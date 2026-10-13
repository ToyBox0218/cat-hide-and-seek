'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Survival=require('../survival-engine.js');
function player(id){return{id,nickname:id,connected:true,ready:true}}
test('survival settings expose no tabby or blast ability',()=>{
  const settings=Survival.settings({tabbyEnabled:true});
  assert.deepEqual(settings,{mode:'survival',size:6,capacity:4});
});
test('a found cat reveals and scores only the selected cell',()=>{
  const game=Survival.create({},[player('a'),player('b')],{now:0,rng:()=>0.25});
  assert.equal(Survival.start(game,0),true);Survival.advance(game,3000);
  const board=game.boards[0],index=board.puzzle.solution[0];
  const result=Survival.act(game,'a',{type:'guess',actionId:'one',boardId:board.puzzle.id,index},3000);
  assert.equal(result.accepted,true);assert.equal(game.players[0].score,1);assert.deepEqual(board.found,[index]);assert.deepEqual(board.misses,[]);
  assert.equal('tabby'in result.event,false);assert.equal('blast'in result.event,false);
  const snapshot=Survival.publicGame(game,3000);assert.equal('revealedTabbies'in snapshot.boards[0],false);assert.equal('blastRevealed'in snapshot.boards[0],false);
});

