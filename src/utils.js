
const getUniqueId = (url) => {
    const idMatch = url.match(/detail\/([^/?#]+)/);
    return idMatch ? idMatch[1] : url;
};

module.exports = {
    getUniqueId,
};
