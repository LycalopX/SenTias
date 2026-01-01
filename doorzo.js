const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

(async () => {
  const searchTerm = "Newニンテンドー3DS LL";
  const encodedSearch = encodeURIComponent(searchTerm);
  const startUrl = `https://www.doorzo.com/pt/search?keywords=${encodedSearch}`;

  const MAX_PAGES = 67;
  const FILENAME = `new_3ds_xl_catalogo_p${MAX_PAGES}.json`;
  const NEW_ITEMS_FILENAME = `novo_catalogo_p${MAX_PAGES}.json`;
  const PRECO_MINIMO = 10000;
  const CONCURRENCY_LIMIT = 5;
  const RECYCLE_THRESHOLD = 50; // Recicla a aba a cada 50 links para evitar crash de memória

  const getExecutablePath = () => {
    if (process.platform === 'win32') {
      return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    } else if (process.platform === 'darwin') {
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    return null;
  };

  const execPath = getExecutablePath();
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: execPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,720',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--js-flags="--max-old-space-size=4096"' // Aumenta limite de memória do JS no Chrome
    ],
    ignoreHTTPSErrors: true
  });

  // 1. Carregamento do Banco de Dados
  let catalog = [];
  let totalOriginal = 0;
  if (fs.existsSync(FILENAME)) {
    try {
      catalog = JSON.parse(fs.readFileSync(FILENAME, 'utf8'));
      totalOriginal = catalog.length;
      catalog.forEach(item => { item.on = 'pending'; });
      console.log(`[DB] ${catalog.length} itens carregados.`);
    } catch (e) {
      console.log("Iniciando novo catálogo.");
    }
  }

  const getUniqueId = (url) => {
    const idMatch = url.match(/detail\/([^/?#]+)/);
    return idMatch ? idMatch[1] : url;
  };

  let rawItems = [];

  try {
    const mainPage = await browser.newPage();

    await mainPage.setRequestInterception(true);
    mainPage.on('request', (req) => {
      const url = req.url();
      const resourceType = req.resourceType();
      const isTracker = url.includes('google-analytics') || url.includes('facebook') || url.includes('gtm.js') || url.includes('tracking.js');

      if (['image', 'font', 'media'].includes(resourceType) || isTracker) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    await mainPage.setUserAgent(userAgent);

    console.log(`Navegando para a busca: ${searchTerm}...`);
    await mainPage.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await mainPage.evaluate(() => {
      const closeSelectors = ['.el-dialog__headerbtn', '.close-btn', '.modal-close', '.coupon-close'];
      closeSelectors.forEach(sel => document.querySelectorAll(sel).forEach(b => b.click()));
    });

    await mainPage.waitForSelector('.goods-item', { timeout: 30000 });

    // 2. Paginação
    const moreBtnSelector = '.more button, .more a';
    for (let p = 0; p < MAX_PAGES; p++) {
      process.stdout.write(`Carregando lotes: ${p + 1}/${MAX_PAGES}\r`);

      try {
        await mainPage.evaluate(() => {
          const overlay = document.querySelector('.el-overlay');
          if (overlay) overlay.remove();
          window.scrollTo(0, document.body.scrollHeight);
        });

        await new Promise(r => setTimeout(r, 800));

        const btn = await mainPage.waitForSelector(moreBtnSelector, { visible: true, timeout: 3000 }).catch(() => null);

        if (btn) {
          const isBusy = await mainPage.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el.disabled || el.classList.contains('is-loading') || el.innerText.includes('...');
          }, moreBtnSelector);

          if (!isBusy) {
            await mainPage.evaluate((sel) => document.querySelector(sel)?.click(), moreBtnSelector);
            await new Promise(r => setTimeout(r, 1500));
          } else {
            await new Promise(r => setTimeout(r, 2000));
            p--;
          }
        } else {
          break;
        }
      } catch (e) { break; }
    }

    rawItems = await mainPage.evaluate(() => {
      return Array.from(document.querySelectorAll('.goods-item')).map(item => {
        const name = item.querySelector('.goods-name')?.innerText || "";
        const priceText = item.querySelector('.price-com')?.innerText || "0";
        const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
        const sold = !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold');
        const href = item.getAttribute('href') || "";
        return {
          nome: name,
          preco_iene: price,
          url: href.startsWith('http') ? href : "https://www.doorzo.com" + href,
          sold
        };
      });
    });

    console.log(`\nAnúncios capturados: ${rawItems.length}`);
    await mainPage.close();

  } catch (err) {
    console.error("\nErro na fase de extração:", err.message);
  }

  // 3. Sincronização
  const toScrape = [];
  const newlyAdded = [];
  const blacklist = ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"];
  const paginacaoGlitched = rawItems.length < (totalOriginal * 0.4) && totalOriginal > 300;

  rawItems.forEach(item => {
    const id = getUniqueId(item.url);
    const lowerName = item.nome.toLowerCase();
    const isNewModel = lowerName.includes('new') && lowerName.includes('3ds') && (lowerName.includes('ll') || lowerName.includes('xl'));
    const isNotAccessory = !blacklist.some(word => item.nome.includes(word));

    if (!isNewModel || item.preco_iene < PRECO_MINIMO || !isNotAccessory) return;

    const existingItem = catalog.find(c => getUniqueId(c.url) === id);
    if (existingItem) {
      if (item.sold) existingItem.on = 'sold';
      else {
        existingItem.on = true;
        existingItem.preco_iene = item.preco_iene;
      }
    } else if (!item.sold) {
      toScrape.push(item);
    }
  });

  // 4. Extração com Gerenciamento de Memória (Reciclagem de Abas)
  if (toScrape.length > 0) {
    console.log(`Minerando ${toScrape.length} consoles. Reutilizando e reciclando abas...`);

    const workers = [];
    const usageCount = Array(CONCURRENCY_LIMIT).fill(0);

    const createWorker = async () => {
      const p = await browser.newPage();
      await p.setRequestInterception(true);
      p.on('request', r => {
        const isT = r.url().includes('google') || r.url().includes('facebook') || r.url().includes('tracking');
        if (['image', 'font', 'media', 'stylesheet'].includes(r.resourceType()) || isT) r.abort();
        else r.continue();
      });
      return p;
    };

    // Inicializa workers
    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
      workers.push(await createWorker());
    }

    for (let i = 0; i < toScrape.length; i += CONCURRENCY_LIMIT) {
      const chunk = toScrape.slice(i, i + CONCURRENCY_LIMIT);

      const results = await Promise.all(chunk.map(async (itemInfo, index) => {
        // Reciclagem: Se a aba foi usada X vezes, fecha e abre uma nova
        if (usageCount[index] >= RECYCLE_THRESHOLD) {
          try { await workers[index].close(); } catch (e) { }
          workers[index] = await createWorker();
          usageCount[index] = 0;
        }

        const tab = workers[index];
        usageCount[index]++;

        try {
          await tab.goto(itemInfo.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
          const selector = '.html';
          await tab.waitForSelector(selector, { timeout: 12000 });
          const desc = await tab.evaluate((s) => document.querySelector(s)?.innerText || "", selector);
          return { ...itemInfo, descricao: desc, on: true };
        } catch (e) {
          return null;
        }
      }));

      const valid = results.filter(r => r !== null);
      catalog.push(...valid);
      newlyAdded.push(...valid);
      process.stdout.write(`Progresso: [${catalog.filter(c => c.on === true).length}] consoles ativos\r`);
    }

    // Fechamento seguro dos workers
    for (const tab of workers) {
      try { if (tab && !tab.isClosed()) await tab.close(); } catch (e) { }
    }
  }

  // 5. Salvamento
  let finalData = paginacaoGlitched ? catalog.filter(item => item.on !== 'sold') : catalog.filter(item => item.on === true);
  fs.writeFileSync(FILENAME, JSON.stringify(finalData, null, 2));
  fs.writeFileSync(NEW_ITEMS_FILENAME, JSON.stringify(newlyAdded, null, 2));

  console.log(`\n\n✅ OPERAÇÃO CONCLUÍDA`);
  console.log(`- Total: ${finalData.length} | Novos: ${newlyAdded.length}`);

  try { await browser.close(); } catch (e) { console.log("[INFO] Browser já estava fechado."); }
})();