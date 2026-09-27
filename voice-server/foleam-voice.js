'use strict';
const {randomBytes, timingSafeEqual} = require('node:crypto');
const {getChatCallIceConfig} = require('./chat-call-ice');
const codePattern = /^[A-F0-9]{12}$/;
function installFoleamVoice({app, io, db, sessionMiddleware, ensureCsrfToken, env=process.env}) {
    const rooms = new Map(), connections = new Map();
    const ns = io.of('/foleam-voice');
    const getUser = id => db.prepare('SELECT id, username, banned, deleted_at, is_bot, is_verified FROM users WHERE id = ?').get(Number(id) || 0);
    const valid = u => u && !u.deleted_at && !Number(u.banned) && !Number(u.is_bot) && Number(u.is_verified) === 1;
    app.get('/api/foleam-voice/session', (req,res) => {
        res.set('Cache-Control','no-store');
        const user = getUser(req.session?.userId);
        if (!valid(user)) return res.status(401).json({error:'Войдите в подтверждённый аккаунт Mailan1.'});
        res.json({user:{id:user.id,name:user.username},csrf:ensureCsrfToken(req),...getChatCallIceConfig(env,user.id)});
    });
    ns.use((socket,next) => {
        const origin = socket.handshake.headers.origin;
        const allowed = new URL(env.APP_URL || env.SITE_URL || 'https://mailan1.ru').origin;
        if (origin !== allowed) return next(Error('Недопустимый источник соединения.'));
        sessionMiddleware(socket.request, {}, next);
    });
    ns.use((socket,next) => {
        const user = getUser(socket.request.session?.userId);
        const a = Buffer.from(String(socket.request.session?.csrfToken || ''));
        const b = Buffer.from(String(socket.handshake.auth?.csrf || ''));
        if (!valid(user) || !a.length || a.length !== b.length || !timingSafeEqual(a,b)) return next(Error('Войдите в Mailan1 заново.'));
        if ((connections.get(user.id)?.size || 0) >= 3) return next(Error('Слишком много открытых голосовых окон.'));
        socket.data.voiceUser = {id:user.id,name:String(user.username).slice(0,40)};
        next();
    });
    const roster = room => [...room.members.values()].map(s=>({id:s.id,name:s.data.voiceUser.name,muted:!!s.data.muted}));
    function leave(socket) {
        const code = socket.data.code, room = rooms.get(code);
        socket.data.code = null;
        if (!room) return;
        room.members.delete(socket.id);socket.leave('voice:'+code);
        if (!room.members.size) rooms.delete(code);
        else { if(room.owner===socket.id) room.owner=room.members.keys().next().value; ns.to('voice:'+code).emit('roster',{members:roster(room),owner:room.owner}); }
    }
    ns.on('connection', socket => {
        const user = socket.data.voiceUser;
        if(!connections.has(user.id)) connections.set(user.id,new Set());
        connections.get(user.id).add(socket.id);
        let start=Date.now(),count=0,joins=0,joinStart=Date.now();
        function handle(name, fn) {
            socket.on(name,(data,ack) => {
                if(typeof ack !== 'function') return;
                try {
                    if(Date.now()-start>10000){start=Date.now();count=0;}
                    if(++count>100) throw Error('Слишком много запросов.');
                    if(!valid(getUser(user.id))) throw Error('Аккаунт недоступен.');
                    ack({ok:true,...fn(data || {})});
                } catch(e) {ack({ok:false,error:e.message});}
            });
        }
        handle('join', data => {
            if(Date.now()-joinStart>60000){joinStart=Date.now();joins=0;}
            if(++joins>10) throw Error('Подождите минуту перед новым входом.');
            if(socket.data.code) throw Error('Сначала выйдите из текущего лобби.');
            const create=data.create===true;
            let code=String(data.code||'').toUpperCase(),room;
            if(create){
                if(rooms.size>=200) throw Error('Сервер заполнен.');
                do {code=randomBytes(6).toString('hex').toUpperCase();} while(rooms.has(code));
                room={members:new Map(),owner:socket.id,created:Date.now()};rooms.set(code,room);
            } else {
                if(!codePattern.test(code) || !(room=rooms.get(code))) throw Error('Лобби не найдено или уже закрыто.');
            }
            if(room.members.size>=8) throw Error('В лобби уже 8 участников.');
            if([...room.members.values()].some(s=>s.data.voiceUser.id===user.id)) throw Error('Вы уже в этом лобби в другом окне.');
            const peers=roster(room);
            room.members.set(socket.id,socket);socket.data.code=code;socket.data.muted=false;socket.join('voice:'+code);
            ns.to('voice:'+code).emit('roster',{members:roster(room),owner:room.owner});
            return {code,peers,owner:room.owner,iceServers:getChatCallIceConfig(env,user.id).iceServers};
        });
        handle('signal', data => {
            const room=rooms.get(socket.data.code),target=room?.members.get(data.to);
            if(!target || target===socket) throw Error('Участник не найден.');
            const signal=data.signal;
            if(!signal || JSON.stringify(signal).length>32000) throw Error('Некорректный сигнал.');
            if(!['offer','answer','candidate'].includes(signal.type)) throw Error('Некорректный тип сигнала.');
            if(signal.type!=='candidate' && typeof signal.sdp!=='string') throw Error('Некорректное описание соединения.');
            target.emit('signal',{from:socket.id,name:user.name,signal});return {};
        });
        handle('mute',data=>{socket.data.muted=!!data.muted;const room=rooms.get(socket.data.code);if(room)ns.to('voice:'+socket.data.code).emit('roster',{members:roster(room),owner:room.owner});return {};});
        handle('leave',()=>{leave(socket);return {};});
        handle('close',()=>{const room=rooms.get(socket.data.code);if(!room||room.owner!==socket.id)throw Error('Только владелец может закрыть лобби.');for(const member of [...room.members.values()]){member.emit('ended','Владелец закрыл лобби.');leave(member);}return {};});
        socket.on('disconnect',()=>{leave(socket);const set=connections.get(user.id);set?.delete(socket.id);if(!set?.size)connections.delete(user.id);});
    });
    const timer=setInterval(()=>{for(const room of rooms.values())if(Date.now()-room.created>4*60*60*1000)for(const s of [...room.members.values()]){s.emit('ended','Лобби закрыто по лимиту времени (4 часа).');leave(s);}},30000);
    timer.unref();
    return {rooms,close(){clearInterval(timer);for(const s of ns.sockets.values())s.disconnect(true);}};
}
module.exports={installFoleamVoice};
