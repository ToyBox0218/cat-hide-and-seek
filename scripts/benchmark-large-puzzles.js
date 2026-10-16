'use strict';
const {performance}=require('node:perf_hooks');
const Classic=require('../classic-engine.js');

function rng(seed){let value=seed>>>0;return()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)/4294967296;};}
function shuffle(values,random){for(let i=values.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[values[i],values[j]]=[values[j],values[i]];}return values;}
function solution(size,random){const result=[];function visit(row,used){if(row===size)return true;for(const col of shuffle([...Array(size).keys()],random)){if(used.has(col)||row&&Math.abs(result[row-1]-col)<=1)continue;result[row]=col;used.add(col);if(visit(row+1,used))return true;used.delete(col);}return false;}return visit(0,new Set())?result.map((col,row)=>row*size+col):null;}
function regionsFor(size,cats,random){const regions=Array(size*size).fill(-1);cats.forEach((cell,region)=>{regions[cell]=region;});let remaining=size*size-size;while(remaining){const options=[];for(let index=0;index<regions.length;index++){const region=regions[index];if(region<0)continue;const row=Math.floor(index/size),col=index%size;for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){const r=row+dr,c=col+dc,next=r*size+c;if(r>=0&&c>=0&&r<size&&c<size&&regions[next]<0)options.push({next,region,score:random()});}}if(!options.length)return null;options.sort((a,b)=>b.score-a.score);const choice=options[Math.floor(random()*Math.min(4,options.length))];regions[choice.next]=choice.region;remaining--;}return regions;}
function logical(puzzle){const cats=new Set(),crosses=new Set(),techniques={};for(let guard=0;guard<puzzle.size*puzzle.size*5&&cats.size<puzzle.size;guard++){const hint=Classic.nextHint(puzzle,{cats,crosses});if(!hint||hint.source!=='logic')break;(hint.kind==='cat'?cats:crosses).add(hint.index);techniques[hint.technique]=(techniques[hint.technique]||0)+1;}return{solved:cats.size===puzzle.size,cats:cats.size,techniques};}

const size=Number(process.argv[2]||12),target=Number(process.argv[3]||3),maxAttempts=Number(process.argv[4]||1000),started=performance.now(),accepted=[];let unique=0,maxValidationMs=0;
for(let attempt=1;attempt<=maxAttempts&&accepted.length<target;attempt++){
  const random=rng(0xC47A11+size*0x9e3779b1+attempt*2654435761),cats=solution(size,random),regions=cats&&regionsFor(size,cats,random);if(!regions)continue;
  const before=performance.now(),check=Classic.validate({size,regions}),validationMs=performance.now()-before;maxValidationMs=Math.max(maxValidationMs,validationMs);if(!check.valid)continue;unique++;
  const puzzle={size,regions,solution:check.solution},logic=logical(puzzle);if(!logic.solved)continue;
  accepted.push({attempt,validationMs:+validationMs.toFixed(1),techniques:logic.techniques});
}
console.log(JSON.stringify({size,target,accepted:accepted.length,unique,attempts:accepted.at(-1)?.attempt||maxAttempts,elapsedMs:+(performance.now()-started).toFixed(1),maxValidationMs:+maxValidationMs.toFixed(1),samples:accepted},null,2));
if(accepted.length<target)process.exitCode=2;
