const puppeteer = require('puppeteer-core');
const fs = require('fs');
const http = require('http');

/**
 * CONFIGURAÇÕES GERAIS
 */
const searchTerm = "Newニンテンドー3DS LL";
const FILENAME = `new_3ds_xl_catalogo_completo.json`;
const PORT = 3000; 

const CONCURRENCY_LIMIT = 7; 
const RECYCLE_THRESHOLD = 25; 
const WAIT_BETWEEN_CYCLES = 1000 * 60 * 10; 

const priceRanges = [
  { min: 22000, max: 24250 },
  { min: 24251, max: 26500 },
  { min: 26501, max: 28750 },
  { min: 28751, max: 31000 }
];

/**
 * ESTADO GLOBAL
 */
let stats = {
  status: "Iniciando...",
  totalItems: 0,
  newItemsLastCycle: 0,
  lastUpdate: "-",
  logs: [],
  currentRange: "",
  progressCurrent: 0,
  progressTotal: 0,
  stopRequested: false // Flag para encerramento manual
};

let browser;
let originalCatalogSnapshot = []; // Backup para caso de encerramento prematuro

function addLog(msg) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${msg}`;
  console.log(entry);
  stats.logs.unshift(entry);
  if (stats.logs.length > 50) stats.logs.pop();
}

/**
 * SERVIDOR DA INTERFACE WEB
 */
const server = http.createServer((req, res) => {
  // API para Status
  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  // API para Parar o Programa
  if (req.url === '/api/stop' && req.method === 'POST') {
    stats.stopRequested = true;
    addLog("⚠️ Solicitação de parada manual recebida via Dashboard.");
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Frontend
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html lang="pt">
    <head>
        <meta charset="UTF-8">
        <title>Doorzo Scraper Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #0f172a; color: #f8fafc; font-family: sans-serif; }
            .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
            .accent { color: #f59e0b; }
            .progress-bar { transition: width 0.3s ease-in-out; }
            .btn-stop { background: #dc2626; transition: all 0.2s; }
            .btn-stop:hover { background: #b91c1c; transform: scale(1.02); }
        </style>
    </head>
    <body class="p-8">
        <div class="max-w-6xl mx-auto">
            <header class="flex justify-between items-center mb-8">
                <div>
                    <h1 class="text-3xl font-bold accent">Doorzo Scraper <span class="text-white text-sm font-normal">Controle Manual</span></h1>
                    <p class="text-slate-400">Gerenciamento de mineração perpétua</p>
                </div>
                <div class="flex gap-4">
                    <button onclick="stopScraper()" id="stop-btn" class="btn-stop px-6 py-2 rounded-lg font-bold shadow-lg">Finalizar e Salvar Agora</button>
                    <div id="status-badge" class="px-4 py-2 rounded-full bg-blue-600 text-sm font-bold uppercase tracking-wider flex items-center">Carregando...</div>
                </div>
            </header>

            <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div class="card">
                    <p class="text-slate-400 text-sm">No Banco de Dados</p>
                    <p id="total-items" class="text-4xl font-bold mt-2">-</p>
                </div>
                <div class="card">
                    <p class="text-slate-400 text-sm">Minerados (Ciclo Atual)</p>
                    <p id="new-items" class="text-4xl font-bold mt-2 text-green-400">-</p>
                </div>
                <div class="card">
                    <p class="text-slate-400 text-sm">Último Checkpoint</p>
                    <p id="last-update" class="text-2xl font-bold mt-3">-</p>
                </div>
                <div class="card">
                    <p class="text-slate-400 text-sm">Workers</p>
                    <p class="text-4xl font-bold mt-2 text-amber-500">${CONCURRENCY_LIMIT}</p>
                </div>
            </div>

            <div id="progress-section" class="mb-8 hidden">
                <div class="flex justify-between mb-2 text-sm font-medium">
                    <span>Progresso de Checagem de Descrição</span>
                    <span id="progress-text" class="accent">0/0</span>
                </div>
                <div class="w-full bg-slate-700 rounded-full h-4">
                    <div id="progress-fill" class="bg-amber-500 h-4 rounded-full progress-bar" style="width: 0%"></div>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="lg:col-span-2 card">
                    <h2 class="text-xl font-bold mb-4">📋 Console de Eventos</h2>
                    <div id="log-container" class="h-96 overflow-y-auto text-sm font-mono space-y-1 bg-black/30 p-4 rounded-lg"></div>
                </div>
                <div class="card">
                    <h2 class="text-xl font-bold mb-4">Meta</h2>
                    <div id="current-range" class="p-4 bg-slate-800 rounded-lg text-center border border-amber-500/30 font-bold">-</div>
                    <div class="mt-6 text-sm text-slate-500">
                        <p class="mb-2 font-bold text-slate-300">Regras de Salvamento:</p>
                        <ul class="list-disc ml-4 space-y-2">
                            <li>Se usar o botão: <span class="text-blue-400">Anexa</span> novos itens ao banco atual.</li>
                            <li>No fim do ciclo: <span class="text-green-400">Limpa</span> itens antigos/vendidos.</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>

        <script>
            async function stopScraper() {
                if(!confirm("Deseja interromper a mineração e salvar os itens capturados até agora?")) return;
                try {
                    await fetch('/api/stop', { method: 'POST' });
                    document.getElementById('stop-btn').innerText = "Encerrando...";
                    document.getElementById('stop-btn').disabled = true;
                } catch(e) {}
            }

            async function updateDashboard() {
                try {
                    const res = await fetch('/api/stats');
                    const data = await res.json();
                    
                    document.getElementById('status-badge').innerText = data.status;
                    document.getElementById('status-badge').className = \`px-4 py-2 rounded-full text-sm font-bold uppercase tracking-wider \${data.status.includes('Minerando') ? 'bg-amber-600' : (data.status.includes('Erro') ? 'bg-red-600' : 'bg-green-600')}\`;
                    
                    document.getElementById('total-items').innerText = data.totalItems;
                    document.getElementById('new-items').innerText = '+' + data.newItemsLastCycle;
                    document.getElementById('last-update').innerText = data.lastUpdate;
                    document.getElementById('current-range').innerText = data.currentRange || "Em Espera";
                    
                    if(data.progressTotal > 0) {
                        document.getElementById('progress-section').classList.remove('hidden');
                        document.getElementById('progress-text').innerText = data.progressCurrent + ' / ' + data.progressTotal;
                        const pct = Math.floor((data.progressCurrent / data.progressTotal) * 100);
                        document.getElementById('progress-fill').style.width = pct + '%';
                    } else {
                        document.getElementById('progress-section').classList.add('hidden');
                    }

                    const logBox = document.getElementById('log-container');
                    logBox.innerHTML = data.logs.map(log => \`<div class="border-b border-white/5 pb-1">\${log}</div>\`).join('');
                } catch (e) {}
            }
            setInterval(updateDashboard, 2000);
        </script>
    </body>
    </html>
  `);
});

