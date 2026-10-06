'use strict';
/* UI and transport adapter. Authority, puzzle generation and public snapshots live in battle-engine.js. */
const battleNow=()=>Date.now()+(state.clockOffset||0);
const isBattle=()=>state.game?.settings.mode==='battle';
const battleNotesAllowed=game=>game.status==='playing'||(game.status==='paused'&&(game.pausedFrom||game._pausedFrom)!=='countdown');
function battleMissRemaining(game=state.game,who=state.you){
  if(!game||!battleNotesAllowed(game))return 0;
  const board=game.boards?.[who];if(board?.cooldownKind!=='miss')return 0;
  const at=game.status==='paused'&&Number.isFinite(game.pausedAt)?game.pausedAt:battleNow();
  return Math.max(0,board.cooldownUntil-at);
}
function battleMissLocked(game=state.game){return isBattle()&&battleMissRemaining(game)>0;}
const battleInputMode=(game=state.game)=>state.mode==='note'||battleMissLocked(game)?'note':'guess';
function captureBattlePress(cell,event){
  if(cell.disabled||event?.button>0)return;
  const game=state.game,board=game?.boards?.[state.you];if(!board)return;
  cell.battlePressIntent={mode:battleInputMode(game),gameId:game.id,boardId:board.puzzle.id,epoch:state.battleInputEpoch||0};
}

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
  if(battleMissLocked(game))return `暫停翻格 ${(Math.ceil(battleMissRemaining(game)/100)/10).toFixed(1)} 秒，現在可以做記號。`;
  if(state.mode==='note')return '記號模式已開：點格子切換紫色 ×；只有你看得到。';
  return board.combo?`連鎖 ${board.combo}！下一隻造成 ${(board.combo+1)*5} 傷害，換盤也不中斷。`:'請找出貓咪！先找到一隻，開始你的連鎖。';
}
function renderBattle(){
  const game=state.game;if(!game||!game.boards)return;
  const silentAudio=Boolean(state.suppressBattleFX||document.hidden);prepareGameAudio(game.id,game.status);
  const event=game.lastEvent,sourceRect=battleEventCellRect(event);
  if(['finished','aborted','paused'].includes(game.status))clearBattleFX();
  document.body.classList.add('is-battle');$('#setup').classList.add('hidden');$('#game').classList.remove('hidden');$('#battleArena').classList.remove('hidden');
  const own=game.boards[state.you],oldBoard=state.battleBoardId;
  if(oldBoard&&oldBoard!==own.puzzle.id){state.notes.clear();state.pendingAction=null;state.selectedCell=null;saveLocal()}
  state.battleBoardId=own.puzzle.id;
  if(state.pendingAction&&(state.pendingAction.boardId!==own.puzzle.id||own.found.includes(state.pendingAction.index)||own.misses.includes(state.pendingAction.index)||game.status!=='playing'))state.pendingAction=null;
  $('#battleConnection').textContent=state.practice?'本機練習 · 對手不會行動':game.status==='paused'?'已暫停 · 等待重連':game.status==='aborted'?'本局已中止':`${state.room} · ${game.status==='lobby'?'同步就緒中':game.status==='countdown'?'開賽讀秒':'P2P 連線'}`;
  $('#leavePractice').classList.toggle('hidden',!state.practice);$('#battleCopyRoom').classList.toggle('hidden',!!state.practice);
  syncAudioControls();syncNoteModeUI();
  $('#battleReconnect').classList.toggle('hidden',game.status!=='paused'||state.manual||state.role!=='guest');
  $('#battleAbort').classList.toggle('hidden',game.status!=='paused');$('#battleReturn').classList.toggle('hidden',game.status!=='aborted');

  const focused=document.activeElement?.closest('.battle-board .cell')?.dataset.index;
  for(const [side,who] of [['local',state.you],['opponent',1-state.you]]){
    const board=game.boards[who],player=game.players[who],root=$(`.battle-side.${side}`),local=side==='local',maxHP=player.maxHP||game.settings.maxHP||150;
    root.dataset.player=who;
    const viewKey=`${game.id}:${who}`;
    if(root.dataset.viewKey!==viewKey){root.dataset.viewKey=viewKey;root.innerHTML=`<div class="battle-player"><div class="portrait">${playerAvatar(player.avatar,'avatar-character')}</div><div class="player-identity"><b>${local?'你':state.practice?'練習貓友':'對手'}</b><span>${escapeHTML(player.nickname)}</span></div><div class="hp-meter" role="meter" aria-label="${local?'你的':'對手'}血量" aria-valuemin="0" aria-valuemax="${maxHP}" aria-valuenow="${player.hp}"><i class="hp-lag" style="width:${Math.max(0,player.hp/maxHP*100)}%"></i><i class="hp-fill" style="width:${Math.max(0,player.hp/maxHP*100)}%"></i><span>${player.hp} / ${maxHP}</span></div></div><div class="combo-badge"><span>🐾 連鎖 <b>${board.combo}</b></span><span>下次傷害 <strong>${5*(board.combo+1)}</strong></span></div><div class="board-card"><div class="capture-callout" role="status" aria-live="polite"></div><div class="board-heading"><b>${local?'你的尋貓小屋':'貓友的小屋'}</b><span>第 ${board.number} 盤 · ${local?'6×6': '僅觀看'}</span></div><div class="battle-lock-slot"><div class="battle-lock hidden" role="status" aria-live="polite"><span class="lock-icon" aria-hidden="true">🔒</span><div class="lock-copy"><strong>找貓暫時鎖定</strong><span class="lock-seconds"></span></div><span class="lock-progress" aria-hidden="true"><i></i></span><span class="lock-note">現在可以做記號</span></div></div><div class="battle-board" role="grid" aria-label="${local?'你的尋貓棋盤':'對手唯讀棋盤'}" style="--n:6"></div></div><div class="cat-basket" aria-label="本盤已找到 ${board.found.length} 隻貓">${Array.from({length:6},(_,i)=>`<span class="basket-cat ${i<board.found.length?'filled':'empty'}">${i<board.found.length?battleCat(stableHash(`${board.puzzle.id}:${board.found[i]}`)):'♧'}</span>`).join('')}<b>${board.found.length} / 6</b></div>`;}
    syncBattleSideHeader(root,game,board,player,local,maxHP);
    const grid=root.querySelector('.battle-board'),palette=regionPalette(board.puzzle);
    if(grid.dataset.boardId!==board.puzzle.id){
      grid.dataset.boardId=board.puzzle.id;grid.innerHTML='';
      for(let index=0;index<36;index++){
        const cell=document.createElement(local?'button':'span'),region=board.puzzle.regions[index],row=Math.floor(index/6),col=index%6;
        cell.className='cell';cell.dataset.index=index;cell.dataset.region=region;cell.setAttribute('role','gridcell');cell.style.setProperty('--bg',palette[region]);
        if(col===5||board.puzzle.regions[index+1]!==region)cell.classList.add('er');if(row===5||board.puzzle.regions[index+6]!==region)cell.classList.add('eb');
        if(local){cell.type='button';cell.onpointerdown=event=>captureBattlePress(cell,event);cell.onpointercancel=()=>{cell.battlePressIntent={cancelled:true};};cell.onclick=()=>{const intent=cell.battlePressIntent;cell.battlePressIntent=null;battleChoose(index,intent);};cell.onkeydown=battleKeydown;}
        else{cell.setAttribute('aria-readonly','true');cell.setAttribute('aria-disabled','true');}
        grid.appendChild(cell);
      }
    }
    for(const cell of Array.from(grid.children)){
      const index=+cell.dataset.index,region=board.puzzle.regions[index],row=Math.floor(index/6),col=index%6;
      const found=board.found.includes(index),miss=board.misses.includes(index);
      const cellState=found?'cat':miss?'opened':local&&state.notes.has(index)?'note':'hidden';
      if(cell.dataset.renderState!==cellState){
        cell.dataset.renderState=cellState;
        for(const name of ['cat','opened','auto-x','note'])cell.classList.toggle(name,name===cellState);
        if(found)cell.innerHTML=battleCat(stableHash(`${board.puzzle.id}:${index}`));
        else cell.textContent=miss?'×':cellState==='note'?'×':'';
        const suffix={cat:'，已找到貓',opened:'，已翻開的空格，確認沒有貓',note:'，私人筆記，尚未確認',hidden:''}[cellState];
        cell.setAttribute('aria-label',`第 ${row+1} 行，第 ${col+1} 列，區域 ${region+1}${suffix}`);
      }
      cell.classList.toggle('latest-result',game.lastEvent?.who===who&&game.lastEvent?.boardId===board.puzzle.id&&game.lastEvent?.index===index);
      if(local){cell.disabled=found||miss||(battleInputMode(game)==='note'?!battleNotesAllowed(game):(game.status!=='playing'||!!state.pendingAction||board.cooldownUntil>battleNow()));cell.classList.toggle('pending-cell',state.pendingAction?.index===index);}
    }
    const basket=root.querySelector('.cat-basket'),basketKey=`${board.puzzle.id}:${board.found.join(',')}`;
    if(basket.dataset.foundKey!==basketKey){
      basket.dataset.foundKey=basketKey;basket.setAttribute('aria-label',`本盤已找到 ${board.found.length} 隻貓`);
      basket.innerHTML=Array.from({length:6},(_,i)=>`<span class="basket-cat ${i<board.found.length?'filled':'empty'}">${i<board.found.length?battleCat(stableHash(`${board.puzzle.id}:${board.found[i]}`)):'♧'}</span>`).join('')+`<b>${board.found.length} / 6</b>`;
    }
  }

  if(focused!==undefined)$(`.battle-side.local .cell[data-index="${focused}"]`)?.focus({preventScroll:true});
  $('#battleNotice').textContent=battleMessage();
  observeBattleEvent(event,sourceRect);
  refreshBattleOverlays({silent:silentAudio});
  if(game.status==='finished'&&!$('#result').open){$('#resultTitle').textContent=game.winner===state.you?'你贏了！喵～':'下一局再加油！';$('#resultScore').textContent=`剩餘血量 ${game.players[state.you].hp}：${game.players[1-state.you].hp}｜最後一擊 ${game.lastEvent?.damage||0} 傷害`;$('#rematch').textContent=state.practice?'再練習一局':'雙方同意，再來一局';$('#result').showModal()}
  if(game.status==='finished'&&state.battleTerminalCue!==game.id){state.battleTerminalCue=game.id;if(!silentAudio){const winningCapture=game.lastEvent?.type==='hit'&&game.lastEvent.who===state.you;const voiced=winningCapture&&playCaptureSound(game.lastEvent.id||`${game.id}:final-capture`,game.lastEvent.combo);soundCue(game.winner===state.you?'win':'lose',{id:`${game.id}:finished`,delay:voiced?.68:0});}}
  if(game.status!=='finished'&&$('#result').open)$('#result').close();
  state.battleCooldownActive=own.cooldownUntil>battleNow();state.battleLagNeedsSync=false;
}
function syncBattleSideHeader(root,game,board,player,local,maxHP){
  const portrait=root.querySelector('.portrait');
  if(portrait.dataset.avatar!==String(player.avatar)){portrait.dataset.avatar=String(player.avatar);portrait.innerHTML=playerAvatar(player.avatar,'avatar-character');}
  const text=(selector,value)=>{const node=root.querySelector(selector);if(node&&node.textContent!==String(value))node.textContent=String(value);};
  text('.player-identity b',local?'你':state.practice?'練習貓友':'對手');text('.player-identity span',player.nickname);
  text('.combo-badge b',board.combo);text('.combo-badge strong',5*(board.combo+1));
  text('.board-heading b',local?'你的尋貓小屋':'貓友的小屋');text('.board-heading span',`第 ${board.number} 盤 · ${local?'6×6':'僅觀看'}`);
  const hp=root.querySelector('.hp-meter'),fill=hp.querySelector('.hp-fill'),lag=hp.querySelector('.hp-lag'),amount=hp.querySelector('span');
  const old=Number(hp.dataset.hp),ratio=Math.max(0,Math.min(100,player.hp/maxHP*100));
  hp.setAttribute('aria-valuemax',String(maxHP));hp.setAttribute('aria-valuenow',String(player.hp));
  if(amount)amount.textContent=`${player.hp} / ${maxHP}`;if(fill)fill.style.width=`${ratio}%`;
  if(lag){
    if(Number.isFinite(old)&&old>player.hp&&game.status==='playing'&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
      lag.style.transition='none';lag.style.width=`${Math.min(100,old/maxHP*100)}%`;lag.dataset.target=String(player.hp);
      state.battleFXFrames??=new Set();
      const frame=requestAnimationFrame(()=>{state.battleFXFrames.delete(frame);if(lag.dataset.target===String(player.hp)){lag.style.transition='';lag.style.width=`${ratio}%`;}});state.battleFXFrames.add(frame);
    }else if(!Number.isFinite(old)||old!==player.hp||game.status!=='playing'||document.hidden||state.suppressBattleFX||state.battleLagNeedsSync){lag.style.width=`${ratio}%`;lag.style.transition='';}
  }
  hp.dataset.hp=String(player.hp);
}
function refreshBattleInputState(){
  const game=state.game;if(!isBattle())return;
  const board=game.boards[state.you],grid=$('.battle-side.local .battle-board');if(!grid)return;
  for(const cell of Array.from(grid.children)){
    const index=+cell.dataset.index;
    cell.disabled=board.found.includes(index)||board.misses.includes(index)||(battleInputMode(game)==='note'?!battleNotesAllowed(game):(game.status!=='playing'||!!state.pendingAction||board.cooldownUntil>battleNow()));
  }
  state.battleCooldownActive=board.cooldownUntil>battleNow();syncNoteModeUI();
}

