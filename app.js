'use strict';

const $ = selector => document.querySelector(selector);
const ICE = { iceServers: [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' }
] };
const state = {
  role: null, you: 0, peer: null, transport: null, rtc: null, game: null,
  notes: new Set(), mode: 'guess', room: '', manual: false,
  muted: localStorage.p2pMuted === '1', audio: null,
  avatar:+localStorage.catAvatar||0,
  observed: { found: 0, misses: 0, finished: false, turn: null, eventAt: 0 }
};
const colors = ['#f6ddd2','#d9ebe2','#f3e5b9','#dbe5f2','#eadcf0','#d5ece8','#f2dcdc','#e5eccb'];
const AVATARS=[
  {emoji:'😺',name:'橘子虎斑'},{emoji:'😸',name:'黑白燕尾'},{emoji:'😻',name:'奶油三花'},
  {emoji:'🐱',name:'灰灰圓臉'},{emoji:'😽',name:'白桃小貓'},{emoji:'🙀',name:'蓬鬆棕貓'}
];
const MODE_INFO={
  scout:{label:'🔎 偵探對戰',description:'猜空會公開八鄰貓數，線索留給下一位玩家。'},
  coop:{label:'🤝 默契合作',description:'共享進度，一起找到全部貓；個人隻數只作紀念。'}
};
const tiles = {
  5:{c:[3,0,2,4,1],r:[1,1,0,0,0,1,1,1,3,3,1,4,2,3,3,1,4,3,3,3,1,4,4,3,3]},
  6:{c:[0,5,3,1,4,2],r:[0,0,0,5,5,5,0,0,5,5,1,1,0,5,5,2,2,1,0,3,5,5,2,1,3,3,5,5,4,4,3,5,5,5,5,4]},
  7:{c:[3,1,4,0,5,2,6],r:[0,0,0,0,2,2,2,0,1,0,0,2,2,2,0,3,0,2,2,2,2,3,3,3,2,2,2,4,3,3,3,5,2,4,4,3,3,5,5,4,4,6,3,3,5,5,4,4,6]}
};
const layouts = {
  12:[[5,7],[6,6],[7,5]],
  20:[[6,7,7],[7,6,7],[7,7,6]],
  24:[[5,6,6,7],[6,5,7,6],[7,6,5,6]]
};

const randomInt = max => crypto.getRandomValues(new Uint32Array(1))[0] % max;
function shuffle(array) {
  for (let i=array.length-1;i;i--) { const j=randomInt(i+1); [array[i],array[j]]=[array[j],array[i]]; }
  return array;
}

function makePuzzle(size) {
  const layout = layouts[size][randomInt(3)], offsets=[];
  let cursor=0;
  for (const width of layout) { offsets.push(cursor); cursor+=width; }
  const regions=Array(size*size).fill(-1), solution=[];
  let previousColumn=null;
  for (let group=0;group<layout.length;group++) {
    const width=layout[group], base=tiles[width], offset=offsets[group];
    const blockOf=value => offsets.findIndex((start,index)=>value>=start&&value<start+layout[index]);
    const belongs=(row,column)=>Math.max(blockOf(row),blockOf(column))===group;
    let mirror=Boolean(randomInt(2));
    if (previousColumn!==null && Math.abs(offset+(mirror?width-1-base.c[0]:base.c[0])-previousColumn)<=1) mirror=!mirror;
    for (let row=0;row<width;row++) for (let column=0;column<width;column++) {
      const sourceColumn=mirror?width-1-column:column;
      regions[(offset+row)*size+offset+column]=offset+base.r[row*width+sourceColumn];
    }
    for (let row=0;row<width;row++) {
      const column=mirror?width-1-base.c[row]:base.c[row];
      solution.push((offset+row)*size+offset+column);
      previousColumn=offset+column;
    }
    const frontier=[];
    for (let row=offset;row<offset+width;row++) for (let column=offset;column<offset+width;column++) frontier.push(row*size+column);
    shuffle(frontier);
    for (let head=0;head<frontier.length;head++) {
      const index=frontier[head], row=Math.floor(index/size), column=index%size, region=regions[index];
      for (const [dr,dc] of shuffle([[-1,0],[1,0],[0,-1],[0,1]])) {
        const nextRow=row+dr, nextColumn=column+dc, next=nextRow*size+nextColumn;
        if (nextRow>=0&&nextRow<size&&nextColumn>=0&&nextColumn<size&&belongs(nextRow,nextColumn)&&regions[next]<0) {
          regions[next]=region; frontier.push(next);
        }
      }
    }
  }
  return { id:`p2p-${size}-${Date.now()}-${randomInt(1e6)}`, size, regions, solution };
}

