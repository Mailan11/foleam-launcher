const { ipcRenderer } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const skinview3d = require('./vendor/skinview3d.cjs');
const $ = (id) => document.getElementById(id);

let currentSettings = {};
let minecraftVersions = [];
let accounts = [];
let activeAccount = null;
let totalRamGB = 8;
let maxRamForGame = 6;
let skinViewer = null;
let customSelectedVersion = null;
let loaderVersionsAvailable = false;
let isCreatingCustom = false;
let versionMode = 'vanilla';

// ============================================================
//                  ОПРЕДЕЛЕНИЕ ОЗУ
// ============================================================
function detectSystemRam() {
    try {
        const total = os.totalmem();
        const free = os.freemem();
        totalRamGB = Math.round(total / 1024 / 1024 / 1024);
        const freeRamGB = Math.round(free / 1024 / 1024 / 1024);
        maxRamForGame = Math.max(2, totalRamGB - 2);
        const ram = $('ram');
        ram.max = String(maxRamForGame);
        if (parseInt(ram.value, 10) > maxRamForGame) ram.value = String(maxRamForGame);
        $('ram-hint').innerHTML =
            `На ПК: <b>${totalRamGB} ГБ</b> всего, ` +
            `~<b>${freeRamGB} ГБ</b> свободно. ` +
            `Доступно для игры: до <b>${maxRamForGame} ГБ</b>.`;
    } catch (e) {
        $('ram-hint').textContent = 'Не удалось определить ОЗУ';
    }
}

// ============================================================
//                       ТАБЫ
// ============================================================
document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
        tab.classList.add('active');
        $('tab-' + tab.dataset.tab).classList.add('active');
    });
});

// ============================================================
//                       МОДАЛКИ
// ============================================================
document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
        if (btn.dataset.close === 'create-custom-modal' && isCreatingCustom) return;
        $(btn.dataset.close).classList.remove('active');
    });
});
document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
        if (e.target !== ov) return;
        if (ov.id === 'create-custom-modal' && isCreatingCustom) return;
        ov.classList.remove('active');
    });
});

// ============================================================
//                       ПУТИ
// ============================================================
const dataArgument = process.argv.find(arg => arg.startsWith('--foleam-data='));
const MINECRAFT_DIR = path.join(dataArgument ? decodeURIComponent(dataArgument.slice('--foleam-data='.length)) : __dirname, 'minecraft_data');
const SKINS_DIR = path.join(MINECRAFT_DIR, 'skins');
const AVATARS_DIR = path.join(MINECRAFT_DIR, 'avatars');

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Очень минимальный markdown-рендер для описания мода Modrinth
function renderMarkdown(md) {
    if (!md) return '';
    let html = escapeHtml(md);

    // Картинки ![alt](url)
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%; border-radius:6px; margin:6px 0;">');
    // Ссылки [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#4daaff;">$1</a>');
    // Заголовки
    html = html.replace(/^######\s+(.+)$/gm, '<h6 style="margin:10px 0 4px; color:#ddd;">$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5 style="margin:10px 0 4px; color:#ddd;">$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4 style="margin:12px 0 4px; color:#eee;">$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3 style="margin:12px 0 4px; color:#fff; font-size:13px;">$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2 style="margin:14px 0 6px; color:#fff; font-size:14px;">$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1 style="margin:16px 0 6px; color:#fff; font-size:15px;">$1</h1>');
    // Жирный, курсив, код
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    html = html.replace(/`([^`]+)`/g, '<code style="background:#2a2a2e; padding:1px 5px; border-radius:3px; color:#e0e0e0; font-size:11px;">$1</code>');
    // Цитаты
    html = html.replace(/^&gt;\s?(.+)$/gm, '<blockquote style="border-left:3px solid #444; margin:6px 0; padding:4px 10px; color:#bbb;">$1</blockquote>');
    // Переносы строк
    html = html.replace(/\n/g, '<br>');
    return html;
}

function getAvatarUrl(nick, size = 32) {
    try {
        const local = path.join(AVATARS_DIR, `${nick}.png`);
        if (fs.existsSync(local)) {
            const buf = fs.readFileSync(local);
            return 'data:image/png;base64,' + buf.toString('base64');
        }
    } catch (_) {}
    return `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/${size}`;
}

function focusInput(el) {
    if (!el) return;
    try { window.focus(); } catch (_) {}
    requestAnimationFrame(() => requestAnimationFrame(() => {
        try { el.focus(); el.select(); } catch (_) {}
    }));
    setTimeout(() => {
        if (document.activeElement !== el) {
            try { el.focus(); el.select(); } catch (_) {}
        }
    }, 120);
}

// ============================================================
//                       АККАУНТЫ
// ============================================================
function renderAccounts() {
    const list = $('accounts-list');
    list.innerHTML = '';

    if (!accounts.length) {
        list.innerHTML = '<div style="text-align:center; color:#666; font-size:12px; padding:20px 0;">Аккаунтов нет. Добавь офлайн-аккаунт или войди в Microsoft.</div>';
        return;
    }

    accounts.forEach((acc, i) => {
        const isActive = activeAccount === acc;
        const el = document.createElement('div');
        el.className = 'account-item' + (isActive ? ' active' : '');
        el.innerHTML = `
            <div class="account-avatar" style="background-image:url('${getAvatarUrl(acc.name, 36)}')">
                <span class="avatar-edit-badge" title="ЛКМ — загрузить, ПКМ — сбросить">✎</span>
            </div>
            <div class="info">
                <div class="name">${escapeHtml(acc.name)}</div>
                <div class="sub ${acc.type === 'licensed' ? 'licensed' : ''}">${acc.type === 'mailan' ? 'Mailan1 ID ' + Number(acc.mailanId) : acc.type === 'licensed' ? 'Лицензия Microsoft' : 'Офлайн'}</div>
            </div>
            <button class="remove" data-i="${i}" title="Удалить">✕</button>
        `;

        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('remove')) return;
            if (e.target.classList.contains('avatar-edit-badge')) return;
            selectAccount(i);
        });

        el.querySelector('.remove').addEventListener('click', (e) => {
            e.stopPropagation();
            removeAccount(i);
        });

        const badge = el.querySelector('.avatar-edit-badge');
        badge.addEventListener('contextmenu', (e) => e.preventDefault());
        badge.addEventListener('mousedown', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (e.button === 2 || e.ctrlKey) {
                const res = await ipcRenderer.invoke('avatar:clear', acc.name);
                if (res?.ok) {
                    renderAccounts();
                    if (activeAccount && activeAccount.name === acc.name) updateAccountDisplay();
                }
                return;
            }
            if (e.button === 0) {
                const res = await ipcRenderer.invoke('avatar:upload', acc.name);
                if (res?.ok) {
                    renderAccounts();
                    if (activeAccount && activeAccount.name === acc.name) updateAccountDisplay();
                } else if (res?.error) {
                    alert('Ошибка загрузки аватара: ' + res.error);
                }
            }
        });

        list.appendChild(el);
    });
}

function selectAccount(i) {
    activeAccount = accounts[i];
    updateAccountDisplay();
    $('accounts-modal').classList.remove('active');
    currentSettings.accountKey = activeAccount.type === 'mailan'
        ? `mailan:${activeAccount.mailanId}`
        : `${activeAccount.type}:${activeAccount.name}`;
    ipcRenderer.invoke('settings:set', { ...currentSettings, username: activeAccount.name });
    currentSettings.username = activeAccount.name;
}

async function removeAccount(i) {
    const removed = accounts[i];
    if (!removed) return;

    let ok = false;
    try {
        ok = await ipcRenderer.invoke('ui:confirm', {
            title: 'Удалить аккаунт',
            message: `Удалить аккаунт «${removed.name}»?`,
            okLabel: 'Удалить',
        });
    } catch (e) {
        console.warn('[removeAccount] confirm failed:', e);
        return;
    }
    if (!ok) return;

    if (removed.type === 'mailan') {
        ipcRenderer.invoke('mailan:logout', removed.mailanId).catch(() => {});
    }
    accounts.splice(i, 1);
    if (activeAccount === removed) {
        activeAccount = accounts[0] || null;
        updateAccountDisplay();
    }
    saveAccounts();
    renderAccounts();
}

function updateAccountDisplay() {
    if (!activeAccount) {
        $('account-name').textContent = 'Нет аккаунта';
        $('account-type').textContent = 'Нажми, чтобы добавить';
        $('account-type').className = 'type';
        $('account-avatar').style.backgroundImage = `url('${getAvatarUrl('Steve', 32)}')`;
        return;
    }
    $('account-name').textContent = activeAccount.name;
    $('account-type').textContent = activeAccount.type === 'mailan'
        ? `Mailan1 ID ${activeAccount.mailanId}`
        : activeAccount.type === 'licensed' ? 'Лицензия Microsoft' : 'Офлайн-аккаунт';
    $('account-type').className = 'type' + (activeAccount.type === 'licensed' ? ' licensed' : '');
    $('account-avatar').style.backgroundImage = `url('${getAvatarUrl(activeAccount.name, 32)}')`;
}

async function saveAccounts() {
    const result = await ipcRenderer.invoke('accounts:save', accounts);
    if (!result?.ok) throw new Error(result?.error || 'Не удалось сохранить аккаунты.');
}

async function loadAccounts() {
    accounts = await ipcRenderer.invoke('accounts:load');
    const cfg = await ipcRenderer.invoke('settings:get');
    if (cfg.username) {
        activeAccount = accounts.find((a) => (a.type === 'mailan' ? `mailan:${a.mailanId}` : `${a.type}:${a.name}`) === cfg.accountKey)
            || accounts.find((a) => a.name === cfg.username)
            || accounts[0] || null;
    } else {
        activeAccount = accounts[0] || null;
    }
    if (!accounts.length) {
        const defName = cfg.username || 'Mailan1';
        accounts.push({ name: defName, type: 'offline' });
        activeAccount = accounts[0];
        await saveAccounts();
    }
    updateAccountDisplay();
    renderAccounts();
}

$('account-block').addEventListener('click', () => {
    renderAccounts();
    $('accounts-modal').classList.add('active');
});

// ============================================================
//             ОФЛАЙН-АККАУНТ
// ============================================================
$('add-offline').addEventListener('click', () => {
    const input = $('offline-nickname');
    input.value = '';
    input.disabled = false;
    $('offline-error').style.display = 'none';
    $('offline-modal').classList.add('active');
    focusInput(input);
});

$('offline-cancel').addEventListener('click', () => {
    $('offline-modal').classList.remove('active');
    $('offline-error').style.display = 'none';
});

async function saveOfflineAccount() {
    const input = $('offline-nickname');
    const errEl = $('offline-error');
    const name = input.value.trim();
    const fail = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
    errEl.style.display = 'none';

    if (!name) { fail('Введи никнейм'); return; }
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
        fail('Ник: 3-16 символов, только A-Z, a-z, 0-9, _');
        return;
    }
    if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
        fail('Такой аккаунт уже есть');
        return;
    }

    accounts.push({ name, type: 'offline' });
    await saveAccounts();

    if (!activeAccount) {
        activeAccount = accounts[accounts.length - 1];
        updateAccountDisplay();
        currentSettings.accountKey = `offline:${activeAccount.name}`;
        currentSettings.username = activeAccount.name;
        ipcRenderer.invoke('settings:set', currentSettings);
    }

    $('offline-modal').classList.remove('active');
    input.value = '';
    errEl.style.display = 'none';

    renderAccounts();
}

$('offline-save').addEventListener('click', saveOfflineAccount);
$('offline-nickname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveOfflineAccount(); }
    if (e.key === 'Escape') {
        $('offline-modal').classList.remove('active');
        $('offline-error').style.display = 'none';
    }
});

// ============================================================
//                  MICROSOFT LOGIN
// ============================================================
$('add-license').addEventListener('click', () => {
    $('accounts-modal').classList.remove('active');
    $('msa-modal').classList.add('active');
    $('msa-code').textContent = '...';
    $('msa-link').textContent = 'microsoft.com/link';
    $('msa-status').textContent = 'Запрос кода у Microsoft...';
    ipcRenderer.send('msa:start-login');
});

$('add-mailan').addEventListener('click', async () => {
    const button = $('add-mailan');
    button.disabled = true;
    $('mailan-status').textContent = 'Ожидаем вход на mailan1.ru...';
    try {
        const result = await ipcRenderer.invoke('mailan:login');
        if (!result.ok) throw new Error(result.error);
        const account = result.account;
        const index = accounts.findIndex(a => a.type === 'mailan' && a.mailanId === account.mailanId);
        if (index >= 0) accounts[index] = account; else accounts.push(account);
        await saveAccounts();

        activeAccount = account;
        updateAccountDisplay();
        currentSettings.accountKey = `mailan:${account.mailanId}`;
        currentSettings.username = account.name;
        ipcRenderer.invoke('settings:set', currentSettings);

        renderAccounts();
        $('status').textContent = `Вход выполнен: Mailan1 ID ${account.mailanId}`;
        $('mailan-status').textContent = '';
    } catch (error) { $('mailan-status').textContent = error.message || 'Не удалось войти.'; }
    finally { button.disabled = false; }
});

ipcRenderer.on('msa:code', (e, data) => {
    $('msa-code').textContent = data.userCode;
    $('msa-link').textContent = data.verificationUri;
    $('msa-status').textContent = 'Открой ссылку в браузере и введи код выше';
});

ipcRenderer.on('msa:login-complete', (e, account) => {
    $('msa-modal').classList.remove('active');
    loadAccounts().then(() => {
        renderAccounts();
        const idx = accounts.findIndex((a) => a.name === account.name);
        if (idx >= 0) selectAccount(idx);
        $('status').innerText = `Вход выполнен: ${account.name}`;
    });
});

ipcRenderer.on('msa:login-error', (e, msg) => {
    $('msa-modal').classList.remove('active');
    $('status').innerText = `Ошибка входа: ${msg}`;
    alert('Не удалось войти в Microsoft.\n\n' + msg);
});

$('msa-cancel').addEventListener('click', () => {
    ipcRenderer.send('msa:cancel-login');
    $('msa-modal').classList.remove('active');
});

// ============================================================
//               ELY.BY LOGIN (UI)
// ============================================================
$('add-ely').addEventListener('click', () => {
    $('accounts-modal').classList.remove('active');
    $('ely-modal').classList.add('active');
    $('ely-username').value = '';
    $('ely-password').value = '';
    $('ely-error').style.display = 'none';
    setTimeout(() => $('ely-username').focus(), 60);
});

$('ely-login-btn').addEventListener('click', async () => {
    const username = $('ely-username').value.trim();
    const password = $('ely-password').value;
    const errEl = $('ely-error');
    const fail = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
    errEl.style.display = 'none';

    if (!username) return fail('Введи логин');
    if (!password) return fail('Введи пароль');

    const btn = $('ely-login-btn');
    btn.disabled = true;
    btn.textContent = 'Вход...';

    try {
        const res = await ipcRenderer.invoke('ely:login', { username, password });
        if (!res?.ok) throw new Error(res?.error || 'Не удалось войти');

        const account = res.account;
        const idx = accounts.findIndex((a) => a.type === 'ely' && a.name === account.name);
        if (idx >= 0) accounts[idx] = account; else accounts.push(account);
        await saveAccounts();

        activeAccount = account;
        updateAccountDisplay();
        currentSettings.accountKey = `ely:${account.name}`;
        currentSettings.username = account.name;
        ipcRenderer.invoke('settings:set', currentSettings);

        renderAccounts();
        $('ely-modal').classList.remove('active');
        $('status').textContent = `Вход Ely.by: ${account.name}`;
    } catch (e) {
        fail(e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Войти';
    }
});

$('ely-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ely-password').focus();
});
$('ely-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ely-login-btn').click();
});

// ============================================================
//                       ПЕРСОНАЖ (3D)
// ============================================================
function initSkinViewer() {
    if (skinViewer) return;
    try {
        skinViewer = new skinview3d.SkinViewer({
            canvas: $('skin-canvas'),
            width: 360,
            height: 300,
            zoom: 0.85,
        });
        skinViewer.animation = null;
        skinViewer.renderer.setClearColor(0x1c1c20, 1);
    } catch (e) {
        console.error('[skin] init error:', e);
    }
}

function loadSkinForAccount() {
    if (!skinViewer) return;
    const nick = activeAccount?.name || 'Steve';
    const localSkin = path.join(SKINS_DIR, `${nick}.png`);

    try {
        if (fs.existsSync(localSkin)) {
            const buf = fs.readFileSync(localSkin);
            const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
            skinViewer.loadSkin(dataUrl, { model: 'auto-detect' });
        } else {
            skinViewer.loadSkin(`https://mc-heads.net/skin/${encodeURIComponent(nick)}`, {
                model: 'auto-detect',
            });
        }
        skinViewer.loadCape(null);
    } catch (e) {
        console.warn('[skin] load error:', e.message);
    }
}

