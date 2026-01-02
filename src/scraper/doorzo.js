const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const { searchTerm, FILENAME_ALL, FILENAME_NEW, CONCURRENCY_LIMIT, RECYCLE_THRESHOLD, WAIT_BETWEEN_CYCLES, priceRanges } = require('../config');
const { getUniqueId, cleanDescription } = require('../utils');
const { browser, originalCatalogSnapshot, stopRequested, stats } = require('../state');

const FILENAME_ALL_PATH = path.join(__dirname, '../../data', FILENAME_ALL);

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    stats.logs.unshift(entry);
    if (stats.logs.length > 50) stats.logs.pop();
}

async function runScraper() {
  if (!browser.instance) {
    browser.instance = await puppeteer.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720', '--disable-dev-shm-usage']
    });
  }

  try {
    while (true) {
      stats.status = "Pesquisando";
      stats.newItemsLastCycle = 0;
      stats.progressCurrent = 0;
      stats.progressTotal = 0;
      stats.lotsFound = 0;
      stats.totalItemsFound = 0;
      stats.failedItemsCount = 0;

      // 1. Snapshot Imutável
      let catalog = [];
      if (fs.existsSync(FILENAME_ALL_PATH)) {
        try {
            catalog = JSON.parse(fs.readFileSync(FILENAME_ALL_PATH, 'utf8'));
        } catch (e) {
            addLog("Erro ao ler ou parsear o catalogo JSON. Começando com um catalogo vazio.");
            catalog = [];
        }
      }
      catalog.forEach(item => item.on = false);

      originalCatalogSnapshot.length = 0;
      originalCatalogSnapshot.push(...catalog); // Snapshot para merge em caso de parada manual
      stats.totalItems = catalog.length;

      if (stopRequested.status) {
          stats.status = "Aguardando comando";
          await new Promise(r => setTimeout(r, 5000)); // wait before checking again
          continue;
      }
      
      let allFoundItems = [];
      const mainPage = await browser.instance.newPage();
      await mainPage.setRequestInterception(true);
      mainPage.on('request', r => ['image', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue());

      addLog("Navegando para a página principal para aquecimento...");
      await mainPage.goto('https://www.doorzo.com/pt', { waitUntil: 'networkidle2' });
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000)); // Human-like pause

      for (const range of priceRanges) {
        if (stopRequested.status) break;
        stats.currentRange = `¥${range.min} - ¥${range.max}`;
        addLog(`Iniciando busca: ${stats.currentRange}`);
        
        let lotNumbers = [];
        const updateLotsLine = (newLotNumber) => {
            lotNumbers.push(newLotNumber);
            const lotsStr = lotNumbers.join(', ');
            const plural = lotNumbers.length > 1;
            process.stdout.write(`Lote${plural ? 's' : ''} ${lotsStr} aberto${plural ? 's' : ''} para esta faixa.\r`);
        }

        try {
          await mainPage.goto(`https://www.doorzo.com/pt/search?keywords=${encodeURIComponent(searchTerm)}&price_min=${range.min}&price_max=${range.max}`, { waitUntil: 'networkidle2', timeout: 45000 });
          stats.lotsFound++;
          updateLotsLine(lotNumbers.length + 1);

          const moreBtnSelector = '.more a, .more button';
          for (let p = 0; p < 35; p++) {
            if (stopRequested.status) break;
            await mainPage.evaluate(() => {
              document.querySelectorAll('.el-overlay, .el-dialog__wrapper').forEach(el => el.remove());
              window.scrollTo(0, document.body.scrollHeight);
            });
            await new Promise(r => setTimeout(r, 1000));
            const btn = await mainPage.waitForSelector(moreBtnSelector, { visible: true, timeout: 3000 }).catch(() => null);
            if (btn) {
              const busy = await mainPage.evaluate(sel => document.querySelector(sel)?.disabled || document.querySelector(sel)?.classList.contains('is-loading'), moreBtnSelector);
              if (!busy) {
                await mainPage.evaluate(sel => document.querySelector(sel)?.click(), moreBtnSelector);
                stats.lotsFound++;
                updateLotsLine(lotNumbers.length + 1);
                await new Promise(r => setTimeout(r, 1500));
              } else { await new Promise(r => setTimeout(r, 2000)); p--; }
            } else break;
          }

          process.stdout.write('\n');

          const items = await mainPage.evaluate(() => {
            return Array.from(document.querySelectorAll('.goods-item')).map(item => ({
              nome: item.querySelector('.goods-name')?.innerText || "",
              preco_iene: parseInt(item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '')) || 0,
              url: "https://www.doorzo.com" + (item.getAttribute('href') || ""),
              sold: !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold')
            }));
          });
          allFoundItems.push(...items);
        } catch (e) { 
            process.stdout.write('\n');
            addLog(`Erro na faixa ${stats.currentRange}: ${e.message}`); 
        }
      }
      await mainPage.close();

      stats.totalItemsFound = allFoundItems.length;

      if (stopRequested.status) continue;

      const uniqueItems = Array.from(new Map(allFoundItems.map(item => [getUniqueId(item.url), item])).values());
      const toScrape = [];
      const blacklist = ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"];
      const keywords = ['new', '3ds', 'll'];

      uniqueItems.forEach(item => {
        const id = getUniqueId(item.url);
        if (blacklist.some(word => item.nome.includes(word)) || item.sold) return;

        const lowerCaseName = item.nome.toLowerCase();
        const hasAllKeywords = keywords.every(kw => lowerCaseName.includes(kw));

        if (!hasAllKeywords) {
            return;
        }

        const existingItem = catalog.find(c => getUniqueId(c.url) === id);
        if (existingItem) {
            existingItem.on = true; 
        } else {
            toScrape.push(item);
        }
      });

      let newlyScrapedThisCycle = [];
      if (toScrape.length > 0 && !stopRequested.status) {
        stats.status = "Minerando Descrições";
        stats.progressTotal = toScrape.length;
        addLog(`Minerando ${toScrape.length} novos consoles...`);

        // --- WATCHDOG ---
        let lastProgress = -1;
        const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
        const watchdogIntervalId = setInterval(() => {
            if (stats.status !== "Minerando Descrições") {
                clearInterval(watchdogIntervalId);
                return;
            }
            if (stats.progressCurrent === lastProgress) {
                addLog(`WATCHDOG: O progresso não muda há 5 minutos. O scraper pode estar travado. Encerrando o processo...`);
                process.exit(1); // Força a saída
            }
            lastProgress = stats.progressCurrent;
        }, WATCHDOG_INTERVAL_MS);
        
        let currentIndex = 0;
        const createWorker = async () => {
          let tab;
          let uses = 0;

          while (currentIndex < toScrape.length && !stopRequested.status) {
            if (!tab) {
                tab = await browser.instance.newPage();
                await tab.setRequestInterception(true);
                tab.on('request', r => (['image', 'font', 'media'].includes(r.resourceType()) || r.url().includes('google')) ? r.abort() : r.continue());
                await tab.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            }

            const item = toScrape[currentIndex++];
            if (!item) break;

            if (uses >= RECYCLE_THRESHOLD) {
              await tab.close().catch(() => {});
              tab = null;
              uses = 0;
              continue;
            }

            let retries = 0;
            let success = false;
            while (!success && retries < 3 && !stopRequested.status) {
              try {
                uses++;
                const response = await tab.goto(item.url, { waitUntil: 'networkidle2', timeout: 30000 });

                if (response.status() === 403) {
                    addLog(`[Item Falho] Acesso negado (403) para ${item.url}.`);
                    break; 
                }
                const pageContent = await tab.content();
                if (pageContent.includes('Verifique se você é humano') || pageContent.includes('captcha') || pageContent.includes('Access Denied')) {
                    addLog(`[Item Falho] Captcha/Verificação humana detectada para ${item.url}.`);
                    break; 
                }

                if (response.status() === 503) {
                    const waitTime = (retries * 5000) + (Math.random() * 5000);
                    addLog(`[Tentativa ${retries + 1}] Status 503 para ${item.url}. Tentando novamente em ${Math.round(waitTime / 1000)}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    retries++;
                    continue;
                }

                const descriptionSelector = '.html';
                const jsonLdSelector = 'script[type="application/ld+json"]';
                
                await tab.waitForFunction(
                  (descSel, jsonSel) => {
                    const htmlDiv = document.querySelector(descSel);
                    const jsonLdScript = document.querySelector(jsonSel);
                    return (htmlDiv && htmlDiv.innerText && htmlDiv.innerText.length > 50) || jsonLdScript;
                  },
                  { timeout: 10000 }
                  , descriptionSelector, jsonLdSelector
                ).catch(() => { /* continue if not found, will be handled by desc === null */ });
                

                let desc = await tab.evaluate((descSel, jsonSel) => {
                  const scripts = Array.from(document.querySelectorAll(jsonSel));
                  for (const s of scripts) {
                    try {
                      const json = JSON.parse(s.innerText);
                      const graph = json['@graph'] || [json];
                      const prod = graph.find(obj => obj['@type'] === 'Product');
                      if (prod && prod.description) return prod.description;
                    } catch (e) {}
                  }
                  return document.querySelector(descSel)?.innerText || null;
                }, descriptionSelector, jsonLdSelector);
                
                if (desc === null) {
                    retries++;
                    continue;
                }

                const cleanedDesc = cleanDescription(desc);

                if (cleanedDesc && cleanedDesc.length > 20 && !/Error|Access Denied|Página não encontrada/i.test(cleanedDesc)) {
                  const scrapedItem = { ...item, descricao: cleanedDesc, on: true, detectado_em: new Date().toISOString() };
                  newlyScrapedThisCycle.push(scrapedItem);
                  stats.lastScrapedName = item.nome;
                  stats.newItemsLastCycle++;
                  success = true;
                } else {
                    addLog(`[Tentativa ${retries + 1}] Descrição inválida para ${item.url}.`);
                    retries++;
                }

              } catch (e) { 
                addLog(`[Tentativa ${retries + 1}] Erro ao minerar ${item.url}: ${e.message.split('\n')[0]}`);
                retries++; 
              }
            }
            if (success) {
                stats.progressCurrent++;
            } else {
                addLog(`FALHA FINAL para ${item.url} após 3 tentativas.`);
                stats.failedItemsCount++;
            }
          }
          if (tab) await tab.close().catch(() => {});
        };

        await Promise.all(Array(CONCURRENCY_LIMIT).fill(0).map(() => createWorker()));
        clearInterval(watchdogIntervalId); // Desarma o watchdog
      }

      // --- NOVA LÓGICA DE SALVAMENTO ---
      const FILENAME_NEW_PATH = path.join(__dirname, '../../data', FILENAME_NEW);
      try {
        fs.writeFileSync(FILENAME_NEW_PATH, JSON.stringify(newlyScrapedThisCycle, null, 2));
        addLog(`Salvo ${newlyScrapedThisCycle.length} novos itens em ${FILENAME_NEW}.`);
      } catch (e) {
          addLog(`Falha Crítica ao escrever no arquivo de novos itens: ${e.message}`);
      }

      // Combina o catálogo que foi modificado ('on' = true para itens encontrados) com os novos
      const combinedCatalog = [...catalog, ...newlyScrapedThisCycle];
      
      // Filtra para manter apenas os que foram encontrados nesta rodada
      const finalCatalog = combinedCatalog.filter(item => item.on === true);

      try {
        fs.writeFileSync(FILENAME_ALL_PATH, JSON.stringify(finalCatalog, null, 2));
        addLog(`Catálogo completo atualizado com ${finalCatalog.length} itens em ${FILENAME_ALL}.`);
      } catch (e) {
          addLog(`Falha Crítica ao escrever no catálogo completo: ${e.message}`);
      }
      
      if(stopRequested.status) {
          stopRequested.status = false; 
          stats.status = "Parado";
      }
      
      stats.lastUpdate = new Date().toLocaleTimeString();
      stats.totalItems = finalCatalog.length;
      if (stats.status !== "Parado") {
        stats.status = "Em Espera";
        stats.progressTotal = 0;
        stats.progressCurrent = 0;
        addLog(`Ciclo finalizado. Novos: ${stats.newItemsLastCycle}. Lotes encontrados: ${stats.lotsFound}. Itens falhos: ${stats.failedItemsCount}. Dormindo ${WAIT_BETWEEN_CYCLES / 60000} min.`);
        await new Promise(r => setTimeout(r, WAIT_BETWEEN_CYCLES));
      }
    }
  } catch (err) {
    stats.status = "Erro Crítico";
    stats.logs.unshift(`[${new Date().toLocaleTimeString()}] Erro crítico no loop principal: ${err.message}`);
    console.error("Erro critico:", err);
    await new Promise(r => setTimeout(r, 30000)); // wait 30s before restarting
    runScraper(); // Tenta reiniciar o scraper
  }
}

module.exports = { runScraper };