const cleanSettings = input => ({
  size:[12,20,24].includes(+input.size)?+input.size:20,
  mode:['scout','coop'].includes(input.mode)?input.mode:'scout',
  turnSecondsA:Math.max(10,Math.min(180,+input.turnSecondsA||45)),
  turnSecondsB:Math.max(10,Math.min(180,+input.turnSecondsB||45)),
  streakLimitEnabled:input.streakLimitEnabled!==false,
  streakLimit:Math.max(1,Math.min(24,+input.streakLimit||3))
});
const settingsFromUI = () => cleanSettings({
  size:+$('#size').value, mode:$('#gameMode').value, turnSecondsA:+$('#secondsA').value, turnSecondsB:+$('#secondsB').value,
  streakLimitEnabled:$('#capEnabled').checked, streakLimit:+$('#cap').value
});

function newGame(size) {
  return {
    puzzle:makePuzzle(size), settings:settingsFromUI(),
    players:[{nickname:$('#nick').value||'奶油虎斑',avatar:state.avatar,score:0,connected:true},{nickname:'等待貓友',avatar:1,score:0,connected:false}],
    status:'lobby', starter:randomInt(2), turn:0, turnId:0, deadline:null,
    found:[], misses:[], clues:{}, streak:0, winner:null, round:0,
    lastEvent:null, lastEmote:null, hint:null, hintVotes:[], actionIds:[]
  };
}

const publicGame = game => ({
  ...game,
  puzzle:{id:game.puzzle.id,size:game.puzzle.size,regions:game.puzzle.regions},
  players:game.players.map(player=>({...player})), actionIds:undefined
});
function saveLocal() {
  if (!state.game) return;
  const key=state.role==='host'?'p2pHost':'p2pGuest';
  sessionStorage.setItem(key,JSON.stringify({room:state.room,game:state.game}));
  sessionStorage.setItem(`p2pNotes-${state.role}`,JSON.stringify([...state.notes]));
}
function send(message) { if (state.transport?.open()) state.transport.send(message); }
function broadcast() {
  if (state.role!=='host') return;
  saveLocal(); send({type:'state',state:publicGame(state.game)}); render();
}

const toast = message => {
  const element=$('#toast'); element.textContent=message; element.classList.add('show');
  setTimeout(()=>element.classList.remove('show'),1800);
};
function setDeadline() {
  const game=state.game;
  game.deadline=Date.now()+1000*(game.turn?game.settings.turnSecondsB:game.settings.turnSecondsA);
}
function switchTurn() {
  const game=state.game; game.turn=1-game.turn; game.turnId++; game.streak=0; game.lastEvent={type:'switch',who:game.turn,at:Date.now()}; setDeadline();
}
function excluded(game,index) {
  const puzzle=game.puzzle, size=puzzle.size, row=Math.floor(index/size), column=index%size, region=puzzle.regions[index];
  return game.found.some(cat=>{
    const catRow=Math.floor(cat/size), catColumn=cat%size;
    return row===catRow||column===catColumn||region===puzzle.regions[cat]||(Math.abs(row-catRow)<=1&&Math.abs(column-catColumn)<=1);
  });
}
function neighborIndexes(size,index) {
  const row=Math.floor(index/size),column=index%size,out=[];
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
    if(!dr&&!dc)continue;const rr=row+dr,cc=column+dc;
    if(rr>=0&&rr<size&&cc>=0&&cc<size)out.push(rr*size+cc);
  }
  return out;
}
function neighborCatCount(puzzle,index) {
  const cats=new Set(puzzle.solution);
  return neighborIndexes(puzzle.size,index).filter(cell=>cats.has(cell)).length;
}
function teachingHint(game) {
  const {size,regions}=game.puzzle, groups=[];
  {
    for(const [rawIndex,clue] of Object.entries(game.clues||{})){
      const around=neighborIndexes(size,+rawIndex),found=around.filter(index=>game.found.includes(index)).length;
      const unknown=around.filter(index=>!game.found.includes(index)&&!game.misses.includes(index)&&!excluded(game,index));
      const remaining=clue-found;
      if(unknown.length&&remaining===0)return `觀察數字 ${clue}：周圍需要的貓已確認，可排除其他相鄰格。`;
      if(unknown.length&&remaining===unknown.length)return `觀察數字 ${clue}：剩下 ${unknown.length} 個相鄰候選都必須是貓。`;
    }
  }
  for (const type of ['行','列','區域']) for (let id=0;id<size;id++) {
    const members=[];
    for (let index=0;index<size*size;index++) {
      const row=Math.floor(index/size), column=index%size;
      if ((type==='行'&&row===id)||(type==='列'&&column===id)||(type==='區域'&&regions[index]===id)) members.push(index);
    }
    if (members.some(index=>game.found.includes(index))) continue;
    const candidates=members.filter(index=>!game.misses.includes(index)&&!excluded(game,index));
    if (candidates.length) groups.push({type,id,count:candidates.length});
  }
  groups.sort((a,b)=>a.count-b.count);
  const best=groups[0];
  if (!best) return '先利用已找到的貓，逐一檢查同行、同列、同區與八鄰排除。';
  return `${best.type} ${best.id+1} 目前剩 ${best.count} 個可選格；用行、列、區域與八鄰規則逐一核對。`;
}

