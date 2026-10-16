#!/usr/bin/env node
'use strict';
const path=require('node:path'),crypto=require('node:crypto'),REPO=path.resolve(__dirname,'..'),rootArg=process.argv.find(item=>item.startsWith('--root=')),ROOT=rootArg?path.resolve(rootArg.slice(7)):REPO,Classic=require(path.join(REPO,'classic-engine.js')),levels=require(path.join(ROOT,'classic-levels.js')),manifest=require(path.join(ROOT,'classic-level-manifest.json'));

function argument(name,fallback){const value=process.argv.find(item=>item.startsWith(`--${name}=`));return value?Number(value.split('=')[1]):fallback;}
const start=Math.max(1,argument('start',1)),count=Math.max(1,argument('count',levels.length-start+1)),selected=levels.slice(start-1,start-1+count);
function normalize(values){const labels=new Map();let next=0;return values.map(value=>{if(!labels.has(value))labels.set(value,next++);return labels.get(value);}).join(',');}
function transform(size,index,flip,turn){let row=Math.floor(index/size),column=index%size;if(flip)column=size-1-column;for(let step=0;step<turn;step++)[row,column]=[column,size-1-row];return row*size+column;}
function canonical(puzzle){
  const variants=[];
  for(let flip=0;flip<2;flip++)for(let turn=0;turn<4;turn++){
    const regions=Array(puzzle.size*puzzle.size),fixed=[];
    for(let index=0;index<regions.length;index++)regions[transform(puzzle.size,index,flip,turn)]=puzzle.regions[index];
    for(const index of Classic.givens(puzzle))fixed.push(transform(puzzle.size,index,flip,turn));
    variants.push(`${normalize(regions)}|${fixed.sort((a,b)=>a-b).join(',')}`);
  }
  return `${puzzle.size}:${variants.sort()[0]}`;
}
function logicalReplay(level){
  const puzzle={size:level.size,regions:level.regions,givens:Classic.givens(level)},cats=new Set(),crosses=new Set(),techniques={};
  const fixed=puzzle.givens.length;
  for(let steps=0;steps<level.size*level.size*8&&cats.size+fixed<level.size;steps++){
    const hint=Classic.nextHint(puzzle,{cats,crosses});
    if(!hint)return{solved:false,steps,reason:'stuck',techniques};
    if(hint.source!=='logic'||!Number.isInteger(hint.index)||!(hint.related||[]).includes(hint.index))return{solved:false,steps,reason:'invalid hint',techniques};
    techniques[hint.technique]=(techniques[hint.technique]||0)+1;(hint.kind==='cat'?cats:crosses).add(hint.index);
  }
  const answer=[...puzzle.givens,...cats].sort((a,b)=>a-b);
  return{solved:answer.join(',')===level.solution.join(','),steps:Object.values(techniques).reduce((sum,value)=>sum+value,0),reason:answer.join(',')===level.solution.join(',')?'':'wrong result',techniques};
}
function stateHash(puzzle,cats,crosses){
  const state=JSON.stringify({size:puzzle.size,regions:puzzle.regions,cats:[...cats].sort((a,b)=>a-b),crosses:[...crosses].sort((a,b)=>a-b)});
  return crypto.createHash('sha256').update(state).digest('hex');
}
function verifyTrace(level,row){
  const trace=row?.actual?.trace;if(!Array.isArray(trace))return{valid:false,steps:0,reason:'missing trace'};
  const puzzle={size:level.size,regions:level.regions,givens:Classic.givens(level)},cats=new Set(),crosses=new Set(),depths=[];
  for(let offset=0;offset<trace.length;offset++){
    const entry=trace[offset],hint=Classic.nextHint(puzzle,{cats,crosses}),beforeHash=stateHash(puzzle,cats,crosses);
    if(!hint)return{valid:false,steps:offset,reason:'trace continues after logic stopped'};
    if(entry.step!==offset+1||entry.beforeHash!==beforeHash||entry.source!=='logic'||entry.technique!==hint.technique||entry.kind!==hint.kind||entry.index!==hint.index||entry.reason!==hint.text||JSON.stringify(entry.related)!==JSON.stringify(hint.related||[]))return{valid:false,steps:offset,reason:`step ${offset+1} does not replay`};
    if(!Array.isArray(entry.dependsOn)||entry.dependsOn.some(parent=>!Number.isInteger(parent)||parent<1||parent>=entry.step))return{valid:false,steps:offset,reason:`step ${offset+1} invalid dependency edge`};
    depths[offset]=entry.dependsOn.length?1+Math.max(...entry.dependsOn.map(parent=>depths[parent-1])):1;
    (entry.kind==='cat'?cats:crosses).add(entry.index);
    if(entry.afterHash!==stateHash(puzzle,cats,crosses))return{valid:false,steps:offset,reason:`step ${offset+1} afterHash mismatch`};
    if(offset&&trace[offset-1].afterHash!==entry.beforeHash)return{valid:false,steps:offset,reason:`step ${offset+1} hash chain mismatch`};
  }
  if(Math.max(0,...depths)!==row.actual.dependencyDepth)return{valid:false,steps:trace.length,reason:'dependency depth mismatch'};
  return{valid:cats.size+Classic.givens(level).length===level.size,steps:trace.length,reason:''};
}

