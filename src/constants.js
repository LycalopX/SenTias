module.exports = {
    SELECTORS: {
        MORE_BUTTON: '.more a, .more button',
        GOODS_ITEM: '.goods-item',
        GOODS_NAME: '.goods-name',
        PRICE: '.price-com',
        DESCRIPTION_HTML: '.html',
        JSON_LD: 'script[type="application/ld+json"]',
        SOLD_TAGS: ['.sold-out-tag', '.is-sold'],
        OVERLAYS: '.el-overlay, .el-dialog__wrapper, .el-message'
    },
    BLACKLIST_KEYWORDS: ["フィルム", "カバー", "ケース", "充電器", "ACアダプター", "タッチペン", "ケーブル", "ポーチ", "ソフト"],
    USER_AGENTS: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ],
    SCRAPER_STATUS: {
        WAITING: 'Aguardando comando',
        RESEARCHING: 'Pesquisando',
        MINING: 'Minerando Descrições',
        IDLE: 'Em Espera',
        STOPPED: 'Parado',
        ERROR: 'Erro Crítico'
    }
};
