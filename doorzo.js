const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const searchTerm = "Newニンテンドー3DS LL";
  const startUrl = "https://www.doorzo.com/pt";

  const browser = await puppeteer.launch({ 
    headless: false, 
    args: ['--no-sandbox', '--window-size=1366,768'] 
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    console.log(`Conectando ao Doorzo...`);
    await page.goto(startUrl, { waitUntil: 'networkidle2' });

    console.log(`Buscando por: ${searchTerm}`);
    const searchInputSelector = '.app-search-input input';
    await page.waitForSelector(searchInputSelector);
    await page.type(searchInputSelector, searchTerm);
    await page.keyboard.press('Enter');

    console.log("Aguardando carregamento da lista de resultados...");
    await page.waitForSelector('.goods-item', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Etapa 1: Coletar os links básicos da primeira página de resultados
    const initialLinks = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.goods-item'));
      return items.map(item => ({
        url: "https://www.doorzo.com" + item.getAttribute('href')
      }));
    });

    console.log(`Encontrados ${initialLinks.length} anúncios. Iniciando captura de descrições...`);

    const finalCatalog = [];

    // Etapa 2: Navegar em cada link para extrair a descrição (Deep Scraping)
    for (let i = 0; i < initialLinks.length; i++) {
        const itemUrl = initialLinks[i].url;
        console.log(`[${i+1}/${initialLinks.length}] Analisando: ${itemUrl}`);
        
        try {
            await page.goto(itemUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
            // Espera o seletor da descrição ou do nome carregar
            await page.waitForSelector('.html', { timeout: 10000 });
            await new Promise(r => setTimeout(r, 1500)); // Pausa para renderização do Vue

            const data = await page.evaluate(() => {
                const nameEl = document.querySelector('.name') || document.querySelector('.goods-name');
                const priceEl = document.querySelector('.price-com');
                const descEl = document.querySelector('.html'); // Onde fica a descrição no Doorzo

                return {
                    nome: nameEl ? nameEl.innerText.trim() : "N/A",
                    preco_iene: priceEl ? parseInt(priceEl.innerText.replace(/[^0-9]/g, '')) : 0,
                    descricao: descEl ? descEl.innerText.trim() : "Descrição não encontrada"
                };
            });

            finalCatalog.push({ ...data, url: itemUrl });
        } catch (e) {
            console.log(`⚠️ Pulei um item por erro de carregamento: ${itemUrl}`);
        }
    }

    // Salvar o arquivo detalhado
    fs.writeFileSync('catalogo_3ds_detalhado.json', JSON.stringify(finalCatalog, null, 2));
    console.log(`\n✅ SUCESSO! ${finalCatalog.length} itens catalogados com descrição.`);
    console.log(`📂 Arquivo criado: catalogo_3ds_detalhado.json`);

  } catch (err) {
    console.error("\n❌ Erro de execução:", err.message);
  } finally {
    await browser.close();
  }
})();