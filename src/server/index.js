const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { stats, stopRequested } = require('../state');
const { runScraper } = require('../scraper/doorzo');
const { addLog } = require('../utils');

const CONFIG_PATH = path.join(__dirname, '../config.json');

function getConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        console.error("Error reading config.json:", error);
        return {}; // Return empty object on error
    }
}

function saveConfig(config, callback) {
    fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8', callback);
}

let config = getConfig();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: "pong" }));
      return;
  }

  // API para Config
  if (req.url === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
  }

  if (req.url === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
          body += chunk.toString();
      });
      req.on('end', () => {
          try {
              const newConfig = JSON.parse(body);
              // Simple validation
              if (newConfig.searchTerm && Array.isArray(newConfig.searchKeywords)) {
                  config = { ...config, ...newConfig }; // Merge new config with existing
                  saveConfig(config, (err) => {
                      if (err) {
                          res.writeHead(500, { 'Content-Type': 'application/json' });
                          res.end(JSON.stringify({ success: false, message: "Failed to save config." }));
                          return;
                      }
                      res.writeHead(200, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ success: true, message: "Config saved." }));
                  });
              } else {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: false, message: "Invalid config format." }));
              }
          } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: "Invalid JSON." }));
          }
      });
      return;
  }

  // API para Status
  if (req.url === '/api/stats') {
    const uptime = stats.startTime ? Math.floor((new Date() - new Date(stats.startTime)) / 1000) : 0;
    const responseStats = { ...stats, uptime };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseStats));
    return;
  }

    // API para Download do Catálogo
  if (req.url === '/api/download') {
    const filePath = path.join(__dirname, '../../data', config.FILENAME_ALL);
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found.');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${config.FILENAME_ALL}"`);
      res.writeHead(200);
      res.end(data);
    });
    return;
  }

  // API para Iniciar o Scraper
  if (req.url === '/api/start' && req.method === 'POST') {
    if (stats.status === 'Parado' || stats.status === "Aguardando comando") {
        stopRequested.status = false;
        stats.status = 'Em Espera'; // O loop vai pegar esse status
        console.log("Comando de início recebido. O próximo ciclo começará em breve.");
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: "Scraper start command received." }));
    return;
  }

  // API para Parar o Programa
  if (req.url === '/api/stop' && req.method === 'POST') {
    stopRequested.status = true;
    console.log("Comando de parada recebido. O scraper irá parar após a conclusão do item atual.");
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: "Scraper stop command sent." }));
    return;
  }


  if (req.url.startsWith('/assets/')) {
    const assetPath = path.join(__dirname, '..', '..', req.url);
    const stream = fs.createReadStream(assetPath);
    stream.on('error', () => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Asset not found.');
    });
    // Guess mime type
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    };
    const ext = path.extname(assetPath).toLowerCase();
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mimeType });
    stream.pipe(res);
    return;
  }

  // Frontend
  if (req.url === '/') {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    fs.readFile(dashboardPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading dashboard.');
        return;
      }

      const html = data.replace('CONCURRENCY_LIMIT_PLACEHOLDER', config.CONCURRENCY_LIMIT);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

function getLocalIp() {
    const nets = os.networkInterfaces();
    const prioritizedInterfaces = ['Ethernet', 'Wi-Fi', 'wlan0', 'eth0'];
    let fallbackIp = null;

    for (const name of prioritizedInterfaces) {
        if (nets[name]) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
    }

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                if (!fallbackIp) {
                    fallbackIp = net.address;
                }
            }
        }
    }
    
    return fallbackIp || '0.0.0.0';
}

const localIp = getLocalIp();

server.listen(config.PORT, '0.0.0.0', () => {
    console.log(`Dashboard rodando! Acesse de um dos seguintes endereços:`);
    console.log(`- No seu computador: http://localhost:${config.PORT}`);
    console.log(`- Na sua rede local: http://${localIp}:${config.PORT}`);
    console.log('\nIniciando o bot do scraper...');
    addLog('Servidor iniciado. Scraper em modo de espera.');
    stats.status = 'Aguardando comando';
    runScraper();
});

module.exports = server;
