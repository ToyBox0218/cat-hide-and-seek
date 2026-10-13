'use strict';
const assert=require('node:assert/strict');
const endpoint=process.argv[2]||'http://127.0.0.1:9222';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function connect(){
  let pages;
  for(let attempt=0;attempt<30;attempt++){
    try{pages=await fetch(`${endpoint}/json/list`).then(response=>response.json());if(pages.length)break;}catch{}
    await wait(250);
  }
  if(!pages?.length)throw new Error('No DevTools page target became available.');
  const target=pages.find(page=>page.type==='page'&&page.url.includes('127.0.0.1:3010'))||pages.find(page=>page.type==='page');
  const socket=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let nextId=0;
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result);}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;};
  return{socket,send,evaluate};
}

(async()=>{
  const cdp=await connect(),results={};
  try{
    await cdp.send('Page.enable');await cdp.send('Runtime.enable');await wait(500);
    await cdp.evaluate(`localStorage.clear();location.reload();true`);await wait(700);
    results.entry=await cdp.evaluate(`(()=>({
      title:document.title,
      modes:[...document.querySelectorAll('#gameMode option')].map(option=>option.value),
      hasClassic:!!document.querySelector('#chooseClassic'),
      tabbyVisible:!!document.querySelector('#survivalTabby'),
      misleadingHelp:[...document.querySelectorAll('#helpDialog p')].some(node=>/�괳|�z�}|3��3|�D���|�_�ÿ�|���ߦX�@/.test(node.textContent))
    }))()`);
    assert.deepEqual(results.entry.modes,['battle','survival']);assert.equal(results.entry.hasClassic,true);assert.equal(results.entry.tabbyVisible,false);assert.equal(results.entry.misleadingHelp,false);

    await cdp.evaluate(`document.querySelector('#chooseClassic').click()`);await wait(150);
    results.classicStart=await cdp.evaluate(`(()=>({visible:!document.querySelector('#classicGame').classList.contains('hidden'),progress:document.querySelector('#classicProgress').textContent,cells:document.querySelectorAll('.classic-cell').length}))()`);
    assert.equal(results.classicStart.visible,true);assert.equal(results.classicStart.progress.trim(),'1 / 300');assert.equal(results.classicStart.cells,16);

    await cdp.evaluate(`document.querySelector('#classicHint').click()`);await wait(50);
    results.hint=await cdp.evaluate(`(()=>({text:document.querySelector('#classicHintText').textContent,highlighted:document.querySelectorAll('.is-hint,.is-related,.is-conflict').length}))()`);
    assert.ok(results.hint.text.trim().length>4);assert.ok(results.hint.highlighted>0);await wait(1350);

    await cdp.evaluate(`(()=>{const slider=document.querySelector('#classicLevel');slider.value='31';slider.dispatchEvent(new Event('input',{bubbles:true}));const cell=document.querySelector('.classic-cell');cell.click();return true})()`);await wait(350);
    results.saved=await cdp.evaluate(`JSON.parse(localStorage.getItem('catClassicProgressV1'))`);assert.equal(results.saved.current,30);assert.ok(results.saved.boards['30'].crosses.length===1);
    await cdp.send('Page.reload',{ignoreCache:true});await wait(700);await cdp.evaluate(`document.querySelector('#chooseClassic').click()`);await wait(100);
    results.restored=await cdp.evaluate(`(()=>({progress:document.querySelector('#classicProgress').textContent,crosses:document.querySelectorAll('.classic-cell.is-cross').length}))()`);
    assert.equal(results.restored.progress.trim(),'31 / 300');assert.equal(results.restored.crosses,1);

    await cdp.evaluate(`(()=>{window.confirm=()=>true;document.querySelector('#classicReplay').click();return true})()`);await wait(100);
    results.replay=await cdp.evaluate(`document.querySelectorAll('.classic-cell.is-cat,.classic-cell.is-cross').length`);assert.equal(results.replay,0);
    await cdp.evaluate(`document.querySelector('#classicNext').click()`);await wait(100);
    results.next=await cdp.evaluate(`document.querySelector('#classicProgress').textContent.trim()`);assert.equal(results.next,'32 / 300');

    await cdp.evaluate(`(()=>{const slider=document.querySelector('#classicLevel');slider.value='1';slider.dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>true;document.querySelector('#classicReplay').click();return true})()`);await wait(100);
    for(const index of await cdp.evaluate(`CAT_CLASSIC_LEVELS[0].solution`)){
      await cdp.evaluate(`(()=>{const cell=document.querySelector('.classic-cell[data-index="${index}"]');cell.click();cell.click();return true})()`);await wait(40);
    }
    await wait(150);
    results.completed=await cdp.evaluate(`(()=>{const p=JSON.parse(localStorage.getItem('catClassicProgressV1'));return{message:document.querySelector('#classicCompletion').textContent,completed:p.completed.includes(0)}})()`);
    assert.equal(results.completed.completed,true);

    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await wait(150);
    results.narrow=await cdp.evaluate(`(()=>{const rect=document.querySelector('#classicBoard').getBoundingClientRect();const offenders=[...document.querySelectorAll('body *')].map(node=>{const r=node.getBoundingClientRect();return{tag:node.tagName,id:node.id,className:String(node.className||''),left:r.left,right:r.right,width:r.width,scrollWidth:node.scrollWidth}}).filter(x=>x.right>innerWidth+1||x.left<-1||x.scrollWidth>x.width+1).slice(0,20);return{innerWidth,boardLeft:rect.left,boardRight:rect.right,boardWidth:rect.width,scrollWidth:document.documentElement.scrollWidth,offenders}})()`);
    assert.equal(results.narrow.innerWidth,390,JSON.stringify(results.narrow));assert.ok(results.narrow.boardLeft>=0&&results.narrow.boardRight<=391,JSON.stringify(results.narrow));assert.ok(results.narrow.scrollWidth<=results.narrow.innerWidth,JSON.stringify(results.narrow));
    console.log(JSON.stringify({ok:true,results},null,2));
  }finally{
    try{await cdp.send('Browser.close');}catch{}cdp.socket.close();
  }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