function rememberAction(game,id) {
  if (!id) return false;
  if (game.actionIds.includes(id)) return true;
  game.actionIds.push(id);
  if (game.actionIds.length>100) game.actionIds.shift();
  return false;
}
function act(who,action) {
  const game=state.game;
  if (!game||game.status!=='playing'||rememberAction(game,action.actionId)) return;
  if (action.type==='emote') { game.lastEmote={from:who,value:String(action.value).slice(0,20)}; broadcast(); return; }
  if (action.type==='hint') {
    if (!game.hintVotes.includes(who)) game.hintVotes.push(who);
    if (game.hintVotes.length===2) { game.hint=teachingHint(game); game.hintVotes=[]; }
    broadcast(); return;
  }
  if (action.turnId!==game.turnId||who!==game.turn) return;
  if (Date.now()>=game.deadline) { switchTurn(); broadcast(); return; }
  if (action.type==='pass') { switchTurn(); broadcast(); return; }
  if (action.type!=='guess') return;
  const index=+action.index;
  if (!Number.isInteger(index)||index<0||index>=game.puzzle.size**2||excluded(game,index)||game.found.includes(index)||game.misses.includes(index)) return;
  if (game.puzzle.solution.includes(index)) {
    game.found.push(index); game.players[who].score++; game.streak++; game.hint=null; game.hintVotes=[];
    game.lastEvent={type:'cat',index,who,streak:game.streak,at:Date.now()};
    if (game.found.length===game.puzzle.size) {
      game.status='finished'; game.deadline=null;
      game.winner=game.settings.mode==='coop'?'coop':game.players[0].score===game.players[1].score?'tie':game.players[0].score>game.players[1].score?0:1;
    } else if (game.settings.streakLimitEnabled&&game.streak>=game.settings.streakLimit) switchTurn();
    else game.turnId++;
  } else {
    game.misses.push(index);
    game.clues[index]=neighborCatCount(game.puzzle,index);
    game.lastEvent={type:'miss',index,who,at:Date.now()};
    switchTurn();
    game.lastEvent={type:'miss',index,who,next:game.turn,at:Date.now()};
  }
  broadcast();
}

function onMessage(message) {
  const data=typeof message==='string'?JSON.parse(message):message;
  if (state.role==='host') {
    if (data.type==='hello') {
      state.game.players[1].nickname=String(data.nickname||'貓友').slice(0,16);
      state.game.players[1].avatar=Math.max(0,Math.min(AVATARS.length-1,+data.avatar||0));
      state.game.players[1].connected=true;
      if (state.game.status==='lobby') {
        state.game.status='playing'; state.game.turn=state.game.starter; state.game.turnId++; setDeadline();
      }
      broadcast();
    } else if (data.type==='action') act(1,data.action);
    else if (data.type==='rematch') rematchVote(1);
  } else if (data.type==='state') {
    state.game=data.state; saveLocal(); render();
  }
}
function onOpen() {
  $('#connection').textContent='P2P 已連線';
  if (state.role==='host') { state.game.players[1].connected=true; broadcast(); }
  else send({type:'hello',nickname:$('#nick').value||'小花貓',avatar:state.avatar});
}
function onClose() {
  $('#connection').textContent='連線中斷－盤面已保留';
  if (state.game) { state.game.players[1-state.you].connected=false; saveLocal(); render(); }
}
function attachPeerConnection(connection) {
  state.transport={open:()=>connection.open,send:value=>connection.send(value),close:()=>connection.close()};
  connection.on('open',onOpen); connection.on('data',onMessage); connection.on('close',onClose);
  connection.on('error',error=>toast(`連線錯誤：${error.type||error.message}`));
}
function attachDataChannel(channel) {
  state.transport={open:()=>channel.readyState==='open',send:value=>channel.send(JSON.stringify(value)),close:()=>channel.close()};
  channel.onopen=onOpen; channel.onclose=onClose;
  channel.onmessage=event=>onMessage(JSON.parse(event.data));
}

