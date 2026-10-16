'use strict';

// Test-only bridge for independently validated constructive research fixtures.
// It never writes the fixture into the release multiplayer catalog.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const Pools=require('../puzzle-pools.js');
const catalog=require('../multiplayer-levels.js');
const Battle=require('../battle-engine.js');
const Survival=require('../survival-engine.js');

const fixturePath=path.resolve(process.argv[2]||'');
if(!process.argv[2]||!fs.existsSync(fixturePath))throw new Error('Pass the constructive fixture JSON path.');

function rotate(size,regions,solution,turns){
  let cells=regions.slice(),answer=solution.slice();
  for(let turn=0;turn<turns;turn++){
    const next=Array(size*size),nextAnswer=[];
    for(let row=0;row<size;row++)for(let column=0;column<size;column++)next[column*size+(size-1-row)]=cells[row*size+column];
    for(const index of answer){const row=Math.floor(index/size),column=index%size;nextAnswer.push(column*size+(size-1-row));}
    cells=next;answer=nextAnswer.sort((left,right)=>left-right);
  }
  return{regions:cells,solution:answer};
}

function makeCatalog(source){
  assert.equal(source.accepted,true);
  assert.equal(source.releaseEligible,false);
  const size=source.size,regions=source.regions.flat(),solution=source.validation.solution.map(cell=>cell.index),shapes=Array.from({length:4},(_,index)=>rotate(size,regions,solution,index));
  const tiers={};
  for(const tier of Pools.TIERS)tiers[tier]=Array.from({length:16},(_,index)=>{
    const shape=shapes[index%4],id=`fixture-${size}-${tier}-${index+1}`;
    return{id,size,regions:shape.regions.slice(),solution:shape.solution.slice(),givens:[],puzzleFingerprint:crypto.createHash('sha256').update(`${id}|${shape.regions.join(',')}`).digest('hex'),givensFingerprint:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',scoringEligible:true,highestTechnique:source.logic.metrics.highestTechnique,techniqueRank:source.logic.metrics.highestTechniqueRank,reasoningLoad:.72,morphologySignature:'research-fixture'};
  });
  return{packVersion:'research-fixture-not-release',poolVersion:`constructive-${size}x${size}-runtime-only`,tiers};
}

const source=JSON.parse(fs.readFileSync(fixturePath,'utf8')),fixture=makeCatalog(source);
assert.equal(Pools.validCatalog(fixture),true);
assert.equal(source.geometry.valid,true);
assert.equal(source.validation.status,'UNIQUE');
assert.equal(source.logic.status,'SOLVED');
const sequence=Pools.create({catalog:fixture,tier:'challenge',matchId:'large-board-smoke',roundSeed:'fixed'}),cohort=Array.from({length:4},(_,lane)=>sequence.at(0,lane));
assert.deepEqual([...new Set(cohort.map(item=>item.size))],[source.size]);
assert.equal(new Set(cohort.map(item=>item.levelId)).size,4);
assert.equal(new Set(cohort.map(item=>item.techniqueRank)).size,1);

const saved={packVersion:catalog.packVersion,poolVersion:catalog.poolVersion,tiers:catalog.tiers};
try{
  catalog.packVersion=fixture.packVersion;catalog.poolVersion=fixture.poolVersion;catalog.tiers=fixture.tiers;
  const battle=Battle.create({difficulty:'challenge',roundSeed:'fixture'},[{connected:true},{connected:true}]);
  assert.deepEqual(battle.boards.map(board=>board.puzzle.size),[source.size,source.size]);
  assert.equal(new Set(battle.boards.map(board=>board.selection.levelId)).size,2);
  const battleGuest=Battle.publicGame(battle,0,1);
  assert.equal(Array.isArray(battleGuest.boards[0].puzzle.regions),false);
  assert.equal(battleGuest.boards[1].puzzle.regions.length,source.size*source.size);

  const players=Array.from({length:4},(_,index)=>({id:`p${index}`,ready:true,connected:true})),survival=Survival.create({difficulty:'challenge',roundSeed:'fixture'},players,{now:0});
  assert.deepEqual(survival.boards.map(board=>board.puzzle.size),[source.size,source.size,source.size,source.size]);
  assert.equal(new Set(survival.boards.map(board=>board.selection.levelId)).size,4);
  const survivalGuest=Survival.publicGame(survival,0,'p2');
  assert.equal(survivalGuest.boards.filter((_,index)=>index!==2).every(board=>!Array.isArray(board.puzzle.regions)),true);
  assert.equal('blast' in (survival.lastEvent||{}),false);
  process.stdout.write(`${JSON.stringify({passed:true,fixture:{path:fixturePath,size:source.size,releaseEligible:false,classification:source.classification},validatedLevels:64,cohort:{size:source.size,players:4,distinctLevelIds:4,techniqueRank:cohort[0].techniqueRank,reasoningLoadSpread:0},battle:{players:2,privateOpponent:true},survival:{players:4,privateOpponents:true,noBlast:true}},null,2)}\n`);
}finally{
  catalog.packVersion=saved.packVersion;catalog.poolVersion=saved.poolVersion;catalog.tiers=saved.tiers;
}
