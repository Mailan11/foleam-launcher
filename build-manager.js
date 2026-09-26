'use strict';
const fs = require('node:fs');
const path = require('node:path');
function createBuildManager({ root, isBuild, info, ipcMain, window, dialog, shell, busy = () => false }) {
    const folders = ['mods', 'config', 'saves', 'resourcepacks', 'shaderpacks', 'screenshots', 'logs'];
    function safe(base, ...parts) {
        const target = path.resolve(base, ...parts);
        if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Недопустимый путь.');
        let current = target;
        while (current !== base) {
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Ссылки на внешние папки не поддерживаются.');
            current = path.dirname(current);
        }
        return target;
    }
    root = path.resolve(root);
    function ensure(id) {
        if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:]/.test(id)) throw new Error('Некорректная сборка.');
        safe(root, 'versions', id, id + '.json');
        if (!isBuild(id)) throw new Error('Выберите установленную сборку.');
        const dir = safe(root, 'instances', id);
        for (const folder of folders) fs.mkdirSync(safe(root, 'instances', id, folder), { recursive: true });
        return dir;
    }
    function list(dir) { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.isSymbolicLink()); }
    function meta(dir) { try { return JSON.parse(fs.readFileSync(safe(root, path.relative(root, dir), '.foleam-build.json'), 'utf8')); } catch (_) { return {}; } }
    function snapshot(id) {
        const dir = ensure(id), settings = meta(dir);
        return { id, ...info(id), name:settings.name || id, description:settings.description || '', path: dir, lastLaunch: settings.lastLaunch || null,
            mods: list(path.join(dir,'mods')).filter(e => e.isFile() && /\.jar(?:\.disabled)?$/i.test(e.name)).map(e => ({ name:e.name, enabled:!e.name.endsWith('.disabled'), size:fs.statSync(path.join(dir,'mods',e.name)).size })),
            worlds: list(path.join(dir,'saves')).filter(e => e.isDirectory() && fs.existsSync(path.join(dir,'saves',e.name,'level.dat'))).map(e => ({name:e.name})), folders };
    }
    function mutable() { if (busy()) throw new Error('Закройте игру перед изменением модов.'); }
    const guard = fn => async (event, data = {}) => {
        if (event.sender !== window()?.webContents || event.senderFrame !== window()?.webContents.mainFrame) return {ok:false,error:'Недопустимое окно.'};
        try { return {ok:true, ...await fn(data)}; } catch(e) { return {ok:false,error:e.message}; }
    };
    ipcMain.handle('build:details', guard(({id}) => ({build:snapshot(id)})));
    function saveMeta(dir, data) {
        const file = safe(root,path.relative(root,dir),'.foleam-build.json');
        const temporary = safe(root,path.relative(root,dir),'.foleam-build.json.tmp');
        fs.writeFileSync(temporary,JSON.stringify({...meta(dir),...data},null,2)); fs.renameSync(temporary,file);
    }
    ipcMain.handle('build:save', guard(({id,name,description}) => {
        if(typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Название должно содержать от 1 до 80 символов.');
        if(typeof description !== 'string' || description.length > 1000) throw new Error('Описание: не больше 1000 символов.');
        saveMeta(ensure(id),{name:name.trim(),description:description.trim()});
        return {build:snapshot(id)};
    }));
    ipcMain.handle('build:folder', guard(async ({id, folder = '', world}) => {
        const dir = ensure(id);
        if (folder && !folders.includes(folder)) throw new Error('Неизвестная папка.');
        if (world && (folder !== 'saves' || path.basename(world) !== world || /[\\/:]/.test(world))) throw new Error('Некорректный мир.');
        const target = safe(root, path.relative(root,dir), folder, world || '');
        if (!fs.existsSync(target)) throw new Error('Папка не найдена.');
        const error = await shell.openPath(target); if (error) throw new Error(error);
        return {};
    }));
    ipcMain.handle('build:import', guard(async ({id,paths}) => {
        mutable(); const dir = ensure(id);
        if (info(id).loader === 'vanilla') throw new Error('Для модов нужна сборка с Fabric, Forge, NeoForge или Quilt.');
        if(paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p)))) throw new Error('Можно добавить до 100 локальных файлов JAR.');
        const result = paths ? {filePaths:paths,canceled:false} : await dialog.showOpenDialog(window(), { title:'Добавить моды в сборку', filters:[{name:'Моды Minecraft', extensions:['jar']}], properties:['openFile','multiSelections'] });
        if (result.canceled) return {canceled:true};
        mutable(); let count = 0; const skipped = [];
        for (const source of result.filePaths) {
            if (!/\.jar$/i.test(source) || !fs.statSync(source).isFile()) { skipped.push(path.basename(source)); continue; }
            const dest = safe(root,path.relative(root,dir),'mods',path.basename(source));
            if (fs.existsSync(dest) || fs.existsSync(dest + '.disabled')) { skipped.push(path.basename(source)); continue; }
            fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL); count++;
        }
        return {count,skipped,build:snapshot(id)};
    }));
    ipcMain.handle('build:toggle', guard(({id,name,enabled}) => {
        mutable(); const dir = ensure(id);
        if (typeof name !== 'string' || /[\\/:]/.test(name) || !/\.jar(?:\.disabled)?$/i.test(name)) throw new Error('Некорректный мод.');
        const from = safe(root,path.relative(root,dir),'mods',name);
        const next = enabled ? name.replace(/\.disabled$/, '') : name.endsWith('.disabled') ? name : name + '.disabled';
        const to = safe(root,path.relative(root,dir),'mods',next);
        if (!fs.statSync(from).isFile()) throw new Error('Файл не найден.');
        if (from !== to) { if (fs.existsSync(to)) throw new Error('Файл с таким именем уже существует.'); fs.renameSync(from,to); }
        return {build:snapshot(id)};
    }));
    ipcMain.handle('build:log', guard(({id}) => {
        const dir = ensure(id), file = safe(root,path.relative(root,dir),'logs','latest.log');
        if (!fs.existsSync(file)) return {text:'Журнал появится после запуска игры.'};
        const fd = fs.openSync(file,'r');
        try { const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size,128 * 1024)); fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length)); return {text:buffer.toString('utf8'),truncated:size>buffer.length}; }
        finally { fs.closeSync(fd); }
    }));
    return {ensure, snapshot, metadata(id) { return meta(safe(root,'instances',id)); }, launched(id) { saveMeta(ensure(id),{lastLaunch:new Date().toISOString()}); }};
}
module.exports = {createBuildManager};