function refreshApplyTargets() {
    const sel = $('apply-offline-target');
    if (!sel) return;

    sel.innerHTML = '';

    const installed = minecraftVersions.filter((v) => v.installed);
    if (!installed.length) {
        const opt = document.createElement('option');
        opt.textContent = 'Нет установленных версий';
        sel.appendChild(opt);
        sel.disabled = true;
        return;
    }

    sel.disabled = false;

    const currentId = select.value;
    const ordered = [];
    const seen = new Set();

    const cur = installed.find((v) => v.id === currentId);
    if (cur) { ordered.push(cur); seen.add(cur.id); }
    for (const v of installed) {
        if (!seen.has(v.id)) { ordered.push(v); seen.add(v.id); }
    }

    for (const v of ordered) {
        const opt = document.createElement('option');
        opt.value = v.id;

        let icon, mode;
        if (v.isBuild) { icon = '🔧'; mode = 'CustomSkinLoader'; }
        else { icon = '🎨'; mode = 'Ресурспак'; }

        const current = (v.id === currentId) ? '  · текущая' : '';
        opt.textContent = `${icon} ${v.id}  (${mode})${current}`;
        sel.appendChild(opt);
    }
}

window.addEventListener('resize', () => {
    if (skinViewer) skinViewer.render();
});

$('upload-skin')?.addEventListener('click', async () => {
    const nick = activeAccount?.name || 'Steve';
    const res = await ipcRenderer.invoke('skin:upload', nick);
    if (res?.ok) {
        loadSkinForAccount();
        $('status').innerText = 'Скин обновлён';
    } else if (res?.error) {
        alert('Ошибка: ' + res.error);
    }
});

$('clear-skin')?.addEventListener('click', async () => {
    const nick = activeAccount?.name || 'Steve';
    const res = await ipcRenderer.invoke('skin:clear', nick);
    if (res?.ok) {
        loadSkinForAccount();
        $('status').innerText = 'Скин сброшен';
    }
});

$('apply-offline-skin')?.addEventListener('click', async () => {
    const nick = activeAccount?.name || null;
    const versionId = $('apply-offline-target').value;

    const statusEl = $('apply-offline-status');
    const btn = $('apply-offline-skin');

    const setStatus = (msg, color = '#7dff7d') => {
        statusEl.style.display = 'block';
        statusEl.style.color = color;
        statusEl.textContent = msg;
    };

    const resetBtn = () => {
        btn.textContent = 'Применить скин';
        btn.disabled = false;
    };

    if (!nick) {
        setStatus('Сначала выбери аккаунт', '#ff9999');
        return;
    }
    if (!versionId) {
        setStatus('Выбери версию, к которой применить скин', '#ff9999');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Применяю...';
    setStatus('Проверяю...', '#aaa');

    try {
        const res = await ipcRenderer.invoke('skin:apply', {
            versionId,
            nickname: nick,
        });

        if (!res?.ok) {
            setStatus('Ошибка: ' + (res?.error || 'неизвестно'), '#ff9999');
            resetBtn();
            return;
        }

        if (res.mode === 'resourcepack') {
            setStatus(
                `✓ Готово! Создан ресурспак ${res.packName} и активирован. Перезапусти игру — скин будет виден.`,
                '#7dff7d'
            );
            $('status').innerText = `Скин для ${nick} применён (ресурспак, без модов)`;
        } else {
            const parts = [];
            if (res.modInstalled) parts.push('мод: ' + res.modInstalled);
            else if (res.modAlreadyPresent) parts.push('мод уже был');
            if (res.skinCopied) parts.push('скин скопирован');
            setStatus(
                `✓ ${parts.join(' · ')}. Перезапусти игру.`,
                '#7dff7d'
            );
            $('status').innerText = `Скин для ${nick} применён (CustomSkinLoader)`;
        }

        btn.textContent = '✓ Готово';
        setTimeout(resetBtn, 2500);
    } catch (e) {
        setStatus('Ошибка: ' + e.message, '#ff9999');
        resetBtn();
    }
});

// ============================================================
//                       НАСТРОЙКИ
// ============================================================
const ram = $('ram');

function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + ' Б';
    const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

function updateRamPresetsActive() {
    const val = parseInt(ram.value, 10);
    document.querySelectorAll('.ram-preset').forEach((btn) => {
        btn.classList.toggle('active', parseInt(btn.dataset.gb, 10) === val);
    });
}

function updateRamLabel() {
    $('ram-val').textContent = ram.value + ' ГБ';
    updateRamPresetsActive();
}

ram.addEventListener('input', updateRamLabel);

document.querySelectorAll('.ram-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
        const gb = parseInt(btn.dataset.gb, 10);
        if (gb > maxRamForGame) {
            $('status').innerText =
                `Нельзя выделить больше ${maxRamForGame} ГБ (всего ${totalRamGB} ГБ в системе)`;
            return;
        }
        ram.value = String(gb);
        updateRamLabel();
    });
});

