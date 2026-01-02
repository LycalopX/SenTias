
const http = require('http');
const fs = require('fs');
const path = require('path');
const { CONCURRENCY_LIMIT, PORT } = require('../config');

const STATS_PATH = path.join(__dirname, '../../data', 'stats.json');
const STOP_PATH = path.join(__dirname, '../../data', 'stop');

const server = http.createServer((req, res) => {
  // API para Status
  if (req.url === '/api/stats') {
    fs.readFile(STATS_PATH, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading stats.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // API para Parar o Programa
  if (req.url === '/api/stop' && req.method === 'POST') {
    fs.writeFileSync(STOP_PATH, '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Frontend
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
});

server.listen(PORT);

module.exports = server;
