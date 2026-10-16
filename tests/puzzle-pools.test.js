'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Pools=require('../puzzle-pools.js');
const catalog=require('../multiplayer-levels.js');
const Battle=require('../battle-engine.js');
const Survival=require('../survival-engine.js');
const Classic=require('../classic-engine.js');

test('all four scoring pools meet release supply and contain validated mixed-size no-given puzzles',()=>{
  assert.equal(Pools.validCatalog(catalog),true);
  const ids=new Set();
  for(const tier of Pools.TIERS){
    assert.ok(catalog.supply[tier].eligible>=25);assert.equal(catalog.tiers[tier].length,catalog.supply[tier].selected);
    for(const level of catalog.tiers[tier]){
      assert.ok(level.size>=4&&level.size<=12);assert.deepEqual(level.givens,[]);assert.equal(level.scoringEligible,true);
      assert.equal(Classic.validate(level).valid,true);assert.equal(ids.has(level.id),false);ids.add(level.id);
    }
  }
  assert.equal(ids.size,92);
  assert.deepEqual(Object.fromEntries(Pools.TIERS.map(tier=>[tier,[...new Set(catalog.tiers[tier].map(level=>level.size))].sort((a,b)=>a-b)])),{beginner:[4,6],normal:[5,6,10],advanced:[6,7,8,12],challenge:[6,7]});
});

test('same authority inputs produce deterministic, distinct fairness cohorts',()=>{
  const options={tier:'advanced',matchId:'match-42',roundSeed:'seed-9'},one=Pools.create(options),two=Pools.create(options);
  const first=Array.from({length:one.size*2+1},(_,index)=>one.at(index,0)),second=Array.from({length:one.size*2+1},(_,index)=>two.at(index,0));
  assert.deepEqual(first.map(value=>value.levelId),second.map(value=>value.levelId));
  assert.equal(new Set(first.slice(0,one.size).map(value=>value.levelId)).size,one.size);
  for(let round=0;round<one.size*2;round++){
    const cohort=Array.from({length:4},(_,lane)=>one.at(round,lane));
    assert.equal(new Set(cohort.map(value=>value.levelId)).size,4);
    assert.equal(new Set(cohort.map(value=>value.size)).size,1);
    assert.equal(new Set(cohort.map(value=>value.techniqueRank)).size,1);
    assert.ok(Math.max(...cohort.map(value=>value.reasoningLoad))-Math.min(...cohort.map(value=>value.reasoningLoad))<=0.25);
  }
  assert.ok(first.every(value=>one.assertSelection(value)));
});

test('version or fingerprint mismatch is rejected without fallback',()=>{
  assert.throws(()=>Pools.create({tier:'normal',matchId:'m',roundSeed:'s',packVersion:'wrong'}),/version mismatch/);
  assert.throws(()=>Pools.create({tier:'normal',matchId:'m',roundSeed:'s',poolVersion:'wrong'}),/version mismatch/);
  const sequence=Pools.create({tier:'normal',matchId:'m',roundSeed:'s'}),selection=sequence.at(0);
  assert.equal(sequence.assertSelection({...selection,puzzleFingerprint:'0'.repeat(64)}),false);
});

test('integrated large cohorts schedule one private four-board cohort per validated size',()=>{
  for(const[tier,size]of [['advanced',8],['normal',10],['advanced',12]]){
    const sequence=Pools.create({tier,matchId:`large-${size}`,roundSeed:'fixed'}),rounds=Array.from({length:sequence.size},(_,index)=>Array.from({length:4},(_,lane)=>sequence.at(index,lane))),cohort=rounds.find(values=>values[0].size===size);
    assert.ok(cohort,`missing ${size}x${size} cohort`);assert.equal(new Set(cohort.map(value=>value.levelId)).size,4);assert.equal(new Set(cohort.map(value=>value.puzzleFingerprint)).size,4);assert.deepEqual([...new Set(cohort.map(value=>value.techniqueRank))],[2]);assert.ok(cohort.every(value=>value.puzzle.regions.length===size*size&&value.puzzle.solution.length===size));
  }
});

test('battle and survival assign different puzzles from one matched fairness cohort',()=>{
  const battle=Battle.create({difficulty:'challenge',roundSeed:'fixed'},[{connected:true},{connected:true}]);
  assert.notEqual(battle.boards[0].selection.levelId,battle.boards[1].selection.levelId);
  assert.equal(battle.boards[0].selection.cohort,battle.boards[1].selection.cohort);
  assert.equal(battle.boards[0].selection.techniqueRank,battle.boards[1].selection.techniqueRank);
  const survival=Survival.create({difficulty:'beginner',roundSeed:'fixed'},[{id:'a',ready:true},{id:'b',ready:true},{id:'c',ready:true}],{now:0});
  assert.equal(new Set(survival.boards.map(board=>board.selection.levelId)).size,3);
  assert.equal(new Set(survival.boards.map(board=>board.selection.cohort)).size,1);
  assert.equal(new Set(survival.boards.map(board=>board.puzzle.id)).size,3);
});
