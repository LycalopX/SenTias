const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const { cleanDescription, addLog } = require('../utils');
const { SCRAPER_STATUS, USER_AGENTS } = require('../constants');
const DoorzoApi = require('./doorzo-api');
const CatalogService = require('./catalog.js');

puppeteer.use(StealthPlugin());

class Scraper {
    constructor(config, stats, stopRequested) {
        this.config = config;
        this.stats = stats;
        this.stopRequested = stopRequested;
        this.browser = null;
        this.catalogService = new CatalogService(config);
        this.doorzoApi = null;
    }

    async initBrowser() {
        if (this.browser) return;

        const launchOptions = {
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        };

        if (os.platform() === 'win32' && this.config.executablePath) {
            addLog(`Usando navegador customizável em: ${this.config.executablePath}`);
            launchOptions.executablePath = this.config.executablePath;
        }

        this.browser = await puppeteer.launch(launchOptions);
        this.doorzoApi = new DoorzoApi(this.browser);
    }

    async run() {
        try {
            if (!this.stats.startTime) {
                this.stats.startTime = new Date();
            }

            await this.initBrowser();

            while (true) {
                if (this.stopRequested.status) {
                    this.handleStop();
                    break;
                }

                try {
                    await this.executeCycle();
                } catch (innerError) {
                    addLog(`Erro no ciclo: ${innerError.message}`);
                    this.stats.errors++;
                }

                if (this.stopRequested.status) {
                    this.handleStop();
                    break;
                }

                this.stats.status = SCRAPER_STATUS.IDLE;
                addLog(`Ciclo finalizado. Dormindo ${this.config.WAIT_BETWEEN_CYCLES / 60000} min.`);

                // Espera respeitando o pedido de parada
                const sleepTime = this.config.WAIT_BETWEEN_CYCLES;
                const checkInterval = 5000;
                for (let elapsed = 0; elapsed < sleepTime; elapsed += checkInterval) {
                    if (this.stopRequested.status) break;
                    await new Promise(r => setTimeout(r, checkInterval));
                }
            }
        } catch (fatalError) {
            this.stats.status = SCRAPER_STATUS.ERROR;
            addLog(`ERRO FATAL: ${fatalError.message}`);
            console.error("Erro fatal:", fatalError);
        } finally {
            await this.cleanup();
        }
    }