$('java-mode').addEventListener('change', () => {
    $('java-path').style.display = $('java-mode').value === 'manual' ? 'block' : 'none';
});

$('java-detect').addEventListener('click', async () => {
    const btn = $('java-detect');
    const box = $('java-detected');
    btn.disabled = true;
    btn.textContent = 'Поиск...';
    box.classList.remove('error');
    box.classList.add('active');
    box.textContent = 'Ищем Java в системе...';

    try {
        const list = await ipcRenderer.invoke('system:detect-java');
        if (!list || !list.length) {
            box.classList.add('error');
            box.innerHTML = '❌ Java не найдена. Установи JRE/JDK или оставь режим «Автоматически».';
            return;
        }

        let html = `<div class="ok">Найдено установок: ${list.length}</div>`;
        for (const j of list) {
            html += `
                <div data-java-path="${escapeHtml(j.path)}"
                     style="margin-top:6px; padding:6px 8px; background:#1a1a1e;
                            border-radius:4px; cursor:pointer; border:1px solid transparent;">
                    <div style="color:#ccc; font-size:11px;">
                        ${escapeHtml(j.version)}
                        <span style="color:#666;">· ${escapeHtml(j.source)}</span>
                    </div>
                    <code>${escapeHtml(j.path)}</code>
                </div>`;
        }
        box.innerHTML = html;

        const items = box.querySelectorAll('[data-java-path]');
        items.forEach((el) => {
            el.addEventListener('click', () => {
                $('java-path').value = el.dataset.javaPath;
                items.forEach((e) => e.style.borderColor = 'transparent');
                el.style.borderColor = '#3daa3d';
                if ($('java-mode').value !== 'manual') {
                    $('java-mode').value = 'manual';
                    $('java-path').style.display = 'block';
                }
            });
        });

        if (list.length === 1) {
            $('java-path').value = list[0].path;
            items[0].style.borderColor = '#3daa3d';
        }
    } catch (e) {
        box.classList.add('error');
        box.innerHTML = 'Ошибка поиска: ' + escapeHtml(e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Найти Java на компьютере';
    }
});

async function updateFolderSize() {
    const el = $('folder-size');
    el.textContent = 'Размер данных: вычисляется...';
    try {
        const bytes = await ipcRenderer.invoke('system:folder-size');
        el.innerHTML = `Размер данных: <b>${formatBytes(bytes)}</b>`;
    } catch (e) {
        el.textContent = 'Размер данных: не удалось определить';
    }
}

function showSaved() {
    const ind = $('save-indicator');
    ind.textContent = '✓ Сохранено';
    ind.classList.add('show');
    clearTimeout(showSaved._t);
    showSaved._t = setTimeout(() => ind.classList.remove('show'), 1500);
}

async function loadSettings() {
    const s = await ipcRenderer.invoke('settings:get');
    currentSettings = s;

    let savedRamGB = Math.round((s.maxMemory || 4096) / 1024);
    if (savedRamGB > maxRamForGame) savedRamGB = maxRamForGame;
    if (savedRamGB < 2) savedRamGB = 2;

    ram.value = String(savedRamGB);
    $('java-mode').value = s.javaMode || 'auto';
    $('java-path').value = s.javaPath || '';
    $('jvm-args').value = s.jvmArgs || '';
    $('auto-close-launcher').checked = !!s.autoCloseLauncher;

    updateRamLabel();
    $('java-path').style.display = $('java-mode').value === 'manual' ? 'block' : 'none';
    updateFolderSize();
}

$('save-settings').addEventListener('click', async () => {
    const maxMemory = parseInt(ram.value, 10) * 1024;
    const minMemory = Math.max(512, Math.round(maxMemory / 2));

    const newSettings = {
        maxMemory,
        minMemory,
        javaMode: $('java-mode').value,
        javaPath: $('java-path').value.trim(),
        jvmArgs: $('jvm-args').value.trim(),
        autoCloseLauncher: $('auto-close-launcher').checked,
    };

    await ipcRenderer.invoke('settings:set', newSettings);
    currentSettings = { ...currentSettings, ...newSettings };
    $('status').innerText = 'Настройки сохранены';
    showSaved();
});

$('reset-settings').addEventListener('click', async () => {
    let ok = false;
    try {
        ok = await ipcRenderer.invoke('ui:confirm', {
            title: 'Сброс настроек',
            message: 'Вернуть все настройки к значениям по умолчанию?',
            okLabel: 'Сбросить',
        });
    } catch (_) { return; }
    if (!ok) return;

    const def = await ipcRenderer.invoke('settings:reset');
    currentSettings = { ...currentSettings, ...def };
    await loadSettings();
    $('status').innerText = 'Настройки сброшены';
    showSaved();
});

// ============================================================
//                       ПАПКИ / МОДЫ
// ============================================================
['mc', 'mods', 'versions', 'saves'].forEach((k) => {
    $('open-' + k).addEventListener('click', () => ipcRenderer.invoke('open-folder', { folder:k === 'mc' ? 'root' : k, version:select.value }));
});

$('install-mod').addEventListener('click', async () => {
    const res = await ipcRenderer.invoke('install-mod', { version: select.value });
    if (res?.ok) $('status').innerText = `Мод установлен: ${res.name}`;
    else if (res?.error) $('status').innerText = `Ошибка: ${res.error}`;
});

// ============================================================
//                       ВЕРСИИ
// ============================================================
const select = $('version');
const playBtn = $('play-btn');
const deleteBtn = $('delete-btn');
const statusText = $('status');
const progressBar = $('progress-bar');
const progressFill = $('progress-fill');

function getVisibleVersions() {
    return minecraftVersions.filter((v) =>
        versionMode === 'builds' ? v.isBuild : !v.isBuild
    );
}

function renderVersionSelect() {
    const visible = getVisibleVersions();
    const prevValue = select.value;
    select.innerHTML = '';

    if (!visible.length) {
        const opt = document.createElement('option');
        opt.textContent = versionMode === 'builds'
            ? 'Сборок пока нет — создай через +'
            : 'Нет доступных версий';
        select.appendChild(opt);
        select.disabled = true;
        playBtn.disabled = true;
        playBtn.textContent = versionMode === 'builds' ? 'Нет сборок' : 'Нет версий';
        playBtn.dataset.action = 'wait';
        deleteBtn.disabled = true;
        return;
    }

    select.disabled = false;
    for (const v of visible) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.dataset.installed = v.installed ? '1' : '0';
        const prefix = v.isBuild ? '⚙ ' : 'Minecraft ';
        opt.textContent = prefix + (v.displayName || v.id) + (v.installed ? '  ✔' : '');
        select.appendChild(opt);
    }

    let restored = false;
    for (const opt of select.options) {
        if (opt.value === prevValue) { select.value = opt.value; restored = true; break; }
    }
    if (!restored && currentSettings.lastVersion) {
        for (const opt of select.options) {
            if (opt.value === currentSettings.lastVersion) { select.value = opt.value; break; }
        }
    }
    updateButtons();
}

async function loadVersions() {
    select.innerHTML = '<option>Загрузка...</option>';
    select.disabled = true;
    playBtn.textContent = 'Подождите...';
    playBtn.dataset.action = 'wait';
    playBtn.disabled = true;
    deleteBtn.disabled = true;
    $('add-custom-version').disabled = true;

    try {
        const versions = await ipcRenderer.invoke('get-versions');
        minecraftVersions = versions;
        $('add-custom-version').disabled = false;
        renderVersionSelect();
        statusText.innerText = versions.some((v) => v.online)
            ? 'Ожидание...'
            : 'Нет интернета — показаны только установленные версии';
    } catch (e) {
        console.error(e);
        select.innerHTML = '<option>Ошибка загрузки</option>';
        playBtn.textContent = 'Ошибка';
    }
}

document.querySelectorAll('.version-mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        if (versionMode === tab.dataset.vmode) return;
        versionMode = tab.dataset.vmode;
        document.querySelectorAll('.version-mode-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        renderVersionSelect();
    });
});

function updateButtons() {
    const opt = select.selectedOptions[0];
    if (!opt || !opt.value) return;
    const installed = opt.dataset.installed === '1';
    playBtn.disabled = false;
    playBtn.textContent = installed ? 'Играть' : 'Установить';
    playBtn.dataset.action = installed ? 'play' : 'install';
    deleteBtn.disabled = !installed;
}
select.addEventListener('change', updateButtons);

playBtn.addEventListener('click', () => {
    if (!activeAccount) { statusText.innerText = 'Сначала добавь аккаунт!'; return; }
    const username = activeAccount.name;
    const version = select.value;
    const action = playBtn.dataset.action;
    if (!version || action === 'wait') return;

    statusText.innerText = action === 'install' ? 'Подготовка к установке...' : 'Запуск...';
    progressBar.style.display = 'block';
    progressFill.style.width = '0%';

    ipcRenderer.invoke('settings:set', { ...currentSettings, username, lastVersion: version });
    ipcRenderer.send('launch-game', {
        username,
        version,
        action,
        type: activeAccount.type,
        mailanId: activeAccount.mailanId,
        accessToken: activeAccount.accessToken || '0',
        uuid: activeAccount.uuid || '00000000000000000000000000000000',
    });
});

// ============================================================
//   УДАЛЕНИЕ ВЕРСИИ с предупреждением о зависимых сборках
// ============================================================
deleteBtn.addEventListener('click', async () => {
    const version = select.value;
    if (!version) return;

    let dependents = [];
    try {
        dependents = await ipcRenderer.invoke('version:dependents', version);
    } catch (_) {}
    if (!Array.isArray(dependents)) dependents = [];

    let detail = '';
    if (dependents.length) {
        const list = dependents.slice(0, 12).map((d) => '  • ' + d).join('\n');
        const more = dependents.length > 12 ? `\n  ...и ещё ${dependents.length - 12}` : '';
        detail =
            `От этой версии зависят:\n${list}${more}\n\n` +
            `Они НЕ будут удалены. При следующем запуске базовая версия ` +
            `${version} скачается заново автоматически.`;
    }

    let ok = false;
    try {
        ok = await ipcRenderer.invoke('ui:confirm', {
            title: 'Удаление версии',
            message: `Удалить версию ${version}?`,
            detail,
            okLabel: 'Удалить',
        });
    } catch (_) { return; }
    if (!ok) return;

    const res = await ipcRenderer.invoke('version:delete', version);
    if (res.ok) { statusText.innerText = `Удалено: ${version}`; loadVersions(); }
    else statusText.innerText = `Ошибка: ${res.error}`;
});

