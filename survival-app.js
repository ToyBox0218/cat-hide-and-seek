'use strict';

/* Browser bridge for the isolated survival engine/session. Only public snapshots
   enter state.game. Room credentials remain in this browser's session storage. */
const SURVIVAL_CREDENTIALS='catSurvivalSeats';
function survivalNow(){return Date.now()+(state.clockOffset||0);}
function survivalMissLocked(game=state.game){const board=game?.boards?.[state.you];return game?.settings?.mode==='survival'&&game.status==='playing'&&board?.cooldownKind==='miss'&&board.cooldownUntil>survivalNow();}
function survivalCanMark(game=state.game){
  const player=game?.players?.[state.you];
  return game?.settings?.mode==='survival'&&game.status==='playing'&&player?.id===state.survivalPlayerId&&player.status==='active'&&player.connected===true&&['hosting','connected'].includes(state.survivalLinkStatus)&&!survivalMissLocked(game)&&!document.hidden;
}
function survivalProfile(){return {nickname:($('#nick').value||'貓友').slice(0,16),avatar:state.avatar};}
function readSurvivalSeat(room,gameId){
  if(!gameId)return null;
  try{const saved=JSON.parse(sessionStorage.getItem(SURVIVAL_CREDENTIALS)||'{}')[room];return saved?.gameId===gameId&&typeof saved.credential==='string'?saved:null;}catch{return null;}
}
function forgetExpiredSurvivalSeat(){try{const saved=JSON.parse(sessionStorage.getItem(SURVIVAL_CREDENTIALS)||'{}');if(saved[state.room]?.gameId===state.survivalExpectedGameId){delete saved[state.room];sessionStorage.setItem(SURVIVAL_CREDENTIALS,JSON.stringify(saved));}}catch{}}
function storeSurvivalSeat(credential,gameId=state.survivalExpectedGameId){
  if(typeof credential!=='string'||!gameId||state.role!=='guest')return;
  let saved={};try{saved=JSON.parse(sessionStorage.getItem(SURVIVAL_CREDENTIALS)||'{}')||{};}catch{}
  saved[state.room]={credential,gameId};
  const rooms=Object.keys(saved);while(rooms.length>20)delete saved[rooms.shift()];
  sessionStorage.setItem(SURVIVAL_CREDENTIALS,JSON.stringify(saved));
}
function survivalNotesKey(){return state.survivalPlayerId&&state.room?`catSurvivalNotes:${state.room}:${state.survivalPlayerId}`:null;}
function saveSurvivalNotes(){
  const key=survivalNotesKey(),board=state.game?.boards?.[state.you];if(!key||!board)return;
  sessionStorage.setItem(key,JSON.stringify({gameId:state.game.id,boardId:board.puzzle.id,notes:[...state.notes]}));
}
function loadSurvivalNotes(snapshot,board){
  const key=survivalNotesKey(),identity=`${snapshot.id}:${state.survivalPlayerId}:${board?.puzzle.id}`;
  if(state.survivalNotesLoadedKey===identity)return;
  state.survivalNotesLoadedKey=identity;state.notes.clear();
  try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved?.gameId===snapshot.id&&saved.boardId===board?.puzzle.id)for(const index of saved.notes||[])if(Number.isInteger(index)&&index>=0&&index<36&&!board.found.includes(index)&&!board.misses.includes(index))state.notes.add(index);}catch{}
}
function applySurvivalSnapshot(snapshot,{historical=false}={}){
  if(!snapshot||snapshot.settings?.mode!=='survival'||!Array.isArray(snapshot.players)||!Array.isArray(snapshot.boards)||snapshot.players.length!==snapshot.boards.length||snapshot.players.length>4)return false;
  if(state.survivalExpectedGameId&&snapshot.id!==state.survivalExpectedGameId)return false;
  const previous=state.game?.settings?.mode==='survival'?state.game:null;
  if(previous?.id===snapshot.id&&snapshot.revision<previous.revision)return false;
  const previousBoard=previous?.boards?.[state.you]?.puzzle.id;
  if(typeof suiPrepareSnapshot==='function')suiPrepareSnapshot(previous,snapshot,{historical});
  state.game=snapshot;state.you=snapshot.players.findIndex(player=>player.id===state.survivalPlayerId);
  const board=snapshot.boards[state.you];
  if(state.survivalSession?.getServerTime)state.clockOffset=state.survivalSession.getServerTime()-Date.now();
  else if(Number.isFinite(snapshot.serverTime))state.clockOffset=snapshot.serverTime-Date.now();
  if(historical||!previous||previous.id!==snapshot.id)state.suppressSurvivalFX=true;
  if(previousBoard&&previousBoard!==board?.puzzle.id){state.notes.clear();state.pendingAction=null;state.selectedCell=null;}
  if(board)loadSurvivalNotes(snapshot,board);
  if(state.pendingAction&&(!board||state.pendingAction.boardId!==board.puzzle.id||board.found.includes(state.pendingAction.index)||board.misses.includes(state.pendingAction.index)||snapshot.status!=='playing'||snapshot.players[state.you]?.status!=='active'))state.pendingAction=null;
  syncBoardGestures();if(board)saveSurvivalNotes();render();return true;
}
function survivalAck(ack){
  if(!ack||state.pendingAction?.actionId!==ack.actionId)return;
  if(ack.accepted){state.pendingAction.acknowledged=true;return;}
  state.pendingAction=null;syncBoardGestures();
  const messages={'cooldown':'肉球還在休息，倒數結束後再翻格','stale-board':'已經換新盤，請重新選格','not-active':'你已離場，可以繼續觀戰','disconnected':'連線中斷，正在嘗試回座','not-playing':'目前不能翻格，請看上方對局狀態','duplicate-action':'這次翻格已經處理過了'};
  toast(messages[ack.reason]||'這次操作未被接受，請確認對局狀態');render();
}
function clearSurvivalReconnectTimer(){clearTimeout(state.survivalReconnectTimer);state.survivalReconnectTimer=null;}
function clearSurvivalActionTimers(){for(const timer of state.survivalActionTimers||[])clearTimeout(timer);state.survivalActionTimers?.clear();}
function armSurvivalRecoveryDeadline(){
  clearTimeout(state.survivalRecoveryTimer);const deadline=state.survivalReconnectUntil,gameId=state.survivalExpectedGameId;
  if(!Number.isFinite(deadline))return;
  state.survivalRecoveryTimer=setTimeout(()=>{
    state.survivalRecoveryTimer=null;
    if(state.role!=='guest'||state.survivalExpectedGameId!==gameId||state.survivalReconnectUntil!==deadline||state.survivalLinkStatus==='connected')return;
    clearSurvivalReconnectTimer();state.survivalConnectInFlight=false;state.pendingAction=null;state.survivalLinkStatus='aborted';state.suppressSurvivalFX=true;
    cancelBoardGestures('survival-recovery-expired');clearSurvivalActionTimers();stopGameAudio();
    if(state.game?.settings.mode==='survival'&&!['finished','aborted'].includes(state.game.status))applySurvivalSnapshot({...state.game,status:'aborted',winner:null,winnerIds:[],endReason:'host-disconnected'});
    else if(state.game?.settings.mode==='survival')render();
  },Math.max(0,deadline-survivalNow()));
}
function scheduleSurvivalReconnect(){
  if(state.role!=='guest'||state.survivalLinkStatus!=='reconnecting'||state.survivalReconnectTimer||survivalNow()>=(state.survivalReconnectUntil||0))return;
  const generation=state.survivalGeneration;
  state.survivalReconnectTimer=setTimeout(()=>{state.survivalReconnectTimer=null;if(generation===state.survivalGeneration)survivalReconnect(false);},1000);
}
function survivalStatus(status){
  if(!status||typeof status.status!=='string')return;
  if(status.status==='clock'){if(Number.isFinite(status.offset))state.clockOffset=status.offset;return;}
  if(status.status.startsWith('player-'))return;
  if(status.status==='connected'){
    state.survivalLinkStatus='connected';state.survivalStatusMessage='';state.survivalReconnectUntil=null;state.survivalConnectInFlight=false;clearSurvivalReconnectTimer();clearTimeout(state.survivalRecoveryTimer);state.survivalRecoveryTimer=null;
  }else if(status.status==='reconnecting'){
    state.survivalLinkStatus='reconnecting';state.suppressSurvivalFX=true;state.pendingAction=null;
    const deadline=Number.isFinite(status.deadline)?status.deadline+(state.clockOffset||0):survivalNow()+15000;
    state.survivalReconnectUntil=state.survivalReconnectUntil?Math.min(state.survivalReconnectUntil,deadline):deadline;
    cancelBoardGestures('survival-disconnect');clearSurvivalActionTimers();stopGameAudio();armSurvivalRecoveryDeadline();scheduleSurvivalReconnect();
  }else if(status.status==='rejected'){
    state.survivalConnectInFlight=false;
    if(status.reason==='seat-unavailable'){forgetExpiredSurvivalSeat();clearSurvivalReconnectTimer();clearTimeout(state.survivalRecoveryTimer);state.survivalRecoveryTimer=null;state.survivalReconnectUntil=null;}
    const messages={'seat-unavailable':'原座位已釋出，重新加入仍在準備中的房間可取得新座位','match-already-started':'比賽已開始，不能加入新玩家','room-full':'這間房間已滿','invalid-credential':'無法恢復原座位，請確認房間是否已重開','seat-already-connected':'你的座位已在另一個連線中','host-unreachable':'暫時連不上房主','room-busy':'房間正在處理連線，請稍後再試'};
    state.survivalStatusMessage=messages[status.reason]||'加入房間失敗，請確認好友房號';$('#setupStatus').textContent=state.survivalStatusMessage;toast(state.survivalStatusMessage);
    if(status.reason!=='seat-unavailable'&&state.game?.settings.mode==='survival'&&survivalNow()<(state.survivalReconnectUntil||0)){state.survivalLinkStatus='reconnecting';scheduleSurvivalReconnect();}
    else state.survivalLinkStatus='closed';
  }else if(['aborted','closed'].includes(status.status)){
    state.survivalLinkStatus=status.status;state.survivalConnectInFlight=false;clearSurvivalReconnectTimer();clearTimeout(state.survivalRecoveryTimer);state.survivalRecoveryTimer=null;state.survivalReconnectUntil=null;state.pendingAction=null;state.suppressSurvivalFX=true;cancelBoardGestures('survival-ended');clearSurvivalActionTimers();stopGameAudio();
  }
  if(state.game?.settings.mode==='survival')render();
}
function disposeSurvivalRoom(reason='left-room'){
  if(state.game?.settings.mode==='survival')saveSurvivalNotes();
  state.survivalGeneration=(state.survivalGeneration||0)+1;state.transportGeneration=(state.transportGeneration||0)+1;
  clearSurvivalReconnectTimer();clearTimeout(state.survivalRecoveryTimer);state.survivalRecoveryTimer=null;clearSurvivalActionTimers();clearTimeout(state.survivalOfferTimer);state.survivalOfferTimer=null;
  const session=state.survivalSession;state.survivalSession=null;
  session?.close(reason);state.transport?.close();state.transport=null;state.peer?.destroy();state.peer=null;
  cancelBoardGestures('survival-leave');resetBoardStrokes('survival-leave');stopGameAudio();
  if(typeof clearSurvivalUI==='function')clearSurvivalUI();
  state.survivalConnectInFlight=false;state.survivalPlayerId=null;state.survivalExpectedGameId=null;state.survivalNotesLoadedKey=null;state.survivalLinkStatus='closed';state.survivalStatusMessage='';state.survivalReconnectUntil=null;state.pendingAction=null;
}
function startSurvivalHost({room=null}={}){
  if(state.survivalSession)disposeSurvivalRoom('new-room');
  cancelBoardGestures('survival-new-room');if(typeof clearBattleFX==='function')clearBattleFX();
  state.transportGeneration=(state.transportGeneration||0)+1;state.transport?.close();state.peer?.destroy();state.transport=null;
  state.role='host';state.you=0;state.practice=false;state.manual=false;state.notes.clear();state.intel=[];state.tool=null;state.yarnTargets=[];state.clockOffset=0;state.room=room||randomRoom();state.survivalPlayerId='p1';state.survivalExpectedGameId=null;state.survivalLinkStatus='joining';state.suppressSurvivalFX=true;
  const generation=state.survivalGeneration=(state.survivalGeneration||0)+1;
  const current=callback=>(...args)=>{if(state.survivalGeneration===generation)callback(...args);};
  state.survivalSession=CatSurvivalSession.createHost({engine:CatSurvival,settings:settingsFromUI(),hostProfile:survivalProfile(),onState:current(snapshot=>applySurvivalSnapshot(snapshot)),onStatus:current(survivalStatus),onAck:current(survivalAck)});
  state.survivalExpectedGameId=state.survivalSession.getState().id;
  function openPeer(attempt=0){
    const peer=new Peer(peerIdForRoom(state.room),peerOptions());state.peer=peer;
    peer.on('open',current(()=>{if(state.peer!==peer)return;state.survivalLinkStatus='hosting';showRoom(state.room);$('#roomInput').value=state.room;$('#setupStatus').textContent=`房號 ${state.room}，邀請貓友加入；兩位即可開賽，最多四位`;applySurvivalSnapshot(state.survivalSession.getState(),{historical:true});}));
    peer.on('connection',current(connection=>{if(state.peer!==peer){connection.close();return;}state.survivalSession?.attach(connection);}));
    peer.on('error',current(error=>{if(state.peer!==peer)return;if(error.type==='unavailable-id'&&!room&&attempt<24){state.peer=null;peer.destroy();state.room=randomRoom();openPeer(attempt+1);return;}toast(`房間連線失敗：${error.type||error.message}`);state.survivalSession?.abort('host-connection-error');}));
    peer.on('close',current(()=>{if(state.peer===peer)state.survivalSession?.abort('host-disconnected');}));
    peer.on('disconnected',current(()=>{if(state.peer===peer)state.survivalSession?.abort('host-disconnected');}));
  }
  openPeer();return state.survivalSession;
}
function adoptSurvivalGuest(connection,offer){
  if(offer?.protocol!==CatSurvivalSession.PROTOCOL||offer.type!=='offer'||typeof offer.gameId!=='string')return false;
  const saved=readSurvivalSeat(state.room,offer.gameId),old=state.survivalSession;
  const generation=state.survivalGeneration=(state.survivalGeneration||0)+1;
  state.transportGeneration=(state.transportGeneration||0)+1;clearSurvivalReconnectTimer();clearTimeout(state.survivalOfferTimer);state.survivalOfferTimer=null;
  state.survivalSession=null;old?.close();state.transport=null;
  state.role='guest';state.practice=false;state.manual=false;state.survivalExpectedGameId=offer.gameId;state.survivalLinkStatus='joining';state.survivalConnectInFlight=false;state.suppressSurvivalFX=true;state.pendingAction=null;state.tool=null;
  cancelBoardGestures('survival-join');
  const current=callback=>(...args)=>{if(state.survivalGeneration===generation)callback(...args);};
  const session=CatSurvivalSession.createGuest({connection,profile:survivalProfile(),credential:saved?.credential,
    onSeat:current(seat=>{state.survivalPlayerId=seat.playerId;state.you=seat.index;}),onCredential:current(token=>storeSurvivalSeat(token,offer.gameId)),
    onState:current(snapshot=>applySurvivalSnapshot(snapshot)),onStatus:current(survivalStatus),onAck:current(survivalAck)});
  state.survivalSession=session;session.receive(offer);
  if(session.getState())applySurvivalSnapshot(session.getState(),{historical:true});
  return true;
}
function survivalReconnect(manual=true){
  if(state.role!=='guest'||!state.room||state.survivalConnectInFlight)return false;
  if(manual&&survivalNow()>=(state.survivalReconnectUntil||0)){state.survivalReconnectUntil=survivalNow()+15000;armSurvivalRecoveryDeadline();}
  if(!manual&&survivalNow()>=(state.survivalReconnectUntil||0))return false;
  state.survivalLinkStatus='reconnecting';state.suppressSurvivalFX=true;cancelBoardGestures('survival-reconnect');
  const generation=state.survivalGeneration;
  function attempt(peer){
    if(generation!==state.survivalGeneration)return;
    if(!peer.open){state.survivalConnectInFlight=false;try{if(peer.disconnected)peer.reconnect();}catch{}scheduleSurvivalReconnect();return;}
    state.survivalConnectInFlight=true;
    const connection=peer.connect(peerIdForRoom(state.room),{reliable:true,serialization:'json'});
    let routed=false,failedOnce=false;
    const failed=()=>{if(routed||failedOnce||generation!==state.survivalGeneration)return;failedOnce=true;state.survivalConnectInFlight=false;clearTimeout(state.survivalOfferTimer);try{connection.close();}catch{}scheduleSurvivalReconnect();};
    connection.on('data',message=>{if(routed||generation!==state.survivalGeneration)return;if(message?.protocol===CatSurvivalSession.PROTOCOL&&message.type==='offer'){routed=true;state.survivalConnectInFlight=false;adoptSurvivalGuest(connection,message);}});
    connection.on('error',failed);connection.on('close',failed);
    state.survivalOfferTimer=setTimeout(failed,Math.min(4000,Math.max(1,(state.survivalReconnectUntil||survivalNow()+4000)-survivalNow())));
  }
  if(state.peer&&!state.peer.destroyed){attempt(state.peer);return true;}
  state.survivalConnectInFlight=true;
  const peer=new Peer(undefined,peerOptions());state.peer=peer;
  peer.on('open',()=>{if(state.peer===peer)attempt(peer);});
  peer.on('error',()=>{if(generation!==state.survivalGeneration)return;state.survivalConnectInFlight=false;scheduleSurvivalReconnect();});
  render();return true;
}
function survivalStart(){if(state.role!=='host'||!state.survivalSession)return false;const ok=state.survivalSession.start();if(!ok)toast('需要至少兩位貓友完成連線；正式開賽後不能重複開始');else applySurvivalSnapshot(state.survivalSession.getState());return ok;}
function survivalChoose(index){
  const board=state.game?.boards?.[state.you];if(!board||!state.survivalSession||!canRevealBoardCell(index))return false;
  const action={type:'guess',index,boardId:board.puzzle.id,actionId:crypto.randomUUID()};state.pendingAction=action;render();
  const result=state.survivalSession.submit(action);
  if(result===false||result?.accepted===false){survivalAck({actionId:action.actionId,accepted:false,reason:result?.reason||'disconnected'});render();return false;}
  if(state.role==='host')applySurvivalSnapshot(state.survivalSession.getState());
  if(state.pendingAction?.actionId===action.actionId){
    const timer=setTimeout(()=>{state.survivalActionTimers?.delete(timer);if(state.pendingAction?.actionId===action.actionId){state.pendingAction=null;toast('尚未收到翻格確認，請檢查連線');render();}},4000);
    state.survivalActionTimers??=new Set();state.survivalActionTimers.add(timer);
  }return true;
}
function survivalKeydown(event){
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();
  const index=+event.currentTarget.dataset.index,delta={ArrowUp:-6,ArrowDown:6,ArrowLeft:-1,ArrowRight:1}[event.key];
  if(event.key==='ArrowLeft'&&index%6===0||event.key==='ArrowRight'&&index%6===5)return;
  for(let next=index+delta;next>=0&&next<36;next+=delta){const cell=$(`#survivalBoard .cell[data-index="${next}"]`);if(cell&&!cell.disabled){cell.focus({preventScroll:true});return;}}
}
function survivalCopyInvite(){if(!['hosting','connected'].includes(state.survivalLinkStatus))return false;$('#copyInvite').click();return true;}
function survivalLeave(){
  if(state.role==='host'&&['countdown','playing'].includes(state.game?.status)&&typeof confirm==='function'&&!confirm('你是房主。離開會中止所有人的這一局，確定離開嗎？'))return false;
  disposeSurvivalRoom('host-left');state.game=null;state.role=null;state.you=0;state.notes.clear();state.selectedCell=null;state.clockOffset=0;document.body.classList.remove('is-battle','is-survival');$('#game').classList.add('hidden');$('#setup').classList.remove('hidden');$('#host').disabled=false;$('#host').textContent='🐾 建立房間';$('#setupStatus').textContent='已離開房間';showEntryChoice();return true;
}
setInterval(()=>{if(state.game?.settings.mode!=='survival')return;if(state.survivalSession?.getServerTime)state.clockOffset=state.survivalSession.getServerTime()-Date.now();syncBoardGestures();if(typeof updateSurvivalTimers==='function')updateSurvivalTimers();},100);
document.addEventListener('visibilitychange',()=>{if(state.game?.settings.mode!=='survival')return;state.suppressSurvivalFX=true;if(document.hidden){if(typeof clearSurvivalEffects==='function')clearSurvivalEffects();}else render();});
window.addEventListener('offline',()=>{if(state.game?.settings.mode==='survival'&&state.role==='host')state.survivalSession?.abort('host-offline');});
window.addEventListener('beforeunload',()=>{if(state.survivalSession)disposeSurvivalRoom('host-left');});
