'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Classic=require('../classic-engine.js'),manifest=require('../classic-level-manifest.json');
let levels;try{levels=require('../classic-levels.js');}catch{levels=[];}
test('all generated classic levels are connected and have exactly one solution',()=>{
  assert.equal(levels.length,300);
  for(const puzzle of levels){const result=Classic.validate(puzzle);assert.equal(result.valid,true,`${puzzle.id}: ${result.errors.join(', ')}`);assert.deepEqual(result.solution,puzzle.solution);}
});
test('original first 100 follow the blueprint allocation and retain reproducible logical traces',()=>{
  const campaign=levels.slice(0,100),groups=[1,2,3,4,5].map(tier=>campaign.filter(level=>level.tier===tier));
  assert.deepEqual(groups.map(group=>group.length),[10,20,20,25,25]);
  assert.deepEqual([4,5,6].map(size=>campaign.filter(level=>level.size===size).length),[6,24,70]);
  assert.deepEqual(campaign.map(level=>level.id),Array.from({length:100},(_,index)=>`classic-${String(index+1).padStart(3,'0')}`));
  assert.ok(campaign.every(level=>level.metrics.steps>=level.size));
  assert.ok(campaign.every(level=>level.metrics.trace.every(step=>step.technique!=='chain'&&step.technique!=='correction'&&Array.isArray(step.dependsOn)&&step.beforeHash&&step.afterHash)));
  assert.deepEqual([0,1,2,3,4].map(rank=>manifest.levels.find(row=>row.actual.techniqueRank===rank)?.level),[1,8,10,30,72]);
  assert.deepEqual(campaign.slice(0,10).map(level=>level.givens?.length||0),[2,1,1,1,1,1,1,1,1,1]);
  assert.ok(campaign.slice(0,10).every(level=>level.givenProvenance==='DESIGN_GIVEN'));
  assert.ok(manifest.levels.every(row=>Object.values(row.acceptance).every(Boolean)));
});
test('the 300 boards have no rotation, mirror or recolor-isomorphic duplicates and no dominant size template',()=>{
  function normalized(values){const map=new Map();let next=0;return values.map(value=>{if(!map.has(value))map.set(value,next++);return map.get(value);}).join(',');}
  function canonical(puzzle){const keys=[];for(let flip=0;flip<2;flip++)for(let rotate=0;rotate<4;rotate++){const values=Array(puzzle.size*puzzle.size);for(let r=0;r<puzzle.size;r++)for(let c=0;c<puzzle.size;c++){let rr=r,cc=flip?puzzle.size-1-c:c;for(let k=0;k<rotate;k++)[rr,cc]=[cc,puzzle.size-1-rr];values[rr*puzzle.size+cc]=puzzle.regions[r*puzzle.size+c];}keys.push(normalized(values));}return `${puzzle.size}:${keys.sort()[0]}`;}
  assert.equal(new Set(levels.map(canonical)).size,300);
  const signatures=new Map();for(const puzzle of levels){const signature=[...Array(puzzle.size)].map((_,region)=>puzzle.regions.filter(value=>value===region).length).sort((a,b)=>a-b).join('-');signatures.set(`${puzzle.size}:${signature}`,(signatures.get(`${puzzle.size}:${signature}`)||0)+1);}
  assert.ok(signatures.size>=150);assert.ok(Math.max(...signatures.values())<=10);
});
test('hint is valid for the current board and never forces a wrong cat',()=>{
  for(const puzzle of levels.filter((_,index)=>index%17===0)){const hint=Classic.nextHint(puzzle,{cats:new Set(),crosses:new Set()});assert.ok(hint);assert.equal(hint.source,'logic');if(hint.kind==='cat')assert.ok(puzzle.solution.includes(hint.index));if(hint.kind==='cross')assert.ok(!puzzle.solution.includes(hint.index));}
});
test('all 300 levels solve with explainable logic even when the stored answer is removed',()=>{
  for(const level of levels){
    const puzzle={size:level.size,regions:level.regions},cats=new Set(),crosses=new Set(),used=new Set();
    for(let guard=0;guard<level.size*level.size*5&&cats.size<level.size;guard++){
      const hint=Classic.nextHint(puzzle,{cats,crosses});assert.ok(hint,`${level.id} got stuck`);assert.equal(hint.source,'logic');assert.notEqual(hint.technique,'chain');assert.ok(hint.text.length>=8,`${level.id} ${hint.technique} lacks an explanation`);assert.ok(hint.related.includes(hint.index),`${level.id} ${hint.technique} does not highlight its target`);used.add(hint.technique);(hint.kind==='cat'?cats:crosses).add(hint.index);
    }
    assert.equal(cats.size,level.size,`${level.id} was not solved`);assert.deepEqual([...cats].sort((a,b)=>a-b),level.solution);
  }
});
test('answer repair is explicitly separated from ordinary deduction hints',()=>{
  const puzzle=levels[0],wrongCat=[...Array(puzzle.size*puzzle.size).keys()].find(index=>!puzzle.solution.includes(index));
  const repair=Classic.nextHint(puzzle,{cats:new Set([wrongCat]),crosses:new Set()});assert.equal(repair.source,'answer-check');assert.equal(repair.technique,'correction');assert.match(repair.text,/答案檢查/);
  const logic=Classic.nextHint(puzzle,{cats:new Set(),crosses:new Set()});assert.equal(logic.source,'logic');assert.doesNotMatch(logic.text,/答案檢查/);
});
test('givens are immutable puzzle constraints and ordinary hints solve around them',()=>{
  const base=levels[0],puzzle={...base,givens:[base.solution[0]]};
  assert.equal(Classic.validate(puzzle).valid,true);
  assert.equal(Classic.fingerprint(puzzle),Classic.fingerprint({...puzzle,givens:[base.solution[0],base.solution[0]]}));
  assert.notEqual(Classic.fingerprint(puzzle),Classic.fingerprint({...puzzle,givens:[base.solution[1]]}));
  const cats=new Set(),crosses=new Set();
  for(let guard=0;guard<base.size*base.size*5&&cats.size+puzzle.givens.length<base.size;guard++){
    const hint=Classic.nextHint({...puzzle,solution:undefined},{cats,crosses});
    assert.ok(hint,'given-based puzzle got stuck');assert.equal(hint.source,'logic');
    (hint.kind==='cat'?cats:crosses).add(hint.index);
  }
  assert.deepEqual([...puzzle.givens,...cats].sort((a,b)=>a-b),base.solution);
  assert.equal(cats.has(puzzle.givens[0]),false,'the given remains separate from player cats');
});
test('invalid, duplicate, out-of-range and conflicting givens are rejected',()=>{
  const base=levels[0],wrong=[...Array(base.size*base.size).keys()].find(index=>index!==base.solution[0]&&!Classic.validPlacement(base.size,base.regions,[base.solution[0]],index));
  for(const givens of ['bad',[base.solution[0],base.solution[0]],[-1],[base.size*base.size],[base.solution[0],wrong]]){
    assert.equal(Classic.validate({...base,givens}).valid,false,JSON.stringify(givens));
  }
});
