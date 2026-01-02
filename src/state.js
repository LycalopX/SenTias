let browser = {};
let originalCatalogSnapshot = [];
let stopRequested = { status: false };
let stats = {
    startTime: null,
    endTime: null,
    totalItems: 0,
    scrapedItems: 0,
    progressTotal: 0,
    progressCurrent: 0,
    status: 'stopped', // 'running', 'waiting', 'stopped', 'error'
    lastRun: null,
    errors: 0,
    logs: [],
    lastScrapedName: '',
    lotsFound: 0,
    totalItemsFound: 0,
    failedItemsCount: 0
};

module.exports = {
    browser,
    originalCatalogSnapshot,
    stopRequested,
    stats
}