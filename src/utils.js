
const getUniqueId = (url) => {
    const idMatch = url.match(/detail\/([^/?#]+)/);
    return idMatch ? idMatch[1] : url;
};

const addLog = (stats, msg) => {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    stats.logs.unshift(entry);
    if (stats.logs.length > 50) stats.logs.pop();
}

module.exports = {
    getUniqueId,
    addLog
};
