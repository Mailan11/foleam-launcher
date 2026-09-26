// === ФИКС IPv6 ===
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, session, nativeImage, safeStorage } = require('electron');
const { createMailanAuth } = require('./mailan-auth');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const extractZip = require('extract-zip');
const yazl = require('yazl');
const { Version, launch } = require('@xmcl/core');

let mainWindow;
let isLaunching = false;
const mailanAuth = createMailanAuth({ BrowserWindow, session, parent: () => mainWindow });
const streams = require('./streams-main').installStreams({ ipcMain, session, WebContentsView, window: () => mainWindow, auth: mailanAuth });

const DATA_PATH = app.isPackaged ? app.getPath('userData') : __dirname;
fs.mkdirSync(DATA_PATH, { recursive: true });
const MINECRAFT_PATH = path.join(DATA_PATH, 'minecraft_data');
const RUNTIME_PATH = path.join(MINECRAFT_PATH, 'runtime');
const AVATARS_PATH = path.join(MINECRAFT_PATH, 'avatars');
const CONFIG_PATH = path.join(DATA_PATH, 'config.json');
const ACCOUNTS_PATH = path.join(DATA_PATH, 'accounts.json');
const accountStore = require('./account-store').createAccountStore(ACCOUNTS_PATH, safeStorage);
require('./launcher-updates').installUpdates({app,ipcMain,window:()=>mainWindow,shell,dialog,busy:()=>isLaunching,root:DATA_PATH});
const buildManager = require('./build-manager').createBuildManager({ root:MINECRAFT_PATH, isBuild:isCustomBuild, info:resolveInstanceInfo,
    ipcMain, window:() => mainWindow, dialog, shell, busy:() => isLaunching });
require('./wardrobe-main').installWardrobe({ ipcMain, nativeImage, dialog, window: () => mainWindow,
    root: __dirname, gameRoot: MINECRAFT_PATH, accountsFile: ACCOUNTS_PATH, readAccounts: () => accountStore.read(),
    applyLocal: applyOfflineSkinInternal, instanceInfo: resolveInstanceInfo,
    refreshMinecraftAccount: ensureFreshMcToken });

// ============================================================
//         ОТМЕНА ДОЛГИХ ОПЕРАЦИЙ
// ============================================================
let currentAbort = null;

function beginOperation() {
    if (currentAbort) {
        try { currentAbort.abort(); } catch (_) {}
    }
    currentAbort = new AbortController();
    return currentAbort;
}

function endOperation() {
    currentAbort = null;
}

function getSignal() {
    return currentAbort ? currentAbort.signal : undefined;
}

function isAborted() {
    return !!(currentAbort && currentAbort.signal.aborted);
}

ipcMain.on('download:cancel', () => {
    if (currentAbort) {
        try { currentAbort.abort(); } catch (_) {}
    }
});

// ============================================================
//           MICROSOFT AUTH
// ============================================================
const MS_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';

function msaPost(pathname, bodyObj) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(bodyObj).toString();
        const req = https.request({
            hostname: 'login.microsoftonline.com',
            path: pathname,
            method: 'POST',
            family: 4,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Minecraft Launcher)',
            },
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
                catch (e) { reject(new Error('Bad JSON from Microsoft: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', (err) => reject(new Error('Net: ' + err.message)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout MSA')); });
        req.write(body);
        req.end();
    });
}

function jsonRequest(urlStr, method, headers, bodyObj) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const body = bodyObj ? JSON.stringify(bodyObj) : null;
        const hdrs = { ...(headers || {}) };
        if (body) {
            hdrs['Content-Type'] = 'application/json';
            hdrs['Content-Length'] = Buffer.byteLength(body);
        }
        const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method,
            family: 4,
            headers: hdrs,
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let parsed = null;
                try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
                resolve({ status: res.statusCode, json: parsed, raw: data });
            });
        });
        req.on('error', (err) => reject(new Error('Net: ' + err.message)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ' + urlStr)); });
        if (body) req.write(body);
        req.end();
    });
}

async function msaRequestDeviceCode() {
    const { status, json } = await msaPost('/consumers/oauth2/v2.0/devicecode', {
        client_id: MS_CLIENT_ID,
        scope: 'XboxLive.signin offline_access',
    });
    if (status !== 200 || !json.device_code) {
        throw new Error(json.error_description || json.error || 'Не удалось получить device code');
    }
    return json;
}

// Возвращаем ВЕСЬ ответ (access_token + refresh_token + expires_in)
async function msaPollForToken(deviceCode, expiresIn) {
    const deadline = Date.now() + expiresIn * 1000;
    let intervalMs = 5000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const { status, json } = await msaPost('/consumers/oauth2/v2.0/token', {
            client_id: MS_CLIENT_ID,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
        });
        if (status === 200 && json.access_token) return json;
        if (json.error === 'authorization_pending') continue;
        if (json.error === 'slow_down') { intervalMs += 5000; continue; }
        throw new Error(json.error_description || json.error || 'Ошибка входа');
    }
    throw new Error('Код входа истёк. Попробуй снова.');
}

// Обновление MSA-токена через refresh_token (без ввода кода)
async function msaRefresh(refreshToken) {
    const { status, json } = await msaPost('/consumers/oauth2/v2.0/token', {
        client_id: MS_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'XboxLive.signin offline_access',
    });
    if (status !== 200 || !json.access_token) {
        throw new Error(json.error_description || json.error || 'Не удалось обновить токен Microsoft');
    }
    return json;
}

async function xblAuthenticate(msaAccessToken) {
    const { status, json } = await jsonRequest(
        'https://user.auth.xboxlive.com/user/authenticate',
        'POST',
        { 'Accept': 'application/json', 'x-xbl-contract-version': '1' },
        {
            Properties: {
                AuthMethod: 'RPS',
                SiteName: 'user.auth.xboxlive.com',
                RpsTicket: 'd=' + msaAccessToken,
            },
            RelyingParty: 'http://auth.xboxlive.com',
            TokenType: 'JWT',
        }
    );
    if (status !== 200 || !json || !json.Token) {
        throw new Error('XBL auth failed: ' + (json?.Message || json?.Identity || status));
    }
    return { token: json.Token, uhs: json.DisplayClaims.xui[0].uhs };
}

async function xstsAuthorize(xblToken) {
    const { status, json } = await jsonRequest(
        'https://xsts.auth.xboxlive.com/xsts/authorize',
        'POST',
        { 'Accept': 'application/json', 'x-xbl-contract-version': '1' },
        {
            Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
            RelyingParty: 'rp://api.minecraftservices.com/',
            TokenType: 'JWT',
        }
    );
    if (status !== 200 || !json || !json.Token) {
        if (json?.XErr) {
            const xerr = json.XErr;
            if (xerr === 2148916233) throw new Error('У аккаунта нет Xbox профиля. Зайди на xbox.com и создай его.');
            if (xerr === 2148916235) throw new Error('Xbox Live недоступен в твоём регионе.');
            if (xerr === 2148916238) throw new Error('Аккаунт ребёнка — нужно разрешение родителя.');
        }
        throw new Error('XSTS auth failed: ' + (json?.Message || status));
    }
    return { token: json.Token, uhs: json.DisplayClaims.xui[0].uhs };
}

async function minecraftLoginWithXbox(uhs, xstsToken) {
    const { status, json } = await jsonRequest(
        'https://api.minecraftservices.com/authentication/login_with_xbox',
        'POST',
        { 'Accept': 'application/json' },
        { identityToken: 'XBL3.0 x=' + uhs + ';' + xstsToken }
    );
    if (status !== 200 || !json || !json.access_token) {
        throw new Error('Minecraft login failed: ' + (json?.error || json?.errorMessage || status));
    }
    return json;
}

async function minecraftProfile(mcAccessToken) {
    const { status, json } = await jsonRequest(
        'https://api.minecraftservices.com/minecraft/profile',
        'GET',
        { 'Accept': 'application/json', Authorization: 'Bearer ' + mcAccessToken },
        null
    );
    if (status !== 200 || !json || !json.id) throw new Error('У аккаунта нет лицензии Minecraft.');
    return { uuid: json.id, name: json.name };
}

// Проверяет и при необходимости обновляет MC-токен аккаунта.
// Если токену осталось > 5 минут — не трогаем, иначе обновляем через refresh_token.
async function ensureFreshMcToken(account, force = false) {
    if (!account || account.type !== 'licensed') return account;

    const stillValid = account.accessToken
        && account.expiresAt
        && (account.expiresAt - Date.now()) > 5 * 60 * 1000;

    if (stillValid && !force) {
        console.log('[MSA] token still valid, expires in',
            Math.round((account.expiresAt - Date.now()) / 1000 / 60), 'min');
        return account;
    }

    if (!account.refreshToken) {
        throw new Error('Токен истёк, а refresh-токена нет. Войдите в Microsoft заново.');
    }

    console.log('[MSA] refreshing expired token...');
    const tokens = await msaRefresh(account.refreshToken);
    const xbl = await xblAuthenticate(tokens.access_token);
    const xsts = await xstsAuthorize(xbl.token);
    const mc = await minecraftLoginWithXbox(xsts.uhs, xsts.token);

    const updated = {
        ...account,
        accessToken: mc.access_token,
        refreshToken: tokens.refresh_token || account.refreshToken,
        expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
        xuid: xbl.uhs,
    };
    console.log('[MSA] token refreshed');

    // Синхронизируем сохранённый аккаунт
    try {
        const accounts = await loadAccountsInternal();
        const idx = accounts.findIndex(
            (a) => a.type === 'licensed' && a.name.toLowerCase() === account.name.toLowerCase()
        );
        if (idx >= 0) {
            accounts[idx] = updated;
            await saveAccountsInternal(accounts);
        }
    } catch (_) {}

    return updated;
}

