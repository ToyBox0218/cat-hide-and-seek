'use strict';

const $ = selector => document.querySelector(selector);
const ICE = { iceServers: [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' }
] };
const state = {
  role: null, you: 0, peer: null, transport: null, rtc: null, game: null,
  notes: new Set(), intel: [], tool: null, yarnTargets: [], room: '', manual: false, matchAbort: null,
  pendingAction: null, selectedCell: null, zoom: +(localStorage.catBoardZoom||1), turnBannerTimer: null,
  muted: localStorage.p2pMuted === '1', volume: Number.isFinite(+localStorage.catAudioVolume)?Math.max(0,Math.min(1,+localStorage.catAudioVolume)):.45, sound:null, audio:null, audioUnlocked:false, uiSoundSequence:0,
  avatar:+localStorage.catAvatar||0,
  observed: { found: 0, misses: 0, finished: false, turn: null, status: null, eventAt: 0 },
  suppressNextTurnSound: false
};
function regionPalette(puzzle){return CatPalette.build(puzzle);}
const AVATARS=[
  {name:'橘子虎斑'},{name:'黑白燕尾'},{name:'奶油三花'},
  {name:'灰灰摺耳'},{name:'白桃暹羅'},{name:'蓬鬆棕貓'}
];
const NICK_ADJECTIVES=['奶油','星星','棉花','蜂蜜','布丁','小雨','泡泡','月光','焦糖','草莓','栗子','雲朵'];
const NICK_NOUNS=['虎斑','肉球','鈴鐺','鬍鬚','毛球','貓掌','小尾巴','探險家','瞇瞇眼','甜甜圈','小偵探','呼嚕'];
function catCharacter(variant,extra=''){return `<span class="cat-character cat-character-${variant%8} ${extra}" aria-hidden="true"><i class="cat-ears"></i><i class="cat-face"></i><i class="cat-mark"></i><i class="cat-eyes"></i><i class="cat-accessory"></i></span>`}
function playerAvatar(variant,extra=''){const selected=Number.isInteger(+variant)&&+variant>=0&&+variant<AVATARS.length?+variant:0;return `<span class="avatar-art avatar-art-${selected} lively-avatar ${extra}" data-avatar="${selected}" aria-hidden="true"></span>`}
function stableHash(value){let hash=2166136261;for(const char of String(value)){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619)}return hash>>>0}
const catVariant=(game,index)=>stableHash(`${game.puzzle.id}:${index}`)%8;
const MODE_INFO={
  survival:{label:'🐈 貓咪大逃殺',description:'2–4 位好友各找自己的貓，第二人進房開始 180 秒等候，也可由房主立即開賽。'},
  battle:{label:'🐾 貓咪大對決',description:'同時解自己的 6×6，連續找到貓可累加攻擊；找齊六隻換新盤，連鎖接續。'},
  basic:{label:'🔎 基本對戰',description:'猜空會公開空格並換手；找到最多貓獲勝。'},
  items:{label:'🐟 魚乾道具戰',description:'翻空格集魚乾；每輪最多用一個道具。'},
  treasure:{label:'🔔 寶藏派對',description:'鈴鐺貓值 2 分，普通貓 1 分，含少量運氣。'},
  coop:{label:'🤝 默契合作',description:'共享魚乾、道具與偵查，一起找完全部貓。'}
};
const tiles = {
  5:{c:[3,0,2,4,1],r:[1,1,0,0,0,1,1,0,3,3,2,2,2,3,3,2,4,3,3,3,4,4,3,3,3]},
  6:{c:[0,5,3,1,4,2],r:[0,0,0,0,0,0,0,0,0,1,1,1,0,0,2,2,1,1,0,3,2,2,2,2,3,3,5,4,4,4,3,3,5,5,5,5]},
  7:{c:[3,1,4,0,5,2,6],r:[1,1,0,0,2,2,2,3,1,0,0,2,2,2,3,3,4,4,2,4,6,3,3,4,4,4,4,6,3,5,4,4,4,4,6,3,5,5,4,5,6,6,5,5,5,5,5,6,6]}
};
const layouts = {
  6:[[6],[6],[6]],
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
  if(size===6)return CatBattle.generatePuzzle();
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
  const regionCounts=Array(size).fill(0);
  for(const region of regions){
    if(!Number.isInteger(region)||region<0||region>=size)throw new Error('Puzzle generation left an invalid region');
    regionCounts[region]++;
  }
  if(regionCounts.some(count=>count<3))throw new Error('Puzzle generation produced a region smaller than three cells');
  return { id:`p2p-${size}-${Date.now()}-${randomInt(1e6)}`, size, regions, solution };
}

const cleanSettings = input => ({
  size:['battle','survival'].includes(input.mode)?6:([6,12,20,24].includes(+input.size)?+input.size:20),
  maxHP:Math.max(50,Math.min(500,+input.maxHP||150)),
  mode:['basic','items','treasure','coop','battle','survival'].includes(input.mode)?input.mode:(input.mode==='scout'?'basic':'basic'),
  ...(input.mode==='survival'?{capacity:4,tabbyEnabled:input.tabbyEnabled!==false}:{}),
  turnSecondsA:Math.max(10,Math.min(180,+input.turnSecondsA||45)),
  turnSecondsB:Math.max(10,Math.min(180,+input.turnSecondsB||45)),
  streakLimitEnabled:input.streakLimitEnabled===true,
  streakLimit:Math.max(1,Math.min(24,+input.streakLimit||3))
});
const settingsFromUI = () => cleanSettings({
  size:+$('#size').value, mode:$('#gameMode').value, capacity:4,tabbyEnabled:$('#survivalTabby')?.checked!==false, maxHP:+$('#battleHP').value, turnSecondsA:+$('#secondsA').value, turnSecondsB:+$('#secondsB').value,
  streakLimitEnabled:$('#capEnabled').checked, streakLimit:+$('#cap').value
});

function newGame(size) {
  if(settingsFromUI().mode==='survival')return CatSurvival.create(settingsFromUI(),[{id:crypto.randomUUID(),nickname:$('#nick').value||'奶油虎斑',avatar:state.avatar}],{now:Date.now()});
  if(settingsFromUI().mode==='battle')return CatBattle.create(settingsFromUI(),[{nickname:$('#nick').value||'奶油虎斑',avatar:state.avatar,connected:true},{nickname:'等待貓友',avatar:1,connected:false}]);
  const puzzle=makePuzzle(size),settings=settingsFromUI(),treasureCount=size<=12?2:3;
  return {
    puzzle,settings,
    players:[{nickname:$('#nick').value||'奶油虎斑',avatar:state.avatar,score:0,cats:0,fish:0,connected:true},{nickname:'等待貓友',avatar:1,score:0,cats:0,fish:0,connected:false}],
    status:'lobby', starter:randomInt(2), turn:0, turnId:0, deadline:null,
    found:[], foundBy:{}, misses:[], clues:{}, streak:0, winner:null, round:0,
    treasures:shuffle(puzzle.solution.slice()).slice(0,treasureCount),sharedFish:0,sharedIntel:[],itemUsedThisTurn:false,shield:null,
    lastEvent:null, lastEmote:null, hint:null, hintVotes:[], actionIds:[]
  };
}

