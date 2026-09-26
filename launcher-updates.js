const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const ORIGIN = 'https://mailan1.ru';
function newer(a,b) {
    const valid = s => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(s);
    if(!valid(a)||!valid(b)) return false;
    const x=a.split('.').map(Number),y=b.split('.').map(Number);
    for(let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]>y[i];
    return false;
}
function validate(value) {
    if(!value || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.version) || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size<1 || value.size>600*1024*1024) throw Error('Некорректные данные обновления.');
    if(value.url!==`${ORIGIN}/Foleam-Launcher-Setup-${value.version}.exe`) throw Error('Недопустимый адрес обновления.');
    return {version:value.version,url:value.url,sha256:value.sha256,size:value.size,notes:String(value.notes||'').slice(0,2000)};
}
function request(url,signal) {
    return new Promise((resolve,reject)=>{
        const req=https.get(url,{family:4,signal,headers:{'Cache-Control':'no-cache'}},res=>{
            if(res.statusCode!==200){res.resume();reject(Error('Сервер обновлений: HTTP '+res.statusCode));return;}
            resolve(res);
        }); req.setTimeout(30000,()=>req.destroy(Error('Сервер не отвечает.')));req.on('error',reject);
    });
}
async function hashFile(file) { const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex'); }
function installUpdates({app,ipcMain,window,shell,dialog,busy,root,fetch=request}) {
    let release=null,controller=null,checking=false,ready=null;
    let state={status:'idle',current:app.getVersion(),progress:0};
    function notify(values){state={...state,...values};const win=window();if(win&&!win.isDestroyed())win.webContents.send('launcher-update:state',state);return state;}
    const guard=fn=>async event=>{
        const w=window();if(!w||event.sender!==w.webContents||event.senderFrame!==w.webContents.mainFrame)return {status:'error',error:'Недопустимое окно.'};
        try{return await fn();}catch(e){return notify({status:ready?'ready':release&&newer(release.version,state.current)?'available':'error',error:e.message});}
    };
    ipcMain.handle('launcher-update:state',guard(()=>state));
    ipcMain.handle('launcher-update:check',guard(async()=>{
        if(checking||controller||ready)return state;
        checking=true;notify({status:'checking',error:null});
        try{
            const res=await fetch(ORIGIN+'/foleam-update.json?t='+Date.now(),AbortSignal.timeout(30000));const chunks=[];let length=0;
            for await(const chunk of res){length+=chunk.length;if(length>16384){res.destroy();throw Error('Слишком большой ответ сервера.');}chunks.push(Buffer.from(chunk));}
            release=validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            return notify({status:newer(release.version,state.current)?'available':'current',version:release.version,notes:release.notes});
        }finally{checking=false;}
    }));
    ipcMain.handle('launcher-update:download',guard(async()=>{
        if(controller||ready)return state;
        if(!release||!newer(release.version,state.current))throw Error('Сначала проверьте обновления.');
        const selected={...release};
        const dir=path.join(root,'updates');fs.mkdirSync(dir,{recursive:true});
        controller=new AbortController();
        const file=path.join(dir,`Foleam-Launcher-Setup-${selected.version}.exe`),temporary=file+'.'+crypto.randomUUID()+'.part';
        notify({status:'downloading',progress:0,error:null});
        try{
            const res=await fetch(selected.url,controller.signal);let received=0,last=0;const hash=crypto.createHash('sha256');
            const measure=new Transform({transform(chunk,encoding,callback){received+=chunk.length;if(received>selected.size)return callback(Error('Размер обновления не совпадает.'));hash.update(chunk);if(Date.now()-last>200){last=Date.now();notify({progress:Math.floor(received/selected.size*100)});}callback(null,chunk);}});
            await pipeline(res,measure,fs.createWriteStream(temporary,{flags:'wx'}),{signal:controller.signal});
            if(received!==selected.size||hash.digest('hex')!==selected.sha256)throw Error('Проверка файла не пройдена. Скачайте обновление заново.');
            fs.renameSync(temporary,file);ready={...selected,file};return notify({status:'ready',progress:100});
        }catch(e){if(controller.signal.aborted)return notify({status:'available',progress:0});throw e;}
        finally{controller=null;if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    }));
    ipcMain.handle('launcher-update:cancel',guard(()=>{controller?.abort();return state;}));
    ipcMain.handle('launcher-update:install',guard(async()=>{
        if(!ready)throw Error('Сначала скачайте обновление.');
        if(busy())throw Error('Закройте Minecraft перед обновлением.');
        if(await hashFile(ready.file)!==ready.sha256){ready=null;throw Error('Скачанный файл изменился. Скачайте его заново.');}
        const answer=await dialog.showMessageBox(window(),{type:'question',buttons:['Отмена','Запустить установщик'],defaultId:0,cancelId:0,title:'Обновление Foleam',message:`Установить Foleam ${ready.version}?`,detail:'Лаунчер закроется. Миры, сборки и аккаунты сохранятся. Установщик пока без цифровой подписи издателя.'});
        if(answer.response!==1)return state;
        if(busy())throw Error('Закройте Minecraft перед обновлением.');
        if(await hashFile(ready.file)!==ready.sha256){ready=null;throw Error('Скачанный файл изменился. Скачайте его заново.');}
        const error=await shell.openPath(ready.file);if(error)throw Error(error);
        if(app.isPackaged)app.quit();return state;
    }));
}
module.exports={installUpdates,newer,validate};
