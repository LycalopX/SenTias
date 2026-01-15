const fs = require('fs');
const path = require('path');
const { getUniqueId, addLog } = require('../utils');
const { BLACKLIST_KEYWORDS } = require('../constants');

class CatalogService {
    constructor(config) {
        this.config = config;
        this.dataDir = path.join(__dirname, '../../data');
    }

    getFilePath(filename) {
        return path.join(this.dataDir, filename);
    }

    readCatalog(filename) {
        const filePath = this.getFilePath(filename);
        if (fs.existsSync(filePath)) {
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                addLog(`Erro ao ler ou parsear o catalogo ${filename}: ${e.message}`);
                return [];
            }
        }
        return [];
    }

    saveCatalog(filename, data) {
        const filePath = this.getFilePath(filename);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            addLog(`Falha Crítica ao escrever no arquivo ${filename}: ${e.message}`);
            return false;
        }
    }

    /**
     * Filtra itens que já existem ou que estão na blacklist/vendidos
     */
    filterNewItems(foundItems, currentCatalog, searchKeywords, priceRanges) {
        const globalMinPrice = priceRanges.length > 0 ? priceRanges[0].min : 0;
        const globalMaxPrice = priceRanges.length > 0 ? priceRanges[priceRanges.length - 1].max : Infinity;

        const toScrape = [];
        const uniqueFound = Array.from(new Map(foundItems.map(item => [getUniqueId(item.url), item])).values());

        uniqueFound.forEach(item => {
            const id = getUniqueId(item.url);

            // Filtros básicos
            if (BLACKLIST_KEYWORDS.some(word => item.nome.includes(word)) || item.sold) return;
            if (item.preco_iene < globalMinPrice || item.preco_iene > globalMaxPrice) return;

            // Filtro de palavras-chave
            const lowerCaseName = item.nome.toLowerCase();
            const hasAllKeywords = searchKeywords.every(kw => lowerCaseName.includes(kw));
            if (!hasAllKeywords) return;

            const existingItem = currentCatalog.find(c => getUniqueId(c.url) === id);
            if (existingItem) {
                existingItem.on = true; // Marca como online
            } else {
                toScrape.push(item);
            }
        });

        return toScrape;
    }
}

module.exports = CatalogService;

