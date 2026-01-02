const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const searchTerm = "Newニンテンドー3DS LL";
  const startUrl = "https://www.doorzo.com/pt";
  const MAX_PAGES = 100; 
  const PRECO_MINIMO = 10000;
  const CSV_FILENAME = 'analise_lotes.csv';
  const CSV_FILENAME_PATH = path.join(__dirname, '../../data', CSV_FILENAME);


  const browser = await puppeteer.launch({
    headless: false,
    args: ['--window-size=1200,800', '--disable-dev-shm-usage', '--no-sandbox']
  });

  const page = await browser.newPage();
  
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  await page.setUserAgent(userAgent);

  try {
    console.log(`=== ANALISADOR OTIMIZADO V2 (RESILIENTE) ===`);
    
    await page.goto(startUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.app-search-input input');
    await page.type('.app-search-input input', searchTerm);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.goods-item', { timeout: 30000 });

    let totalValidosAcumulados = 0;
    let totalItensAcumulados = 0;
    let historicoLotes = [];

    for (let p = 1; p <= MAX_PAGES; p++) {
      // Espera inicial para estabilização
      await new Promise(r => setTimeout(r, 1500)); 

      const currentData = await page.evaluate((minPreco) => {
        const items = Array.from(document.querySelectorAll('.goods-item'));
        const totalNoDom = items.length;
        
        const validos = items.filter(item => {
          const nome = item.querySelector('.goods-name')?.innerText.toLowerCase() || "";
          const preco = parseInt(item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '')) || 0;
          const sold = !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold');
          
          const temPalavras = nome.includes('new') && nome.includes('3ds') && (nome.includes('ll') || nome.includes('xl'));
          return temPalavras && preco >= minPreco && !sold;
        });

        return { totalNoDom, totalValidos: validos.length };
      }, PRECO_MINIMO);

      // Verificação de estagnação: Se o contador não subiu, tentamos um scroll forçado
      if (p > 1 && currentData.totalNoDom === totalItensAcumulados) {
        process.stdout.write(`Tentando forçar carregamento do Lote ${p}...\r`);
        await page.evaluate(() => window.scrollBy(0, -200));
        await new Promise(r => setTimeout(r, 500));
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 2000));
      }

      const novosValidos = currentData.totalValidos - totalValidosAcumulados;
      const novosTotais = currentData.totalNoDom - totalItensAcumulados;
      
      totalValidosAcumulados = currentData.totalValidos;
      totalItensAcumulados = currentData.totalNoDom;

      console.log(`Lote ${p.toString().padStart(2, '0')}: ${novosValidos.toString().padStart(2, '0')} novos válidos | Total Bruto: ${totalItensAcumulados}`);
      
      historicoLotes.push({ lote: p, novosValidos, novosTotais, acumuladoValidos: totalValidosAcumulados, acumuladoTotais: totalItensAcumulados });

      // Clique Inteligente: tenta o botão ou o link pai
      const clicou = await page.evaluate(() => {
        const btn = document.querySelector('.more button') || document.querySelector('.more a');
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicou) {
        console.log("\n[FIM] Botão 'MAIS' não encontrado.");
        break;
      }

      // Espera AJAX proporcional à velocidade da rede
      await new Promise(r => setTimeout(r, 2500)); 
    }

    const csvHeaders = "Lote,Novos Validos,Novos Totais,Acumulado Validos,Acumulado Totais\n";
    const csvRows = historicoLotes.map(l => `${l.lote},${l.novosValidos},${l.novosTotais},${l.acumuladoValidos},${l.acumuladoTotais}`).join("\n");
    fs.writeFileSync(CSV_FILENAME_PATH, csvHeaders + csvRows);
    console.log(`\nArquivo '${CSV_FILENAME}' salvo.`);

  } catch (err) {
    console.error(`Erro: ${err.message}`);
  } finally {
    await browser.close();
  }
})();