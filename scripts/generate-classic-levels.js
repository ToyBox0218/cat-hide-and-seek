'use strict';
const fs=require('node:fs'),path=require('node:path'),Classic=require('../classic-engine.js');
const OUTPUT=path.join(__dirname,'..','classic-levels.js'),POOL_TARGETS={4:120,5:240,6:600};

function rng(seed){let value=seed>>>0;return()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)/4294967296;};}
function shuffle(values,random){for(let i=values.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[values[i],values[j]]=[values[j],values[i]];}return values;}
function solution(size,random){
  const result=[];
  function visit(row,used){if(row===size)return true;for(const col of shuffle([...Array(size).keys()],random)){if(used.has(col)||row&&Math.abs(result[row-1]-col)<=1)continue;result[row]=col;used.add(col);if(visit(row+1,used))return true;used.delete(col);}return false;}
  return visit(0,new Set())?result.map((col,row)=>row*size+col):null;
}
function regionsFor(size,cats,random){
  const regions=Array(size*size).fill(-1);cats.forEach((cell,region)=>{regions[cell]=region;});
  let remaining=size*size-size,guard=0;
  while(remaining&&guard++<size*size*30){
    const region=Math.floor(random()*size),owned=[];for(let i=0;i<regions.length;i++)if(regions[i]===region)owned.push(i);
    const source=owned[Math.floor(random()*owned.length)],row=Math.floor(source/size),col=source%size;
    for(const[dr,dc]of shuffle([[-1,0],[1,0],[0,-1],[0,1]],random)){const r=row+dr,c=col+dc,index=r*size+c;if(r>=0&&c>=0&&r<size&&c<size&&regions[index]===-1){regions[index]=region;remaining--;break;}}
  }
  if(remaining){for(let i=0;i<regions.length;i++)if(regions[i]===-1){const row=Math.floor(i/size),col=i%size,n=[];for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){const r=row+dr,c=col+dc,j=r*size+c;if(r>=0&&c>=0&&r<size&&c<size&&regions[j]>=0)n.push(regions[j]);}if(!n.length)return null;regions[i]=n[Math.floor(random()*n.length)];}}
  return regions;
}
function normalized(values){const map=new Map();let next=0;return values.map(value=>{if(!map.has(value))map.set(value,next++);return map.get(value);}).join(',');}
function canonical(size,regions){
  const transforms=[];
  for(let flip=0;flip<2;flip++)for(let rotate=0;rotate<4;rotate++){
    const values=Array(size*size);for(let r=0;r<size;r++)for(let c=0;c<size;c++){let rr=r,cc=flip?size-1-c:c;for(let k=0;k<rotate;k++)[rr,cc]=[cc,size-1-rr];values[rr*size+cc]=regions[r*size+c];}transforms.push(normalized(values));
  }
  return `${size}:${transforms.sort()[0]}`;
}
function analyze(puzzle){
  const cats=new Set(),crosses=new Set(),counts={},trace=[];
  for(let guard=0;guard<puzzle.size*puzzle.size*5&&cats.size<puzzle.size;guard++){
    const hint=Classic.nextHint(puzzle,{cats,crosses});
    if(!hint||hint.kind==='error'||hint.source!=='logic')break;
    if(hint.kind==='cat')cats.add(hint.index);else crosses.add(hint.index);
    counts[hint.technique]=(counts[hint.technique]||0)+1;
    trace.push({technique:hint.technique,kind:hint.kind,index:hint.index});
  }
  const singles=Object.entries(counts).filter(([key])=>key.endsWith('-single')).reduce((sum,[,value])=>sum+value,0);
  const adjacent=counts.adjacent||0;
  const locked=Object.entries(counts).filter(([key])=>['region-row','region-column','row-region','column-region'].includes(key)).reduce((sum,[,value])=>sum+value,0);
  const subset2=Object.entries(counts).filter(([key])=>key.startsWith('subset-2-')).reduce((sum,[,value])=>sum+value,0);
  const subset3=Object.entries(counts).filter(([key])=>key.startsWith('subset-3-')).reduce((sum,[,value])=>sum+value,0);
  // No board-size constant and no solution-count term: score comes only from
  // the deductions actually used, with routine adjacency marking weighted low.
  const score=singles*.5+adjacent*.1+locked*1.5+subset2*4+subset3*7+trace.length/puzzle.size;
  return {solved:cats.size===puzzle.size,score:+score.toFixed(2),steps:trace.length,counts,trace};
}
function collect(size,target){
  const pool=[],seen=new Set();let attempt=0;
  while(pool.length<target&&attempt<1500000){
    attempt++;const random=rng(0xC47A11+size*0x9e3779b1+attempt*2654435761),cats=solution(size,random);if(!cats)continue;
    const regions=regionsFor(size,cats,random);if(!regions)continue;const check=Classic.validate({size,regions});if(!check.valid)continue;
    const key=canonical(size,regions);if(seen.has(key))continue;
    const metrics=analyze({size,regions,solution:check.solution});if(!metrics.solved)continue;
    seen.add(key);pool.push({size,regions,solution:check.solution,metrics});
    if(pool.length%50===0)console.log(`size ${size}: ${pool.length}/${target} after ${attempt} attempts`);
  }
  if(pool.length!==target)throw new Error(`Only generated ${pool.length}/${target} pure-logic size-${size} levels after ${attempt} attempts.`);
  return pool.sort((a,b)=>a.metrics.score-b.metrics.score||a.metrics.steps-b.metrics.steps);
}
function sample(values,start,end,count){
  const slice=values.slice(Math.floor(values.length*start),Math.ceil(values.length*end)),chosen=[];
  for(let i=0;i<count;i++)chosen.push(slice[Math.round(i*(slice.length-1)/Math.max(1,count-1))]);
  return chosen;
}

const pools={4:collect(4,POOL_TARGETS[4]),5:collect(5,POOL_TARGETS[5]),6:collect(6,POOL_TARGETS[6])};
const tiers=[
  sample(pools[4],0,.65,30),
  sample(pools[5],.1,.9,60),
  // The new 6×6 stage starts with a short reset, then samples the middle
  // difficulty band; later stages use disjoint, progressively harder bands.
  sample(pools[6],.25,.49,80),
  sample(pools[6],.50,.74,70),
  sample(pools[6],.75,1,60)
];
const levels=[];tiers.forEach((group,tierIndex)=>group.forEach(value=>levels.push({...value,id:`classic-${String(levels.length+1).padStart(3,'0')}`,tier:tierIndex+1})));
if(new Set(levels.map(level=>canonical(level.size,level.regions))).size!==300)throw new Error('Final selection contains an isomorphic duplicate.');
const payload=`/* Generated by scripts/generate-classic-levels.js. Do not hand edit. */\n(function(root,data){if(typeof module==='object'&&module.exports)module.exports=data;else root.CAT_CLASSIC_LEVELS=data;})(typeof globalThis!=='undefined'?globalThis:this,${JSON.stringify(levels)});\n`;
fs.writeFileSync(OUTPUT,payload);console.log(`wrote ${levels.length} pure-logic levels to ${OUTPUT}`);
