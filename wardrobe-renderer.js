(() => {
    const { ipcRenderer } = require('electron');
    const sv = require('./vendor/skinview3d.cjs'), icons = require('lucide');
    const page = document.createElement('section'); page.id = 'wardrobe'; page.hidden = true;
    page.innerHTML = `
      <header class="wardrobe-header"><button class="wardrobe-icon" id="wardrobe-close" title="Назад" aria-label="Назад"><i data-lucide="arrow-left"></i></button><h2>Выбор скина</h2><span id="wardrobe-account-kind"></span></header>
      <div class="wardrobe-layout"><aside class="wardrobe-preview"><div class="wardrobe-nick" id="wardrobe-nick"></div><div class="wardrobe-stage"><canvas id="wardrobe-canvas"></canvas></div><div class="wardrobe-tools"><button id="wardrobe-rotate" class="wardrobe-icon" title="Автовращение" aria-label="Автовращение" aria-pressed="false"><i data-lucide="rotate-3d"></i></button><button id="wardrobe-walk" class="wardrobe-icon" title="Анимация ходьбы" aria-label="Анимация ходьбы" aria-pressed="false"><i data-lucide="footprints"></i></button><button id="wardrobe-edit" class="wardrobe-button"><i data-lucide="pencil"></i>Изменить</button></div><button id="wardrobe-delete" class="wardrobe-icon" title="Удалить из библиотеки" aria-label="Удалить из библиотеки"><i data-lucide="trash-2"></i></button></aside>
      <main class="wardrobe-library"><h3>Сохранённые скины</h3><div id="wardrobe-saved" class="wardrobe-grid"></div><h3>Стандартные скины</h3><div id="wardrobe-defaults" class="wardrobe-grid"></div><div class="wardrobe-apply"><select id="wardrobe-version" aria-label="Сборка Minecraft"></select><button id="wardrobe-apply" class="wardrobe-button wardrobe-primary"><i data-lucide="check"></i>Применить в игре</button></div><p id="wardrobe-status" class="wardrobe-status" role="status"></p></main></div>
      <dialog id="wardrobe-editor"><header class="wardrobe-editor-heading"><h2>Настройка скина</h2><button id="wardrobe-edit-close" class="wardrobe-icon" title="Закрыть" aria-label="Закрыть"><i data-lucide="x"></i></button></header><div class="wardrobe-editor-content"><div class="wardrobe-editor-stage"><canvas id="wardrobe-edit-canvas"></canvas></div><div class="wardrobe-editor-fields"><label>Название<input id="wardrobe-name" type="text" maxlength="64"></label><button id="wardrobe-replace" class="wardrobe-button"><i data-lucide="upload"></i>Текстура</button><fieldset><legend>Руки</legend><div class="wardrobe-models"><label><input type="radio" name="wardrobe-model" value="default">Широкие</label><label><input type="radio" name="wardrobe-model" value="slim">Тонкие</label></div></fieldset><fieldset><legend>Локальный плащ</legend><div class="wardrobe-capes"><img id="wardrobe-cape-preview" class="wardrobe-cape-preview" alt="Плащ" hidden><button id="wardrobe-no-cape" class="wardrobe-icon" title="Без плаща" aria-label="Без плаща"><i data-lucide="x"></i></button><button id="wardrobe-upload-cape" class="wardrobe-icon" title="Загрузить плащ" aria-label="Загрузить плащ"><i data-lucide="plus"></i></button></div></fieldset></div></div><p id="wardrobe-editor-status" class="wardrobe-status" role="status"></p><footer class="wardrobe-editor-footer"><button id="wardrobe-cancel" class="wardrobe-button">Отмена</button><button id="wardrobe-save" class="wardrobe-button wardrobe-primary"><i data-lucide="save"></i>Сохранить скин</button></footer></dialog><input type="file" id="wardrobe-texture-file" accept="image/png" hidden><input type="file" id="wardrobe-cape-file" accept="image/png" hidden>`;
    document.body.append(page);
    document.getElementById('character-modal')?.remove();
    const $w = id => document.getElementById(id);
    const paintIcons = () => icons.createIcons({ icons: icons.icons });
    let key, library, chosen, viewer, controls, editorViewer, editorControls, thumbs, draft, generation = 0, busy = false;
    const cache = new Map();
    function animateControls() { if (!page.hidden) { controls?.update(); if ($w('wardrobe-editor').open) editorControls?.update(); } requestAnimationFrame(animateControls); }
    requestAnimationFrame(animateControls);
    const message = (text, error = false, editor = false) => { const target = $w(editor ? 'wardrobe-editor-status' : 'wardrobe-status'); target.textContent = text; target.dataset.error = error; };
    async function invoke(route, data = {}) { const r = await ipcRenderer.invoke('wardrobe:' + route, { ...data, key }); if (!r?.ok) throw new Error(r?.error || 'Не удалось выполнить действие.'); return r; }
    function createViewer(canvas, thumbnail = false) {
        const v = new sv.SkinViewer({ canvas, width: thumbnail ? 220 : 300, height: thumbnail ? 280 : 420, zoom: thumbnail ? .94 : .78, alpha: true, preserveDrawingBuffer: thumbnail, renderPaused: thumbnail });
        v.renderer.setClearColor(0, 0); v.playerObject.rotation.y = -.25;
        return v;
    }
    function fit(v) { if (!v) return; const box = v.canvas.parentElement.getBoundingClientRect(); if (box.width && box.height) v.setSize(Math.round(box.width), Math.round(box.height)); }
    async function load(v, item) { await v.loadSkin(item.texture, item.model); if (item.capeTexture) await v.loadCape(item.capeTexture); else v.loadCape(null); v.render(); }
    async function preview() {
        if (!viewer) { viewer = createViewer($w('wardrobe-canvas')); controls = sv.createOrbitControls(viewer); controls.enablePan = false; controls.enableZoom = false; }
        viewer.renderPaused = false; fit(viewer); await load(viewer, chosen);
    }
    async function thumbnail(item) {
        const hash = item.id + ':' + item.model;
        if (cache.has(hash)) return cache.get(hash);
        if (!thumbs) thumbs = createViewer(document.createElement('canvas'), true);
        await load(thumbs, item); const image = thumbs.canvas.toDataURL('image/png'); cache.set(hash, image); return image;
    }
    async function selectItem(item) {
        if (busy) return; busy = true;
        try { await invoke('select', { id: item.id }); chosen = item; await preview(); markSelection(); message('Скин выбран.'); }
        catch (e) { message(e.message, true); } finally { busy = false; }
    }
    function markSelection() {
        page.querySelectorAll('[data-skin-id]').forEach(b => { const selected = b.dataset.skinId === chosen.id; b.setAttribute('aria-pressed', String(selected)); b.querySelector('.wardrobe-check').hidden = !selected; });
        $w('wardrobe-delete').hidden = true;
        page.querySelectorAll('[data-remove-skin]').forEach(b => { b.disabled = b.dataset.removeSkin === chosen.id; });
    }
    async function render() {
        const current = ++generation;
        for (const id of ['wardrobe-saved','wardrobe-defaults']) $w(id).replaceChildren();
        const add = document.createElement('button'); add.className = 'wardrobe-card wardrobe-add'; add.innerHTML = '<i data-lucide="plus"></i><strong>Добавить скин</strong>';
        add.onclick = () => importSkin();
        add.ondragover = e => { e.preventDefault(); add.classList.add('dragging'); };
        add.ondragleave = () => add.classList.remove('dragging');
        add.ondrop = e => { e.preventDefault(); add.classList.remove('dragging'); const files = [...e.dataTransfer.files]; if (files.length !== 1) return message('Перетащите один PNG-файл.', true); importSkin(files[0]); };
        $w('wardrobe-saved').append(add); paintIcons();
        for (const item of [...library.items, ...library.defaults]) {
            if (generation !== current) return;
            const b = document.createElement('button'); b.className = 'wardrobe-card'; b.dataset.skinId = item.id; b.title = item.name;
            const img = document.createElement('img'); img.alt = item.name;
            const label = document.createElement('span'); label.className = 'wardrobe-card-name'; label.textContent = item.name;
            const check = document.createElement('span'); check.className = 'wardrobe-check'; check.innerHTML = '<i data-lucide="check"></i>';
            b.append(img, label, check); b.onclick = () => selectItem(item);
            const tile = document.createElement('div'); tile.className = 'wardrobe-tile'; tile.append(b);
            if (!item.standard) {
                const remove = document.createElement('button'); remove.className = 'wardrobe-icon wardrobe-remove'; remove.dataset.removeSkin = item.id;
                remove.title = 'Удалить сохранённый скин'; remove.setAttribute('aria-label', 'Удалить ' + item.name); remove.innerHTML = '<i data-lucide="trash-2"></i>';
                remove.onclick = async () => { if (busy) return; busy = true; try { const r = await invoke('delete', { id: item.id }); if (!r.canceled) await reload(); } catch (e) { message(e.message, true); } finally { busy = false; } };
                tile.append(remove);
            }
            $w(item.standard ? 'wardrobe-defaults' : 'wardrobe-saved').append(tile);
            try { img.src = await thumbnail(item); } catch (_) { img.alt = 'Ошибка предпросмотра: ' + item.name; }
            markSelection(); paintIcons();
        }
    }
    async function reload(selectedId) {
        library = await invoke('list'); chosen = [...library.items,...library.defaults].find(i => i.id === (selectedId || library.selected)) || library.defaults[0];
        await preview(); await render();
    }
    async function importSkin(file) {
        if (busy) return; busy = true;
        try {
            if (file && file.size > 2 * 1024 * 1024) throw new Error('PNG должен быть не больше 2 МБ.');
            const data = file ? { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name.replace(/\.png$/i, '') } : {};
            const result = await invoke('import', data); if (!result.canceled) { await invoke('select', { id: result.item.id }); await reload(result.item.id); message('Скин добавлен.'); }
        } catch (e) { message(e.message, true); } finally { busy = false; }
    }
    async function open() {
        if (!activeAccount) return;
        key = activeAccount.type === 'mailan' ? `mailan:${activeAccount.mailanId}` : `${activeAccount.type}:${activeAccount.name}`;
        $w('wardrobe-nick').textContent = activeAccount.name;
        $w('wardrobe-account-kind').textContent = activeAccount.type === 'licensed' ? 'Аккаунт Minecraft' : 'Локальный профиль';
        const selector = $w('wardrobe-version'); selector.replaceChildren();
        for (const version of minecraftVersions.filter(v => v.installed)) { const o = document.createElement('option'); o.value = version.id; o.textContent = version.id; selector.append(o); }
        if (select.value) selector.value = select.value;
        selector.hidden = activeAccount.type === 'licensed';
        page.hidden = false; page.scrollTop = 0; message('Загружаем библиотеку…');
        try { await reload(); message(''); } catch (e) { message(e.message, true); }
    }
    $w('character-btn').addEventListener('click', e => { e.stopImmediatePropagation(); open(); }, true);
    $w('wardrobe-close').onclick = () => { page.hidden = true; generation++; if (viewer) viewer.renderPaused = true; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !page.hidden && !$w('wardrobe-editor').open) $w('wardrobe-close').click(); });
    const observer = new ResizeObserver(() => { fit(viewer); fit(editorViewer); }); observer.observe($w('wardrobe-canvas').parentElement); observer.observe($w('wardrobe-edit-canvas').parentElement);
    $w('wardrobe-rotate').onclick = () => { if (controls) { controls.autoRotate = !controls.autoRotate; $w('wardrobe-rotate').setAttribute('aria-pressed', String(controls.autoRotate)); } };
    let walk;
    $w('wardrobe-walk').onclick = () => { if (!viewer) return; if (walk) { walk.resetAndRemove(); walk = null; } else walk = viewer.animations.add(sv.WalkingAnimation); $w('wardrobe-walk').setAttribute('aria-pressed', String(!!walk)); };
    $w('wardrobe-edit').onclick = async () => {
        if (!chosen || busy) return; draft = { ...chosen }; $w('wardrobe-name').value = draft.name;
        page.querySelector(`input[name=wardrobe-model][value=${draft.model}]`).checked = true;
        $w('wardrobe-editor').showModal(); message('', false, true);
        try { if (!editorViewer) { editorViewer = createViewer($w('wardrobe-edit-canvas')); editorControls = sv.createOrbitControls(editorViewer); editorControls.enablePan = false; editorControls.enableZoom = false; } editorViewer.renderPaused = false; fit(editorViewer); await drawDraft(); }
        catch (e) { message(e.message, true, true); }
    };
    async function drawDraft() { await load(editorViewer, draft); $w('wardrobe-cape-preview').hidden = !draft.capeTexture; if (draft.capeTexture) $w('wardrobe-cape-preview').src = draft.capeTexture; }
    for (const id of ['wardrobe-edit-close','wardrobe-cancel']) $w(id).onclick = () => $w('wardrobe-editor').close();
    $w('wardrobe-editor').onclose = () => { if (editorViewer) editorViewer.renderPaused = true; draft = null; };
    page.querySelectorAll('input[name=wardrobe-model]').forEach(input => input.onchange = async () => { if (draft) { draft.model = input.value; if (draft.standard && !draft.textureBytes) draft.texture = draft.variants[input.value]; try { await drawDraft(); } catch (e) { message(e.message, true, true); } } });
    $w('wardrobe-replace').onclick = () => $w('wardrobe-texture-file').click();
    $w('wardrobe-upload-cape').onclick = () => $w('wardrobe-cape-file').click();
    async function replacement(input, cape) {
        const file = input.files[0]; input.value = ''; if (!file || !draft) return;
        try {
            if (file.size > 2 * 1024 * 1024 || !/\.png$/i.test(file.name)) throw new Error('Нужен PNG до 2 МБ.');
            const bytes = new Uint8Array(await file.arrayBuffer()); const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            const valid = image.width === 64 && (cape ? image.height === 32 : [32,64].includes(image.height)); image.close(); if (!valid) throw new Error(cape ? 'Плащ: PNG 64×32.' : 'Скин: PNG 64×64 или 64×32.');
            const url = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
            if (cape) { draft.capeTexture = url; draft.capeBytes = bytes; } else { draft.texture = url; draft.textureBytes = bytes; }
            await drawDraft(); message('', false, true);
        } catch (e) { message(e.message, true, true); }
    }
    $w('wardrobe-texture-file').onchange = e => replacement(e.target, false); $w('wardrobe-cape-file').onchange = e => replacement(e.target, true);
    $w('wardrobe-no-cape').onclick = async () => { draft.capeTexture = null; draft.capeBytes = null; await drawDraft(); };
    $w('wardrobe-save').onclick = async () => {
        if (busy || !draft) return; busy = true; $w('wardrobe-save').disabled = true;
        try { const result = await invoke('save', { id: draft.id, name: $w('wardrobe-name').value, model: draft.model, texture: draft.textureBytes, cape: draft.capeBytes }); await invoke('select', { id: result.item.id }); $w('wardrobe-editor').close(); await reload(result.item.id); message('Скин сохранён.'); }
        catch (e) { message(e.message, true, true); } finally { busy = false; $w('wardrobe-save').disabled = false; }
    };
    $w('wardrobe-delete').onclick = async () => { if (busy || !chosen) return; try { const result = await invoke('delete', { id: chosen.id }); if (!result.canceled) await reload(); } catch (e) { message(e.message, true); } };
    $w('wardrobe-apply').onclick = async () => {
        if (busy || !chosen) return; busy = true; $w('wardrobe-apply').disabled = true; message('Применяем скин…');
        try { await invoke('select', { id: chosen.id }); const result = await invoke('apply', { id: chosen.id, versionId: $w('wardrobe-version').value }); message(result.message); }
        catch (e) { message(e.message, true); } finally { busy = false; $w('wardrobe-apply').disabled = false; }
    };
    paintIcons();
})();
