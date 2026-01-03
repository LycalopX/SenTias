const { stats } = require('./state');

const getUniqueId = (url) => {
    const idMatch = url.match(/detail\/([^/?#]+)/);
    return idMatch ? idMatch[1] : url;
};

const cleanDescription = (str) => {
    if (!str) return "";
    // Remove style blocks first
    let cleaned = str.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    // Basic HTML tag removal
    cleaned = cleaned.replace(/<[^>]*>/g, '');
    // Basic HTML entity decoding
    cleaned = cleaned.replace(/&quot;/g, '"')
                     .replace(/&amp;/g, '&')
                     .replace(/&lt;/g, '<')
                     .replace(/&gt;/g, '>')
                     .replace(/&nbsp;/g, ' ')
                     .replace(/\\n/g, '\n'); // from JSON-LD
    return cleaned.trim();
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    stats.logs.unshift(entry);
    if (stats.logs.length > 50) stats.logs.pop();
}

module.exports = {
    getUniqueId,
    cleanDescription,
    addLog,
};