// ============================================================
//               ELY.BY AUTH (Yggdrasil)
// ============================================================
const ELY_AUTHSERVER = 'https://authserver.ely.by/authserver';

function elyJsonRequest(urlStr, method, bodyObj) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const body = bodyObj ? JSON.stringify(bodyObj) : null;
        const hdrs = {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Minecraft Launcher)',
        };
        if (body) {
            hdrs['Content-Type'] = 'application/json';
            hdrs['Content-Length'] = Buffer.byteLength(body);
        }
        const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method,
            family: 4,
            headers: hdrs,
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let parsed = null;
                try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
                resolve({ status: res.statusCode, json: parsed, raw: data });
            });
        });
        req.on('error', (err) => reject(new Error('Net: ' + err.message)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ' + urlStr)); });
        if (body) req.write(body);
        req.end();
    });
}

async function elyAuthenticate(username, password, clientToken) {
    const { status, json } = await elyJsonRequest(
        `${ELY_AUTHSERVER}/authenticate`,
        'POST',
        {
            agent: { name: 'Minecraft', version: 1 },
            username,
            password,
            clientToken: clientToken || undefined,
            requestUser: false,
        }
    );
    if (status !== 200 || !json || !json.accessToken) {
        const err = json?.errorMessage || json?.error || `HTTP ${status}`;
        throw new Error(err);
    }
    return json;
}

async function elyValidate(accessToken) {
    const { status } = await elyJsonRequest(
        `${ELY_AUTHSERVER}/validate`,
        'POST',
        { accessToken }
    );
    return status === 200;
}

// Скачиваем authlib-injector для Ely.by
const AUTHLIB_INJECTOR_PATH = path.join(RUNTIME_PATH, 'authlib-injector.jar');

async function ensureAuthlibInjector() {
    if (fs.existsSync(AUTHLIB_INJECTOR_PATH)) {
        const st = fs.statSync(AUTHLIB_INJECTOR_PATH);
        if (st.size > 100 * 1024) return AUTHLIB_INJECTOR_PATH;
    }
    const url = 'https://github.com/yushijinhun/authlib-injector/releases/latest/download/authlib-injector.jar';
    fs.mkdirSync(RUNTIME_PATH, { recursive: true });
    await downloadFile(url, AUTHLIB_INJECTOR_PATH, 0);
    console.log('[authlib-injector] скачан:', AUTHLIB_INJECTOR_PATH);
    return AUTHLIB_INJECTOR_PATH;
}

// ============================================================
//                    КОНФИГ
// ============================================================
const DEFAULT_CONFIG = {
    username: 'Player',
    maxMemory: 4096,
    minMemory: 2048,
    javaMode: 'auto',
    javaPath: '',
    jvmArgs: '',
    autoCloseLauncher: false,
    lastVersion: '',
};
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
        }
    } catch (e) { console.warn('[config]', e.message); }
    return { ...DEFAULT_CONFIG };
}
function saveConfig(cfg) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8'); return true; }
    catch (e) { return false; }
}

// ============================================================
//                    ОКНО
// ============================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024, height: 700,
        icon: path.join(__dirname,'assets','foleam-logo.png'),
        webPreferences: { nodeIntegration: true, contextIsolation: false, additionalArguments:['--foleam-data=' + encodeURIComponent(DATA_PATH)] }
    });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.on('resize', () => streams.resize());
    mainWindow.on('closed', () => streams.stopPlayer());
    mainWindow.webContents.on('will-navigate', event => event.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
app.whenReady().then(() => {
    fs.mkdirSync(MINECRAFT_PATH, { recursive: true });
    fs.mkdirSync(RUNTIME_PATH, { recursive: true });
    fs.mkdirSync(AVATARS_PATH, { recursive: true });
    ensureLauncherProfile();
    createWindow();
});

// ============================================================
//        LAUNCHER_PROFILES.JSON — заглушка для инсталлеров
// ============================================================
function ensureLauncherProfile() {
    const profilePath = path.join(MINECRAFT_PATH, 'launcher_profiles.json');
    if (fs.existsSync(profilePath)) return;

    const stub = {
        profiles: {},
        settings: {
            enableSnapshots: false,
            enableAdvanced: false,
            keepLauncherOpen: false,
            showGameLog: false,
            showMenu: false,
            soundOn: false,
        },
        version: 3,
    };
    try {
        fs.writeFileSync(profilePath, JSON.stringify(stub, null, 2), 'utf-8');
        console.log('[profile] создан launcher_profiles.json');
    } catch (e) {
        console.warn('[profile] не удалось создать launcher_profiles.json:', e.message);
    }
}

// ============================================================
//                  СЕТЬ
// ============================================================
function requestOptions(timeoutMs) {
    return {
        timeout: timeoutMs,
        family: 4,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Minecraft Launcher)',
            'Accept': '*/*'
        }
    };
}

function fetchJson(url, timeoutMs = 40000, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const opts = requestOptions(timeoutMs);
        const sig = getSignal();
        if (sig) opts.signal = sig;

        const req = https.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('Слишком много редиректов'));
                let nextUrl;
                try { nextUrl = new URL(res.headers.location, url).toString(); }
                catch { return reject(new Error('Bad Location')); }
                fetchJson(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Bad JSON')); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ' + url)); });
        req.on('error', (err) => {
            if (err.name === 'AbortError' || isAborted()) return reject(new Error('__ABORTED__'));
            reject(new Error('Net: ' + err.message));
        });
    });
}

function fetchText(url, timeoutMs = 40000, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const opts = requestOptions(timeoutMs);
        const sig = getSignal();
        if (sig) opts.signal = sig;

        const req = https.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('Слишком много редиректов'));
                let nextUrl;
                try { nextUrl = new URL(res.headers.location, url).toString(); }
                catch { return reject(new Error('Bad Location')); }
                fetchText(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(data));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ' + url)); });
        req.on('error', (err) => {
            if (err.name === 'AbortError' || isAborted()) return reject(new Error('__ABORTED__'));
            reject(new Error('Net: ' + err.message));
        });
    });
}

function downloadFile(url, destPath, expectedSize, timeoutMs = 300000, attempts = 3) {
    return new Promise((resolve, reject) => {
        try {
            if (fs.existsSync(destPath)) {
                const st = fs.statSync(destPath);
                if (!expectedSize || st.size === expectedSize) return resolve({ skipped: true });
            }
        } catch (_) {}
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const tmp = destPath + '.part-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
        const file = fs.createWriteStream(tmp);

        const opts = requestOptions(timeoutMs);
        const sig = getSignal();
        if (sig) opts.signal = sig;

        const req = https.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                file.close();
                fs.unlink(tmp, () => {});
                const nextUrl = new URL(res.headers.location, url).toString();
                return downloadFile(nextUrl, destPath, expectedSize, timeoutMs, attempts).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                fs.unlink(tmp, () => {});
                return reject(new Error('HTTP ' + res.statusCode));
            }
            res.pipe(file);
            file.on('finish', () => file.close(() => {
                try {
                    if (fs.existsSync(destPath) && expectedSize) {
                        const st = fs.statSync(destPath);
                        if (st.size === expectedSize) { fs.unlink(tmp, () => {}); return resolve({ skipped: true }); }
                    }
                    fs.renameSync(tmp, destPath);
                    resolve({ skipped: false });
                } catch (e) { fs.unlink(tmp, () => {}); resolve({ skipped: true }); }
            }));
        });
        req.on('timeout', () => {
            req.destroy();
            try { file.close(); fs.unlink(tmp, () => {}); } catch (_) {}
            if (isAborted()) return reject(new Error('__ABORTED__'));
            if (attempts > 1) downloadFile(url, destPath, expectedSize, timeoutMs, attempts - 1).then(resolve).catch(reject);
            else reject(new Error('Timeout ' + url));
        });
        req.on('error', (err) => {
            try { file.close(); fs.unlink(tmp, () => {}); } catch (_) {}
            if (err.name === 'AbortError' || isAborted()) return reject(new Error('__ABORTED__'));
            if (attempts > 1) downloadFile(url, destPath, expectedSize, timeoutMs, attempts - 1).then(resolve).catch(reject);
            else reject(err);
        });
    });
}

