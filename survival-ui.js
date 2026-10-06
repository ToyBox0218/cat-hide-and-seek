'use strict';

/* Public-snapshot view only. The authority and transport own all match decisions. */
const survivalUI = {
  gameId:null, followIndex:null, seen:new Set(), timers:new Set(), effects:new Set(),
  warned:new Set(), lastLock:false, lastCountdown:null, terminalCue:null
};
const suiNow=()=>Date.now()+(state.clockOffset||0);
const suiText=(selector,value)=>{const node=$(selector);if(node&&node.textContent!==String(value))node.textContent=String(value);};
const suiArray=value=>Array.isArray(value)?value:[];
const suiAlive=player=>player?.status==='active';
const suiOwn=game=>game.players?.[state.you];
const suiEsc=value=>escapeHTML(String(value??''));
const suiTime=ms=>{const seconds=Math.max(0,Math.ceil(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
const suiConnected=()=>!['joining','reconnecting','aborted','closed'].includes(state.survivalLinkStatus);

function suiReason(player){
  const reason=player?.reason;if(!reason)return player?.status==='retired'?'已離開本局':'未能通過這一輪';
  const code=typeof reason==='string'?reason:reason.type||reason.code;
  if(['quota','checkpoint','quota_missed','missed_quota'].includes(code)){
    const event=suiArray(state.game?.events).find(item=>item.type==='checkpoint'&&suiArray(item.eliminatedIds).includes(player.id));
    const minute=reason.minute||reason.checkpoint||event?.checkpoint,required=reason.required??reason.quota??event?.quota;
    return `未達${minute?`第 ${minute} 分鐘`:''}配額${Number.isFinite(required)?`（${player.score}／${required} 隻）`:''}`;
  }
  if(['disconnected','disconnect','disconnect_timeout','reconnect_timeout'].includes(code))return '重新連線逾時';
  if(['left','leave','retired'].includes(code))return '已退出本局';
  if(['host_left','host_disconnected','host_lost'].includes(code))return '房主已離線，本局中止';
  return typeof reason==='object'&&reason.message?String(reason.message):'本輪已結束，繼續替貓友加油';
}

function suiQuota(game,now=suiNow()){
  const elapsed=Number.isFinite(game.startedAt)?Math.max(0,now-game.startedAt):Math.max(0,game.elapsed||0);
  if(elapsed>=240000||game.nextQuota===null)return null;
  const next=game.nextQuota;
  const minute=typeof next==='object'&&next?Number(next.minute||next.checkpoint):Number.isInteger(game.checkpoint)?game.checkpoint+1:Math.floor(elapsed/60000)+1;
  const safeMinute=Math.min(4,Math.max(1,minute||Math.floor(elapsed/60000)+1));
  const target=typeof next==='number'?next:Number(next?.quota??next?.required??next?.target??[6,12,20,30][safeMinute-1]);
  const deadline=Number(game.nextCheckpointAt??next?.deadline??next?.at??(game.startedAt+safeMinute*60000));
  return {minute:safeMinute,target,deadline:Number.isFinite(deadline)?deadline:now+(60000-elapsed%60000)};
}

function suiBuildShell(root,game){
  root.innerHTML=`
    <header class="survival-header">
      <div class="survival-brand"><span class="survival-brand-paw" aria-hidden="true">🐾</span><div><small>CAT HIDE & SEEK · FRIENDS ONLY</small><h1>貓咪大逃殺</h1><p>五分鐘生存賽 · 一起找貓，留到最後</p></div></div>
      <nav class="survival-toolbar" aria-label="房間工具"><button id="survivalCopy" type="button">邀請貓友</button><button id="survivalHelp" type="button">玩法／音效</button><button id="survivalMute" type="button" aria-label="關閉音效">🔊</button><button id="survivalExit" type="button">離開房間</button></nav>
    </header>
    <div class="survival-connection-row"><span id="survivalConnection" role="status"></span><span id="survivalRoom"></span><button id="survivalRetry" type="button" class="hidden">重新連線</button></div>
    <div id="survivalConnectionNotice" class="survival-connection-notice hidden" role="status" aria-live="polite"></div>
    <section id="survivalLobby" class="survival-lobby" aria-label="好友等候室">
      <div class="survival-lobby-main survival-paper"><div class="survival-section-heading"><div><span class="survival-eyebrow">好友等候室</span><h2>一起等貓友入座</h2></div><span id="survivalCapacityBadge" class="survival-pill"></span></div><p class="survival-soft">最多 4 位真人好友，2 人就能出發；各自在自己的 6×6 小屋找貓。</p><div id="survivalSeats" class="survival-seats"></div><div id="survivalLobbyWaiting" class="survival-lobby-waiting"><div><span id="survivalLobbyWaitLabel">等候第二位貓友</span><strong id="survivalLobbyClock" role="timer" aria-live="off">不計時</strong></div><p id="survivalLobbyWaitCopy">房主可以繼續等待。至少 2 位貓友連線完成後，開始 180 秒倒數。</p></div><div class="survival-lobby-actions hidden"><button id="survivalStartButton" type="button" class="survival-primary hidden">立即開始</button></div><p id="survivalLobbyNotice" role="status" aria-live="polite"></p><div id="survivalCountdown" class="survival-countdown hidden" role="status" aria-live="polite"><span>開賽前 3 秒</span><strong>3</strong><span>準備好你的肉球，一起出發！</span></div></div>
      <aside class="survival-rules survival-paper"><span class="survival-eyebrow">一場五分鐘的小冒險</span><h2>每分鐘，留在場上</h2><ol class="survival-checkpoints"><li><span>01 分</span><strong>6 <small>隻</small></strong></li><li><span>02 分</span><strong>12 <small>隻</small></strong></li><li><span>03 分</span><strong>20 <small>隻</small></strong></li><li><span>04 分</span><strong>30 <small>隻</small></strong></li></ol><p>配額是全場累計，換新盤會接著算。每個整分鐘，未達配額的貓友轉為觀戰。</p><div class="survival-final-rule"><b>第五分鐘 · 最後衝刺</b><p>不再淘汰配額。仍在場上的玩家，比全場找到的貓數，再比猜錯較少；完全相同就共享冠軍。</p></div><p class="survival-rule-small">只剩一人時提前獲勝；同時全數淘汰則沒有冠軍。猜錯連續鎖定 2／4／6／8 秒，找到貓後重設。</p><p id="survivalTabbyRule" class="survival-tabby-rule"></p></aside>
    </section>
    <section id="survivalMatch" class="hidden" aria-label="生存賽對局">
      <section id="survivalResult" class="survival-result survival-paper hidden" aria-live="polite"><div class="survival-result-icon" aria-hidden="true">♛</div><div><span class="survival-eyebrow">本局結算</span><h2 id="survivalResultTitle"></h2><p id="survivalResultCopy"></p></div><div id="survivalWinners" class="survival-winners"></div></section>
      <div id="survivalSpectatorNotice" class="survival-spectator-notice hidden" role="status"></div>
      <div class="survival-match-layout">
        <section class="survival-main-board local" aria-label="主要棋盤"><div class="survival-player-heading"><span id="survivalMainAvatar" class="survival-avatar"></span><div class="survival-player-name"><small id="survivalMainLabel">你的小屋</small><h2 id="survivalMainName"></h2></div><div class="survival-total"><strong id="survivalMainScore">0</strong><span>全場找到</span></div><div class="survival-errors"><b id="survivalMainErrors">0</b><span>猜錯</span></div></div><div class="survival-board-card"><div class="survival-board-heading"><b id="survivalBoardTitle">尋貓小屋</b><span id="survivalBoardNumber"></span></div><div class="survival-board-stage"><div id="survivalBoard" class="battle-board survival-board" role="grid" aria-describedby="survivalGestureHint"></div><div id="survivalLock" class="survival-lock hidden" role="status" aria-live="polite"><span aria-hidden="true">🔒</span><strong id="survivalLockTitle">肉球休息一下</strong><b id="survivalLockSeconds"></b><span id="survivalLockCopy">翻格與私人標記都暫停</span><i class="survival-lock-meter" aria-hidden="true"><i></i></i></div><div id="survivalFX" class="survival-fx" aria-hidden="true"></div></div><div class="survival-board-foot"><span id="survivalBoardProgress"></span><span>每行・每列・每區各一隻</span></div></div><p id="survivalBoardNotice" class="survival-board-notice" role="status" aria-live="polite"></p></section>
        <aside class="survival-center-rail" aria-label="時間、配額與操作"><div class="survival-clock-card"><span id="survivalMinuteLabel">生存挑戰</span><strong id="survivalClock">5:00</strong><span id="survivalAlive"></span></div><div id="survivalQuotaCard" class="survival-quota-card"><span id="survivalQuotaLabel">下一次配額</span><strong id="survivalQuotaTarget">6 <small>隻</small></strong><span id="survivalQuotaTime"></span><div id="survivalQuotaMeter" class="survival-quota-meter" role="progressbar" aria-label="你的全場累計配額進度" aria-valuemin="0"><i></i></div><b id="survivalQuotaRemaining"></b></div><p id="survivalQuotaWarning" class="survival-quota-warning hidden" role="status" aria-live="polite"></p><p id="survivalGestureHint" class="gesture-hint" role="note" aria-label="單點私人標記，快速雙點翻格，長按拖曳只加標記，右鍵不操作"><span class="gesture-action">單點 <span class="gesture-mark" aria-hidden="true">×</span> 標記</span><span class="gesture-action">雙點 🐾 翻格</span><small class="gesture-drag">長按拖曳加標記</small><small class="survival-key-hint">右鍵不操作</small></p><p class="survival-legend"><span><i class="survival-note-dot">×</i> 私人筆記</span><span><i>×</i> 已確認空格</span></p></aside>
        <aside class="survival-friends survival-paper" aria-label="貓友動態與觀戰"><div class="survival-section-heading"><h2>貓友動態</h2><span id="survivalPlayerCount" class="survival-pill"></span></div><p class="survival-friends-caption">全場貓數／猜錯 · 點選觀看</p><div id="survivalScoreList" class="survival-score-list"></div><div class="survival-follow-control"><label for="survivalFollow">觀看貓友</label><select id="survivalFollow"></select></div><div id="survivalPreview" class="survival-preview"><div class="survival-preview-heading"><b id="survivalPreviewName"></b><span>唯讀</span></div><div id="survivalMini" class="survival-mini" role="img"></div><p id="survivalPreviewInfo"></p></div></aside>
      </div>
    </section>`;
  $('#survivalCopy').onclick=()=>survivalCopyInvite();
  $('#survivalExit').onclick=()=>survivalLeave();
  $('#survivalRetry').onclick=()=>survivalReconnect();
  $('#survivalHelp').onclick=()=>{if(typeof syncAudioControls==='function')syncAudioControls();$('#helpDialog')?.showModal();};
  $('#survivalMute').onclick=()=>{state.muted=!state.muted;localStorage.p2pMuted=state.muted?'1':'0';getGameAudio().setMuted(state.muted);if(typeof syncAudioControls==='function')syncAudioControls();suiSyncMute();};
  $('#survivalStartButton').onclick=()=>survivalStart();
  $('#survivalFollow').onchange=event=>{survivalUI.followIndex=Number(event.target.value);renderSurvival();};
  root.dataset.gameId=game.id;
}

function suiSyncMute(){const button=$('#survivalMute');if(!button)return;button.textContent=state.muted?'🔇':'🔊';button.setAttribute('aria-pressed',String(Boolean(state.muted)));button.setAttribute('aria-label',state.muted?'開啟音效':'關閉音效');}

function suiRenderLobby(game){
  const players=game.players||[],capacity=4,lobby=game.status==='lobby';
  const seats=$('#survivalSeats'),key=JSON.stringify(players.map(p=>[p.id,p.nickname,p.avatar,p.connected,p.ready,p.status]));
  if(seats.dataset.key!==key||seats.dataset.capacity!==String(capacity)){
    seats.dataset.key=key;seats.dataset.capacity=String(capacity);
    seats.innerHTML=Array.from({length:capacity},(_,index)=>{const player=players[index],eligible=player?.connected&&player.ready&&player.status==='active';return player?`<article class="survival-seat ${eligible?'is-connected':''} ${!player.connected?'is-disconnected':''}"><span class="survival-avatar">${playerAvatar(player.avatar,'avatar-character')}</span><b>${suiEsc(player.nickname)}${index===state.you?' <small>你</small>':''}</b><span class="survival-seat-state">${!player.connected?'暫時離線':eligible?'✓ 已入座':'正在連線'}</span></article>`:`<div class="survival-seat is-empty"><span class="survival-empty-paw" aria-hidden="true">🐾</span><b>等待貓友</b><span>空位 ${index+1}</span></div>`;}).join('');
  }
  suiText('#survivalCapacityBadge',`${players.length}／${capacity} 位`);
  suiUpdateLobbyTimer(game);
  suiText('#survivalTabbyRule',game.settings.tabbyEnabled?'🐈 虎斑驚喜已開啟：手動找到虎斑貓，會在自己的小屋隨機揭開一個 3×3 範圍；貓咪照算分，空格不算猜錯，也不會連鎖引爆。':'虎斑驚喜未開啟，本局靠推理找出每一隻貓。');
  $('#survivalCountdown').classList.toggle('hidden',lobby);
}

function suiUpdateLobbyTimer(game,now=suiNow()){
  const eligible=Number.isInteger(game.eligibleCount)?game.eligibleCount:0,lobby=game.status==='lobby',host=state.role==='host';
  const waiting=lobby&&eligible>=2&&Number.isFinite(game.lobbyDeadline),button=$('#survivalStartButton');
  button.classList.toggle('hidden',!host||!lobby||eligible<2);button.disabled=!host||!lobby||eligible<2||!suiConnected();
  $('.survival-lobby-actions').classList.toggle('hidden',!host||!lobby||eligible<2);
  $('#survivalLobbyWaiting').classList.toggle('is-counting',waiting);
  suiText('#survivalLobbyWaitLabel',waiting?'自動開始倒數':'等候第二位貓友');
  suiText('#survivalLobbyClock',waiting?suiTime(game.lobbyDeadline-now):'不計時');
  suiText('#survivalLobbyWaitCopy',waiting?'倒數結束後自動開始。房主也可以按「立即開始」，直接進入開賽前 3 秒。':'房主可以繼續等待。至少 2 位貓友連線完成後，開始 180 秒倒數。');
  suiText('#survivalLobbyNotice',!lobby?'即將一起出發，進入開賽前 3 秒。':eligible<2?'不足 2 人時不會開賽；湊齊 2 人後會重新開始完整的 180 秒倒數。':`${eligible} 位貓友已入座。新加入的貓友不會重設倒數。`);
}

function suiChooseFollow(game){
  const players=game.players||[],own=suiOwn(game),want=survivalUI.followIndex;
  if(Number.isInteger(want)&&players[want]&&(game.status!=='playing'||!suiAlive(own)||want!==state.you))return want;
  let index=players.findIndex((player,i)=>i!==state.you&&suiAlive(player));
  if(index<0)index=players.findIndex((player,i)=>i!==state.you);
  if(index<0)index=Math.max(0,state.you);
  survivalUI.followIndex=index;return index;
}

function suiSyncBoard(grid,board,game,who,interactive,mini=false){
  if(!grid||!board?.puzzle)return;
  const size=board.puzzle.size||6,puzzle=board.puzzle,found=new Set(suiArray(board.found)),misses=new Set(suiArray(board.misses)),tabbies=new Set(suiArray(board.revealedTabbies)),blast=new Set(suiArray(board.blastRevealed));
  const key=`${puzzle.id}:${interactive?'input':'read'}`;
  if(grid.dataset.viewKey!==key){
    if(!mini)clearSurvivalEffects();
    grid.dataset.viewKey=key;grid.dataset.boardId=puzzle.id;grid.dataset.player=String(who);grid.style.setProperty('--n',size);grid.innerHTML='';
    const palette=regionPalette(puzzle);
    for(let index=0;index<size*size;index++){
      const cell=document.createElement(interactive?'button':'span'),region=puzzle.regions[index],row=Math.floor(index/size),col=index%size;
      cell.className=mini?'survival-mini-cell':'cell';cell.dataset.index=String(index);cell.dataset.region=String(region);cell.dataset.gameId=game.id;cell.dataset.boardId=puzzle.id;cell.style.setProperty('--bg',palette[region]);
      if(col===size-1||puzzle.regions[index+1]!==region)cell.classList.add('er');
      if(row===size-1||puzzle.regions[index+size]!==region)cell.classList.add('eb');
      if(!mini)cell.setAttribute('role','gridcell');
      if(interactive){cell.type='button';wireBoardCell(cell,index);}else{cell.setAttribute('aria-readonly','true');if(!mini)cell.setAttribute('aria-disabled','true');}
      grid.appendChild(cell);
    }
  }
  const lock=board.cooldownKind==='miss'&&board.cooldownUntil>suiNow();
  for(const cell of grid.children){
    const index=Number(cell.dataset.index),hit=found.has(index),miss=misses.has(index),note=interactive&&state.notes.has(index),tabby=hit&&tabbies.has(index);
    const kind=hit?'cat':miss?'opened':note?'note':'hidden',renderKey=`${kind}:${tabby}:${blast.has(index)&&(hit||miss)}`;
    if(cell.dataset.renderState!==renderKey){
      cell.dataset.renderState=renderKey;
      for(const name of ['cat','opened','note'])cell.classList.toggle(name,kind===name);
      cell.classList.toggle('revealed-tabby',tabby);cell.classList.toggle('blast-revealed',blast.has(index)&&(hit||miss));
      if(hit)cell.innerHTML=mini?'<i aria-hidden="true">●</i>':battleCat(tabby?1:stableHash(`${puzzle.id}:${index}`),tabby?'survival-tabby-cat':'');
      else cell.textContent=miss||note?'×':'';
      if(!mini){const label={cat:tabby?'已找到虎斑貓':'已找到貓',opened:'已翻開的空格，確認沒有貓',note:'私人筆記，尚未確認',hidden:'尚未翻開'}[kind];cell.setAttribute('aria-label',`第 ${Math.floor(index/size)+1} 行，第 ${index%size+1} 列，區域 ${puzzle.regions[index]+1}，${label}`);}
    }
    if(interactive){cell.disabled=hit||miss||lock||game.status!=='playing'||!suiConnected();cell.classList.toggle('pending-cell',state.pendingAction?.boardId===puzzle.id&&state.pendingAction?.index===index);}
  }
  if(!mini){grid.setAttribute('aria-label',`${game.players[who]?.nickname||'貓友'}的${interactive?'尋貓':'唯讀'}棋盤`);grid.setAttribute('aria-readonly',String(!interactive));}
  else grid.setAttribute('aria-label',`${game.players[who]?.nickname||'貓友'}的唯讀盤面，第 ${board.number||1} 盤，已找到 ${found.size} 隻貓`);
}

function suiRenderFriends(game,followIndex){
  const list=$('#survivalScoreList'),players=game.players||[],winners=new Set(suiArray(game.winnerIds));
  const sorted=players.map((player,index)=>({player,index})).sort((a,b)=>(Number(suiAlive(b.player))-Number(suiAlive(a.player)))||(b.player.score-a.player.score)||(a.player.errors-b.player.errors)||a.index-b.index);
  const key=JSON.stringify([followIndex,state.you,game.status,sorted.map(({player:p,index})=>[index,p.id,p.nickname,p.avatar,p.score,p.errors,p.status,p.connected,winners.has(p.id)])]);
  if(list.dataset.key!==key){
    list.dataset.key=key;list.innerHTML=sorted.map(({player,index})=>`<button type="button" class="survival-score-row ${index===followIndex?'is-selected':''} ${!suiAlive(player)?'is-out':''}" data-player="${index}" aria-pressed="${index===followIndex}" aria-label="觀看 ${suiEsc(player.nickname)}，全場找到 ${player.score||0} 隻，猜錯 ${player.errors||0} 次"><span class="survival-small-avatar">${playerAvatar(player.avatar)}</span><span class="survival-row-name"><b>${winners.has(player.id)?'<span class="survival-crown" aria-label="冠軍">♛</span> ':''}${suiEsc(player.nickname)}${index===state.you?' <small>你</small>':''}</b><small>${!player.connected?'暫時離線':player.status==='retired'?'已離開':player.status==='eliminated'?'觀戰中':game.status==='finished'?'完成本局':'仍在場上'}</small></span><span class="survival-row-score"><b>${player.score||0}</b><small>／${player.errors||0}</small></span></button>`).join('');
    for(const button of list.querySelectorAll('button'))button.onclick=()=>{const index=Number(button.dataset.player);if(state.game.status==='playing'&&suiAlive(suiOwn(state.game))&&index===state.you)return;survivalUI.followIndex=index;renderSurvival();};
  }
  suiText('#survivalPlayerCount',`${players.length} 位`);
  const choices=players.map((player,index)=>({player,index})).filter(({index})=>game.status!=='playing'||!suiAlive(suiOwn(game))||index!==state.you),select=$('#survivalFollow');
  const selectKey=JSON.stringify(choices.map(({player,index})=>[index,player.nickname,player.status]));
  if(select.dataset.key!==selectKey){select.dataset.key=selectKey;select.innerHTML=choices.map(({player,index})=>`<option value="${index}">${suiEsc(player.nickname)}${player.status==='active'?'':'（觀戰中）'}</option>`).join('');}
  select.value=String(followIndex);
  const player=players[followIndex],board=game.boards?.[followIndex];
  if(player&&board){suiText('#survivalPreviewName',player.nickname);suiText('#survivalPreviewInfo',`第 ${board.number||1} 盤 · 本盤 ${suiArray(board.found).length}／6 隻`);suiSyncBoard($('#survivalMini'),board,game,followIndex,false,true);}
  $('#survivalPreview').classList.toggle('hidden',!player||!board||!suiAlive(suiOwn(game))||game.status!=='playing');
}

function suiRenderResult(game){
  const final=['finished','aborted'].includes(game.status);$('#survivalResult').classList.toggle('hidden',!final);if(!final)return;
  const ids=suiArray(game.winnerIds),winners=(game.players||[]).filter((player,index)=>ids.includes(player.id)||(ids.length===0&&game.winner!=null&&(game.winner===index||game.winner===player.id)));
  const aborted=game.status==='aborted';
  suiText('#survivalResultTitle',aborted?'這場小冒險暫告一段落':winners.length>1?`${winners.length} 位貓友，共享冠軍！`:winners.length===1?`${winners[0].nickname}，留下來的尋貓王！`:'這一局，沒有冠軍');
  suiText('#survivalResultCopy',aborted?'房主連線中斷或本局已中止，不判勝負。':winners.length>1?'全場貓數與猜錯次數完全相同，一起戴上皇冠。':winners.length===1?`全場找到 ${winners[0].score} 隻貓 · 猜錯 ${winners[0].errors} 次${game.endReason==='last-survivor'?' · 最後一位仍在場上的貓友':''}`:'所有玩家都已淘汰，邀請貓友再挑戰一次吧。');
  const winnerRoot=$('#survivalWinners'),key=winners.map(player=>`${player.id}:${player.avatar}`).join(',');
  if(winnerRoot.dataset.key!==key){winnerRoot.dataset.key=key;winnerRoot.innerHTML=winners.map(player=>`<span class="survival-winner-avatar"><span aria-hidden="true">♛</span>${playerAvatar(player.avatar)}</span>`).join('');}
}

function renderSurvival(){
  const game=state.game,root=$('#survivalArena');if(!root||game?.settings?.mode!=='survival')return;
  const fresh=survivalUI.gameId!==game.id;
  if(fresh){clearSurvivalUI();survivalUI.gameId=game.id;}
  document.body.classList.remove('is-battle');document.body.classList.add('is-survival');$('#setup')?.classList.add('hidden');$('#game')?.classList.remove('hidden');$('#battleArena')?.classList.add('hidden');root.classList.remove('hidden');
  if(root.dataset.gameId!==game.id)suiBuildShell(root,game);
  const lobby=['lobby','countdown'].includes(game.status),own=suiOwn(game),players=game.players||[];
  $('#survivalLobby').classList.toggle('hidden',!lobby);$('#survivalMatch').classList.toggle('hidden',lobby);
  suiText('#survivalRoom',state.room?`房號 ${state.room}`:'好友私密房間');suiSyncMute();
  if(document.hidden||!suiConnected()||game.status!=='playing')clearSurvivalEffects();
  if(typeof prepareGameAudio==='function')prepareGameAudio(game.id,game.status);
  if(lobby)suiRenderLobby(game);
  else{
    const followIndex=suiChooseFollow(game),interactive=game.status==='playing'&&suiAlive(own),mainIndex=interactive?state.you:followIndex,player=players[mainIndex],board=game.boards?.[mainIndex];
    $('#survivalGestureHint').classList.toggle('hidden',!interactive);
    const spectator=$('#survivalSpectatorNotice');spectator.classList.toggle('hidden',!own||suiAlive(own)||game.status!=='playing');
    if(own&&!suiAlive(own))spectator.textContent=`你已轉為觀戰：${suiReason(own)}。選一位貓友，繼續替他加油。`;
    if(player&&board){
      const avatar=$('#survivalMainAvatar');if(avatar.dataset.avatar!==String(player.avatar)){avatar.dataset.avatar=String(player.avatar);avatar.innerHTML=playerAvatar(player.avatar,'avatar-character');}
      suiText('#survivalMainLabel',interactive?'你的小屋':'觀戰小屋 · 唯讀');suiText('#survivalMainName',player.nickname);suiText('#survivalMainScore',player.score||0);suiText('#survivalMainErrors',player.errors||0);suiText('#survivalBoardTitle',interactive?'你的尋貓小屋':`${player.nickname}的小屋`);suiText('#survivalBoardNumber',`第 ${board.number||1} 盤 · 6×6`);suiText('#survivalBoardProgress',`本盤找到 ${suiArray(board.found).length}／6 隻`);
      suiSyncBoard($('#survivalBoard'),board,game,mainIndex,interactive);
      $('.survival-main-board').classList.toggle('is-spectating',!interactive);
    }
    suiRenderFriends(game,followIndex);suiRenderResult(game);
  }
  updateSurvivalTimers();suiObserveEvents(game,fresh);
}

function updateSurvivalTimers(){
  const game=state.game,root=$('#survivalArena');if(!root||root.classList.contains('hidden')||game?.settings?.mode!=='survival')return;
  const now=suiNow(),own=suiOwn(game),reconnecting=state.survivalLinkStatus==='reconnecting',closed=['aborted','closed'].includes(state.survivalLinkStatus);
  const linkText=reconnecting?'重新連線中':closed?'連線已結束':state.survivalLinkStatus==='joining'?'正在加入房間':game.status==='lobby'?'好友等候室':game.status==='countdown'?'開賽倒數':game.status==='finished'?'本局已完成':game.status==='aborted'?'本局已中止':'好友同步對局';
  suiText('#survivalConnection',linkText);$('#survivalConnection').classList.toggle('is-offline',reconnecting||closed);
  $('#survivalCopy').disabled=!['hosting','connected'].includes(state.survivalLinkStatus);
  $('#survivalRetry').classList.toggle('hidden',state.role==='host'||(!reconnecting&&!closed));
  const connectionNotice=$('#survivalConnectionNotice');connectionNotice.classList.toggle('hidden',!reconnecting&&!closed);
  if(reconnecting){const left=Number.isFinite(state.survivalReconnectUntil)?Math.max(0,Math.ceil((state.survivalReconnectUntil-now)/1000)):null;connectionNotice.textContent=`與房主重新連線中${left!==null?` · 剩餘 ${left} 秒`:''}。場上時間仍會繼續，連線恢復前無法操作。`;}
  else if(closed)connectionNotice.textContent=state.survivalStatusMessage||'房間連線已結束，可以離開房間重新邀請貓友。';
  if(game.status==='countdown'){
    const count=Math.max(1,Math.ceil((game.startAt-now)/1000));suiText('#survivalCountdown strong',count);return;
  }
  if(game.status==='lobby'){suiUpdateLobbyTimer(game,now);return;}
  const playing=game.status==='playing',remaining=playing&&Number.isFinite(game.endAt)?Math.max(0,game.endAt-now):Math.max(0,game.remaining||0),elapsed=Number.isFinite(game.startedAt)?now-game.startedAt:game.elapsed||0;
  suiText('#survivalClock',suiTime(remaining));suiText('#survivalAlive',`${(game.players||[]).filter(suiAlive).length}／${game.players?.length||0} 位仍在場上`);suiText('#survivalMinuteLabel',!playing?'本局結束':elapsed>=240000?'最後一分鐘':'生存挑戰');
  const quota=suiQuota(game,now),quotaCard=$('#survivalQuotaCard'),warning=$('#survivalQuotaWarning');
  quotaCard.classList.toggle('is-final',!quota);quotaCard.classList.toggle('is-complete',Boolean(quota&&(own?.score||0)>=quota.target));
  if(quota&&playing){
    const left=Math.max(0,quota.deadline-now),needed=Math.max(0,quota.target-(own?.score||0));
    suiText('#survivalQuotaLabel',`第 ${quota.minute} 分鐘配額`);suiText('#survivalQuotaTarget',`${quota.target} 隻`);suiText('#survivalQuotaTime',`${suiTime(left)} 後結算`);suiText('#survivalQuotaRemaining',!suiAlive(own)?'正在觀戰':needed?`你還差 ${needed} 隻`:'你已達標 ✓');
    const meter=$('#survivalQuotaMeter');meter.classList.remove('hidden');meter.setAttribute('aria-valuemax',String(quota.target));meter.setAttribute('aria-valuenow',String(Math.min(own?.score||0,quota.target)));meter.querySelector('i').style.width=`${Math.min(100,(own?.score||0)/quota.target*100)}%`;
    const urgent=left<=15000&&suiAlive(own)&&needed>0;warning.classList.toggle('hidden',!urgent);quotaCard.classList.toggle('is-urgent',urgent);if(urgent)suiText('#survivalQuotaWarning',`最後 ${Math.ceil(left/1000)} 秒，還差 ${needed} 隻！`);
  }else{
    suiText('#survivalQuotaLabel',playing?'配額全部通過':'全場累計成績');suiText('#survivalQuotaTarget',playing?'衝刺！':'已結算');suiText('#survivalQuotaTime',playing?'第五分鐘不再設配額':'貓數優先，猜錯較少優先');suiText('#survivalQuotaRemaining',playing?'比貓數，再比猜錯較少':'同分同錯，共享冠軍');$('#survivalQuotaMeter').classList.add('hidden');warning.classList.add('hidden');quotaCard.classList.remove('is-urgent');
  }
  const grid=$('#survivalBoard'),who=Number(grid?.dataset.player),board=game.boards?.[who],interactive=grid?.dataset.viewKey?.endsWith(':input'),locked=Boolean(interactive&&playing&&board?.cooldownKind==='miss'&&board.cooldownUntil>now),blocked=Boolean(interactive&&!suiConnected());
  $('#survivalLock').classList.toggle('hidden',!locked&&!blocked);
  if(locked||blocked){
    suiText('#survivalLockTitle',blocked?'正在重新連線':'肉球休息一下');suiText('#survivalLockSeconds',blocked?'稍等一下':`${(Math.ceil((board.cooldownUntil-now)/100)/10).toFixed(1)} 秒`);suiText('#survivalLockCopy',blocked?'連線恢復後再繼續找貓':'翻格與私人標記都暫停');
    const duration=board.cooldownDuration||Math.max(1,board.cooldownUntil-(board.cooldownStartedAt||now));$('#survivalLock .survival-lock-meter > i').style.width=blocked?'100%':`${Math.max(0,Math.min(100,(board.cooldownUntil-now)/duration*100))}%`;
  }
  // Only patch disabled state. Cell nodes and active pointer gestures survive timer ticks.
  if(interactive&&board)for(const cell of grid.children){const index=Number(cell.dataset.index);cell.disabled=locked||blocked||!playing||suiArray(board.found).includes(index)||suiArray(board.misses).includes(index);}
  suiText('#survivalBoardNotice',!playing?'本局已結束，可從右側選擇貓友回看最後盤面。':!interactive?'這是貓友的公開盤面，只能觀看。':blocked?'重新連線中，請稍等。':locked?'猜錯會鎖定，找到貓後重設連續猜錯次數。':state.pendingAction?'等待房主確認…':game.settings.tabbyEnabled?'找到六隻就換新盤；虎斑驚喜只在翻開後揭曉。':'找到六隻就換新盤，全場貓數持續累計。');
  survivalUI.lastLock=locked;
}

function suiRemember(set,key,limit=128){set.add(key);while(set.size>limit)set.delete(set.values().next().value);}
function suiEffect(node,className,duration=950){
  if(!node)return;
  for(const old of survivalUI.effects)if(old.node===node&&old.className===className){clearTimeout(old.timer);survivalUI.effects.delete(old);survivalUI.timers.delete(old.timer);}
  const effect={node,className,timer:null};node.classList.add(className);survivalUI.effects.add(effect);
  effect.timer=setTimeout(()=>{node.classList.remove(className);survivalUI.effects.delete(effect);survivalUI.timers.delete(effect.timer);},duration);survivalUI.timers.add(effect.timer);
  while(survivalUI.effects.size>32){const old=survivalUI.effects.values().next().value;clearTimeout(old.timer);old.node.classList.remove(old.className);survivalUI.effects.delete(old);survivalUI.timers.delete(old.timer);}
}
function suiBlastFX(event){
  const grid=$('#survivalBoard'),who=Number(grid?.dataset.player),matching=grid?.dataset.boardId===event.boardId&&who===event.who;
  const row=$(`#survivalScoreList [data-player="${event.who}"]`);suiEffect(row,'survival-cheer');
  if(!matching)return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  for(const index of suiArray(event.blast?.cells))suiEffect(grid.querySelector(`[data-index="${index}"]`),'survival-blast-flash',reduced?1200:900);
  if(reduced){suiEffect(grid,'survival-static-highlight',1200);return;}
  const layer=$('#survivalFX'),landing=event.blast?.landing,center=Number.isInteger(landing)?landing:Number(event.index);
  if(!layer||!Number.isInteger(center)||center<0||center>=36)return;
  while(layer.children.length>=3)layer.firstElementChild.remove();
  const burst=document.createElement('div');burst.className='survival-tabby-burst';burst.style.setProperty('--x',`${((center%6)+.5)/6*100}%`);burst.style.setProperty('--y',`${(Math.floor(center/6)+.5)/6*100}%`);burst.innerHTML='<i class="survival-burst-ring"></i><span>🐾</span><span>🐾</span><span>🐾</span>';layer.appendChild(burst);
  const source=Number(event.index);if(Number.isInteger(source)&&source>=0&&source<36){const cell=grid.children[source];suiEffect(cell,'survival-tabby-found',600);}
  const timer=setTimeout(()=>{burst.remove();survivalUI.timers.delete(timer);},1400);survivalUI.timers.add(timer);
}

function suiObserveEvents(game,fresh){
  const silent=Boolean(fresh||state.suppressSurvivalFX||document.hidden||!suiConnected()),events=Array.isArray(game.events)?game.events:game.lastEvent?[game.lastEvent]:[];
  for(const event of events.slice(-32)){
    const id=event.id||`${game.id}:${event.at}:${event.type}:${event.who}:${event.boardId}`,seen=survivalUI.seen.has(id);suiRemember(survivalUI.seen,id);
    if(seen||silent||game.status!=='playing'||!Number.isFinite(event.at)||suiNow()-event.at>1800)continue;
    if(event.blast){suiBlastFX(event);if(event.who===state.you)playCaptureSound(id,1);}
    else if((event.type==='hit'||event.type==='found')&&event.who===state.you){playCaptureSound(id,1);suiEffect($('#survivalBoard'),'survival-capture-glow',600);}
    else if(event.type==='miss'&&event.who===state.you)soundCue('miss',{id});
    if(event.advanced&&event.who===state.you){soundCue('boardClear',{id,delay:.2});suiEffect($('.survival-board-card'),'survival-board-clear',900);}
  }
  if(['finished','aborted'].includes(game.status)&&survivalUI.terminalCue!==game.id){survivalUI.terminalCue=game.id;if(!silent&&game.status==='finished')soundCue(suiArray(game.winnerIds).includes(suiOwn(game)?.id)?'win':'lose',{id:`${game.id}:survival-finish`});}
  state.suppressSurvivalFX=false;
}

function clearSurvivalEffects(){
  for(const timer of survivalUI.timers)clearTimeout(timer);
  for(const effect of survivalUI.effects)effect.node.classList.remove(effect.className);
  survivalUI.timers.clear();survivalUI.effects.clear();$('#survivalFX')?.replaceChildren();
}
function clearSurvivalUI(){
  clearSurvivalEffects();survivalUI.seen.clear();survivalUI.warned.clear();survivalUI.gameId=null;survivalUI.followIndex=null;survivalUI.terminalCue=null;survivalUI.lastLock=false;survivalUI.lastCountdown=null;
  document.body.classList.remove('is-survival');$('#survivalArena')?.classList.add('hidden');
}
