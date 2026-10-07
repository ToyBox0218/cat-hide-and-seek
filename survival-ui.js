'use strict';

/* Public-snapshot view only. The authority and transport own all match decisions. */
const survivalUI = {
  gameId:null, followIndex:null, seen:new Set(), timers:new Set(), effects:new Set(),
  warned:new Set(), announced:new Set(), quotaObservation:null, quotaCutin:null, quotaDock:null, blastGeometry:new Map(),
  overlays:new Map(), lastLock:false, lastCountdown:null, terminalCue:null
};
const suiNow=()=>Date.now()+(state.clockOffset||0);
const suiText=(selector,value)=>{const node=$(selector);if(node&&node.textContent!==String(value))node.textContent=String(value);};
const suiArray=value=>Array.isArray(value)?value:[];
const suiAlive=player=>player?.status==='active';
const suiOwn=game=>game.players?.[state.you];
const suiEsc=value=>escapeHTML(String(value??''));
const suiTime=ms=>{const seconds=Math.max(0,Math.ceil(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
const suiConnected=()=>!['joining','reconnecting','aborted','closed'].includes(state.survivalLinkStatus);
const suiReducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const suiEventId=(event,game=state.game)=>event.id||`${game.id}:${event.at}:${event.type}:${event.who}:${event.boardId}`;

// This illustration is reserved for a publicly revealed special cat. Ordinary
// orange avatars never acquire these tiger stripes, neckerchief or spark badge.
function suiTabbyArt(){
  return '<svg class="cat-art survival-tabby-cat" viewBox="0 0 120 120" aria-hidden="true"><path d="M89 87c23 1 24-27 9-24" fill="none" stroke="#9b663e" stroke-width="13" stroke-linecap="round"/><path d="M34 70c-8 14-10 28-4 36h58c7-10 3-26-8-37" fill="#e6b976" stroke="#714931" stroke-width="3"/><path d="m30 48-5-32 27 16m16 0 26-16-3 34" fill="#e6b976" stroke="#714931" stroke-width="3" stroke-linejoin="round"/><path d="m32 35-2-13 12 11m35 0 13-11-2 16" fill="#cd8b77"/><ellipse cx="61" cy="56" rx="38" ry="31" fill="#edc68b" stroke="#714931" stroke-width="3"/><path d="m48 29 3 13m10-15v14m13-12-4 13M26 50l15 5m-16 7 15 1m56-13-15 5m16 7-15 1M32 88l14 4m-15 5 14 3m37-12-13 4m15 5-14 3" fill="none" stroke="#795036" stroke-width="5" stroke-linecap="round"/><ellipse cx="49" cy="55" rx="4" ry="6" fill="#44392e"/><ellipse cx="74" cy="55" rx="4" ry="6" fill="#44392e"/><path d="m57 63 5 4 5-4M62 67v5m0 0-7 3m7-3 7 3" fill="none" stroke="#77513e" stroke-width="3" stroke-linecap="round"/><path d="m37 79 23 8 26-8-10 18-15-9-11 13z" fill="#3e806c" stroke="#285f52" stroke-width="2"/><path d="m101 11 3 9 9 3-9 3-3 9-3-9-9-3 9-3z" fill="#f8d865" stroke="#a87930" stroke-width="2"/></svg>';
}

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
  const target=typeof next==='number'?next:Number(next?.quota??next?.required??next?.target??[4,10,16,24][safeMinute-1]);
  const deadline=Number(game.nextCheckpointAt??next?.deadline??next?.at??(game.startedAt+safeMinute*60000));
  return {minute:safeMinute,target,deadline:Number.isFinite(deadline)?deadline:now+(60000-elapsed%60000)};
}

function suiBuildShell(root,game){
  root.innerHTML=`
    <header class="survival-header">
      <div class="survival-brand"><span class="survival-brand-paw" aria-hidden="true">🐾</span><div><small>CAT HIDE & SEEK · FRIENDS ONLY</small><h1>貓咪大逃殺</h1><p>5 分鐘 · 留到最後</p></div></div>
      <nav class="survival-toolbar" aria-label="房間工具"><button id="survivalCopy" type="button">邀請貓友</button><button id="survivalHelp" type="button">玩法</button><button id="survivalMute" type="button" aria-label="關閉音效">🔊</button><button id="survivalExit" type="button">離開房間</button></nav>
    </header>
    <div class="survival-connection-row"><span id="survivalConnection" role="status"></span><span id="survivalRoom"></span><button id="survivalRetry" type="button" class="hidden">重新連線</button></div>
    <div id="survivalConnectionNotice" class="survival-connection-notice hidden" role="status" aria-live="polite"></div>
    <section id="survivalLobby" class="survival-lobby" aria-label="好友等候室">
      <div class="survival-lobby-main survival-paper"><div class="survival-section-heading"><div><span class="survival-eyebrow">好友等候室</span><h2>一起等貓友入座</h2></div><span id="survivalCapacityBadge" class="survival-pill"></span></div><p class="survival-soft">2–4 位好友 · 各自的 6×6 小屋</p><div id="survivalSeats" class="survival-seats"></div><div id="survivalLobbyWaiting" class="survival-lobby-waiting"><div><span id="survivalLobbyWaitLabel">等候第二位貓友</span><strong id="survivalLobbyClock" role="timer" aria-live="off">不計時</strong></div><p id="survivalLobbyWaitCopy">房主可以繼續等待。至少 2 位貓友連線完成後，開始 180 秒倒數。</p></div><div class="survival-lobby-actions hidden"><button id="survivalStartButton" type="button" class="survival-primary hidden">立即開始</button></div><p id="survivalLobbyNotice" role="status" aria-live="polite"></p><div id="survivalCountdown" class="survival-countdown hidden" role="status" aria-live="polite"><span>開賽前 3 秒</span><strong>3</strong><span>準備好你的肉球，一起出發！</span></div></div>
      <aside class="survival-rules survival-paper"><span class="survival-eyebrow">五分鐘生存賽</span><h2>累計找貓，通過配額</h2><ol class="survival-checkpoints"><li><span>01 分</span><strong>4 <small>隻</small></strong></li><li><span>02 分</span><strong>10 <small>隻</small></strong></li><li><span>03 分</span><strong>16 <small>隻</small></strong></li><li><span>04 分</span><strong>24 <small>隻</small></strong></li></ol><p>每分鐘結算 · 未達標轉觀戰</p><div class="survival-final-rule"><b>第五分鐘 · 最後衝刺</b><p>比貓數，再比猜錯較少</p></div><p id="survivalTabbyRule" class="survival-tabby-rule"></p></aside>
    </section>
    <section id="survivalMatch" class="hidden" aria-label="生存賽對局">
      <section id="survivalResult" class="survival-result survival-paper hidden" aria-live="polite"><div class="survival-result-icon" aria-hidden="true">♛</div><div><span class="survival-eyebrow">本局結算</span><h2 id="survivalResultTitle"></h2><p id="survivalResultCopy"></p></div><div id="survivalWinners" class="survival-winners"></div></section>
      <div id="survivalSpectatorNotice" class="survival-spectator-notice hidden" role="status"></div>
      <div class="survival-match-layout">
        <section class="survival-main-board local" aria-label="主要棋盤"><div class="survival-player-heading"><span id="survivalMainAvatar" class="survival-avatar"></span><div class="survival-player-name"><small id="survivalMainLabel">你的小屋</small><h2 id="survivalMainName"></h2></div><div class="survival-total"><strong id="survivalMainScore">0</strong><span>全場找到</span></div><div class="survival-errors"><b id="survivalMainErrors">0</b><span>猜錯</span></div></div><div class="survival-board-card"><div class="survival-board-heading"><b id="survivalBoardTitle">尋貓小屋</b><span id="survivalBoardNumber"></span></div><div class="survival-board-stage"><div id="survivalBoard" class="battle-board survival-board" role="grid" aria-describedby="survivalGestureHint"></div><div id="survivalLock" class="survival-lock hidden" role="status" aria-live="polite"><span aria-hidden="true">🔒</span><strong id="survivalLockTitle">肉球休息一下</strong><b id="survivalLockSeconds"></b><span id="survivalLockCopy">翻格與私人標記都暫停</span><i class="survival-lock-meter" aria-hidden="true"><i></i></i></div><div id="survivalFX" class="survival-fx" aria-hidden="true"></div></div><div class="survival-board-foot"><span id="survivalBoardProgress"></span><span>每行・每列・每區各一隻</span></div></div><p id="survivalBoardNotice" class="survival-board-notice" role="status" aria-live="polite"></p></section>
        <aside class="survival-center-rail" aria-label="時間、配額與操作"><div class="survival-clock-card"><span id="survivalMinuteLabel">生存挑戰</span><strong id="survivalClock">5:00</strong><span id="survivalAlive"></span></div><div id="survivalQuotaCard" class="survival-quota-card"><span id="survivalQuotaLabel">下一次配額</span><strong id="survivalQuotaTarget">0 / 4</strong><span id="survivalQuotaTime"></span><div id="survivalQuotaMeter" class="survival-quota-meter" role="progressbar" aria-label="全場累計配額進度" aria-valuemin="0"><i></i></div><b id="survivalQuotaRemaining"></b></div><p id="survivalQuotaWarning" class="survival-quota-warning hidden" role="timer" aria-live="off"></p><span id="survivalQuotaAnnouncement" class="survival-screen-reader" role="status" aria-live="polite" aria-atomic="true"></span><p id="survivalGestureHint" class="gesture-hint" role="note" aria-label="單點私人標記，快速雙點翻格，長按拖曳只加標記，右鍵不操作"><span class="gesture-action">單點 <span class="gesture-mark" aria-hidden="true">×</span> 標記</span><span class="gesture-action">雙點 🐾 翻格</span><small class="gesture-drag">長按拖曳加標記</small></p></aside>
        <aside class="survival-friends survival-paper" aria-label="貓友動態與觀戰"><div class="survival-section-heading"><h2>貓友動態</h2><span id="survivalPlayerCount" class="survival-pill"></span></div><p class="survival-friends-caption">貓數／猜錯 · 點選觀戰</p><div id="survivalScoreList" class="survival-score-list"></div><div class="survival-follow-control"><label for="survivalFollow">觀看貓友</label><select id="survivalFollow"></select></div><div id="survivalPreview" class="survival-preview"><div class="survival-preview-heading"><b id="survivalPreviewName"></b><span>唯讀</span></div><div id="survivalMini" class="survival-mini" role="img"></div><p id="survivalPreviewInfo"></p></div></aside>
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
  suiText('#survivalTabbyRule',game.settings.tabbyEnabled?'✦ 虎斑驚喜 · 隨機揭開 3×3':'虎斑驚喜 · 關閉');
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
    // Advancing a board is atomic; the old public event overlay finishes above it.
    // A different followed player or input/read-only role cancels all old feedback.
    if(!mini&&grid.dataset.viewKey&&(grid.dataset.player!==String(who)||grid.dataset.viewKey.endsWith(':input')!==interactive)){clearSurvivalEffects();stopGameAudio();}
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
      if(hit)cell.innerHTML=mini?'<i aria-hidden="true">●</i>':tabby?suiTabbyArt():battleCat(stableHash(`${puzzle.id}:${index}`),'');
      else cell.textContent=miss||note?'×':'';
      if(!mini){const label={cat:tabby?'已找到虎斑貓':'已找到貓',opened:'已翻開的空格，確認沒有貓',note:'私人筆記，尚未確認',hidden:'尚未翻開'}[kind];cell.setAttribute('aria-label',`第 ${Math.floor(index/size)+1} 行，第 ${index%size+1} 列，區域 ${puzzle.regions[index]+1}，${label}`);}
    }
    if(interactive){cell.disabled=hit||miss||lock||game.status!=='playing'||!suiConnected();cell.classList.toggle('pending-cell',state.pendingAction?.boardId===puzzle.id&&state.pendingAction?.index===index);}
  }
  if(!mini){grid.setAttribute('aria-label',`${game.players[who]?.nickname||'貓友'}的${interactive?'尋貓':'唯讀'}棋盤`);grid.setAttribute('aria-readonly',String(!interactive));}
  else grid.setAttribute('aria-label',`${game.players[who]?.nickname||'貓友'}的唯讀盤面，第 ${board.number||1} 盤，已找到 ${found.size} 隻貓`);
}

function suiRenderFriends(game,followIndex){
  const list=$('#survivalScoreList'),players=game.players||[],winners=new Set(game.status==='finished'?suiArray(game.winnerIds):[]);
  const sorted=players.map((player,index)=>({player,index})).sort((a,b)=>(Number(suiAlive(b.player))-Number(suiAlive(a.player)))||(b.player.score-a.player.score)||(a.player.errors-b.player.errors)||a.index-b.index);
  const key=JSON.stringify([followIndex,state.you,game.status,sorted.map(({player:p,index})=>[index,p.id,p.nickname,p.avatar,p.score,p.errors,p.status,p.connected,winners.has(p.id)])]);
  if(list.dataset.key!==key){
    list.dataset.key=key;list.innerHTML=sorted.map(({player,index})=>`<button type="button" class="survival-score-row ${index===followIndex?'is-selected':''} ${!suiAlive(player)?'is-out':''}" data-player="${index}" aria-pressed="${index===followIndex}" aria-label="觀看 ${suiEsc(player.nickname)}，全場找到 ${player.score||0} 隻，猜錯 ${player.errors||0} 次"><span class="survival-small-avatar">${playerAvatar(player.avatar)}</span><span class="survival-row-name"><b>${winners.has(player.id)?'<span class="survival-crown" aria-label="冠軍">♛</span> ':''}${suiEsc(player.nickname)}${index===state.you?' <small>你</small>':''}</b><small>${game.status==='aborted'?'本局已中止':!player.connected?'暫時離線':player.status==='retired'?'已離開':player.status==='eliminated'?'觀戰中':game.status==='finished'?'完成本局':'仍在場上'}</small></span><span class="survival-row-score"><b>${player.score||0}</b><small>／${player.errors||0}</small></span></button>`).join('');
    for(const button of list.querySelectorAll('button'))button.onclick=()=>{const index=Number(button.dataset.player);if(state.game.status==='playing'&&suiAlive(suiOwn(state.game))&&index===state.you)return;survivalUI.followIndex=index;renderSurvival();};
  }
  suiText('#survivalPlayerCount',`${players.length} 位`);
  const choices=players.map((player,index)=>({player,index})).filter(({index})=>game.status!=='playing'||!suiAlive(suiOwn(game))||index!==state.you),select=$('#survivalFollow');
  const selectKey=JSON.stringify([game.status,choices.map(({player,index})=>[index,player.nickname,player.status])]);
  if(select.dataset.key!==selectKey){select.dataset.key=selectKey;select.innerHTML=choices.map(({player,index})=>`<option value="${index}">${suiEsc(player.nickname)}${game.status==='aborted'?'（本局已中止）':player.status==='active'?'':'（觀戰中）'}</option>`).join('');}
  select.value=String(followIndex);
  const player=players[followIndex],board=game.boards?.[followIndex];
  if(player&&board){suiText('#survivalPreviewName',player.nickname);suiText('#survivalPreviewInfo',`第 ${board.number||1} 盤 · 本盤 ${suiArray(board.found).length}／6 隻`);suiSyncBoard($('#survivalMini'),board,game,followIndex,false,true);}
  $('#survivalPreview').classList.toggle('hidden',!player||!board||!suiAlive(suiOwn(game))||game.status!=='playing');
}

function suiRenderResult(game){
  const final=['finished','aborted'].includes(game.status);$('#survivalResult').classList.toggle('hidden',!final);if(!final)return;
  const aborted=game.status==='aborted';
  const ids=suiArray(game.winnerIds),winners=aborted?[]:(game.players||[]).filter((player,index)=>ids.includes(player.id)||(ids.length===0&&game.winner!=null&&(game.winner===index||game.winner===player.id)));
  suiText('.survival-result-icon',aborted?'🐾':'♛');suiText('.survival-result .survival-eyebrow',aborted?'本局紀錄':'本局結算');
  suiText('#survivalResultTitle',aborted?'本局已中止':winners.length>1?`${winners.length} 位貓友，共享冠軍！`:winners.length===1?`${winners[0].nickname}，留下來的尋貓王！`:'這一局，沒有冠軍');
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
    if(own&&!suiAlive(own))spectator.textContent=`觀戰中 · ${suiReason(own)}`;
    if(player&&board){
      const avatar=$('#survivalMainAvatar');if(avatar.dataset.avatar!==String(player.avatar)){avatar.dataset.avatar=String(player.avatar);avatar.innerHTML=playerAvatar(player.avatar,'avatar-character');}
      suiText('#survivalMainLabel',interactive?'你的小屋':'觀戰 · 唯讀');suiText('#survivalMainName',player.nickname);suiText('#survivalMainScore',player.score||0);suiText('#survivalMainErrors',player.errors||0);suiText('#survivalBoardTitle',interactive?'你的尋貓小屋':`${player.nickname}的小屋`);suiText('#survivalBoardNumber',`第 ${board.number||1} 盤 · 6×6`);suiText('#survivalBoardProgress',`本盤 ${suiArray(board.found).length}／6`);
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
  const linkText=reconnecting?'重新連線中':game.status==='aborted'?'本局已中止':closed?'連線已結束':state.survivalLinkStatus==='joining'?'正在加入房間':game.status==='lobby'?'好友等候室':game.status==='countdown'?'開賽倒數':game.status==='finished'?'本局已完成':'好友同步對局';
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
  const playing=game.status==='playing',aborted=game.status==='aborted',remaining=playing&&Number.isFinite(game.endAt)?Math.max(0,game.endAt-now):Math.max(0,game.remaining||0),elapsed=Number.isFinite(game.startedAt)?now-game.startedAt:game.elapsed||0;
  suiText('#survivalClock',suiTime(remaining));suiText('#survivalAlive',aborted?'不判勝負':playing?`${(game.players||[]).filter(suiAlive).length}／${game.players?.length||0} 位仍在場上`:`${game.players?.length||0} 位參與本局`);suiText('#survivalMinuteLabel',aborted?'本局已中止':!playing?'本局結束':elapsed>=240000?'最後一分鐘':'生存挑戰');
  const quota=suiQuota(game,now),quotaCard=$('#survivalQuotaCard'),warning=$('#survivalQuotaWarning');
  const localActive=suiAlive(own),focus=localActive?own:game.players?.[suiChooseFollow(game)],score=focus?.score||0;
  quotaCard.classList.toggle('is-final',playing&&!quota);quotaCard.classList.toggle('is-complete',Boolean(playing&&quota&&suiAlive(focus)&&score>=quota.target));
  if(quota&&playing){
    const left=Math.max(0,quota.deadline-now),needed=Math.max(0,quota.target-score);
    suiText('#survivalQuotaLabel',localActive?`${quota.minute} 分鐘配額`:`觀戰 · ${focus?.nickname||'貓友'}`);
    suiText('#survivalQuotaTarget',`${score} / ${quota.target}`);suiText('#survivalQuotaTime',`${suiTime(left)} 結算`);
    suiText('#survivalQuotaRemaining',!suiAlive(focus)?'已離場':needed?`還差 ${needed} 隻`:'已達標 ✓');
    const meter=$('#survivalQuotaMeter');meter.classList.remove('hidden');meter.setAttribute('aria-label',`${localActive?'你':focus?.nickname||'貓友'}的累計配額進度`);meter.setAttribute('aria-valuemax',String(quota.target));meter.setAttribute('aria-valuenow',String(Math.min(score,quota.target)));meter.querySelector('i').style.width=`${Math.min(100,score/quota.target*100)}%`;
    const urgent=left>0&&left<=20000&&suiAlive(focus)&&needed>0;
    warning.classList.toggle('hidden',!urgent);quotaCard.classList.toggle('is-urgent',urgent);
    if(urgent){
      suiText('#survivalQuotaWarning',`${localActive?'⚠':focus.nickname+' ·'} ${Math.ceil(left/1000)} 秒 · 差 ${needed} 隻`);
      const announcement=`${game.id}:${quota.minute}:${focus.id}`;
      if(!document.hidden&&!survivalUI.announced.has(announcement)){suiRemember(survivalUI.announced,announcement,16);suiText('#survivalQuotaAnnouncement',`${localActive?'你':focus.nickname}距離配額結算剩 ${Math.ceil(left/1000)} 秒，還差 ${needed} 隻`);}
    }else suiText('#survivalQuotaAnnouncement','');
    suiSyncQuotaDock(quota,score,left,urgent&&localActive&&suiConnected()&&!document.hidden);
    suiQuotaAttention(game,quota,now);
  }else{
    suiText('#survivalQuotaLabel',aborted?'全場紀錄':playing?'最後衝刺':'全場成績');suiText('#survivalQuotaTarget',aborted?'已中止':playing?'衝刺！':'已結算');suiText('#survivalQuotaTime',aborted?'成績保留':playing?'不再設配額':'貓數／猜錯');suiText('#survivalQuotaRemaining',aborted?'不判勝負':playing?'比貓數，再比猜錯較少':'同分同錯，共享冠軍');$('#survivalQuotaMeter').classList.add('hidden');warning.classList.add('hidden');quotaCard.classList.remove('is-urgent');
    suiStopQuotaCutin();suiRemoveQuotaDock();survivalUI.quotaObservation=null;suiText('#survivalQuotaAnnouncement','');
  }
  const grid=$('#survivalBoard'),who=Number(grid?.dataset.player),board=game.boards?.[who],interactive=grid?.dataset.viewKey?.endsWith(':input'),locked=Boolean(interactive&&playing&&board?.cooldownKind==='miss'&&board.cooldownUntil>now),blocked=Boolean(interactive&&!suiConnected());
  $('#survivalLock').classList.toggle('hidden',!locked&&!blocked);
  if(locked||blocked){
    suiText('#survivalLockTitle',blocked?'正在重新連線':'肉球休息一下');suiText('#survivalLockSeconds',blocked?'稍等一下':`${(Math.ceil((board.cooldownUntil-now)/100)/10).toFixed(1)} 秒`);suiText('#survivalLockCopy',blocked?'連線恢復後再繼續找貓':'翻格與私人標記都暫停');
    const duration=board.cooldownDuration||Math.max(1,board.cooldownUntil-(board.cooldownStartedAt||now));$('#survivalLock .survival-lock-meter > i').style.width=blocked?'100%':`${Math.max(0,Math.min(100,(board.cooldownUntil-now)/duration*100))}%`;
  }
  // Only patch disabled state. Cell nodes and active pointer gestures survive timer ticks.
  if(interactive&&board)for(const cell of grid.children){const index=Number(cell.dataset.index);cell.disabled=locked||blocked||!playing||suiArray(board.found).includes(index)||suiArray(board.misses).includes(index);}
  suiText('#survivalBoardNotice',aborted?'本局已中止，不判勝負；盤面僅供回看。':!playing?'選擇貓友回看盤面':!interactive?'':blocked?'重新連線中…':locked?'':state.pendingAction?'等待確認…':'');
  survivalUI.lastLock=locked;
}

function suiStopQuotaCutin(){
  const cutin=survivalUI.quotaCutin;if(!cutin)return;
  clearTimeout(cutin.timer);survivalUI.timers.delete(cutin.timer);cutin.node.remove();survivalUI.quotaCutin=null;
}

function suiRemoveQuotaDock(){survivalUI.quotaDock?.remove();survivalUI.quotaDock=null;}
function suiSyncQuotaDock(quota,score,left,urgent){
  if(!urgent){suiRemoveQuotaDock();return;}
  const card=$('#survivalQuotaCard')?.getBoundingClientRect(),height=window.innerHeight,width=window.innerWidth;
  const visible=card&&card.top+card.height/2>=0&&card.top+card.height/2<=height&&card.left+card.width/2>=0&&card.left+card.width/2<=width;
  if(visible){suiRemoveQuotaDock();return;}
  if(!survivalUI.quotaDock){
    const node=document.createElement('div');node.className='survival-quota-dock';node.setAttribute('aria-hidden','true');$('#survivalArena').appendChild(node);survivalUI.quotaDock=node;
  }
  survivalUI.quotaDock.textContent=`🐾 ${score} / ${quota.target} · ${Math.ceil(left/1000)} 秒`;
}

function suiQuotaAttention(game,quota,now){
  const own=suiOwn(game),left=quota.deadline-now,key=`${game.id}:${quota.minute}`;
  const eligible=game.status==='playing'&&suiAlive(own)&&(own.score||0)<quota.target&&suiConnected()&&!document.hidden;
  const previous=survivalUI.quotaObservation;
  if(!eligible||state.suppressSurvivalFX||left<=0||left>20000)suiStopQuotaCutin();
  if(left>0&&left<=20000&&!survivalUI.warned.has(key)){
    // Joining, returning from a hidden tab or reconnecting inside the window
    // acknowledges this checkpoint without replaying its entrance animation.
    suiRemember(survivalUI.warned,key,4);
    if(eligible&&!state.suppressSurvivalFX&&previous?.key===key&&previous.eligible&&previous.left>20000&&!suiReducedMotion())suiQuotaCutin(quota,own,left);
  }
  if(survivalUI.quotaCutin){
    const {node}=survivalUI.quotaCutin;node.querySelector('strong').textContent=`${own.score||0} / ${quota.target}`;node.querySelector('b').textContent=`${Math.ceil(left/1000)} 秒`;
    const target=(survivalUI.quotaDock||$('#survivalQuotaCard'))?.getBoundingClientRect();
    if(target?.width){node.style.setProperty('--to-x',`${target.left+target.width/2}px`);node.style.setProperty('--to-y',`${target.top+target.height/2}px`);}
  }
  survivalUI.quotaObservation={key,left,eligible};
}

function suiQuotaCutin(quota,player,left){
  suiStopQuotaCutin();
  const arena=$('#survivalArena'),board=$('#survivalBoard')?.getBoundingClientRect(),target=(survivalUI.quotaDock||$('#survivalQuotaCard'))?.getBoundingClientRect();
  if(!arena||!board?.width||!target?.width)return;
  const node=document.createElement('div');node.className='survival-quota-cutin';node.dataset.checkpoint=String(quota.minute);node.setAttribute('aria-hidden','true');
  node.style.setProperty('--from-x',`${Math.max(140,Math.min(window.innerWidth-140,board.left+board.width/2))}px`);node.style.setProperty('--from-y',`${Math.max(65,Math.min(window.innerHeight-65,board.top+board.height*.35))}px`);
  node.style.setProperty('--to-x',`${target.left+target.width/2}px`);node.style.setProperty('--to-y',`${target.top+target.height/2}px`);
  node.innerHTML=`<span aria-hidden="true">🐾</span><div><small>配額倒數</small><strong>${player.score||0} / ${quota.target}</strong></div><b>${Math.ceil(left/1000)} 秒</b>`;arena.appendChild(node);
  const cutin={node,timer:null};survivalUI.quotaCutin=cutin;
  cutin.timer=setTimeout(()=>{survivalUI.timers.delete(cutin.timer);node.remove();if(survivalUI.quotaCutin===cutin)survivalUI.quotaCutin=null;},1450);survivalUI.timers.add(cutin.timer);
}

function suiRemember(set,key,limit=128){set.add(key);while(set.size>limit)set.delete(set.values().next().value);}
function suiEffect(node,className,duration=950){
  if(!node)return;
  for(const old of survivalUI.effects)if(old.node===node&&old.className===className){clearTimeout(old.timer);survivalUI.effects.delete(old);survivalUI.timers.delete(old.timer);}
  const effect={node,className,timer:null};node.classList.add(className);survivalUI.effects.add(effect);
  effect.timer=setTimeout(()=>{node.classList.remove(className);survivalUI.effects.delete(effect);survivalUI.timers.delete(effect.timer);},duration);survivalUI.timers.add(effect.timer);
  while(survivalUI.effects.size>32){const old=survivalUI.effects.values().next().value;clearTimeout(old.timer);old.node.classList.remove(old.className);survivalUI.effects.delete(old);survivalUI.timers.delete(old.timer);}
}
function suiCaptureBlastGeometry(event,grid){
  if(grid?.dataset.boardId!==event.boardId||Number(grid.dataset.player)!==event.who)return null;
  const layer=$('#survivalFX'),frame=layer?.getBoundingClientRect();
  if(!frame?.width||!frame.height)return null;
  const point=index=>{
    if(!Number.isInteger(index)||index<0||index>=36)return null;
    const cell=grid.children[index],rect=cell?.getBoundingClientRect();if(!rect?.width||!rect.height)return null;
    return {index,x:(rect.left-frame.left+rect.width/2)/frame.width*100,y:(rect.top-frame.top+rect.height/2)/frame.height*100,w:rect.width/frame.width*100,h:rect.height/frame.height*100};
  };
  const source=point(event.index),landing=point(event.blast?.landing);if(!source||!landing)return null;
  return {source,landing,cells:suiArray(event.blast.cells).slice(0,9).map(point).filter(Boolean),who:event.who,boardId:event.boardId};
}

// Called by the app bridge before it replaces state.game or touches the DOM.
// Retain geometry only; never clone a board, its private notes or hidden facts.
function suiPrepareSnapshot(previous,snapshot,{historical=false}={}){
  if(historical||!previous||previous.id!==snapshot.id||previous.status!=='playing'||snapshot.status!=='playing'||state.suppressSurvivalFX||document.hidden||!suiConnected())return;
  const grid=$('#survivalBoard');
  for(const event of suiArray(snapshot.events).slice(-32)){
    const id=suiEventId(event,snapshot);
    if(!event.blast||survivalUI.seen.has(id)||survivalUI.blastGeometry.has(id)||!Number.isFinite(event.at))continue;
    const geometry=suiCaptureBlastGeometry(event,grid);if(geometry)survivalUI.blastGeometry.set(id,geometry);
  }
  while(survivalUI.blastGeometry.size>8)survivalUI.blastGeometry.delete(survivalUI.blastGeometry.keys().next().value);
}

function suiRemoveOverlay(node){
  const timer=survivalUI.overlays.get(node);clearTimeout(timer);survivalUI.timers.delete(timer);survivalUI.overlays.delete(node);node.remove();
}

function suiBlastFX(event){
  const id=suiEventId(event),grid=$('#survivalBoard'),who=Number(grid?.dataset.player),matching=grid?.dataset.boardId===event.boardId&&who===event.who;
  const geometry=survivalUI.blastGeometry.get(id)||(matching?suiCaptureBlastGeometry(event,grid):null);survivalUI.blastGeometry.delete(id);
  suiEffect($(`#survivalScoreList [data-player="${event.who}"]`),'survival-cheer');
  if(!geometry||who!==event.who)return;
  const reduced=suiReducedMotion(),layer=$('#survivalFX');if(!layer)return;
  if(matching){
    for(const index of suiArray(event.blast.cells))suiEffect(grid.children[index],'survival-blast-flash',reduced?1400:1300);
    suiEffect(grid.children[event.index],'survival-tabby-found',reduced?1400:650);
    if(reduced)suiEffect(grid,'survival-static-highlight',1400);
  }
  while(survivalUI.overlays.size>=3)suiRemoveOverlay(survivalUI.overlays.keys().next().value);
  const {source,landing,cells}=geometry,burst=document.createElement('div');
  burst.className=`survival-tabby-sequence${reduced?' is-static':''}${matching?'':' is-previous-board'}`;
  burst.dataset.eventId=String(id);burst.dataset.boardId=event.boardId;burst.dataset.source=String(event.index);burst.dataset.landing=String(event.blast.landing);burst.setAttribute('aria-hidden','true');
  for(const [key,value] of Object.entries({'--source-x':source.x,'--source-y':source.y,'--landing-x':landing.x,'--landing-y':landing.y,'--mid-x':(source.x+landing.x)/2,'--mid-y':Math.max(8,Math.min(source.y,landing.y)-17),'--cat-size':Math.min(27,source.w*1.6)}))burst.style.setProperty(key,`${value}%`);
  const tiles=cells.map(cell=>`<i class="survival-blast-tile" style="left:${cell.x-cell.w/2}%;top:${cell.y-cell.h/2}%;width:${cell.w}%;height:${cell.h}%"></i>`).join('');
  burst.innerHTML=`${tiles}<div class="survival-tabby-flight">${suiTabbyArt()}</div><i class="survival-burst-ring"></i><div class="survival-tabby-score"><small>虎斑${matching?'':' · 上盤'}</small><strong>+${Math.max(1,suiArray(event.found).length)}</strong><span>🐾</span></div>`;
  layer.appendChild(burst);suiEffect($('#survivalMainScore'),'survival-score-pop',1400);
  // Use the shared, muted/voice-limited controller; these scheduled voices are
  // canceled with the room, hidden tab, disconnect or a changed watched board.
  soundCue('launch',{id:`${id}:tabby-launch`,delay:reduced?0:.35});
  soundCue('impact',{id:`${id}:tabby-impact`,delay:reduced?.08:.9});
  const timer=setTimeout(()=>suiRemoveOverlay(burst),1450);survivalUI.overlays.set(burst,timer);survivalUI.timers.add(timer);
}

function suiObserveEvents(game,fresh){
  const silent=Boolean(fresh||state.suppressSurvivalFX||document.hidden||!suiConnected()),events=Array.isArray(game.events)?game.events:game.lastEvent?[game.lastEvent]:[];
  for(const event of events.slice(-32)){
    const id=suiEventId(event,game),seen=survivalUI.seen.has(id);suiRemember(survivalUI.seen,id);
    if(seen||silent||game.status!=='playing'||!Number.isFinite(event.at)){survivalUI.blastGeometry.delete(id);continue;}
    if(event.blast){suiBlastFX(event);if(event.who===state.you)playCaptureSound(id,1);}
    else if((event.type==='hit'||event.type==='found')&&event.who===state.you){playCaptureSound(id,1);suiEffect($('#survivalBoard'),'survival-capture-glow',600);}
    else if(event.type==='miss'&&event.who===state.you)soundCue('miss',{id});
    if(event.advanced&&event.who===state.you){soundCue('boardClear',{id,delay:event.blast&&!suiReducedMotion()?1.05:.2});suiEffect($('.survival-board-card'),'survival-board-clear',900);}
  }
  if(['finished','aborted'].includes(game.status)&&survivalUI.terminalCue!==game.id){survivalUI.terminalCue=game.id;if(!silent&&game.status==='finished')soundCue(suiArray(game.winnerIds).includes(suiOwn(game)?.id)?'win':'lose',{id:`${game.id}:survival-finish`});}
  state.suppressSurvivalFX=false;
}

function clearSurvivalEffects(){
  suiStopQuotaCutin();suiRemoveQuotaDock();survivalUI.quotaObservation=null;survivalUI.blastGeometry.clear();
  for(const timer of survivalUI.timers)clearTimeout(timer);
  for(const effect of survivalUI.effects)effect.node.classList.remove(effect.className);
  survivalUI.timers.clear();survivalUI.effects.clear();survivalUI.overlays.clear();$('#survivalFX')?.replaceChildren();
}
function clearSurvivalUI(){
  clearSurvivalEffects();survivalUI.seen.clear();survivalUI.warned.clear();survivalUI.announced.clear();survivalUI.gameId=null;survivalUI.followIndex=null;survivalUI.terminalCue=null;survivalUI.lastLock=false;survivalUI.lastCountdown=null;
  document.body.classList.remove('is-survival');$('#survivalArena')?.classList.add('hidden');
}