const publicGame = game => game.settings.mode==='survival'?CatSurvival.publicGame(game):game.settings.mode==='battle'?CatBattle.publicGame(game):({
  ...game,
  puzzle:{id:game.puzzle.id,size:game.puzzle.size,regions:game.puzzle.regions},
  players:game.players.map(player=>({...player})),
  foundTreasures:game.settings.mode==='treasure'?game.found.filter(index=>game.treasures.includes(index)):[],
  treasures:undefined, actionIds:undefined
});
function saveLocal() {
  if (!state.game||state.practice) return;
  if(state.game.settings.mode==='survival'){saveSurvivalNotes();return;}
  const key=state.role==='host'?'p2pHost':'p2pGuest';
  sessionStorage.setItem(key,JSON.stringify({room:state.room,game:state.game}));
  sessionStorage.setItem(`p2pNotes-${state.role}`,JSON.stringify([...state.notes]));
  sessionStorage.setItem(`p2pIntel-${state.role}`,JSON.stringify(state.intel));
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
  const game=state.game; game.turn=1-game.turn; game.turnId++; game.streak=0; game.itemUsedThisTurn=false; game.shield=null; game.lastEvent={type:'switch',who:game.turn,at:Date.now()}; setDeadline();
}
const itemMode=game=>['items','coop'].includes(game.settings.mode);
const fishBalance=(game,who)=>game.settings.mode==='coop'?game.sharedFish:game.players[who].fish;
function changeFish(game,who,delta){if(game.settings.mode==='coop')game.sharedFish=Math.max(0,Math.min(4,game.sharedFish+delta));else game.players[who].fish=Math.max(0,Math.min(4,game.players[who].fish+delta))}
function unresolved(game,index){return Number.isInteger(index)&&index>=0&&index<game.puzzle.size**2&&!game.found.includes(index)&&!game.misses.includes(index)}
const BOARD_DOUBLE_MS=300;
const hasIndependentBoards=game=>['battle','survival'].includes(game?.settings?.mode);
function localGestureBoard(){const game=state.game;return hasIndependentBoards(game)?game.boards?.[state.you]:game;}
function boardGestureContext(){
  const game=state.game,board=localGestureBoard();if(!game||!board?.puzzle)return `none:${state.gestureEpoch||0}`;
  const battle=hasIndependentBoards(game),survival=game.settings.mode==='survival',locked=survival?survivalMissLocked(game):battle&&typeof battleMissLocked==='function'&&battleMissLocked(game);
  return [state.role,state.you,game.id||game.puzzle.id,board.puzzle.id,game.status,game.pausedFrom||game._pausedFrom||'',
    battle?'':game.turnId,battle?'':game.turn,board.cooldownUntil||0,locked?'locked':'ready',
    (board.found||[]).join('.'),(board.misses||[]).join('.'),state.pendingAction?.actionId||'',state.tool||'',survival?`${game.players[state.you]?.id}:${game.players[state.you]?.status}:${game.players[state.you]?.connected}:${state.survivalLinkStatus}`:'',state.gestureEpoch||0].join('|');
}
function canMarkBoardCell(index,context=boardGestureContext()){
  const game=state.game,board=localGestureBoard();
  if(document.hidden||!game||!board?.puzzle||context!==boardGestureContext()||!Number.isInteger(index)||index<0||index>=board.puzzle.size**2||board.found.includes(index)||board.misses.includes(index))return false;
  if(game.settings.mode==='survival')return survivalCanMark(game);
  if(game.settings.mode==='battle')return (game.status==='playing'||(game.status==='paused'&&(game.pausedFrom||game._pausedFrom)!=='countdown'))&&!battleMissLocked(game);
  return game.status==='playing';
}
function canRevealBoardCell(index){
  const game=state.game,board=localGestureBoard();if(!canMarkBoardCell(index)||game.status!=='playing'||state.pendingAction||state.tool)return false;
  return hasIndependentBoards(game)?board.cooldownUntil<=Date.now()+(state.clockOffset||0):game.turn===state.you;
}
function cancelBoardGestures(reason='state-change'){
  state.cellGestures?.cancel();state.boardStrokes?.cancel(reason);state.gestureEpoch=(state.gestureEpoch||0)+1;state.boardGestureKey=boardGestureContext();state.lastToolCellGesture=null;state.revealClickGuard=null;
}
function syncBoardGestures(){
  const key=boardGestureContext();if(state.boardGestureKey!==key){state.cellGestures?.cancel();state.boardStrokes?.cancel('state-change');state.boardGestureKey=key;}state.boardStrokes?.sync();
  const board=localGestureBoard();let changed=false;
  if(board)for(const index of [...state.notes])if(board.found.includes(index)||board.misses.includes(index)){state.notes.delete(index);changed=true;}
  if(changed&&state.role)saveLocal();
}
function setPrivateCell(index,marked,context=boardGestureContext(),persist=true){
  if(!canMarkBoardCell(index,context)||state.notes.has(index)===marked)return false;
  marked?state.notes.add(index):state.notes.delete(index);state.selectedCell=null;
  state.noteVersions??=new Map();state.noteVersions.set(index,(state.noteVersions.get(index)||0)+1);if(persist)saveLocal();else state.strokeNotesDirty=true;
  const board=localGestureBoard(),cell=state.game.settings.mode==='survival'?$('#survivalBoard')?.querySelector(`.cell[data-index="${index}"]`):state.game.settings.mode==='battle'?$('.battle-side.local .battle-board')?.querySelector(`.cell[data-index="${index}"]`):boardCell(index);
  if(cell){const size=board.puzzle.size;cell.classList.toggle('note',marked);cell.classList.remove('selected-cell');cell.textContent=marked?'×':'';cell.dataset.renderState=marked?'note':'hidden';cell.setAttribute('aria-label',`第 ${Math.floor(index/size)+1} 行，第 ${index%size+1} 列，區域 ${board.puzzle.regions[index]+1}${marked?'，私人筆記，尚未確認':''}`);}
  return true;
}
function togglePrivateCell(index,context=boardGestureContext()){return setPrivateCell(index,!state.notes.has(index),context);}
function markGestureCell(index,context){
  const before=state.notes.has(index);if(!setPrivateCell(index,!before,context))return false;
  const version=state.noteVersions.get(index);let used=false;
  return ()=>{if(used)return false;used=true;return context===boardGestureContext()&&state.noteVersions.get(index)===version?setPrivateCell(index,before,context):false;};
}
function explainRevealBlock(index,{pressedBlocked=false}={}){
  const game=state.game,board=localGestureBoard();let message='';
  if(!game||!board||document.hidden)return;
  if(game.status==='countdown'||game.status==='lobby')message='讀秒結束後才能翻格';
  else if(game.status==='paused')message='對局暫停中，現在只能做私人記號';
  else if(game.status!=='playing')message='這局已結束，請開始新的一局';
  else if(game.settings.mode==='survival'&&survivalMissLocked(game)||game.settings.mode==='battle'&&battleMissLocked(game))message='鎖定倒數中，翻格與標記都暫停';
  else if(game.settings.mode==='survival'&&!survivalCanMark(game))message=game.players[state.you]?.status!=='active'?'你已離場，可以切換觀戰盤面':'連線中斷，正在嘗試回座';
  else if(state.pendingAction)message='正在等待翻格結果，請稍候';
  else if(state.tool)message='正在選擇道具目標，取消道具後可翻格';
  else if(!hasIndependentBoards(game)&&game.turn!==state.you)message='還沒輪到你，可以先單點做私人記號';
  else if(hasIndependentBoards(game)&&board.cooldownUntil>Date.now()+(state.clockOffset||0))message='剛找到貓，稍等一下再雙點翻格';
  else if(pressedBlocked)message='剛才按下時還不能翻格，請放開後重新雙點';
  if(message&&(state.lastInputNotice!==message||Date.now()-(state.lastInputNoticeAt||0)>900)){state.lastInputNotice=message;state.lastInputNoticeAt=Date.now();toast(message);}
}
function revealGestureCell(index,context){
  if(context!==boardGestureContext()||!canRevealBoardCell(index)){explainRevealBlock(index);return false;}
  state.revealClickGuard={index,boardId:localGestureBoard().puzzle.id,until:Date.now()+BOARD_DOUBLE_MS};
  if(state.game.settings.mode==='survival')return survivalChoose(index);
  if(state.game.settings.mode==='battle'){battleChoose(index);return true;}
  const game=state.game,action={type:'guess',index,turnId:game.turnId,actionId:crypto.randomUUID()};
  state.selectedCell=null;state.pendingAction={index,turnId:game.turnId,actionId:action.actionId};render();
  setTimeout(()=>{if(state.pendingAction?.actionId===action.actionId){state.pendingAction=null;render();}},1800);
  state.role==='host'?act(0,action):send({type:'action',action});return true;
}
function getBoardGestures(){
  if(!state.cellGestures)state.cellGestures=CatCellGestures.create({doubleMs:BOARD_DOUBLE_MS,cellCount:576,
    getContext:boardGestureContext,canAct:canMarkBoardCell,canReveal:canRevealBoardCell,onMark:markGestureCell,onReveal:revealGestureCell,onBlockedReveal:index=>explainRevealBlock(index,{pressedBlocked:true}),
    now:()=>typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:id=>clearTimeout(id)});
  syncBoardGestures();return state.cellGestures;
}
function cellMatchesCurrentBoard(cell){
  const game=state.game,board=localGestureBoard();return !!board&&cell.dataset.gameId===(game.id||game.puzzle.id)&&cell.dataset.boardId===board.puzzle.id;
}
function rolloverGestureSuppressed(index){const guard=state.revealClickGuard;return !!guard&&guard.index===index&&guard.boardId!==localGestureBoard()?.puzzle.id&&Date.now()<guard.until;}
function toolGestureSuppressed(index){const guard=state.lastToolCellGesture,board=localGestureBoard();return !!guard&&guard.boardId===board?.puzzle.id&&guard.index===index&&Date.now()<guard.until;}
function captureBoardPress(cell,event){
  const index=+cell.dataset.index,context=boardGestureContext();
  if(event?.button>0)return;
  cell.boardCancelled=false;cell.boardToolIntent=null;
  if(event?.key)cell.boardPointerState=null;
  if(cell.boardPressIntent)state.cellGestures?.cancelPress(cell.boardPressIntent);cell.boardPressIntent=null;
  if(state.tool&&!hasIndependentBoards(state.game)){
    cell.boardToolIntent={context,epoch:state.gestureEpoch||0,tool:state.tool,allowed:cellMatchesCurrentBoard(cell)&&canMarkBoardCell(index,context)&&state.game.turn===state.you&&!state.pendingAction&&!toolGestureSuppressed(index)};return;
  }
  const gestures=getBoardGestures(),intent=gestures.press(index,{pointerType:event?.pointerType||(event?.key?'keyboard':'mouse'),timeStamp:event?.timeStamp});
  if(!cellMatchesCurrentBoard(cell)||toolGestureSuppressed(index)||rolloverGestureSuppressed(index))gestures.cancelPress(intent);
  cell.boardPressIntent=intent;
}
function cancelCellPress(cell){
  if(cell.boardPressIntent)state.cellGestures?.cancelPress(cell.boardPressIntent);
  cell.boardPressIntent=null;cell.boardToolIntent={cancelled:true};cell.boardCancelled=true;
}
function activateBoardCell(cell,event={}){
  if(event.button>0)return;
  if(cell.boardPointerState)finishBoardStroke({...pointerEventValues(event),pointerId:cell.boardPointerState.id,pointerType:cell.boardPointerState.type},cell);
  const index=+cell.dataset.index,intent=cell.boardPressIntent,toolIntent=cell.boardToolIntent,pointer=cell.boardPointerState;
  cell.boardPressIntent=null;cell.boardToolIntent=null;cell.boardPointerState=null;
  if(pointer?.consumed||(!intent&&Date.now()<(state.strokeClickSuppressedUntil||0)))return;
  if(event.button>0||!cellMatchesCurrentBoard(cell)||toolGestureSuppressed(index)||rolloverGestureSuppressed(index)||cell.boardCancelled){cell.boardCancelled=false;return;}
  if(toolIntent||state.tool){
    const captured=toolIntent||{context:boardGestureContext(),epoch:state.gestureEpoch||0,tool:state.tool,allowed:event.detail==null||event.detail===0};
    if(captured.cancelled||!captured.allowed||captured.context!==boardGestureContext()||captured.epoch!==(state.gestureEpoch||0)||captured.tool!==state.tool||!canMarkBoardCell(index)||state.game.turn!==state.you||state.pendingAction)return;
    state.cellGestures?.cancel();state.lastToolCellGesture={index,boardId:localGestureBoard().puzzle.id,until:Date.now()+BOARD_DOUBLE_MS};
    if(state.tool==='magnifier'){sendItem({item:'magnifier',target:index});return;}
    if(state.tool==='yarn'){state.yarnTargets.includes(index)?state.yarnTargets=state.yarnTargets.filter(value=>value!==index):state.yarnTargets.length<3&&state.yarnTargets.push(index);render();return;}
    return;
  }
  const gestures=getBoardGestures();
  if(event.detail>0&&!intent)return;
  gestures.activate(intent||gestures.press(index,{pointerType:'keyboard',timeStamp:event.timeStamp}),{detail:event.detail||0,timeStamp:event.timeStamp});
}
function boardCellKeydown(event){
  if(['Enter',' ','Spacebar'].includes(event.key)){if(event.repeat){event.preventDefault();return;}event.currentTarget.boardCancelled=false;captureBoardPress(event.currentTarget,event);return;}
  if(state.game?.settings.mode==='survival')survivalKeydown(event);else if(state.game?.settings.mode==='battle')battleKeydown(event);
}
function wireBoardCell(cell,index){
  const game=state.game,board=localGestureBoard();cell.dataset.gameId=game.id||game.puzzle.id;cell.dataset.boardId=board.puzzle.id;
  cell.onpointerdown=event=>{if(event.button>0)return;cell.boardCancelled=false;if(event.isPrimary!==false)captureBoardPress(cell,event);startBoardStroke(cell,event);};
  cell.onpointercancel=event=>{cancelCellPress(cell);cancelBoardStrokePointer(event);};cell.onlostpointercapture=event=>{if(state.boardStrokeCapture?.cell===cell)cancelBoardStrokePointer(event,'lostcapture');};cell.onblur=()=>{cancelCellPress(cell);const pointer=cell.boardPointerState;if(pointer&&state.boardPointerRecords?.get(pointer.id)===pointer)cancelBoardStrokePointer({pointerId:pointer.id},'cell-blur');};
  cell.onclick=event=>activateBoardCell(cell,event);cell.onkeydown=boardCellKeydown;
}
// Pointer strokes are private ADD-only input, separate from click recognition.
const boardInputNow=()=>typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now();
function boardAllowsStroke(context){
  const game=state.game;if(!game||document.hidden||context!==boardGestureContext())return false;
  if(game.settings.mode==='survival')return survivalCanMark(game);
  return game.settings.mode==='battle'?battlePhaseAllowsNotes(game)&&!battleMissLocked(game):game.status==='playing';
}
function playableGrid(){return state.game?.settings.mode==='survival'?$('#survivalBoard'):state.game?.settings.mode==='battle'?$('.battle-side.local .battle-board'):$('#board');}
function strokeGeometry(){
  const grid=playableGrid();if(!grid)return null;
  const bounds=grid.getBoundingClientRect(),key=boardGestureContext(),old=state.strokeGeometry;
  if(old&&old.grid===grid&&old.key===key&&['left','top','width','height'].every(name=>old.bounds[name]===bounds[name]))return old;
  const cells=Array.from(grid.children).map(cell=>({index:+cell.dataset.index,rect:cell.getBoundingClientRect()}));
  return state.strokeGeometry={grid,key,bounds,cells};
}
function strokeCellAt(x,y){
  const geometry=strokeGeometry();if(!geometry)return null;
  const hit=document.elementFromPoint?.(x,y)?.closest?.('.cell');
  if(hit&&geometry.grid.contains?.(hit)&&cellMatchesCurrentBoard(hit))return +hit.dataset.index;
  if(document.elementFromPoint)return null;
  return geometry.cells.find(({rect})=>x>=rect.left&&x<rect.left+rect.width&&y>=rect.top&&y<rect.top+rect.height)?.index??null;
}
function strokeIndicesBetween(from,to,context){
  if(context!==boardGestureContext())return [];
  const geometry=strokeGeometry();if(!geometry)return [];
  const dx=to.x-from.x,dy=to.y-from.y,hits=[];
  for(const {index,rect} of geometry.cells){
    const inset=Math.min(.5,rect.width/8,rect.height/8),left=rect.left+inset,right=rect.left+rect.width-inset,top=rect.top+inset,bottom=rect.top+rect.height-inset;
    let enter=0,leave=1,valid=true;
    for(const [start,delta,min,max] of [[from.x,dx,left,right],[from.y,dy,top,bottom]]){
      if(delta===0){if(start<min||start>max){valid=false;break;}continue;}
      const a=(min-start)/delta,b=(max-start)/delta;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>leave){valid=false;break;}
    }
    if(valid)hits.push({index,enter});
  }
  return hits.sort((a,b)=>a.enter-b.enter).map(hit=>hit.index);
}
function releaseBoardStrokeCapture(){
  const capture=state.boardStrokeCapture;state.boardStrokeCapture=null;
  if(capture)try{if(capture.cell.hasPointerCapture?.(capture.id))capture.cell.releasePointerCapture(capture.id);}catch{}
}
function getBoardStrokes(){
  if(!state.boardStrokes)state.boardStrokes=CatBoardStrokes.create({getContext:boardGestureContext,canAct:boardAllowsStroke,
    canMark:(index,context)=>!state.tool&&canMarkBoardCell(index,context),onAdd:(index,context)=>!state.tool&&setPrivateCell(index,true,context,false),
    indicesBetween:strokeIndicesBetween,now:boardInputNow,
    onStart:event=>{
      state.cellGestures?.cancel();
      if(state.tool){state.boardStrokes.cancel('tool-target');return;}
      const record=state.boardPointerRecords?.get(event.id);if(record){record.consumed=true;cancelCellPress(record.cell);}
      const grid=playableGrid();grid?.classList.add('marking-stroke');
      if(record?.cell)try{record.cell.setPointerCapture?.(event.id);state.boardStrokeCapture={cell:record.cell,id:event.id};}catch{}
    },
    onEnd:event=>{
      const record=state.boardPointerRecords?.get(event.id);if(record)record.consumed=event.consumed;
      if(event.consumed){state.cellGestures?.cancel();state.strokeClickSuppressedUntil=Date.now()+600;if(record?.cell)cancelCellPress(record.cell);}
      playableGrid()?.classList.remove('marking-stroke');releaseBoardStrokeCapture();
      if(state.strokeNotesDirty){state.strokeNotesDirty=false;saveLocal();}
    }});
  return state.boardStrokes;
}
function pointerEventValues(event){
  return {pointerId:event.pointerId,pointerType:event.pointerType,button:event.button,buttons:event.buttons,isPrimary:event.isPrimary,clientX:event.clientX,clientY:event.clientY,timeStamp:event.timeStamp};
}
function pointerStrokeEvent(event,record){
  const x=Number.isFinite(event.clientX)?event.clientX:record?.x,y=Number.isFinite(event.clientY)?event.clientY:record?.y;
  let now=boardInputNow();const stamp=event.timeStamp;
  if(record&&Number.isFinite(stamp)&&Number.isFinite(record.stamp)&&stamp>=record.stamp&&(stamp>=1e12)===(record.stamp>=1e12))now=record.began+(stamp-record.stamp);
  return {id:event.pointerId??record?.id??1,type:event.pointerType||record?.type||'mouse',button:event.button??0,buttons:event.buttons,primary:event.isPrimary!==false,x,y,index:strokeCellAt(x,y),now};
}
function startBoardStroke(cell,event){
  if(event.button>0)return;
  const rect=cell.getBoundingClientRect(),id=event.pointerId??1;
  const record={id,type:event.pointerType||'mouse',cell,consumed:false,x:Number.isFinite(event.clientX)?event.clientX:rect.left+rect.width/2,y:Number.isFinite(event.clientY)?event.clientY:rect.top+rect.height/2,began:boardInputNow(),stamp:event.timeStamp};
  state.boardPointerRecords??=new Map();state.boardPointerRecords.set(id,record);cell.boardPointerState=record;
  const outcome=getBoardStrokes().down({...pointerStrokeEvent(event,record),index:+cell.dataset.index});
  if(outcome.consumed){record.consumed=true;cancelCellPress(cell);state.cellGestures?.cancel();}
}
function observeExtraBoardPointer(event){
  if(event.button>0||!state.boardStrokes?.state().pointerCount||state.boardPointerRecords?.has(event.pointerId??1))return;
  const id=event.pointerId??1;state.boardPointerRecords??=new Map();
  const record={id,type:event.pointerType||'mouse',cell:null,consumed:true,x:event.clientX,y:event.clientY,began:boardInputNow(),stamp:event.timeStamp};
  state.boardPointerRecords.set(id,record);state.boardStrokes.down({...pointerStrokeEvent(event,record),index:null});state.cellGestures?.cancel();
}
function moveBoardStroke(event){
  if(!state.boardStrokes||!state.boardPointerRecords?.has(event.pointerId??1))return;
  const record=state.boardPointerRecords.get(event.pointerId??1),coalesced=event.getCoalescedEvents?.()||[];
  if(record.type!=='touch'&&event.buttons!==undefined&&!(event.buttons&1)){cancelBoardStrokePointer(event,'released');return;}
  for(const sample of [...coalesced,event]){
    const outcome=state.boardStrokes.move(pointerStrokeEvent({...pointerEventValues(sample),pointerId:event.pointerId,pointerType:event.pointerType},record));
    if(outcome.consumed){record.consumed=true;state.cellGestures?.cancel();if(record.cell)cancelCellPress(record.cell);}
  }
  if(state.boardStrokes.state().active&&event.cancelable)event.preventDefault();
}
function finishBoardStroke(event,cell=null){
  const id=event.pointerId??cell?.boardPointerState?.id??1,current=state.boardPointerRecords?.get(id);
  if(cell&&current&&current!==cell.boardPointerState)return;
  const record=current||cell?.boardPointerState;
  if(!state.boardStrokes||!record)return;
  const outcome=state.boardStrokes.up(pointerStrokeEvent({...pointerEventValues(event),pointerId:id},record));
  record.consumed=record.consumed||outcome.consumed;state.boardPointerRecords?.delete(id);
}
function cancelBoardStrokePointer(event,reason='pointercancel'){
  const id=event.pointerId??1,record=state.boardPointerRecords?.get(id);
  state.boardStrokes?.pointerCancel({id},reason);
  if(record){record.consumed=true;if(record.cell)cancelCellPress(record.cell);}state.boardPointerRecords?.delete(id);
}
function resetBoardStrokes(reason){
  state.boardStrokes?.reset(reason);
  for(const record of state.boardPointerRecords?.values()||[]){record.consumed=true;if(record.cell)cancelCellPress(record.cell);}
  state.boardPointerRecords?.clear();state.strokeGeometry=null;releaseBoardStrokeCapture();
}
document.addEventListener('pointerdown',observeExtraBoardPointer);
document.addEventListener('pointermove',moveBoardStroke,{passive:false});
document.addEventListener('pointerup',event=>finishBoardStroke(event));
document.addEventListener('pointercancel',event=>cancelBoardStrokePointer(event));
document.addEventListener('scroll',()=>{if(state.boardStrokes?.state().tracking)cancelBoardGestures('scroll');},true);
window.addEventListener('resize',()=>cancelBoardGestures('resize'));
function connectedTargets(size,targets){const set=new Set(targets),seen=new Set([targets[0]]),queue=[targets[0]];while(queue.length){const i=queue.shift(),r=Math.floor(i/size),c=i%size;for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]){const rr=r+dr,cc=c+dc,n=rr*size+cc;if(rr>=0&&rr<size&&cc>=0&&cc<size&&set.has(n)&&!seen.has(n)){seen.add(n);queue.push(n)}}}return seen.size===targets.length}
function deliverIntel(game,who,intel){
  if(game.settings.mode==='coop'){game.sharedIntel.push(intel);if(game.sharedIntel.length>12)game.sharedIntel.shift();return}
  if(who===0){state.intel.push(intel);saveLocal()}else send({type:'intel',intel});
}
function applyItem(who,action){
  const game=state.game,costs={magnifier:2,yarn:2,shield:3,hourglass:2},kind=action.item,cost=costs[kind];
  if(!itemMode(game)||who!==game.turn||action.turnId!==game.turnId||game.itemUsedThisTurn||!cost||fishBalance(game,who)<cost||Date.now()>=game.deadline)return false;
  let intel=null;
  if(kind==='magnifier'){
    const target=+action.target;if(!unresolved(game,target))return false;
    intel={type:'magnifier',targets:[target],count:neighborCatCount(game.puzzle,target),at:Date.now()};
  }else if(kind==='yarn'){
    const targets=[...new Set((action.targets||[]).map(Number))];
    if(targets.length<2||targets.length>3||targets.some(index=>!unresolved(game,index))||!connectedTargets(game.puzzle.size,targets))return false;
    const region=game.puzzle.regions[targets[0]];if(targets.some(index=>game.puzzle.regions[index]!==region))return false;
    const unresolvedRegion=game.puzzle.regions.reduce((list,value,index)=>value===region&&unresolved(game,index)?[...list,index]:list,[]);
    if(targets.length>=unresolvedRegion.length)return false;
    intel={type:'yarn',targets,hasCat:targets.some(index=>game.puzzle.solution.includes(index))?1:0,at:Date.now()};
  }else if(kind==='shield')game.shield={owner:who};
  else if(kind==='hourglass')game.deadline+=10000;
  changeFish(game,who,-cost);game.itemUsedThisTurn=true;game.lastEvent={type:'item',kind,who,at:Date.now()};if(intel)deliverIntel(game,who,intel);broadcast();return true;
}
// Used only when both players explicitly request the textual teaching hint.
// Never use logical deductions to reveal, disable or style unopened cells.
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
  if(game?.settings.mode==='survival')return state.survivalSession?.submit(action);
  if(game?.settings.mode==='battle'){if(!action||typeof action!=='object')return;const result=CatBattle.act(game,who,action,Date.now());if(who===1)send({type:'battleAck',actionId:action.actionId,accepted:result.accepted,reason:result.reason});else state.pendingAction=null;broadcast();return result;}
  if (!game||game.status!=='playing'||rememberAction(game,action.actionId)) return;
  if (action.type==='emote') { game.lastEmote={from:who,value:String(action.value).slice(0,20)}; broadcast(); return; }
  if (action.type==='hint') {
    if (!game.hintVotes.includes(who)) game.hintVotes.push(who);
    if (game.hintVotes.length===2) { game.hint=teachingHint(game); game.hintVotes=[]; }
    broadcast(); return;
  }
  if(action.type==='item'){applyItem(who,action);return}
  if (action.turnId!==game.turnId||who!==game.turn) return;
  if (Date.now()>=game.deadline) { switchTurn(); broadcast(); return; }
  if (action.type==='pass') { switchTurn(); broadcast(); return; }
  if (action.type!=='guess') return;
  const index=+action.index;
  if (!Number.isInteger(index)||index<0||index>=game.puzzle.size**2||game.found.includes(index)||game.misses.includes(index)) return;
  if (game.puzzle.solution.includes(index)) {
    const points=game.settings.mode==='treasure'&&game.treasures.includes(index)?2:1;
    game.found.push(index); game.foundBy[index]=who; game.players[who].score+=points; game.players[who].cats=(game.players[who].cats||0)+1; game.streak++; game.hint=null; game.hintVotes=[];
    game.lastEvent={type:'cat',index,who,streak:game.streak,at:Date.now()};
    if (game.found.length===game.puzzle.size) {
      game.status='finished'; game.deadline=null;
      game.winner=game.settings.mode==='coop'?'coop':game.players[0].score===game.players[1].score?'tie':game.players[0].score>game.players[1].score?0:1;
    } else if (game.settings.streakLimitEnabled&&game.streak>=game.settings.streakLimit) { const catEvent=game.lastEvent;switchTurn();game.lastEvent={...catEvent,next:game.turn}; }
    else game.turnId++;
  } else {
    game.misses.push(index);
    game.lastEvent={type:'miss',index,who,at:Date.now()};
    if(game.shield?.owner===who){game.shield=null;game.turnId++;game.lastEvent={type:'shield',index,who,at:Date.now()}}
    else{if(itemMode(game))changeFish(game,who,1);switchTurn();game.lastEvent={type:'miss',index,who,next:game.turn,at:Date.now()}}
  }
  broadcast();
}