function battleChoose(index,intent){
  const game=state.game,board=game?.boards?.[state.you];
  if(!board||!Number.isInteger(index)||index<0||index>=36||!battleNotesAllowed(game))return;
  if(intent&&(intent.cancelled||intent.gameId!==game.id||intent.boardId!==board.puzzle.id||intent.epoch!==(state.battleInputEpoch||0)))return;
  const mode=intent?.mode||battleInputMode(game);
  if(mode==='guess'&&battleInputMode(game)!=='guess')return;
  if(board.found.includes(index)||board.misses.includes(index))return;
  if(mode==='note'){state.notes.has(index)?state.notes.delete(index):state.notes.add(index);saveLocal();render();return}
  if(game.status!=='playing'||state.pendingAction||board.cooldownUntil>battleNow())return;
  const action={type:'guess',index,boardId:board.puzzle.id,actionId:crypto.randomUUID()};state.pendingAction=action;render();
  if(state.role==='host')act(0,action);else{send({type:'action',action});setTimeout(()=>{if(state.pendingAction?.actionId===action.actionId){state.pendingAction=null;toast('尚未收到確認，請檢查連線');render()}},4000)}
}
function battleKeydown(event){
  if(['Enter',' ','Spacebar'].includes(event.key)){if(event.repeat){event.preventDefault();return;}captureBattlePress(event.currentTarget,event);return;}
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
  const inputBoundary=`${state.game?.id||''}:${state.game?.status||''}:${document.hidden?'hidden':'visible'}`;
  if(state.battleInputBoundary!==inputBoundary){state.battleInputBoundary=inputBoundary;state.battleInputEpoch=(state.battleInputEpoch||0)+1;}
  state.battleUnlockNoticeUntil=0;
  state.battleLagNeedsSync=true;
  for(const frame of state.battleFXFrames||[])cancelAnimationFrame(frame);state.battleFXFrames=new Set();
  for(const side of ['local','opponent']){const meter=$(`.battle-side.${side} .hp-meter`);if(!meter)continue;const value=Number(meter.getAttribute('aria-valuenow')),max=Number(meter.getAttribute('aria-valuemax')),lag=meter.querySelector('.hp-lag');if(lag&&Number.isFinite(value)&&max>0){lag.style.transition='none';lag.style.width=`${Math.max(0,Math.min(100,value/max*100))}%`;lag.dataset.target=String(value);}}
  for(const effect of state.battleClassEffects||[])effect.node.classList.remove(effect.className);state.battleClassEffects=new Set();
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
  if(event.type==='hit'){playBattleEventSound(event);battleAttackFX(event,sourceRect);return true;}
  if(event.type==='miss'){playBattleEventSound(event);return true;}
  if(event.type==='start')soundCue('start',{id:event.id||`${game.id}:start`});
  return false;
}
function playBattleEventSound(event){
  const game=state.game,id=event.id||`${game.id}:${event.sequence}:${event.at}`;
  if(event.type==='hit'){
    if(event.who===state.you)playCaptureSound(id,event.combo);
    soundCue('launch',{id,combo:event.combo,delay:.12});
    soundCue(event.who===state.you?'impact':'damage',{id,combo:event.combo,delay:.42});
    if(event.advanced&&event.who===state.you){soundCue('boardClear',{id,combo:event.combo,delay:.75});soundCue('newBoard',{id,delay:.98});}
  }else if(event.type==='miss'&&event.who===state.you){
    soundCue('miss',{id});soundCue('lock',{id,delay:.12});
    state.pendingUnlockCue={id,boardId:event.boardId,until:game.boards[state.you].cooldownUntil};
    const lock=$('.battle-side.local')?.querySelector('.battle-lock');
    if(lock&&!matchMedia('(prefers-reduced-motion: reduce)').matches)trackBattleClass(lock,'lock-pop',520);
  }
}
function trackBattleClass(node,className,duration=900){
  if(!node)return;state.battleClassEffects??=new Set();state.battleFXTimers??=new Set();
  for(const previous of [...state.battleClassEffects])if(previous.node===node&&previous.className===className){clearTimeout(previous.timer);state.battleFXTimers.delete(previous.timer);state.battleClassEffects.delete(previous);}
  node.classList.remove(className);void node.offsetWidth;node.classList.add(className);
  const effect={node,className,timer:null};state.battleClassEffects.add(effect);
  effect.timer=setTimeout(()=>{node.classList.remove(className);state.battleClassEffects.delete(effect);state.battleFXTimers.delete(effect.timer);},duration);state.battleFXTimers.add(effect.timer);
}
function updateBattleUnlockFeedback(){
  const cue=state.pendingUnlockCue,game=state.game;if(!cue||!game||game.status!=='playing'||battleNow()<cue.until)return;
  state.pendingUnlockCue=null;
  if(cue.boardId!==game.boards[state.you].puzzle.id||document.hidden)return;
  soundCue('unlock',{id:cue.id});trackBattleClass($('.battle-side.local .board-card'),'unlock-pulse');
  state.battleUnlockNoticeUntil=battleNow()+1000;
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
  const timer=setTimeout(()=>{removeBatch(batch);state.battleFXBatches=state.battleFXBatches.filter(value=>value!==batch);},1100);
  batch.timers.push(timer);state.battleFXTimers.add(timer);
  const impact=()=>{if(state.game?.id===game.id&&state.game.status==='playing')trackBattleClass(target,'hp-hit',220);};
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)impact();else{const impactTimer=setTimeout(()=>{state.battleFXTimers.delete(impactTimer);impact();},420);batch.timers.push(impactTimer);state.battleFXTimers.add(impactTimer);}
  const sourceSide=$(`.battle-side[data-player="${event.who}"]`),sourceGrid=sourceSide?.querySelector('.battle-board'),comboBadge=sourceSide?.querySelector('.combo-badge');
  const callout=sourceSide?.querySelector('.capture-callout');if(callout){callout.textContent=event.combo<=1?'抓到了！':event.combo<=3?`${event.combo} 連喵！`:`喵喵連擊 ×${event.combo}`;callout.dataset.comboTier=String(Math.min(3,Math.ceil(event.combo/3)));trackBattleClass(callout,'show',750);}
  if(comboBadge){comboBadge.dataset.comboTier=String(Math.min(3,1+Math.floor((event.combo-1)/3)));trackBattleClass(comboBadge,'combo-glow');}
  if(sourceGrid?.dataset.boardId===event.boardId)trackBattleClass(sourceGrid.querySelector(`.cell[data-index="${event.index}"]`),'found-glow');
  if(event.advanced&&sourceGrid){trackBattleClass(sourceGrid,'board-clear-glow');const celebration=document.createElement('div');celebration.className='board-clear-celebration';celebration.innerHTML=[0,1,2].map(i=>battleCat(stableHash(`${event.boardId}:${event.index+i}`))).join('');const card=sourceSide.querySelector('.board-card');if(card)add(celebration,card);}
  const number=document.createElement('span');number.className='battle-damage';number.textContent=`−${event.damage}`;add(number,target);
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const from=sourceRect||battleEventCellRect(event);if(!from)return;
  const to=target.getBoundingClientRect(),x=from.left+from.width/2,y=from.top+from.height/2,tx=to.left+to.width/2,ty=to.top+to.height/2;
  const intensity=Math.min(3,1+Math.floor((Math.max(1,event.combo)-1)/3));
  const position=node=>{node.style.left=`${x}px`;node.style.top=`${y}px`;node.style.setProperty('--dx',`${tx-x}px`);node.style.setProperty('--dy',`${ty-y}px`);node.style.setProperty('--lift',`${Math.min(65,Math.max(28,from.height))}px`);node.style.setProperty('--scale',String(intensity));return node;};
  const cat=document.createElement('div');cat.className='battle-cat-launch';cat.innerHTML=battleCat(stableHash(`${event.boardId}:${event.index}`));add(position(cat));
  const paw=document.createElement('div');paw.className='battle-paw-shot';paw.textContent='🐾';paw.style.setProperty('--trail-angle',`${Math.atan2(ty-y,tx-x)*180/Math.PI}deg`);add(position(paw));
  for(let i=0;i<intensity;i++){
    const spark=document.createElement('div');spark.className='battle-spark';spark.style.left=`${tx}px`;spark.style.top=`${ty}px`;spark.style.setProperty('--scale',String(1+i));spark.style.setProperty('--delay',`${420+i*35}ms`);add(spark);
  }
}
function refreshBattleOverlays({silent=false}={}){
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
  if(beat&&state.battleOpeningBeat!==beat){state.battleOpeningBeat=beat;if(!silent&&!document.hidden)soundCue('countdown',{id:beat,combo:4-seconds});}
  for(const [side,who] of [['local',state.you],['opponent',1-state.you]]){
    const board=game.boards[who],root=$(`.battle-side.${side}`),lock=root?.querySelector('.battle-lock');if(!lock)continue;
    const remaining=battleMissRemaining(game,who);
    const unlocked=side==='local'&&game.status==='playing'&&!document.hidden&&!silent&&remaining<=0&&state.battleUnlockNoticeUntil>now;
    lock.classList.toggle('hidden',remaining<=0&&!unlocked);
    lock.classList.toggle('notes-available',side==='local'&&remaining>0);
    lock.classList.toggle('is-unlocked',unlocked);
    const secondsNode=lock.querySelector('.lock-seconds'),progress=lock.querySelector('.lock-progress > i'),note=lock.querySelector('.lock-note'),label=lock.querySelector('.lock-copy > strong');
    const streak=Math.max(0,Math.trunc(Number(board.missStreak)||0));
    if(label)label.textContent=unlocked?'可以找貓了':game.status==='paused'?(side==='local'?'連線暫停':'暫停'):side==='opponent'?'鎖定中':streak>1?`連錯 ${streak} 次・暫停翻格`:'暫停翻格';
    if(secondsNode)secondsNode.textContent=unlocked?'':`${(Math.ceil(remaining/100)/10).toFixed(1)} 秒`;
    const storedDuration=Number(board.cooldownDuration);
    const duration=Number.isFinite(storedDuration)&&storedDuration>0?storedDuration:Math.max(1,Number.isFinite(board.cooldownStartedAt)?board.cooldownUntil-board.cooldownStartedAt:2000);
    if(progress)progress.style.width=`${Math.max(0,Math.min(100,remaining/duration*100))}%`;
    if(note)note.textContent=side==='local'?(unlocked?(state.mode==='note'?'記號模式仍開啟；關閉後即可找貓':'點格子繼續找貓'):'現在可以做記號'):'對手正在恢復';
  }
}
function updateBattleTimers(){
  if(!isBattle())return;
  const game=state.game;
  if(state.role==='host'&&CatBattle.advance(game,Date.now())){broadcast();return;}
  prepareGameAudio(game.id,game.status);
  if(['finished','aborted','paused'].includes(game.status))clearBattleFX();
  updateBattleUnlockFeedback();
  refreshBattleOverlays({silent:Boolean(state.suppressBattleFX||document.hidden)});$('#battleNotice').textContent=battleMessage();
  if(game.status==='playing'&&state.battleCooldownActive&&game.boards[state.you].cooldownUntil<=battleNow())refreshBattleInputState();
  if(['playing','countdown'].includes(game.status)&&!state.practice&&state.transport?.open()&&Date.now()-(state.lastPong||Date.now())>8000){onClose();state.transport.close();}
  if(game.status==='paused'&&state.disconnectAt&&Date.now()-state.disconnectAt>=60000){CatBattle.abort(game);if(state.role==='host')broadcast();else{saveLocal();render();}}
}

