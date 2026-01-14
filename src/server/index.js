const express = require('express');
const router = express.Router(); // Transformando em Router
const fs = require('fs');
const path = require('path');
const os = require('os');
const { stats, stopRequested } = require('../state');
const { runScraper } = require('../scraper/doorzo');
const { addLog } = require('../utils');

const CONFIG_PATH = path.join(__dirname, '../config.json');

// --- MANTEMOS SUAS FUNÇÕES ORIGINAIS ---
function getConfig() {
    const defaults = { PORT: 3000, FILENAME_ALL: "catalogo_completo.json" };
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

// Middleware para JSON (substitui o req.on('data') manual)
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
        console.log("Comando de início recebido.");
    }
    res.json({ success: true, message: "Scraper start command received." });
});

// API para Parar o Programa
router.post('/api/stop', (req, res) => {
    stopRequested.status = true;
    res.json({ success: true, message: "Scraper stop command sent." });
});

// Assets (Imagens/CSS)
router.use('/assets', express.static(path.join(__dirname, '../../assets')));

// Frontend (Dashboard)
router.get('/', (req, res) => {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    fs.readFile(dashboardPath, 'utf8', (err, data) => {
        if (err) return res.status(500).send('Error loading dashboard.');
        const html = data.replace('CONCURRENCY_LIMIT_PLACEHOLDER', config.CONCURRENCY_LIMIT);
        res.send(html);
    });
});

const { exec } = require('child_process');

// Rota de Emergência para limpar a RAM
router.post('/api/sys/cleanup', (req, res) => {
    // Mata todos os processos chrome/chromium do usuário
    exec("pkill -9 -u lycalopx chrome || pkill -9 -u lycalopx chromium", (err) => {
        addLog("Limpeza de emergência executada via Dashboard.");
        res.json({ success: true, message: "Processos Chromium encerrados." });
    });
});

// --- INICIALIZAÇÃO ---
addLog('Servidor iniciado. Scraper em modo de espera.');
stats.status = 'Aguardando comando';
runScraper();

module.exports = router; // Exportamos o router para o MasterHub