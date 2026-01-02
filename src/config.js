module.exports = {
    searchTerm: "Newニンテンドー3DS LL",
    FILENAME_ALL: `catalogo_completo.json`,
    FILENAME_NEW: `catalogo_novos_do_ciclo.json`,
    PORT: 3000, 
    CONCURRENCY_LIMIT: 5, 
    RECYCLE_THRESHOLD: 20, 
    WAIT_BETWEEN_CYCLES: 5000, // Temporariamente reduzido para 5 segundos para testes
    priceRanges: [
      { min: 22000, max: 24250 } // Temporariamente reduzido para 1 faixa para testes
    ]
};