    async executeCycle() {
        this.resetCycleStats();
        this.stats.status = SCRAPER_STATUS.RESEARCHING;

        let catalog = this.catalogService.readCatalog(this.config.FILENAME_ALL);
        catalog.forEach(item => item.on = false);
        this.stats.totalItems = catalog.length;

        const mainPage = await this.browser.newPage();
        await mainPage.setRequestInterception(true);
        mainPage.on('request', r => ['image', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue());

        addLog("Iniciando busca por faixas de preço...");
        let allFoundItems = [];

        for (const range of this.config.priceRanges) {
            if (this.stopRequested.status) break;
            this.stats.currentRange = `¥${range.min} - ¥${range.max}`;
            addLog(`Buscando: ${this.stats.currentRange}`);

            try {
                // Passa callback para atualizar lotes em tempo real
                const lots = await this.doorzoApi.searchItemsInRange(
                    mainPage,
                    this.config.searchTerm,
                    range.min,
                    range.max,
                    () => this.stats.lotsFound++
                );

                addLog(`Faixa ¥${range.min}-¥${range.max} finalizada: ${lots} lotes abertos.`);

                const items = await this.doorzoApi.extractItemsFromList(mainPage);
                allFoundItems.push(...items);
            } catch (e) {
                addLog(`Erro na faixa ${this.stats.currentRange}: ${e.message}`);
            }
        }
        await mainPage.close();

        this.stats.totalItemsFound = allFoundItems.length;
        if (this.stopRequested.status) return;

        const toScrape = this.catalogService.filterNewItems(
            allFoundItems,
            catalog,
            this.config.searchKeywords,
            this.config.priceRanges
        );

        let newlyScraped = [];
        if (toScrape.length > 0) {
            newlyScraped = await this.mineDescriptions(toScrape);
        }

        this.saveResults(catalog, newlyScraped);
    }

    async mineDescriptions(toScrape) {
        this.stats.status = SCRAPER_STATUS.MINING;
        this.stats.progressTotal = toScrape.length;
        this.stats.progressCurrent = 0;
        addLog(`Minerando ${toScrape.length} novos itens (Sequencial)...`);

        const newlyScraped = [];
        let tab = await this.browser.newPage();
        await tab.setRequestInterception(true);
        tab.on('request', r => (['image', 'font', 'media'].includes(r.resourceType()) || r.url().includes('google')) ? r.abort() : r.continue());
        
        let uses = 0;

        for (const item of toScrape) {
            if (this.stopRequested.status) break;

            // Recicla a aba se atingir o limite
            if (uses >= this.config.RECYCLE_THRESHOLD) {
                await tab.close().catch(() => {});
                tab = await this.browser.newPage();
                await tab.setRequestInterception(true);
                tab.on('request', r => (['image', 'font', 'media'].includes(r.resourceType()) || r.url().includes('google')) ? r.abort() : r.continue());
                uses = 0;
            }

            const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
            await tab.setUserAgent(ua);

            let success = false;
            for (let retry = 0; retry < 3 && !success && !this.stopRequested.status; retry++) {
                try {
                    uses++;
                    const desc = await this.doorzoApi.getItemDescription(tab, item.url);

                    if (desc) {
                        const cleanedDesc = cleanDescription(desc);
                        if (cleanedDesc && cleanedDesc.length > 20 && !/Access Denied|Error/i.test(cleanedDesc)) {
                            newlyScraped.push({
                                ...item,
                                descricao: cleanedDesc,
                                on: true,
                                detectado_em: new Date().toISOString()
                            });
                            this.stats.lastScrapedName = item.nome;
                            success = true;
                        }
                    }

                    if (!success) throw new Error("Descrição vazia ou inválida");

                } catch (e) {
                    const isLastRetry = retry === 2;
                    if (!isLastRetry) {
                        const waitTime = (Math.pow(2, retry) * 2000) + (Math.random() * 1000);
                        await new Promise(r => setTimeout(r, waitTime));
                    }
                }
            }

            if (success) {
                this.stats.progressCurrent++;
                this.stats.newItemsLastCycle++;
            } else {
                addLog(`FALHA FINAL para ${item.nome}`);
                this.stats.failedItemsCount++;
            }

            // Respiro de 1s para a CPU entre itens (conforme sugerido)
            await new Promise(r => setTimeout(r, 1000));
        }

        if (tab) await tab.close().catch(() => {});
        return newlyScraped;
    }

    saveResults(catalog, newlyScraped) {
        addLog(`Salvando resultados do ciclo...`);

        this.catalogService.saveCatalog(this.config.FILENAME_NEW, newlyScraped);

        const stillOnline = catalog.filter(item => item.on === true);

        const finalCatalogMap = new Map();
        stillOnline.forEach(item => finalCatalogMap.set(item.url, item));
        newlyScraped.forEach(item => finalCatalogMap.set(item.url, item));

        const finalCatalogUnique = Array.from(finalCatalogMap.values());

        this.catalogService.saveCatalog(this.config.FILENAME_ALL, finalCatalogUnique);

        this.stats.totalItems = finalCatalogUnique.length;
        this.stats.lastUpdate = new Date().toLocaleTimeString();
        addLog(`Catálogo atualizado: ${finalCatalogUnique.length} itens.`);
    }

    resetCycleStats() {
        this.stats.newItemsLastCycle = 0;
        this.stats.progressCurrent = 0;
        this.stats.progressTotal = 0;
        this.stats.lotsFound = 0;
        this.stats.totalItemsFound = 0;
        this.stats.failedItemsCount = 0;
    }

    handleStop() {
        this.stopRequested.status = false;
        this.stats.status = SCRAPER_STATUS.STOPPED;
        addLog("Scraper parado pelo usuário.");
    }

    async cleanup() {
        if (this.browser) {
            addLog("Fechando navegador...");
            await this.browser.close().catch(() => { });
            this.browser = null;
        }
    }
}

module.exports = Scraper;