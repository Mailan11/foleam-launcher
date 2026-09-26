'use strict';
const https = require('node:https');
const { Request, Response, FormData, File } = require('undici');

// Use the same IPv4 transport as Microsoft login instead of the SDK connection pool.
async function minecraftFetch(url, options = {}) {
    const target = new URL(url);
    if (target.origin !== 'https://api.minecraftservices.com') throw new Error('Unexpected Minecraft endpoint');
    const request = new Request(url, options);
    const body = options.body ? Buffer.from(await request.arrayBuffer()) : null;
    return new Promise((resolve, reject) => {
        const headers = Object.fromEntries(request.headers);
        if (body) headers['content-length'] = String(body.length);
        const req = https.request(target, { method: request.method, headers, family: 4, signal: options.signal }, res => {
            const chunks = []; let size = 0;
            res.on('error', reject);
            res.on('data', chunk => {
                size += chunk.length;
                if (size > 1024 * 1024) { res.destroy(new Error('Minecraft response too large')); return; }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const error = new Error('Minecraft HTTP ' + res.statusCode);
                    error.status = res.statusCode;
                    reject(error); return;
                }
                resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
                    status: res.statusCode, headers: { 'content-type': 'application/json' }
                }));
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => {
            const error = new Error('Minecraft timeout'); error.code = 'ETIMEDOUT'; req.destroy(error);
        });
        req.end(body);
    });
}

function makeMinecraftClient() {
    return new (require('@xmcl/user').MojangClient)({ fetch: minecraftFetch, FormData, File });
}

function skinErrorMessage(error) {
    const status = error.status;
    if (status === 401) return 'Сессия Minecraft истекла. Войдите в Microsoft заново.';
    if (status === 403) return 'Minecraft запретил изменение скина (403). Проверьте доступ к Minecraft Java в этом аккаунте.';
    if (status === 429) return 'Слишком много изменений скина. Подождите и попробуйте снова.';
    if (status === 400) return 'Minecraft отклонил PNG скина (400). Выберите другую текстуру.';
    if (status) return `Сервис Minecraft ответил ошибкой ${status}. Попробуйте позже.`;
    return 'Не удалось связаться с Minecraft. Проверьте подключение и повторите загрузку.';
}
module.exports = { makeMinecraftClient, minecraftFetch, skinErrorMessage };
