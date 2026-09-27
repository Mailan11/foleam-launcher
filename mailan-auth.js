'use strict';
const { randomUUID, createHash } = require('node:crypto');
const ORIGIN = 'https://mailan1.ru';

function gameAccount(profile) {
    if (!Number.isSafeInteger(profile?.id) || profile.id < 1 || typeof profile.username !== 'string') throw new Error('Некорректный ответ Mailan1.');
    const name = /^[A-Za-z0-9_]{3,16}$/.test(profile.username) ? profile.username : `Mailan_${profile.id}`;
    if (name.length > 16) throw new Error('Имя аккаунта не подходит для Minecraft.');
    const uuid = createHash('md5').update(`OfflinePlayer:${name}`).digest();
    uuid[6] = (uuid[6] & 15) | 48;
    uuid[8] = (uuid[8] & 63) | 128;
    return { type: 'mailan', mailanId: profile.id, siteUsername: profile.username, name, uuid: uuid.toString('hex') };
}

function createMailanAuth({ BrowserWindow, session, parent }) {
    const sessions = new Map();
    let pending = null;
    async function profile(ses) {
        const response = await ses.fetch(`${ORIGIN}/api/launcher/account`, {
            credentials: 'include', redirect: 'error', cache: 'no-store',
            headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000)
        });
        if (response.status === 401) return null;
        if (response.status === 403) throw new Error('Аккаунт недоступен или почта не подтверждена.');
        if (!response.ok) throw new Error(`Mailan1 временно недоступен (${response.status}).`);
        return gameAccount((await response.json()).account);
    }
    async function forget(id) {
        const ses = sessions.get(Number(id));
        sessions.delete(Number(id));
        if (ses) await ses.clearStorageData();
    }
    function login() {
        if (pending) return pending;
        pending = new Promise((resolve, reject) => {
            const ses = session.fromPartition(`mailan-login-${randomUUID()}`, { cache: false });
            ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
            ses.setPermissionCheckHandler(() => false);
            ses.on('will-download', event => event.preventDefault());
            const win = new BrowserWindow({
                width: 1050, height: 780, minWidth: 360, minHeight: 540,
                title: 'Вход в Mailan1 ID — mailan1.ru', parent: parent(),
                webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
            });
            win.setMenuBarVisibility(false);
            win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            const guard = (event, url) => {
                try { if (new URL(url).origin === ORIGIN) return; } catch (_) {}
                event.preventDefault();
            };
            win.webContents.on('will-navigate', guard);
            win.webContents.on('will-redirect', guard);
            let done = false;
            let checking = false;
            let checkAgain = false;
            const finish = (error, account) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (!account) ses.clearStorageData().catch(() => {});
                if (!win.isDestroyed()) win.close();
                if (error) reject(error); else resolve(account);
            };
            const timer = setTimeout(() => finish(new Error('Время входа истекло. Повторите попытку.')), 5 * 60 * 1000);
            win.on('closed', () => finish(new Error('Вход отменён.')));
            const onLoaded = async () => {
                if (done) return;
                if (checking) { checkAgain = true; return; }
                checking = true;
                try {
                    const account = await profile(ses);
                    if (done || !account) return;
                    await forget(account.mailanId);
                    if (done) return;
                    sessions.set(account.mailanId, ses);
                    finish(null, account);
                } catch (error) { finish(new Error(error.message || 'Не удалось связаться с Mailan1.')); }
                finally {
                    checking = false;
                    if (checkAgain && !done) { checkAgain = false; onLoaded(); }
                }
            };
            win.webContents.on('did-finish-load', onLoaded);
            win.loadURL(`${ORIGIN}/login?loginMode=id`).catch(() => finish(new Error('Не удалось открыть mailan1.ru. Проверьте интернет.')));
        }).finally(() => { pending = null; });
        return pending;
    }
    async function authenticate(id) {
        id = Number(id);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('Выберите аккаунт Mailan1 заново.');
        const ses = sessions.get(id);
        let account = ses ? await profile(ses) : null;
        if (!account) account = await login();
        if (account.mailanId !== id) throw new Error(`Нужен вход в Mailan1 ID ${id}. Вы вошли в другой аккаунт.`);
        return account;
    }
    async function streamRequest(id, route, body) {
        const routes = ['me', 'presence', 'proxy'];
        if (!routes.includes(route)) throw new Error('Unknown launcher route');
        const ses = sessions.get(Number(id));
        if (!ses) throw new Error('Войдите в Mailan1 в разделе стримов.');
        const options = { credentials: 'include', redirect: 'error', cache: 'no-store',
            headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) };
        if (body !== undefined) {
            const info = await streamRequest(id, 'me');
            options.method = 'POST';
            options.headers['Content-Type'] = 'application/json';
            options.headers['x-csrf-token'] = info.csrf;
            options.body = JSON.stringify(body);
        }
        const response = await ses.fetch(`${ORIGIN}/api/launcher/streams/${route}`, options);
        let data;
        try { data = await response.json(); } catch (_) { throw new Error('Сервис стримов недоступен.'); }
        if (!response.ok) throw new Error(data.error || `Ошибка сервиса (${response.status}).`);
        return data;
    }
    return { login, authenticate, forget, streamRequest, getSession: id => sessions.get(Number(id)) };
}
module.exports = { createMailanAuth, gameAccount };