// ============================================================
//          УСТАНОВЛЕНА ЛИ ВЕРСИЯ
// ============================================================
function readVersionJson(versionId) {
    const p = path.join(MINECRAFT_PATH, 'versions', versionId, `${versionId}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return null; }
}

function isInstalled(versionId) {
    const json = readVersionJson(versionId);
    if (!json) return false;

    // Сборки/Forge/NeoForge/Fabric/OptiFine наследуют базовую версию.
    // Считаем их установленными при наличии их собственного JSON —
    // родительская версия при необходимости докачается при запуске.
    if (json.inheritsFrom) return true;

    const dir = path.join(MINECRAFT_PATH, 'versions', versionId);
    const jar = path.join(dir, `${versionId}.jar`);
    if (!fs.existsSync(jar)) return false;
    try { if (fs.statSync(jar).size < 1024 * 1024) return false; }
    catch { return false; }
    return true;
}

function listLocalVersions() {
    const dir = path.join(MINECRAFT_PATH, 'versions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((id) => {
        try { return fs.statSync(path.join(dir, id)).isDirectory(); } catch { return false; }
    });
}

function isCustomBuild(versionId) {
    const jsonPath = path.join(MINECRAFT_PATH, 'versions', versionId, `${versionId}.json`);
    if (!fs.existsSync(jsonPath)) return false;
    try {
        const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (json.__customBuild === true) return true;
        if (json.inheritsFrom) {
            const hasLibs = Array.isArray(json.libraries) && json.libraries.length > 0;
            const jarPath = path.join(MINECRAFT_PATH, 'versions', versionId, `${versionId}.jar`);
            if (!hasLibs && !fs.existsSync(jarPath)) return true;
        }
    } catch (_) {}
    return false;
}

// ============================================================
//                    JAVA
// ============================================================
function javaMajorForVersion(versionId) {
    const m = versionId.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return 8;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    const patch = m[3] ? parseInt(m[3], 10) : 0;
    if (major >= 26) return 25;
    if (major === 1) {
        if (minor >= 21) return 21;
        if (minor >= 20) return patch >= 5 ? 21 : 17;
        if (minor >= 18) return 17;
        if (minor === 17) return 16;
        return 8;
    }
    return 8;
}
function findJavaw(rootDir) {
    if (!fs.existsSync(rootDir)) return null;
    const stack = [rootDir];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.name.toLowerCase() === 'javaw.exe') return full;
        }
    }
    return null;
}
async function ensureJava(majorVersion, event) {
    const javaDir = path.join(RUNTIME_PATH, `jre-${majorVersion}`);
    const existing = findJavaw(javaDir);
    if (existing) { console.log(`[java] нашли: ${existing}`); return existing; }

    event?.reply('launcher-status', `Скачивание Java ${majorVersion}...`);
    event?.reply('download-progress', 3);

    const url = `https://api.adoptium.net/v3/binary/latest/${majorVersion}/ga/windows/x64/jre/hotspot/normal/eclipse`;
    const zipPath = path.join(RUNTIME_PATH, `jre-${majorVersion}.zip`);
    fs.mkdirSync(RUNTIME_PATH, { recursive: true });
    await downloadFile(url, zipPath, 0);

    event?.reply('launcher-status', `Распаковка Java ${majorVersion}...`);
    event?.reply('download-progress', 6);

    fs.mkdirSync(javaDir, { recursive: true });
    await extractZip(zipPath, { dir: path.resolve(javaDir) });
    try { fs.unlinkSync(zipPath); } catch (_) {}

    const javaw = findJavaw(javaDir);
    if (!javaw) throw new Error(`Не нашли javaw.exe в Java ${majorVersion}`);
    console.log(`[java] скачали: ${javaw}`);
    return javaw;
}

// ============================================================
//                    СПИСОК ВЕРСИЙ
// ============================================================
ipcMain.handle('get-versions', async () => {
    const local = listLocalVersions();
    let manifestVersions = [];
    try {
        const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
        manifestVersions = manifest.versions.filter(
            (v) => v.type === 'release' && /^1\.\d+(\.\d+)?$/.test(v.id)
        );
    } catch (e) { console.warn('[versions]', e.message); }

    const onlineSet = new Set(manifestVersions.map((v) => v.id));
    const result = [];
    const seen = new Set();

    for (const id of local) {
        if (seen.has(id)) continue;
        if (!isInstalled(id)) continue;
        seen.add(id);
        result.push({
            id,
            installed: true,
            online: onlineSet.has(id),
            isBuild: isCustomBuild(id),
            displayName: buildManager.metadata(id).name || id,
        });
    }
    for (const v of manifestVersions) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        result.push({ id: v.id, installed: false, online: true, isBuild: false });
    }
    return result;
});

// ============================================================
//                    СКАЧИВАНИЕ ВЕРСИИ
// ============================================================
function currentOSName() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'osx';
    return 'linux';
}
function currentOSArch() {
    switch (process.arch) {
        case 'x64': return 'x86_64';
        case 'ia32': return 'x86';
        case 'arm64': return 'arm64';
        default: return 'x86_64';
    }
}
function libraryAllowed(lib) {
    const rules = lib.rules;
    if (!rules || !rules.length) return true;
    let allowed = false;
    for (const rule of rules) {
        let match = false;
        const os = rule.os;
        if (!os) match = true;
        else {
            if (os.name && os.name !== currentOSName()) match = false;
            else if (os.arch && os.arch !== currentOSArch()) match = false;
            else match = true;
        }
        if (match) allowed = (rule.action === 'allow');
    }
    return allowed;
}

async function installVersion(versionJson, onProgress) {
    if (isAborted()) throw new Error('__ABORTED__');

    const versionId = versionJson.id;
    const versionsDir = path.join(MINECRAFT_PATH, 'versions', versionId);
    fs.mkdirSync(versionsDir, { recursive: true });
    fs.writeFileSync(path.join(versionsDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2), 'utf-8');

    if (versionJson.downloads?.client) {
        const c = versionJson.downloads.client;
        onProgress?.(`Клиент Minecraft ${versionId}...`);
        await downloadFile(c.url, path.join(versionsDir, `${versionId}.jar`), c.size);
    }
    const libs = versionJson.libraries || [];
    let i = 0;
    for (const lib of libs) {
        if (isAborted()) throw new Error('__ABORTED__');
        i++;
        if (!libraryAllowed(lib)) continue;
        const downloads = lib.downloads || {};
        if (downloads.artifact?.path && downloads.artifact?.url) {
            onProgress?.(`Библиотеки (${i}/${libs.length})...`);
            try {
                await downloadFile(downloads.artifact.url, path.join(MINECRAFT_PATH, 'libraries', downloads.artifact.path), downloads.artifact.size);
            } catch (e) {
                if (e.message === '__ABORTED__') throw e;
                console.warn(`[lib] ${downloads.artifact.path}: ${e.message}`);
            }
        }
        if (downloads.classifiers) {
            const osName = currentOSName();
            for (const key of Object.keys(downloads.classifiers)) {
                if (!key.startsWith('natives-' + osName)) continue;
                const cl = downloads.classifiers[key];
                if (!cl?.path || !cl?.url) continue;
                try { await downloadFile(cl.url, path.join(MINECRAFT_PATH, 'libraries', cl.path), cl.size); }
                catch (e) {
                    if (e.message === '__ABORTED__') throw e;
                    console.warn(`[native] ${cl.path}: ${e.message}`);
                }
            }
        }
    }
    if (versionJson.assetIndex?.url) {
        onProgress?.('Индекс ассетов...');
        const assetIndex = await fetchJson(versionJson.assetIndex.url);
        const indexesDir = path.join(MINECRAFT_PATH, 'assets', 'indexes');
        fs.mkdirSync(indexesDir, { recursive: true });
        fs.writeFileSync(path.join(indexesDir, `${versionJson.assetIndex.id}.json`), JSON.stringify(assetIndex, null, 2), 'utf-8');

        const objects = assetIndex.objects || {};
        const hashesSet = new Set();
        for (const name of Object.keys(objects)) hashesSet.add(objects[name].hash);
        const hashes = Array.from(hashesSet);
        const sizeByHash = {};
        for (const name of Object.keys(objects)) {
            const h = objects[name].hash;
            if (!sizeByHash[h]) sizeByHash[h] = objects[name].size;
        }
        const total = hashes.length;
        let done = 0, idx = 0;
        async function worker() {
            while (idx < total) {
                if (isAborted()) return;
                const myIdx = idx++;
                const hash = hashes[myIdx];
                const sub = hash.slice(0, 2);
                const dest = path.join(MINECRAFT_PATH, 'assets', 'objects', sub, hash);
                const url = `https://resources.download.minecraft.net/${sub}/${hash}`;
                done++;
                if (done % 100 === 0 || done === total) onProgress?.(`Ассеты (${done}/${total})...`);
                try { await downloadFile(url, dest, sizeByHash[hash]); }
                catch (e) {
                    if (e.message === '__ABORTED__') return;
                    console.warn(`[asset] ${hash}: ${e.message}`);
                }
            }
        }
        const workers = [];
        for (let w = 0; w < 8; w++) workers.push(worker());
        await Promise.all(workers);
        if (isAborted()) throw new Error('__ABORTED__');
    }
}