function peerOptions() { return {debug:1,config:ICE}; }
function startPeerHost(restored=false) {
  state.role='host'; state.you=0; state.manual=false;
  if (!restored) { state.room=`CAT-${crypto.randomUUID().slice(0,8).toUpperCase()}`; state.game=newGame(+$('#size').value); }
  $('#setupStatus').textContent='正在向免費 PeerJS Cloud 登記房號…';
  const peer=new Peer(state.room,peerOptions()); state.peer=peer;
  peer.on('open',id=>{$('#setupStatus').textContent=`房號 ${id}，請傳給另一位玩家`; $('#roomInput').value=id;});
  peer.on('connection',connection=>attachPeerConnection(connection));
  peer.on('error',error=>{
    const message=error.type==='unavailable-id'?'房號仍被占用，請稍候重試或建立新房間':error.type||error.message;
    toast(`PeerJS：${message}`); $('#setupStatus').textContent=`連線服務錯誤：${message}`;
  });
}
function startPeerGuest() {
  const room=$('#roomInput').value.trim().toUpperCase();
  if (!/^CAT-[A-Z0-9-]{6,}$/.test(room)) throw Error('請輸入房主顯示的 CAT- 房號');
  state.role='guest'; state.you=1; state.room=room; state.manual=false;
  $('#setupStatus').textContent='正在透過 PeerJS Cloud 尋找房主…';
  const peer=new Peer(undefined,peerOptions()); state.peer=peer;
  peer.on('open',()=>attachPeerConnection(peer.connect(room,{reliable:true,serialization:'json'})));
  peer.on('error',error=>{toast(`PeerJS：${error.type||error.message}`); $('#setupStatus').textContent='房主不存在、尚未就緒或網路無法 P2P 連線';});
}

function rtcPeer(role) {
  const connection=new RTCPeerConnection(ICE); state.rtc=connection;
  connection.onconnectionstatechange=()=>{
    $('#connection').textContent=connection.connectionState==='connected'?'P2P 已連線':connection.connectionState==='failed'?'連線失敗：請改網路或檢查 NAT':connection.connectionState;
  };
  if (role==='host') attachDataChannel(connection.createDataChannel('cats',{ordered:true}));
  else connection.ondatachannel=event=>attachDataChannel(event.channel);
  return connection;
}
const gathered = connection => connection.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>{
  const changed=()=>{if(connection.iceGatheringState==='complete'){connection.removeEventListener('icegatheringstatechange',changed);resolve();}};
  connection.addEventListener('icegatheringstatechange',changed);
});
const encode = value => btoa(JSON.stringify(value));
const decode = value => JSON.parse(atob(value.trim()));
async function makeOffer() { const pc=rtcPeer('host'); await pc.setLocalDescription(await pc.createOffer()); await gathered(pc); return encode(pc.localDescription); }
async function useOffer(code) { const pc=rtcPeer('guest'); await pc.setRemoteDescription(decode(code)); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc); return encode(pc.localDescription); }
async function useAnswer(code) { await state.rtc.setRemoteDescription(decode(code)); }
function showManual(title) { $('#manual').classList.remove('hidden'); $('#manualTitle').textContent=title; }
async function manualHost(restored=false) {
  state.role='host'; state.you=0; state.manual=true;
  if (!restored) { state.room='手動連線'; state.game=newGame(+$('#size').value); }
  $('#outCode').value=await makeOffer(); showManual('步驟 1：把邀請碼傳給對方，再貼回覆碼');
  $('#setupStatus').textContent='等待對方回覆碼';
}
function manualJoin() {
  state.role='guest'; state.you=1; state.manual=true; state.room='手動連線';
  showManual('貼上房主邀請碼，產生回覆碼後傳回房主'); $('#setupStatus').textContent='請貼上邀請碼';
}
async function resumeHost() {
  const saved=JSON.parse(sessionStorage.p2pHost||'null');
  if (!saved?.game?.puzzle?.solution) throw Error('沒有可恢復的房主局面');
  state.game=saved.game; state.game.settings=cleanSettings(state.game.settings||{}); state.game.clues=state.game.clues||{};
  state.game.players.forEach((player,index)=>{if(player.avatar===undefined)player.avatar=index});
  state.room=`CAT-${crypto.randomUUID().slice(0,8).toUpperCase()}`; state.game.players[1].connected=false;
  state.notes=new Set(JSON.parse(sessionStorage.getItem('p2pNotes-host')||'[]'));
  startPeerHost(true);
}

