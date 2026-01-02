const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PORT, CONCURRENCY_LIMIT, FILENAME_ALL } = require('../config');
const { stats, stopRequested } = require('../state');
const { runScraper } = require('../scraper/doorzo');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API para Status
  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

    // API para Download do Catálogo
  if (req.url === '/api/download') {
    const filePath = path.join(__dirname, '../../data', FILENAME_ALL);
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found.');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${FILENAME_ALL}"`);
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

  // Frontend
  if (req.url === '/') {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    fs.readFile(dashboardPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading dashboard.');
        return;
      }

      const html = data.replace('CONCURRENCY_LIMIT_PLACEHOLDER', CONCURRENCY_LIMIT);
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard rodando! Acesse de um dos seguintes endereços:`);
    console.log(`- No seu computador: http://localhost:${PORT}`);
    console.log(`- Na sua rede local: http://${localIp}:${PORT}`);
    console.log('\nIniciando o bot do scraper...');
    stats.status = 'Aguardando comando';
    runScraper();
});

module.exports = server;