function onMessage(message) {
  let data;
  try { data=typeof message==='string'?JSON.parse(message):message; } catch { return; }
  if(!data||typeof data!=='object')return;
  if(data.type==='ping'){send({type:'pong',echo:data.sentAt,serverTime:Date.now()});return;}
  if(data.type==='pong'){
    state.lastPong=Date.now();
    if(state.role==='guest'&&Number.isFinite(data.echo)&&Number.isFinite(data.serverTime))syncBattleClock(data.echo,data.serverTime);
    return;
  }
  if(data.type==='battleAck'&&state.role==='guest'){
    if(state.pendingAction?.actionId===data.actionId)state.pendingAction=null;
    render();return;
  }
  if(state.role==='host'){
    const game=state.game;if(!game)return;
    if(data.type==='hello'){
      game.players[1].nickname=String(data.nickname||'貓友').slice(0,16);
      game.players[1].avatar=Math.max(0,Math.min(AVATARS.length-1,+data.avatar||0));
      game.players[1].connected=true;
      if(game.settings.mode==='battle'){
        state.pendingAction=null;
        if(game.status==='lobby'||game.status==='paused'){
          state.awaitingBattleReady=game.id;
          send({type:'battlePrepare',gameId:game.id});
        }
      }else if(game.status==='lobby'){
        game.status='playing';game.turn=game.starter;game.turnId++;setDeadline();
      }
      broadcast();
    }else if(data.type==='battleSync'&&game.settings.mode==='battle'&&data.gameId===game.id&&state.awaitingBattleReady===game.id&&Number.isFinite(data.sentAt)){
      send({type:'battleClock',gameId:game.id,echo:data.sentAt,serverTime:Date.now()});
    }else if(data.type==='battleReady'&&game.settings.mode==='battle'&&data.gameId===game.id&&state.awaitingBattleReady===game.id){
      state.awaitingBattleReady=null;
      if(game.status==='lobby')CatBattle.start(game,Date.now());
      else if(game.status==='paused'){
        if(Date.now()-(game.pausedAt||Date.now())>=60000)CatBattle.abort(game);
        else CatBattle.reconnect(game,Date.now());
      }
      state.disconnectAt=null;state.suppressBattleFX=true;broadcast();
    }else if(data.type==='action')act(1,data.action);
    else if(data.type==='rematch')rematchVote(1);
    else if(data.type==='battleAbort'&&game.settings.mode==='battle'){CatBattle.abort(game);broadcast();}
  }else if(data.type==='battlePrepare'&&typeof data.gameId==='string'){
    state.pendingBattleSync=data.gameId;state.suppressBattleFX=true;
    send({type:'battleSync',gameId:data.gameId,sentAt:Date.now()});
  }else if(data.type==='battleClock'&&data.gameId===state.pendingBattleSync&&Number.isFinite(data.echo)&&Number.isFinite(data.serverTime)){
    if(!syncBattleClock(data.echo,data.serverTime))return;
    state.pendingBattleSync=null;send({type:'battleReady',gameId:data.gameId});
  }else if(data.type==='state'){
    if(!data.state?.settings||!Array.isArray(data.state.players))return;
    const previous=state.game,incoming=data.state,battle=incoming.settings.mode==='battle';
    if(battle&&previous?.id===incoming.id&&Number.isFinite(previous.revision)&&incoming.revision<previous.revision)return;
    const previousPuzzle=previous?.settings?.mode==='battle'?previous.boards[state.you].puzzle.id:previous?.puzzle?.id;
    state.game=incoming;
    if(!battle&&(!previous||previous.puzzle?.id!==incoming.puzzle?.id))state.suppressLegacyAudio=true;
    if(battle){
      if(!state.clockSyncedAt&&Number.isFinite(incoming.serverTime))state.clockOffset=incoming.serverTime-Date.now();
      if(!previous||previous.id!==incoming.id||previous.status==='paused')state.suppressBattleFX=true;
      if(incoming.status!=='paused')state.disconnectAt=null;
      if(['paused','aborted','finished'].includes(incoming.status)&&typeof clearBattleFX==='function')clearBattleFX();
    }
    const currentPuzzle=battle?incoming.boards[state.you].puzzle.id:incoming.puzzle.id;
    if(previousPuzzle&&previousPuzzle!==currentPuzzle){state.intel=[];state.notes.clear();state.tool=null;state.yarnTargets=[];}
    saveLocal();render();
  }else if(data.type==='intel'){
    state.intel.push(data.intel);if(state.intel.length>12)state.intel.shift();saveLocal();render();
  }
}
function syncBattleClock(sentAt,serverTime){
  const receivedAt=Date.now(),rtt=receivedAt-sentAt;
  if(!Number.isFinite(rtt)||rtt<0||rtt>10000)return false;
  if(!Number.isFinite(state.bestClockRtt)||rtt<=state.bestClockRtt+25){
    state.clockOffset=serverTime-(sentAt+receivedAt)/2;state.bestClockRtt=rtt;state.clockSyncedAt=receivedAt;
  }
  return true;
}