function unlockAudio() {
  if (!state.audio) state.audio=new (window.AudioContext||window.webkitAudioContext)();
  if (state.audio.state==='suspended') state.audio.resume();
}
function tone(kind) {
  if (state.muted) return;
  try {
    unlockAudio(); const now=state.audio.currentTime, oscillator=state.audio.createOscillator(), gain=state.audio.createGain();
    oscillator.connect(gain); gain.connect(state.audio.destination);
    oscillator.frequency.setValueAtTime(kind==='cat'?520:kind==='finish'?660:210,now);
    if (kind==='cat'||kind==='finish') oscillator.frequency.exponentialRampToValueAtTime(kind==='finish'?1040:760,now+.16);
    gain.gain.setValueAtTime(.0001,now); gain.gain.exponentialRampToValueAtTime(.09,now+.015); gain.gain.exponentialRampToValueAtTime(.0001,now+.22);
    oscillator.start(now); oscillator.stop(now+.23);
  } catch {}
}
document.addEventListener('pointerdown',()=>{if(!state.muted)unlockAudio();},{once:true});

function render() {
  const game=state.game; if (!game) return;
  if (game.found.length>state.observed.found) tone('cat');
  if (game.misses.length>state.observed.misses) tone('miss');
  if (game.status==='finished'&&!state.observed.finished) tone('finish');
  state.observed={found:game.found.length,misses:game.misses.length,finished:game.status==='finished'};
  $('#setup').classList.add('hidden'); $('#game').classList.remove('hidden');
  $('#room').textContent=`房號 ${state.room||'手動連線'}`;
  $('#turnText').textContent=game.status==='finished'?'本局完成':game.turn===state.you?'輪到你囉！':`換 ${game.players[game.turn].nickname}`;
  $('#message').textContent=game.hint|| (game.hintVotes?.length?`${game.players[game.hintVotes[0]].nickname} 正在等待共同提示同意`:'') || (game.lastEmote?`${game.players[game.lastEmote.from].nickname}：${game.lastEmote.value}`:'') || (game.streak>1?`連抓 ${game.streak} 隻！`:'');
  for (let playerIndex=0;playerIndex<2;playerIndex++) {
    const player=game.players[playerIndex], element=$(`#p${playerIndex}`); element.className=game.turn===playerIndex?'current':'';
    element.innerHTML=`<div class="face">${playerIndex?'🐈‍⬛':'🐈'}</div><b>${player.nickname}${playerIndex===state.you?'（你）':''}</b><div class="score">${player.score}</div><small>${player.connected?'已連線':'暫時離線'}</small><div>${'🐾'.repeat(player.score)}</div>`;
  }
  const board=$('#board'), size=game.puzzle.size, cellSize=Math.max(18,Math.min(29,(innerHeight-175)/size,(innerWidth-350)/size));
  board.style.setProperty('--n',size); board.style.setProperty('--s',`${cellSize}px`); board.innerHTML='';
  for (let index=0;index<size*size;index++) {
    const cell=document.createElement('button'), region=game.puzzle.regions[index], row=Math.floor(index/size), column=index%size;
    cell.className='cell'; cell.dataset.index=index; cell.setAttribute('role','gridcell');
    cell.setAttribute('aria-label',`第 ${row+1} 行，第 ${column+1} 列，區域 ${region+1}`);
    cell.title=`行 ${row+1}｜列 ${column+1}｜區域 ${region+1}`; cell.style.setProperty('--bg',colors[region%colors.length]);
    if (column===size-1||game.puzzle.regions[index+1]!==region) cell.classList.add('er');
    if (row===size-1||game.puzzle.regions[index+size]!==region) cell.classList.add('eb');
    if (game.found.includes(index)) { cell.classList.add('cat'); cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，已找到貓`); }
    else if (game.misses.includes(index)||excluded(game,index)) { cell.classList.add('x'); cell.textContent='×'; cell.disabled=true; }
    else if (state.notes.has(index)) { cell.classList.add('note'); cell.textContent='×'; }
    if (state.mode==='guess'&&game.turn!==state.you) cell.disabled=true;
    cell.onclick=()=>{
      if (state.mode==='note') { state.notes.has(index)?state.notes.delete(index):state.notes.add(index); saveLocal(); render(); return; }
      const action={type:'guess',index,turnId:game.turnId,actionId:crypto.randomUUID()};
      state.role==='host'?act(0,action):send({type:'action',action});
    };
    board.appendChild(cell);
  }
  $('#pass').disabled=game.turn!==state.you;
  if (game.status==='finished'&&!$('#result').open) {
    $('#resultTitle').textContent=game.winner==='tie'?'平手！':game.winner===state.you?'你贏了！':'下一局再加油！';
    $('#resultScore').textContent=`${game.players[0].score}：${game.players[1].score}`; $('#result').showModal();
  }
}

const escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function playVisualEvent(event) {
  if(!event||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const cell=Number.isInteger(event.index)?boardCell(event.index):null;
  if(cell)cell.classList.add('reveal-pop');
  if(event.type==='cat'&&cell){
    const target=$(`#p${event.who} .basket`),from=cell.getBoundingClientRect(),to=target?.getBoundingClientRect();
    if(to){const flyer=document.createElement('div');flyer.className='fly-cat';flyer.textContent='🐱';flyer.style.left=`${from.left}px`;flyer.style.top=`${from.top}px`;flyer.style.setProperty('--dx',`${to.left+to.width/2-from.left}px`);flyer.style.setProperty('--dy',`${to.top+to.height/2-from.top}px`);document.body.appendChild(flyer);setTimeout(()=>flyer.remove(),800)}
    if(event.streak>1){const burst=document.createElement('div');burst.className='streak-burst';burst.textContent=`連抓 ${event.streak} 隻！`;$('#fxLayer').appendChild(burst);setTimeout(()=>burst.remove(),800)}
  }
}
function renderV2() {
  const game=state.game;if(!game)return;
  game.clues=game.clues||{};game.settings=cleanSettings(game.settings||{});
  const unseen=game.lastEvent?.at>state.observed.eventAt;
  if(game.found.length>state.observed.found)tone('cat');
  if(game.misses.length>state.observed.misses)tone('miss');
  if(game.status==='finished'&&!state.observed.finished)tone('finish');
  $('#setup').classList.add('hidden');$('#game').classList.remove('hidden');
  $('#room').textContent=`房號 ${state.room||'手動連線'}`;
  const info=MODE_INFO[game.settings.mode];
  const capText=game.settings.streakLimitEnabled?`連抓 ${game.settings.streakLimit}`:'不限連抓';
  $('#modeBadge').textContent=`${info.label}｜${game.settings.turnSecondsA}/${game.settings.turnSecondsB} 秒｜${capText}`;
  $('#turnText').textContent=game.status==='finished'?'本局完成':game.turn===state.you?'輪到你囉！':`換 ${game.players[game.turn].nickname}`;
  $('#message').textContent=game.hint||(game.hintVotes?.length?`${game.players[game.hintVotes[0]].nickname} 正在等待共同提示同意`:'')||(game.lastEmote?`${game.players[game.lastEmote.from].nickname}：${game.lastEmote.value}`:'')||(game.streak>1?`連抓 ${game.streak} 隻！`:'');
  for(let playerIndex=0;playerIndex<2;playerIndex++){
    const player=game.players[playerIndex],avatar=AVATARS[player.avatar]||AVATARS[playerIndex],element=$(`#p${playerIndex}`);
    element.className=`player-card ${game.turn===playerIndex&&game.status==='playing'?'current':''}`;
    element.innerHTML=`<div class="avatar avatar-${player.avatar||0}" title="${escapeHTML(avatar.name)}">${avatar.emoji}</div><div class="player-name">${escapeHTML(player.nickname)}${playerIndex===state.you?'（你）':''}</div><div class="score">${player.score}</div><small>${game.settings.mode==='coop'?'一起找到':'個人找到'} · ${player.connected?'已連線':'暫時離線'}</small><div class="basket" aria-label="貓咪籃子">${Array.from({length:player.score},(_,i)=>`<span class="basket-cat" style="animation-delay:${Math.min(i*.02,.3)}s">🐾</span>`).join('')}</div>`;
  }
  const board=$('#board'),size=game.puzzle.size,cellSize=Math.max(18,Math.min(30,(innerHeight-190)/size,(innerWidth-390)/size));
  board.style.setProperty('--n',size);board.style.setProperty('--s',`${cellSize}px`);board.innerHTML='';
  for(let index=0;index<size*size;index++){
    const cell=document.createElement('button'),region=game.puzzle.regions[index],row=Math.floor(index/size),column=index%size;
    cell.className='cell';cell.dataset.index=index;cell.setAttribute('role','gridcell');cell.setAttribute('aria-label',`第 ${row+1} 行，第 ${column+1} 列，區域 ${region+1}`);cell.title=`行 ${row+1}｜列 ${column+1}｜區域 ${region+1}`;cell.style.setProperty('--bg',colors[region%colors.length]);
    if(column===size-1||game.puzzle.regions[index+1]!==region)cell.classList.add('er');
    if(row===size-1||game.puzzle.regions[index+size]!==region)cell.classList.add('eb');
    if(game.found.includes(index)){cell.classList.add('cat');cell.disabled=true;cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，已找到貓`)}
    else if(game.misses.includes(index)){const clue=game.clues[index]??0;cell.classList.add('opened',`clue-${clue}`);cell.textContent=String(clue);cell.disabled=true;cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，已翻空格，周圍有 ${clue} 隻貓`)}
    else if(excluded(game,index)){cell.classList.add('auto-x');cell.disabled=true;cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，規則自動排除`)}
    else if(state.notes.has(index)){cell.classList.add('note');cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，私人筆記`)}
    if(state.mode==='guess'&&game.turn!==state.you)cell.disabled=true;
    cell.onclick=()=>{if(state.mode==='note'){state.notes.has(index)?state.notes.delete(index):state.notes.add(index);saveLocal();render();return}const action={type:'guess',index,turnId:game.turnId,actionId:crypto.randomUUID()};state.role==='host'?act(0,action):send({type:'action',action})};
    board.appendChild(cell);
  }
  $('#pass').disabled=game.turn!==state.you;
  if(game.status==='finished'&&!$('#result').open){
    $('#resultTitle').textContent=game.winner==='coop'?'共同成功！全部貓都回家了':game.winner==='tie'?'平手！':game.winner===state.you?'你贏了！':'下一局再加油！';
    $('#resultScore').textContent=game.winner==='coop'?`你們一起找到 ${game.found.length} 隻｜個人紀念 ${game.players[0].score}＋${game.players[1].score}`:`${game.players[0].score}：${game.players[1].score}`;$('#result').showModal();
  }
  state.observed={found:game.found.length,misses:game.misses.length,finished:game.status==='finished',turn:game.turn,eventAt:Math.max(state.observed.eventAt,game.lastEvent?.at||0)};
  if(unseen)requestAnimationFrame(()=>playVisualEvent(game.lastEvent));
}
render=renderV2;

