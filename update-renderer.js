(() => {
    const {ipcRenderer}=require('electron'),icons=require('lucide');
    const panel=document.createElement('section');panel.id='launcher-update';panel.className='settings-section';
    panel.innerHTML='<div class="update-heading"><img src="assets/foleam-logo.png" alt=""><div><strong>Foleam Launcher</strong><div id="update-version"></div></div></div><p id="update-status" role="status"></p><p id="update-notes"></p><progress id="update-progress" max="100" hidden></progress><button id="update-action" class="btn-secondary"></button><button id="update-cancel" class="btn-secondary" hidden>Отменить загрузку</button>';
    document.getElementById('tab-settings').append(panel);
    const disclosure=document.createElement('p');disclosure.className='update-disclosure';
    disclosure.textContent='Обновления загружаются с mailan1.ru только по кнопке «Скачать». Файл сохраняется в папке updates профиля лаунчера. Перед запуском установщика проверяется SHA-256 и запрашивается подтверждение.';
    panel.append(disclosure);
    const source=document.createElement('button');source.className='btn-secondary';source.textContent='Исходный код и безопасность';
    source.onclick=()=>ipcRenderer.invoke('open-url','https://mailan1.ru/foleam.html#source');panel.append(source);
    const badge=document.createElement('button');badge.id='update-badge';badge.hidden=true;badge.textContent='Доступно обновление';document.querySelector('.launcher-title').after(badge);
    const $=id=>document.getElementById(id);let state={status:'idle'};
    function paint(s){state=s;$('update-version').textContent='Версия '+(s.current||'');
        const labels={idle:'Обновления с Mailan1.ru',checking:'Проверяем обновления...',current:'Установлена актуальная версия',available:'Доступна версия '+s.version,downloading:'Загрузка: '+s.progress+'%',ready:'Обновление скачано и проверено',error:s.error||'Не удалось проверить обновления'};
        $('update-status').textContent=s.error||labels[s.status];$('update-notes').textContent=['available','ready'].includes(s.status)?s.notes||'':'';
        $('update-progress').hidden=s.status!=='downloading';$('update-progress').value=s.progress||0;
        $('update-cancel').hidden=s.status!=='downloading';
        const action=$('update-action');action.disabled=['checking','downloading'].includes(s.status);
        action.textContent=s.status==='ready'?'Установить обновление':s.status==='available'?'Скачать обновление':'Проверить обновления';
        badge.hidden=!['available','ready'].includes(s.status);
    }
    async function run(action){try{paint(await ipcRenderer.invoke('launcher-update:'+action));}catch(e){paint({...state,status:'error',error:e.message});}}
    $('update-action').onclick=()=>run(state.status==='ready'?'install':state.status==='available'?'download':'check');
    $('update-cancel').onclick=()=>run('cancel');
    badge.onclick=()=>{document.querySelector('[data-tab="settings"]').click();panel.scrollIntoView({block:'nearest'});};
    ipcRenderer.on('launcher-update:state',(_e,s)=>paint(s));
    run('state').then(()=>run('check'));setInterval(()=>run('check'),4*60*60*1000);
    icons.createIcons({icons:icons.icons});
})();
