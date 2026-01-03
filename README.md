# LatiasSeek

LatiasSeek is a powerful and customizable web scraper built with Node.js and Puppeteer to monitor and extract data from the Japanese e-commerce site Doorzo. It features a user-friendly dashboard to control and configure the scraper in real-time.

## Features

- **Real-time Monitoring:** A web dashboard provides live statistics and logs of the scraping process.
- **Customizable Search:** Easily change the main search term and define specific keywords for filtering results.
- **Flexible Price Ranges:** Add, remove, and manage multiple price ranges to target different market segments.
- **Graceful Control:** Start and stop the scraper gracefully from the dashboard without losing data.
- **Data Export:** Download the entire scraped catalog in JSON format directly from the dashboard.
- **Stealth Scraping:** Uses `puppeteer-extra-plugin-stealth` to avoid detection.
- **Resilient:** The scraper is designed to handle errors and retries, and it can be configured to run in cycles.

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/LycalopX/SenTias.git
   ```
2. Navigate to the project directory:
   ```bash
   cd SenTias
   ```
3. Install the dependencies:
   ```bash
   npm install
   ```

### Running the Application

To start the server and the scraper, run:

```bash
npm start
```

This will launch the web server and open the dashboard, which you can access at `http://localhost:3000` or the specified network IP. The scraper will start in a "waiting for command" state.

## Usage

The dashboard provides a simple interface to manage the scraper.

- **Start/Stop:** Use the "Iniciar Bot" (Start Bot) and "Finalizar e Salvar Agora" (Finish and Save Now) buttons to control the scraper.
- **Download Catalog:** Click "Download Catálogo" to get a JSON file of all scraped items.
- **Search Settings:**
  - **Termo de Busca Principal:** The main search term to be used on Doorzo.
  - **Palavras-chave de Filtragem:** A list of keywords that *must* be present in the item's name for it to be considered valid.
- **Price Ranges:**
  - Define multiple price ranges for the scraper to search through.
  - The ranges are automatically sorted and cannot overlap.
- **Save Settings:** Click "Salvar Configurações" to apply your changes. The scraper will pick up the new settings on its next cycle.

## File Structure

```
.
├── data/                 # Stores the scraped data
│   ├── catalogo_completo.json
│   └── catalogo_novos_do_ciclo.json
├── src/
│   ├── scraper/
│   │   └── doorzo.js       # The main scraper logic
│   ├── server/
│   │   ├── dashboard.html  # The frontend dashboard
│   │   └── index.js        # The Node.js server
│   ├── analysis/
│   │   └── analise.py      # Python script for analysis
│   ├── config.json         # Main configuration file
│   ├── state.js            # In-memory state of the application
│   └── utils.js            # Utility functions
├── package.json
└── README.md
```

## Configuration

The `src/config.json` file contains the main configuration for the scraper.

- `searchTerm` (string): The main search term for Doorzo.
- `searchKeywords` (array of strings): Keywords that must be present in the item name.
- `FILENAME_ALL` (string): The name of the file to store the complete catalog.
- `FILENAME_NEW` (string): The name of the file to store newly scraped items from the last cycle.
- `PORT` (number): The port for the web server.
- `CONCURRENCY_LIMIT` (number): The number of concurrent pages to open when scraping item details.
- `RECYCLE_THRESHOLD` (number): The number of pages a browser tab can load before being recycled to save memory.
- `WAIT_BETWEEN_CYCLES` (number): The time in milliseconds to wait between scraping cycles.
- `priceRanges` (array of objects): The price ranges to scrape. Each object should have a `min` and `max` property.