setInterval(()=>{
  const game=state.game; if (!game) return;
  if (game.deadline) $('#timer').textContent=Math.max(0,Math.ceil((game.deadline-Date.now())/1000));
  if (state.role==='host'&&game.status==='playing'&&Date.now()>=game.deadline) { switchTurn(); broadcast(); }
},250);

function renderAvatarChoices(){
  const root=$('#avatarChoices');root.innerHTML='';
  AVATARS.forEach((avatar,index)=>{const button=document.createElement('button');button.type='button';button.className=`avatar-choice ${state.avatar===index?'selected':''}`;button.dataset.avatar=index;button.setAttribute('aria-label',avatar.name);button.innerHTML=`<span class="avatar avatar-${index}">${avatar.emoji}</span><small>${avatar.name}</small>`;button.onclick=()=>{state.avatar=index;localStorage.catAvatar=String(index);renderAvatarChoices()};root.appendChild(button)});
}
function updateModeDescription(){const info=MODE_INFO[$('#gameMode').value];$('#modeDescription').textContent=info.description}
renderAvatarChoices();updateModeDescription();$('#gameMode').onchange=updateModeDescription;
$('#helpButton').onclick=()=>$('#helpDialog').showModal();
$('#closeHelp').onclick=()=>$('#helpDialog').close();
$('#helpDialog').addEventListener('click',event=>{if(event.target===$('#helpDialog'))$('#helpDialog').close()});

