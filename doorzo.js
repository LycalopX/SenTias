const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const searchTerm = "Newニンテンドー3DS LL";
  const startUrl = "https://www.doorzo.com/pt";
  const FILENAME = 'new_3ds_xl_catalogo.json';
  const NEW_ITEMS_FILENAME = 'novo_catalogo.json';
  const MAX_PAGES = 50; 
  const PRECO_MINIMO = 10000;
  const CONCURRENCY_LIMIT = 5;

  // 1. Carregamento do Banco de Dados
  let catalog = [];
  if (fs.existsSync(FILENAME)) {
    try {
      catalog = JSON.parse(fs.readFileSync(FILENAME, 'utf8'));
      // Lógica solicitada: todos começam como 'on: false' para limpeza de stock
      catalog.forEach(item => item.on = false);
      console.log(`[DB] ${catalog.length} itens carregados.`);
    } catch (e) { 
      console.log("Iniciando novo catálogo."); 
    }
  }

  const getUniqueId = (url) => {
    const idMatch = url.match(/detail\/([^/?#]+)/);
    return idMatch ? idMatch[1] : url;
  };

  const browser = await puppeteer.launch({ 
    headless: false, 
    args: ['--no-sandbox', '--window-size=1366,768'] 
  });

  let rawItems = [];

  try {
    const mainPage = await browser.newPage();
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    await mainPage.setUserAgent(userAgent);

    console.log(`Buscando por: ${searchTerm}...`);
    await mainPage.goto(startUrl, { waitUntil: 'networkidle2' });
    await mainPage.waitForSelector('.app-search-input input');
    await mainPage.type('.app-search-input input', searchTerm);
    await mainPage.keyboard.press('Enter');
    await mainPage.waitForSelector('.goods-item', { timeout: 30000 });

    // 2. Carregamento de Lotes (Paginação)
    for (let p = 0; p < MAX_PAGES; p++) {
      process.stdout.write(`Carregando lotes: ${p + 1}/${MAX_PAGES}\r`);
      
      await mainPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 2000));

      const clicou = await mainPage.evaluate(() => {
        const btn = document.querySelector('.more button');
        if (btn && btn.offsetParent !== null && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicou) break;
      await new Promise(r => setTimeout(r, 4000));

      // Filtro de ruído por preço médio para parar cedo se necessário
      const avgPrice = await mainPage.evaluate(() => {
        const prices = Array.from(document.querySelectorAll('.goods-item'))
                            .slice(-20)
                            .map(item => parseInt(item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '')) || 0);
        return prices.reduce((a, b) => a + b, 0) / (prices.length || 1);
      });

      if (avgPrice > 0 && avgPrice < 8000) {
        console.log(`\n[INFO] Ruído detectado (¥${Math.round(avgPrice)}). Parando busca.`);
        break;
      }
    }

    // Extração dos dados básicos
    rawItems = await mainPage.evaluate(() => {
      return Array.from(document.querySelectorAll('.goods-item')).map(item => {
        const name = item.querySelector('.goods-name')?.innerText || "";
        const price = parseInt(item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '')) || 0;
        const sold = !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold');
        return { nome: name, preco_iene: price, url: "https://www.doorzo.com" + item.getAttribute('href'), sold };
      });
    });

    console.log(`\nAnúncios encontrados: ${rawItems.length}`);
    
    // OTIMIZAÇÃO: Fechamos a aba principal ANTES de iniciar o scraping pesado
    console.log("Limpando memória: Fechando aba de pesquisa...");
    await mainPage.close();

  } catch (err) {
    console.error("\nErro na fase de pesquisa:", err.message);
  }

  // 3. Processamento de Dados e Sincronização
  const toScrape = [];
  const newlyAdded = [];
  const blacklist = ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"];

  rawItems.forEach(item => {
    const id = getUniqueId(item.url);
    const isNewModel = item.nome.toLowerCase().includes('new') && item.nome.toLowerCase().includes('ll') && item.nome.toLowerCase().includes('3ds');
    const isNotAccessory = !blacklist.some(word => item.nome.includes(word));
    
    if (item.sold || !isNewModel || item.preco_iene < PRECO_MINIMO || !isNotAccessory) return;

    const existingItem = catalog.find(c => getUniqueId(c.url) === id);
    if (existingItem) {
      existingItem.on = true; // Item validado no stock atual
      existingItem.preco_iene = item.preco_iene;
    } else {
      toScrape.push(item);
    }
  });

  // 4. Extração de Descrições com Pool de 5 Abas
  if (toScrape.length > 0) {
    console.log(`Minerando descrições de ${toScrape.length} novos consoles...`);
    const workers = [];
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    
    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
      const p = await browser.newPage();
      await p.setUserAgent(userAgent);
      workers.push(p);
    }

    for (let i = 0; i < toScrape.length; i += CONCURRENCY_LIMIT) {
      const chunk = toScrape.slice(i, i + CONCURRENCY_LIMIT);
      const results = await Promise.all(chunk.map(async (itemInfo, index) => {
        const tab = workers[index];
        try {
          await tab.goto(itemInfo.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
          await tab.waitForSelector('.html', { timeout: 12000 });
          const desc = await tab.evaluate(() => document.querySelector('.html')?.innerText || "");
          return { ...itemInfo, descricao: desc, on: true };
        } catch (e) { return null; }
      }));
      
      const valid = results.filter(r => r !== null);
      catalog.push(...valid);
      newlyAdded.push(...valid);
      process.stdout.write(`Progresso: [${catalog.filter(c => c.on).length}] consoles ativos\r`);
    }
    for (const tab of workers) await tab.close();
  }

  // 5. Salvamento Final: Ignora quem tem "on" como false
  const finalData = catalog.filter(item => item.on === true);
  fs.writeFileSync(FILENAME, JSON.stringify(finalData, null, 2));
  fs.writeFileSync(NEW_ITEMS_FILENAME, JSON.stringify(newlyAdded, null, 2));

  console.log(`\n\n✅ OPERAÇÃO CONCLUÍDA`);
  console.log(`- Catálogo Ativo Atualizado: ${finalData.length} itens`);
  console.log(`- Adicionados nesta rodada: ${newlyAdded.length}`);
  console.log(`- Removidos (Saíram de stock): ${catalog.length - finalData.length + newlyAdded.length}`);

  await browser.close();
})();