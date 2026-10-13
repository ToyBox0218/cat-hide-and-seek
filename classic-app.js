(function(){
'use strict';
const $=selector=>document.querySelector(selector),levels=window.CAT_CLASSIC_LEVELS||[];
if(!levels.length||!window.CatClassic)return;
const palette=window.CatPalette?.colors||['#f1ce79','#e297f6','#60d8fb','#60ce7e','#fbd8fb','#fb9792'];
const storeKey='catClassicProgressV1';
const state={level:0,cats:new Set(),crosses:new Set(),gestures:null,viewEpoch:0,sessionLabel:'全新關卡',newGameArmed:false};

function saved(){try{const value=JSON.parse(localStorage.getItem(storeKey)||'{}');return value&&typeof value==='object'?value:{}}catch{return{}}}
function cleanIndexes(values,limit){return Array.isArray(values)?[...new Set(values.filter(value=>Number.isInteger(value)&&value>=0&&value<limit))]:[]}
function boardState(record,value){
  const limit=value.size*value.size,cleanCats=cleanIndexes(record?.cats,limit),repaired=cleanCats.length===limit;
  const cats=repaired?[]:cleanCats,occupied=new Set(cats),crosses=cleanIndexes(record?.crosses,limit).filter(index=>!occupied.has(index));
  return{cats,crosses,repaired};
}
function save(){
  const progress=saved();progress.schema=2;progress.current=state.level;progress.completed=cleanIndexes(progress.completed,levels.length);progress.boards=progress.boards&&typeof progress.boards==='object'?progress.boards:{};
  progress.boards[state.level]={cats:[...state.cats],crosses:[...state.crosses]};localStorage.setItem(storeKey,JSON.stringify(progress));
}
function progressFacts(progress=saved()){
  const completed=cleanIndexes(progress.completed,levels.length),boards=progress.boards&&typeof progress.boards==='object'?progress.boards:{};
  let marks=0;for(const [key,record] of Object.entries(boards)){const level=levels[Number(key)];if(!level)continue;marks+=boardState(record,level).cats.length+boardState(record,level).crosses.length}
  return{hasProgress:completed.length>0||marks>0||(Number.isInteger(progress.current)&&progress.current>0),marks,completed,current:Number.isInteger(progress.current)?Math.max(0,Math.min(levels.length-1,progress.current)):0};
}
function updateEntry(){
  const facts=progressFacts(),start=$('#chooseClassic'),button=$('#continueClassic'),summary=$('#classicContinueSummary');if(!start||!button||!summary)return;
  state.newGameArmed=false;start.classList.remove('is-confirming');start.innerHTML='<strong>開始新遊戲</strong><small>從第 1 關空白開始</small>';
  button.disabled=!facts.hasProgress;summary.textContent=facts.hasProgress?`第 ${facts.current+1} 關 · ${facts.marks} 個標記 · ${facts.completed.length} 關完成`:'目前沒有可繼續的進度';
}
function puzzle(){return levels[state.level]}
function tierName(tier){return['','新手暖身','基礎排除','交叉推理','長鏈挑戰','進階混合'][tier]}
function gestureContext(){return`${state.viewEpoch}:${state.level}`}
function canAct(index,context=gestureContext()){return context===gestureContext()&&!$('#classicGame').classList.contains('hidden')&&Number.isInteger(index)&&index>=0&&index<puzzle().size*puzzle().size}
function cancelGestures(){state.gestures?.cancel()}
function setMessage(text){$('#classicMessage').textContent=text}
function classicCat(index){return`<span class="cat-art ${index%2?'orange':'gray'} board-character" aria-hidden="true"></span>`}

function ensureChrome(){
  const game=$('#classicGame'),header=game.querySelector('.classic-header'),panel=game.querySelector('.classic-panel'),card=game.querySelector('.classic-board-card'),board=$('#classicBoard');
  header.classList.add('battle-header');header.querySelector('div')?.classList.add('classic-brand');card.classList.add('board-card');board.classList.add('battle-board');
  const start=$('#chooseClassic');start.innerHTML='<strong>開始新遊戲</strong><small>從第 1 關空白開始</small>';start.parentElement.classList.add('classic-entry');
  if(!$('#continueClassic'))start.insertAdjacentHTML('afterend','<button id="continueClassic" type="button"><strong>繼續進度</strong><small id="classicContinueSummary">目前沒有可繼續的進度</small></button>');
  if(!$('#classicSessionState'))panel.insertAdjacentHTML('afterbegin','<div class="classic-session-row"><span id="classicSessionState" role="status">全新關卡</span><strong id="classicPlacedCount">0 / 4</strong></div>');
  if(!card.querySelector('.classic-board-heading'))card.insertAdjacentHTML('afterbegin','<div class="classic-board-heading board-heading"><b>你的尋貓小屋</b><span id="classicBoardStatus">第 1 關 · 4×4</span></div>');
  if(!$('#classicLegend'))board.insertAdjacentHTML('afterend','<div id="classicLegend" class="classic-legend"><span><i class="classic-swatch note">×</i> 單點標記</span><span><i class="classic-swatch cat"><span class="cat-art orange" aria-hidden="true"></span></i> 雙點放貓</span><span>提示只高亮，不會自動落子</span></div>');
}

function load(index,{reset=false,reason='navigate'}={}){
  cancelGestures();state.viewEpoch++;
  state.level=Math.max(0,Math.min(levels.length-1,Number(index)||0));
  const progress=saved(),record=!reset&&progress.boards?.[state.level],clean=boardState(record,puzzle());
  state.cats=new Set(clean.cats);state.crosses=new Set(clean.crosses);
  if(clean.repaired)state.sessionLabel='已修復異常盤面';
  else if(reset)state.sessionLabel='已重新開始本關';
  else if(clean.cats.length||clean.crosses.length)state.sessionLabel=`已恢復 ${clean.cats.length+clean.crosses.length} 個標記`;
  else state.sessionLabel=reason==='enter'?'全新關卡':'尚無標記';
  save();render();
  setMessage(clean.repaired?'偵測到每格都是貓的異常舊資料，已從空白盤面恢復。':state.sessionLabel==='全新關卡'?'這是空白新局；單點標記 ×，雙點放置貓。':state.sessionLabel);
}
function isComplete(){const value=puzzle();return state.cats.size===value.size&&value.solution.every(index=>state.cats.has(index))}
function mark(index,cat){
  if(cat){state.crosses.delete(index);state.cats.has(index)?state.cats.delete(index):state.cats.add(index)}
  else{state.cats.delete(index);state.crosses.has(index)?state.crosses.delete(index):state.crosses.add(index)}
  state.sessionLabel='進行中';save();render();
}
function getGestures(){
  if(!state.gestures)state.gestures=CatCellGestures.create({cellCount:36,getContext:gestureContext,canAct,canReveal:canAct,
    onMark:(index,context)=>{const beforeCat=state.cats.has(index),beforeCross=state.crosses.has(index);if(!canAct(index,context))return false;mark(index,false);let used=false;return()=>{if(used||!canAct(index,context))return false;used=true;beforeCat?state.cats.add(index):state.cats.delete(index);beforeCross?state.crosses.add(index):state.crosses.delete(index);save();render();return true}},
    onReveal:(index,context)=>{if(!canAct(index,context))return false;mark(index,true);return true}});
  return state.gestures;
}
function wireCell(cell,index){
  const gestures=getGestures();
  cell.onpointerdown=event=>{if(event.button>0)return;cell.classicPress=gestures.press(index,{pointerType:event.pointerType||'mouse',timeStamp:event.timeStamp})};
  cell.onpointercancel=()=>{if(cell.classicPress)gestures.cancelPress(cell.classicPress);cell.classicPress=null};cell.onblur=cell.onpointercancel;
  cell.onkeydown=event=>{if(!['Enter',' ','Spacebar'].includes(event.key)||event.repeat)return;cell.classicPress=gestures.press(index,{pointerType:'keyboard',timeStamp:event.timeStamp})};
  cell.onclick=event=>{if(event.button>0)return;const intent=cell.classicPress;cell.classicPress=null;if(event.detail>0&&!intent)return;gestures.activate(intent||gestures.press(index,{pointerType:'keyboard',timeStamp:event.timeStamp}),{detail:event.detail||0,timeStamp:event.timeStamp})};
}
function render(){
  const value=puzzle(),progress=saved(),completed=new Set(cleanIndexes(progress.completed,levels.length)),container=$('#classicBoard');
  container.style.setProperty('--classic-size',value.size);container.style.setProperty('--n',value.size);container.replaceChildren();
  value.regions.forEach((region,index)=>{const cell=document.createElement('button'),hasCat=state.cats.has(index),hasCross=state.crosses.has(index);cell.type='button';cell.className='cell classic-cell';cell.dataset.index=index;cell.dataset.region=region;cell.dataset.state=hasCat?'cat':hasCross?'cross':'open';cell.style.setProperty('--bg',palette[region%palette.length]);cell.classList.toggle('cat',hasCat);cell.classList.toggle('is-cat',hasCat);cell.classList.toggle('note',hasCross);cell.classList.toggle('is-cross',hasCross);if(hasCat)cell.innerHTML=classicCat(index);else if(hasCross)cell.textContent='✕';cell.setAttribute('role','gridcell');cell.setAttribute('aria-label',`第 ${Math.floor(index/value.size)+1} 排第 ${index%value.size+1} 格，色區 ${region+1}${hasCat?'，已放貓':hasCross?'，已排除':'，未標記'}`);wireCell(cell,index);container.append(cell)});
  $('#classicProgress').textContent=`${state.level+1} / ${levels.length}`;$('#classicLevel').value=state.level+1;$('#classicTier').textContent=tierName(value.tier);$('#classicSize').textContent=`${value.size}×${value.size}`;$('#classicSessionState').textContent=state.sessionLabel;$('#classicPlacedCount').textContent=`${state.cats.size} / ${value.size}`;$('#classicBoardStatus').textContent=`第 ${state.level+1} 關 · ${value.size}×${value.size}`;$('#classicPrev').disabled=state.level===0;$('#classicNext').disabled=state.level===levels.length-1&&!isComplete();
  const complete=isComplete();$('#classicGame').classList.toggle('is-complete',complete);$('#classicCompletion').textContent=complete?'完成！已儲存進度':completed.has(state.level)?'已完成，可重玩':'尚未完成';
  if(complete&&!completed.has(state.level)){completed.add(state.level);progress.completed=[...completed].sort((a,b)=>a-b);progress.current=Math.min(state.level+1,levels.length-1);localStorage.setItem(storeKey,JSON.stringify(progress));setMessage(state.level===levels.length-1?'300 關全部完成！':'完成本關，可以前往下一關。')}
}
function show(index){$('#setup').classList.add('hidden');$('#game').classList.add('hidden');$('#classicGame').classList.remove('hidden');$('#helpButton').classList.add('hidden');document.body.classList.add('is-classic');load(index,{reason:'enter'})}
function startNew(){const facts=progressFacts();if(facts.hasProgress&&!state.newGameArmed){state.newGameArmed=true;const button=$('#chooseClassic');button.classList.add('is-confirming');button.innerHTML='<strong>確認清除並開始</strong><small>再按一次，既有經典進度會清除</small>';return}localStorage.removeItem(storeKey);show(0)}
function resume(){const facts=progressFacts();if(!facts.hasProgress){updateEntry();return}state.newGameArmed=false;show(facts.current)}
function hide(){cancelGestures();state.viewEpoch++;document.body.classList.remove('is-classic');$('#classicGame').classList.add('hidden');$('#setup').classList.remove('hidden');$('#setup').removeAttribute('data-flow');$('#entryChoice').classList.remove('hidden');$('#entryFlow').classList.add('hidden');$('#helpButton').classList.remove('hidden');updateEntry()}
function cell(index){return $('#classicBoard')?.querySelector(`[data-index="${index}"]`)}
function showHint(){
  cancelGestures();const hint=CatClassic.nextHint(puzzle(),state);document.querySelectorAll('.classic-cell').forEach(node=>node.classList.remove('is-hint','is-related','is-conflict'));
  if(!hint){$('#classicHintText').textContent='目前沒有可用提示。';return}
  $('#classicHintText').textContent=hint.text;for(const index of hint.related||[])cell(index)?.classList.add('is-related');if(Number.isInteger(hint.index))cell(hint.index)?.classList.add(hint.kind==='error'?'is-conflict':'is-hint');setMessage('提示只標出可推理的下一步，請由你決定是否落子。');
}

ensureChrome();
updateEntry();$('#chooseClassic').onclick=startNew;$('#continueClassic').onclick=resume;$('#classicExit').onclick=hide;$('#classicLevel').oninput=event=>load(Number(event.target.value)-1);$('#classicPrev').onclick=()=>load(state.level-1);$('#classicNext').onclick=()=>load(state.level+1);$('#classicReplay').onclick=()=>{cancelGestures();if(confirm('清除本關標記並重新開始？'))load(state.level,{reset:true})};$('#classicHint').onclick=showHint;
for(const option of [...document.querySelectorAll('#gameMode option')])if(!['battle','survival'].includes(option.value))option.remove();
const survivalOption=$('#gameMode option[value="survival"]');if(survivalOption)survivalOption.textContent='🏆 4 人大逃殺｜2–4 人好友，最多四人';
const tabbyToggle=$('#survivalTabby');if(tabbyToggle)tabbyToggle.closest('label')?.remove();
const survivalSettings=$('#survivalSettings');if(survivalSettings){const note=survivalSettings.querySelector('p:last-child');if(note)note.textContent='2 至 4 位真人，最多四人。找到貓只計一分，不會炸開或連帶揭露鄰格。'}
for(const paragraph of document.querySelectorAll('#helpDialog p'))if(/虎斑|爆破|3×3|道具戰|寶藏貓|雙貓合作/.test(paragraph.textContent))paragraph.remove();
})();
