(function(){
'use strict';
const $=selector=>document.querySelector(selector),levels=window.CAT_CLASSIC_LEVELS||[];
if(!levels.length||!window.CatClassic||!window.CatClassicProgress)return;
const palette=window.CatPalette?.colors||['#f1ce79','#e297f6','#60d8fb','#60ce7e','#fbd8fb','#fb9792'];
const packId=window.CAT_CLASSIC_PACK?.id||CatClassicProgress.DEFAULT_PACK_ID;
const progressStore=CatClassicProgress.create({storage:localStorage,levels,Classic:CatClassic,packId});
const state={level:0,cats:new Set(),crosses:new Set(),gestures:null,pointerAdapter:null,strokeDirty:false,viewEpoch:0,sessionLabel:'全新關卡',newGameArmed:false,audioSequence:0,combo:0,comboTimer:0};

function saved(){return progressStore.read()}
function save(){
  progressStore.write(progressStore.setBoard(saved(),state.level,state));
}
function progressFacts(progress=saved()){return progressStore.facts(progress)}
function updateEntry(){
  const facts=progressFacts(),start=$('#chooseClassic'),button=$('#continueClassic'),summary=$('#classicContinueSummary');if(!start||!button||!summary)return;
  state.newGameArmed=false;start.classList.remove('is-confirming');start.innerHTML='<strong>開始新遊戲</strong><small>從第 1 關空白開始</small>';
  button.disabled=!facts.hasProgress;summary.textContent=facts.hasProgress?`第 ${facts.current+1} 關 · ${facts.marks} 個標記 · ${facts.completed.length} 關完成`:'目前沒有可繼續的進度';
}
function puzzle(){return levels[state.level]}
function givenCats(){return new Set(CatClassic.givens(puzzle()))}
function allCats(){return new Set([...givenCats(),...state.cats])}
function tierName(tier){return['','新手暖身','基礎排除','交叉推理','長鏈挑戰','進階混合'][tier]}
function gestureContext(){return`${state.viewEpoch}:${state.level}`}
function canAct(index,context=gestureContext()){return context===gestureContext()&&!$('#classicGame').classList.contains('hidden')&&Number.isInteger(index)&&index>=0&&index<puzzle().size*puzzle().size&&!givenCats().has(index)}
function cancelGestures(reason='state-change'){
  state.gestures?.cancel();state.pointerAdapter?.reset(reason);
  if(state.strokeDirty){state.strokeDirty=false;save()}
}
function setMessage(text){CatStatusPresenter.present($('#classicMessage'),text)}
function setHintMessage(text){CatStatusPresenter.present($('#classicHintText'),text)}
function classicCat(index){return`<span class="cat-art ${index%2?'orange':'gray'} board-character" aria-hidden="true"></span>`}

function ensureChrome(){
  const game=$('#classicGame'),header=game.querySelector('.classic-header'),panel=game.querySelector('.classic-panel'),card=game.querySelector('.classic-board-card'),board=$('#classicBoard');
  header.classList.add('battle-header');header.querySelector('div')?.classList.add('classic-brand');card.classList.add('board-card');board.classList.add('battle-board');
  const start=$('#chooseClassic');start.innerHTML='<strong>開始新遊戲</strong><small>從第 1 關空白開始</small>';start.parentElement.classList.add('classic-entry');
  if(!$('#continueClassic'))start.insertAdjacentHTML('afterend','<button id="continueClassic" type="button"><strong>繼續進度</strong><small id="classicContinueSummary">目前沒有可繼續的進度</small></button>');
  if(!$('#classicSessionState'))panel.insertAdjacentHTML('afterbegin','<div class="classic-session-row"><span id="classicSessionState" role="status">全新關卡</span><strong id="classicPlacedCount">0 / 4</strong></div>');
  if(!$('#classicCombo'))panel.querySelector('.classic-session-row')?.insertAdjacentHTML('afterend','<div id="classicCombo" class="classic-combo" role="status" aria-live="polite" aria-atomic="true" hidden></div>');
  if(!card.querySelector('.classic-board-heading'))card.insertAdjacentHTML('afterbegin','<div class="classic-board-heading board-heading"><b>你的尋貓小屋</b><span id="classicBoardStatus">第 1 關 · 4×4</span></div>');
  if(!$('#classicLegend'))board.insertAdjacentHTML('afterend','<div id="classicLegend" class="classic-legend"><span><i class="classic-swatch note">×</i> 單點／長按拖曳標記</span><span><i class="classic-swatch cat"><span class="cat-art orange" aria-hidden="true"></span></i> 雙點放貓</span><span>提示只高亮，不會自動落子</span></div>');
  board.setAttribute('aria-describedby','classicLegend classicHintText classicMessage');
}

function load(index,{reset=false,reason='navigate'}={}){
  closeResult();cancelGestures();state.viewEpoch++;
  resetCombo();
  state.level=Math.max(0,Math.min(levels.length-1,Number(index)||0));
  const progress=saved(),clean=!reset?progressStore.board(progress,state.level):{cats:[],crosses:[],matched:true};
  state.cats=new Set(clean.cats);state.crosses=new Set(clean.crosses);
  if(!clean.matched)state.sessionLabel='題目已更新，舊標記已安全隔離';
  else if(reset)state.sessionLabel='已重新開始本關';
  else if(clean.cats.length||clean.crosses.length)state.sessionLabel=`已恢復 ${clean.cats.length+clean.crosses.length} 個標記`;
  else state.sessionLabel=reason==='enter'?'全新關卡':'尚無標記';
  save();render();
  setMessage(!clean.matched?'這一關的題目版本已更新，因此未套用舊盤面的標記。舊版進度仍保留在瀏覽器中。':state.sessionLabel==='全新關卡'?'這是空白新局；單點標記 ×，雙點放置貓，長按拖曳可連續標記 ×。':state.sessionLabel);
}
function isComplete(){const value=puzzle(),cats=allCats();return cats.size===value.size&&value.solution.every(index=>cats.has(index))}
function classicCue(kind,options={}){return window.CatGameAudioControls?.play?.(kind,{id:`classic:${state.level}:${kind}:${++state.audioSequence}`,...options})}
function resetCombo(){state.combo=0;clearTimeout(state.comboTimer);state.comboTimer=0;const node=$('#classicCombo');if(node){node.hidden=true;node.classList.remove('is-hit');node.textContent=''}}
function rewardCorrectCat(index){
  state.combo=Math.min(state.combo+1,5);classicCue('found',{combo:state.combo});
  const node=$('#classicCombo');if(!node)return;node.hidden=false;node.textContent=state.combo>1?`連續命中 ×${state.combo}`:'找到一隻貓！';node.classList.remove('is-hit');void node.offsetWidth;node.classList.add('is-hit');
  clearTimeout(state.comboTimer);state.comboTimer=setTimeout(()=>{node.hidden=true;node.classList.remove('is-hit')},900);
}
function hasRuleConflict(index){
  const cats=allCats();if(!cats.has(index))return false;const value=puzzle(),row=Math.floor(index/value.size),column=index%value.size,region=value.regions[index];
  return [...cats].some(other=>other!==index&&(Math.floor(other/value.size)===row||other%value.size===column||value.regions[other]===region||(Math.abs(Math.floor(other/value.size)-row)<=1&&Math.abs(other%value.size-column)<=1)));
}
function mark(index,cat){
  if(givenCats().has(index))return;
  const wasComplete=isComplete(),wasCat=state.cats.has(index);
  if(cat){state.crosses.delete(index);state.cats.has(index)?state.cats.delete(index):state.cats.add(index)}
  else{state.cats.delete(index);state.crosses.has(index)?state.crosses.delete(index):state.crosses.add(index)}
  state.sessionLabel='進行中';save();render({announceCompletion:!wasComplete});
  if(cat&&state.cats.has(index)&&hasRuleConflict(index)){resetCombo();setMessage('這隻貓與同排、同欄、同色區或相鄰的貓衝突；可用提示檢查下一步。');classicCue('miss');}
  else if(cat&&state.cats.has(index)&&puzzle().solution.includes(index))rewardCorrectCat(index);
  else if(cat||wasCat){resetCombo();classicCue('ui');}
  else classicCue('ui');
}
function setCross(index,marked,context=gestureContext(),persist=true){
  if(!canAct(index,context)||allCats().has(index)||state.crosses.has(index)===marked)return false;
  marked?state.crosses.add(index):state.crosses.delete(index);state.sessionLabel='進行中';
  const node=cell(index);if(node){node.classList.toggle('note',marked);node.classList.toggle('is-cross',marked);node.dataset.state=marked?'cross':'open';node.textContent=marked?'✕':'';const value=puzzle();node.setAttribute('aria-label',`第 ${Math.floor(index/value.size)+1} 排第 ${index%value.size+1} 格，色區 ${value.regions[index]+1}${marked?'，已排除':'，未標記'}`)}
  $('#classicSessionState').textContent=state.sessionLabel;if(persist)save();else state.strokeDirty=true;return true;
}
function getGestures(){
  if(!state.gestures)state.gestures=CatCellGestures.create({cellCount:36,getContext:gestureContext,canAct,canReveal:canAct,
    onMark:(index,context)=>{const beforeCat=state.cats.has(index),beforeCross=state.crosses.has(index);if(!canAct(index,context))return false;mark(index,false);let used=false;return()=>{if(used||!canAct(index,context))return false;used=true;beforeCat?state.cats.add(index):state.cats.delete(index);beforeCross?state.crosses.add(index):state.crosses.delete(index);save();render();return true}},
    onReveal:(index,context)=>{if(!canAct(index,context))return false;mark(index,true);return true}});
  return state.gestures;
}
const inputNow=()=>typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now();
function cancelCellPress(cell){if(cell?.classicPress)state.gestures?.cancelPress(cell.classicPress);if(cell){cell.classicPress=null;cell.classicCancelled=true}}
function getPointerAdapter(){
  if(!state.pointerAdapter)state.pointerAdapter=CatBoardPointerAdapter.create({cellCount:36,pointerProperty:'classicPointerState',cellSelector:'.classic-cell',getGrid:()=>$('#classicBoard'),getContext:gestureContext,canAct:context=>context===gestureContext()&&!$('#classicGame').classList.contains('hidden'),canMark:(index,context)=>canAct(index,context)&&!allCats().has(index),onAdd:(index,context)=>setCross(index,true,context,false),now:inputNow,onCancelPress:cancelCellPress,onCancelGestures:()=>state.gestures?.cancel(),onStrokeEnd:()=>{if(state.strokeDirty){state.strokeDirty=false;save()}}});
  return state.pointerAdapter;
}
function focusFromArrow(cell,event){
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return false;
  const size=puzzle().size,index=+cell.dataset.index,row=Math.floor(index/size),column=index%size,nextRow=row+(event.key==='ArrowUp'?-1:event.key==='ArrowDown'?1:0),nextColumn=column+(event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0);
  event.preventDefault();if(nextRow>=0&&nextRow<size&&nextColumn>=0&&nextColumn<size)document.querySelector(`#classicBoard [data-index="${nextRow*size+nextColumn}"]`)?.focus({preventScroll:true});return true;
}
function wireCell(cell,index){
  const gestures=getGestures();getPointerAdapter().wireCell(cell,index,{onPointerDown:(node,event)=>{node.classicCancelled=false;if(event.isPrimary!==false)node.classicPress=gestures.press(index,{pointerType:event.pointerType||'mouse',timeStamp:event.timeStamp})},onCancel:cancelCellPress,
    onKeydown:(node,event)=>{if(focusFromArrow(node,event))return;if(!['Enter',' ','Spacebar'].includes(event.key))return;if(event.repeat){event.preventDefault();return}node.classicPress=gestures.press(index,{pointerType:'keyboard',timeStamp:event.timeStamp})},
    onClick:(node,event,stroke)=>{const intent=node.classicPress;node.classicPress=null;if(stroke.consumed||(!intent&&stroke.suppressed)||node.classicCancelled){node.classicCancelled=false;return}if(event.detail>0&&!intent)return;gestures.activate(intent||gestures.press(index,{pointerType:'keyboard',timeStamp:event.timeStamp}),{detail:event.detail||0,timeStamp:event.timeStamp})}});
}
function closeResult(){const dialog=$('#classicResult');if(dialog?.open)dialog.close()}
function showResult(){
  const dialog=$('#classicResult'),last=state.level===levels.length-1;if(!dialog||dialog.open)return;
  $('#classicResultTitle').textContent=last?'300 關全部完成！':`第 ${state.level+1} 關完成！`;
  $('#classicResultText').textContent=last?'恭喜完成整套經典單人關卡。你可以重玩本關或回到模式選單。':'進度已儲存。要直接前往下一關，還是重玩這一關？';
  $('#classicResultNext').hidden=last;dialog.showModal?.();if(!dialog.open)dialog.setAttribute('open','');
  requestAnimationFrame(()=>$(last?'#classicResultReplay':'#classicResultNext')?.focus());classicCue('win',{delay:.12});
}
function render({announceCompletion=false}={}){
  const value=puzzle(),progress=saved(),completed=new Set(progress.completed.map(progressStore.indexOf).filter(index=>index>=0)),fixed=givenCats(),cats=allCats(),container=$('#classicBoard');
  container.style.setProperty('--classic-size',value.size);container.style.setProperty('--n',value.size);container.replaceChildren();
  value.regions.forEach((region,index)=>{const cell=document.createElement('button'),isGiven=fixed.has(index),hasCat=cats.has(index),hasCross=state.crosses.has(index);cell.type='button';cell.className='cell classic-cell';cell.dataset.index=index;cell.dataset.region=region;cell.dataset.state=isGiven?'given':hasCat?'cat':hasCross?'cross':'open';cell.style.setProperty('--bg',palette[region%palette.length]);cell.classList.toggle('cat',hasCat);cell.classList.toggle('is-cat',hasCat);cell.classList.toggle('given',isGiven);cell.classList.toggle('note',hasCross);cell.classList.toggle('is-cross',hasCross);if(hasCat)cell.innerHTML=classicCat(index);else if(hasCross)cell.textContent='✕';cell.setAttribute('role','gridcell');cell.setAttribute('aria-readonly',isGiven?'true':'false');cell.setAttribute('aria-label',`第 ${Math.floor(index/value.size)+1} 排第 ${index%value.size+1} 格，色區 ${region+1}${isGiven?'，題目給定的貓':hasCat?'，已放貓':hasCross?'，已排除':'，未標記'}`);wireCell(cell,index);container.append(cell)});
  $('#classicProgress').textContent=`${state.level+1} / ${levels.length}`;$('#classicLevel').value=state.level+1;$('#classicTier').textContent=tierName(value.tier);$('#classicSize').textContent=`${value.size}×${value.size}`;$('#classicSessionState').textContent=state.sessionLabel;$('#classicPlacedCount').textContent=`${cats.size} / ${value.size}`;$('#classicBoardStatus').textContent=`第 ${state.level+1} 關 · ${value.size}×${value.size}`;$('#classicPrev').disabled=state.level===0;$('#classicNext').disabled=state.level===levels.length-1&&!isComplete();
  const complete=isComplete();$('#classicGame').classList.toggle('is-complete',complete);$('#classicCompletion').textContent=complete?'完成！已儲存進度':completed.has(state.level)?'已完成，可重玩':'尚未完成';
  if(complete&&!completed.has(state.level)){progressStore.write(progressStore.complete(progress,state.level));setMessage(state.level===levels.length-1?'300 關全部完成！':'完成本關，可以前往下一關。')}
  if(complete&&announceCompletion)showResult();
}
function show(index){$('#setup').classList.add('hidden');$('#game').classList.add('hidden');$('#classicGame').classList.remove('hidden');$('#helpButton').classList.add('hidden');document.body.classList.add('is-classic');load(index,{reason:'enter'})}
function startNew(){const facts=progressFacts();if(facts.hasProgress&&!state.newGameArmed){state.newGameArmed=true;const button=$('#chooseClassic');button.classList.add('is-confirming');button.innerHTML='<strong>確認清除並開始</strong><small>再按一次，這一版的經典進度會清除</small>';return}progressStore.clear();show(0)}
function resume(){const facts=progressFacts();if(!facts.hasProgress){updateEntry();return}state.newGameArmed=false;show(facts.current)}
function hide(){closeResult();cancelGestures();state.viewEpoch++;document.body.classList.remove('is-classic');$('#classicGame').classList.add('hidden');$('#setup').classList.remove('hidden');$('#setup').removeAttribute('data-flow');$('#entryChoice').classList.remove('hidden');$('#entryFlow').classList.add('hidden');$('#helpButton').classList.remove('hidden');updateEntry()}
function cell(index){return $('#classicBoard')?.querySelector(`[data-index="${index}"]`)}
function showHint(){
  cancelGestures();const hint=CatClassic.nextHint(puzzle(),state);document.querySelectorAll('.classic-cell').forEach(node=>node.classList.remove('is-hint','is-related','is-conflict'));
  if(!hint){setHintMessage('目前沒有可用提示。');classicCue('miss');return}
  setHintMessage(hint.text);for(const index of hint.related||[])cell(index)?.classList.add('is-related');if(Number.isInteger(hint.index))cell(hint.index)?.classList.add(hint.kind==='error'?'is-conflict':'is-hint');setMessage('提示只標出可推理的下一步，請由你決定是否落子。');classicCue(hint.kind==='error'?'miss':'ui');
}

window.addEventListener('blur',()=>cancelGestures('blur'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelGestures('hidden')});

ensureChrome();
updateEntry();$('#chooseClassic').onclick=startNew;$('#continueClassic').onclick=resume;$('#classicExit').onclick=hide;$('#classicMute').onclick=()=>window.CatGameAudioControls?.toggleMute?.();window.CatGameAudioControls?.sync?.();$('#classicLevel').oninput=event=>load(Number(event.target.value)-1);$('#classicPrev').onclick=()=>load(state.level-1);$('#classicNext').onclick=()=>load(state.level+1);$('#classicReplay').onclick=()=>{cancelGestures();if(confirm('清除本關標記並重新開始？'))load(state.level,{reset:true})};$('#classicHint').onclick=showHint;
$('#classicResultReplay').onclick=()=>load(state.level,{reset:true});$('#classicResultNext').onclick=()=>load(state.level+1);$('#classicResultClose').onclick=closeResult;$('#classicResult')?.addEventListener('close',()=>cell(puzzle().solution.find(index=>allCats().has(index)))?.focus({preventScroll:true}));
for(const option of [...document.querySelectorAll('#gameMode option')])if(!['battle','survival'].includes(option.value))option.remove();
const survivalOption=$('#gameMode option[value="survival"]');if(survivalOption)survivalOption.textContent='🏆 4 人大逃殺｜2–4 人好友，最多四人';
const tabbyToggle=$('#survivalTabby');if(tabbyToggle)tabbyToggle.closest('label')?.remove();
const survivalSettings=$('#survivalSettings');if(survivalSettings){const note=survivalSettings.querySelector('p:last-child');if(note)note.textContent='2 至 4 位真人，最多四人。找到貓只計一分，不會炸開或連帶揭露鄰格。'}
for(const paragraph of document.querySelectorAll('#helpDialog p')){
  if(paragraph.textContent.startsWith('貓咪大逃殺：'))paragraph.innerHTML='<b>貓咪大逃殺：</b>2–4 位真人好友各解獨立 6×6；每隻貓只計 1 分，不會炸開或連帶揭露鄰格。1／2／3／4 分鐘累積門檻為 4／10／16／24 隻，最後一分鐘沒有新門檻；5 分鐘後比全場貓數，再比猜錯較少。';
  else if(/道具戰|寶藏貓|雙貓合作/.test(paragraph.textContent))paragraph.remove();
}
})();