const failures=[],canonicalOwners=new Map(),techniques={},sizes={},tiers={};let hintSteps=0,givens=0,tracedSteps=0,traceVerified=0;
for(const level of levels){const key=canonical(level);if(canonicalOwners.has(key))failures.push(`${level.id}: D4/recolor duplicate of ${canonicalOwners.get(key)}`);else canonicalOwners.set(key,level.id);}
for(const level of selected){
  const validation=Classic.validate(level);if(!validation.valid)failures.push(`${level.id}: ${validation.errors.join('; ')}`);
  const replay=logicalReplay(level);if(!replay.solved)failures.push(`${level.id}: logic replay ${replay.reason} after ${replay.steps} steps`);
  hintSteps+=replay.steps;givens+=Classic.givens(level).length;sizes[level.size]=(sizes[level.size]||0)+1;tiers[level.tier]=(tiers[level.tier]||0)+1;
  for(const [name,value] of Object.entries(replay.techniques))techniques[name]=(techniques[name]||0)+value;
  const row=manifest.levels.find(value=>value.id===level.id);if(row){const traced=verifyTrace(level,row);tracedSteps+=traced.steps;if(traced.valid)traceVerified++;else failures.push(`${level.id}: trace ${traced.reason}`);}
}
const selectedIds=new Set(selected.map(level=>level.id)),manifestRows=manifest.levels.filter(row=>selectedIds.has(row.id)),highestTechniques={},targetTechniques={},difficultyByTier={};
for(const row of manifestRows){highestTechniques[row.actual.highestTechnique]=(highestTechniques[row.actual.highestTechnique]||0)+1;targetTechniques[row.targetHighestTechnique]=(targetTechniques[row.targetHighestTechnique]||0)+1;(difficultyByTier[row.tier]??=[]).push(row.actual.score);}
const difficulty=Object.fromEntries(Object.entries(difficultyByTier).map(([tier,values])=>{values.sort((a,b)=>a-b);return[tier,{count:values.length,min:values[0],median:values[Math.floor(values.length/2)],max:values.at(-1)}];}));
const report={range:{start,count:selected.length,end:start+selected.length-1},packLevels:levels.length,validAndUnique:selected.length-failures.filter(item=>item.includes('expected one solution')||item.includes('invalid')||item.includes('disconnected')).length,logicalSolved:selected.length-failures.filter(item=>item.includes('logic replay')).length,d4RecolorUnique:canonicalOwners.size,givens,hintSteps,traceVerified,tracedSteps,sizes,tiers,highestTechniques,targetTechniques,difficulty,techniques,acceptanceGaps:manifest.levels.filter(row=>!Object.values(row.acceptance).every(Boolean)).map(row=>({id:row.id,acceptance:row.acceptance})),designAdjustments:manifest.designAdjustments||[],proofs:manifest.proofs||{},limitations:manifest.limitations||[],failures};
console.log(JSON.stringify(report,null,2));if(failures.length)process.exitCode=1;
