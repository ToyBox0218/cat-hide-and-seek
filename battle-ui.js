'use strict';
/* UI and transport adapter. Authority, puzzle generation and public snapshots live in battle-engine.js. */
const battleNow=()=>Date.now()+(state.clockOffset||0);
const isBattle=()=>state.game?.settings.mode==='battle';
const battleNotesAllowed=game=>game.status==='playing'||(game.status==='paused'&&(game.pausedFrom||game._pausedFrom)!=='countdown');
const battleCat=(variant,extra='')=>`<span class="cat-art ${variant%2?'orange':'gray'} ${extra}" aria-hidden="true"></span>`;
function battleMessage(){
  const game=state.game,board=game.boards[state.you];
  if(game.status==='lobby')return '雙方就緒後，開始同步讀秒。';
  if(game.status==='countdown')return '準備好了嗎？讀秒結束後一起找貓！';
  if(game.status==='paused')return '連線中斷，雙方已暫停。60 秒內重新連線可接回原本盤面。';
  if(game.status==='aborted')return '連線未能恢復，本局已結束，不判勝負。';
  if(game.status==='finished')return game.winner===state.you?'漂亮！所有連鎖都算數。':'這次讓貓友搶先了，再來一局吧！';
  if(state.pendingAction)return '等待房主確認…';
  const remaining=board.cooldownUntil-battleNow();
  if(remaining>350)return `稍等 ${(remaining/1000).toFixed(1)} 秒，再找下一隻。私人筆記仍可使用。`;
  if(state.mode==='note')return '私人筆記只留在你的瀏覽器；再按一次可取消。';
  return board.combo?`連鎖 ${board.combo}！下一隻造成 ${(board.combo+1)*5} 傷害，換盤也不中斷。`:'請找出貓咪！先找到一隻，開始你的連鎖。';
}
function renderBattle(){
  const game=state.game;if(!game||!game.boards)return;
  const event=game.lastEvent,sourceRect=battleEventCellRect(event);
  if(['finished','aborted','paused'].includes(game.status))clearBattleFX();
  document.body.classList.add('is-battle');$('#setup').classList.add('hidden');$('#game').classList.remove('hidden');$('#battleArena').classList.remove('hidden');
  const own=game.boards[state.you],oldBoard=state.battleBoardId;
  if(oldBoard&&oldBoard!==own.puzzle.id){state.notes.clear();state.pendingAction=null;state.selectedCell=null;saveLocal()}
  state.battleBoardId=own.puzzle.id;
  if(state.pendingAction&&(state.pendingAction.boardId!==own.puzzle.id||own.found.includes(state.pendingAction.index)||own.misses.includes(state.pendingAction.index)||game.status!=='playing'))state.pendingAction=null;
  $('#battleConnection').textContent=state.practice?'本機練習 · 對手不會行動':game.status==='paused'?'已暫停 · 等待重連':game.status==='aborted'?'本局已中止':`${state.room} · ${game.status==='lobby'?'同步就緒中':game.status==='countdown'?'開賽讀秒':'P2P 連線'}`;
  $('#leavePractice').classList.toggle('hidden',!state.practice);$('#battleCopyRoom').classList.toggle('hidden',!!state.practice);
  $('#battleMute').textContent=state.muted?'🔇':'🔊';$('#battleMute').setAttribute('aria-pressed',String(state.muted));
  $('#battleReconnect').classList.toggle('hidden',game.status!=='paused'||state.manual||state.role!=='guest');
  $('#battleAbort').classList.toggle('hidden',game.status!=='paused');$('#battleReturn').classList.toggle('hidden',game.status!=='aborted');
  $('#battleGuess').classList.toggle('active',state.mode==='guess');$('#battleNote').classList.toggle('active',state.mode==='note');
  const focused=document.activeElement?.closest('.battle-board .cell')?.dataset.index;
  for(const [side,who] of [['local',state.you],['opponent',1-state.you]]){
    const board=game.boards[who],player=game.players[who],root=$(`.battle-side.${side}`),local=side==='local',maxHP=player.maxHP||game.settings.maxHP||150;
    root.dataset.player=who;
    root.innerHTML=`<div class="battle-player"><div class="portrait">${playerAvatar(player.avatar,'avatar-character')}</div><div class="player-identity"><b>${local?'你':state.practice?'練習貓友':'對手'}</b><span>${escapeHTML(player.nickname)}</span></div><div class="hp-meter" role="meter" aria-label="${local?'你的':'對手'}血量" aria-valuemin="0" aria-valuemax="${maxHP}" aria-valuenow="${player.hp}"><i style="width:${Math.max(0,player.hp/maxHP*100)}%"></i><span>${player.hp} / ${maxHP}</span></div></div><div class="combo-badge"><span>🐾 連鎖 <b>${board.combo}</b></span><span>下次傷害 <strong>${5*(board.combo+1)}</strong></span></div><div class="board-card"><div class="board-heading"><b>${local?'你的尋貓小屋':'貓友的小屋'}</b><span>第 ${board.number} 盤 · ${local?'6×6': '僅觀看'}</span></div><div class="battle-lock hidden" role="status" aria-live="polite"><span class="lock-icon" aria-hidden="true">🔒</span><div class="lock-copy"><strong>找貓暫時鎖定</strong><span class="lock-seconds"></span></div><span class="lock-progress" aria-hidden="true"><i></i></span><span class="lock-note">私人筆記仍可使用</span></div><div class="battle-board" role="grid" aria-label="${local?'你的尋貓棋盤':'對手唯讀棋盤'}" style="--n:6"></div></div><div class="cat-basket" aria-label="本盤已找到 ${board.found.length} 隻貓">${Array.from({length:6},(_,i)=>`<span class="basket-cat ${i<board.found.length?'filled':'empty'}">${i<board.found.length?battleCat(stableHash(`${board.puzzle.id}:${board.found[i]}`)):'♧'}</span>`).join('')}<b>${board.found.length} / 6</b></div>`;
    const grid=root.querySelector('.battle-board'),palette=regionPalette(board.puzzle);
    grid.dataset.boardId=board.puzzle.id;
    for(let index=0;index<36;index++){
      const cell=document.createElement(local?'button':'span'),region=board.puzzle.regions[index],row=Math.floor(index/6),col=index%6;
      cell.className='cell';cell.dataset.index=index;cell.dataset.region=region;cell.setAttribute('role','gridcell');cell.style.setProperty('--bg',palette[region]);cell.setAttribute('aria-label',`第 ${row+1} 行，第 ${col+1} 列，區域 ${region+1}`);
      if(col===5||board.puzzle.regions[index+1]!==region)cell.classList.add('er');if(row===5||board.puzzle.regions[index+6]!==region)cell.classList.add('eb');
      const found=board.found.includes(index),miss=board.misses.includes(index),out=excluded(board,index);
      if(found){cell.classList.add('cat');cell.innerHTML=battleCat(stableHash(`${board.puzzle.id}:${index}`));cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，已找到貓`)}
      else if(miss){cell.classList.add('opened');cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，翻開空格`)}
      else if(out){cell.classList.add('auto-x');cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，規則排除`)}
      else if(local&&state.notes.has(index)){cell.classList.add('note');cell.setAttribute('aria-label',`${cell.getAttribute('aria-label')}，私人筆記`)}
      if(game.lastEvent?.who===who&&game.lastEvent?.boardId===board.puzzle.id&&game.lastEvent?.index===index)cell.classList.add('latest-result');
      if(local){cell.type='button';cell.disabled=found||miss||out||(state.mode==='note'?!battleNotesAllowed(game):(game.status!=='playing'||!!state.pendingAction||board.cooldownUntil>battleNow()));if(state.pendingAction?.index===index)cell.classList.add('pending-cell');cell.onclick=()=>battleChoose(index);cell.onkeydown=battleKeydown;}
      else{cell.setAttribute('aria-readonly','true');cell.setAttribute('aria-disabled','true');}
      grid.appendChild(cell);
    }
  }
  if(focused!==undefined)$(`.battle-side.local .cell[data-index="${focused}"]`)?.focus({preventScroll:true});
  $('#battleNotice').textContent=battleMessage();
  observeBattleEvent(event,sourceRect);
  refreshBattleOverlays();
  if(game.status==='finished'&&!$('#result').open){$('#resultTitle').textContent=game.winner===state.you?'你贏了！喵～':'下一局再加油！';$('#resultScore').textContent=`剩餘血量 ${game.players[state.you].hp}：${game.players[1-state.you].hp}｜最後一擊 ${game.lastEvent?.damage||0} 傷害`;$('#rematch').textContent=state.practice?'再練習一局':'雙方同意，再來一局';$('#result').showModal();tone('finish')}
  if(game.status!=='finished'&&$('#result').open)$('#result').close();
  state.battleCooldownActive=own.cooldownUntil>battleNow();
}
function battleChoose(index){
  const game=state.game,board=game.boards[state.you];
  if(!battleNotesAllowed(game))return;
  if(board.found.includes(index)||board.misses.includes(index)||excluded(board,index))return;
  if(state.mode==='note'){state.notes.has(index)?state.notes.delete(index):state.notes.add(index);saveLocal();render();return}
  if(game.status!=='playing'||state.pendingAction||board.cooldownUntil>battleNow())return;
  const action={type:'guess',index,boardId:board.puzzle.id,actionId:crypto.randomUUID()};state.pendingAction=action;render();
  if(state.role==='host')act(0,action);else{send({type:'action',action});setTimeout(()=>{if(state.pendingAction?.actionId===action.actionId){state.pendingAction=null;toast('尚未收到確認，請檢查連線');render()}},4000)}
}
function battleKeydown(event){
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();
  const index=+event.currentTarget.dataset.index,delta={ArrowUp:-6,ArrowDown:6,ArrowLeft:-1,ArrowRight:1}[event.key];let next=index+delta;
  if((event.key==='ArrowLeft'&&index%6===0)||(event.key==='ArrowRight'&&index%6===5))return;
  while(next>=0&&next<36){const cell=$(`.battle-side.local .cell[data-index="${next}"]`);if(!cell?.disabled){cell?.focus();return}next+=delta;}
}
function battleEventCellRect(event){
  if(!event||event.type!=='hit'||!Number.isInteger(event.index))return null;
  const side=$(`.battle-side[data-player="${event.who}"]`),grid=side?.querySelector('.battle-board');
  if(!grid||grid.dataset.boardId!==event.boardId)return null;
  const cell=grid.querySelector(`.cell[data-index="${event.index}"]`);
  return cell?.getBoundingClientRect()||null;
}
function clearBattleFX(){
  for(const timer of state.battleFXTimers||[])clearTimeout(timer);
  for(const node of state.battleFXNodes||[])node.remove();
  state.battleFXTimers=new Set();state.battleFXNodes=new Set();state.battleFXBatches=[];
  document.querySelectorAll('.hp-hit').forEach(node=>node.classList.remove('hp-hit'));
}
function observeBattleEvent(event,sourceRect){
  const game=state.game;if(!game)return false;
  if(state.battleFXGameId!==game.id){clearBattleFX();state.battleFXGameId=game.id;state.battleEventHighWater=-1;state.battleSeenEvents=new Set();}
  if(!event)return false;
  const sequence=Number.isFinite(event.sequence)?event.sequence:game.revision||0;
  const key=event.id||`${game.id}:${sequence}:${event.at}:${event.type}:${event.who}:${event.index}`;
  const seen=state.battleSeenEvents||(state.battleSeenEvents=new Set());
  const duplicate=seen.has(key)||sequence<=state.battleEventHighWater;
  seen.add(key);if(seen.size>64)seen.delete(seen.values().next().value);
  state.battleEventHighWater=Math.max(state.battleEventHighWater??-1,sequence);
  if(state.suppressBattleFX){state.suppressBattleFX=false;return false;}
  if(duplicate||document.hidden||game.status!=='playing'||battleNow()-(event.at||0)>1800)return false;
  if(event.type==='hit'){tone('cat');battleAttackFX(event,sourceRect);return true;}
  if(event.type==='miss'){tone('miss');return true;}
  return false;
}
function battleAttackFX(event,sourceRect){
  const game=state.game;if(!game||game.status!=='playing'||document.hidden)return;
  const target=$(`.battle-side[data-player="${1-event.who}"] .hp-meter`);if(!target)return;
  const batch={nodes:[],timers:[]};
  state.battleFXNodes??=new Set();state.battleFXTimers??=new Set();state.battleFXBatches??=[];
  const removeBatch=old=>{for(const timer of old.timers){clearTimeout(timer);state.battleFXTimers.delete(timer);}for(const node of old.nodes){node.remove();state.battleFXNodes.delete(node);}};
  while(state.battleFXBatches.length>=3)removeBatch(state.battleFXBatches.shift());
  state.battleFXBatches.push(batch);
  const add=(node,parent=document.body)=>{node.dataset.eventId=event.id||String(event.sequence);parent.appendChild(node);state.battleFXNodes.add(node);batch.nodes.push(node);return node;};
  const timer=setTimeout(()=>{removeBatch(batch);state.battleFXBatches=state.battleFXBatches.filter(value=>value!==batch);target.classList.remove('hp-hit');},1100);
  batch.timers.push(timer);state.battleFXTimers.add(timer);
  target.classList.add('hp-hit');
  const number=document.createElement('span');number.className='battle-damage';number.textContent=`−${event.damage}`;add(number,target);
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const from=sourceRect||battleEventCellRect(event);if(!from)return;
  const to=target.getBoundingClientRect(),x=from.left+from.width/2,y=from.top+from.height/2,tx=to.left+to.width/2,ty=to.top+to.height/2;
  const intensity=Math.min(3,1+Math.floor((Math.max(1,event.combo)-1)/3));
  const position=node=>{node.style.left=`${x}px`;node.style.top=`${y}px`;node.style.setProperty('--dx',`${tx-x}px`);node.style.setProperty('--dy',`${ty-y}px`);node.style.setProperty('--lift',`${Math.min(65,Math.max(28,from.height))}px`);node.style.setProperty('--scale',String(intensity));return node;};
  const cat=document.createElement('div');cat.className='battle-cat-launch';cat.innerHTML=battleCat(stableHash(`${event.boardId}:${event.index}`));add(position(cat));
  const paw=document.createElement('div');paw.className='battle-paw-shot';paw.textContent='🐾';add(position(paw));
  for(let i=0;i<intensity;i++){
    const spark=document.createElement('div');spark.className='battle-spark';spark.style.left=`${tx}px`;spark.style.top=`${ty}px`;spark.style.setProperty('--scale',String(1+i));spark.style.setProperty('--delay',`${570+i*45}ms`);add(spark);
  }
}
function refreshBattleOverlays(){
  const game=state.game;if(!isBattle())return;
  const now=battleNow(),opening=$('#battleOpening');
  const countdown=game.status==='countdown';
  const prompt=game.status==='playing'&&Number.isFinite(game.startedAt)&&now>=game.startedAt&&now-game.startedAt<1500;
  opening.classList.toggle('hidden',!countdown&&!prompt);
  opening.classList.toggle('is-countdown',countdown);opening.classList.toggle('is-start-prompt',prompt);
  const caption=opening.querySelector('.opening-caption'),count=opening.querySelector('.opening-count'),text=opening.querySelector('.opening-prompt');
  if(caption)caption.textContent=countdown?'準備好了嗎？':'開賽！';
  const seconds=countdown?Math.max(0,Math.ceil((game.startAt-now)/1000)):0;
  if(count)count.textContent=countdown?(seconds>0?String(seconds):'就緒'):' ';
  if(text)text.textContent=countdown?(seconds>0?'讀秒結束，一起找貓':'等待房主開賽確認…'):'請找出貓咪！';
  const beat=countdown&&seconds>0?`${game.id}:${game.startAt}:${seconds}`:null;
  if(beat&&state.battleOpeningBeat!==beat){state.battleOpeningBeat=beat;if(!document.hidden)tone('turn');}
  for(const [side,who] of [['local',state.you],['opponent',1-state.you]]){
    const board=game.boards[who],root=$(`.battle-side.${side}`),lock=root?.querySelector('.battle-lock');if(!lock)continue;
    const remaining=game.status==='playing'&&board.cooldownKind==='miss'?Math.max(0,board.cooldownUntil-now):0;
    lock.classList.toggle('hidden',remaining<=0);
    lock.classList.toggle('notes-available',side==='local'&&state.mode==='note');
    const secondsNode=lock.querySelector('.lock-seconds'),progress=lock.querySelector('.lock-progress > i'),note=lock.querySelector('.lock-note');
    if(secondsNode)secondsNode.textContent=`${(Math.ceil(remaining/100)/10).toFixed(1)} 秒`;
    const duration=Math.max(1,board.cooldownUntil-(board.cooldownStartedAt||board.cooldownUntil-2000));
    if(progress)progress.style.width=`${Math.max(0,Math.min(100,remaining/duration*100))}%`;
    if(note)note.textContent=side==='local'?'私人筆記仍可使用':'對手正在恢復';
  }
}
function updateBattleTimers(){
  if(!isBattle())return;
  const game=state.game;
  if(state.role==='host'&&CatBattle.advance(game,Date.now())){broadcast();return;}
  if(['finished','aborted','paused'].includes(game.status))clearBattleFX();
  refreshBattleOverlays();$('#battleNotice').textContent=battleMessage();
  if(game.status==='playing'&&state.battleCooldownActive&&game.boards[state.you].cooldownUntil<=battleNow())render();
  if(['playing','countdown'].includes(game.status)&&!state.practice&&state.transport?.open()&&Date.now()-(state.lastPong||Date.now())>8000){onClose();state.transport.close();}
  if(game.status==='paused'&&state.disconnectAt&&Date.now()-state.disconnectAt>=60000){CatBattle.abort(game);if(state.role==='host')broadcast();else{saveLocal();render();}}
}

function startPractice(){
  clearBattleFX();state.suppressBattleFX=false;state.battleOpeningBeat=null;
  state.transportGeneration=(state.transportGeneration||0)+1;state.transport?.close();state.peer?.destroy();state.peer=null;state.transport=null;state.practice=true;state.role='host';state.you=0;state.room='本機練習';state.clockOffset=0;state.notes.clear();state.pendingAction=null;state.battleBoardId=null;state.battleObservedEvent=null;state.mode='guess';
  state.game=CatBattle.create({mode:'battle',maxHP:150},[{nickname:$('#nick').value||'奶油虎斑',avatar:state.avatar,connected:true},{nickname:'暖暖橘子',avatar:1,connected:true}]);CatBattle.start(state.game);render();
}
$('#previewBattle').onclick=startPractice;
$('#leavePractice').onclick=()=>{clearBattleFX();state.transportGeneration=(state.transportGeneration||0)+1;state.transport?.close();state.peer?.destroy();state.transport=null;state.peer=null;state.practice=false;state.game=null;state.notes.clear();state.battleBoardId=null;document.body.classList.remove('is-battle');$('#game').classList.add('hidden');$('#setup').classList.remove('hidden');showEntryChoice();};
$('#battleReturn').onclick=()=>$('#leavePractice').onclick();
$('#battleGuess').onclick=()=>{state.mode='guess';render()};$('#battleNote').onclick=()=>{state.mode='note';render()};$('#battleHelp').onclick=()=>$('#helpDialog').showModal();$('#battleMute').onclick=()=>{$('#mute').click();render()};$('#battleCopyRoom').onclick=event=>copyRoomCode(event.currentTarget);
$('#battleAbort').onclick=()=>{if(state.role==='host'){CatBattle.abort(state.game);broadcast()}else send({type:'battleAbort'});};
$('#battleReconnect').onclick=()=>{state.peer?.destroy();state.transport=null;$('#roomInput').value=state.room;startPeerGuest();toast('正在重新尋找房主…')};
const priorRematch=$('#rematch').onclick;$('#rematch').onclick=()=>{if(state.practice){$('#result').close();startPractice()}else priorRematch()};
setInterval(updateBattleTimers,100);
setInterval(()=>{if(isBattle()&&!state.practice&&state.transport?.open())send({type:'ping',sentAt:Date.now()});},2000);
document.addEventListener('visibilitychange',()=>{
  if(!isBattle())return;
  if(document.hidden){clearBattleFX();state.suppressBattleFX=true;}
  else{state.suppressBattleFX=true;updateBattleTimers();render();}
});
