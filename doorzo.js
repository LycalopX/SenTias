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
  const RECYCLE_THRESHOLD = 30; 
  const MAX_RETRIES = 3; // Máximo de tentativas para erros 503 ou falhas de rede

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
      '--disable-gpu',
      '--js-flags="--max-old-space-size=4096"'
    ],
    ignoreHTTPSErrors: true
  });

  // 1. Carregamento do Banco de Dados
  let catalog = [];
  if (fs.existsSync(FILENAME)) {
    try {
      catalog = JSON.parse(fs.readFileSync(FILENAME, 'utf8'));
      catalog.forEach(item => { item.on = 'pending'; });
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
      if (['image', 'font', 'media'].includes(resourceType) || url.includes('google-analytics') || url.includes('facebook')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await mainPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log(`Buscando: ${searchTerm}...`);
    await mainPage.goto(startUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Fecha popups iniciais
    await mainPage.evaluate(() => {
      document.querySelectorAll('.el-dialog__headerbtn, .close-btn, .modal-close').forEach(b => b.click());
    });

    await mainPage.waitForSelector('.goods-item', { timeout: 30000 });

    // 2. Paginação
    const moreBtnSelector = '.more button, .more a';
    for (let p = 0; p < MAX_PAGES; p++) {
      process.stdout.write(`Lotes: ${p + 1}/${MAX_PAGES}\r`);
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
            return el.disabled || el.classList.contains('is-loading');
          }, moreBtnSelector);
          if (!isBusy) {
            await mainPage.evaluate((sel) => document.querySelector(sel)?.click(), moreBtnSelector);
            await new Promise(r => setTimeout(r, 1500));
          } else {
            await new Promise(r => setTimeout(r, 2000));
            p--; 
          }
        } else break;
      } catch (e) { break; }
    }

    rawItems = await mainPage.evaluate(() => {
      return Array.from(document.querySelectorAll('.goods-item')).map(item => {
        const name = item.querySelector('.goods-name')?.innerText || "";
        const price = parseInt(item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '')) || 0;
        const sold = !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold');
        const href = item.getAttribute('href') || "";
        return { nome: name, preco_iene: price, url: href.startsWith('http') ? href : "https://www.doorzo.com" + href, sold };
      });
    });
    console.log(`\nAnúncios encontrados: ${rawItems.length}`);
    await mainPage.close(); 
  } catch (err) {
    console.error("Erro na busca:", err.message);
  }

  // 3. Sincronização
  const toScrape = [];
  const blacklist = ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"];
  
  rawItems.forEach(item => {
    const id = getUniqueId(item.url);
    const lowerName = item.nome.toLowerCase();
    const isNewModel = lowerName.includes('new') && lowerName.includes('3ds') && (lowerName.includes('ll') || lowerName.includes('xl'));
    const isNotAccessory = !blacklist.some(word => item.nome.includes(word));

    if (!isNewModel || item.preco_iene < PRECO_MINIMO || !isNotAccessory) return;

    const existingItem = catalog.find(c => getUniqueId(c.url) === id);
    if (existingItem) {
      existingItem.on = item.sold ? 'sold' : true;
      if (!item.sold) existingItem.preco_iene = item.preco_iene;
    } else if (!item.sold) {
      toScrape.push(item);
    }
  });

  // 4. Extração via Worker Pool com tratamento de erro 503
  if (toScrape.length > 0) {
    console.log(`Minerando ${toScrape.length} novos consoles...`);
    
    let currentIndex = 0;
    const results = [];

    const createWorker = async () => {
      let tab = await browser.newPage();
      let uses = 0;

      const setupTab = async (t) => {
        await t.setRequestInterception(true);
        t.on('request', r => {
          const isT = r.url().includes('google') || r.url().includes('facebook') || r.url().includes('tracking');
          if (['image', 'font', 'media'].includes(r.resourceType()) || isT) r.abort();
          else r.continue();
        });
      };
      
      await setupTab(tab);

      while (currentIndex < toScrape.length) {
        const itemIndex = currentIndex++;
        const itemInfo = toScrape[itemIndex];
        
        if (uses >= RECYCLE_THRESHOLD) {
          await tab.close().catch(() => {});
          tab = await browser.newPage();
          await setupTab(tab);
          uses = 0;
        }

        let success = false;
        let retries = 0;

        while (!success && retries < MAX_RETRIES) {
          try {
            uses++;
            const response = await tab.goto(itemInfo.url, { waitUntil: 'networkidle2', timeout: 30000 });
            
            // Verifica se o servidor retornou erro 503 ou similar
            if (response && response.status() === 503) {
              throw new Error("Erro 503 - Servidor sobrecarregado");
            }

            await new Promise(r => setTimeout(r, 1000));

            const data = await tab.evaluate(() => {
              const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
              for (const s of scripts) {
                try {
                  const json = JSON.parse(s.innerText);
                  const graph = json['@graph'] || [json];
                  const product = graph.find(obj => obj['@type'] === 'Product');
                  if (product && product.description) return product.description;
                } catch (e) {}
              }
              const htmlDesc = document.querySelector('.html');
              return htmlDesc ? htmlDesc.innerText : null;
            });

            if (data) {
              results.push({ ...itemInfo, descricao: data, on: true });
              success = true;
            } else {
              // Se não houver descrição, consideramos erro de carregamento e tentamos novamente
              throw new Error("Descrição não encontrada na página");
            }
          } catch (e) {
            retries++;
            // Se falhar, espera um tempo crescente antes da próxima tentativa (backoff simples)
            const waitTime = 2000 * retries;
            await new Promise(r => setTimeout(r, waitTime));
          }
        }
        process.stdout.write(`Progresso: ${results.length}/${toScrape.length} (Falhas/Ignorados: ${currentIndex - results.length})\r`);
      }
      await tab.close().catch(() => {});
    };

    await Promise.all(Array(CONCURRENCY_LIMIT).fill(0).map(() => createWorker()));
    catalog.push(...results);
  }

  // 5. Salvamento
  const finalData = catalog.filter(item => item.on === true);
  const newlyAdded = results = []; // Limpando para evitar confusão no log final se necessário
  
  fs.writeFileSync(FILENAME, JSON.stringify(finalData, null, 2));
  
  // O arquivo de novos itens agora é filtrado do catálogo final
  const newItems = finalData.filter(item => !catalog.some(old => getUniqueId(old.url) === getUniqueId(item.url) && old.on !== 'pending'));
  fs.writeFileSync(NEW_ITEMS_FILENAME, JSON.stringify(newItems, null, 2));

  console.log(`\n\n✅ OPERAÇÃO CONCLUÍDA: ${finalData.length} itens no catálogo.`);
  await browser.close().catch(() => {});
})();