// ============================================================
//              СОЗДАНИЕ СБОРКИ
// ============================================================
function isLoaderSupported(loader, mcVersion) {
    if (loader === 'vanilla') return true;
    if (loader === 'neoforge') {
        const m = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
        if (!m) return false;
        const minor = parseInt(m[1], 10);
        const patch = m[2] ? parseInt(m[2], 10) : 0;
        if (minor > 20) return true;
        if (minor === 20 && patch >= 2) return true;
        return false;
    }
    return true;
}

function renderCustomVersions(filter = '') {
    const list = $('custom-versions-list');
    list.innerHTML = '';

    const f = filter.toLowerCase().trim();
    const releases = minecraftVersions.filter((v) => !v.isBuild && /^1\.\d+(\.\d+)?$/.test(v.id));
    const filtered = f ? releases.filter((v) => v.id.toLowerCase().includes(f)) : releases;

    if (!filtered.length) {
        list.innerHTML = '<div style="text-align:center;color:#666;font-size:12px;padding:12px;">Ничего не найдено</div>';
        updatePreview();
        return;
    }

    for (const v of filtered) {
        const el = document.createElement('div');
        el.className = 'version-item' + (customSelectedVersion === v.id ? ' selected' : '');
        el.innerHTML = `
            <span>Minecraft ${v.id}</span>
            ${v.installed ? '<span class="installed-mark">✔</span>' : ''}
        `;
        el.addEventListener('click', () => {
            customSelectedVersion = v.id;
            renderCustomVersions($('custom-search').value);
            updateLoaderVersions();
        });
        list.appendChild(el);
    }

    updatePreview();
    updateAutoPlaceholder();
}

async function updateLoaderVersions() {
    const loaderInput = document.querySelector('input[name="custom-loader"]:checked');
    const loader = loaderInput ? loaderInput.value : 'vanilla';
    const row = $('loader-version-row');
    const sel = $('custom-loader-version');

    loaderVersionsAvailable = false;

    if (loader === 'vanilla' || !customSelectedVersion) {
        row.style.display = 'none';
        loaderVersionsAvailable = true;
        updatePreview();
        updateAutoPlaceholder();
        updateCreateButtonState();
        return;
    }

    if (!isLoaderSupported(loader, customSelectedVersion)) {
        row.style.display = 'block';
        sel.innerHTML = '<option>Не поддерживается для этой версии</option>';
        sel.disabled = true;
        loaderVersionsAvailable = false;
        updatePreview();
        updateAutoPlaceholder();
        updateCreateButtonState();
        return;
    }

    row.style.display = 'block';
    sel.innerHTML = '<option>Загрузка...</option>';
    sel.disabled = true;

    try {
        const list = await ipcRenderer.invoke('modloader:versions', {
            type: loader,
            mcVersion: customSelectedVersion,
        });

        if (!list.length) {
            sel.innerHTML = '<option>Нет версий для ' + customSelectedVersion + '</option>';
            sel.disabled = true;
            loaderVersionsAvailable = false;
            updatePreview();
            updateAutoPlaceholder();
            updateCreateButtonState();
            return;
        }

        sel.innerHTML = '';
        list.forEach((v, idx) => {
            const opt = document.createElement('option');
            opt.value = v;
            if (idx === 0) {
                opt.textContent = v + '  ⭐ рекомендуется';
                opt.dataset.recommended = '1';
            } else {
                opt.textContent = v;
            }
            sel.appendChild(opt);
        });
        sel.disabled = false;
        loaderVersionsAvailable = true;

        sel.onchange = () => { updatePreview(); updateAutoPlaceholder(); };
    } catch (e) {
        sel.innerHTML = '<option>Ошибка: ' + e.message + '</option>';
        sel.disabled = true;
        loaderVersionsAvailable = false;
    }

    updatePreview();
    updateAutoPlaceholder();
    updateCreateButtonState();
}

function updateCreateButtonState() {
    const btn = $('custom-create');
    if (isCreatingCustom) return;
    const loaderInput = document.querySelector('input[name="custom-loader"]:checked');
    const loader = loaderInput ? loaderInput.value : 'vanilla';
    const valid = customSelectedVersion && (loader === 'vanilla' || loaderVersionsAvailable);
    btn.disabled = !valid;
}

function updatePreview() {
    if (isCreatingCustom) return;

    const name = $('custom-name').value.trim();
    const loaderInput = document.querySelector('input[name="custom-loader"]:checked');
    const loader = loaderInput ? loaderInput.value : 'vanilla';
    const preview = $('custom-preview');

    if (!customSelectedVersion) { preview.style.display = 'none'; return; }

    const loaderNames = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric' };
    let html = '';

    if (loader === 'vanilla') {
        html = `Будет создана сборка <b>Minecraft ${customSelectedVersion}</b> ` +
               `<span class="loader-tag vanilla">Vanilla</span><br>` +
               `Свои моды, сохранения и конфиги в отдельной папке`;
    } else if (!loaderVersionsAvailable) {
        const reason = !isLoaderSupported(loader, customSelectedVersion)
            ? `${loaderNames[loader]} не поддерживает ${customSelectedVersion}`
            : `Для ${loaderNames[loader]} нет версий под ${customSelectedVersion}`;
        html = `<span style="color:#ff7777;">⚠ ${reason}</span><br>` +
               `Выбери другую версию Minecraft или другой загрузчик`;
    } else {
        const loaderVersion = $('custom-loader-version').value || '?';
        const isRecommended = $('custom-loader-version').selectedOptions[0]?.dataset.recommended === '1';
        html = `Будет создана сборка <b>Minecraft ${customSelectedVersion}</b> ` +
               `с <span class="loader-tag ${loader}">${loaderNames[loader]}</span> ` +
               `<b>${loaderVersion}</b>${isRecommended ? ' ⭐' : ''}<br>` +
               `Свои моды, сохранения и конфиги в отдельной папке`;
    }

    if (name) html += `<br>Название: <b>${name}</b>`;

    preview.innerHTML = html;
    preview.style.display = 'block';
}

function updateAutoPlaceholder() {
    if (!customSelectedVersion) return;
    const loaderInput = document.querySelector('input[name="custom-loader"]:checked');
    const loader = loaderInput ? loaderInput.value : 'vanilla';
    const nameInput = $('custom-name');
    if (nameInput.value.trim()) return;
    const loaderNames = { neoforge: ' NeoForge', forge: ' Forge', fabric: ' Fabric' };
    nameInput.placeholder = `${customSelectedVersion}${loader !== 'vanilla' ? loaderNames[loader] : ''}`;
}

$('add-custom-version').addEventListener('click', () => {
    customSelectedVersion = null;
    loaderVersionsAvailable = false;
    isCreatingCustom = false;

    const releases = minecraftVersions.filter((v) => !v.isBuild && /^1\.\d+(\.\d+)?$/.test(v.id));
    if (releases.length) {
        const installed = releases.find((v) => v.installed);
        customSelectedVersion = installed ? installed.id : releases[0].id;
    }

    $('custom-name').value = '';
    $('custom-search').value = '';
    document.querySelector('input[name="custom-loader"][value="vanilla"]').checked = true;
    $('loader-version-row').style.display = 'none';
    $('custom-error').style.display = 'none';
    $('custom-create').disabled = false;
    $('custom-create').textContent = 'OK';

    renderCustomVersions();
    updatePreview();
    updateAutoPlaceholder();
    updateCreateButtonState();

    $('create-custom-modal').classList.add('active');
    setTimeout(() => $('custom-name').focus(), 60);
});

$('custom-search').addEventListener('input', () => {
    renderCustomVersions($('custom-search').value);
});

$('custom-name').addEventListener('input', () => {
    updatePreview();
});

document.querySelectorAll('input[name="custom-loader"]').forEach((radio) => {
    radio.addEventListener('change', () => {
        updateLoaderVersions();
    });
});

function showCustomProgress(msg = 'Подготовка...', pct = 0) {
    const preview = $('custom-preview');
    preview.style.display = 'block';
    preview.innerHTML = `
        <b id="custom-status-text">${msg}</b>
        <div style="margin-top:8px; width:100%; height:6px; background:#2a2a2e; border-radius:3px; overflow:hidden;">
            <div id="custom-progress-bar" style="width:${pct}%; height:100%;
                 background:linear-gradient(90deg,#3fca3f,#8BC34A); transition:width 0.2s;"></div>
        </div>
    `;
}

ipcRenderer.on('custom-status', (e, msg) => {
    const textEl = document.getElementById('custom-status-text');
    if (textEl) textEl.textContent = msg;
    else showCustomProgress(msg, 0);
});

ipcRenderer.on('custom-progress', (e, p) => {
    const bar = document.getElementById('custom-progress-bar');
    if (bar) bar.style.width = p + '%';
});

$('custom-create').addEventListener('click', async () => {
    if (isCreatingCustom) return;

    const name = $('custom-name').value.trim() || $('custom-name').placeholder;
    const errEl = $('custom-error');
    const fail = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };
    errEl.style.display = 'none';

    if (!name) return fail('Введи название');
    if (!/^[A-Za-z0-9 _\-\.]{1,32}$/.test(name)) return fail('Только A-Z, a-z, 0-9, пробел, _, - и точка');
    if (!customSelectedVersion) return fail('Выбери версию Minecraft');

    const loaderInput = document.querySelector('input[name="custom-loader"]:checked');
    const loader = loaderInput ? loaderInput.value : 'vanilla';
    let loaderVersion = null;

    if (loader !== 'vanilla') {
        if (!loaderVersionsAvailable) return fail('Загрузчик недоступен для этой версии Minecraft');
        loaderVersion = $('custom-loader-version').value;
        if (!loaderVersion) return fail('Выбери версию загрузчика');
    }

    const safe = name.toLowerCase().replace(/[^a-z0-9\-_]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safe) return fail('Название должно содержать буквы/цифры');
    const newId = `${customSelectedVersion}-${safe}`;

    isCreatingCustom = true;
    const createBtn = $('custom-create');
    createBtn.disabled = true;
    createBtn.textContent = 'Создание...';
    $('custom-name').disabled = true;
    $('custom-search').disabled = true;
    document.querySelectorAll('input[name="custom-loader"]').forEach((r) => (r.disabled = true));
    $('custom-loader-version').disabled = true;

    showCustomProgress('Подготовка...', 0);

    try {
        const res = await ipcRenderer.invoke('version:create-custom', {
            baseVersion: customSelectedVersion,
            newId,
            displayName: name,
            loader,
            loaderVersion,
        });

        if (!res.ok) {
            isCreatingCustom = false;
            fail(res.error || 'Ошибка');
            updatePreview();
            return;
        }

        isCreatingCustom = false;
        $('create-custom-modal').classList.remove('active');

        versionMode = 'builds';
        document.querySelectorAll('.version-mode-tab').forEach((t) => {
            t.classList.toggle('active', t.dataset.vmode === 'builds');
        });

        await loadVersions();
        for (const opt of select.options) {
            if (opt.value === res.versionId) { select.value = opt.value; break; }
        }
        updateButtons();
        $('status').innerText = `Сборка создана: ${name}`;
    } catch (e) {
        isCreatingCustom = false;
        fail(e.message);
        updatePreview();
    } finally {
        createBtn.disabled = false;
        createBtn.textContent = 'OK';
        $('custom-name').disabled = false;
        $('custom-search').disabled = false;
        document.querySelectorAll('input[name="custom-loader"]').forEach((r) => (r.disabled = false));
        $('custom-loader-version').disabled = false;
        updateCreateButtonState();
    }
});

