'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../battle-engine.js'),'utf8');
function engine() { const box = {module:{exports:{}}}; vm.runInNewContext(source,box); return box.module.exports; }
function seeded(seed) { return () => { seed = Math.imul(seed,1664525)+1013904223; return (seed >>> 0)/0x100000000; }; }
function variants(regions) {
  return Array.from({length:8},(_,symmetry) => {
    const result = [];
    regions.forEach((region,cell) => {
      let row = Math.floor(cell/6), column = cell%6;
      if (symmetry >= 4) column = 5-column;
      for (let turn = 0; turn < symmetry%4; turn++) [row,column] = [column,5-row];
      result[row*6+column] = region;
    });
    return result;
  });
}
function normalized(regions) {
  const labels = new Map();
  return regions.map(region => { if (!labels.has(region)) labels.set(region,labels.size); return labels.get(region); }).join('');
}
function topology(regions) { return variants(regions).map(normalized).sort()[0]; }
function boundary(regions) {
  let bits = 0n, edge = 0n;
  for (let cell = 0; cell < 36; cell++) for (const next of [cell%6 < 5 ? cell+1 : -1,cell < 30 ? cell+6 : -1]) {
    if (next < 0) continue;
    if (regions[cell] !== regions[next]) bits |= 1n << edge;
    edge++;
  }
  return bits;
}
function popcount(value) { let result = 0; while (value) { value &= value-1n; result++; } return result; }
function conflict(regions,a,b) {
  return a !== b && (Math.floor(a/6) === Math.floor(b/6) || a%6 === b%6 || regions[a] === regions[b] ||
    (Math.abs(Math.floor(a/6)-Math.floor(b/6)) <= 1 && Math.abs(a%6-b%6) <= 1));
}
function referenceSolutions(regions) {
  const found = [];
  function visit(row,answer) {
    if (row === 6) { found.push(answer); return; }
    for (let column = 0; column < 6; column++) {
      const cell = row*6+column;
      if (answer.every(other => !conflict(regions,cell,other))) visit(row+1,answer.concat(cell));
    }
  }
  visit(0,[]); return found;
}
function checkProof(B,puzzle) {
  const proof = B.solveLogically(puzzle.regions,true), active = new Set(Array.from({length:36},(_,cell) => cell));
  assert.equal(proof.solved,true);
  assert.ok(proof.steps.length > 0 && proof.steps.length <= 30,'every step removes at least one of 30 empty cells');
  for (const step of proof.steps) {
    const candidates = Array.from(active).filter(cell => step.kind === 'row' ? Math.floor(cell/6) === step.group :
      step.kind === 'column' ? cell%6 === step.group : puzzle.regions[cell] === step.group);
    assert.deepEqual(Array.from(step.candidates),candidates,'proof uses exactly the currently possible cells of a visible group');
    assert.ok(candidates.length > 0);
    for (const cell of step.excluded) {
      assert.ok(active.has(cell));
      assert.ok(candidates.every(other => conflict(puzzle.regions,cell,other)),'the group cat rules out this cell wherever it is');
      active.delete(cell);
    }
  }
  assert.deepEqual(Array.from(active),Array.from(puzzle.solution),'the proof reaches all cats without reading the supplied answer');
}

test('fresh 6×6 regions have independently replayable non-guess proofs and a unique reference answer', () => {
  const B = engine(), rng = seeded(8675309);
  for (let sample = 0; sample < 180; sample++) {
    const puzzle = B.generatePuzzle({rng});
    assert.equal(B.validatePuzzle(puzzle).valid,true);
    const answers = referenceSolutions(puzzle.regions);
    assert.equal(answers.length,1);
    assert.deepEqual(answers[0],Array.from(puzzle.solution));
    checkProof(B,puzzle);
  }
  const unconstrained = Array.from({length:36},(_,cell) => Math.floor(cell/6));
  assert.equal(B.solveLogically(unconstrained,true).solved,false);
  assert.equal(B.solveLogically([]).solved,false);
});

