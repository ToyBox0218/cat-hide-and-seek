'use strict';
const assert=require('node:assert/strict');
const endpoint=process.argv[2]||'http://127.0.0.1:9245';
const pageUrl=process.argv[3]||'http://127.0.0.1:3011/?classic-drag-test=1';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function connect(){
  let pages;
  for(let attempt=0;attempt<40;attempt++){
    try{pages=await fetch(`${endpoint}/json/list`).then(response=>response.json());if(pages.length)break}catch{}
    await wait(250);
  }
  const page=pages?.find(item=>item.type==='page');if(!page)throw Error('No browser page');
  const socket=new WebSocket(page.webSocketDebuggerUrl),pending=new Map();let id=0;
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  socket.onmessage=event=>{const message=JSON.parse(event.data);if(!message.id||!pending.has(message.id))return;const job=pending.get(message.id);pending.delete(message.id);message.error?job.reject(Error(JSON.stringify(message.error))):job.resolve(message.result)};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}))});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
  return{socket,send,evaluate};
}

(async()=>{
  const c=await connect(),results=[];
  const inspect=()=>c.evaluate(`(()=>({cats:[...document.querySelectorAll('#classicBoard .cat')].map(n=>+n.dataset.index),crosses:[...document.querySelectorAll('#classicBoard .note')].map(n=>+n.dataset.index),saved:JSON.parse(localStorage.getItem('catClassicProgressV1')||'{}'),width:innerWidth,scrollWidth:document.documentElement.scrollWidth}))()`);
  async function ready(){for(let i=0;i<40;i++){if(await c.evaluate(`!!window.CatClassic&&window.CAT_CLASSIC_LEVELS?.length===300&&typeof document.querySelector('#chooseClassic')?.onclick==='function'`).catch(()=>false))return;await wait(100)}throw Error('Classic app did not load')}
  async function reset(width,height){await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await c.send('Page.navigate',{url:`${pageUrl}&w=${width}`});await ready();await c.evaluate(`localStorage.clear();document.querySelector('#chooseClassic').click();true`);await wait(80)}
  const centers=()=>c.evaluate(`([...document.querySelectorAll('#classicBoard .classic-cell')].map(n=>{const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}}))`);
  async function mousePath(indices,{outside=false}={}){const points=await centers(),start=points[indices[0]];await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:start.x,y:start.y,button:'left',buttons:1,clickCount:1});await wait(300);for(const index of indices.slice(1)){const point=points[index];await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'left',buttons:1});await wait(25)}const end=outside?{x:points[3].x+points[3].x-points[2].x,y:points[3].y}:points[indices.at(-1)];await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:end.x,y:end.y,button:'left',buttons:0,clickCount:1});await wait(80)}
  async function click(index,count=1){const point=(await centers())[index];for(let n=1;n<=count;n++){await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:n});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:n});if(n<count)await wait(45)}await wait(350)}

  await reset(1366,768);
  await mousePath([0,1,2,3]);let value=await inspect();assert.deepEqual(value.crosses,[0,1,2,3]);assert.deepEqual(value.cats,[]);results.push('desktop row drag');
  await wait(650);await click(0);value=await inspect();assert.deepEqual(value.crosses,[1,2,3]);results.push('single click erases X');
  await click(5,2);value=await inspect();assert.deepEqual(value.cats,[5]);results.push('double click places cat');
  await mousePath([4,5,6]);value=await inspect();assert.deepEqual(value.cats,[5]);assert.ok(value.crosses.includes(4)&&value.crosses.includes(6)&&!value.crosses.includes(5));results.push('drag skips cat');
  await mousePath([8,9,13,12,8]);value=await inspect();for(const index of [8,9,12,13])assert.ok(value.crosses.includes(index));assert.deepEqual(value.cats,[5]);results.push('turned and re-entered path');
  await mousePath([10,11],{outside:true});value=await inspect();assert.ok(value.crosses.includes(10)&&value.crosses.includes(11));assert.deepEqual(value.cats,[5]);results.push('out-of-bounds release');
  await c.send('Page.reload',{ignoreCache:true});await wait(300);await ready();await c.evaluate(`document.querySelector('#continueClassic').click();true`);await wait(80);value=await inspect();assert.ok(value.crosses.includes(13));assert.deepEqual(value.cats,[5]);results.push('reload persistence');

  await reset(390,844);await mousePath([0,1,2,3]);value=await inspect();assert.equal(value.width,390);assert.ok(value.scrollWidth<=390);assert.deepEqual(value.crosses,[0,1,2,3]);assert.deepEqual(value.cats,[]);results.push('390px row drag without overflow');
  console.log(JSON.stringify({passed:true,results,desktopAnd390:true,actualBrowserPointerPaths:true}));
  c.socket.close();
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
