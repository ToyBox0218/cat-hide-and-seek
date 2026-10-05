'use strict';
/* UI and transport adapter. Authority, puzzle generation and public snapshots live in battle-engine.js. */
const battleNow=()=>Date.now()+(state.clockOffset||0);
const isBattle=()=>state.game?.settings.mode==='battle';
const battleCat=(variant,extra='')=>`<span class="cat-art ${variant%2?'orange':'gray'} ${extra}" aria-hidden="true"></span>`;
function battleMessage(){
  const game=state.game,board=game.boards[state.you];
  if(game.status==='paused')return '連線中斷，雙方已暫停。60 秒內重新連線可接回原本盤面。';
  if(game.status==='aborted')return '連線未能恢復，本局已結束，不判勝負。';
  if(game.status==='finished')return game.winner===state.you?'漂亮！所有連鎖都算數。':'這次讓貓友搶先了，再來一局吧！';
  if(state.pendingAction)return '等待房主確認…';
  const remaining=board.cooldownUntil-battleNow();
  if(remaining>350)return `稍等 ${(remaining/1000).toFixed(1)} 秒，再找下一隻。私人筆記仍可使用。`;
  if(state.mode==='note')return '私人筆記只留在你的瀏覽器；再按一次可取消。';
  return board.combo?`連鎖 ${board.combo}！下一隻造成 ${(board.combo+1)*5} 傷害，換盤也不中斷。`:'先找出一隻貓，開始你的連鎖！';
}
function renderBattle(){
  const game=state.game;if(!game||!game.boards)return;
  document.body.classList.add('is-battle');$('#setup').classList.add('hidden');$('#game').classList.remove('hidden');$('#battleArena').classList.remove('hidden');
  const own=game.boards[state.you],oldBoard=state.battleBoardId;
  if(oldBoard&&oldBoard!==own.puzzle.id){state.notes.clear();state.pendingAction=null;state.selectedCell=null;saveLocal()}
  state.battleBoardId=own.puzzle.id;
  if(state.pendingAction&&(state.pendingAction.boardId!==own.puzzle.id||own.found.includes(state.pendingAction.index)||own.misses.includes(state.pendingAction.index)||game.status!=='playing'))state.pendingAction=null;
  $('#battleConnection').textContent=state.practice?'本機練習 · 對手不會行動':game.status==='paused'?'已暫停 · 等待重連':game.status==='aborted'?'本局已中止':`${state.room} · ${game.status==='lobby'?'等待貓友':'P2P 連線'}`;
  $('#leavePractice').classList.toggle('hidden',!state.practice);$('#battleCopyRoom').classList.toggle('hidden',!!state.practice);
  $('#battleMute').textContent=state.muted?'🔇':'🔊';$('#battleMute').setAttribute('aria-pressed',String(state.muted));
  $('#battleReconnect').classList.toggle('hidden',game.status!=='paused'||state.manual||state.role!=='guest');
  $('#battleAbort').classList.toggle('hidden',game.status!=='paused');$('#battleReturn').classList.toggle('hidden',game.status!=='aborted');
  $('#battleGuess').classList.toggle('active',state.mode==='guess');$('#battleNote').classList.toggle('active',state.mode==='note');
  const focused=document.activeElement?.closest('.battle-board .cell')?.dataset.index;
  for(const [side,who] of [['local',state.you],['opponent',1-state.you]]){
    const board=game.boards[who],player=game.players[who],root=$(`.battle-side.${side}`),local=side==='local',maxHP=player.maxHP||game.settings.maxHP||150;
    root.dataset.player=who;
    root.innerHTML=`<div class="battle-player"><div class="portrait">${playerAvatar(player.avatar,'avatar-character')}</div><div class="player-identity"><b>${local?'你':state.practice?'練習貓友':'對手'}</b><span>${escapeHTML(player.nickname)}</span></div><div class="hp-meter" role="meter" aria-label="${local?'你的':'對手'}血量" aria-valuemin="0" aria-valuemax="${maxHP}" aria-valuenow="${player.hp}"><i style="width:${Math.max(0,player.hp/maxHP*100)}%"></i><span>${player.hp} / ${maxHP}</span></div></div><div class="combo-badge"><span>🐾 連鎖 <b>${board.combo}</b></span><span>下次傷害 <strong>${5*(board.combo+1)}</strong></span></div><div class="board-card"><div class="board-heading"><b>${local?'你的尋貓小屋':'貓友的小屋'}</b><span>第 ${board.number} 盤 · ${local?'6×6': '僅觀看'}</span></div><div class="battle-board" role="grid" aria-label="${local?'你的尋貓棋盤':'對手唯讀棋盤'}" style="--n:6"></div></div><div class="cat-basket" aria-label="本盤已找到 ${board.found.length} 隻貓">${Array.from({length:6},(_,i)=>`<span class="basket-cat ${i<board.found.length?'filled':'empty'}">${i<board.found.length?battleCat(stableHash(`${board.puzzle.id}:${board.found[i]}`)):'♧'}</span>`).join('')}<b>${board.found.length} / 6</b></div>`;
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
      if(local){cell.type='button';cell.disabled=found||miss||out||(state.mode!=='note'&&(game.status!=='playing'||!!state.pendingAction||board.cooldownUntil>battleNow()));if(state.pendingAction?.index===index)cell.classList.add('pending-cell');cell.onclick=()=>battleChoose(index);cell.onkeydown=battleKeydown;}
      else{cell.setAttribute('aria-readonly','true');cell.setAttribute('aria-disabled','true');}
      grid.appendChild(cell);
    }
  }
  if(focused!==undefined)$(`.battle-side.local .cell[data-index="${focused}"]`)?.focus({preventScroll:true});
  $('#battleNotice').textContent=battleMessage();
  const event=game.lastEvent,eventKey=event?`${event.sequence||game.revision||''}:${event.at}:${event.who}:${event.boardId}:${event.index}:${event.type}`:null;
  if(event&&eventKey!==state.battleObservedEvent){state.battleObservedEvent=eventKey;if(event.type==='hit'){tone('cat');requestAnimationFrame(()=>battleAttackFX(event));}else if(event.type==='miss')tone('miss');}
  if(game.status==='finished'&&!$('#result').open){$('#resultTitle').textContent=game.winner===state.you?'你贏了！喵～':'下一局再加油！';$('#resultScore').textContent=`剩餘血量 ${game.players[state.you].hp}：${game.players[1-state.you].hp}｜最高攻勢：${own.combo} 連鎖`;$('#rematch').textContent=state.practice?'再練習一局':'雙方同意，再來一局';$('#result').showModal();tone('finish')}
  if(game.status!=='finished'&&$('#result').open)$('#result').close();
  state.battleCooldownActive=own.cooldownUntil>battleNow();
}
function battleChoose(index){
  const game=state.game,board=game.boards[state.you];
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
function battleAttackFX(event){
  const source=$(`.battle-side[data-player="${event.who}"] .combo-badge`),target=$(`.battle-side[data-player="${1-event.who}"] .hp-meter`);if(!source||!target)return;
  target.classList.add('hp-hit');const number=document.createElement('span');number.className='battle-damage';number.textContent=`−${event.damage}`;target.appendChild(number);setTimeout(()=>{number.remove();target.classList.remove('hp-hit')},900);
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const from=source.getBoundingClientRect(),to=target.getBoundingClientRect(),paw=document.createElement('div');paw.className='battle-fx';paw.textContent='🐾';paw.style.left=`${from.left+from.width/2}px`;paw.style.top=`${from.top+from.height/2}px`;paw.style.setProperty('--dx',`${to.left+to.width/2-(from.left+from.width/2)}px`);paw.style.setProperty('--dy',`${to.top+to.height/2-(from.top+from.height/2)}px`);document.body.appendChild(paw);setTimeout(()=>paw.remove(),780);
}
function startPractice(){
  state.transportGeneration=(state.transportGeneration||0)+1;state.transport?.close();state.peer?.destroy();state.peer=null;state.transport=null;state.practice=true;state.role='host';state.you=0;state.room='本機練習';state.clockOffset=0;state.notes.clear();state.pendingAction=null;state.battleBoardId=null;state.battleObservedEvent=null;state.mode='guess';
  state.game=CatBattle.create({mode:'battle',maxHP:150},[{nickname:$('#nick').value||'奶油虎斑',avatar:state.avatar,connected:true},{nickname:'暖暖橘子',avatar:1,connected:true}]);CatBattle.start(state.game);render();
}
$('#previewBattle').onclick=startPractice;
$('#leavePractice').onclick=()=>{state.transportGeneration=(state.transportGeneration||0)+1;state.transport?.close();state.peer?.destroy();state.transport=null;state.peer=null;state.practice=false;state.game=null;state.notes.clear();state.battleBoardId=null;document.body.classList.remove('is-battle');$('#game').classList.add('hidden');$('#setup').classList.remove('hidden');showEntryChoice();};
$('#battleReturn').onclick=()=>$('#leavePractice').onclick();
$('#battleGuess').onclick=()=>{state.mode='guess';render()};$('#battleNote').onclick=()=>{state.mode='note';render()};$('#battleHelp').onclick=()=>$('#helpDialog').showModal();$('#battleMute').onclick=()=>{$('#mute').click();render()};$('#battleCopyRoom').onclick=event=>copyRoomCode(event.currentTarget);
$('#battleAbort').onclick=()=>{if(state.role==='host'){CatBattle.abort(state.game);broadcast()}else send({type:'battleAbort'});};
$('#battleReconnect').onclick=()=>{state.peer?.destroy();state.transport=null;$('#roomInput').value=state.room;startPeerGuest();toast('正在重新尋找房主…')};
const priorRematch=$('#rematch').onclick;$('#rematch').onclick=()=>{if(state.practice){$('#result').close();startPractice()}else priorRematch()};
setInterval(()=>{
  if(!isBattle())return;const game=state.game;
  if(game.status==='playing'){
    $('#battleNotice').textContent=battleMessage();
    if(state.battleCooldownActive&&game.boards[state.you].cooldownUntil<=battleNow())render();
    if(!state.practice&&state.transport?.open()&&Date.now()-(state.lastPong||Date.now())>8000){onClose();state.transport.close();}
  }
  if(game.status==='paused'&&state.disconnectAt&&Date.now()-state.disconnectAt>=60000){CatBattle.abort(game);if(state.role==='host')broadcast();else{saveLocal();render();}}
},100);
setInterval(()=>{if(isBattle()&&!state.practice&&state.transport?.open())send({type:'ping'})},2000);