function onOpen() {
  cancelBoardGestures();
  state.suppressLegacyAudio=true;
  state.lastPong=Date.now();state.bestClockRtt=Infinity;state.clockSyncedAt=null;state.suppressBattleFX=true;if(state.game?.settings.mode!=='battle')state.disconnectAt=null;
  if (state.role==='guest') state.suppressNextTurnSound=true;
  $('#connection').textContent='P2P 已連線';
  if (state.role==='host') { state.game.players[1].connected=true; broadcast(); }
  else send({type:'hello',nickname:$('#nick').value||'小花貓',avatar:state.avatar});
}
function onClose() {
  cancelBoardGestures();
  stopGameAudio();state.suppressLegacyAudio=true;
  $('#connection').textContent='連線中斷－盤面已保留';
  if(state.game?.settings.mode==='battle'){if(['playing','countdown','paused'].includes(state.game.status)){if(state.role==='host')CatBattle.pause(state.game,Date.now());else if(state.game.status!=='paused'){state.game.pausedFrom=state.game.status;state.game.countdownRemaining=state.game.status==='countdown'?Math.max(0,state.game.startAt-(Date.now()+(state.clockOffset||0))):null;state.game.status='paused';state.game.pausedAt=Date.now()+(state.clockOffset||0);}state.disconnectAt??=Date.now();state.pendingAction=null;}}
  state.suppressBattleFX=true;if(typeof clearBattleFX==='function')clearBattleFX();
  if (state.game) { state.game.players[1-state.you].connected=false; saveLocal(); render(); }
}
function attachPeerConnection(connection) {
  state.transport={open:()=>connection.open,send:value=>connection.send(value),close:()=>connection.close()};
  const generation=state.transportGeneration=(state.transportGeneration||0)+1;let survivalRouted=false;const current=callback=>(...args)=>{if(generation===state.transportGeneration)callback(...args)};
  connection.on('open',current(()=>{if(!survivalRouted)onOpen();}));
  connection.on('data',current(message=>{if(survivalRouted)return;if(message?.protocol==='cat-survival-v1'&&message.type==='offer'&&state.role==='guest'){survivalRouted=true;adoptSurvivalGuest(connection,message);return;}onMessage(message);}));
  connection.on('close',current(()=>{if(!survivalRouted)onClose();}));
  connection.on('error',error=>toast(`連線錯誤：${error.type||error.message}`));
}
function attachDataChannel(channel) {
  state.transport={open:()=>channel.readyState==='open',send:value=>channel.send(JSON.stringify(value)),close:()=>channel.close()};
  const generation=state.transportGeneration=(state.transportGeneration||0)+1;channel.onopen=()=>{if(generation===state.transportGeneration)onOpen()};channel.onclose=()=>{if(generation===state.transportGeneration)onClose()};
  channel.onmessage=event=>{if(generation===state.transportGeneration)onMessage(event.data)};
}