function startPractice(){
  clearBattleFX();stopGameAudio();state.suppressBattleFX=false;state.battleOpeningBeat=null;
  state.transportGeneration=(state.transportGeneration||0)+1;state.transport?.close();state.peer?.destroy();state.peer=null;state.transport=null;state.practice=true;state.role='host';state.you=0;state.room='本機練習';state.clockOffset=0;state.notes.clear();state.pendingAction=null;state.battleBoardId=null;state.battleObservedEvent=null;state.mode='guess';
  state.game=CatBattle.create({mode:'battle',maxHP:150},[{nickname:$('#nick').value||'奶油虎斑',avatar:state.avatar,connected:true},{nickname:'暖暖橘子',avatar:1,connected:true}]);CatBattle.start(state.game);render();
}
$('#previewBattle').onclick=startPractice;
$('#leavePractice').onclick=()=>{clearBattleFX();stopGameAudio();state.transportGeneration=(state.transportGeneration||0)+1;state.transport?.close();state.peer?.destroy();state.transport=null;state.peer=null;state.practice=false;state.game=null;state.notes.clear();state.battleBoardId=null;document.body.classList.remove('is-battle');$('#game').classList.add('hidden');$('#setup').classList.remove('hidden');showEntryChoice();};
$('#battleReturn').onclick=()=>$('#leavePractice').onclick();
$('#battleNote').onclick=()=>setNoteMode(state.mode!=='note');$('#battleHelp').onclick=()=>$('#helpDialog').showModal();$('#battleMute').onclick=()=>{$('#mute').click();render()};$('#battleCopyRoom').onclick=event=>copyRoomCode(event.currentTarget);
$('#battleAbort').onclick=()=>{if(state.role==='host'){CatBattle.abort(state.game);broadcast()}else send({type:'battleAbort'});};
$('#battleReconnect').onclick=()=>{state.peer?.destroy();state.transport=null;$('#roomInput').value=state.room;startPeerGuest();toast('正在重新尋找房主…')};
const priorRematch=$('#rematch').onclick;$('#rematch').onclick=()=>{if(state.practice){$('#result').close();startPractice()}else priorRematch()};
setInterval(updateBattleTimers,100);
setInterval(()=>{if(isBattle()&&!state.practice&&state.transport?.open())send({type:'ping',sentAt:Date.now()});},2000);
document.addEventListener('visibilitychange',()=>{
  if(!isBattle())return;
  if(document.hidden){clearBattleFX();stopGameAudio();state.suppressBattleFX=true;}
  else{state.suppressBattleFX=true;updateBattleTimers();render();}
});