test('deterministic sample improves actual boundaries and excludes rotated recent topologies', () => {
  const B = engine(), rng = seeded(123456789), patterns = [], boards = [], recent = [], distances = [], all = new Set();
  for (let sample = 0; sample < 360; sample++) {
    const puzzle = B.generatePuzzle({rng,avoidSolutions:patterns,avoidBoards:boards,currentSolutions:patterns.slice(-2)});
    const shape = topology(puzzle.regions), masks = variants(puzzle.regions).map(boundary), key = B.solutionPattern(puzzle.solution);
    assert.ok(!recent.some(previous => previous.shape === shape),'rotation/reflection and region relabeling do not count as new');
    if (recent.length) distances.push(Math.min(...recent.map(previous => Math.min(...masks.map(mask => popcount(mask ^ previous.mask))))));
    if (sample < 90) assert.ok(!patterns.includes(key),'all 90 answer patterns remain available');
    all.add(shape); patterns.push(key); boards.push(B.boardKey(puzzle.regions)); recent.push({shape,mask:masks[0]});
    if (patterns.length > 90) patterns.shift(); if (boards.length > 90) boards.shift(); if (recent.length > 90) recent.shift();
  }
  distances.sort((a,b) => a-b);
  assert.equal(all.size,360);
  assert.equal(distances.filter(distance => distance <= 4).length,0,'no near-copy within four boundary edits');
  assert.ok(distances[Math.floor(distances.length/2)] >= 15,'median nearest-recent geometry differs by at least 15 boundary edges');
});

test('same-page quick rematches avoid recent answers and topologies without carrying previousGame', () => {
  const B = engine(), patterns = [], shapes = [];
  for (let match = 0; match < 60; match++) {
    const game = B.create();
    for (const board of game.boards) {
      const key = B.solutionPattern(board.puzzle.solution), shape = topology(board.puzzle.regions);
      // Only 90 valid answers exist. All are used before the first reuse.
      if (patterns.length < 90) assert.ok(!patterns.includes(key));
      assert.ok(!shapes.slice(-90).includes(shape));
      patterns.push(key); shapes.push(shape);
    }
    const snapshot = JSON.stringify(B.publicGame(game,0));
    for (const hidden of ['solution','recentPatterns','recentGeometry','generationSequence','seed','_history','boundaries','topology']) assert.ok(!snapshot.includes(hidden),hidden);
  }
  assert.equal(new Set(patterns.slice(0,90)).size,90);
});

test('stuck entropy is bounded and cannot repeat a rotated topology across repeated generations', () => {
  const B = engine(), recent = []; let entropyCalls = 0;
  for (let sample = 0; sample < 200; sample++) {
    const puzzle = B.generatePuzzle({rng:() => { entropyCalls++; return 0; }}), shape = topology(puzzle.regions);
    assert.ok(!recent.includes(shape));
    assert.equal(B.validatePuzzle(puzzle).valid,true);
    recent.push(shape); if (recent.length > 90) recent.shift();
  }
  assert.equal(entropyCalls,200,'one entropy seed per board; repair and fallback loops have fixed limits');
});

test('caller history recognizes rotated and relabeled boards even in a new engine instance', () => {
  const A = engine(), B = engine(), first = A.generatePuzzle({rng:seeded(5)});
  const avoidBoards = variants(first.regions).map(regions => normalized(regions.map(label => 5-label)));
  const next = B.generatePuzzle({rng:seeded(5),avoidBoards});
  assert.notEqual(topology(next.regions),topology(first.regions));
});

test('uniqueness alone does not pass the new teachability validation', () => {
  const B = engine();
  const fixture = [...source.matchAll(/'([0-5]{6}):([0-5]{36})'/g)].map(match => ({size:6,
    solution:Array.from(match[1],(column,row) => row*6+Number(column)),regions:Array.from(match[2],Number)}))
    .find(puzzle => !B.solveLogically(puzzle.regions).solved);
  assert.ok(fixture,'retain a genuinely unique example that the bounded logic rules cannot finish');
  assert.equal(referenceSolutions(fixture.regions).length,1);
  const validation = B.validatePuzzle(fixture);
  assert.equal(validation.solutionCount,1);
  assert.equal(validation.valid,false);
  assert.ok(validation.errors.includes('Puzzle lacks a non-guess logical deduction proof.'));
});