function peerOptions() { return {debug:1,config:ICE}; }
const ROOM_RE=/^CAT-(?:\d{4}|[A-Z0-9-]{6,})$/;
const SHORT_ROOM_RE=/^CAT-\d{4}$/;
const normalizeRoom=value=>String(value||'').trim().toUpperCase().replace(/\s+/g,'');
const randomRoom=()=>`CAT-${String(randomInt(10000)).padStart(4,'0')}`;
const peerIdForRoom=room=>SHORT_ROOM_RE.test(room)?`cat-hide-seek-v1-${room.toLowerCase()}`:room;
function showRoom(room){$('#roomInput').value=room;$('#room').textContent=`房號 ${room}`}
function startPeerHost(restored=false,forcedRoom=null,collisionAttempt=0) {
  if(settingsFromUI().mode==='survival')return startSurvivalHost({room:forcedRoom});
  state.practice=false;state.clockOffset=0;state.clockSyncedAt=null;state.role='host'; state.you=0; state.manual=false;
  if (!restored) { state.room=forcedRoom||randomRoom(); state.game=newGame(+$('#size').value); state.notes.clear();state.intel=[];state.tool=null;state.yarnTargets=[]; }
  $('#roomInput').value='';
  $('#setupStatus').textContent='正在向免費 PeerJS Cloud 登記房號…';
  const peer=new Peer(peerIdForRoom(state.room),peerOptions()); state.peer=peer;
  peer.on('open',()=>{$('#setupStatus').textContent=`房號 ${state.room}，請傳給另一位玩家`;showRoom(state.room);$('#roomField').classList.add('room-ready');$('#host').disabled=true;$('#host').textContent='房間已建立'});
  peer.on('connection',connection=>{if(state.transport?.open()){connection.close();return}attachPeerConnection(connection)});
  peer.on('error',error=>{
    if(error.type==='unavailable-id'&&!forcedRoom&&SHORT_ROOM_RE.test(state.room)&&collisionAttempt<24){peer.destroy();$('#setupStatus').textContent='房號剛好重複，正在自動換一組…';state.room=randomRoom();startPeerHost(true,null,collisionAttempt+1);return}
    const message=error.type==='unavailable-id'?'房號已被占用，請重新建立房間':error.type||error.message;
    toast(`PeerJS：${message}`); $('#setupStatus').textContent=`連線服務錯誤：${message}`;
  });
}
function startPeerGuest() {
  if(state.survivalSession){disposeSurvivalRoom('join-room');state.game=null;$('#game').classList.add('hidden');$('#setup').classList.remove('hidden');}
  const room=normalizeRoom($('#roomInput').value);
  const saved=JSON.parse(sessionStorage.p2pGuest||'null');
  if(saved?.room!==room){state.notes.clear();state.intel=[];state.tool=null;state.yarnTargets=[]}
  if (!ROOM_RE.test(room)) throw Error('請輸入房主顯示的 CAT- 房號');
  state.practice=false;state.role='guest'; state.you=1; state.room=room; state.manual=false;
  $('#setupStatus').textContent='正在透過 PeerJS Cloud 尋找房主…';
  const peer=new Peer(undefined,peerOptions()); state.peer=peer;
  peer.on('open',()=>{if(state.game?.settings.mode==='survival')return;attachPeerConnection(peer.connect(peerIdForRoom(room),{reliable:true,serialization:'json'}));});
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
  if(settingsFromUI().mode==='survival')throw Error('大逃殺請使用好友房號建立房間');
  state.practice=false;state.clockOffset=0;state.clockSyncedAt=null;state.role='host'; state.you=0; state.manual=true;
  if (!restored) { state.room='手動連線'; state.game=newGame(+$('#size').value); }
  $('#outCode').value=await makeOffer(); showManual('步驟 1：把邀請碼傳給對方，再貼回覆碼');
  $('#setupStatus').textContent='等待對方回覆碼';
}
function manualJoin() {
  state.practice=false;state.role='guest'; state.you=1; state.manual=true; state.room='手動連線';
  showManual('貼上房主邀請碼，產生回覆碼後傳回房主'); $('#setupStatus').textContent='請貼上邀請碼';
}
async function resumeHost() {
  const saved=JSON.parse(sessionStorage.p2pHost||'null');
  if(saved?.game?.settings?.mode==='battle'){if(!saved.game.boards?.every(board=>board.puzzle.solution))throw Error('沒有可恢復的房主局面');state.game=saved.game;state.suppressBattleFX=true;state.suppressLegacyAudio=true;CatBattle.pause(state.game,Date.now());state.game.players[0].connected=true;state.game.players[1].connected=false;state.disconnectAt=state.game.pausedAt||Date.now();syncSettingsUI(state.game.settings);state.room=randomRoom();state.notes=new Set(JSON.parse(sessionStorage.getItem('p2pNotes-host')||'[]'));startPeerHost(true);return}
  if (!saved?.game?.puzzle?.solution) throw Error('沒有可恢復的房主局面');
  state.suppressLegacyAudio=true;state.game=saved.game; state.game.settings=cleanSettings(state.game.settings||{}); state.game.clues=state.game.clues||{};
  state.game.players.forEach((player,index)=>{if(player.avatar===undefined)player.avatar=index;if(player.cats===undefined)player.cats=player.score||0;if(player.fish===undefined)player.fish=0});
  state.game.foundBy=state.game.foundBy||{};state.game.sharedFish=state.game.sharedFish||0;state.game.sharedIntel=state.game.sharedIntel||[];state.game.itemUsedThisTurn=Boolean(state.game.itemUsedThisTurn);state.game.shield=state.game.shield||null;
  state.game.treasures=state.game.treasures||shuffle(state.game.puzzle.solution.slice()).slice(0,state.game.puzzle.size<=12?2:3);
  syncSettingsUI(state.game.settings);
  state.room=randomRoom(); state.game.players[1].connected=false;
  state.notes=new Set(JSON.parse(sessionStorage.getItem('p2pNotes-host')||'[]'));
  state.intel=JSON.parse(sessionStorage.getItem('p2pIntel-host')||'[]');
  startPeerHost(true);
}