$('#host').onclick=()=>{try{startPeerHost(false)}catch(error){toast(error.message)}};
$('#join').onclick=()=>{try{startPeerGuest()}catch(error){toast(error.message)}};
$('#manualHost').onclick=()=>manualHost(false).catch(error=>toast(error.message));
$('#manualJoin').onclick=manualJoin;
$('#resume').onclick=()=>resumeHost().catch(error=>toast(error.message));
$('#applyCode').onclick=async()=>{
  try {
    if (state.role==='host') { await useAnswer($('#inCode').value); $('#setupStatus').textContent='已套用回覆，正在建立連線'; }
    else { $('#outCode').value=await useOffer($('#inCode').value); $('#setupStatus').textContent='請把上方回覆碼傳回房主'; }
  } catch (error) { toast(`代碼無效：${error.message}`); }
};
$('#copyCode').onclick=()=>navigator.clipboard.writeText($('#outCode').value).then(()=>toast('已複製'));
$('#guessMode').onclick=()=>{state.mode='guess';$('#guessMode').classList.add('active');$('#noteMode').classList.remove('active');render()};
$('#noteMode').onclick=()=>{state.mode='note';$('#noteMode').classList.add('active');$('#guessMode').classList.remove('active');render()};
$('#pass').onclick=()=>{
  const action={type:'pass',turnId:state.game.turnId,actionId:crypto.randomUUID()}; state.role==='host'?act(0,action):send({type:'action',action});
};
$('#hint').onclick=()=>{
  const action={type:'hint',turnId:state.game.turnId,actionId:crypto.randomUUID()}; state.role==='host'?act(0,action):send({type:'action',action});
};
document.querySelectorAll('.emote').forEach(button=>button.onclick=()=>{
  const action={type:'emote',value:button.textContent,turnId:state.game.turnId,actionId:crypto.randomUUID()}; state.role==='host'?act(0,action):send({type:'action',action});
});
$('#mute').textContent=state.muted?'🔇':'🔊';
$('#mute').onclick=()=>{state.muted=!state.muted;localStorage.p2pMuted=state.muted?'1':'0';$('#mute').textContent=state.muted?'🔇':'🔊';if(!state.muted){unlockAudio();tone('cat')}};

