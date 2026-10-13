(function(){
'use strict';
const $=selector=>document.querySelector(selector),levels=window.CAT_CLASSIC_LEVELS||[],palette=['#f7ddb9','#d9ead8','#f4c9c0','#d5e5f3','#ead8ee','#f5e7ac','#cfe7df','#ead6bf'];
if(!levels.length||!window.CatClassic)return;
const storeKey='catClassicProgressV1',state={level:0,cats:new Set(),crosses:new Set(),click:null};
function saved(){try{return JSON.parse(localStorage.getItem(storeKey)||'{}')}catch{return{}}}
function save(){const progress=saved();progress.current=state.level;progress.completed=progress.completed||[];progress.boards=progress.boards||{};progress.boards[state.level]={cats:[...state.cats],crosses:[...state.crosses]};localStorage.setItem(storeKey,JSON.stringify(progress));}
function tierName(tier){return['','�s��x��','��¦�ư�','��e���z','����D��','�i���V�X'][tier]}
function puzzle(){return levels[state.level]}
function load(index,reset=false){state.level=Math.max(0,Math.min(levels.length-1,index));const progress=saved(),record=!reset&&progress.boards?.[state.level];state.cats=new Set(record?.cats||[]);state.crosses=new Set(record?.crosses||[]);state.click=null;save();render();}
function isComplete(){const value=puzzle();return state.cats.size===value.size&&value.solution.every(index=>state.cats.has(index));}
function mark(index,cat){if(cat){state.crosses.delete(index);if(state.cats.has(index))state.cats.delete(index);else state.cats.add(index);}else{state.cats.delete(index);if(state.crosses.has(index))state.crosses.delete(index);else state.crosses.add(index);}save();render();}
function render(){const value=puzzle(),progress=saved(),completed=new Set(progress.completed||[]),container=$('#classicBoard');container.style.setProperty('--classic-size',value.size);container.replaceChildren();
  value.regions.forEach((region,index)=>{const cell=document.createElement('button');cell.type='button';cell.className='classic-cell';cell.dataset.index=index;cell.style.setProperty('--region-color',palette[region%palette.length]);cell.classList.toggle('is-cat',state.cats.has(index));cell.classList.toggle('is-cross',state.crosses.has(index));cell.setAttribute('aria-label',`�� ${Math.floor(index/value.size)+1} �Ʋ� ${index%value.size+1} ��A��� ${region+1}${state.cats.has(index)?'�A�w���':state.crosses.has(index)?'�A�w�ư�':'�A���аO'}`);cell.onclick=()=>{const now=performance.now();if(state.click?.index===index&&now-state.click.at<380){state.click=null;mark(index,true);}else{state.click={index,at:now};setTimeout(()=>{if(state.click?.index===index&&performance.now()-state.click.at>=300){state.click=null;mark(index,false);}},310);}};container.append(cell);});
  $('#classicProgress').textContent=`${state.level+1} / ${levels.length}`;$('#classicLevel').value=state.level+1;$('#classicTier').textContent=tierName(value.tier);$('#classicSize').textContent=`${value.size}��${value.size}`;$('#classicPrev').disabled=state.level===0;$('#classicNext').disabled=state.level===levels.length-1&&!isComplete();
  const complete=isComplete();$('#classicGame').classList.toggle('is-complete',complete);$('#classicCompletion').textContent=complete?'�����I�w�x�s�i��':completed.has(state.level)?'�w�����A�i����':'�|������';if(complete&&!completed.has(state.level)){completed.add(state.level);progress.completed=[...completed].sort((a,b)=>a-b);progress.current=Math.min(state.level+1,levels.length-1);localStorage.setItem(storeKey,JSON.stringify(progress));$('#classicMessage').textContent=state.level===levels.length-1?'300 �����������I':'���������A�i�H�e���U�@���C';}
}
function show(){const progress=saved();$('#setup').classList.add('hidden');$('#game').classList.add('hidden');$('#classicGame').classList.remove('hidden');$('#helpButton').classList.add('hidden');load(Number.isInteger(progress.current)?progress.current:0);}
function hide(){$('#classicGame').classList.add('hidden');$('#setup').classList.remove('hidden');$('#setup').removeAttribute('data-flow');$('#entryChoice').classList.remove('hidden');$('#entryFlow').classList.add('hidden');$('#helpButton').classList.remove('hidden');}
function cell(index){return $('#classicBoard')?.querySelector(`[data-index="${index}"]`)}
$('#chooseClassic').onclick=show;$('#classicExit').onclick=hide;$('#classicLevel').oninput=event=>load(Number(event.target.value)-1);$('#classicPrev').onclick=()=>load(state.level-1);$('#classicNext').onclick=()=>load(state.level+1);$('#classicReplay').onclick=()=>{if(confirm('�M�������аO�í��s�}�l�H'))load(state.level,true)};
$('#classicHint').onclick=()=>{const hint=CatClassic.nextHint(puzzle(),state);document.querySelectorAll('.classic-cell').forEach(node=>node.classList.remove('is-hint','is-related','is-conflict'));if(!hint){$('#classicHintText').textContent='�ثe�S���i�δ��ܡC';return}$('#classicHintText').textContent=hint.text;for(const index of hint.related||[])cell(index)?.classList.add('is-related');if(Number.isInteger(hint.index))cell(hint.index)?.classList.add(hint.kind==='error'?'is-conflict':'is-hint');if(hint.kind==='error')return;if(hint.kind==='cat')state.cats.add(hint.index);else state.crosses.add(hint.index);save();setTimeout(render,1250);};
// Only the two retained network modes remain selectable.
for(const option of [...document.querySelectorAll('#gameMode option')])if(!['battle','survival'].includes(option.value))option.remove();
const survivalOption=$('#gameMode option[value="survival"]');
if(survivalOption)survivalOption.textContent='?? 4 �H�j�k���U2�V4 �H�n�͡A�̦h�|�H';
const tabbyToggle=$('#survivalTabby');
if(tabbyToggle)tabbyToggle.closest('label')?.remove();
const survivalSettings=$('#survivalSettings');
if(survivalSettings){const note=survivalSettings.querySelector('p:last-child');if(note)note.textContent='2 �� 4 ��u�H�A�̦h�|�H�C���ߥu�p�@���A���|���}�γs�a���S�F��C';}
for(const paragraph of document.querySelectorAll('#helpDialog p'))if(/�괳|�z�}|3��3|�D���|�_�ÿ�|���ߦX�@/.test(paragraph.textContent))paragraph.remove();
})();