// ============================================================
//                       МОДЛОАДЕРЫ
// ============================================================
const mlType = $('ml-type');
const mlMcVersion = $('ml-mcversion');
const mlVersion = $('ml-version');
const mlInstall = $('ml-install');
const mlHint = $('ml-hint');
const mlStatus = $('status-ml');
const mlProgressBar = $('progress-bar-ml');
const mlProgressFill = $('progress-fill-ml');

function fillMcVersions() {
    mlMcVersion.innerHTML = '';
    const seen = new Set();
    for (const v of minecraftVersions) {
        if (v.isBuild) continue;
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.id;
        mlMcVersion.appendChild(opt);
    }
    mlMcVersion.disabled = false;
}

async function refreshModloaderVersions() {
    const type = mlType.value;
    const mcVersion = mlMcVersion.value;
    if (type === 'optifine') {
        $('ml-version-row').style.display = 'none';
        mlInstall.disabled = false;
        mlInstall.textContent = 'Открыть сайт OptiFine';
        mlHint.innerHTML = 'OptiFine не имеет открытого API. Откроется сайт — скачай .jar для <b>' + mcVersion + '</b>.';
        return;
    }
    $('ml-version-row').style.display = 'flex';
    mlInstall.disabled = true;
    mlInstall.textContent = 'Загрузка...';
    mlVersion.disabled = true;
    mlVersion.innerHTML = '<option>Загрузка...</option>';
    try {
        const list = await ipcRenderer.invoke('modloader:versions', { type, mcVersion });
        if (!list.length) {
            mlVersion.innerHTML = '<option>Нет версий</option>';
            mlInstall.disabled = true;
            mlInstall.textContent = 'Нет версий';
            return;
        }
        mlVersion.innerHTML = '';
        for (const v of list) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            mlVersion.appendChild(opt);
        }
        mlVersion.disabled = false;
        mlInstall.disabled = false;
        mlInstall.textContent = 'Установить ' + (type === 'forge' ? 'Forge' : 'NeoForge');
    } catch (e) {
        mlVersion.innerHTML = '<option>Ошибка</option>';
        mlInstall.disabled = true;
    }
}
mlType.addEventListener('change', refreshModloaderVersions);
mlMcVersion.addEventListener('change', refreshModloaderVersions);

mlInstall.addEventListener('click', async () => {
    const type = mlType.value;
    const mcVersion = mlMcVersion.value;
    if (type === 'optifine') {
        await ipcRenderer.invoke('open-url', 'https://optifine.net/downloads');
        return;
    }
    const mlVer = mlVersion.value;
    if (!mlVer) return;
    mlInstall.disabled = true;
    mlStatus.innerText = 'Подготовка...';
    mlProgressBar.style.display = 'block';
    mlProgressFill.style.width = '0%';
    ipcRenderer.send('modloader:install', { type, mcVersion, mlVer });
});

ipcRenderer.on('ml-status', (e, text) => { mlStatus.innerText = text; });
ipcRenderer.on('ml-progress', (e, p) => { mlProgressFill.style.width = p + '%'; });
ipcRenderer.on('ml-complete', (e, res) => {
    mlInstall.disabled = false;
    if (res.ok) { mlStatus.innerText = 'Установлено: ' + res.versionId; loadVersions(); }
    else mlStatus.innerText = 'Ошибка: ' + res.error;
});

// ============================================================
//                  ОТМЕНА СКАЧИВАНИЯ / УСТАНОВКИ
// ============================================================
const cancelRow = $('cancel-row');
const cancelBtn = $('cancel-download-btn');
const cancelRowMl = $('cancel-row-ml');
const cancelBtnMl = $('cancel-download-btn-ml');

function showCancel(target) {
    const row = target === 'ml' ? cancelRowMl : cancelRow;
    const btn = target === 'ml' ? cancelBtnMl : cancelBtn;
    if (!row || !btn) return;
    row.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Отменить';
}

function hideCancel(target) {
    const row = target === 'ml' ? cancelRowMl : cancelRow;
    if (!row) return;
    row.style.display = 'none';
}

function handleCancelClick(target) {
    const btn = target === 'ml' ? cancelBtnMl : cancelBtn;
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Отмена...';
    ipcRenderer.send('download:cancel');
}

if (cancelBtn) cancelBtn.addEventListener('click', () => handleCancelClick('play'));
if (cancelBtnMl) cancelBtnMl.addEventListener('click', () => handleCancelClick('ml'));

ipcRenderer.on('operation-started', () => {
    showCancel('play');
});

ipcRenderer.on('operation-finished', () => {
    hideCancel('play');
    hideCancel('ml');
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = 'Отменить'; }
    if (cancelBtnMl) { cancelBtnMl.disabled = false; cancelBtnMl.textContent = 'Отменить'; }
});

// ============================================================
//                       СОБЫТИЯ ОТ MAIN
// ============================================================
ipcRenderer.on('launcher-status', (e, t) => { statusText.innerText = t; });
ipcRenderer.on('download-progress', (e, p) => { progressFill.style.width = p + '%'; });
ipcRenderer.on('install-complete', (e, id) => {
    const v = minecraftVersions.find((x) => x.id === id);
    if (v) {
        v.installed = true;
        renderVersionSelect();
    }
});

// ============================================================
//                    МОД МАГАЗИН (Modrinth)
// ============================================================
let modshopInstances = [];
let modshopCurrentTarget = null;
let modshopSelectedProject = null;
let modshopSearchTimer = null;
let modshopLastQuery = '__never__';

// ============================================================
//        ПРОСМОТР СКРИНШОТОВ МОДА
// ============================================================
let modshopScreenshotList = [];
let modshopScreenshotIndex = 0;

function openScreenshotsModal(gallery, modTitle) {
    const list = (gallery || [])
        .filter((g) => g && g.url)
        .map((g) => ({ url: g.url, title: g.title || '', featured: !!g.featured }));

    const titleEl = $('screenshots-title');
    const grid = $('screenshots-grid');
    if (!grid) return;

    if (titleEl) titleEl.textContent = `Скриншоты · ${modTitle || ''} (${list.length})`;
    grid.innerHTML = '';

    if (!list.length) {
        grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#666; padding:40px 0; font-size:13px;">У этого мода нет скриншотов</div>';
        $('screenshots-modal').classList.add('active');
        return;
    }

    const featured = list.filter((g) => g.featured);
    const regular  = list.filter((g) => !g.featured);

    // Общий список для полноразмерного просмотра: сначала избранные, потом остальные
    modshopScreenshotList = [...featured, ...regular];

    const sectionTitle = (label, count) => {
        const el = document.createElement('div');
        el.style.cssText = 'grid-column:1/-1; font-size:11px; color:#888; text-transform:uppercase; letter-spacing:1.5px; margin:6px 0 2px;';
        el.textContent = `${label} (${count})`;
        return el;
    };

    const appendCards = (items) => {
        items.forEach((g) => {
            const idx = modshopScreenshotList.indexOf(g);
            const card = document.createElement('div');
            card.style.cssText = 'position:relative; border-radius:8px; overflow:hidden; cursor:pointer; background:#232327; border:1px solid #333; transition:0.15s;';
            card.innerHTML = `
                <img src="${escapeHtml(g.url)}" alt="${escapeHtml(g.title)}"
                     style="width:100%; height:150px; object-fit:cover; display:block; background:#1a1a1e;"
                     loading="lazy">
                <div style="padding:6px 8px; font-size:11px; color:#bbb;
                            white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    ${escapeHtml(g.title || 'Скриншот ' + (idx + 1))}
                </div>
                ${g.featured ? '<div style="position:absolute; top:6px; right:6px; background:#3daa3d; color:#fff; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px;">★</div>' : ''}
            `;
            card.addEventListener('mouseenter', () => { card.style.borderColor = '#3daa3d'; });
            card.addEventListener('mouseleave', () => { card.style.borderColor = '#333'; });
            card.addEventListener('click', () => {
                openScreenshotFullsize(idx);
            });
            grid.appendChild(card);
        });
    };

    if (featured.length) {
        grid.appendChild(sectionTitle('★ Избранные', featured.length));
        appendCards(featured);
    }
    if (regular.length) {
        grid.appendChild(sectionTitle(featured.length ? 'Все скриншоты' : 'Скриншоты', regular.length));
        appendCards(regular);
    }

    $('screenshots-modal').classList.add('active');
}

function openScreenshotFullsize(index) {
    if (!modshopScreenshotList.length) return;
    if (index < 0) index = modshopScreenshotList.length - 1;
    if (index >= modshopScreenshotList.length) index = 0;
    modshopScreenshotIndex = index;

    const item = modshopScreenshotList[index];
    const img = $('screenshot-viewer-img');
    const cap = $('screenshot-viewer-caption');
    if (!img) return;
    img.src = item.url;
    if (cap) {
        const n = modshopScreenshotList.length;
        const t = item.title ? ` — ${item.title}` : '';
        cap.textContent = `${index + 1} / ${n}${t}`;
    }
    $('screenshot-viewer').classList.add('active');
}

// Кнопки в полноразмерном просмотрщике
(function bindScreenshotViewerButtons() {
    const close = $('screenshot-viewer-close');
    const prev  = $('screenshot-viewer-prev');
    const next  = $('screenshot-viewer-next');
    if (close) close.addEventListener('click', () => $('screenshot-viewer').classList.remove('active'));
    if (prev)  prev.addEventListener('click', () => openScreenshotFullsize(modshopScreenshotIndex - 1));
    if (next)  next.addEventListener('click', () => openScreenshotFullsize(modshopScreenshotIndex + 1));
})();

