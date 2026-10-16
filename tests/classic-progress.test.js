'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Classic=require('../classic-engine.js'),Progress=require('../classic-progress.js');

const levels=[
  {id:'a',size:4,regions:[0,0,1,1,0,0,1,1,2,2,3,3,2,2,3,3],givens:[0],solution:[0,6,9,15]},
  {id:'b',size:4,regions:[0,0,1,1,0,0,1,1,2,2,3,3,2,2,3,3],solution:[1,7,8,14]}
];
function memory(seed={}){
  const values=new Map(Object.entries(seed));
  return{getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),value:key=>values.get(key)};
}

test('legacy progress imports without modifying or deleting its original bytes',()=>{
  const legacy=JSON.stringify({schema:2,current:1,completed:[0],boards:{0:{cats:[0,6],crosses:[2]},1:{cats:[7],crosses:[3]}}});
  const storage=memory({catClassicProgressV1:legacy}),store=Progress.create({storage,levels,Classic});
  const imported=store.read();
  assert.equal(imported.currentId,'b');assert.deepEqual(imported.completed,['a']);
  assert.deepEqual(store.board(imported,0).cats,[6],'a given is not duplicated in player marks');
  store.write(store.setBoard(imported,1,{cats:new Set([7]),crosses:new Set([3])}));
  store.clear();
  assert.equal(storage.value('catClassicProgressV1'),legacy);
  assert.equal(store.read().legacySource,'catClassicProgressV1');
  assert.deepEqual(store.read().boards,{},'clearing creates a schema-3 record and cannot silently re-import legacy state');
});

test('pack ids isolate progress and fingerprints quarantine changed boards',()=>{
  const storage=memory(),first=Progress.create({storage,levels,Classic,packId:'pack-a'});
  first.write(first.setBoard(first.read(),0,{cats:new Set([6]),crosses:new Set([2])}));
  const second=Progress.create({storage,levels,Classic,packId:'pack-b'});
  assert.equal(second.facts().hasProgress,false);
  const changed=[{...levels[0],regions:levels[0].regions.map((value,index)=>index===0?1:index===2?0:value)},levels[1]];
  const reopened=Progress.create({storage,levels:changed,Classic,packId:'pack-a'}),board=reopened.board(reopened.read(),0);
  assert.equal(board.matched,false);assert.deepEqual(board.cats,[]);assert.deepEqual(board.crosses,[]);
});

test('completed levels and current level are keyed by stable level ids',()=>{
  const storage=memory(),store=Progress.create({storage,levels,Classic,packId:'ids'});
  let progress=store.setBoard(store.read(),1,{cats:new Set([7]),crosses:new Set([3])});
  progress=store.complete(progress,0);progress=store.write(progress);
  assert.equal(progress.currentId,'b');assert.deepEqual(progress.completed,['a']);
  assert.equal(store.facts(progress).current,1);assert.equal(store.facts(progress).marks,2);
});
