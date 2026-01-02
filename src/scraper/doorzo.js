const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { searchTerm, FILENAME, CONCURRENCY_LIMIT, RECYCLE_THRESHOLD, WAIT_BETWEEN_CYCLES, priceRanges, getExecutablePath } = require('../config');
const { stats, stopRequested, browser, originalCatalogSnapshot } = require('../state');
const { getUniqueId, addLog } = require('../utils');
const path = require('path');

const FILENAME_PATH = path.join(__dirname, '../../data', FILENAME);

async function runScraper() {
  const execPath = getExecutablePath();
  stats.browser = await puppeteer.launch({
    headless: false,
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720', '--disable-dev-shm-usage']
  });

  try {
    while (true) {
      stats.status = "Pesquisando";
      stats.newItemsLastCycle = 0;
      stats.progressCurrent = 0;
      stats.progressTotal = 0;
      stopRequested.status = false;

      let catalog = [];
      if (fs.existsSync(FILENAME_PATH)) {
        catalog = JSON.parse(fs.readFileSync(FILENAME_PATH, 'utf8'));
      }
      stats.originalCatalogSnapshot = [...catalog]; // Snapshot para merge em caso de parada manual
      stats.totalItems = catalog.length;

      let allFoundItems = [];
      const mainPage = await stats.browser.newPage();
      await mainPage.setRequestInterception(true);
      mainPage.on('request', r => ['image', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue());

      for (const range of priceRanges) {
        if (stopRequested.status) break;
        stats.currentRange = `¥${range.min} - ¥${range.max}`;
        addLog(stats, `Iniciando busca: ${stats.currentRange}`);
        
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
        } catch (e) { addLog(stats, `Erro na faixa ${stats.currentRange}`); }
      }
      await mainPage.close();

      // FILTRAGEM
      const uniqueItems = Array.from(new Map(allFoundItems.map(item => [getUniqueId(item.url), item])).values());
      const toScrape = [];
      const blacklist = ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"];

      uniqueItems.forEach(item => {
        const id = getUniqueId(item.url);
        if (blacklist.some(word => item.nome.includes(word)) || item.sold) return;
        if (!catalog.find(c => getUniqueId(c.url) === id)) toScrape.push(item);
      });

      // MINERAÇÃO
      let newlyScrapedThisCycle = [];
      if (toScrape.length > 0 && !stopRequested.status) {
        stats.status = "Minerando Descrições";
        stats.progressTotal = toScrape.length;
        addLog(stats, `Minerando ${toScrape.length} novos consoles...`);
        
        let currentIndex = 0;
        const createWorker = async () => {
          let tab = await stats.browser.newPage();
          let uses = 0;
          await tab.setRequestInterception(true);
          tab.on('request', r => (['image', 'font', 'media'].includes(r.resourceType()) || r.url().includes('google')) ? r.abort() : r.continue());

          while (currentIndex < toScrape.length && !stopRequested.status) {
            const item = toScrape[currentIndex++];
            if (!item) break;

            if (uses >= RECYCLE_THRESHOLD) {
              await tab.close().catch(() => {});
              tab = await stats.browser.newPage();
              uses = 0;
            }

            let retries = 0;
            let success = false;
            while (!success && retries < 2 && !stopRequested.status) {
              try {
                uses++;
                await tab.goto(item.url, { waitUntil: 'networkidle2', timeout: 30000 });
                const desc = await tab.evaluate(() => {
                  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                  for (const s of scripts) {
                    try {
                      const json = JSON.parse(s.innerText);
                      const graph = json['@graph'] || [json];
                      const prod = graph.find(obj => obj['@type'] === 'Product');
                      if (prod && prod.description) return product.description;
                    } catch (e) {}
                  }
                  return document.querySelector('.html')?.innerText || null;
                });
                if (desc) {
                  newlyScrapedThisCycle.push({ ...item, descricao: desc, on: true, detectado_em: new Date().toISOString() });
                  stats.newItemsLastCycle++;
                  stats.progressCurrent++;
                  success = true;
                }
              } catch (e) { retries++; }
            }
          }
          await tab.close().catch(() => {});
        };

        await Promise.all(Array(CONCURRENCY_LIMIT).fill(0).map(() => createWorker()));
      }

      // SALVAMENTO LÓGICO
      let finalCatalog;
      if (stopRequested.status) {
        addLog(stats, "Merge de segurança: Combinando itens novos com catálogo antigo...");
        // Mantém TUDO o que já existia + o que foi minerado agora
        finalCatalog = [...stats.originalCatalogSnapshot, ...newlyScrapedThisCycle];
      } else {
        // Ciclo normal: Atualiza o catálogo principal e remove o que não foi visto (ou vendido)
        finalCatalog = [...catalog, ...newlyScrapedThisCycle].filter(item => item.on === true);
      }

      fs.writeFileSync(FILENAME_PATH, JSON.stringify(finalCatalog, null, 2));
      
      if (stopRequested.status) {
        addLog(stats, "Dados salvos com sucesso. Finalizando processo.");
        process.exit();
      }

      stats.lastUpdate = new Date().toLocaleTimeString();
      stats.totalItems = finalCatalog.length;
      stats.status = "Em Espera";
      stats.progressTotal = 0;
      addLog(stats, `Ciclo finalizado. Novos: ${stats.newItemsLastCycle}. Dormindo 10 min.`);
      await new Promise(r => setTimeout(r, WAIT_BETWEEN_CYCLES));
    }
  } catch (err) {
    addLog(stats, `Erro crítico: ${err.message}`);
    setTimeout(runScraper, 30000);
  }
}

runScraper();