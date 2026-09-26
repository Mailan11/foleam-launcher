'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { makeMinecraftClient: defaultMinecraftClient, skinErrorMessage } = require('./minecraft-skin-client');
const DEFAULTS = ['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri'];
function installWardrobe({ ipcMain, nativeImage, dialog, window, root, gameRoot, accountsFile, readAccounts = () => JSON.parse(fs.readFileSync(accountsFile, 'utf8')), applyLocal, instanceInfo, makeMinecraftClient = defaultMinecraftClient, refreshMinecraftAccount = async a => a }) {
    const dir = path.join(gameRoot, 'wardrobe'), manifest = path.join(dir, 'library.json');
    function read() { return fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : { items: [], selected: {} }; }
    function write(data) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(manifest + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(manifest + '.tmp', manifest);
    }
    function account(key) {
        const accounts = readAccounts();
        const a = accounts.find(a => (a.type === 'mailan' ? `mailan:${a.mailanId}` : `${a.type}:${a.name}`) === key);
        if (!a || !/^[A-Za-z0-9_]{1,16}$/.test(a.name)) throw new Error('Выберите игровой аккаунт с корректным ником.');
        return a;
    }
    function validate(buffer, cape = false) {
        if (!Buffer.isBuffer(buffer) || buffer.length > 2 * 1024 * 1024 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Нужен PNG размером до 2 МБ.');
        const image = nativeImage.createFromBuffer(buffer), { width, height } = image.getSize();
        if (image.isEmpty() || !(cape ? width === 64 && height === 32 : width === 64 && [32,64].includes(height))) throw new Error(cape ? 'Плащ должен быть PNG 64×32.' : 'Скин должен быть PNG 64×64 или 64×32.');
        return image.toPNG();
    }
    function source(item, model) {
        if (item.id.startsWith('default-')) return path.join(root, 'assets/default-skins', `${item.id.slice(8)}-${model === 'slim' ? 'slim' : 'wide'}.png`);
        if (!/^[a-f0-9-]{36}$/.test(item.id)) throw new Error('Некорректный скин.');
        return path.join(dir, `${item.id}.png`);
    }
    const standard = () => DEFAULTS.map(name => ({ id: `default-${name}`, name: name[0].toUpperCase() + name.slice(1), model: name === 'alex' ? 'slim' : 'default', standard: true, cape: false }));
    function find(data, id) { const item = [...data.items, ...standard()].find(i => i.id === id); if (!item) throw new Error('Скин не найден.'); return item; }
    function view(item) {
        const data = { ...item, texture: `data:image/png;base64,${fs.readFileSync(source(item, item.model)).toString('base64')}` };
        if (item.standard) data.variants = Object.fromEntries(['default', 'slim'].map(model => [model, `data:image/png;base64,${fs.readFileSync(source(item, model)).toString('base64')}`]));
        if (item.cape) data.capeTexture = `data:image/png;base64,${fs.readFileSync(path.join(dir, item.id + '-cape.png')).toString('base64')}`;
        return data;
    }
    const guard = handler => async (event, value) => {
        if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame) return { ok: false, error: 'Недопустимое окно.' };
        try { return { ok: true, ...await handler(value || {}) }; } catch (e) { return { ok: false, error: e.message }; }
    };
    ipcMain.handle('wardrobe:list', guard(({ key }) => {
        const a = account(key), data = read();
        const legacy = path.join(gameRoot, 'skins', a.name + '.png');
        if (!data.selected[key] && fs.existsSync(legacy)) {
            const buffer = validate(fs.readFileSync(legacy));
            const id = randomUUID(); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id + '.png'), buffer);
            const legacyCape = path.join(gameRoot, 'capes', a.name + '.png');
            const hasCape = fs.existsSync(legacyCape);
            if (hasCape) fs.writeFileSync(path.join(dir, id + '-cape.png'), validate(fs.readFileSync(legacyCape), true));
            data.items.push({ id, name: a.name, model: 'default', cape: hasCape }); data.selected[key] = id; write(data);
        }
        return { items: data.items.map(view), defaults: standard().map(view), selected: data.selected[key] || 'default-steve', licensed: a.type === 'licensed' };
    }));
    ipcMain.handle('wardrobe:import', guard(async ({ key, bytes, name }) => {
        account(key); const data = read();
        if (data.items.length >= 100) throw new Error('В библиотеке уже 100 скинов.');
        let buffer;
        if (bytes) buffer = Buffer.from(bytes);
        else {
            const result = await dialog.showOpenDialog(window(), { title: 'Добавить скин', filters: [{ name: 'PNG', extensions: ['png'] }], properties: ['openFile'] });
            if (result.canceled) return { canceled: true };
            const file = result.filePaths[0]; if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Файл больше 2 МБ.');
            buffer = fs.readFileSync(file); name = path.basename(file, '.png');
        }
        buffer = validate(buffer); const id = randomUUID();
        const item = { id, name: String(name || 'Мой скин').slice(0, 64), model: 'default', cape: false };
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id + '.png'), buffer);
        data.items.push(item); write(data); return { item: view(item) };
    }));
    ipcMain.handle('wardrobe:save', guard(({ key, id, model, cape, texture, name }) => {
        account(key); const data = read(), original = find(data, id);
        if (!['default','slim'].includes(model)) throw new Error('Неверная модель рук.');
        const skin = validate(texture ? Buffer.from(texture) : fs.readFileSync(source(original, model)));
        const capeBuffer = cape === null ? null : cape ? validate(Buffer.from(cape), true) : original.cape ? fs.readFileSync(path.join(dir, original.id + '-cape.png')) : null;
        // Editing creates a copy; Cancel never mutates an existing saved texture.
        if (data.items.length >= 100) throw new Error('В библиотеке уже 100 скинов.');
        const saved = { id: randomUUID(), name: String(name || original.name).trim().slice(0,64) || 'Мой скин', model, cape: !!capeBuffer };
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, saved.id + '.png'), skin);
        if (capeBuffer) fs.writeFileSync(path.join(dir, saved.id + '-cape.png'), capeBuffer);
        data.items.push(saved); write(data); return { item: view(saved) };
    }));
    ipcMain.handle('wardrobe:select', guard(({ key, id }) => {
        const a = account(key), data = read(), item = find(data, id);
        const texture = validate(fs.readFileSync(source(item, item.model)));
        const skins = path.join(gameRoot, 'skins'); fs.mkdirSync(skins, { recursive: true });
        fs.writeFileSync(path.join(skins, a.name + '.png'), texture);
        const capes = path.join(gameRoot, 'capes'); fs.mkdirSync(capes, { recursive: true });
        const capePath = path.join(capes, a.name + '.png');
        if (item.cape) fs.copyFileSync(path.join(dir, item.id + '-cape.png'), capePath);
        else if (fs.existsSync(capePath)) fs.unlinkSync(capePath);
        data.selected[key] = id; write(data); return { item: view(item) };
    }));
    ipcMain.handle('wardrobe:delete', guard(async ({ key, id }) => {
        account(key); const data = read(); const item = find(data, id);
        if (item.standard) throw new Error('Стандартный скин нельзя удалить.');
        if (Object.values(data.selected).includes(id)) throw new Error('Этот скин выбран для аккаунта. Сначала выберите другой.');
        const result = await dialog.showMessageBox(window(), { type: 'question', message: `Удалить скин «${item.name}» из библиотеки?`, buttons: ['Отмена', 'Удалить'], defaultId: 0, cancelId: 0 });
        if (result.response !== 1) return { canceled: true };
        data.items = data.items.filter(i => i.id !== id); write(data);
        for (const suffix of ['.png', '-cape.png']) { const file = path.join(dir, id + suffix); if (fs.existsSync(file)) fs.unlinkSync(file); }
        return {};
    }));
    ipcMain.handle('wardrobe:apply', guard(async ({ key, id, versionId }) => {
        const a = account(key), data = read(), item = find(data, id);
        if (data.selected[key] !== id) throw new Error('Сначала выберите этот скин.');
        if (a.type === 'licensed') {
            let fresh;
            try { fresh = await refreshMinecraftAccount(a); }
            catch (_) { throw new Error('Не удалось обновить сессию Minecraft. Проверьте сеть или войдите в Microsoft заново.'); }
            if (!fresh.accessToken) throw new Error('Войдите в Microsoft заново.');
            const upload = token => makeMinecraftClient().setSkin('skin.png', fs.readFileSync(source(item, item.model)), item.model === 'slim' ? 'slim' : 'classic', token, AbortSignal.timeout(20000));
            try { await upload(fresh.accessToken); }
            catch (error) {
                if (error.status !== 401) throw new Error(skinErrorMessage(error));
                try { fresh = await refreshMinecraftAccount(fresh, true); }
                catch (_) { throw new Error('Сессия Minecraft истекла. Войдите в Microsoft заново.'); }
                try { await upload(fresh.accessToken); }
                catch (retryError) { throw new Error(skinErrorMessage(retryError)); }
            }
            return { message: item.cape ? 'Скин отправлен в Minecraft. Загруженный плащ остаётся локальным: Microsoft принимает только плащи, принадлежащие аккаунту.' : 'Скин обновлён в аккаунте Minecraft.' };
        }
        if (typeof versionId !== 'string' || !/^[A-Za-z0-9._ -]{1,150}$/.test(versionId) || versionId.includes('..')) throw new Error('Выберите установленную сборку.');
        if (instanceInfo(versionId).loader === 'vanilla') throw new Error('Для локального скина и плаща нужна сборка с Fabric, Forge или NeoForge. Ресурспак не заменяет персональный скин надёжно.');
        const result = await applyLocal(versionId, a.name);
        if (!result.ok) throw new Error(result.error);
        return { message: 'Скин и локальный плащ установлены в сборку. Перезапустите игру. Другим игрокам они не передаются.' };
    }));
    return { validate };
}
module.exports = { installWardrobe };
