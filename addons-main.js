'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const catalog=require('./voice-catalog.json');
const ORIGIN='https://mailan1.ru', ENTRY=ORIGIN+'/foleam-addon/foleam-voice.html';
function verify(bytes){
    if(bytes.length!==catalog.size||crypto.createHash('sha256').update(bytes).digest('hex')!==catalog.sha256)throw Error('Дополнение не прошло проверку подлинности.');
    const data=JSON.parse(bytes);if(data.id!=='voice'||data.version!==catalog.version)throw Error('Неверная версия дополнения.');return data;
}
function installAddons({ipcMain,BrowserWindow,auth,root,window,dialog,fetcher=fetch}){
    const dir=path.join(root,'addons'),file=path.join(dir,'voice.json'),disabled=path.join(dir,'voice.disabled');
    let voiceWindow=null,voiceSession=null,busy=false,epoch=0;
    function state(){let installed=false,error='';if(fs.existsSync(file)){try{verify(fs.readFileSync(file));installed=true;}catch(e){error=e.message;}}return {installed,enabled:installed&&!fs.existsSync(disabled),version:catalog.version,size:catalog.size,error};}
    function stop(){epoch++;if(voiceWindow&&!voiceWindow.isDestroyed())voiceWindow.destroy();voiceWindow=null;if(voiceSession){voiceSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));voiceSession.setPermissionCheckHandler(()=>false);voiceSession.protocol.unhandle('https');voiceSession=null;}}
    const register=(name,fn)=>ipcMain.handle('addons:'+name,async(_event,data)=>{try{return {ok:true,...await fn(data)};}catch(e){return {...state(),ok:false,error:e.message};}});
    register('state',()=>state());
    register('install',async()=>{
        if(busy)throw Error('Дождитесь завершения операции.');busy=true;
        try{
            const response=await fetcher(catalog.url,{redirect:'error',signal:AbortSignal.timeout(30000)});
            if(!response.ok)throw Error('Не удалось скачать дополнение.');
            const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>catalog.size)throw Error('Недопустимый размер дополнения.');chunks.push(Buffer.from(chunk));}
            const bytes=Buffer.concat(chunks);verify(bytes);
            fs.mkdirSync(dir,{recursive:true});if(fs.lstatSync(dir).isSymbolicLink())throw Error('Недопустимая папка дополнений.');
            const temp=path.join(dir,'voice-'+crypto.randomUUID()+'.part');
            try{fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
            if(fs.existsSync(disabled))fs.unlinkSync(disabled);return state();
        }finally{busy=false;}
    });
    register('toggle',data=>{if(busy)throw Error('Дождитесь загрузки.');if(!state().installed)throw Error('Сначала установите дополнение.');if(data?.enabled===true){if(fs.existsSync(disabled))fs.unlinkSync(disabled);}else{stop();fs.writeFileSync(disabled,'disabled\n');}return state();});
    register('remove',async()=>{if(busy)throw Error('Дождитесь загрузки.');const result=await dialog.showMessageBox(window(),{type:'question',title:'Удалить Foleam Voice?',message:'Голосовое соединение будет закрыто. Дополнение можно скачать снова.',buttons:['Отмена','Удалить'],defaultId:0,cancelId:0});if(result.response!==1)return state();stop();for(const target of [file,disabled])if(fs.existsSync(target))fs.unlinkSync(target);return state();});
    register('open',async()=>{
        if(!state().enabled)throw Error('Дополнение отключено или не установлено.');
        if(voiceWindow&&!voiceWindow.isDestroyed()){voiceWindow.focus();return state();}
        if(busy)throw Error('Дождитесь завершения операции.');busy=true;const expected=epoch;
        try{
            const account=await auth.login();if(expected!==epoch||!state().enabled)throw Error('Дополнение отключено.');
            const ses=auth.getSession(account.mailanId);if(!ses)throw Error('Войдите в Mailan1 заново.');
            const bundle=verify(fs.readFileSync(file));voiceSession=ses;
            ses.protocol.handle('https',request=>{
                const url=new URL(request.url);
                if(url.origin===ORIGIN&&url.pathname.startsWith('/foleam-addon/')){
                    const name=url.pathname.slice('/foleam-addon/'.length);
                    if(!Object.hasOwn(bundle.files,name))return new Response('Not found',{status:404});
                    const type=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript';
                    return new Response(bundle.files[name],{headers:{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
                }
                return ses.fetch(request,{bypassCustomProtocolHandlers:true});
            });
            const win=new BrowserWindow({width:820,height:680,minWidth:360,minHeight:500,title:'Foleam Voice',icon:path.join(__dirname,'assets/foleam-logo.png'),webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});voiceWindow=win;win.setMenuBarVisibility(false);
            const trusted=wc=>wc===win.webContents&&!win.isDestroyed()&&wc.getURL().split('#')[0]===ENTRY;
            ses.setPermissionCheckHandler((wc,permission,origin,details)=>trusted(wc)&&origin===ORIGIN&&permission==='media'&&details.mediaType==='audio');
            ses.setPermissionRequestHandler(async(wc,permission,callback,details)=>{
                if(!trusted(wc)||permission!=='media'||!details.mediaTypes?.length||details.mediaTypes.some(t=>t!=='audio'))return callback(false);
                try{const result=await dialog.showMessageBox(win,{type:'question',title:'Микрофон',message:'Разрешить Foleam Voice использовать микрофон для голосового лобби?',buttons:['Не разрешать','Разрешить'],defaultId:0,cancelId:0});callback(result.response===1&&trusted(wc));}catch{callback(false);}
            });
            win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
            const guard=(event,url)=>{if(url.split('#')[0]!==ENTRY)event.preventDefault();};
            win.webContents.on('will-navigate',guard);win.webContents.on('will-redirect',guard);win.webContents.on('will-attach-webview',e=>e.preventDefault());
            win.on('closed',()=>{if(voiceWindow===win){voiceWindow=null;if(voiceSession===ses){ses.protocol.unhandle('https');ses.setPermissionRequestHandler((_w,_p,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);voiceSession=null;}}});
            await win.loadURL(ENTRY);return state();
        }catch(e){stop();throw e;}finally{busy=false;}
    });
    return {stop,state};
}
module.exports={installAddons,verify};
