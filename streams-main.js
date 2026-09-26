'use strict';
const { randomUUID } = require('node:crypto');

function installStreams({ ipcMain, session, WebContentsView, window, auth }) {
    let linkedId = null, game = null, timer = null, sending = false, view = null, credentials = null, inFlight = Promise.resolve();
    let feed = [], useProxy = true, playerSession = null, refreshing = null;
    async function renewProxy() {
        if (!refreshing) refreshing = auth.streamRequest(linkedId, 'proxy', {}).then(next => {
            if (credentials && credentials.url !== next.url) throw new Error('Адрес прокси изменился. Переключите подключение заново.');
            credentials = next;
            return next;
        }).finally(() => { refreshing = null; });
        return refreshing;
    }
    const send = (name, value) => { const win = window(); if (win && !win.isDestroyed()) win.webContents.send(name, value); };
    async function heartbeat() {
        if (!game || !linkedId || sending) return;
        sending = true;
        const current = game;
        try {
            inFlight = auth.streamRequest(linkedId, 'presence', { gameSession: current.id, playing: true });
            await inFlight;
        }
        catch (e) { send('streams:status', e.message); }
        finally { sending = false; }
    }
    function stopPlayer() {
        if (!view) return;
        const win = window();
        if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close(); view = null;
    }
    function resize() {
        if (!view) return;
        const [width, height] = window().getContentSize();
        view.setBounds({ x: 0, y: 72, width, height: Math.max(1, height - 72) });
    }
    function setupPlayerSession() {
        if (playerSession) return playerSession;
        playerSession = session.fromPartition('foleam-stream-player');
        playerSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
        playerSession.setPermissionCheckHandler(() => false);
        playerSession.on('will-download', e => e.preventDefault());
        return playerSession;
    }
    function guard(fn) {
        return async (event, data) => {
            const win = window();
            if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Forbidden');
            try { return { ok: true, ...(await fn(data)) }; }
            catch (e) { return { ok: false, error: e.message }; }
        };
    }
    ipcMain.handle('streams:list', guard(async () => {
        const response = await session.defaultSession.fetch('https://mailan1.ru/api/launcher/streams', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Не удалось обновить список трансляций.');
        const data = await response.json();
        feed = Array.isArray(data.streams) ? data.streams : [];
        return { ...data, linkedId, playing: !!game, useProxy };
    }));
    ipcMain.handle('streams:connect', guard(async () => {
        const account = await auth.login();
        if (linkedId && linkedId !== account.mailanId && game) await auth.streamRequest(linkedId, 'presence', { gameSession: game.id, playing: false }).catch(() => {});
        linkedId = account.mailanId;
        await heartbeat();
        return { account, ...(await auth.streamRequest(linkedId, 'me')) };
    }));
    ipcMain.handle('streams:save', guard(async data => {
        if (!linkedId) throw new Error('Сначала войдите в Mailan1.');
        return auth.streamRequest(linkedId, 'me', { url: String(data?.url || '') });
    }));
    ipcMain.handle('streams:proxy', guard(async data => {
        stopPlayer();
        const ses = setupPlayerSession();
        if (data?.enabled) {
            if (!linkedId) throw new Error('Сначала войдите в Mailan1.');
            const next = await auth.streamRequest(linkedId, 'proxy', {});
            const url = new URL(next.url);
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Недопустимый адрес прокси.');
            await ses.setProxy({ mode: 'fixed_servers', proxyRules: next.url, proxyBypassRules: '<-loopback>' });
            credentials = next;
        } else {
            await ses.setProxy({ mode: 'direct' }); credentials = null;
        }
        await ses.closeAllConnections();
        useProxy = !!data?.enabled;
        return { useProxy };
    }));
    ipcMain.handle('streams:close-player', guard(async () => { stopPlayer(); return {}; }));
    ipcMain.handle('streams:watch', guard(async data => {
        const stream = feed.find(s => s.accountId === data?.accountId);
        if (!stream) throw new Error('Обновите список трансляций.');
        let url;
        if (stream.provider === 'youtube' && /^[\w-]{11}$/.test(stream.id)) url = `https://www.youtube.com/watch?v=${stream.id}`;
        else if (stream.provider === 'vk' && /^-?\d+_\d+$/.test(stream.id)) url = `https://vkvideo.ru/video${stream.id}`;
        else if (stream.provider === 'rutube' && /^[a-f\d]{32}$/i.test(stream.id)) url = `https://rutube.ru/video/${stream.id}/`;
        else throw new Error('Платформа пока не поддерживается.');
        if (useProxy) {
            // Refresh before navigation; never fall back to a direct connection on proxy failure.
            if (!linkedId) linkedId = (await auth.login()).mailanId;
            await renewProxy();
            const endpoint = new URL(credentials.url);
            if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Недопустимый адрес прокси.');
            await setupPlayerSession().setProxy({ mode: 'fixed_servers', proxyRules: credentials.url, proxyBypassRules: '<-loopback>' });
        }
        stopPlayer();
        view = new WebContentsView({ webPreferences: { session: setupPlayerSession(), sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true } });
        const wc = view.webContents;
        wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        const allowed = new URL(url).hostname;
        const navigationGuard = (event, next) => {
            try { const u = new URL(next); if (u.protocol === 'https:' && u.hostname === allowed) return; } catch (_) {}
            event.preventDefault();
        };
        wc.on('will-navigate', navigationGuard); wc.on('will-redirect', navigationGuard);
        wc.on('login', async (event, details, info, callback) => {
            event.preventDefault();
            if (info.isProxy && credentials) {
                const endpoint = new URL(credentials.url);
                if (info.host === endpoint.hostname && Number(info.port) === Number(endpoint.port || 443)) {
                    try {
                        if (credentials.expires * 1000 < Date.now() + 60000) await renewProxy();
                        else if (!details.firstAuthAttempt) { send('streams:status', 'Прокси отклонил авторизацию. Переключите подключение заново.'); return callback(); }
                        return callback(credentials.username, credentials.password);
                    } catch (e) { send('streams:status', e.message); }
                }
            }
            callback();
        });
        wc.on('did-fail-load', (_e, code, _description, _url, main) => {
            if (main && code !== -3) send('streams:status', 'Плеер не загрузился. Проверьте подключение или прокси.');
        });
        window().contentView.addChildView(view); resize();
        wc.loadURL(url).catch(() => {});
        return { title: stream.title };
    }));
    function track(proc) {
        game = { id: randomUUID(), proc };
        const current = game;
        heartbeat(); clearInterval(timer); timer = setInterval(heartbeat, 30000); timer.unref();
        const stop = () => {
            if (game !== current) return;
            clearInterval(timer); game = null;
            const owner = linkedId;
            if (owner) inFlight.catch(() => {}).then(() => auth.streamRequest(owner, 'presence', { gameSession: current.id, playing: false })).catch(() => {});
        };
        proc.once('close', stop); proc.once('error', stop);
    }
    return { track, resize, stopPlayer };
}
module.exports = { installStreams };
