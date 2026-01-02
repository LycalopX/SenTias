module.exports = {
    searchTerm: "Newニンテンドー3DS LL",
    FILENAME: `new_3ds_xl_catalogo_completo.json`,
    PORT: 3000, 
    CONCURRENCY_LIMIT: 7, 
    RECYCLE_THRESHOLD: 25, 
    WAIT_BETWEEN_CYCLES: 1000 * 60 * 10, 
    priceRanges: [
      { min: 22000, max: 24250 },
      { min: 24251, max: 26500 },
      { min: 26501, max: 28750 },
      { min: 28751, max: 31000 }
    ],
    getExecutablePath: () => {
        if (process.platform === 'win32') return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
        if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        return null;
    }
};
