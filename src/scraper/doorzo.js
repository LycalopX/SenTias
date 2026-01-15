const fs = require('fs');
const path = require('path');
const Scraper = require('../services/scraper');
const { stats, stopRequested } = require('../state');

const CONFIG_PATH = path.join(__dirname, '../config.json');

function getConfig() {
    try {
        const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
        return JSON.parse(configData);
    } catch (error) {
        console.error("Error loading config.json:", error);
        process.exit(1);
    }
}

async function runStandalone() {
    const config = getConfig();
    const scraper = new Scraper(config, stats, stopRequested);

    console.log("Iniciando Scraper em modo Standalone...");
    stats.status = "Em Espera";
    await scraper.run();
}

if (require.main === module) {
    runStandalone();
}

module.exports = { runScraper: () => { } }; // Export dummy para não quebrar imports antigos se existirem