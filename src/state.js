
let stats = {
  status: "Iniciando...",
  totalItems: 0,
  newItemsLastCycle: 0,
  lastUpdate: "-",
  logs: [],
  currentRange: "",
  progressCurrent: 0,
  progressTotal: 0,
};

let stopRequested = {
    status: false
};

let browser;
let originalCatalogSnapshot = []; 

module.exports = {
    stats,
    stopRequested,
    browser,
    originalCatalogSnapshot
}
