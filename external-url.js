'use strict';
function externalUrl(value) {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Некорректная ссылка.');
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Разрешены только веб-ссылки HTTP и HTTPS.');
    return url.href;
}
module.exports = { externalUrl };