// Клавиатура: Esc закрывает, ←/→ листают
document.addEventListener('keydown', (e) => {
    const sv = $('screenshot-viewer');
    const sm = $('screenshots-modal');
    if (e.key === 'Escape') {
        if (sv && sv.classList.contains('active')) { sv.classList.remove('active'); return; }
        if (sm && sm.classList.contains('active')) { sm.classList.remove('active'); return; }
    }
    if (sv && sv.classList.contains('active')) {
        if (e.key === 'ArrowLeft')  openScreenshotFullsize(modshopScreenshotIndex - 1);
        if (e.key === 'ArrowRight') openScreenshotFullsize(modshopScreenshotIndex + 1);
    }
});

async function openModshop() {
    $('modshop-modal').classList.add('active');
    $('modshop-detail').classList.remove('active');
    $('modshop-detail').innerHTML = '';
    modshopSelectedProject = null;
    modshopLastQuery = '__never__';

    let list = [];
    try {
        list = await ipcRenderer.invoke('modshop:instances');
    } catch (e) {
        console.error('[modshop] instances error:', e);
    }
    modshopInstances = Array.isArray(list) ? list : [];

    const sel = $('modshop-target');
    sel.innerHTML = '';

    if (!modshopInstances.length) {
        const opt = document.createElement('option');
        opt.textContent = 'Нет установленных версий';
        sel.appendChild(opt);
        sel.disabled = true;
        const badge = $('modshop-target-badge');
        badge.textContent = '—';
        badge.className = 'badge warn';
        return;
    }

    sel.disabled = false;

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— в корневую mods (без сборки) —';
    sel.appendChild(noneOpt);

    for (const inst of modshopInstances) {
        const opt = document.createElement('option');
        opt.value = inst.id;
        const loaderLabel = inst.loader === 'vanilla'
            ? 'Vanilla'
            : inst.loader[0].toUpperCase() + inst.loader.slice(1);
        const prefix = inst.isBuild ? '⚙ ' : '📦 ';
        opt.textContent = `${prefix}${inst.id}  (${inst.mcVersion}, ${loaderLabel})`;
        sel.appendChild(opt);
    }

    const currentVersion = select.value;
    if (currentVersion && modshopInstances.some((x) => x.id === currentVersion)) {
        sel.value = currentVersion;
    } else if (modshopInstances.length) {
        sel.value = modshopInstances[0].id;
    }

    updateModshopTarget();
    setTimeout(() => $('modshop-search').focus(), 60);
    doModshopSearch();
}

function updateModshopTarget() {
    const sel = $('modshop-target');
    modshopCurrentTarget = modshopInstances.find((x) => x.id === sel.value) || null;

    const badge = $('modshop-target-badge');
    if (!modshopCurrentTarget) {
        badge.textContent = 'без фильтра';
        badge.className = 'badge warn';
        return;
    }
    const loaderLabel = modshopCurrentTarget.loader === 'vanilla'
        ? 'Vanilla'
        : modshopCurrentTarget.loader;
    badge.textContent = `${modshopCurrentTarget.mcVersion} · ${loaderLabel}`;
    badge.className = 'badge';
}

async function doModshopSearch() {
    const query = $('modshop-search').value.trim();
    const onlyCompat = $('modshop-only-compat').checked;
    const target = modshopCurrentTarget;

    const key = `${query}|${onlyCompat}|${target?.id || ''}`;
    if (key === modshopLastQuery) return;
    modshopLastQuery = key;

    const results = $('modshop-results');
    results.innerHTML = '<div class="modshop-loading">Поиск...</div>';
    $('modshop-detail').classList.remove('active');
    $('modshop-detail').innerHTML = '';

    let res;
    try {
        res = await ipcRenderer.invoke('modshop:search', {
            query,
            mcVersion: target?.mcVersion || null,
            loader: target?.loader || null,
            onlyCompat,
            limit: 30,
        });
    } catch (e) {
        results.innerHTML = `<div class="modshop-empty">Ошибка запроса: ${escapeHtml(e.message)}</div>`;
        return;
    }

    if (!res || !res.ok) {
        results.innerHTML = `<div class="modshop-empty">Ошибка: ${escapeHtml(res?.error || 'нет ответа')}</div>`;
        return;
    }
    if (!res.hits.length) {
        results.innerHTML = `<div class="modshop-empty">Ничего не найдено${query ? ' по запросу «' + escapeHtml(query) + '»' : ''}</div>`;
        return;
    }
    renderModshopResults(res.hits, target, query);
}

function renderModshopResults(hits, target, query) {
    const results = $('modshop-results');
    results.innerHTML = '';

    const header = document.createElement('div');
    header.style.cssText = 'grid-column: 1 / -1; font-size: 11px; color: #666; padding: 2px 0 4px;';
    header.textContent = query
        ? `Найдено ${hits.length} модов по запросу «${query}»`
        : `Популярные моды${target ? ' для ' + target.id : ''}`;
    results.appendChild(header);

    for (const hit of hits) {
        const card = document.createElement('div');
        card.className = 'modshop-card';
        card.dataset.projectId = hit.project_id;

        let compatClass = 'no', compatLabel = '✕', compatTitle = 'Несовместим';
        if (target && target.mcVersion) {
            const versions = hit.versions || [];
            const categories = hit.categories || [];
            const mcOk = versions.includes(target.mcVersion);
            const loaderOk = !target.loader || target.loader === 'vanilla' ||
                             categories.includes(target.loader);
            if (mcOk && loaderOk) { compatClass = 'ok'; compatLabel = '✓'; compatTitle = 'Совместим'; }
            else if (mcOk) { compatClass = 'warn'; compatLabel = '~'; compatTitle = 'MC совпадает, загрузчик — нет'; }
            else { compatTitle = 'Нет версии под ' + target.mcVersion; }
        } else {
            compatClass = 'warn'; compatLabel = '?'; compatTitle = 'Выбери сборку для проверки';
        }

        const icon = hit.icon_url || '';
        const dl = (hit.downloads || 0).toLocaleString('ru');
        const desc = hit.description || '';

        card.innerHTML = `
            <span class="compat ${compatClass}" title="${escapeHtml(compatTitle)}">${compatLabel}</span>
            <div class="icon" style="background-image:url('${icon}')"></div>
            <div class="meta">
                <h4>${escapeHtml(hit.title)}</h4>
                <p>${escapeHtml(desc)}</p>
                <div class="dl">⬇ ${dl}</div>
            </div>
        `;
        card.addEventListener('click', () => selectModshopMod(hit, card));
        results.appendChild(card);
    }
}