function getGameAudio(){
  if(!state.sound)state.sound=CatAudio.create({muted:state.muted,volume:state.volume,isHidden:()=>Boolean(document.hidden),samples:window.CAT_MEOW_SAMPLES});
  return state.sound;
}
function unlockAudio(){
  try{return getGameAudio().unlockFromGesture().then(unlocked=>{state.audioUnlocked=Boolean(unlocked);if(unlocked)getGameAudio().loadSamples().then(()=>syncAudioControls());return unlocked;}).catch(()=>false);}catch{return Promise.resolve(false);}
}
function soundCue(kind,options={}){return getGameAudio().play(kind,options);}
function tone(kind,options={}){return soundCue(({cat:'found',finish:'win',turn:'start'})[kind]||kind,options);}
function stopGameAudio(){state.sound?.stopAll();state.pendingUnlockCue=null;state.battleUnlockNoticeUntil=0;}
function prepareGameAudio(matchId,status){
  if(state.audioMatchId!==matchId){getGameAudio().resetMatch();state.audioMatchId=matchId;state.captureSoundEvents=new Set();state.audioGameStatus=null;state.battleTerminalCue=null;state.pendingUnlockCue=null;}
  if(state.audioGameStatus!==status){if(['paused','finished','aborted'].includes(status))stopGameAudio();state.audioGameStatus=status;}
}
function playCaptureSound(id,combo=1){state.captureSoundEvents??=new Set();if(state.captureSoundEvents.has(id))return false;state.captureSoundEvents.add(id);if(state.captureSoundEvents.size>128)state.captureSoundEvents.delete(state.captureSoundEvents.values().next().value);soundCue('meow',{id,combo});if(combo>1)soundCue('combo',{id,combo,delay:.14});return true;}
function playUICue(){return soundCue('ui',{id:`ui:${++state.uiSoundSequence}`});}
function syncAudioControls(){
  for(const id of ['#mute','#battleMute']){const button=$(id);if(button){button.textContent=state.muted?'🔇':'🔊';button.setAttribute('aria-pressed',String(state.muted));button.setAttribute('aria-label',state.muted?'開啟音效':'關閉音效');}}
  const volume=$('#soundVolume'),output=$('#soundVolumeValue');
  if(volume){volume.value=String(Math.round(state.volume*100));volume.setAttribute('aria-valuetext',`音量 ${Math.round(state.volume*100)}%`);}
  if(output)output.textContent=`${Math.round(state.volume*100)}%`;
  const sampleStatus=$('#meowLoadStatus'),audioState=state.sound?.getState();if(sampleStatus){sampleStatus.textContent=audioState?.loadedSamples?`已載入 ${audioState.loadedSamples} 組貓叫，隨機播放且不連續重複。`:audioState?.samplesStatus==='failed'?'貓叫錄音載入失敗，目前使用合成備用音效；請重新整理再試。':audioState?.samplesStatus==='loading'?'貓叫錄音載入中…':'首次操作後載入貓叫錄音；載入前會使用合成備用音效。';}
}
function observeLegacyAudio(game){
  const matchId=game.puzzle.id,initial=state.legacyAudioMatch!==matchId;
  prepareGameAudio(matchId,game.status);
  if(initial){state.legacyAudioMatch=matchId;state.legacyAudioEvents=new Set();state.legacyTerminalCue=null;}
  const silent=state.suppressLegacyAudio||document.hidden,event=game.lastEvent;
  state.suppressLegacyAudio=false;
  if(event){
    const id=`${matchId}:${event.type}:${event.at}:${event.index??''}:${event.who??''}:${event.streak??''}`;
    const seen=state.legacyAudioEvents;
    if(!seen.has(id)){
      seen.add(id);if(seen.size>100)seen.delete(seen.values().next().value);
      if(!silent&&(game.status==='playing'||(game.status==='finished'&&event.type==='cat'))){
        if(event.type==='cat')playCaptureSound(id,event.streak||1);
        else if(event.type==='miss')soundCue('miss',{id});
        else if(event.type==='switch'&&event.who===state.you)soundCue('start',{id});
        else if(['item','shield'].includes(event.type))soundCue('ui',{id});
      }
    }
  }
  if(game.status==='finished'&&state.legacyTerminalCue!==matchId){
    state.legacyTerminalCue=matchId;
    if(!silent)soundCue(game.winner==='coop'||game.winner==='tie'||game.winner===state.you?'win':'lose',{id:`${matchId}:finished`,delay:game.lastEvent?.type==='cat'?.68:0});
  }
}
const unlockAudioFromGesture=()=>{if(!state.muted&&state.volume>0)unlockAudio();};
document.addEventListener('pointerdown',unlockAudioFromGesture);document.addEventListener('keydown',unlockAudioFromGesture);
window.addEventListener('blur',()=>{cancelBoardGestures('blur');resetBoardStrokes('blur');});
document.addEventListener('visibilitychange',()=>{cancelBoardGestures('visibility');resetBoardStrokes('visibility');if(document.hidden)stopGameAudio();state.suppressLegacyAudio=true;});

function render(){renderV2();}

const escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function playVisualEvent(event) {
  if(!event)return;
  const cell=Number.isInteger(event.index)?boardCell(event.index):null;
  if(event.type==='cat'&&cell){cell.classList.add('found-glow');setTimeout(()=>cell.classList.remove('found-glow'),900);}
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  if(cell)cell.classList.add('reveal-pop');
  if(event.type==='cat'&&cell){
    const target=$(`#p${event.who} .basket`),from=cell.getBoundingClientRect(),to=target?.getBoundingClientRect();
    if(to){const flyer=document.createElement('div');flyer.className='fly-cat';flyer.textContent='🐱';flyer.style.left=`${from.left}px`;flyer.style.top=`${from.top}px`;flyer.style.setProperty('--dx',`${to.left+to.width/2-from.left}px`);flyer.style.setProperty('--dy',`${to.top+to.height/2-from.top}px`);document.body.appendChild(flyer);setTimeout(()=>flyer.remove(),800)}
    if(event.streak>1){const burst=document.createElement('div');burst.className='streak-burst';burst.textContent=`連抓 ${event.streak} 隻！`;$('#fxLayer').appendChild(burst);setTimeout(()=>burst.remove(),800)}
  }
}
function showTurnBanner(isMine){
  const banner=$('#turnBanner');if(!banner)return;
  clearTimeout(state.turnBannerTimer);banner.textContent=isMine?'輪到你了！':'輪到對方';banner.className=`show ${isMine?'mine':'other'}`;
  state.turnBannerTimer=setTimeout(()=>banner.className='',1050);
}
function renderV2() {
  const game=state.game;if(!game)return;
  if(game.settings.mode==='survival'){renderSurvival();return;}
  document.body.classList.remove('is-survival');$('#survivalArena')?.classList.add('hidden');
  if(game.settings.mode==='battle'){renderBattle();return}document.body.classList.remove('is-battle');$('#battleArena').classList.add('hidden');
  game.clues=game.clues||{};game.foundBy=game.foundBy||{};game.settings=cleanSettings(game.settings||{});game.sharedIntel=game.sharedIntel||[];game.sharedFish=game.sharedFish||0;
  game.players.forEach((player,index)=>{player.cats??=player.score||0;player.fish??=0;player.avatar??=index});
  if(state.pendingAction&&(state.pendingAction.turnId!==game.turnId||game.turn!==state.you||game.found.includes(state.pendingAction.index)||game.misses.includes(state.pendingAction.index)))state.pendingAction=null;
  if(game.turn!==state.you||game.itemUsedThisTurn||game.status!=='playing'){state.tool=null;state.yarnTargets=[]}
  const previousTurn=state.observed.turn,turnChanged=game.status==='playing'&&previousTurn!==game.turn,audibleTurnChanged=turnChanged&&previousTurn!==null&&state.observed.status==='playing'&&!state.suppressNextTurnSound;
  const visibleIntel=game.settings.mode==='coop'?game.sharedIntel:state.intel,probed=new Set(visibleIntel.flatMap(intel=>intel.targets||[]));
  const unseen=game.lastEvent?.at>state.observed.eventAt;
  syncBoardGestures();observeLegacyAudio(game);
  $('#setup').classList.add('hidden');$('#game').classList.remove('hidden');
  $('#room').textContent=`房號 ${state.room||'手動連線'}`;
  const info=MODE_INFO[game.settings.mode];
  const capText=game.settings.streakLimitEnabled?`連抓 ${game.settings.streakLimit}`:'不限連抓';
  $('#modeBadge').textContent=`${info.label}｜${game.settings.turnSecondsA}/${game.settings.turnSecondsB} 秒｜${capText}`;
  $('#turnText').textContent=game.status==='finished'?'本局完成':game.turn===state.you?'輪到你囉！':`換 ${game.players[game.turn].nickname}`;
  $('#message').textContent=game.hint||(game.hintVotes?.length?`${game.players[game.hintVotes[0]].nickname} 正在等待共同提示同意`:'')||(game.lastEmote?`${game.players[game.lastEmote.from].nickname}：${game.lastEmote.value}`:'')||(game.streak>1?`連抓 ${game.streak} 隻！`:'');
  for(let playerIndex=0;playerIndex<2;playerIndex++){
    const player=game.players[playerIndex],avatar=AVATARS[player.avatar]||AVATARS[playerIndex],element=$(`#p${playerIndex}`);
    const isCurrent=game.turn===playerIndex&&game.status==='playing',isInactive=game.status==='playing'&&!isCurrent;
    element.className=`player-card ${isCurrent?'current':''} ${isInactive?'inactive':''} ${game.shield?.owner===playerIndex?'shield-on':''}`;
    element.setAttribute('aria-current',isCurrent?'true':'false');
    const scoreText=game.settings.mode==='treasure'?`${player.score} 分 · ${player.cats} 隻`:String(player.cats);
    const fishText=game.settings.mode==='items'?` · 🐟 ${player.fish}/4`:game.settings.mode==='coop'?` · 共用 🐟 ${game.sharedFish}/4`:'';
    const intelText=visibleIntel.slice(-2).map(intel=>intel.type==='magnifier'?`◎ 周圍有 ${intel.count} 隻貓`:`🧶 選取格${intel.hasCat?'有':'沒有'}貓`).join('<br>');
    const captures=game.found.filter(index=>+game.foundBy[index]===playerIndex),fallback=Math.max(0,player.cats-captures.length);
    const basketCats=[...captures.map((index,i)=>`<span class="basket-cat" title="已找到的貓" style="animation-delay:${Math.min(i*.02,.3)}s">${catCharacter(catVariant(game,index),'basket-character')}</span>`),...Array.from({length:fallback},(_,i)=>`<span class="basket-cat">${catCharacter((playerIndex*3+i)%8,'basket-character')}</span>`)];
    element.innerHTML=`<div class="turn-label" aria-hidden="true">目前回合</div><div class="avatar avatar-${player.avatar||0}" title="${escapeHTML(avatar.name)}">${playerAvatar(player.avatar||0,'avatar-character')}</div><div class="player-name">${escapeHTML(player.nickname)}${playerIndex===state.you?'（你）':''}</div><div class="score">${scoreText}</div><small>${game.settings.mode==='coop'?'共同進度':'個人成績'}${fishText} · ${player.connected?'已連線':'暫時離線'}</small><div class="basket" aria-label="貓咪籃子">${basketCats.join('')}</div>${intelText?`<div class="intel-list">${intelText}</div>`:''}`;
  }
  const tools=itemMode(game),balance=fishBalance(game,state.you);$('#toolbox').classList.toggle('hidden',!tools);$('#fishCount').textContent=balance;$('#itemStatus').textContent=game.itemUsedThisTurn?'本輪已使用道具':state.tool==='magnifier'?'道具目標：點一下選未翻中心格':state.tool==='yarn'?`道具目標：點一下選取，已選 ${state.yarnTargets.length}/3 格`:game.shield?'護墊待命中':'';
  document.querySelectorAll('#toolbox [data-item]').forEach(button=>{const cost={magnifier:2,yarn:2,shield:3,hourglass:2}[button.dataset.item];button.disabled=!tools||game.turn!==state.you||game.itemUsedThisTurn||balance<cost;button.classList.toggle('selected',state.tool===button.dataset.item)});$('#confirmYarn').classList.toggle('hidden',state.tool!=='yarn');$('#cancelItem').classList.toggle('hidden',!state.tool);
  const board=$('#board'),size=game.puzzle.size,mobile=innerWidth<=700,smallSize=size===6;
  const baseSize=mobile?(smallSize?Math.min(50,(innerWidth-38)/size):Math.max(18,Math.min(24,(innerWidth-18)/Math.min(size,20)))):Math.max(14,Math.min(smallSize?62:36,(innerHeight-368)/size,(innerWidth-508)/size));
  const cellSize=mobile?Math.round(baseSize*state.zoom):Math.floor(baseSize*state.zoom),palette=regionPalette(game.puzzle);
  $('#zoomLabel').textContent=`${Math.round(state.zoom*100)}%`;$('#zoomOut').disabled=state.zoom<=.75;$('#zoomIn').disabled=state.zoom>=1.75;
  board.dataset.size=String(size);board.style.setProperty('--n',size);board.style.setProperty('--s',`${cellSize}px`);
  const boardKey=`${state.role}:${state.you}:${game.puzzle.id}:${size}`,rebuild=board.dataset.viewKey!==boardKey||board.children.length!==size*size;
  if(rebuild){board.dataset.viewKey=boardKey;board.innerHTML='';}
  for(let index=0;index<size*size;index++){
    const cell=rebuild?document.createElement('button'):board.children[index],region=game.puzzle.regions[index],row=Math.floor(index/size),column=index%size;
    if(rebuild){cell.type='button';cell.className='cell';cell.dataset.index=index;cell.setAttribute('role','gridcell');wireBoardCell(cell,index);board.appendChild(cell);}
    cell.dataset.region=region;cell.title=`行 ${row+1}｜列 ${column+1}｜區域 ${region+1}`;cell.style.setProperty('--bg',palette[region]);
    cell.classList.toggle('er',column===size-1||game.puzzle.regions[index+1]!==region);
    cell.classList.toggle('eb',row===size-1||game.puzzle.regions[index+size]!==region);
    const found=game.found.includes(index),miss=game.misses.includes(index),note=!found&&!miss&&state.notes.has(index);
    const treasure=found&&game.settings.mode==='treasure'&&Boolean(state.role==='host'?game.treasures?.includes(index):game.foundTreasures?.includes(index));
    for(const [name,on] of [['cat',found],['opened',miss],['note',note],['treasure-cat',treasure]])cell.classList.toggle(name,on);
    const visual=found?`cat:${treasure}`:miss?'opened':note?'note':'hidden';
    if(cell.dataset.renderState!==visual){
      if(found)cell.innerHTML=catCharacter(catVariant(game,index),'board-character');else cell.textContent=miss||note?'×':'';
      cell.dataset.renderState=visual;
    }
    const suffix=found?`，已找到${treasure?'鈴鐺':''}貓`:miss?'，已翻開的空格，確認沒有貓':note?'，私人筆記，尚未確認':'';
    cell.setAttribute('aria-label',`第 ${row+1} 行，第 ${column+1} 列，區域 ${region+1}${suffix}`);
    cell.classList.toggle('probed',probed.has(index)&&!found&&!miss);
    cell.classList.toggle('yarn-picked',state.yarnTargets.includes(index));
    cell.classList.toggle('latest-result',game.lastEvent?.index===index);
    cell.classList.toggle('selected-cell',state.selectedCell===index);
    cell.classList.toggle('pending-cell',state.pendingAction?.index===index);
    cell.disabled=found||miss||game.status!=='playing';
  }
  $('#pass').disabled=game.turn!==state.you;
  if(game.status==='finished'&&!$('#result').open){
    $('#resultTitle').textContent=game.winner==='coop'?'共同成功！全部貓都回家了':game.winner==='tie'?'平手！':game.winner===state.you?'你贏了！':'下一局再加油！';
    $('#resultScore').textContent=game.winner==='coop'?`你們一起找到 ${game.found.length} 隻｜個人紀念 ${game.players[0].cats}＋${game.players[1].cats}`:game.settings.mode==='treasure'?`${game.players[0].score} 分（${game.players[0].cats} 隻） ： ${game.players[1].score} 分（${game.players[1].cats} 隻）`:`${game.players[0].cats}：${game.players[1].cats}`;$('#result').showModal();
  }
  if(game.status!=='finished'&&$('#result').open)$('#result').close();
  state.observed={found:game.found.length,misses:game.misses.length,finished:game.status==='finished',turn:game.turn,status:game.status,eventAt:Math.max(state.observed.eventAt,game.lastEvent?.at||0)};
  state.suppressNextTurnSound=false;
  if(turnChanged)showTurnBanner(game.turn===state.you);
  if(unseen)requestAnimationFrame(()=>playVisualEvent(game.lastEvent));
}
render=renderV2;