async function downloadVersion(versionId, event) {
    let manifest;
    try { manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'); }
    catch (e) {
        if (e.message === '__ABORTED__') throw e;
        throw new Error('Нет интернета.');
    }
    const target = manifest.versions.find((v) => v.id === versionId);
    if (!target) throw new Error(`Версия ${versionId} не найдена.`);

    event.reply('launcher-status', `Скачивание метаданных ${versionId}...`);
    event.reply('download-progress', 5);
    const versionJson = await fetchJson(target.url);
    versionJson.id = versionId;

    let steps = 0;
    await installVersion(versionJson, (msg) => {
        steps++;
        event.reply('launcher-status', msg);
        event.reply('download-progress', Math.min(90, 5 + steps));
    });
}

// ============================================================
//    ДОКАЧКА РОДИТЕЛЬСКИХ ВЕРСИЙ (если их удалили)
// ============================================================
async function ensureParentsInstalled(versionId, event) {
    const visited = new Set([versionId]);
    let cur = versionId;
    let safety = 10;

    while (cur && safety-- > 0) {
        const j = readVersionJson(cur);
        if (!j || !j.inheritsFrom) return;

        const parent = j.inheritsFrom;
        if (visited.has(parent)) return;
        visited.add(parent);

        if (!readVersionJson(parent)) {
            event.reply('launcher-status', `Родительская версия ${parent} не найдена — докачиваем...`);
            try {
                await downloadVersion(parent, event);
                event.reply('install-complete', parent);
            } catch (e) {
                if (e.message === '__ABORTED__') throw e;
                throw new Error(`Не удалось скачать родительскую версию ${parent}: ${e.message}`);
            }
        }

        cur = parent;
    }
}

// ============================================================
//                    IPC: UI CONFIRM
// ============================================================
ipcMain.handle('ui:confirm', async (_e, { message, title, okLabel, detail }) => {
    const res = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: [okLabel || 'OK', 'Отмена'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: title || 'Подтверждение',
        message: message || 'Вы уверены?',
        detail: detail || undefined,
    });
    return res.response === 0;
});

// ============================================================
//          СИСТЕМНЫЕ ДЕЙСТВИЯ ДЛЯ НАСТРОЕК
// ============================================================
ipcMain.handle('system:detect-java', async () => {
    const candidates = [];

    try {
        if (fs.existsSync(RUNTIME_PATH)) {
            for (const d of fs.readdirSync(RUNTIME_PATH)) {
                if (!d.startsWith('jre-')) continue;
                const found = findJavaw(path.join(RUNTIME_PATH, d));
                if (found) {
                    candidates.push({
                        path: found,
                        version: d.replace('jre-', 'Java '),
                        source: 'скачана лаунчером',
                    });
                }
            }
        }
    } catch (_) {}

    if (process.platform === 'win32') {
        const dirs = [
            'C:\\Program Files\\Java',
            'C:\\Program Files\\Eclipse Adoptium',
            'C:\\Program Files\\Microsoft\\jdk',
            'C:\\Program Files\\Amazon Corretto',
            'C:\\Program Files (x86)\\Java',
            'C:\\Program Files (x86)\\Eclipse Adoptium',
        ];
        for (const base of dirs) {
            if (!fs.existsSync(base)) continue;
            try {
                for (const sub of fs.readdirSync(base)) {
                    const full = path.join(base, sub);
                    try { if (!fs.statSync(full).isDirectory()) continue; } catch (_) { continue; }
                    const javaw = findJavaw(full);
                    if (javaw) candidates.push({ path: javaw, version: sub, source: 'установлена в системе' });
                }
            } catch (_) {}
        }
    }

    if (process.env.JAVA_HOME) {
        const javaw = findJavaw(process.env.JAVA_HOME);
        if (javaw) candidates.push({ path: javaw, version: 'JAVA_HOME', source: 'переменная JAVA_HOME' });
    }

    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        unique.push(c);
    }
    return unique;
});

function getDirSize(dir) {
    let total = 0;
    try {
        const stack = [dir];
        while (stack.length) {
            const d = stack.pop();
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                const full = path.join(d, e.name);
                try {
                    if (e.isDirectory()) stack.push(full);
                    else if (e.isFile()) total += fs.statSync(full).size;
                } catch (_) {}
            }
        }
    } catch (_) {}
    return total;
}

ipcMain.handle('system:folder-size', async () => {
    return getDirSize(MINECRAFT_PATH);
});

ipcMain.handle('settings:reset', async () => {
    saveConfig({ ...DEFAULT_CONFIG });
    return { ...DEFAULT_CONFIG };
});

// ============================================================
//                    IPC: НАСТРОЙКИ / ПАПКИ / МОДЫ
// ============================================================
ipcMain.handle('settings:get', async () => loadConfig());
ipcMain.handle('settings:set', async (_e, partial) => {
    const cfg = loadConfig();
    const merged = { ...cfg, ...partial };
    saveConfig(merged);
    return merged;
});
ipcMain.handle('open-folder', async (_e, which) => {
    const version = typeof which === 'object' ? which?.version : null;
    which = typeof which === 'object' ? which?.folder : which;
    const root = version && isCustomBuild(version) ? buildManager.ensure(version) : MINECRAFT_PATH;
    let target;
    switch (which) {
        case 'mods': target = path.join(root, 'mods'); break;
        case 'versions': target = path.join(MINECRAFT_PATH, 'versions'); break;
        case 'saves': target = path.join(root, 'saves'); break;
        default: target = root; break;
    }
    fs.mkdirSync(target, { recursive: true });
    await shell.openPath(target);
    return { ok: true };
});
ipcMain.handle('open-url', async (event, url) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false };
    try { await shell.openExternal(require('./external-url').externalUrl(url)); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
});

ipcMain.handle('install-mod', async (_e, opts) => {
    const version = opts?.version;

    const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите мод (.jar)',
        filters: [{ name: 'Minecraft Mod', extensions: ['jar'] }],
        properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };

    let modsDir;
    if (version && isCustomBuild(version)) buildManager.ensure(version);
    if (version) {
        const inst = path.join(MINECRAFT_PATH, 'instances', version);
        if (fs.existsSync(inst)) modsDir = path.join(inst, 'mods');
    }
    if (!modsDir) modsDir = path.join(MINECRAFT_PATH, 'mods');

    fs.mkdirSync(modsDir, { recursive: true });
    const names = [];
    for (const src of res.filePaths) {
        const name = path.basename(src);
        try { fs.copyFileSync(src, path.join(modsDir, name)); names.push(name); }
        catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: true, name: names.join(', ') };
});

