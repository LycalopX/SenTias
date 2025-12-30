const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  // Configuração da busca (New 3DS LL no Mercari via Doorzo)
  const searchTerm = "Newニンテンドー3DS LL";
  const searchUrl = `https://www.doorzo.com/pt/mall/mercari/search?keywords=${encodeURIComponent(searchTerm)}`;

  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  
  // Definindo um User-Agent comum para evitar bloqueios simples
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log(`Abrindo: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'networkidle2' });

  // Espera os itens carregarem (seletor baseado na estrutura do Doorzo)
  await page.waitForSelector('.goods-item');

  // Scroll automático para carregar mais itens (lazy loading)
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      let distance = 100;
      let timer = setInterval(() => {
        let scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });

  // Extração dos dados
  const products = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.goods-item'));
    return items.map(item => {
      const name = item.querySelector('.name')?.innerText.trim();
      const priceText = item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '');
      const link = item.getAttribute('href');
      const img = item.querySelector('img')?.getAttribute('src');
      
      return {
        nome: name,
        preco_iene: parseInt(priceText),
        url: link ? `https://www.doorzo.com${link}` : null,
        imagem: img
      };
    });
  });

  // Salva em JSON
  fs.writeFileSync('catalogo_3ds.json', JSON.stringify(products, null, 2));
  
  console.log(`Finalizado! ${products.length} itens catalogados em catalogo_3ds.json`);
  await browser.close();
})();