server.listen(PORT);

/**
 * SCRAPER
 */
const getExecutablePath = () => {
  if (process.platform === 'win32') return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return null;
};

const getUniqueId = (url) => {
  const idMatch = url.match(/detail\/([^/?#]+)/);
  return idMatch ? idMatch[1] : url;
};

async function runScraper() {
  const execPath = getExecutablePath();
  browser = await puppeteer.launch({
    headless: false,
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720', '--disable-dev-shm-usage']
  });

  try {
    while (true) {
      stats.status = "Pesquisando";
      stats.newItemsLastCycle = 0;
      stats.progressCurrent = 0;
      stats.progressTotal = 0;
      stats.stopRequested = false;

      let catalog = [];
      if (fs.existsSync(FILENAME)) {
        catalog = JSON.parse(fs.readFileSync(FILENAME, 'utf8'));
      }
      originalCatalogSnapshot = [...catalog]; // Snapshot para merge em caso de parada manual
      stats.totalItems = catalog.length;

      let allFoundItems = [];
      const mainPage = await browser.newPage();
      await mainPage.setRequestInterception(true);
      mainPage.on('request', r => ['image', 'font', 'media'].includes(r.resourceType()) ? r.abort() : r.continue());

      for (const range of priceRanges) {
        if (stats.stopRequested) break;
        stats.currentRange = `¥${range.min} - ¥${range.max}`;
        addLog(`Iniciando busca: ${stats.currentRange}`);
        
        try {
          await mainPage.goto(`https://www.doorzo.com/pt/search?keywords=${encodeURIComponent(searchTerm)}&price_min=${range.min}&price_max=${range.max}`, { waitUntil: 'networkidle2', timeout: 45000 });
          const moreBtnSelector = '.more a, .more button';
          for (let p = 0; p < 35; p++) {
            if (stats.stopRequested) break;
            await mainPage.evaluate(() => {
              document.querySelectorAll('.el-overlay, .el-dialog__wrapper').forEach(el => el.remove());
              window.scrollTo(0, document.body.scrollHeight);
            });
            await new Promise(r => setTimeout(r, 1000));
            const btn = await mainPage.waitForSelector(moreBtnSelector, { visible: true, timeout: 3000 }).catch(() => null);
            if (btn) {
              const busy = await mainPage.evaluate(sel => document.querySelector(sel)?.disabled || document.querySelector(sel)?.classList.contains('is-loading'), moreBtnSelector);
              if (!busy) {
                await mainPage.evaluate(sel => document.querySelector(sel)?.click(), moreBtnSelector);
                await new Promise(r => setTimeout(r, 1500));
              } else { await new Promise(r => setTimeout(r, 2000)); p--; }
            } else break;
          }

          const items = await mainPage.evaluate(() => {
            return Array.from(document.querySelectorAll('.goods-item')).map(item => ({
              nome: item.querySelector('.goods-name')?.innerText || "",
              preco_iene: parseInt(item.querySelector('.price-com')?.innerText.replace(/[^0-9]/g, '')) || 0,
              url: "https://www.doorzo.com" + (item.getAttribute('href') || ""),
              sold: !!item.querySelector('.sold-out-tag') || !!item.querySelector('.is-sold')
            }));
          });
          allFoundItems.push(...items);
        } catch (e) { addLog(`Erro na faixa ${stats.currentRange}`); }
      }
      await mainPage.close();

      // FILTRAGEM
      const uniqueItems = Array.from(new Map(allFoundItems.map(item => [getUniqueId(item.url), item])).values());
      const toScrape = [];
      const blacklist = ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"];

      uniqueItems.forEach(item => {
        const id = getUniqueId(item.url);
        if (blacklist.some(word => item.nome.includes(word)) || item.sold) return;
        if (!catalog.find(c => getUniqueId(c.url) === id)) toScrape.push(item);
      });

      // MINERAÇÃO
      let newlyScrapedThisCycle = [];
      if (toScrape.length > 0 && !stats.stopRequested) {
        stats.status = "Minerando Descrições";
        stats.progressTotal = toScrape.length;
        addLog(`Minerando ${toScrape.length} novos consoles...`);
        
        let currentIndex = 0;
        const createWorker = async () => {
          let tab = await browser.newPage();
          let uses = 0;
          await tab.setRequestInterception(true);
          tab.on('request', r => (['image', 'font', 'media'].includes(r.resourceType()) || r.url().includes('google')) ? r.abort() : r.continue());

          while (currentIndex < toScrape.length && !stats.stopRequested) {
            const item = toScrape[currentIndex++];
            if (!item) break;

            if (uses >= RECYCLE_THRESHOLD) {
              await tab.close().catch(() => {});
              tab = await browser.newPage();
              uses = 0;
            }

            let retries = 0;
            let success = false;
            while (!success && retries < 2 && !stats.stopRequested) {
              try {
                uses++;
                await tab.goto(item.url, { waitUntil: 'networkidle2', timeout: 30000 });
                const desc = await tab.evaluate(() => {
                  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                  for (const s of scripts) {
                    try {
                      const json = JSON.parse(s.innerText);
                      const graph = json['@graph'] || [json];
                      const prod = graph.find(obj => obj['@type'] === 'Product');
                      if (prod && prod.description) return product.description;
                    } catch (e) {}
                  }
                  return document.querySelector('.html')?.innerText || null;
                });
                if (desc) {
                  newlyScrapedThisCycle.push({ ...item, descricao: desc, on: true, detectado_em: new Date().toISOString() });
                  stats.newItemsLastCycle++;
                  stats.progressCurrent++;
                  success = true;
                }
              } catch (e) { retries++; }
            }
          }
          await tab.close().catch(() => {});
        };

        await Promise.all(Array(CONCURRENCY_LIMIT).fill(0).map(() => createWorker()));
      }

      // SALVAMENTO LÓGICO
      let finalCatalog;
      if (stats.stopRequested) {
        addLog("Merge de segurança: Combinando itens novos com catálogo antigo...");
        // Mantém TUDO o que já existia + o que foi minerado agora
        finalCatalog = [...originalCatalogSnapshot, ...newlyScrapedThisCycle];
      } else {
        // Ciclo normal: Atualiza o catálogo principal e remove o que não foi visto (ou vendido)
        finalCatalog = [...catalog, ...newlyScrapedThisCycle].filter(item => item.on === true);
      }

      fs.writeFileSync(FILENAME, JSON.stringify(finalCatalog, null, 2));
      
      if (stats.stopRequested) {
        addLog("Dados salvos com sucesso. Finalizando processo.");
        process.exit();
      }

      stats.lastUpdate = new Date().toLocaleTimeString();
      stats.totalItems = finalCatalog.length;
      stats.status = "Em Espera";
      stats.progressTotal = 0;
      addLog(`Ciclo finalizado. Novos: ${stats.newItemsLastCycle}. Dormindo 10 min.`);
      await new Promise(r => setTimeout(r, WAIT_BETWEEN_CYCLES));
    }
  } catch (err) {
    addLog(`Erro crítico: ${err.message}`);
    setTimeout(runScraper, 30000);
  }
}

runScraper();