ipcMain.handle('version:delete', async (_e, versionId) => {
    try {
        const dir = path.join(MINECRAFT_PATH, 'versions', versionId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

        const inst = path.join(MINECRAFT_PATH, 'instances', versionId);
        if (fs.existsSync(inst)) fs.rmSync(inst, { recursive: true, force: true });

        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('version:dependents', async (_e, versionId) => {
    const dir = path.join(MINECRAFT_PATH, 'versions');
    if (!fs.existsSync(dir)) return [];
    const result = [];
    for (const id of fs.readdirSync(dir)) {
        if (id === versionId) continue;
        const j = readVersionJson(id);
        if (j && j.inheritsFrom === versionId) result.push(id);
    }
    return result;
});

// ============================================================
//            УСТАНОВКА ЗАГРУЗЧИКА
// ============================================================
async function installModloader(type, mcVersion, mlVer, onStatus) {
    onStatus?.('Определение Java...', 0);

    const javaMajor = javaMajorForVersion(mcVersion);
    const javaPath = await ensureJava(javaMajor, {
        reply: (ch, msg) => onStatus?.(msg, 10),
    });
    console.log('[ml] java:', javaPath);

    ensureLauncherProfile();

    let installerUrl, installerName;
    if (type === 'forge') {
        const full = `${mcVersion}-${mlVer}`;
        installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
        installerName = `forge-${full}-installer.jar`;
    } else if (type === 'neoforge') {
        installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${mlVer}/neoforge-${mlVer}-installer.jar`;
        installerName = `neoforge-${mlVer}-installer.jar`;
    } else {
        throw new Error('Загрузчик не поддерживается: ' + type);
    }

    onStatus?.(`Скачивание установщика ${type}...`, 30);
    const installerPath = path.join(RUNTIME_PATH, installerName);
    await downloadFile(installerUrl, installerPath, 0);

    onStatus?.(`Запуск установщика ${type} (это может занять минуту)...`, 50);

    const logName = `${type}-installer-${Date.now()}.log`;
    const logPath = path.join(RUNTIME_PATH, logName);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`\n=== ${new Date().toISOString()} | ${type} ${mcVersion}-${mlVer} ===\n`);

    await new Promise((resolve, reject) => {
        const args = ['-jar', installerPath, '--installClient', MINECRAFT_PATH];
        const p = spawn(javaPath, args, {
            cwd: MINECRAFT_PATH,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const sig = getSignal();
        const onAbort = () => { try { p.kill(); } catch (_) {} };
        if (sig) sig.addEventListener('abort', onAbort, { once: true });

        p.stdout.on('data', (d) => {
            const s = d.toString();
            logStream.write(s);
            console.log('[installer]', s.trim());
        });
        p.stderr.on('data', (d) => {
            const s = d.toString();
            logStream.write(s);
            console.error('[installer-err]', s.trim());
        });
        p.on('close', (code) => {
            if (sig) sig.removeEventListener('abort', onAbort);
            logStream.end();
            if (isAborted()) return reject(new Error('__ABORTED__'));
            if (code === 0) resolve();
            else reject(new Error(`Installer exit ${code}. Лог: minecraft_data/runtime/${logName}`));
        });
        p.on('error', (err) => {
            if (sig) sig.removeEventListener('abort', onAbort);
            logStream.end();
            reject(err);
        });
    });

    try { fs.unlinkSync(installerPath); } catch (_) {}

    onStatus?.(`${type} ${mlVer} установлен`, 100);
}

function findLoaderId(versionsDir, loader, baseVersion, loaderVersion) {
    if (!fs.existsSync(versionsDir)) return null;
    const all = fs.readdirSync(versionsDir);
    if (loader === 'forge') {
        const exact = `${baseVersion}-forge-${loaderVersion}`;
        return all.find((id) => id === exact)
            || all.find((id) => id.startsWith(`${baseVersion}-forge-`));
    }
    if (loader === 'neoforge') {
        const exact = `neoforge-${loaderVersion}`;
        return all.find((id) => id === exact);
    }
    if (loader === 'fabric') {
        const exact = `fabric-loader-${loaderVersion}-${baseVersion}`;
        return all.find((id) => id === exact)
            || all.find((id) => id.startsWith('fabric-loader-') && id.endsWith('-' + baseVersion));
    }
    return null;
}

// ============================================================
//       СОЗДАНИЕ СБОРКИ (с автоустановкой загрузчика)
// ============================================================
ipcMain.handle('version:create-custom', async (event, { baseVersion, newId, displayName, loader, loaderVersion }) => {
    const send = (msg, pct) => {
        if (msg) event.sender.send('custom-status', msg);
        if (typeof pct === 'number') {
            event.sender.send('custom-progress', Math.max(0, Math.min(100, pct)));
        }
    };

    try {
        const versionsDir = path.join(MINECRAFT_PATH, 'versions');
        const newDir = path.join(versionsDir, newId);

        if (fs.existsSync(newDir)) {
            return { ok: false, error: 'Сборка с таким названием уже существует' };
        }

        let sourceId = baseVersion;

        if (!isInstalled(baseVersion)) {
            send(`Скачивание Minecraft ${baseVersion}...`, 3);
            try {
                const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
                const target = manifest.versions.find((v) => v.id === baseVersion);
                if (!target) return { ok: false, error: `Версия ${baseVersion} не найдена` };

                send(`Загрузка метаданных ${baseVersion}...`, 5);
                const versionJson = await fetchJson(target.url);
                versionJson.id = baseVersion;

                let step = 0;
                await installVersion(versionJson, (msg) => {
                    step++;
                    send(msg, 5 + Math.min(50, Math.round((step / 25) * 50)));
                });
                send(`Minecraft ${baseVersion} установлен`, 55);
            } catch (e) {
                return { ok: false, error: `Не удалось скачать Minecraft ${baseVersion}: ${e.message}` };
            }
        } else {
            send(`Minecraft ${baseVersion} уже установлен`, 55);
        }

        if (loader && loader !== 'vanilla') {
            let loaderId = findLoaderId(versionsDir, loader, baseVersion, loaderVersion);
            if (!loaderId) {
                send(`Установка ${loader} ${loaderVersion}...`, 60);
                try {
                    await installModloader(loader, baseVersion, loaderVersion, (msg, progress) => {
                        const pct = typeof progress === 'number'
                            ? 60 + Math.round(progress * 0.32)
                            : undefined;
                        send(msg, pct);
                    });
                } catch (e) {
                    return { ok: false, error: `Не удалось установить ${loader}: ${e.message}` };
                }
                loaderId = findLoaderId(versionsDir, loader, baseVersion, loaderVersion);
                if (!loaderId) {
                    return { ok: false, error: `${loader} установлен, но папка не найдена.` };
                }
            } else {
                send(`${loader} ${loaderVersion} уже установлен`, 90);
            }
            sourceId = loaderId;
        }

        send('Создание сборки...', 94);

        fs.mkdirSync(newDir, { recursive: true });

        const now = new Date().toISOString();
        const newJson = {
            id: newId,
            inheritsFrom: sourceId,
            type: 'release',
            time: now,
            releaseTime: now,
            __customBuild: true,
        };
        fs.writeFileSync(
            path.join(newDir, `${newId}.json`),
            JSON.stringify(newJson, null, 2),
            'utf-8'
        );

        const instDir = path.join(MINECRAFT_PATH, 'instances', newId);
        fs.mkdirSync(path.join(instDir, 'mods'), { recursive: true });
        fs.mkdirSync(path.join(instDir, 'config'), { recursive: true });
        fs.mkdirSync(path.join(instDir, 'saves'), { recursive: true });

        send(`Сборка «${displayName}» готова!`, 100);
        console.log('[custom] created:', newId, '| inherits:', sourceId);
        return { ok: true, versionId: newId };
    } catch (e) {
        console.error('[custom] error:', e);
        return { ok: false, error: e.message };
    }
});

// ============================================================
//                    IPC: АККАУНТЫ
// ============================================================
ipcMain.handle('accounts:load', async event => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Недопустимое окно.');
    return accountStore.read();
});

ipcMain.handle('mailan:login', async event => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: 'Недопустимое окно входа.' };
    try { return { ok: true, account: await mailanAuth.login() }; }
    catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('mailan:logout', async (event, id) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
    await mailanAuth.forget(id);
});

ipcMain.handle('accounts:save', async (event, accounts) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false };
    try {
        accountStore.write(accounts);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
//                    IPC: СКИНЫ
// ============================================================
ipcMain.handle('skin:upload', async (_e, nickname) => {
    const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите скин (.png, 64x64 или 64x32)',
        filters: [{ name: 'PNG skin', extensions: ['png'] }],
        properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const src = res.filePaths[0];
    const skinsDir = path.join(MINECRAFT_PATH, 'skins');
    fs.mkdirSync(skinsDir, { recursive: true });
    const dest = path.join(skinsDir, `${nickname}.png`);
    try {
        fs.copyFileSync(src, dest);
        return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('skin:clear', async (_e, nickname) => {
    try {
        const dest = path.join(MINECRAFT_PATH, 'skins', `${nickname}.png`);
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
//   ВЫБОР СКИНА (галерея) И ПЛАЩЕЙ (для лицензии)
// ============================================================
ipcMain.handle('skin:list-saved', async () => {
    const dir = path.join(MINECRAFT_PATH, 'skins');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => ({ name: path.basename(f, '.png'), file: f }));
});

ipcMain.handle('skin:apply-by-name', async (_e, { name, nickname }) => {
    try {
        const dir = path.join(MINECRAFT_PATH, 'skins');
        const src = path.join(dir, `${name}.png`);
        const dest = path.join(dir, `${nickname}.png`);
        if (!fs.existsSync(src)) return { ok: false, error: 'Скин не найден' };
        if (src === dest) return { ok: true, path: dest };
        fs.copyFileSync(src, dest);
        return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('skin:delete-saved', async (_e, name) => {
    try {
        const p = path.join(MINECRAFT_PATH, 'skins', `${name}.png`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('skin:download-and-apply', async (_e, { name, nickname }) => {
    try {
        const url = `https://mc-heads.net/skin/${encodeURIComponent(name)}`;
        const dir = path.join(MINECRAFT_PATH, 'skins');
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `_tmp_${Date.now()}.png`);
        await downloadFile(url, tmp, 0);
        const dest = path.join(dir, `${nickname}.png`);
        fs.renameSync(tmp, dest);
        return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ---------- ПЛАЩИ ----------
ipcMain.handle('cape:list-saved', async () => {
    const dir = path.join(MINECRAFT_PATH, 'capes');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => ({ name: path.basename(f, '.png'), file: f }));
});

ipcMain.handle('cape:upload', async (_e, nickname) => {
    const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите плащ (.png, 64x32 или 22x17)',
        filters: [{ name: 'PNG cape', extensions: ['png'] }],
        properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const dir = path.join(MINECRAFT_PATH, 'capes');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${nickname}.png`);
    try {
        fs.copyFileSync(res.filePaths[0], dest);
        return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cape:apply-by-name', async (_e, { name, nickname }) => {
    try {
        const dir = path.join(MINECRAFT_PATH, 'capes');
        const src = path.join(dir, `${name}.png`);
        const dest = path.join(dir, `${nickname}.png`);
        if (!fs.existsSync(src)) return { ok: false, error: 'Плащ не найден' };
        if (src === dest) return { ok: true, path: dest };
        fs.copyFileSync(src, dest);
        return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cape:clear', async (_e, nickname) => {
    try {
        const dest = path.join(MINECRAFT_PATH, 'capes', `${nickname}.png`);
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cape:delete-saved', async (_e, name) => {
    try {
        const p = path.join(MINECRAFT_PATH, 'capes', `${name}.png`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cape:get-active', async (_e, nickname) => {
    const dest = path.join(MINECRAFT_PATH, 'capes', `${nickname}.png`);
    return { active: fs.existsSync(dest) };
});

// ============================================================
//                    IPC: АВАТАРКИ
// ============================================================
ipcMain.handle('avatar:upload', async (_e, nickname) => {
    const res = await dialog.showOpenDialog(mainWindow, {
        title: `Выберите аватар для ${nickname} (.png)`,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
        properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    fs.mkdirSync(AVATARS_PATH, { recursive: true });
    const dest = path.join(AVATARS_PATH, `${nickname}.png`);
    try {
        fs.copyFileSync(res.filePaths[0], dest);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('avatar:clear', async (_e, nickname) => {
    try {
        const dest = path.join(AVATARS_PATH, `${nickname}.png`);
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
//            MICROSOFT LOGIN
// ============================================================
ipcMain.on('msa:start-login', async (event) => {
    try {
        console.log('[MSA] requesting device code...');

        const code = await msaRequestDeviceCode();
        console.log('[MSA] user code:', code.user_code);

        event.reply('msa:code', {
            userCode: code.user_code,
            verificationUri: code.verification_uri,
        });
        shell.openExternal(code.verification_uri).catch(() => {});

        const tokens = await msaPollForToken(code.device_code, code.expires_in);
        console.log('[MSA] got MSA tokens (refresh_token:', tokens.refresh_token ? 'yes' : 'no', ')');

        const xbl = await xblAuthenticate(tokens.access_token);
        console.log('[MSA] got XBL token');

        const xsts = await xstsAuthorize(xbl.token);
        console.log('[MSA] got XSTS token');

        const mc = await minecraftLoginWithXbox(xsts.uhs, xsts.token);
        console.log('[MSA] got Minecraft token');

        const profile = await minecraftProfile(mc.access_token);
        console.log('[MSA] profile:', profile.name);

        const account = {
            name: profile.name,
            type: 'licensed',
            accessToken: mc.access_token,
            refreshToken: tokens.refresh_token || '',
            expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
            uuid: profile.uuid,
            xuid: xbl.uhs,
        };

        const accounts = await loadAccountsInternal();
        const filtered = accounts.filter((a) => a.name !== account.name);
        filtered.push(account);
        await saveAccountsInternal(filtered);

        event.reply('msa:login-complete', account);
    } catch (err) {
        console.error('[MSA] Error:', err);
        let msg = err.message || 'Неизвестная ошибка';
        if (/expired_token|code_expired/i.test(msg)) msg = 'Код входа устарел. Попробуй снова.';
        else if (/authorization_declined|user_cancelled/i.test(msg)) msg = 'Вход отменён пользователем.';
        else if (/invalid_client/i.test(msg)) msg = 'Ошибка Client ID.';
        else if (/invalid app registration/i.test(msg)) msg = 'Minecraft отклонил вход. Этот Client ID не в белом списке Mojang.';
        event.reply('msa:login-error', msg);
    }
});

ipcMain.on('msa:cancel-login', () => { /* ждём таймаута */ });

async function loadAccountsInternal() {
    return accountStore.read();
}
async function saveAccountsInternal(accounts) {
    try {
        accountStore.write(accounts);
        return true;
    } catch (_) { return false; }
}

// ============================================================
//        МОДЛОАДЕРЫ: СПИСКИ ВЕРСИЙ
// ============================================================
ipcMain.handle('modloader:versions', async (_e, { type, mcVersion }) => {
    if (type === 'forge') {
        const xml = await fetchText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
        const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
        return all
            .filter((v) => v.startsWith(mcVersion + '-'))
            .map((v) => v.slice(mcVersion.length + 1))
            .filter((v) => /^[\d.]+$/.test(v))
            .sort((a, b) => {
                const pa = a.split('.').map(Number);
                const pb = b.split('.').map(Number);
                for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                    const d = (pb[i] || 0) - (pa[i] || 0);
                    if (d) return d;
                }
                return 0;
            });
    }
    if (type === 'neoforge') {
        const data = await fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
        const mcParts = mcVersion.split('.').slice(1);
        if (mcParts.length < 2) return [];
        const prefix = mcParts[0] + '.' + mcParts[1] + '.';
        return data.versions
            .filter((v) => v.startsWith(prefix))
            .sort((a, b) => {
                const pa = a.split('.').map(Number);
                const pb = b.split('.').map(Number);
                for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                    const d = (pb[i] || 0) - (pa[i] || 0);
                    if (d) return d;
                }
                return 0;
            });
    }
    if (type === 'fabric') {
        const data = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
        return data
            .map((x) => x.loader && x.loader.version)
            .filter(Boolean);
    }
    return [];
});

// ============================================================
//       МОДЛОАДЕРЫ: УСТАНОВКА
// ============================================================
ipcMain.on('modloader:install', async (event, { type, mcVersion, mlVer }) => {
    beginOperation();
    event.reply('operation-started');
    try {
        event.reply('ml-progress', 2);
        event.reply('ml-status', 'Определение Java...');

        await installModloader(type, mcVersion, mlVer, (msg, progress) => {
            event.reply('ml-status', msg);
            if (typeof progress === 'number') event.reply('ml-progress', progress);
        });

        event.reply('ml-progress', 100);

        let newVersionId;
        if (type === 'forge') {
            newVersionId = `${mcVersion}-${mlVer}`;
        } else if (type === 'neoforge') {
            const dir = path.join(MINECRAFT_PATH, 'versions');
            const all = fs.readdirSync(dir);
            const candidates = all.filter((id) => id.toLowerCase().includes('neoforge'));
            if (candidates.length) newVersionId = candidates[candidates.length - 1];
        }

        event.reply('ml-complete', { ok: true, versionId: newVersionId || 'установлено' });
    } catch (e) {
        console.error('[ml] error:', e);
        if (e.message === '__ABORTED__') {
            event.reply('ml-complete', { ok: false, error: 'Отменено' });
        } else {
            event.reply('ml-complete', { ok: false, error: e.message });
        }
    } finally {
        event.reply('operation-finished');
        endOperation();
    }
});

// ============================================================
//                    ЗАПУСК ИГРЫ
// ============================================================
ipcMain.on('launch-game', async (event, data) => {
    if (isLaunching) return;
    isLaunching = true;

    beginOperation();
    event.reply('operation-started');

    try {
        const cfg = loadConfig();
        let username = String(data?.username || cfg.username || 'Mailan1').trim();
        const versionId = String(data?.version || '1.20.1').trim();
        const accountType = data?.type || 'offline';
        let accessToken = data?.accessToken || '0';
        let uuid = String(data?.uuid || '00000000000000000000000000000000').replace(/-/g, '');

        if (accountType === 'mailan') {
            event.reply('launcher-status', 'Проверяем аккаунт Mailan1...');
            const account = await mailanAuth.authenticate(data.mailanId);
            username = account.name;
            uuid = account.uuid;
            accessToken = '0';
        }

        // Обновляем MC-токен, если он истекает или уже истёк.
        // Это избавляет от ошибки "Недействительная сессия" на Hypixel.
        if (accountType === 'licensed') {
            try {
                event.reply('launcher-status', 'Проверка сессии Microsoft...');
                const accounts = await loadAccountsInternal();
                const licensed = accounts.find(
                    (a) => a.type === 'licensed' && a.name.toLowerCase() === username.toLowerCase()
                );
                if (!licensed) {
                    throw new Error('Аккаунт Microsoft не найден. Войдите заново.');
                }
                const fresh = await ensureFreshMcToken(licensed);
                accessToken = fresh.accessToken;
                uuid = String(fresh.uuid || uuid).replace(/-/g, '');
                username = fresh.name || username;
            } catch (e) {
                console.error('[MSA] refresh failed:', e);
                event.reply('launcher-status', `Сессия истекла: ${e.message}`);
                event.reply('operation-finished');
                endOperation();
                isLaunching = false;
                return;
            }
        }

        if (!isInstalled(versionId)) {
            await downloadVersion(versionId, event);
            event.reply('install-complete', versionId);
        }

        await ensureParentsInstalled(versionId, event);

        let javaPath;
        if (cfg.javaMode === 'manual' && cfg.javaPath) {
            javaPath = cfg.javaPath;
            console.log('[java] (manual):', javaPath);
        } else {
            const javaMajor = javaMajorForVersion(versionId);
            event.reply('launcher-status', `Проверка Java ${javaMajor}...`);
            javaPath = await ensureJava(javaMajor, event);
            console.log('[java] path:', javaPath);
        }

        event.reply('download-progress', 95);
        event.reply('launcher-status', 'Подготовка к запуску...');

        const version = await Version.parse(MINECRAFT_PATH, versionId);
        console.log('[launch] version.id:', version.id, '| java:', javaPath, '| type:', accountType);

        const extraJVMArgs = [];
        if (cfg.jvmArgs && typeof cfg.jvmArgs === 'string') {
            for (const a of cfg.jvmArgs.split(/\s+/)) if (a) extraJVMArgs.push(a);
        }
        if (/^26\./.test(versionId)) extraJVMArgs.push('-XX:StackShadowPages=32');

        const instDir = path.join(MINECRAFT_PATH, 'instances', versionId);
        const gamePath = isCustomBuild(versionId) ? buildManager.ensure(versionId) : fs.existsSync(instDir) ? instDir : MINECRAFT_PATH;
        console.log('[launch] gamePath:', gamePath);

                // Если у пользователя есть локальный плащ — копируем в CustomSkinLoader
        try {
            const capeSrc = path.join(MINECRAFT_PATH, 'capes', `${username}.png`);
            if (fs.existsSync(capeSrc)) {
                const cslDirs = [
                    path.join(gamePath, 'CustomSkinLoader', 'LocalSkin', 'capes'),
                    path.join(MINECRAFT_PATH, 'CustomSkinLoader', 'LocalSkin', 'capes'),
                ];
                for (const d of cslDirs) {
                    if (!fs.existsSync(path.dirname(d))) continue;
                    fs.mkdirSync(d, { recursive: true });
                    fs.copyFileSync(capeSrc, path.join(d, `${username}.png`));
                }
            }
        } catch (e) {
            console.warn('[cape] copy failed:', e.message);
        }

        const proc = await launch({
            version: version,
            gamePath: gamePath,
            resourcePath: MINECRAFT_PATH,
            javaPath: javaPath,
            gameProfile: {
                name: username,
                id: uuid,
            },
            accessToken: accessToken,
            userType: accountType === 'licensed' ? 'msa' : 'legacy',
            maxMemory: cfg.maxMemory || 4096,
            minMemory: cfg.minMemory || 2048,
            extraJVMArgs: extraJVMArgs,
        });

        streams.track(proc);
        if (isCustomBuild(versionId)) { try { buildManager.launched(versionId); } catch(e) { console.warn('[build] Cannot save last launch'); } }
        event.reply('download-progress', 100);
        event.reply('launcher-status', 'Игра запущена!');
        event.reply('operation-finished');
        endOperation();

        if (cfg.autoCloseLauncher && mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.minimize(); } catch (_) {}
        }

        proc.on('close', (code) => {
            event.reply('launcher-status', `Игра закрыта (код ${code})`);
            isLaunching = false;
        });
    } catch (error) {
        console.error('ОШИБКА:\n', error.stack || error);
        if (error.message === '__ABORTED__') {
            event.reply('launcher-status', 'Отменено');
        } else {
            event.reply('launcher-status', `ОШИБКА: ${error.message}`);
        }
        event.reply('operation-finished');
        endOperation();
        isLaunching = false;
    }
});

// ============================================================
//                    МОД МАГАЗИН (Modrinth)
// ============================================================
const MODRINTH_API = 'https://api.modrinth.com/v2';

function modrinthFetch(urlPath) {
    return fetchJson(MODRINTH_API + urlPath, 30000);
}

function resolveInstanceInfo(versionId) {
    let curId = versionId;
    let mcVersion = null;
    let loader = 'vanilla';
    const visited = new Set();

    while (curId && !visited.has(curId)) {
        visited.add(curId);

        const mcMatch = curId.match(/^1\.\d+(?:\.\d+)?/);
        if (mcMatch && !mcVersion) mcVersion = mcMatch[0];

        if (/neoforge/i.test(curId)) {
            loader = 'neoforge';
            if (!mcVersion) {
                const nf = curId.match(/neoforge-(\d+)\.(\d+)/);
                if (nf) mcVersion = `1.${nf[1]}.${nf[2]}`;
            }
        } else if (/forge/i.test(curId)) {
            loader = 'forge';
        } else if (/fabric/i.test(curId) && loader === 'vanilla') {
            loader = 'fabric';
        } else if (/quilt/i.test(curId) && loader === 'vanilla') {
            loader = 'quilt';
        }

        const p = path.join(MINECRAFT_PATH, 'versions', curId, `${curId}.json`);
        if (!fs.existsSync(p)) break;
        try {
            const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
            curId = j.inheritsFrom || null;
        } catch { break; }
    }

    return { id: versionId, mcVersion, loader };
}

ipcMain.handle('modshop:instances', async () => {
    const ids = listLocalVersions().filter((id) => isInstalled(id));
    const result = [];
    for (const id of ids) {
        const info = resolveInstanceInfo(id);
        if (!info.mcVersion) continue;
        result.push({
            id,
            mcVersion: info.mcVersion,
            loader: info.loader,
            isBuild: isCustomBuild(id),
        });
    }
    result.sort((a, b) => {
        if (a.isBuild !== b.isBuild) return a.isBuild ? -1 : 1;
        return a.id.localeCompare(b.id);
    });
    return result;
});

ipcMain.handle('modshop:search', async (_e, { query, mcVersion, loader, onlyCompat, offset = 0, limit = 20 }) => {
    const facets = [['project_type:mod']];
    if (onlyCompat && mcVersion) facets.push([`versions:${mcVersion}`]);
    if (onlyCompat && loader && loader !== 'vanilla') {
        facets.push([`categories:${loader}`]);
    }

    const params = new URLSearchParams({
        query: query || '',
        limit: String(limit),
        offset: String(offset),
        index: 'relevance',
    });
    params.append('facets', JSON.stringify(facets));

    try {
        const data = await modrinthFetch('/search?' + params.toString());
        return { ok: true, hits: data.hits || [], total: data.total_hits || 0 };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('modshop:versions', async (_e, { projectId, mcVersion, loader }) => {
    const params = new URLSearchParams();
    if (mcVersion) params.append('game_versions', JSON.stringify([mcVersion]));
    if (loader && loader !== 'vanilla') params.append('loaders', JSON.stringify([loader]));

    try {
        const data = await modrinthFetch(`/project/${projectId}/version?` + params.toString());
        return { ok: true, versions: data || [] };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('modshop:project', async (_e, { projectId }) => {
    try {
        const data = await modrinthFetch(`/project/${projectId}`);
        return { ok: true, project: data || null };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('modshop:install', async (_e, { versionId, downloadUrl, fileName }) => {
    try {
        if (versionId && isCustomBuild(versionId)) buildManager.ensure(versionId);
        let modsDir;
        if (versionId) {
            const instDir = path.join(MINECRAFT_PATH, 'instances', versionId);
            if (fs.existsSync(instDir)) modsDir = path.join(instDir, 'mods');
        }
        if (!modsDir) modsDir = path.join(MINECRAFT_PATH, 'mods');
        fs.mkdirSync(modsDir, { recursive: true });

        const safeName = String(fileName).replace(/[^A-Za-z0-9._\-]/g, '_');
        const dest = path.join(modsDir, safeName);

        // Установка мода не должна прерываться общей кнопкой «Отменить».
        const prevAbort = currentAbort;
        currentAbort = null;
        try {
            await downloadFile(downloadUrl, dest, 0);
        } finally {
            currentAbort = prevAbort;
        }

        return { ok: true, path: dest };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ============================================================
//       АВТОУСТАНОВКА CustomSkinLoader ДЛЯ СБОРОК
// ============================================================
async function findCustomSkinLoaderVersion(mcVersion, loader) {
    const loaders = (loader && loader !== 'vanilla')
        ? [loader]
        : ['forge', 'neoforge', 'fabric', 'quilt'];

    const params = new URLSearchParams();
    if (mcVersion) params.append('game_versions', JSON.stringify([mcVersion]));
    params.append('loaders', JSON.stringify(loaders));

    const data = await modrinthFetch(`/project/customskinloader/version?` + params.toString());
    if (!Array.isArray(data) || !data.length) return null;

    const ver = data[0];
    const primary = (ver.files || []).find((f) => f.primary) || ver.files?.[0];
    if (!primary) return null;
    return {
        url: primary.url,
        filename: primary.filename,
        versionNumber: ver.version_number,
    };
}

async function applyOfflineSkinInternal(versionId, nickname) {
    try {
        if (versionId && isCustomBuild(versionId)) buildManager.ensure(versionId);
        if (!nickname) return { ok: false, error: 'Нет активного аккаунта' };

        let instanceDir;
        let modsDir;

        if (versionId) {
            const inst = path.join(MINECRAFT_PATH, 'instances', versionId);
            if (fs.existsSync(inst)) {
                instanceDir = inst;
                modsDir = path.join(inst, 'mods');
            }
        }
        if (!modsDir) {
            instanceDir = MINECRAFT_PATH;
            modsDir = path.join(MINECRAFT_PATH, 'mods');
        }
        fs.mkdirSync(modsDir, { recursive: true });

        const info = resolveInstanceInfo(versionId || '');
        const mcVersion = info.mcVersion;
        const loader = info.loader;

        if (!mcVersion) {
            return { ok: false, error: 'Не удалось определить версию Minecraft — выбери сборку' };
        }
        if (loader === 'vanilla') {
            return {
                ok: false,
                error: 'Для ванильных используется ресурспак. Это внутренняя ошибка — сообщи разработчику.',
            };
        }

        let existingJar = null;
        try {
            const jars = fs.readdirSync(modsDir);
            existingJar = jars.find((f) => /customskinloader/i.test(f) && f.endsWith('.jar')) || null;
        } catch (_) {}

        let downloadedJar = null;
        if (!existingJar) {
            const verInfo = await findCustomSkinLoaderVersion(mcVersion, loader);
            if (!verInfo) {
                return {
                    ok: false,
                    error: `Не нашёл CustomSkinLoader для ${mcVersion} (${loader}). Проверь интернет.`,
                };
            }
            const dest = path.join(modsDir, verInfo.filename);
            await downloadFile(verInfo.url, dest, 0);
            downloadedJar = verInfo.filename;
            console.log('[csl] downloaded:', verInfo.filename);
        } else {
            console.log('[csl] already present:', existingJar);
        }

        const cslDir = path.join(instanceDir, 'CustomSkinLoader');
        const localSkinsDir = path.join(cslDir, 'LocalSkin', 'skins');
        const localCapesDir = path.join(cslDir, 'LocalSkin', 'capes');
        fs.mkdirSync(localSkinsDir, { recursive: true });
        fs.mkdirSync(localCapesDir, { recursive: true });

        const srcSkin = path.join(MINECRAFT_PATH, 'skins', `${nickname}.png`);
        let skinCopied = false;
        if (fs.existsSync(srcSkin)) {
            fs.copyFileSync(srcSkin, path.join(localSkinsDir, `${nickname}.png`));
            skinCopied = true;
        }

        const configPath = path.join(cslDir, 'CustomSkinLoader.json');
        const srcCape = path.join(MINECRAFT_PATH, 'capes', `${nickname}.png`);
        const destCape = path.join(localCapesDir, `${nickname}.png`);
        if (fs.existsSync(srcCape)) fs.copyFileSync(srcCape, destCape);
        else if (fs.existsSync(destCape)) fs.unlinkSync(destCape);
        const previousConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
        const config = {
            enable: true,
            enableSkull: true,
            enableDynamicSkull: false,
            enableTransparentSkin: true,
            forceIgnoreHttpsCertificate: false,
            forceLoadAllTextures: true,
            enableCape: true,
            threadPoolSize: 8,
            cacheExpiry: 30,
            loadlist: [
                { name: 'LocalSkin', type: 'Legacy', skin: 'LocalSkin/skins/{USERNAME}.png', cape: 'LocalSkin/capes/{USERNAME}.png' },
                { name: 'Mojang', type: 'MojangAPI' },
            ],
        };
        Object.assign(config, previousConfig);
        config.loadlist = [{ name: 'LocalSkin', type: 'Legacy', skin: 'LocalSkin/skins/{USERNAME}.png', cape: 'LocalSkin/capes/{USERNAME}.png' },
            ...(Array.isArray(previousConfig.loadlist) ? previousConfig.loadlist.filter(item => item.name !== 'LocalSkin') : [{ name: 'Mojang', type: 'MojangAPI' }])];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

        return {
            ok: true,
            modInstalled: downloadedJar,
            modAlreadyPresent: existingJar,
            skinCopied,
            skinPath: skinCopied ? path.join(localSkinsDir, `${nickname}.png`) : null,
            configPath,
            mcVersion,
            loader,
        };
    } catch (e) {
        console.error('[csl] error:', e);
        return { ok: false, error: e.message };
    }
}

// ============================================================
//    ВАНИЛЬНЫЙ ОФЛАЙН-СКИН ЧЕРЕЗ РЕСУРСПАК (без модов)
// ============================================================
function getResourcePackFormat(mcVersion) {
    const m = String(mcVersion).match(/^1\.(\d+)(?:\.(\d+))?/);
    if (!m) return 6;
    const minor = parseInt(m[1], 10);
    const patch = m[2] ? parseInt(m[2], 10) : 0;

    if (minor <= 6) return 1;
    if (minor <= 8) return 2;
    if (minor <= 10) return 3;
    if (minor <= 12) return 4;
    if (minor === 13) return 4;
    if (minor === 14) return 4;
    if (minor === 15) return 5;
    if (minor === 16) return patch <= 1 ? 5 : 6;
    if (minor === 17) return 7;
    if (minor === 18) return 8;
    if (minor === 19 && patch <= 2) return 9;
    if (minor === 19 && patch === 3) return 12;
    if (minor === 19 && patch === 4) return 13;
    if (minor === 20 && patch <= 1) return 15;
    if (minor === 20 && patch === 2) return 18;
    if (minor === 20 && patch <= 4) return 22;
    if (minor === 20) return 32;
    if (minor === 21 && patch <= 1) return 34;
    if (minor === 21 && patch <= 3) return 42;
    return 46;
}

function createSkinResourcePack(nickname, mcVersion, outPath) {
    const skinSrc = path.join(MINECRAFT_PATH, 'skins', `${nickname}.png`);
    if (!fs.existsSync(skinSrc)) {
        return Promise.reject(new Error('Скин не найден: сначала загрузи PNG через «Загрузить свой скин»'));
    }

    const packFormat = getResourcePackFormat(mcVersion);
    const skinBuf = fs.readFileSync(skinSrc);

    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();

        const mcmeta = {
            pack: {
                pack_format: packFormat,
                description: `Offline skin: ${nickname}`,
            },
        };
        zip.addBuffer(Buffer.from(JSON.stringify(mcmeta, null, 2), 'utf-8'), 'pack.mcmeta');

        zip.addBuffer(skinBuf, 'assets/minecraft/textures/entity/steve.png');
        zip.addBuffer(skinBuf, 'assets/minecraft/textures/entity/alex.png');

        zip.addBuffer(skinBuf, 'assets/minecraft/textures/entity/player/wide/steve.png');
        zip.addBuffer(skinBuf, 'assets/minecraft/textures/entity/player/slim/alex.png');

        zip.addBuffer(skinBuf, 'assets/minecraft/textures/entity/player/wide/default.png');
        zip.addBuffer(skinBuf, 'assets/minecraft/textures/entity/player/slim/default_slim.png');

        zip.end();

        const out = fs.createWriteStream(outPath);
        zip.outputStream.pipe(out);
        out.on('close', () => resolve(outPath));
        out.on('error', reject);
    });
}

function updateOptionsTxt(gamePath, packFileName) {
    const optsPath = path.join(gamePath, 'options.txt');
    const packEntry = `file/${packFileName}`;
    const key = 'resourcePacks:';

    let lines = [];
    if (fs.existsSync(optsPath)) {
        lines = fs.readFileSync(optsPath, 'utf-8').split(/\r?\n/);
    }

    let found = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(key)) {
            const rest = lines[i].slice(key.length).trim();
            let arr = [];
            try {
                arr = JSON.parse(rest);
                if (!Array.isArray(arr)) arr = [];
            } catch (_) { arr = []; }
            if (!arr.includes(packEntry)) arr.unshift(packEntry);
            lines[i] = key + JSON.stringify(arr);
            found = true;
            break;
        }
    }
    if (!found) {
        lines.push(key + JSON.stringify([packEntry]));
    }

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('incompatibleResourcePacks:')) {
            const rest = lines[i].slice('incompatibleResourcePacks:'.length).trim();
            let arr = [];
            try { arr = JSON.parse(rest); if (!Array.isArray(arr)) arr = []; } catch (_) { arr = []; }
            arr = arr.filter((x) => x !== packEntry);
            lines[i] = 'incompatibleResourcePacks:' + JSON.stringify(arr);
            break;
        }
    }

    fs.writeFileSync(optsPath, lines.join('\n'), 'utf-8');
}

async function applyVanillaSkin(versionId, nickname) {
    if (versionId && isCustomBuild(versionId)) buildManager.ensure(versionId);
    const info = resolveInstanceInfo(versionId || '');
    const mcVersion = info.mcVersion;
    if (!mcVersion) {
        return { ok: false, error: 'Не удалось определить версию Minecraft' };
    }

    let gamePath = MINECRAFT_PATH;
    if (versionId) {
        const inst = path.join(MINECRAFT_PATH, 'instances', versionId);
        if (fs.existsSync(inst)) gamePath = inst;
    }

    const rpDir = path.join(gamePath, 'resourcepacks');
    fs.mkdirSync(rpDir, { recursive: true });

    const safeNick = String(nickname).replace(/[^A-Za-z0-9_\-]/g, '_');
    const packName = `skin_${safeNick}_${mcVersion}.zip`;
    const packPath = path.join(rpDir, packName);

    await createSkinResourcePack(nickname, mcVersion, packPath);
    updateOptionsTxt(gamePath, packName);

    return {
        ok: true,
        mode: 'resourcepack',
        packName,
        packPath,
        gamePath,
        mcVersion,
        format: getResourcePackFormat(mcVersion),
    };
}

ipcMain.handle('skin:apply', async (_e, { versionId, nickname }) => {
    try {
        if (!nickname) return { ok: false, error: 'Нет активного аккаунта' };

        const info = resolveInstanceInfo(versionId || '');
        if (!info.mcVersion) {
            return { ok: false, error: 'Не удалось определить MC-версию' };
        }

        if (info.loader === 'vanilla') {
            return await applyVanillaSkin(versionId, nickname);
        } else {
            return await applyOfflineSkinInternal(versionId, nickname);
        }
    } catch (e) {
        console.error('[skin:apply] error:', e);
        return { ok: false, error: e.message };
    }
});
