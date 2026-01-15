# Plano de Refatoração e Melhorias - Projeto SenTias

Este documento descreve as principais tarefas para refatorar o projeto, com foco em modularidade, robustez, legibilidade e segurança.

## 1. Modularização Urgente do Scraper

O arquivo `src/scraper/doorzo.js` é um monolito e precisa ser dividido.

- [x] **Criar Módulo de Serviço do Scraper (`services/scraper.js`):**
    - Mover a lógica principal de orquestração (o loop `while (true)`, o controle de `stopRequested`, a espera entre os ciclos) para este arquivo.
- [x] **Criar Módulo de API do Doorzo (`services/doorzo-api.js`):**
    - Centralizar todas as funções que interagem diretamente com o Puppeteer e o site.
    - Exemplos: `searchItems(page, range)`, `loadMore(page)`, `getItemDetails(page, url)`.
    - Todos os seletores CSS (`.goods-item`, etc.) devem residir aqui, de preferência como constantes.
- [x] **Criar Módulo de Gerenciamento do Catálogo (`services/catalog.js`):**
    - Isolar toda a lógica de manipulação de arquivos JSON.
    - Funções: `readCatalog()`, `writeCatalog(data)`, `getNewItems(foundItems, catalog)`, `mergeCatalogs(oldCatalog, newItems)`.
- [x] **Criar Módulo de Constantes (`constants.js`):**
    - Mover "números mágicos" e "strings mágicas" para cá.
    - Ex: `RETRY_COUNT = 3`, `MAX_PAGES_TO_LOAD = 35`, `SELECTORS = { moreButton: '.more a', ... }`.

## 2. Encapsulamento do Estado e Lógica

O estado global em `src/state.js` é frágil e dificulta o rastreamento.

- [x] **Criar uma classe `Scraper`:**
    - Esta classe irá conter o estado (`config`, `stats`, `browser`, `stopRequested`) como propriedades de instância (`this.*`).
    - Transformar as principais funções em métodos da classe: `start()`, `stop()`, `getStats()`, `updateConfig()`.
- [x] **Refatorar `src/server/index.js`:**
    - Criar uma **única instância** da classe `Scraper`.
    - As rotas da API (Express) devem chamar os métodos dessa instância (ex: `router.post('/api/start', () => scraperInstance.start())`). Isso elimina o acoplamento por meio de variáveis globais.

## 3. Aumentar a Robustez e Melhorar o Tratamento de Erros

O scraper precisa ser mais resiliente a falhas.

- [x] **Refinar o `try/catch` principal:**
    - A falha em um único ciclo de scraping não deve matar todo o processo do scraper. O `catch` deve registrar o erro e, talvez, aguardar um tempo antes de tentar o próximo ciclo.
- [x] **Substituir o Watchdog:**
    - A causa raiz do travamento (provavelmente na mineração de detalhes) precisa ser tratada.
    - Implementar timeouts mais granulares para cada `tab.goto()` e `tab.evaluate()`.
    - Se um worker (uma aba) travar, ele deve ser finalizado individualmente, sem derrubar o loop principal. O item que causou o travamento pode ser registrado como falho.
- [x] **Implementar Estratégia de Retentativa (Exponential Backoff):**
    - Para falhas de rede ou acesso (ex: status 503), em vez de um número fixo de tentativas com espera fixa, aumentar o tempo de espera a cada nova tentativa.

## 4. Segurança e Boas Práticas

- [x] **Remover a Rota de Emergência `/api/sys/cleanup` (Crítico):**
    - **Remover o endpoint imediatamente.**
    - A solução para limpar processos zumbis do Chrome é gerenciar o PID do navegador iniciado pelo Puppeteer.
    - Armazenar `browser.process().pid` e, se absolutamente necessário, usar `process.kill(pid)` para encerrar *apenas* aquela instância. A função `browser.close()` já deve cuidar disso na maioria dos casos.
- [ ] **Validar Entradas da API:**
    - Aprimorar a validação na rota `POST /api/config` para garantir que `priceRanges` e outros campos contenham dados no formato esperado antes de salvar.

## 5. Organização Geral e Legibilidade

- [x] **Mover Scripts de Análise:**
    - Mover `src/analysis/analise.py` e `src/scraper/curva.js` para um novo diretório `tools/` ou `scripts/` para separá-los da aplicação principal.
- [x] **Adotar Nomes de Funções Descritivos:**
    - Garantir que os nomes das novas funções extraídas (passo 1) descrevam claramente o que elas fazem (ex: `filterSoldAndBlacklistedItems`).