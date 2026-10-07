'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'legacy-modes.test.js'),'utf8');
const boundary=source.indexOf("\ntest('");
assert.ok(boundary>0);
const context={require,__dirname,console,Buffer,URL,URLSearchParams};
vm.runInNewContext(source.slice(0,boundary)+'\nglobalThis.makeHarness=harness;',context);

// Exercise the real legacy factory, rather than calling the generator directly.
// The old one-tile path could only produce eight oriented geometries.
for(const mode of ['basic','items','treasure','coop'])test(`${mode} 6x6 rematches share diverse logical puzzles without publishing private history`,()=>{
  const h=context.makeHarness({mode,size:6,seed:672091}),B=h.context.CatBattle;
  const boards=new Set(),answers=new Set();
  for(let round=0;round<12;round++){
    const game=h.newGame(6),puzzle=game.puzzle;
    assert.equal(game.settings.mode,mode);
    assert.equal(B.validatePuzzle(puzzle).valid,true);
    assert.equal(B.solveLogically(puzzle.regions).solved,true);
    boards.add(B.boardKey(puzzle.regions));answers.add(B.solutionPattern(puzzle.solution));
    assert.deepEqual(Array.from(game.players,p=>p.score),[0,0]);
    assert.doesNotMatch(JSON.stringify(h.publicGame(game)),/"(?:solution|recentPatterns|recentGeometry|generationSequence|steps|seed)"\s*:/);
  }
  assert.equal(boards.size,12,'more than the old eight template orientations');
  assert.equal(answers.size,12,'quick rematches do not reuse an answer pattern');
});
