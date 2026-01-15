const { addLog } = require('../utils');
const { SELECTORS } = require('../constants');

class DoorzoApi {
    constructor(browserInstance) {
        this.browser = browserInstance;
    }

    async searchItemsInRange(page, searchTerm, minPrice, maxPrice, onLotFound) {
        const url = `https://www.doorzo.com/pt/search?keywords=${encodeURIComponent(searchTerm)}&price_min=${minPrice}&price_max=${maxPrice}`;
        
        addLog(`Navegando para busca: ¥${minPrice} - ¥${maxPrice}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        
        let lotsFound = 1;
        if (onLotFound) onLotFound();
        process.stdout.write(`Lote ${lotsFound} aberto para esta faixa.\r`);

        const moreBtnSelector = '.more a, .more button'; // Hardcoded para garantir compatibilidade exata com o original

        // Lógica otimizada para velocidade
        for (let p = 0; p < 35; p++) {
            if (this.browser === null) break;

            await page.evaluate((sel) => {
                document.querySelectorAll(sel).forEach(el => el.remove());
                window.scrollTo(0, document.body.scrollHeight);
            }, SELECTORS.OVERLAYS);
            
            // Removido delay inicial fixo de 1000ms para agilidade
            
            // Tenta achar o botão com timeout de 5s. Se não achar, aciona o Nudge.
            let btn = await page.waitForSelector(SELECTORS.MORE_BUTTON, { visible: true, timeout: 5000 }).catch(() => null);
            
            // Se não achou, tenta um scroll de "cutucada" (scroll up/down) para forçar lazy load
            if (!btn) {
                await page.evaluate(() => window.scrollBy(0, -200));
                await new Promise(r => setTimeout(r, 200)); // Delay reduzido
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await new Promise(r => setTimeout(r, 500)); // Delay reduzido
                btn = await page.waitForSelector(SELECTORS.MORE_BUTTON, { visible: true, timeout: 3000 }).catch(() => null);
            }
            
            if (btn) {
                const isBusy = await page.evaluate(sel => {
                    const el = document.querySelector(sel);
                    return el?.disabled || el?.classList.contains('is-loading');
                }, SELECTORS.MORE_BUTTON);

                if (!isBusy) {
                    await page.evaluate(sel => document.querySelector(sel)?.click(), SELECTORS.MORE_BUTTON);
                    
                    lotsFound++;
                    if (onLotFound) onLotFound();
                    
                    process.stdout.write(`Lote ${lotsFound} aberto para esta faixa.\r`);
                    
                    // Espera pós-clique reduzida para 800ms (era 1500ms)
                    await new Promise(r => setTimeout(r, 800));
                } else { 
                    // Se ocupado, espera 1s e tenta de novo (p--) - Loop de proteção
                    await new Promise(r => setTimeout(r, 1000)); 
                    p--; 
                }
            } else {
                break;
            }
        }
        
        process.stdout.write('\n');
        return lotsFound;
    }

    async extractItemsFromList(page) {
        return await page.evaluate((sel) => {
            return Array.from(document.querySelectorAll(sel.GOODS_ITEM)).map(item => ({
                nome: item.querySelector(sel.GOODS_NAME)?.innerText || "",
                preco_iene: parseInt(item.querySelector(sel.PRICE)?.innerText.replace(/[^0-9]/g, '')) || 0,
                url: "https://www.doorzo.com" + (item.getAttribute('href') || ""),
                sold: !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold')
            }));
        }, SELECTORS);
    }

    async getItemDescription(page, url) {
        // Lógica original do doorzo.js para descrição
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        if (response && response.status() === 403) {
             // O original logava e breakava. Aqui lançamos erro para o retry tratar.
             throw new Error(`Acesso negado (403)`);
        }
        
        // Verifica captcha/acesso negado no conteúdo (Lógica original)
        const pageContent = await page.content();
        if (pageContent.includes('Verifique se você é humano') || pageContent.includes('captcha') || pageContent.includes('Access Denied')) {
             throw new Error(`Captcha/Verificação humana detectada`);
        }

        const descriptionSelector = '.html';
        const jsonLdSelector = 'script[type="application/ld+json"]';

        // Wait original
        await page.waitForFunction(
            (descSel, jsonSel) => {
                const htmlDiv = document.querySelector(descSel);
                const jsonLdScript = document.querySelector(jsonSel);
                return (htmlDiv && htmlDiv.innerText && htmlDiv.innerText.length > 50) || jsonLdScript;
            },
            { timeout: 10000 },
            descriptionSelector, jsonLdSelector
        ).catch(() => {});

        // Extração original
        return await page.evaluate((descSel, jsonSel) => {
            const scripts = Array.from(document.querySelectorAll(jsonSel));
            for (const s of scripts) {
                try {
                    const json = JSON.parse(s.innerText);
                    const graph = json['@graph'] || [json];
                    const prod = graph.find(obj => obj['@type'] === 'Product');
                    if (prod && prod.description) return prod.description;
                } catch (e) {}
            }
            return document.querySelector(descSel)?.innerText || null;
        }, descriptionSelector, jsonLdSelector);
    }
}

module.exports = DoorzoApi;