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

module.exports = {
    getUniqueId,
    cleanDescription,
};