setInterval(()=>{
  const game=state.game; if (!game||hasIndependentBoards(game)) return;
  if (game.deadline) $('#timer').textContent=Math.max(0,Math.ceil((game.deadline-Date.now())/1000));
  if (state.role==='host'&&game.status==='playing'&&Date.now()>=game.deadline) { switchTurn(); broadcast(); }
},250);

function renderAvatarChoices(){
  const root=$('#avatarChoices');root.innerHTML='';
  AVATARS.forEach((avatar,index)=>{const button=document.createElement('button');button.type='button';button.className=`avatar-choice ${state.avatar===index?'selected':''}`;button.dataset.avatar=index;button.setAttribute('aria-label',avatar.name);button.setAttribute('aria-pressed',String(state.avatar===index));button.innerHTML=`<span class="avatar avatar-${index}" aria-hidden="true">${playerAvatar(index,'avatar-character')}</span>`;button.onclick=()=>{state.avatar=index;localStorage.catAvatar=String(index);renderAvatarChoices();playUICue()};root.appendChild(button)});
}
function setEntryFlow(kind){
  const activeFlow=state.role==='guest'?'join':state.role,active=state.peer?.open&&activeFlow;
  if(active&&kind!==activeFlow){toast('目前房間仍在連線中，已保留原本房間');kind=activeFlow}
  $('#setup').dataset.flow=kind;$('#entryChoice').classList.add('hidden');$('#entryFlow').classList.remove('hidden');$('#flowTitle').textContent=kind==='host'?'建立房間':'加入房間';
  const roomReady=kind==='join'||Boolean(state.room&&state.peer?.open);$('#roomField').classList.toggle('room-ready',roomReady);
  $('#host').disabled=Boolean(kind==='host'&&state.peer?.open);$('#host').textContent=state.peer?.open&&state.role==='host'?'房間已建立':'🐾 建立房間';
  updateModeDescription();
}
function showEntryChoice(){
  $('#entryChoice').classList.remove('hidden');$('#entryFlow').classList.add('hidden');delete $('#setup').dataset.flow;
}
function updateModeDescription(){const mode=$('#gameMode').value,info=MODE_INFO[mode],battle=mode==='battle',survival=mode==='survival';$('#modeDescription').textContent=info.description;$('#battleSettings').classList.toggle('hidden',!battle);$('#survivalSettings')?.classList.toggle('hidden',!survival);$('.turn-settings').classList.toggle('hidden',battle||survival);$('#size').disabled=battle||survival;if(battle||survival)$('#size').value='6';$('#manualControls')?.classList.toggle('hidden',survival&&$('#setup').dataset.flow!=='join');}
function updateCapUI(){const enabled=$('#capEnabled').checked;$('#cap').disabled=!enabled;$('#capField').classList.toggle('locked',!enabled);$('#capField').setAttribute('aria-disabled',String(!enabled))}
function syncSettingsUI(settings){const clean=cleanSettings(settings);$('#battleHP').value=String(clean.maxHP);$('#size').value=String(clean.size);$('#gameMode').value=clean.mode;$('#secondsA').value=String(clean.turnSecondsA);$('#secondsB').value=String(clean.turnSecondsB);$('#capEnabled').checked=clean.streakLimitEnabled;$('#cap').value=String(clean.streakLimit);updateCapUI();updateModeDescription()}
function randomNickname(){
  const all=NICK_ADJECTIVES.flatMap(adjective=>NICK_NOUNS.map(noun=>`${adjective}${noun}`)),current=$('#nick').value.trim();let history=[];try{history=JSON.parse(localStorage.catNickHistory||'[]')}catch{}
  const blocked=new Set([current,...history.slice(-10)]),choices=all.filter(name=>!blocked.has(name)),name=choices[randomInt(choices.length)]||all[randomInt(all.length)];
  $('#nick').value=name;history.push(name);localStorage.catNickHistory=JSON.stringify(history.slice(-20));localStorage.catNickname=name;
}
if(localStorage.catNickname)$('#nick').value=localStorage.catNickname.slice(0,16);
renderAvatarChoices();updateModeDescription();updateCapUI();$('#chooseHost').onclick=()=>setEntryFlow('host');$('#chooseJoin').onclick=()=>setEntryFlow('join');$('#backToEntry').onclick=showEntryChoice;$('#gameMode').onchange=()=>{updateModeDescription();playUICue()};$('#capEnabled').onchange=updateCapUI;$('#randomNick').onclick=()=>{randomNickname();playUICue()};$('#nick').oninput=()=>{localStorage.catNickname=$('#nick').value.slice(0,16)};
if(window.CAT_MATCH_ENABLED!==true){$('#quickMatch').classList.add('hidden');$('#quickMatch').disabled=true;$('#quickMatch').textContent='⚡ 快速配對（未啟用）';$('#quickMatch').title='此靜態版本未設定配對服務，請使用房號或邀請連結'}