// ============================================================
//        ПОДРОБНАЯ КАРТОЧКА МОДА
// ============================================================
async function selectModshopMod(hit, cardEl) {
    document.querySelectorAll('.modshop-card').forEach((c) => c.classList.remove('selected'));
    cardEl.classList.add('selected');
    modshopSelectedProject = hit;

    const target = modshopCurrentTarget;
    const detail = $('modshop-detail');
    detail.classList.add('active');
    detail.innerHTML = '<div class="modshop-loading">Загрузка информации о моде...</div>';

    let projectRes = { ok: false };
    let versionsRes = { ok: false };
    try {
        [projectRes, versionsRes] = await Promise.all([
            ipcRenderer.invoke('modshop:project', { projectId: hit.project_id }),
            ipcRenderer.invoke('modshop:versions', {
                projectId: hit.project_id,
                mcVersion: target?.mcVersion || null,
                loader: target?.loader || null,
            }),
        ]);
    } catch (e) {
        detail.innerHTML = `<div style="color:#ff7777;">Ошибка запроса: ${escapeHtml(e.message)}</div>`;
        return;
    }

    const project = projectRes?.ok ? projectRes.project : null;
    const versions = versionsRes?.ok ? (versionsRes.versions || []) : [];

    const title = project?.title || hit.title || '';
    const desc = project?.description || hit.description || '';
    const icon = project?.icon_url || hit.icon_url || '';
    const dl = (project?.downloads ?? hit.downloads ?? 0).toLocaleString('ru');
    const followers = (project?.followers ?? 0).toLocaleString('ru');
    const categories = (project?.categories || hit.categories || []);
    const loaders = (project?.loaders || []);
    const gameVersions = (project?.game_versions || []);
    const license = project?.license || null;
    const sourceUrl = project?.source_url || '';
    const issuesUrl = project?.issues_url || '';
    const wikiUrl = project?.wiki_url || '';
    const discordUrl = project?.discord_url || '';
    const projectUrl = `https://modrinth.com/mod/${project?.slug || hit.slug}`;

    let html = `
        <div style="display:flex; gap:14px; margin-bottom:12px;">
            <div style="width:64px; height:64px; border-radius:10px; flex-shrink:0;
                        background:#333 url('${icon}') center/cover; image-rendering:pixelated;"></div>
            <div style="flex:1; min-width:0;">
                <h3 style="margin:0 0 4px;">${escapeHtml(title)}</h3>
                <div style="font-size:12px; color:#aaa; line-height:1.5;">
                    ${escapeHtml(desc)}
                </div>
                <div style="font-size:11px; color:#666; margin-top:6px;">
                    ⬇ ${dl} загрузок · ★ ${followers} подписчиков
                    ${license ? ` · 📜 ${escapeHtml(license.name || license.id || '')}` : ''}
                </div>
            </div>
        </div>
    `;

    if (categories.length || loaders.length) {
        html += `<div style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px;">`;
        for (const l of loaders) {
            html += `<span style="padding:2px 8px; background:#2a3a2a; color:#7dff7d;
                        border-radius:4px; font-size:10px; font-weight:700; text-transform:uppercase;">${escapeHtml(l)}</span>`;
        }
        for (const c of categories.slice(0, 8)) {
            html += `<span style="padding:2px 8px; background:#2a2a2e; color:#bbb;
                        border-radius:4px; font-size:10px;">${escapeHtml(c)}</span>`;
        }
        html += `</div>`;
    }

    const links = [];
    if (sourceUrl) links.push(`<a href="${escapeHtml(sourceUrl)}" target="_blank" class="mlink">Исходники</a>`);
    if (issuesUrl) links.push(`<a href="${escapeHtml(issuesUrl)}" target="_blank" class="mlink">Issues</a>`);
    if (wikiUrl) links.push(`<a href="${escapeHtml(wikiUrl)}" target="_blank" class="mlink">Wiki</a>`);
    if (discordUrl) links.push(`<a href="${escapeHtml(discordUrl)}" target="_blank" class="mlink">Discord</a>`);
    links.push(`<a href="${escapeHtml(projectUrl)}" target="_blank" class="mlink">Modrinth</a>`);
    html += `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; font-size:12px;">
                ${links.join('')}
            </div>`;

    // Галерея — кнопка «Скриншоты» + превью
    const gallery = (project?.gallery || []).filter((g) => g && g.url);
    if (gallery.length) {
        html += `
            <div style="margin-bottom:12px; padding:10px 12px; background:#232327;
                        border:1px solid #333; border-radius:8px;
                        display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <button id="modshop-open-screenshots" class="btn-secondary"
                        style="width:auto; padding:8px 16px; flex-shrink:0;">
                    📷 Скриншоты (${gallery.length})
                </button>
                <div style="display:flex; gap:6px; flex:1; min-width:0; overflow:hidden;">
        `;
        for (const g of gallery.slice(0, 4)) {
            html += `<img src="${escapeHtml(g.url)}"
                         style="height:44px; width:70px; object-fit:cover; border-radius:4px;
                                flex-shrink:0; background:#1a1a1e;">`;
        }
        html += `</div></div>`;
    }

    if (gameVersions.length) {
        const shown = gameVersions.slice(0, 12).map((g) => `<span style="padding:1px 6px;
            background:#232327; color:#aaa; border-radius:3px; font-size:10px;">${escapeHtml(g)}</span>`).join(' ');
        const more = gameVersions.length > 12 ? ` <span style="color:#666; font-size:10px;">+${gameVersions.length - 12}</span>` : '';
        html += `<div style="font-size:11px; color:#888; margin-bottom:6px;">Minecraft: ${shown}${more}</div>`;
    }

    const body = project?.body || '';
    if (body) {
        const shownBody = body.length > 2500 ? body.slice(0, 2500) + '\n\n…' : body;
        html += `
            <div style="margin-top:10px; border-top:1px solid #2e2e33; padding-top:10px;">
                <div id="modshop-body-toggle"
                     style="font-size:11px; color:#4daaff; cursor:pointer; margin-bottom:6px; user-select:none;">
                    ▸ Подробное описание
                </div>
                <div id="modshop-body" style="display:none; font-size:12px; color:#bbb;
                            line-height:1.6; max-height:280px; overflow-y:auto;
                            background:#151517; border-radius:6px; padding:10px;">
                    ${renderMarkdown(shownBody)}
                </div>
            </div>
        `;
    }

    if (!versions.length) {
        const mc = target?.mcVersion || '?';
        const ld = target?.loader && target.loader !== 'vanilla' ? target.loader : 'Vanilla';
        html += `
            <div style="color:#ff9999; font-size:12px; margin-top:12px;">
                ⚠ Нет файлов для ${escapeHtml(mc)} (${escapeHtml(ld)})
            </div>
        `;
    } else {
        html += `
            <div class="versions-row" style="margin-top:14px;">
                <span style="font-size:12px; color:#aaa;">Версия:</span>
                <select id="modshop-version-select">
        `;
        for (let i = 0; i < versions.length; i++) {
            const v = versions[i];
            const star = i === 0 ? ' ⭐' : '';
            const loaderTag = (v.loaders || []).join(', ');
            const mcTag = (v.game_versions || []).slice(0, 3).join(', ');
            const sizeMb = v.files?.[0]?.size
                ? ' · ' + (v.files[0].size / 1024 / 1024).toFixed(2) + ' МБ'
                : '';
            html += `<option value="${i}">${escapeHtml(v.version_number)} · ${escapeHtml(loaderTag)} · ${escapeHtml(mcTag)}${sizeMb}${star}</option>`;
        }
        html += `
                </select>
                <button class="btn-primary btn-install" id="modshop-install">Установить</button>
            </div>
            <div class="loader-line">
                Файл будет скопирован в <b>mods</b> выбранной сборки.
                Не забудь про <b>зависимости</b> (например, Fabric API).
            </div>
        `;
    }

    detail.innerHTML = html;

    // Стиль ссылок
    detail.querySelectorAll('.mlink').forEach((a) => {
        if (a.tagName === 'A') {
            a.style.color = '#4daaff';
            a.style.textDecoration = 'none';
            a.addEventListener('mouseenter', () => a.style.textDecoration = 'underline');
            a.addEventListener('mouseleave', () => a.style.textDecoration = 'none');
        }
    });

    // Кнопка «Скриншоты»
    const screenshotsBtn = $('modshop-open-screenshots');
    if (screenshotsBtn && gallery.length) {
        screenshotsBtn.addEventListener('click', () => {
            openScreenshotsModal(gallery, title);
        });
    }

    // Раскрытие описания
    const toggle = $('modshop-body-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const bodyEl = $('modshop-body');
            const open = bodyEl.style.display === 'block';
            bodyEl.style.display = open ? 'none' : 'block';
            toggle.textContent = open ? '▸ Подробное описание' : '▾ Подробное описание';
        });
    }

    if (!versions.length) return;

    $('modshop-install').addEventListener('click', async () => {
        const idx = parseInt($('modshop-version-select').value, 10);
        const ver = versions[idx];
        if (!ver) return;

        const primary = (ver.files || []).find((f) => f.primary) || ver.files?.[0];
        if (!primary) { alert('У мода нет файлов'); return; }

        const btn = $('modshop-install');
        btn.disabled = true;
        btn.textContent = 'Скачивание...';

        let installRes;
        try {
            installRes = await ipcRenderer.invoke('modshop:install', {
                versionId: target?.id || '',
                downloadUrl: primary.url,
                fileName: primary.filename,
            });
        } catch (e) {
            installRes = { ok: false, error: e.message };
        }

        btn.disabled = false;
        if (installRes && installRes.ok) {
            btn.textContent = '✓ Установлено';
            $('status').innerText = `Мод установлен: ${title}`;
            setTimeout(() => { btn.textContent = 'Установить'; }, 2000);
        } else {
            btn.textContent = 'Установить';
            alert('Ошибка установки: ' + (installRes?.error || 'нет ответа'));
        }
    });
}

$('modshop-btn').addEventListener('click', openModshop);

$('modshop-search-btn').addEventListener('click', () => {
    modshopLastQuery = '__never__';
    doModshopSearch();
});

$('modshop-search').addEventListener('input', () => {
    if (modshopSearchTimer) clearTimeout(modshopSearchTimer);
    modshopSearchTimer = setTimeout(() => {
        modshopLastQuery = '__never__';
        doModshopSearch();
    }, 400);
});

$('modshop-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (modshopSearchTimer) clearTimeout(modshopSearchTimer);
        modshopLastQuery = '__never__';
        doModshopSearch();
    }
});

$('modshop-target').addEventListener('change', () => {
    updateModshopTarget();
    modshopLastQuery = '__never__';
    doModshopSearch();
});

$('modshop-only-compat').addEventListener('change', () => {
    modshopLastQuery = '__never__';
    doModshopSearch();
});

// ============================================================
//        ВЫБОР СКИНА И ПЛАЩА
// ============================================================
let skinPickerViewer = null;

const SKIN_PICKER_DEFAULTS = [
    { name: 'Steve',  label: 'Steve' },
    { name: 'Alex',   label: 'Alex' },
    { name: 'Ari',    label: 'Ari' },
    { name: 'Efe',    label: 'Efe' },
    { name: 'Kai',    label: 'Kai' },
    { name: 'Makena', label: 'Makena' },
    { name: 'Noor',   label: 'Noor' },
    { name: 'Sunny',  label: 'Sunny' },
    { name: 'Zuri',   label: 'Zuri' },
];

const SKIN_PICKER_MINECON = [
    { name: 'MHF_Steve',     label: 'Steve Classic' },
    { name: 'MHF_Alex',      label: 'Alex Classic' },
    { name: 'MHF_Herobrine', label: 'Herobrine' },
    { name: 'Dinnerbone',    label: 'Dinnerbone' },
    { name: 'jeb_',          label: 'jeb_' },
    { name: 'Grumm',         label: 'Grumm' },
    { name: 'Notch',         label: 'Notch' },
    { name: 'Deadmau5',      label: 'deadmau5' },
];

function makeSkinCard(id, label, previewUrl, isActive, deletable) {
    const card = document.createElement('div');
    card.className = 'skin-picker-card' + (isActive ? ' active' : '');
    card.style.cssText =
        'position:relative; aspect-ratio:5/6; background:#232327;' +
        'border:2px solid ' + (isActive ? '#3daa3d' : '#333') + '; border-radius:10px;' +
        'overflow:hidden; cursor:pointer; transition:0.15s; display:flex; flex-direction:column;';
    card.innerHTML =
        '<div class="preview" style="flex:1; min-height:0; background:#1c1c20 center/contain no-repeat;"></div>' +
        '<div style="padding:6px 8px; font-size:11px; color:#bbb; text-align:center;' +
        'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' +
        'background:rgba(0,0,0,0.35);">' + escapeHtml(label) + '</div>' +
        '<div class="check" style="position:absolute; top:8px; right:8px; width:22px; height:22px;' +
        'border-radius:50%; background:#3daa3d; color:#fff; font-size:13px;' +
        'display:' + (isActive ? 'flex' : 'none') + '; align-items:center; justify-content:center;' +
        'font-weight:700; box-shadow:0 2px 6px rgba(0,0,0,0.4);">✓</div>' +
        (deletable ? '<button class="del" style="position:absolute; top:8px; left:8px;' +
            'width:22px; height:22px; border-radius:50%; background:rgba(0,0,0,0.55);' +
            'color:#ff8888; font-size:14px; font-weight:700; border:none; cursor:pointer;' +
            'display:none; align-items:center; justify-content:center; padding:0;">✕</button>' : '');

    card.querySelector('.preview').style.backgroundImage = "url('" + previewUrl + "')";

    card.addEventListener('mouseenter', () => {
        card.style.borderColor = '#3daa3d';
        const d = card.querySelector('.del');
        if (d) d.style.display = 'flex';
    });
    card.addEventListener('mouseleave', () => {
        card.style.borderColor = card.classList.contains('active') ? '#3daa3d' : '#333';
        const d = card.querySelector('.del');
        if (d) d.style.display = 'none';
    });
    return card;
}

function skinPreviewUrl(name) {
    try {
        const local = path.join(SKINS_DIR, name + '.png');
        if (fs.existsSync(local)) {
            return 'data:image/png;base64,' + fs.readFileSync(local).toString('base64');
        }
    } catch (_) {}
    return 'https://mc-heads.net/body/' + encodeURIComponent(name) + '/240';
}

function capePreviewUrl(name) {
    try {
        const p = path.join(MINECRAFT_DIR, 'capes', name + '.png');
        if (fs.existsSync(p)) {
            return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
        }
    } catch (_) {}
    return '';
}

