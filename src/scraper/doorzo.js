const puppeteer = require('puppeteer');
const fs = require('fs');
const { searchTerm, FILENAME, CONCURRENCY_LIMIT, RECYCLE_THRESHOLD, WAIT_BETWEEN_CYCLES, priceRanges } = require('../config');
const { getUniqueId } = require('../utils');
const path = require('path');

const FILENAME_PATH = path.join(__dirname, '../../data', FILENAME);
const STATS_PATH = path.join(__dirname, '../../data', 'stats.json');
const STOP_PATH = path.join(__dirname, '../../data', 'stop');

let stats = {
  status: "Iniciando...",
  totalItems: 0,
  newItemsLastCycle: 0,
  lastUpdate: "-",
  logs: [],
  currentRange: "",
  progressCurrent: 0,
  progressTotal: 0,
};

let stopRequested = {
    status: false
};

let originalCatalogSnapshot = [];

function writeStats() {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    stats.logs.unshift(entry);
    if (stats.logs.length > 50) stats.logs.pop();
}

async function runScraper() {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720', '--disable-dev-shm-usage']
  });

  try {
    while (true) {
      if (fs.existsSync(STOP_PATH)) {
        stopRequested.status = true;
        fs.unlinkSync(STOP_PATH);
      }

      stats.status = "Pesquisando";
      stats.newItemsLastCycle = 0;
      stats.progressCurrent = 0;
      stats.progressTotal = 0;
      if (stopRequested.status) {
          stats.status = "Parando...";
      }
      writeStats();

      if(stopRequested.status){
          let catalog = [];
          if (fs.existsSync(FILENAME_PATH)) {
            catalog = JSON.parse(fs.readFileSync(FILENAME_PATH, 'utf8'));
          }
           // SALVAMENTO LÓGICO
          let finalCatalog;
          addLog("Merge de segurança: Combinando itens novos com catálogo antigo...");
          writeStats();
          // Mantém TUDO o que já existia + o que foi minerado agora
          finalCatalog = [...originalCatalogSnapshot, ...newlyScrapedThisCycle];
          
          fs.writeFileSync(FILENAME_PATH, JSON.stringify(finalCatalog, null, 2));
          addLog("Dados salvos com sucesso. Finalizando processo.");
          writeStats();
          process.exit();
      }

      let catalog = [];
      if (fs.existsSync(FILENAME_PATH)) {
        catalog = JSON.parse(fs.readFileSync(FILENAME_PATH, 'utf8'));
      }
      originalCatalogSnapshot = [...catalog]; // Snapshot para merge em caso de parada manual
      stats.totalItems = catalog.length;
      writeStats();

      let allFoundItems = [];
      const mainPage = await browser.newPage();
      await mainPage.setRequestInterception(true);
      mainPage.on('request', r => ['image', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue());

      for (const range of priceRanges) {
        if (stopRequested.status) break;
        stats.currentRange = `¥${range.min} - ¥${range.max}`;
        addLog(`Iniciando busca: ${stats.currentRange}`);
        writeStats();
        
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
        } catch (e) { addLog(`Erro na faixa ${stats.currentRange}`); writeStats(); }
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
        addLog(`Minerando ${toScrape.length} novos consoles...`);
        writeStats();
        
        let currentIndex = 0;
        const createWorker = async () => {
          let tab = await browser.newPage();
          let uses = 0;
          await tab.setRequestInterception(true);
          tab.on('request', r => (['image', 'font', 'media'].includes(r.resourceType()) || r.url().includes('google')) ? r.abort() : r.continue());

          while (currentIndex < toScrape.length && !stopRequested.status) {
            const item = toScrape[currentIndex++];
            if (!item) break;

            if (uses >= RECYCLE_THRESHOLD) {
              await tab.close().catch(() => {});
              tab = await browser.newPage();
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
                  writeStats();
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
        addLog("Merge de segurança: Combinando itens novos com catálogo antigo...");
        writeStats();
        // Mantém TUDO o que já existia + o que foi minerado agora
        finalCatalog = [...originalCatalogSnapshot, ...newlyScrapedThisCycle];
      } else {
        // Ciclo normal: Atualiza o catálogo principal e remove o que não foi visto (ou vendido)
        finalCatalog = [...catalog, ...newlyScrapedThisCycle].filter(item => item.on === true);
      }

      fs.writeFileSync(FILENAME_PATH, JSON.stringify(finalCatalog, null, 2));
      
      if (stopRequested.status) {
        addLog("Dados salvos com sucesso. Finalizando processo.");
        writeStats();
        process.exit();
      }

      stats.lastUpdate = new Date().toLocaleTimeString();
      stats.totalItems = finalCatalog.length;
      stats.status = "Em Espera";
      stats.progressTotal = 0;
      addLog(`Ciclo finalizado. Novos: ${stats.newItemsLastCycle}. Dormindo 10 min.`);
      writeStats();
      await new Promise(r => setTimeout(r, WAIT_BETWEEN_CYCLES));
    }
  } catch (err) {
    addLog(`Erro crítico: ${err.message}`);
    writeStats();
    setTimeout(runScraper, 30000);
  }
}

runScraper();
