'use strict';
// Local, dependency-free benchmark. Examples:
//   node scripts/benchmark-puzzle-diversity.js
//   node scripts/benchmark-puzzle-diversity.js --baseline=9c57511 --samples=1080
// Wall-clock figures describe this Node host, not a browser or mobile device.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const {execFileSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const root = path.resolve(__dirname,'..'), currentSource = fs.readFileSync(path.join(root,'battle-engine.js'),'utf8');
const options = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/,'').split('=')));
const samples = Number(options.samples) || 1080;
function load(source,name) {
  const instance = new Module(path.join(root,name)); instance.filename = path.join(root,name);
  instance._compile(source,instance.filename); return instance.exports;
}
const logicalReference = load(currentSource,'logical-reference.js');
function seeded(seed) { return () => { seed = Math.imul(seed,1664525)+1013904223; return (seed>>>0)/4294967296; }; }
function variants(values) {
  return Array.from({length:8},(_,symmetry) => {
    const result = [];
    values.forEach((value,cell) => {
      let row = Math.floor(cell/6), column = cell%6;
      if (symmetry >= 4) column = 5-column;
      for (let turn = 0; turn < symmetry%4; turn++) [row,column] = [column,5-row];
      result[row*6+column] = value;
    });
    return result;
  });
}
function normalize(values) { const labels = new Map(); return values.map(value => { if (!labels.has(value)) labels.set(value,labels.size); return labels.get(value); }).join(''); }
function boundary(values) {
  let result = 0n, edge = 0n;
  for (let cell = 0; cell < 36; cell++) for (const next of [cell%6<5 ? cell+1 : -1,cell<30 ? cell+6 : -1]) {
    if (next < 0) continue;
    if (values[cell] !== values[next]) result |= 1n << edge;
    edge++;
  }
  return result;
}
function popcount(value) { let result = 0; while (value) { value &= value-1n; result++; } return result; }
function summary(values) {
  values = values.slice().sort((a,b) => a-b);
  const rounded = value => Number(value.toFixed(3));
  return {min:rounded(values[0]),median:rounded(values[Math.floor(values.length/2)]),mean:rounded(values.reduce((a,b) => a+b,0)/values.length),p95:rounded(values[Math.min(values.length-1,Math.floor(values.length*0.95))]),max:rounded(values[values.length-1])};
}
// Both implementations are compared to the same original fallback geometry set.
const baseSource = options.baseline ? execFileSync('git',['show',`${options.baseline}:battle-engine.js`],{cwd:root,encoding:'utf8'}) : currentSource;
const baseMasks = [...baseSource.matchAll(/'([0-5]{6}):([0-5]{36})'/g)].flatMap(match => variants(Array.from(match[2],Number)).map(boundary));
function measure(source,name) {
  const loadStart = performance.now(), B = load(source,`${name}-benchmark.js`), loadMs = performance.now()-loadStart;
  const rng = seeded(123456789), patterns = [], boards = [], recent = [], answers = new Set(), oriented = new Set(), topologies = new Set();
  const times = [], recentDistances = [], baseDistances = []; let logical = 0;
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now(), puzzle = B.generatePuzzle({rng,avoidSolutions:patterns,avoidBoards:boards,currentSolutions:patterns.slice(-2)});
    times.push(performance.now()-start);
    const key = B.solutionPattern(puzzle.solution), geometry = B.boardKey(puzzle.regions), transforms = variants(puzzle.regions);
    const masks = transforms.map(boundary), topology = transforms.map(normalize).sort()[0];
    if (logicalReference.solveLogically(puzzle.regions).solved) logical++;
    answers.add(key); oriented.add(geometry); topologies.add(topology);
    if (recent.length) recentDistances.push(Math.min(...recent.map(previous => Math.min(...masks.map(mask => popcount(mask ^ previous))))));
    baseDistances.push(Math.min(...baseMasks.map(mask => popcount(mask ^ masks[0]))));
    patterns.push(key); boards.push(geometry); recent.push(masks[0]);
    if (patterns.length>90) patterns.shift(); if (boards.length>90) boards.shift(); if (recent.length>90) recent.shift();
  }
  return {samples,loadMs:Number(loadMs.toFixed(3)),coldMs:Number(times[0].toFixed(3)),warmMs:summary(times.slice(1)),answers:answers.size,
    orientedGeometries:oriented.size,topologiesModuloD4:topologies.size,nonGuessLogicalProofs:logical,
    nearestPrevious90BoundaryEdits:summary(recentDistances),nearRecentAtMost4:recentDistances.filter(distance => distance<=4).length,
    nearestOriginalBaseBoundaryEdits:summary(baseDistances),nearOriginalBaseAtMost4:baseDistances.filter(distance => distance<=4).length};
}
const result = {node:process.version,seed:123456789,boundaryMetric:'Hamming distance over 60 internal grid edges; minimum over 8 rotations/reflections; labels ignored.'};
if (options.baseline) result.baseline = measure(baseSource,options.baseline);
result.current = measure(currentSource,'current');
console.log(JSON.stringify(result,null,2));