$('#board').addEventListener('keydown',event=>{
  if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  const current=event.target.closest('.cell'); if (!current||!state.game) return;
  event.preventDefault(); const size=state.game.puzzle.size, index=+current.dataset.index;
  const delta={ArrowUp:-size,ArrowDown:size,ArrowLeft:-1,ArrowRight:1}[event.key];
  let next=index+delta;
  if (event.key==='ArrowLeft'&&index%size===0) next=index;
  if (event.key==='ArrowRight'&&index%size===size-1) next=index;
  boardCell(next)?.focus();
});
function boardCell(index) { return index>=0&&index<state.game.puzzle.size**2?$(`#board .cell[data-index="${index}"]`):null; }

let rematchVotes=new Set();
function rematchVote(who) {
  rematchVotes.add(who);
  if (state.role==='host'&&rematchVotes.size===2) {
    const game=state.game; game.round++; game.starter=1-game.starter; game.puzzle=makePuzzle(game.settings.size);
    game.status='playing'; game.turn=game.starter; game.turnId++; game.found=[]; game.misses=[]; game.clues={}; game.streak=0; game.winner=null;
    game.lastEvent={type:'rematch',at:Date.now()};game.hint=null; game.hintVotes=[]; game.actionIds=[]; game.players.forEach(player=>player.score=0); setDeadline();
    rematchVotes.clear(); broadcast(); $('#result').close();
  }
}
$('#rematch').onclick=()=>{if(state.role==='host')rematchVote(0);else send({type:'rematch'});toast('等待另一方同意再戰')};

if (sessionStorage.p2pHost) $('#resume').classList.remove('hidden');
const guestSaved=JSON.parse(sessionStorage.p2pGuest||'null');
if (guestSaved?.room?.startsWith('CAT-')) { $('#roomInput').value=guestSaved.room; $('#setupStatus').textContent='找到上次房號，可按「加入房間」重新連線'; }
try { state.notes=new Set(JSON.parse(sessionStorage.getItem('p2pNotes-guest')||'[]')); } catch {}