function sendItem(payload){
  const game=state.game;
  if(!game||!itemMode(game)||game.status!=='playing'||game.turn!==state.you||game.itemUsedThisTurn){toast('現在不能使用道具');return false}
  const costs={magnifier:2,yarn:2,shield:3,hourglass:2},cost=costs[payload.item];
  if(!cost||fishBalance(game,state.you)<cost){toast('小魚乾不足');return false}
  if(payload.item==='magnifier'&&!unresolved(game,+payload.target)){toast('請選尚未翻開的格子');return false}
  if(payload.item==='yarn'){
    const targets=[...new Set((payload.targets||[]).map(Number))];
    if(targets.length<2||targets.length>3||targets.some(index=>!unresolved(game,index))||!connectedTargets(game.puzzle.size,targets)){toast('毛線球要圈選 2～3 個相連的未解格');return false}
    const region=game.puzzle.regions[targets[0]];
    if(targets.some(index=>game.puzzle.regions[index]!==region)){toast('毛線球的格子必須在同一區');return false}
    const remaining=game.puzzle.regions.reduce((list,value,index)=>value===region&&unresolved(game,index)?[...list,index]:list,[]);
    if(targets.length>=remaining.length){toast('不能直接圈完整個剩餘區域');return false}
    payload={...payload,targets};
  }
  const action={type:'item',...payload,turnId:game.turnId,actionId:crypto.randomUUID()};
  const accepted=state.role==='host'?applyItem(0,action):(send({type:'action',action}),true);
  if(!accepted){toast('道具目標已過期，沒有扣除小魚乾');return false}
  state.tool=null;state.yarnTargets=[];render();return true;
}

document.querySelectorAll('#toolbox [data-item]').forEach(button=>button.onclick=()=>{
  const item=button.dataset.item;
  if(item==='magnifier'||item==='yarn'){
    cancelBoardGestures();state.tool=state.tool===item?null:item;state.yarnTargets=[];render();return;
  }
  sendItem({item});
});
$('#confirmYarn').onclick=()=>sendItem({item:'yarn',targets:state.yarnTargets});
$('#cancelItem').onclick=()=>{state.tool=null;state.yarnTargets=[];render()};
$('#zoomOut').onclick=()=>{state.zoom=Math.max(.75,+(state.zoom-.25).toFixed(2));localStorage.catBoardZoom=String(state.zoom);render()};
$('#zoomIn').onclick=()=>{state.zoom=Math.min(1.75,+(state.zoom+.25).toFixed(2));localStorage.catBoardZoom=String(state.zoom);render()};
$('#helpButton').onclick=()=>$('#helpDialog').showModal();
$('#closeHelp').onclick=()=>$('#helpDialog').close();
$('#helpDialog').addEventListener('click',event=>{if(event.target===$('#helpDialog'))$('#helpDialog').close()});

$('#host').onclick=()=>{try{startPeerHost(false)}catch(error){toast(error.message)}};
$('#join').onclick=()=>{try{startPeerGuest()}catch(error){toast(error.message)}};
$('#manualHost').onclick=()=>manualHost(false).catch(error=>toast(error.message));
$('#manualJoin').onclick=manualJoin;
$('#resume').onclick=()=>resumeHost().catch(error=>toast(error.message));
$('#quickMatch').onclick=async()=>{
  if(state.matchAbort){state.matchAbort.abort();return}
  const controller=new AbortController();state.matchAbort=controller;$('#quickMatch').textContent='取消等待';$('#setupStatus').textContent='正在等待相同棋盤、模式、時間與連抓規則的玩家…';
  try{
    const key=btoa(JSON.stringify(settingsFromUI())),response=await fetch(`/match?key=${encodeURIComponent(key)}`,{signal:controller.signal});
    if(!response.ok)throw Error(`HTTP ${response.status}`);const match=await response.json();
    if(!ROOM_RE.test(normalizeRoom(match.room))||!['host','guest'].includes(match.role))throw Error('配對服務回應無效');
    setEntryFlow(match.role==='host'?'host':'join');$('#roomInput').value=match.room;
    if(match.role==='host')startPeerHost(false,match.room);else startPeerGuest();
  }catch(error){
    if(error.name==='AbortError')$('#setupStatus').textContent='已取消快速配對';
    else $('#setupStatus').textContent='快速配對服務目前未啟用，仍可使用房號邀請';
  }finally{state.matchAbort=null;$('#quickMatch').textContent='⚡ 快速配對'}
};
$('#copyInvite').onclick=async()=>{
  const room=normalizeRoom(state.room||$('#roomInput').value);
  if(!ROOM_RE.test(room)){toast('請先建立房間或輸入房號');return}
  const invite=new URL(location.href);invite.search='';invite.searchParams.set('room',room);
  try{await navigator.clipboard.writeText(invite.href);toast('已複製邀請連結')}catch{toast(invite.href)}
};
async function copyRoomCode(button){
  const room=normalizeRoom(state.room||$('#roomInput').value);
  if(!ROOM_RE.test(room)){toast('請先建立房間或輸入房號');return}
  try{await navigator.clipboard.writeText(room);const original=button.textContent;button.textContent='已複製';toast(`已複製房號 ${room}`);setTimeout(()=>button.textContent=original,1400)}catch{toast(`房號 ${room}`)}
}
$('#copyRoom').onclick=event=>copyRoomCode(event.currentTarget);
$('#copyGameRoom').onclick=event=>copyRoomCode(event.currentTarget);
$('#applyCode').onclick=async()=>{
  try {
    if (state.role==='host') { await useAnswer($('#inCode').value); $('#setupStatus').textContent='已套用回覆，正在建立連線'; }
    else { $('#outCode').value=await useOffer($('#inCode').value); $('#setupStatus').textContent='請把上方回覆碼傳回房主'; }
  } catch (error) { toast(`代碼無效：${error.message}`); }
};
$('#copyCode').onclick=()=>navigator.clipboard.writeText($('#outCode').value).then(()=>toast('已複製'));
$('#pass').onclick=()=>{
  const action={type:'pass',turnId:state.game.turnId,actionId:crypto.randomUUID()}; state.role==='host'?act(0,action):send({type:'action',action});
};
$('#hint').onclick=()=>{
  const action={type:'hint',turnId:state.game.turnId,actionId:crypto.randomUUID()}; state.role==='host'?act(0,action):send({type:'action',action});
};
document.querySelectorAll('.emote').forEach(button=>button.onclick=()=>{
  const action={type:'emote',value:button.textContent,turnId:state.game.turnId,actionId:crypto.randomUUID()}; state.role==='host'?act(0,action):send({type:'action',action});
});
$('#mute').onclick=()=>{
  state.muted=!state.muted;localStorage.p2pMuted=state.muted?'1':'0';getGameAudio().setMuted(state.muted);syncAudioControls();
  if(!state.muted)unlockAudio().then(unlocked=>{if(unlocked)playUICue();});
};
$('#soundVolume').oninput=()=>{state.volume=Math.max(0,Math.min(1,Number($('#soundVolume').value)/100));localStorage.catAudioVolume=String(state.volume);getGameAudio().setVolume(state.volume);syncAudioControls();};
$('#soundVolume').onchange=()=>{if(!state.muted)unlockAudio().then(unlocked=>{if(unlocked)playUICue();});};
syncAudioControls();

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
  cancelBoardGestures();
  if(state.game?.settings.mode==='battle'&&state.game.status!=='finished')return;
  rematchVotes.add(who);
  if (state.role==='host'&&rematchVotes.size===2) {
    if(state.game.settings.mode==='battle'){const old=state.game;state.game=CatBattle.create(old.settings,old.players,old);CatBattle.start(state.game);state.notes.clear();state.pendingAction=null;state.battleObservedEvent=null;rematchVotes.clear();broadcast();$('#result').close();return}
    const game=state.game; game.round++; game.starter=1-game.starter; game.puzzle=makePuzzle(game.settings.size);
    game.status='playing'; game.turn=game.starter; game.turnId++; game.found=[]; game.foundBy={}; game.misses=[]; game.clues={}; game.streak=0; game.winner=null;
    game.treasures=shuffle(game.puzzle.solution.slice()).slice(0,game.puzzle.size<=12?2:3);game.sharedFish=0;game.sharedIntel=[];game.itemUsedThisTurn=false;game.shield=null;
    game.lastEvent={type:'rematch',at:Date.now()};game.hint=null; game.hintVotes=[]; game.actionIds=[]; game.players.forEach(player=>{player.score=0;player.cats=0;player.fish=0});
    state.intel=[];state.notes.clear();state.tool=null;state.yarnTargets=[];setDeadline();
    rematchVotes.clear(); broadcast(); $('#result').close();
  }
}
$('#rematch').onclick=()=>{if(state.role==='host')rematchVote(0);else send({type:'rematch'});toast('等待另一方同意再戰')};

const hasSavedHost=Boolean(sessionStorage.p2pHost);if(hasSavedHost)$('#resume').classList.remove('hidden');
const guestSaved=JSON.parse(sessionStorage.p2pGuest||'null');
if (guestSaved?.room?.startsWith('CAT-')) { $('#roomInput').value=guestSaved.room; $('#setupStatus').textContent='找到上次房號，可按「加入房間」重新連線'; }
const invitedRoom=normalizeRoom(new URLSearchParams(location.search).get('room'));
if(ROOM_RE.test(invitedRoom)){ $('#roomInput').value=invitedRoom; $('#setupStatus').textContent='邀請房號已填入，請按「加入房間」'; }
if(ROOM_RE.test(invitedRoom))setEntryFlow('join');else if(hasSavedHost)setEntryFlow('host');else if(guestSaved?.room?.startsWith('CAT-'))setEntryFlow('join');
try { state.notes=new Set(JSON.parse(sessionStorage.getItem('p2pNotes-guest')||'[]')); } catch {}
try { state.intel=JSON.parse(sessionStorage.getItem('p2pIntel-guest')||'[]'); } catch {}
