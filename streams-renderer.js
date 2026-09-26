(() => {
    const { ipcRenderer } = require('electron');
    const lucide = require('lucide');
    const el = id => document.getElementById(id);
    let streams = [], providers = {}, filter = 'all', watching = false, loading = false;
    const icons = () => lucide.createIcons({ icons: lucide.icons });
    const status = message => { el('streams-status').textContent = message || ''; };
    async function invoke(channel, data) {
        const result = await ipcRenderer.invoke(channel, data);
        if (!result?.ok) throw new Error(result?.error || 'Не удалось выполнить действие.');
        return result;
    }
    function render() {
        const grid = el('streams-grid'); grid.replaceChildren();
        const shown = streams.filter(s => filter === 'all' || s.provider === filter);
        el('streams-count').textContent = `${shown.length} в эфире`;
        el('streams-empty').hidden = shown.length > 0;
        for (const stream of shown) {
            const button = document.createElement('button'); button.className = 'stream-card';
            const preview = document.createElement('div'); preview.className = 'stream-thumbnail';
            if (stream.thumbnail) {
                const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy';
                try { if (new URL(stream.thumbnail).protocol === 'https:') img.src = stream.thumbnail; } catch (_) {}
                preview.append(img);
            }
            const live = document.createElement('span'); live.className = 'stream-live'; live.textContent = 'В ЭФИРЕ'; preview.append(live);
            const details = document.createElement('div'); details.className = 'stream-details';
            const title = document.createElement('h3'); title.textContent = stream.title;
            const subtitle = document.createElement('p'); subtitle.textContent = `${stream.username} · ${stream.provider === 'youtube' ? 'YouTube' : stream.provider === 'vk' ? 'VK Видео' : 'Rutube'}`;
            details.append(title, subtitle); button.append(preview, details);
            button.onclick = async () => {
                button.disabled = true;
                try {
                    const result = await invoke('streams:watch', { accountId: stream.accountId });
                    watching = true; el('streams-directory').hidden = true; el('streams-mine').hidden = true;
                    el('streams-player-title').textContent = result.title;
                } catch (e) { status(e.message); } finally { button.disabled = false; }
            };
            grid.append(button);
        }
    }
    async function refresh() {
        if (loading) return;
        loading = true; el('streams-refresh').disabled = true; status('Обновляем эфиры…');
        try {
            const data = await invoke('streams:list');
            streams = data.streams; providers = data.providers || {};
            el('streams-proxy').checked = data.useProxy;
            status(Object.values(providers).some(Boolean) ? '' : 'Подключение платформ ожидает настройки API.'); render();
        } catch (e) { status(e.message); } finally { loading = false; el('streams-refresh').disabled = false; }
    }
    el('streams-open').onclick = () => { el('streams-page').hidden = false; refresh(); };
    el('streams-back').onclick = async () => {
        await invoke('streams:close-player').catch(e => status(e.message));
        if (watching) {
            watching = false; el('streams-directory').hidden = false; el('streams-mine').hidden = false; el('streams-player-title').textContent = ''; refresh();
        } else el('streams-page').hidden = true;
    };
    el('streams-refresh').onclick = refresh;
    document.querySelectorAll('[data-provider]').forEach(button => { button.onclick = () => {
        filter = button.dataset.provider;
        document.querySelectorAll('[data-provider]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
        status(filter !== 'all' && !providers[filter] ? 'Платформа ещё не подключена.' : ''); render();
    }; });
    el('streams-mine').onclick = () => el('streams-dialog').showModal();
    el('streams-dialog-close').onclick = () => el('streams-dialog').close();
    el('streams-login').onclick = async () => {
        el('streams-login').disabled = true;
        try {
            const result = await invoke('streams:connect');
            el('streams-account-status').textContent = `${result.username} · ID ${result.account.mailanId}${result.playing ? ' · Игра запущена' : ' · Игра не запущена'}`;
            el('streams-challenge').value = result.challenge; el('streams-url').value = result.url; el('streams-form').hidden = false;
        } catch (e) { el('streams-account-status').textContent = e.message; }
        finally { el('streams-login').disabled = false; }
    };
    async function save(url) {
        const buttons = el('streams-form').querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
        try {
            const result = await invoke('streams:save', { url });
            el('streams-account-status').textContent = !url ? 'Эфир убран.' : result.verified ? 'Эфир подтверждён. Он виден, пока запущена игра.' : result.status;
            if (!url) el('streams-url').value = '';
            refresh();
        } catch (e) { el('streams-account-status').textContent = e.message; }
        finally { buttons.forEach(b => b.disabled = false); }
    }
    el('streams-form').onsubmit = e => { e.preventDefault(); save(el('streams-url').value.trim()); };
    el('streams-remove').onclick = () => save('');
    el('streams-proxy').onchange = async () => {
        const checkbox = el('streams-proxy'); const desired = checkbox.checked; checkbox.disabled = true;
        try { const result = await invoke('streams:proxy', { enabled: desired }); checkbox.checked = result.useProxy; status(result.useProxy ? 'Просмотр через VDS включён.' : 'Прямое подключение.'); }
        catch (e) { checkbox.checked = !desired; status(e.message); }
        finally { checkbox.disabled = false; }
    };
    ipcRenderer.on('streams:status', (_event, message) => {
        status(message);
        if (watching) el('streams-player-title').textContent = message;
    });
    setInterval(() => { if (!el('streams-page').hidden && !watching && !el('streams-dialog').open) refresh(); }, 60000);
    icons();
})();
