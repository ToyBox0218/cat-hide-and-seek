'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const endpoint=process.argv[2]||'http://127.0.0.1:9257',pageUrl=process.argv[3]||'http://127.0.0.1:3010/?classic-audio-test=1',reportPath=path.resolve(process.argv[4]||'artifacts/classic-audio-browser.json');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function connect(){
  let pages;for(let i=0;i<40;i++){try{pages=await fetch(endpoint+'/json/list').then(response=>response.json());if(pages.length)break}catch{}await wait(250)}
  const page=pages?.find(item=>item.type==='page');if(!page)throw Error('No browser page');
  const socket=new WebSocket(page.webSocketDebuggerUrl),pending=new Map();let id=0;
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  socket.onmessage=event=>{const message=JSON.parse(event.data);if(!message.id||!pending.has(message.id))return;const job=pending.get(message.id);pending.delete(message.id);message.error?job.reject(Error(JSON.stringify(message.error))):job.resolve(message.result)};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}))});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
  return{socket,send,evaluate};
}

(async()=>{
  const c=await connect(),checks=[];fs.mkdirSync(path.dirname(reportPath),{recursive:true});
  async function ready(){for(let i=0;i<40;i++){if(await c.evaluate(`document.readyState==='complete'&&window.CAT_CLASSIC_LEVELS?.length===300&&!!window.CatGameAudioControls&&typeof document.querySelector('#chooseClassic')?.onclick==='function'`).catch(()=>false))return;await wait(100)}throw Error('Classic app did not load')}
  async function point(index){return c.evaluate(`(()=>{const r=document.querySelector('#classicBoard [data-index="${index}"]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)}
  async function clickCell(index,count=1){const p=await point(index);for(let n=1;n<=count;n++){await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:n});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:n});if(n<count)await wait(40)}await wait(count===1?360:100)}
  async function instrument(){await c.evaluate(`(()=>{window.__classicAudioCalls=[];const original=CatGameAudioControls.play.bind(CatGameAudioControls);CatGameAudioControls.play=async(kind,options)=>{const result=await original(kind,options);window.__classicAudioCalls.push({kind,result});return result};return true})()`)}

  await c.send('Emulation.setDeviceMetricsOverride',{width:1366,height:768,deviceScaleFactor:1,mobile:false});await c.send('Page.navigate',{url:pageUrl});await ready();await c.evaluate(`localStorage.clear();location.reload();true`);await wait(300);await ready();
  await c.evaluate(`localStorage.removeItem('catClassicProgressV1');location.reload();true`);await wait(300);await ready();await c.evaluate(`document.querySelector('#chooseClassic').click()`);await instrument();
  await clickCell(0);await clickCell(1,2);await clickCell(0,2);await wait(80);
  const interactionCalls=await c.evaluate(`window.__classicAudioCalls.slice()`);
  assert.ok(interactionCalls.some(call=>call.kind==='ui'),'single mark must request UI cue');
  assert.ok(interactionCalls.some(call=>call.kind==='found'),'valid cat placement must request found cue');
  assert.ok(interactionCalls.some(call=>call.kind==='miss'),'conflicting cat placement must request miss cue');
  checks.push('single mark, valid cat and conflicting cat call ui, found and miss respectively');

  await c.evaluate(`document.querySelector('#classicMute').click()`);await wait(60);
  const muted=await c.evaluate(`(async()=>({stored:localStorage.p2pMuted,pressed:document.querySelector('#classicMute').getAttribute('aria-pressed'),results:await Promise.all(['ui','found','miss','win'].map((kind,index)=>CatGameAudioControls.play(kind,{id:'muted:'+kind+':'+index})))}))()`);
  assert.equal(muted.stored,'1');assert.equal(muted.pressed,'true');assert.deepEqual(muted.results,[false,false,false,false]);
  checks.push('classic mute suppresses ui, found, miss and win and persists its shared setting');

  await c.send('Page.reload',{ignoreCache:true});await wait(300);await ready();
  const restored=await c.evaluate(`({stored:localStorage.p2pMuted,pressed:document.querySelector('#classicMute').getAttribute('aria-pressed'),muted:CatGameAudioControls.isMuted()})`);
  assert.deepEqual(restored,{stored:'1',pressed:'true',muted:true});
  await c.evaluate(`document.querySelector('#continueClassic').click()`);await wait(80);
  const mutePoint=await c.evaluate(`(()=>{const r=document.querySelector('#classicMute').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:mutePoint.x,y:mutePoint.y,button:'left',buttons:1,clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:mutePoint.x,y:mutePoint.y,button:'left',buttons:0,clickCount:1});await wait(150);
  const unlock=await c.evaluate(`(async()=>({stored:localStorage.p2pMuted,pressed:document.querySelector('#classicMute').getAttribute('aria-pressed'),played:await CatGameAudioControls.play('ui',{id:'post-unmute-browser-gesture'})}))()`);
  assert.equal(unlock.stored,'0');assert.equal(unlock.pressed,'false');assert.equal(unlock.played,true);
  checks.push('mute restores after reload and a real browser click unlocks audible playback');

  await c.evaluate(`localStorage.removeItem('catClassicProgressV1');location.reload();true`);await wait(300);await ready();await c.evaluate(`document.querySelector('#chooseClassic').click()`);await instrument();
  const solution=await c.evaluate(`CAT_CLASSIC_LEVELS[0].solution`);for(const index of solution)await clickCell(index,2);await wait(120);
  const completed=await c.evaluate(`({open:document.querySelector('#classicResult').open,focus:document.activeElement?.id,winResults:window.__classicAudioCalls.filter(call=>call.kind==='win').map(call=>call.result),cats:[...document.querySelectorAll('#classicBoard .cat')].map(cell=>Number(cell.dataset.index)),progress:document.querySelector('#classicProgress').textContent})`);
  assert.equal(completed.open,true,JSON.stringify(completed));assert.equal(completed.focus,'classicResultNext');assert.deepEqual(completed.winResults,[true]);
  await c.evaluate(`document.querySelector('#classicResultClose').click()`);await wait(50);
  const closeFocus=await c.evaluate(`({open:document.querySelector('#classicResult').open,cell:document.activeElement?.dataset?.index})`);assert.equal(closeFocus.open,false);assert.ok(solution.map(String).includes(closeFocus.cell));
  await c.evaluate(`document.querySelector('#classicResult').showModal()`);await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await wait(50);
  const escaped=await c.evaluate(`({open:document.querySelector('#classicResult').open,cell:document.activeElement?.dataset?.index,wins:window.__classicAudioCalls.filter(call=>call.kind==='win').length})`);assert.equal(escaped.open,false);assert.ok(solution.map(String).includes(escaped.cell));assert.equal(escaped.wins,1);
  await c.evaluate(`document.querySelector('#classicResult').showModal();document.querySelector('#classicResultReplay').click()`);await wait(80);
  const replayed=await c.evaluate(`({marks:document.querySelectorAll('#classicBoard .cat,#classicBoard .note').length,wins:window.__classicAudioCalls.filter(call=>call.kind==='win').length})`);assert.deepEqual(replayed,{marks:0,wins:1});
  for(const index of solution)await clickCell(index,2);await wait(120);await c.evaluate(`document.querySelector('#classicResultNext').click()`);await wait(80);
  const advanced=await c.evaluate(`({progress:document.querySelector('#classicProgress').textContent,wins:window.__classicAudioCalls.filter(call=>call.kind==='win').length})`);assert.deepEqual(advanced,{progress:'2 / 300',wins:2});
  await c.send('Page.reload',{ignoreCache:true});await wait(300);await ready();await instrument();await c.evaluate(`document.querySelector('#continueClassic').click()`);await wait(80);
  assert.equal(await c.evaluate(`document.querySelector('#classicResult').open`),false);assert.equal(await c.evaluate(`window.__classicAudioCalls.filter(call=>call.kind==='win').length`),0);
  checks.push('completion opens once, focuses Next, close and Escape restore board focus, and Replay, Next and reload do not replay it');

  const report={passed:true,actualBrowser:true,audioHardwareListened:false,audioCallAndUnlockVerified:true,checks,interactionCalls,muted,restored,unlock,completed,closeFocus,escaped,replayed,advanced};
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));c.socket.close();
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