async function openSkinPicker() {
    if (!activeAccount) { alert('Сначала добавь аккаунт'); return; }
    const nick = activeAccount.name;
    const modal = $('skins-modal');
    if (!modal) return;

    $('skin-picker-nick').textContent = nick;

    // 3D-превью
    const canvas = $('skin-picker-canvas');
    setTimeout(() => {
        try {
            if (skinPickerViewer && skinPickerViewer.dispose) {
                try { skinPickerViewer.dispose(); } catch (_) {}
            }
            skinPickerViewer = new skinview3d.SkinViewer({
                canvas,
                width: canvas.clientWidth || 300,
                height: canvas.clientHeight || 380,
                zoom: 0.85,
            });
            skinPickerViewer.animation = null;
            skinPickerViewer.renderer.setClearColor(0x000000, 0);

            const localSkin = path.join(SKINS_DIR, nick + '.png');
            if (fs.existsSync(localSkin)) {
                skinPickerViewer.loadSkin(
                    'data:image/png;base64,' + fs.readFileSync(localSkin).toString('base64'),
                    { model: 'auto-detect' });
            } else {
                skinPickerViewer.loadSkin(
                    'https://mc-heads.net/skin/' + encodeURIComponent(nick),
                    { model: 'auto-detect' });
            }

            const localCape = path.join(MINECRAFT_DIR, 'capes', nick + '.png');
            if (fs.existsSync(localCape)) {
                skinPickerViewer.loadCape(
                    'data:image/png;base64,' + fs.readFileSync(localCape).toString('base64'));
            } else {
                skinPickerViewer.loadCape(null);
            }
        } catch (e) {
            console.warn('[skinpicker] viewer init failed:', e);
        }
    }, 60);

    // ---- Сохранённые скины ----
    const savedBox = $('skin-picker-saved');
    savedBox.innerHTML = '';
    let saved = [];
    try { saved = await ipcRenderer.invoke('skin:list-saved'); } catch (_) {}
    if (!Array.isArray(saved)) saved = [];

    const activeIsSaved = saved.some((s) => s.name === nick);

    if (!saved.length) {
        savedBox.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#666;' +
            'padding:20px 0; font-size:12px;">Пока ничего не сохранено — жми «Изменить»</div>';
    }

    saved.forEach((s) => {
        const card = makeSkinCard(s.name, s.name, skinPreviewUrl(s.name),
            activeIsSaved && s.name === nick, s.name !== nick);
        card.addEventListener('click', async (e) => {
            if (e.target.classList.contains('del')) return;
            await ipcRenderer.invoke('skin:apply-by-name', { name: s.name, nickname: nick });
            if (skinViewer) loadSkinForAccount();
            openSkinPicker();
            $('status').innerText = 'Скин: ' + s.name;
        });
        const del = card.querySelector('.del');
        if (del) del.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await ipcRenderer.invoke('ui:confirm', {
                title: 'Удалить скин',
                message: 'Удалить сохранённый скин «' + s.name + '»?',
                okLabel: 'Удалить',
            });
            if (!ok) return;
            await ipcRenderer.invoke('skin:delete-saved', s.name);
            openSkinPicker();
        });
        savedBox.appendChild(card);
    });

    // ---- Стандартные скины ----
    const defBox = $('skin-picker-defaults');
    defBox.innerHTML = '';
    SKIN_PICKER_DEFAULTS.forEach((d) => {
        const isActive = !activeIsSaved && d.name === nick;
        const card = makeSkinCard(d.name, d.label, skinPreviewUrl(d.name), isActive, false);
        card.addEventListener('click', async () => {
            const res = await ipcRenderer.invoke('skin:download-and-apply',
                { name: d.name, nickname: nick });
            if (!res?.ok) {
                await ipcRenderer.invoke('skin:apply-by-name',
                    { name: d.name, nickname: nick });
            }
            if (skinViewer) loadSkinForAccount();
            openSkinPicker();
            $('status').innerText = 'Скин: ' + d.label;
        });
        defBox.appendChild(card);
    });

    // ---- MINECON ----
    const minBox = $('skin-picker-minecon');
    minBox.innerHTML = '';
    SKIN_PICKER_MINECON.forEach((d) => {
        const card = makeSkinCard(d.name, d.label, skinPreviewUrl(d.name), false, false);
        card.addEventListener('click', async () => {
            const res = await ipcRenderer.invoke('skin:download-and-apply',
                { name: d.name, nickname: nick });
            if (!res?.ok) {
                await ipcRenderer.invoke('skin:apply-by-name',
                    { name: d.name, nickname: nick });
            }
            if (skinViewer) loadSkinForAccount();
            openSkinPicker();
            $('status').innerText = 'Скин: ' + d.label;
        });
        minBox.appendChild(card);
    });

    // ---- ПЛАЩИ ----
    const isLicensed = activeAccount.type === 'licensed';
    const capesSection = $('capes-section');
    const capesGrid = $('capes-grid');
    const capesWarn = $('capes-warning');

    if (isLicensed) {
        capesSection.style.display = 'block';
        capesWarn.style.display = 'none';

        let capes = [];
        try { capes = await ipcRenderer.invoke('cape:list-saved'); } catch (_) {}
        if (!Array.isArray(capes)) capes = [];

        const hasActiveCape = capes.some((c) => c.name === nick);
        capesGrid.innerHTML = '';

        // Кнопка «Загрузить плащ»
        const uploadCard = document.createElement('div');
        uploadCard.style.cssText =
            'aspect-ratio:5/6; border:2px dashed #3a3a3e; border-radius:10px;' +
            'display:flex; flex-direction:column; align-items:center; justify-content:center;' +
            'gap:8px; cursor:pointer; color:#888; transition:0.15s;';
        uploadCard.innerHTML =
            '<div style="font-size:34px; line-height:1;">+</div>' +
            '<div style="font-size:12px; font-weight:700;">Добавить плащ</div>' +
            '<div style="font-size:10px; color:#666;">PNG 64×32 или 22×17</div>';
        uploadCard.addEventListener('mouseenter', () => uploadCard.style.borderColor = '#3daa3d');
        uploadCard.addEventListener('mouseleave', () => uploadCard.style.borderColor = '#3a3a3e');
        uploadCard.addEventListener('click', async () => {
            const res = await ipcRenderer.invoke('cape:upload', nick);
            if (res?.ok) {
                openSkinPicker();
                $('status').innerText = 'Плащ загружен';
            }
        });
        capesGrid.appendChild(uploadCard);

        // Существующие плащи
        for (const c of capes) {
            const preview = capePreviewUrl(c.name);
            const card = document.createElement('div');
            card.style.cssText =
                'position:relative; aspect-ratio:5/6; background:#1c1c20;' +
                'border:2px solid ' + (c.name === nick ? '#3daa3d' : '#333') + ';' +
                'border-radius:10px; overflow:hidden; cursor:pointer; transition:0.15s;' +
                'display:flex; flex-direction:column;';
            card.innerHTML =
                '<div style="flex:1; background:center/contain no-repeat; ' +
                'background-image:url(\'' + preview + '\');"></div>' +
                '<div style="padding:6px 8px; font-size:11px; color:#bbb; text-align:center;' +
                'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;' +
                'background:rgba(0,0,0,0.35);">' + escapeHtml(c.name) + '</div>' +
                (c.name === nick ?
                    '<div style="position:absolute; top:8px; right:8px; width:22px; height:22px;' +
                    'border-radius:50%; background:#3daa3d; color:#fff; font-size:13px;' +
                    'display:flex; align-items:center; justify-content:center; font-weight:700;">✓</div>'
                    : '') +
                (c.name !== nick ?
                    '<button class="delcape" style="position:absolute; top:8px; left:8px;' +
                    'width:22px; height:22px; border-radius:50%; background:rgba(0,0,0,0.55);' +
                    'color:#ff8888; font-size:14px; font-weight:700; border:none; cursor:pointer;' +
                    'display:none; align-items:center; justify-content:center; padding:0;">✕</button>'
                    : '');

            card.addEventListener('mouseenter', () => {
                card.style.borderColor = '#3daa3d';
                const d = card.querySelector('.delcape');
                if (d) d.style.display = 'flex';
            });
            card.addEventListener('mouseleave', () => {
                card.style.borderColor = card.querySelector('div[style*="3daa3d"]') ? '#3daa3d' : '#333';
                const d = card.querySelector('.delcape');
                if (d) d.style.display = 'none';
            });

            card.addEventListener('click', async (e) => {
                if (e.target.classList.contains('delcape')) return;
                await ipcRenderer.invoke('cape:apply-by-name', { name: c.name, nickname: nick });
                openSkinPicker();
                $('status').innerText = 'Плащ: ' + c.name;
            });
            const del = card.querySelector('.delcape');
            if (del) del.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ok = await ipcRenderer.invoke('ui:confirm', {
                    title: 'Удалить плащ',
                    message: 'Удалить сохранённый плащ «' + c.name + '»?',
                    okLabel: 'Удалить',
                });
                if (!ok) return;
                await ipcRenderer.invoke('cape:delete-saved', c.name);
                openSkinPicker();
            });
            capesGrid.appendChild(card);
        }

        // Кнопка «Убрать активный плащ»
        if (hasActiveCape) {
            const removeCard = document.createElement('div');
            removeCard.style.cssText =
                'aspect-ratio:5/6; border:2px dashed #5a2a2a; border-radius:10px;' +
                'display:flex; flex-direction:column; align-items:center; justify-content:center;' +
                'gap:8px; cursor:pointer; color:#ff8888; transition:0.15s;';
            removeCard.innerHTML =
                '<div style="font-size:34px; line-height:1;">✕</div>' +
                '<div style="font-size:12px; font-weight:700;">Убрать плащ</div>';
            removeCard.addEventListener('mouseenter', () => removeCard.style.borderColor = '#ff6666');
            removeCard.addEventListener('mouseleave', () => removeCard.style.borderColor = '#5a2a2a');
            removeCard.addEventListener('click', async () => {
                await ipcRenderer.invoke('cape:clear', nick);
                openSkinPicker();
                $('status').innerText = 'Плащ убран';
            });
            capesGrid.appendChild(removeCard);
        }
    } else {
        capesSection.style.display = 'block';
        capesWarn.style.display = 'block';
        capesWarn.textContent = 'Плащи доступны только для лицензионных аккаунтов Microsoft. ' +
            'Смени аккаунт во вкладке «Играть» → «Аккаунты» → «Войти в Microsoft».';
        capesGrid.innerHTML = '';
    }

    modal.classList.add('active');
}

// Кнопка «Изменить» в галерее
document.addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'skin-picker-change') {
        if (!activeAccount) return;
        const res = await ipcRenderer.invoke('skin:upload', activeAccount.name);
        if (res?.ok) {
            openSkinPicker();
            if (skinViewer) loadSkinForAccount();
            $('status').innerText = 'Скин обновлён';
        }
    }
    if (e.target && e.target.id === 'open-skin-picker') {
        openSkinPicker();
    }
});

// ============================================================
//                       СТАРТ
// ============================================================
(async () => {
    detectSystemRam();
    await loadSettings();
    await loadAccounts();
    await loadVersions();
    fillMcVersions();
    refreshModloaderVersions();
})();
