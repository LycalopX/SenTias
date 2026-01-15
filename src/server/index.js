const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { stats, stopRequested } = require('../state');
const Scraper = require('../services/scraper');
const { addLog } = require('../utils');

const CONFIG_PATH = path.join(__dirname, '../config.json');

function getConfig() {
    const defaults = {
        PORT: 3000,
        FILENAME_ALL: "catalogo_completo.json",
        FILENAME_NEW: "catalogo_novos_do_ciclo.json",
        CONCURRENCY_LIMIT: 5,
        RECYCLE_THRESHOLD: 20,
        WAIT_BETWEEN_CYCLES: 1800000
    };
    try {
        const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
        return { ...defaults, ...JSON.parse(configData) };
    } catch (error) {
        console.error("Warning: Could not read config.json.", error);
        return defaults;
    }
}

function saveConfig(config, callback) {
    fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8', callback);
}

let config = getConfig();
const scraperInstance = new Scraper(config, stats, stopRequested);

// Middleware para JSON
router.use(express.json());

// API para Config (GET)
router.get('/api/config', (req, res) => {
    res.json(config);
});

// API para Config (POST)
router.post('/api/config', (req, res) => {
    const newConfig = req.body;
    if (newConfig.searchTerm && Array.isArray(newConfig.searchKeywords)) {
        config = { ...config, ...newConfig };
        scraperInstance.config = config; // Atualiza a config na instância do scraper
        saveConfig(config, (err) => {
            if (err) return res.status(500).json({ success: false, message: "Failed to save config." });
            res.json({ success: true, message: "Config saved." });
        });
    } else {
        res.status(400).json({ success: false, message: "Invalid config format." });
    }
});

// API para Status
router.get('/api/stats', (req, res) => {
    const uptime = stats.startTime ? Math.floor((new Date() - new Date(stats.startTime)) / 1000) : 0;
    res.json({ ...stats, uptime });
});

// API para Download do Catálogo
router.get('/api/download', (req, res) => {
    const filePath = path.join(__dirname, '../../data', config.FILENAME_ALL);
    res.download(filePath, config.FILENAME_ALL, (err) => {
        if (err) res.status(404).send('File not found.');
    });
});

// API para Iniciar o Scraper
router.post('/api/start', (req, res) => {
    if (stats.status === 'Parado' || stats.status === "Aguardando comando") {
        stopRequested.status = false;
        stats.status = 'Em Espera';
        addLog("Comando de início recebido.");
        // O scraper já está rodando em loop, ele vai detectar que o status mudou ou vai sair do sleep
    }
    res.json({ success: true, message: "Scraper start command received." });
});

// API para Parar o Programa
router.post('/api/stop', (req, res) => {
    stopRequested.status = true;
    addLog("Comando de parada recebido.");
    res.json({ success: true, message: "Scraper stop command sent." });
});

// Assets (Imagens/CSS)
router.use('/assets', express.static(path.join(__dirname, '../../assets')));

// Frontend (Dashboard)
router.get('/', (req, res) => {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    fs.readFile(dashboardPath, 'utf8', (err, data) => {
        if (err) return res.status(500).send('Error loading dashboard.');
        res.send(data);
    });
});

// --- INICIALIZAÇÃO ---
addLog('Servidor iniciado. Scraper em modo de espera.');
stats.status = 'Aguardando comando';
scraperInstance.run(); // Inicia o loop do scraper

module.exports = router; 