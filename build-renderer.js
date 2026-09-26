(() => {
    const { ipcRenderer: ipc, webUtils } = require('electron');
    const icons = require('lucide');
    const byId = id => document.getElementById(id);
    const selector = byId('version');
    const picker = document.createElement('div'); picker.className = 'build-picker';
    selector.before(picker); picker.append(selector);
    const entry = document.createElement('button'); entry.id = 'build-functions'; entry.hidden = true;
    entry.innerHTML = '<i data-lucide="settings-2"></i>Функции'; picker.append(entry);
    const page = document.createElement('section'); page.id = 'build-page'; page.hidden = true;
    page.setAttribute('aria-label','Управление сборкой');
    page.innerHTML = `<header><button id="build-back" title="Назад" aria-label="Назад"><i data-lucide="arrow-left"></i></button><div class="build-heading"><h2 id="build-title"></h2><p id="build-meta"></p></div><button id="build-play" class="build-primary"><i data-lucide="play"></i>Играть</button><button id="build-root" title="Папка сборки" aria-label="Папка сборки"><i data-lucide="folder-open"></i></button></header>
    <nav role="tablist" aria-label="Разделы сборки"></nav><p id="build-status" role="status"></p><div id="build-content" role="tabpanel"></div>`;
    document.body.append(page);
    const description = document.createElement('p'); description.id = 'build-description'; page.querySelector('.build-heading').append(description);
    const edit = document.createElement('button'); edit.id = 'build-edit'; edit.title = 'Название и описание'; edit.setAttribute('aria-label',edit.title); edit.innerHTML = '<i data-lucide="pencil"></i>'; byId('build-play').before(edit);
    const editor = document.createElement('dialog'); editor.id = 'build-editor';
    editor.innerHTML = `<form><header><h2>Настройки сборки</h2><button type="button" id="build-edit-close" aria-label="Закрыть"><i data-lucide="x"></i></button></header><label>Название<input id="build-name-input" maxlength="80" required></label><label>Описание<textarea id="build-description-input" maxlength="1000" rows="4"></textarea></label><p id="build-edit-status" role="status"></p><footer><button type="button" id="build-edit-cancel">Отмена</button><button type="submit" class="build-primary"><i data-lucide="check"></i>Сохранить</button></footer></form>`;
    page.append(editor);
    edit.onclick = () => { byId('build-name-input').value = build.name || build.id; byId('build-description-input').value = build.description || ''; byId('build-edit-status').textContent = ''; editor.showModal(); };
    byId('build-edit-close').onclick = byId('build-edit-cancel').onclick = () => editor.close();
    editor.querySelector('form').onsubmit = async event => {
        event.preventDefault(); const save = editor.querySelector('[type="submit"]'); save.disabled = true;
        try {
            const result = await invoke('save',{name:byId('build-name-input').value,description:byId('build-description-input').value}); build = result.build;
            const version = minecraftVersions.find(v => v.id === id); if(version) version.displayName = build.name;
            renderVersionSelect(); selector.value = id; await render(); editor.close();
        } catch(e) { byId('build-edit-status').textContent = e.message; } finally { save.disabled = false; }
    };
    const tabs = [['mods','Контент','boxes'],['files','Файлы','folder'],['worlds','Миры','globe'],['log','Журнал','terminal']];
    let id = '', build, tab = 'mods', generation = 0;
    const paint = () => icons.createIcons({icons:icons.icons});
    const status = text => { byId('build-status').textContent = text; };
    const button = (label, icon, action, primary = false) => {
        const b = document.createElement('button'); b.innerHTML = `<i data-lucide="${icon}"></i>`;
        b.append(document.createTextNode(label)); if(primary) b.className = 'build-primary';
        b.onclick = async () => { b.disabled = true; status(''); try { await action(); } catch(e) { status(e.message); } finally { b.disabled = false; } }; return b;
    };
    async function invoke(route, data = {}) {
        const r = await ipc.invoke('build:' + route,{...data,id});
        if(!r?.ok) throw new Error(r?.error || 'Не удалось выполнить действие.'); return r;
    }
    function updateEntry() {
        const selected = minecraftVersions.find(v => v.id === selector.value);
        entry.hidden = !selected?.isBuild || !selected?.installed;
    }
    new MutationObserver(updateEntry).observe(selector,{childList:true,subtree:true,attributes:true});
    selector.addEventListener('change',updateEntry);
    for(const [key,label,icon] of tabs) {
        const b = button(label,icon,async () => { tab = key; await render(); });
        b.setAttribute('role','tab'); b.dataset.tab = key; page.querySelector('nav').append(b);
    }
    function row(name, detail, icon) {
        const r = document.createElement('div'); r.className = 'build-item'; r.innerHTML = `<i data-lucide="${icon}"></i>`;
        const n = document.createElement('div'); n.className = 'build-item-name'; n.textContent = name;
        if(detail) { const s = document.createElement('small'); s.textContent = detail; n.append(s); } r.append(n); return r;
    }
    function empty(title, icon) {
        const e = document.createElement('div'); e.className = 'build-empty'; e.innerHTML = `<i data-lucide="${icon}"></i>`;
        const h = document.createElement('h3'); h.textContent = title; e.append(h); return e;
    }
    async function refresh() { const r = await invoke('details'); build = r.build; await render(); }
    async function render() {
        const revision = ++generation;
        byId('build-title').textContent = build.name || build.id;
        description.textContent = build.description || ''; description.hidden = !build.description;
        byId('build-meta').textContent = `${build.loader} · Minecraft ${build.mcVersion}` + (build.lastLaunch ? ` · Последний запуск: ${new Date(build.lastLaunch).toLocaleString('ru-RU')}` : '');
        page.querySelectorAll('[role="tab"]').forEach(b => b.setAttribute('aria-selected',String(b.dataset.tab === tab)));
        const content = byId('build-content'); content.replaceChildren();
        const actions = document.createElement('div'); actions.className = 'build-actions'; content.append(actions);
        actions.append(button('','refresh-cw',refresh)); actions.lastChild.title = 'Обновить'; actions.lastChild.setAttribute('aria-label','Обновить');
        if(tab === 'mods') {
            actions.append(button('Добавить файлы','folder-plus',() => importMods()),button('Найти моды','compass',() => openModshop(),true));
            const summary = document.createElement('span'); summary.className = 'build-count'; summary.textContent = `${build.mods.length} модов · ${build.mods.filter(m=>m.enabled).length} включено`; actions.append(summary);
            const drop = document.createElement('div'); drop.className = 'build-drop'; drop.innerHTML = '<i data-lucide="import"></i><span>Перетащите моды .jar</span>'; content.append(drop);
            if(!build.mods.length) content.append(empty('В сборке пока нет модов','package-open'));
            for(const mod of build.mods) {
                const r = row(mod.name.replace(/\.disabled$/,''),(mod.size/1024/1024).toFixed(2)+' МБ','puzzle');
                const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = mod.enabled;
                toggle.setAttribute('aria-label','Включить '+mod.name);
                toggle.onchange = async () => { toggle.disabled = true; try { const res = await invoke('toggle',{name:mod.name,enabled:toggle.checked}); build = res.build; await render(); } catch(e) { toggle.checked = mod.enabled; status(e.message); } finally { toggle.disabled = false; } };
                r.append(toggle); content.append(r);
            }
        } else if(tab === 'files') {
            const labels = {mods:'Моды',config:'Настройки модов',saves:'Миры',resourcepacks:'Ресурспаки',shaderpacks:'Шейдеры',screenshots:'Скриншоты',logs:'Журналы'};
            for(const folder of build.folders) { const r = row(labels[folder],folder,'folder'); r.append(button('Открыть','folder-open',() => invoke('folder',{folder}))); content.append(r); }
        } else if(tab === 'worlds') {
            actions.append(button('Папка миров','folder-open',() => invoke('folder',{folder:'saves'})));
            if(!build.worlds.length) content.append(empty('Сохранённых миров пока нет','globe'));
            for(const world of build.worlds) { const r = row(world.name,'','globe'); r.append(button('Открыть','folder-open',() => invoke('folder',{folder:'saves',world:world.name}))); content.append(r); }
        } else {
            const pre = document.createElement('pre'); pre.id = 'build-log'; pre.textContent = 'Загрузка журнала...'; content.append(pre);
            paint(); const result = await invoke('log'); if(revision !== generation) return;
            pre.textContent = (result.truncated ? 'Последняя часть журнала\n\n' : '') + result.text;
        }
        paint();
    }
    let importing = false;
    async function importMods(paths) {
        if(importing) return;
        importing = true; page.classList.add('build-importing'); status('Добавление модов...');
        try { const r = await invoke('import',paths ? {paths} : {}); if(r.canceled) { status(''); return; } build = r.build; await render(); status(`Добавлено: ${r.count}` + (r.skipped.length ? `. Пропущено (дубликаты или не JAR): ${r.skipped.join(', ')}` : '')); }
        finally { importing = false; page.classList.remove('build-importing'); }
    }
    let dragDepth = 0;
    const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
    page.addEventListener('dragenter',e => { if(hasFiles(e) && !editor.open) { e.preventDefault(); dragDepth++; page.classList.add('build-dragging'); } });
    page.addEventListener('dragover',e => { if(hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = editor.open || importing ? 'none' : 'copy'; } });
    page.addEventListener('dragleave',() => { if(--dragDepth <= 0) { dragDepth = 0; page.classList.remove('build-dragging'); } });
    page.addEventListener('drop',async e => {
        e.preventDefault(); dragDepth = 0; page.classList.remove('build-dragging'); if(editor.open || importing) return;
        try { const paths = Array.from(e.dataTransfer.files).map(file => webUtils.getPathForFile(file)).filter(Boolean); if(!paths.length) return; tab = 'mods'; await importMods(paths); } catch(error) { status(error.message); }
    });
    entry.onclick = async () => {
        id = selector.value; tab = 'mods'; status(''); entry.disabled = true;
        try { await refresh(); page.hidden = false; byId('build-back').focus(); }
        catch(e) { byId('status').textContent = e.message; } finally { entry.disabled = false; }
    };
    const close = () => { page.hidden = true; generation++; entry.focus(); };
    byId('build-back').onclick = close;
    byId('build-root').onclick = async () => { try { await invoke('folder'); } catch(e) { status(e.message); } };
    byId('build-play').onclick = () => { selector.value = id; selector.dispatchEvent(new Event('change')); close(); byId('play-btn').click(); };
    document.addEventListener('keydown',e => { if(e.key === 'Escape' && !editor.open && !page.hidden && !document.querySelector('.modal.active')) close(); });
    updateEntry(); paint();
})();
