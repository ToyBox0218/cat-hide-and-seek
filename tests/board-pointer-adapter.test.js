'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Adapter=require('../board-pointer-adapter.js');

function harness({consume=false}={}){
  const listeners=new Map(),classes=new Set(),grid={children:[],classList:{add:value=>classes.add(value),remove:value=>classes.delete(value)},contains:cell=>grid.children.includes(cell),getBoundingClientRect:()=>({left:0,top:0,width:40,height:40})};
  const document={hidden:false,elementFromPoint:()=>null,addEventListener:(type,fn)=>listeners.set(`d:${type}`,fn),removeEventListener:()=>{}};
  const window={addEventListener:(type,fn)=>listeners.set(`w:${type}`,fn),removeEventListener:()=>{}};
  const strokeOptions=[],downs=[],Strokes={create(options){strokeOptions.push(options);let tracking=false;return{down(event){downs.push(event);tracking=true;options.onStart?.(event);return{consumed:consume};},move(){return{consumed:consume};},up(event){tracking=false;const result={...event,consumed:consume};options.onEnd?.(result);return result;},pointerCancel(){tracking=false;},cancel(){tracking=false;},reset(){tracking=false;},sync(){},state(){return{tracking,active:tracking,pointerCount:tracking?1:0};}};}};
  const clicks=[],cancels=[];
  const adapter=Adapter.create({document,window,Strokes,getGrid:()=>grid,getContext:()=> 'board',canAct:()=>true,canMark:()=>true,onAdd:()=>true,onCancelPress:cell=>cancels.push(cell)});
  function cell(index){const value={dataset:{index:String(index)},classList:{},getBoundingClientRect:()=>({left:index*20,top:0,width:20,height:20,right:index*20+20,bottom:20}),setPointerCapture(){},hasPointerCapture(){return false;}};grid.children.push(value);adapter.wireCell(value,index,{onClick:(node,event,stroke)=>clicks.push(stroke)});return value;}
  return{adapter,cell,clicks,cancels,listeners,classes,strokeOptions,downs};
}

test('shared adapter wires a pointer click once and clears its active stroke',()=>{
  const h=harness(),cell=h.cell(0),event={button:0,pointerId:7,pointerType:'mouse',isPrimary:true,buttons:1,clientX:5,clientY:5,timeStamp:10};
  cell.onpointerdown(event);h.listeners.get('d:pointerup')({...event,buttons:0,timeStamp:20});cell.onclick({...event,detail:1,buttons:0,timeStamp:21});
  assert.equal(h.clicks.length,1);assert.equal(h.clicks[0].consumed,false);assert.equal(h.adapter.state().records,0);
});

test('consumed strokes suppress click activation metadata and cancel the competing press',()=>{
  const h=harness({consume:true}),cell=h.cell(0),event={button:0,pointerId:4,pointerType:'mouse',isPrimary:true,buttons:1,clientX:5,clientY:5,timeStamp:10};
  cell.onpointerdown(event);h.listeners.get('d:pointerup')({...event,buttons:0,timeStamp:30});cell.onclick({...event,detail:1,buttons:0,timeStamp:31});
  assert.equal(h.clicks[0].consumed,true);assert.ok(h.cancels.length>=1);assert.equal(h.classes.has('marking-stroke'),false);
});

test('reset quarantines records and dispose is repeatable',()=>{
  const h=harness(),cell=h.cell(0),event={button:0,pointerId:2,pointerType:'touch',isPrimary:true,buttons:1,clientX:5,clientY:5,timeStamp:10};
  cell.onpointerdown(event);h.adapter.reset('view-change');assert.equal(h.adapter.state().records,0);assert.ok(h.cancels.includes(cell));h.adapter.dispose();h.adapter.dispose();
});

test('an unwired matching cell still counts as an extra pointer and cancels a connected-board stroke',()=>{
  const h=harness(),cell=h.cell(0),event={button:0,pointerId:1,pointerType:'touch',isPrimary:true,buttons:1,clientX:5,clientY:5,timeStamp:10};
  cell.onpointerdown(event);h.listeners.get('d:pointerdown')({...event,pointerId:2,isPrimary:false,target:{closest:()=>({})}});assert.equal(h.downs.length,2);assert.equal(h.downs[1].index,null);
});

for(const [name,dispatch] of [
  ['pointercancel',(cell,event)=>cell.onpointercancel(event)],
  ['lostpointercapture',(cell,event)=>cell.onlostpointercapture(event)],
  ['cell blur',(cell)=>cell.onblur()]
])test(`${name} clears the active pointer record and quarantines its click`,()=>{
  const h=harness(),cell=h.cell(0),event={button:0,pointerId:9,pointerType:'pen',isPrimary:true,buttons:1,clientX:5,clientY:5,timeStamp:10};
  cell.onpointerdown(event);assert.equal(h.adapter.state().records,1);dispatch(cell,event);assert.equal(h.adapter.state().records,0);assert.ok(h.cancels.includes(cell));
  cell.onclick({...event,detail:1,buttons:0,timeStamp:20});assert.equal(h.clicks.at(-1).consumed,true);
});
