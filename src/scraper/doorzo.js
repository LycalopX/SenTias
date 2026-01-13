const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getUniqueId, cleanDescription, addLog } = require('../utils');
const { browser, originalCatalogSnapshot, stopRequested, stats } = require('../state');

const CONFIG_PATH = path.join(__dirname, '../config.json');

async function getConfig() {
  try {
    const configData = await fs.promises.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error("Error reading or parsing config.json:", error);
    throw new Error("Could not load configuration.");
  }
}

async function runScraper() {

  try {

    if (!stats.startTime) {
      stats.startTime = new Date();
    }

    if (!browser.instance) {
      const { executablePath } = await getConfig();
      const launchOptions = {
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', // Evita crash por falta de memória compartilhada no Docker/Linux
          '--disable-gpu'            // Servidores geralmente não têm GPU
        ]
      };

      if (os.platform() === 'win32' && executablePath) {
        addLog(`Usando navegador customizável em: ${executablePath}`);
        launchOptions.executablePath = executablePath;
      }

      browser.instance = await puppeteer.launch(launchOptions);
    }

    while (true) {
      const { searchTerm, FILENAME_ALL, FILENAME_NEW, CONCURRENCY_LIMIT, RECYCLE_THRESHOLD, WAIT_BETWEEN_CYCLES, priceRanges, searchKeywords } = await getConfig();
      const FILENAME_ALL_PATH = path.join(__dirname, '../../data', FILENAME_ALL);
      stats.status = "Pesquisando";
      stats.newItemsLastCycle = 0; stats.newItemsLastCycle = 0;
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
        await browser.instance.close();
        browser.instance = null; // Reseta para o próximo start
        stopRequested.status = false;
        stats.status = "Parado";
        break; // Sai do loop while
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

        let lotsInThisRange = 0;

        try {
          await mainPage.goto(`https://www.doorzo.com/pt/search?keywords=${encodeURIComponent(searchTerm)}&price_min=${range.min}&price_max=${range.max}`, { waitUntil: 'networkidle2', timeout: 45000 });
          stats.lotsFound++;
          lotsInThisRange++;
          process.stdout.write(`Lote ${lotsInThisRange} aberto para esta faixa.\r`);

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
                lotsInThisRange++;
                process.stdout.write(`Lote ${lotsInThisRange} aberto para esta faixa.\r`);
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

      const globalMinPrice = priceRanges.length > 0 ? priceRanges[0].min : 0;
      const globalMaxPrice = priceRanges.length > 0 ? priceRanges[priceRanges.length - 1].max : Infinity;

      uniqueItems.forEach(item => {
        const id = getUniqueId(item.url);
        if (blacklist.some(word => item.nome.includes(word)) || item.sold) return;

        if (item.preco_iene < globalMinPrice || item.preco_iene > globalMaxPrice) return;

        const lowerCaseName = item.nome.toLowerCase();
        const hasAllKeywords = searchKeywords.every(kw => lowerCaseName.includes(kw));

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
              await tab.close().catch(() => { });
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
                    } catch (e) { }
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
                  retries++;
                }

              } catch (e) {
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
          if (tab) await tab.close().catch(() => { });
        };

        await Promise.all(Array(CONCURRENCY_LIMIT).fill(0).map(() => createWorker()));
        clearInterval(watchdogIntervalId); // Desarma o watchdog
      }

      // --- NOVA LÓGICA DE SALVAMENTO v2 ---

      // 1. Salvar os itens recém-descobertos no arquivo de "novos"
      const FILENAME_NEW_PATH = path.join(__dirname, '../../data', FILENAME_NEW);
      try {
        fs.writeFileSync(FILENAME_NEW_PATH, JSON.stringify(newlyScrapedThisCycle, null, 2));
        addLog(`Salvo ${newlyScrapedThisCycle.length} novos itens em ${FILENAME_NEW}.`);
      } catch (e) {
        addLog(`Falha Crítica ao escrever no arquivo de novos itens: ${e.message}`);
      }

      // 2. Criar e salvar o novo catálogo completo e podado
      // Itens do catálogo anterior que foram encontrados de novo já estão com item.on = true
      // Itens novos em newlyScrapedThisCycle também já têm item.on = true
      const updatedOldCatalog = catalog.filter(item => item.on === true);
      const finalCatalog = [...updatedOldCatalog, ...newlyScrapedThisCycle];

      // Usar um Map para garantir que não haja duplicatas caso um item seja re-processado
      const finalCatalogMap = new Map();
      finalCatalog.forEach(item => finalCatalogMap.set(getUniqueId(item.url), item));

      const finalCatalogUnique = Array.from(finalCatalogMap.values());

      try {
        fs.writeFileSync(FILENAME_ALL_PATH, JSON.stringify(finalCatalogUnique, null, 2));
        addLog(`Catálogo completo atualizado com ${finalCatalogUnique.length} itens em ${FILENAME_ALL}.`);
      } catch (e) {
        addLog(`Falha Crítica ao escrever no catálogo completo: ${e.message}`);
      }

      if (stopRequested.status) {
        stopRequested.status = false;
        stats.status = "Parado";
      }

      stats.lastUpdate = new Date().toLocaleTimeString();
      stats.totalItems = finalCatalogUnique.length;
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
    addLog(`Erro crítico no loop principal: ${err.message}`);
    console.error("Erro critico:", err);
    if (browser.instance) {
        await browser.instance.close().catch(() => {});
        browser.instance = null;
    }
    await new Promise(r => setTimeout(r, 30000)); // wait 30s before restarting
    runScraper(); // Tenta reiniciar o scraper
  }
}

module.exports = { runScraper };
