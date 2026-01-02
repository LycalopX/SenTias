const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { searchTerm, FILENAME, CONCURRENCY_LIMIT, RECYCLE_THRESHOLD, WAIT_BETWEEN_CYCLES, priceRanges } = require('../config');
const { getUniqueId, cleanDescription } = require('../utils');
const { browser, originalCatalogSnapshot, stopRequested, stats } = require('../state');

const FILENAME_PATH = path.join(__dirname, '../../data', FILENAME);

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

      // 1. Snapshot Imutável
      let catalog = [];
      if (fs.existsSync(FILENAME_PATH)) {
        try {
            catalog = JSON.parse(fs.readFileSync(FILENAME_PATH, 'utf8'));
        } catch (e) {
            addLog("Erro ao ler ou parsear o catalogo JSON. Começando com um catalogo vazio.");
            catalog = [];
        }
      }
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

      for (const range of priceRanges) {
        if (stopRequested.status) break;
        stats.currentRange = `¥${range.min} - ¥${range.max}`;
        addLog(`Iniciando busca: ${stats.currentRange}`);
        
        try {
          await mainPage.goto(`https://www.doorzo.com/pt/search?keywords=${encodeURIComponent(searchTerm)}&price_min=${range.min}&price_max=${range.max}`, { waitUntil: 'networkidle2', timeout: 45000 });
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
                stats.lotsFound++; // Increment lotsFound
                await new Promise(r => setTimeout(r, 1500));
              } else { await new Promise(r => setTimeout(r, 2000)); p--; }
            } else break;
          }

          const items = await mainPage.evaluate(() => {
            return Array.from(document.querySelectorAll('.goods-item')).map(item => ({
              nome: item.querySelector('.goods-name')?.innerText || "",
              preco_iene: parseInt(item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '')) || 0,
              url: "https://www.doorzo.com" + (item.getAttribute('href') || ""),
              sold: !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold')
            }));
          });
          allFoundItems.push(...items);
        } catch (e) { addLog(`Erro na faixa ${stats.currentRange}: ${e.message}`); }
      }
      await mainPage.close();

      stats.totalItemsFound = allFoundItems.length;

      if (stopRequested.status) continue;

      const uniqueItems = Array.from(new Map(allFoundItems.map(item => [getUniqueId(item.url), item])).values());
      const toScrape = [];
      const blacklist = ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"];

      uniqueItems.forEach(item => {
        const id = getUniqueId(item.url);
        if (blacklist.some(word => item.nome.includes(word)) || item.sold) return;
        const existingItem = catalog.find(c => getUniqueId(c.url) === id);
        if (!existingItem) {
            toScrape.push(item);
        } else {
            // Se o item já existe, atualizamos o `on` para true.
            existingItem.on = true;
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
                if (response.status() === 503) {
                    const waitTime = (retries * 5000) + (Math.random() * 5000);
                    addLog(`Recebido status 503 para ${item.url}. Tentando novamente em ${Math.round(waitTime / 1000)}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    retries++;
                    continue;
                }

                let desc = await tab.evaluate(() => {
                  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                  for (const s of scripts) {
                    try {
                      const json = JSON.parse(s.innerText);
                      const graph = json['@graph'] || [json];
                      const prod = graph.find(obj => obj['@type'] === 'Product');
                      if (prod && prod.description) return prod.description;
                    } catch (e) {}
                  }
                  return document.querySelector('.html')?.innerText || null;
                });
                
                if (desc === null) {
                    await new Promise(r => setTimeout(r, 2000));
                     desc = await tab.evaluate(() => document.querySelector('.html')?.innerText || null);
                }

                const cleanedDesc = cleanDescription(desc);

                if (cleanedDesc && cleanedDesc.length > 20 && !/Error|Access Denied|Página não encontrada/i.test(cleanedDesc)) {
                  const scrapedItem = { ...item, descricao: cleanedDesc, on: true, detectado_em: new Date().toISOString() };
                  newlyScrapedThisCycle.push(scrapedItem);
                  stats.lastScrapedName = item.nome;
                  stats.newItemsLastCycle++;
                  success = true;
                } else {
                    addLog(`Descrição inválida ou página de erro para ${item.url}.`);
                }

              } catch (e) { 
                addLog(`Erro ao minerar ${item.url}: ${e.message.split('\n')[0]}`);
                retries++; 
              } finally {
                stats.progressCurrent++;
              }
            }
          }
          if (tab) await tab.close().catch(() => {});
        };

        await Promise.all(Array(CONCURRENCY_LIMIT).fill(0).map(() => createWorker()));
        clearInterval(watchdogIntervalId); // Desarma o watchdog
      }

      // Lógica de Salvamento Dual
      let finalCatalog;
      if (stopRequested.status) {
        addLog("Merge de segurança: Combinando itens novos com catálogo antigo...");
        finalCatalog = [...originalCatalogSnapshot, ...newlyScrapedThisCycle];
        // Reset stop request so the loop can be restarted from the dashboard
        stopRequested.status = false; 
        stats.status = "Parado";
      } else {
        addLog("Ciclo normal: Atualizando o catálogo principal e limpando itens offline.");
        // Marca todos os itens antigos como `off` antes de fazer o merge
        catalog.forEach(item => item.on = false);
        const combined = [...catalog, ...newlyScrapedThisCycle];
        const itemMap = new Map();
        combined.forEach(item => {
            const id = getUniqueId(item.url);
            const existing = itemMap.get(id);
            if (!existing || (!existing.on && item.on)) {
                 itemMap.set(id, item);
            }
        });
        finalCatalog = Array.from(itemMap.values()).filter(item => item.on === true);
      }

      try {
        fs.writeFileSync(FILENAME_PATH, JSON.stringify(finalCatalog, null, 2));
      } catch (e) {
          addLog(`Falha Crítica ao escrever no disco: ${e.message}`);
      }
      
      stats.lastUpdate = new Date().toLocaleTimeString();
      stats.totalItems = finalCatalog.length;
      if (stats.status !== "Parado") {
        stats.status = "Em Espera";
        stats.progressTotal = 0;
        stats.progressCurrent = 0;
        addLog(`Ciclo finalizado. Novos: ${stats.newItemsLastCycle}. Lotes encontrados: ${stats.lotsFound}. Dormindo ${WAIT_BETWEEN_CYCLES / 60000} min.`);
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
