'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Classic=require('../classic-engine.js');
const OUTPUT=path.join(__dirname,'..','classic-levels.js'),MANIFEST=path.join(__dirname,'..','classic-level-manifest.json'),LOCAL_BLUEPRINT=path.join(__dirname,'..','classic-level-blueprint.json'),MULTIPLAYER_OUTPUT=path.join(__dirname,'..','multiplayer-levels.js'),MULTIPLAYER_MANIFEST=path.join(__dirname,'..','multiplayer-pool-manifest.json');
const POOL_TARGETS={4:180,5:720,6:900,7:180},GENERATOR_VERSION='classic-blueprint-v5',POOL_CACHE=path.join(__dirname,'..','artifacts','classic-v3-pool-cache.json');
const HANDOFF_BLUEPRINT=process.env.CAT_CLASSIC_HANDOFF_BLUEPRINT?path.resolve(process.env.CAT_CLASSIC_HANDOFF_BLUEPRINT):null;
const CALIBRATION_GUIDE=process.env.CAT_CLASSIC_CALIBRATION_GUIDE?path.resolve(process.env.CAT_CLASSIC_CALIBRATION_GUIDE):null;
const CALIBRATION_CACHE=process.env.CAT_CLASSIC_CALIBRATION_CACHE?path.resolve(process.env.CAT_CLASSIC_CALIBRATION_CACHE):null;
const auditedCalibrationPools=CALIBRATION_CACHE&&fs.existsSync(CALIBRATION_CACHE)?JSON.parse(fs.readFileSync(CALIBRATION_CACHE,'utf8')).pools:null;
const LARGE_COHORTS_PATH=path.join(__dirname,'..','multiplayer-large-cohorts.json'),largeCohorts=fs.existsSync(LARGE_COHORTS_PATH)?JSON.parse(fs.readFileSync(LARGE_COHORTS_PATH,'utf8')):null;
const selectionDiagnostics=[];
const dryRun=process.argv.includes('--dry-run');
const stagingArg=process.argv.find(value=>value.startsWith('--staging-dir=')),stagingDir=stagingArg?path.resolve(stagingArg.slice(14)):null,nonDestructive=dryRun||Boolean(stagingDir);
const probeLevels=new Set((process.argv.find(value=>value.startsWith('--probe='))?.slice(8)||'').split(',').filter(Boolean).map(Number).filter(Number.isInteger));
const allowCoreGaps=process.argv.includes('--allow-core-gaps');
const searchProbe=process.argv.includes('--search');
const searchLimit=Number(process.argv.find(value=>value.startsWith('--search-limit='))?.slice(15))||5000;

function rng(seed){let value=seed>>>0;return()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)/4294967296;};}
function shuffle(values,random){for(let i=values.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[values[i],values[j]]=[values[j],values[i]];}return values;}
function combinations(values,count,start=0,prefix=[],result=[]){if(prefix.length===count){result.push(prefix.slice());return result;}for(let index=start;index<=values.length-(count-prefix.length);index++){prefix.push(values[index]);combinations(values,count,index+1,prefix,result);prefix.pop();}return result;}
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
function connectedRegion(size,regions,region){const cells=regions.map((value,index)=>value===region?index:-1).filter(index=>index>=0);if(!cells.length)return false;const seen=new Set([cells[0]]),queue=[cells[0]];while(queue.length){const index=queue.shift(),row=Math.floor(index/size),col=index%size;for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){const r=row+dr,c=col+dc,next=r*size+c;if(r>=0&&c>=0&&r<size&&c<size&&regions[next]===region&&!seen.has(next)){seen.add(next);queue.push(next);}}}return seen.size===cells.length;}
function expandedRegionsFor(size,cats,random,kernel){
  if(kernel==='balanced')return regionsFor(size,cats,random);
  const regions=Array(size*size).fill(-1);cats.forEach((cell,region)=>{regions[cell]=region;});
  const target=kernel==='weighted'?Array.from({length:size},()=>.3+random()**2*2.7):Array(size).fill(size),sum=target.reduce((a,b)=>a+b,0);for(let i=0;i<size;i++)target[i]=Math.max(1,target[i]/sum*size*size);
  const direction=Array.from({length:size},()=>{const angle=random()*Math.PI*2;return[Math.sin(angle),Math.cos(angle)];}),counts=Array(size).fill(1);let remaining=size*size-size;
  while(remaining){const options=[];for(let index=0;index<regions.length;index++){const region=regions[index];if(region<0)continue;const row=Math.floor(index/size),col=index%size;for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){const r=row+dr,c=col+dc,next=r*size+c;if(r<0||c<0||r>=size||c>=size||regions[next]>=0)continue;const deficit=(target[region]-counts[region])/Math.max(1,target[region]),bias=kernel==='directional'?(dr*direction[region][0]+dc*direction[region][1])*.7:0;options.push({next,region,score:deficit+bias+random()*.35});}}
    if(!options.length)return null;options.sort((a,b)=>b.score-a.score);const choice=options[Math.floor(random()*Math.min(4,options.length))];regions[choice.next]=choice.region;counts[choice.region]++;remaining--;}
  if(kernel==='directional')for(let pass=0;pass<Math.max(2,Math.floor(size/2));pass++){const candidates=shuffle([...Array(size*size).keys()].filter(index=>!cats.includes(index)),random);for(const index of candidates){const row=Math.floor(index/size),col=index%size,source=regions[index],targets=shuffle([...new Set([[-1,0],[1,0],[0,-1],[0,1]].map(([dr,dc])=>{const r=row+dr,c=col+dc;return r>=0&&c>=0&&r<size&&c<size?regions[r*size+c]:source;}).filter(value=>value!==source))],random);let moved=false;for(const targetRegion of targets){regions[index]=targetRegion;if(connectedRegion(size,regions,source)&&connectedRegion(size,regions,targetRegion)){moved=true;break;}regions[index]=source;}if(moved)break;}}
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
function stateHash(puzzle,cats,crosses){
  const state=JSON.stringify({size:puzzle.size,regions:puzzle.regions,cats:[...cats].sort((a,b)=>a-b),crosses:[...crosses].sort((a,b)=>a-b)});
  return crypto.createHash('sha256').update(state).digest('hex');
}
function proofHints(puzzle,marks){return Classic.enumerateLogicalActions(puzzle,marks);
  const cats=new Set([...Classic.givens(puzzle),...(marks?.cats||[])]),crosses=new Set(marks?.crosses||[]),open=Classic.candidates(puzzle,{cats,crosses}),units=[],hints=[];
  const add=hint=>hints.push(hint),valueOf=(type,index)=>type==='row'?Math.floor(index/puzzle.size):type==='column'?index%puzzle.size:puzzle.regions[index];
  for(let value=0;value<puzzle.size;value++)for(const type of ['row','column','region'])units.push({type,value,cells:open.filter(index=>valueOf(type,index)===value),done:[...cats].some(index=>valueOf(type,index)===value)});
  for(const unit of units)if(!unit.done&&unit.cells.length===1)add({kind:'cat',index:unit.cells[0],technique:`${unit.type}-single`});
  for(const cat of cats){const row=Math.floor(cat/puzzle.size),col=cat%puzzle.size;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const r=row+dr,c=col+dc,index=r*puzzle.size+c;if((dr||dc)&&r>=0&&c>=0&&r<puzzle.size&&c<puzzle.size&&!cats.has(index)&&!crosses.has(index))add({kind:'cross',index,technique:'adjacent'});}}
  for(const unit of units.filter(value=>!value.done&&value.cells.length>1)){const rows=new Set(unit.cells.map(index=>Math.floor(index/puzzle.size))),cols=new Set(unit.cells.map(index=>index%puzzle.size));if(unit.type==='region'&&rows.size===1){const row=[...rows][0];for(const index of open)if(Math.floor(index/puzzle.size)===row&&puzzle.regions[index]!==unit.value)add({kind:'cross',index,technique:'region-row'});}if(unit.type==='region'&&cols.size===1){const col=[...cols][0];for(const index of open)if(index%puzzle.size===col&&puzzle.regions[index]!==unit.value)add({kind:'cross',index,technique:'region-column'});}}
  for(const unit of units.filter(value=>!value.done&&value.cells.length>1)){const members=new Set(unit.cells);for(const index of open)if(!members.has(index)&&unit.cells.every(candidate=>!Classic.validPlacement(puzzle.size,puzzle.regions,[candidate],index)))add({kind:'cross',index,technique:'common-conflict'});}
  for(const unit of units.filter(value=>!value.done&&value.cells.length>1&&value.type!=='region')){const regions=new Set(unit.cells.map(index=>puzzle.regions[index]));if(regions.size!==1)continue;const region=[...regions][0];for(const index of open)if(puzzle.regions[index]===region&&(unit.type==='row'?Math.floor(index/puzzle.size)!==unit.value:index%puzzle.size!==unit.value))add({kind:'cross',index,technique:`${unit.type}-region`});}
  const families={};for(const type of ['row','column','region'])families[type]=units.filter(unit=>unit.type===type&&!unit.done&&unit.cells.length);
  for(const sourceType of ['row','column','region'])for(const targetType of ['row','column','region'])if(sourceType!==targetType)for(const width of [2,3])for(const group of combinations(families[sourceType],width)){const targets=new Set(group.flatMap(unit=>unit.cells.map(index=>valueOf(targetType,index))));if(targets.size!==width)continue;const sources=new Set(group.map(unit=>unit.value));for(const index of open)if(targets.has(valueOf(targetType,index))&&!sources.has(valueOf(sourceType,index)))add({kind:'cross',index,technique:`subset-${width}-${sourceType}-${targetType}`});}
  const unique=new Map();for(const hint of hints){const key=`${hint.kind}:${hint.index}`;if(!unique.has(key))unique.set(key,hint);}return[...unique.values()];
}
function proofRank(technique){if(technique?.startsWith('subset-3-'))return 4;if(technique?.startsWith('subset-2-'))return 3;if(technique==='common-conflict')return 2;if(['region-row','region-column','row-region','column-region'].includes(technique))return 1;return 0;}
function openingMoves(puzzle){const hints=proofHints(puzzle,{cats:new Set(),crosses:new Set()});if(!hints.length)return[];const rank=Math.min(...hints.map(hint=>proofRank(hint.technique)));return hints.filter(hint=>proofRank(hint.technique)===rank);}
function marksWithout(trace,end,skip=-1){const cats=new Set(),crosses=new Set();for(let index=0;index<end;index++)if(index!==skip)(trace[index].kind==='cat'?cats:crosses).add(trace[index].index);return{cats,crosses};}
function addDependencies(puzzle,trace){
  const depths=[];
  for(let index=0;index<trace.length;index++){
    const step=trace[index],dependsOn=[];
    for(let prior=0;prior<index;prior++){
      const valid=proofHints(puzzle,marksWithout(trace,index,prior)).some(hint=>hint.technique===step.technique&&hint.kind===step.kind&&hint.index===step.index);
      if(!valid)dependsOn.push(prior+1);
    }
    step.dependsOn=dependsOn;depths[index]=dependsOn.length?1+Math.max(...dependsOn.map(value=>depths[value-1]||1)):1;
  }
  return depths.length?Math.max(...depths):0;
}
function analyze(puzzle){
  const cats=new Set(),crosses=new Set(),counts={},trace=[],eliminated=new Set();
  for(let guard=0;guard<puzzle.size*puzzle.size*5&&cats.size<puzzle.size;guard++){
    const beforeCandidates=new Set(Classic.candidates(puzzle,{cats,crosses}));
    const hint=Classic.nextHint(puzzle,{cats,crosses});
    if(!hint||hint.kind==='error'||hint.source!=='logic')break;
    const beforeHash=stateHash(puzzle,cats,crosses);
    if(hint.kind==='cat')cats.add(hint.index);else crosses.add(hint.index);
    const afterHash=stateHash(puzzle,cats,crosses);
    const afterCandidates=new Set(Classic.candidates(puzzle,{cats,crosses}));for(const cell of beforeCandidates)if(!afterCandidates.has(cell)&&!cats.has(cell))eliminated.add(cell);
    counts[hint.technique]=(counts[hint.technique]||0)+1;
    trace.push({step:trace.length+1,technique:hint.technique,kind:hint.kind,index:hint.index,related:(hint.related||[]).slice(),reason:hint.text,source:hint.source,beforeHash,afterHash});
  }
  const singles=Object.entries(counts).filter(([key])=>key.endsWith('-single')).reduce((sum,[,value])=>sum+value,0);
  const adjacent=counts.adjacent||0;
  const locked=Object.entries(counts).filter(([key])=>['region-row','region-column','row-region','column-region'].includes(key)).reduce((sum,[,value])=>sum+value,0);
  const conflict=counts['common-conflict']||0;
  const subset2=Object.entries(counts).filter(([key])=>key.startsWith('subset-2-')).reduce((sum,[,value])=>sum+value,0);
  const subset3=Object.entries(counts).filter(([key])=>key.startsWith('subset-3-')).reduce((sum,[,value])=>sum+value,0);
  // No board-size constant and no solution-count term: score comes only from
  // the deductions actually used, with routine adjacency marking weighted low.
  const highestTechnique=subset3?'SMALL_UNIT_SUBSET_3':subset2?'SMALL_UNIT_SUBSET_2':conflict?'COMMON_CONFLICT':locked?'UNIT_LOCK':'UNIT_SINGLE';
  const techniqueRank={UNIT_SINGLE:0,UNIT_LOCK:1,COMMON_CONFLICT:2,SMALL_UNIT_SUBSET_2:3,SMALL_UNIT_SUBSET_3:4}[highestTechnique];
  const score=singles*.5+adjacent*.1+locked*1.5+conflict*2.5+subset2*4+subset3*7+trace.length/puzzle.size;
  const solved=cats.size+Classic.givens(puzzle).length===puzzle.size,dependencyDepth=addDependencies(puzzle,trace),opening=openingMoves(puzzle),openingActions=proofHints(puzzle,{cats:new Set(),crosses:new Set()}),openingUniquePlacementCount=new Set(openingActions.filter(action=>action.kind==='cat').map(action=>action.index)).size,decisionOpening=openingActions.filter(action=>!action.housekeeping&&action.technique!=='adjacent'),openingDecisionRank=decisionOpening.length?Math.min(...decisionOpening.map(action=>proofRank(action.technique))):null,openingDecisions=decisionOpening.filter(action=>proofRank(action.technique)===openingDecisionRank),strategicActionCount=trace.filter(step=>step.kind==='cross'&&step.technique!=='adjacent').length,decisionStepCount=trace.filter(step=>step.technique!=='adjacent').length;
  // Terminal exclusions count every non-solution cell proved empty, including
  // cells already excluded by a tutorial given before the first recorded step.
  const effectiveEliminations=solved?puzzle.size*puzzle.size-puzzle.size:eliminated.size;
  return {solved,score:+score.toFixed(2),steps:trace.length,counts,trace,highestTechnique,techniqueRank,dependencyDepth,decisionStepCount,openingMoveCount:opening.length,openingMoves:opening,openingUniquePlacementCount,openingDecisionCount:new Set(openingDecisions.map(action=>`${action.kind}:${action.index}`)).size,openingTechniqueSet:[...new Set(openingDecisions.map(action=>action.technique))],effectiveEliminations,strategicActionCount};
}
function collect(size,target){
  const pool=[],seen=new Set();let attempt=0;
  while(pool.length<target&&attempt<1500000){
    attempt++;const random=rng(0xC47A11+size*0x9e3779b1+attempt*2654435761),cats=solution(size,random);if(!cats)continue;
    const kernel=['balanced','weighted','directional'][attempt%3],regions=expandedRegionsFor(size,cats,random,kernel);if(!regions)continue;const check=Classic.validate({size,regions});if(!check.valid)continue;
    const key=canonical(size,regions);if(seen.has(key))continue;
    const metrics=analyze({size,regions,solution:check.solution});if(!metrics.solved)continue;
    seen.add(key);pool.push({size,regions,solution:check.solution,metrics,kernel,seed:0xC47A11+size*0x9e3779b1+attempt*2654435761,candidateOrdinal:attempt,canonicalTopologyHash:crypto.createHash('sha256').update(key).digest('hex')});
    if(pool.length%50===0)console.log(`size ${size}: ${pool.length}/${target} after ${attempt} attempts`);
  }
  if(pool.length!==target)throw new Error(`Only generated ${pool.length}/${target} pure-logic size-${size} levels after ${attempt} attempts.`);
  return pool.sort((a,b)=>a.metrics.score-b.metrics.score||a.metrics.steps-b.metrics.steps);
}
function boundary(size,regions){const bits=[];for(let row=0;row<size;row++)for(let col=0;col<size-1;col++)bits.push(+(regions[row*size+col]!==regions[row*size+col+1]));for(let row=0;row<size-1;row++)for(let col=0;col<size;col++)bits.push(+(regions[row*size+col]!==regions[(row+1)*size+col]));return bits;}
function boundaryVariants(puzzle){const values=[];for(let flip=0;flip<2;flip++)for(let rotate=0;rotate<4;rotate++){const transformed=Array(puzzle.size*puzzle.size);for(let row=0;row<puzzle.size;row++)for(let col=0;col<puzzle.size;col++){let rr=row,cc=flip?puzzle.size-1-col:col;for(let step=0;step<rotate;step++)[rr,cc]=[cc,puzzle.size-1-rr];transformed[rr*puzzle.size+cc]=puzzle.regions[row*puzzle.size+col];}values.push(boundary(puzzle.size,transformed));}return values;}
function boundaryDistance(left,right){let best=Infinity;for(const a of left)for(const b of right){let distance=0;for(let i=0;i<a.length;i++)distance+=a[i]!==b[i];best=Math.min(best,distance);}return best;}
function geometry(puzzle){
  const edges=boundary(puzzle.size,puzzle.regions),areas=[],compactness=[],elongations=[];let junctions=0;
  for(let region=0;region<puzzle.size;region++){const cells=puzzle.regions.map((value,index)=>value===region?index:-1).filter(index=>index>=0),rows=cells.map(index=>Math.floor(index/puzzle.size)),cols=cells.map(index=>index%puzzle.size),height=Math.max(...rows)-Math.min(...rows)+1,width=Math.max(...cols)-Math.min(...cols)+1;areas.push(cells.length);compactness.push(cells.length/(width*height));elongations.push(Math.max(width/height,height/width));}
  for(let row=0;row<puzzle.size-1;row++)for(let col=0;col<puzzle.size-1;col++)if(new Set([puzzle.regions[row*puzzle.size+col],puzzle.regions[row*puzzle.size+col+1],puzzle.regions[(row+1)*puzzle.size+col],puzzle.regions[(row+1)*puzzle.size+col+1]]).size>=3)junctions++;
  const boundaryEdges=edges.reduce((sum,value)=>sum+value,0),boundaryDensity=boundaryEdges/(2*puzzle.size*(puzzle.size-1)),mean=areas.reduce((a,b)=>a+b,0)/areas.length,areaImbalance=(Math.max(...areas)-Math.min(...areas))/mean,meanCompactness=compactness.reduce((a,b)=>a+b,0)/compactness.length,maxElongation=Math.max(...elongations),junctionDensity=junctions/((puzzle.size-1)**2);
  const shapeFamily=maxElongation>=3||meanCompactness<.62?'shallow-ribbon':junctionDensity>=.3&&boundaryDensity>=.5?'stair-step':areaImbalance<=.8&&meanCompactness>=.78?'balanced-block':junctionDensity<=.16&&maxElongation<=2?'soft-corner':areaImbalance>=1.3&&meanCompactness>=.72&&maxElongation<=2.5?'offset-block':'compact-blob';
  const complexity=boundaryDensity*.35+Math.min(1,areaImbalance/1.5)*.2+(1-meanCompactness)*.2+Math.min(1,(maxElongation-1)/3)*.15+junctionDensity*.1,geometryBand=complexity<.44?'G1':complexity<.53?'G2':'G3';
  return{boundaryEdges,boundaryDensity:+boundaryDensity.toFixed(4),areaImbalance:+areaImbalance.toFixed(4),meanCompactness:+meanCompactness.toFixed(4),maxElongation:+maxElongation.toFixed(4),junctionCount:junctions,junctionDensity:+junctionDensity.toFixed(4),complexity:+complexity.toFixed(4),geometryBand,shapeFamily,areaHistogram:areas.slice().sort((a,b)=>a-b)};
}
function desiredPercent(row){const roles={reset:.08,teach:.16,'guided-practice':.24,practice:.38,climb:.55,relief:.22,recall:.42,challenge:.74,consolidate:.62,milestone:.9};return roles[row.beatRole]??.5;}
function distantSet(pool,count,size){
  const candidates=pool.filter(value=>value.metrics.techniqueRank===0&&!retainedCanonical.has(canonical(value.size,value.regions))),threshold=Math.ceil(.15*2*size*(size-1));
  candidates.forEach(value=>value.boundaryVariants??=boundaryVariants(value));const cache=new Map(),far=(a,b)=>{const key=a.candidateOrdinal<b.candidateOrdinal?`${a.candidateOrdinal}:${b.candidateOrdinal}`:`${b.candidateOrdinal}:${a.candidateOrdinal}`;if(!cache.has(key))cache.set(key,boundaryDistance(a.boundaryVariants,b.boundaryVariants)>threshold);return cache.get(key);};
  let best=[];for(let attempt=0;attempt<12000&&best.length<count;attempt++){const order=shuffle(candidates.slice(),rng(0x51e7+attempt*2654435761)),chosen=[];for(const value of order)if(chosen.every(other=>far(value,other))){chosen.push(value);if(chosen.length===count)break;}if(chosen.length>best.length)best=chosen;}
  if(best.length<count){const ordered=candidates.slice().sort((a,b)=>candidates.filter(value=>far(b,value)).length-candidates.filter(value=>far(a,value)).length);let answer=null,nodes=0;const visit=(chosen,available)=>{if(answer||++nodes>2000000)return;if(chosen.length===count){answer=chosen;return}if(chosen.length+available.length<count)return;for(let index=0;index<available.length&&!answer;index++){const value=available[index],next=available.slice(index+1).filter(other=>far(value,other));visit(chosen.concat(value),next);}};visit([],ordered);if(answer)best=answer;}
  if(best.length<count)throw new Error(`Only found ${best.length}/${count} pairwise-distant size-${size} boards.`);return new Set(best);
}
function maximumClique(pool,size,rank=0){
  const candidates=pool.filter(value=>value.metrics.techniqueRank===rank&&!retainedCanonical.has(canonical(value.size,value.regions)));
  const threshold=Math.ceil(.15*2*size*(size-1));
  candidates.forEach(value=>value.boundaryVariants??=boundaryVariants(value));
  const adjacent=candidates.map((left,i)=>candidates.map((right,j)=>i!==j&&boundaryDistance(left.boundaryVariants,right.boundaryVariants)>threshold));
  let best=[];
  function expand(clique,vertices){
    if(clique.length+vertices.length<=best.length)return;
    if(!vertices.length){if(clique.length>best.length)best=clique.slice();return;}
    while(vertices.length&&clique.length+vertices.length>best.length){
      const vertex=vertices.pop(),next=vertices.filter(other=>adjacent[vertex][other]);
      expand(clique.concat(vertex),next);
      if(clique.length+vertices.length<=best.length)return;
    }
    if(clique.length>best.length)best=clique.slice();
  }
  expand([],candidates.map((_,index)=>index));
  return {maximum:best.length,candidateCount:candidates.length,threshold,ordinals:best.map(index=>candidates[index].candidateOrdinal)};
}
function compatibleSet(pool,size,rank,target){
  const candidates=pool.filter(value=>value.metrics.techniqueRank===rank&&!retainedCanonical.has(canonical(value.size,value.regions))),threshold=Math.ceil(.15*2*size*(size-1));candidates.forEach(value=>value.boundaryVariants??=boundaryVariants(value));let best=[];
  for(let attempt=0;attempt<30&&best.length<target;attempt++){const order=shuffle(candidates.slice(),rng(0xC11C0+attempt*2654435761)),chosen=[];for(const value of order)if(chosen.every(other=>boundaryDistance(value.boundaryVariants,other.boundaryVariants)>threshold)){chosen.push(value);if(chosen.length===target)break;}if(chosen.length>best.length)best=chosen;}
  return{count:best.length,target,candidateCount:candidates.length,threshold,candidates:best};
}
function exactCompatibleSubset(candidates,target){
  if(target<=0)return{candidates:[],nodes:1};const values=candidates.slice(),size=values[0]?.size||6,threshold=Math.ceil(.15*2*size*(size-1));values.forEach(value=>value.boundaryVariants??=boundaryVariants(value));let nodes=0,best=[];
  function visit(chosen,remaining){nodes++;if(chosen.length>best.length)best=chosen.slice();if(best.length>=target||chosen.length+remaining.length<=best.length)return;for(let index=0;index<remaining.length;index++){const value=remaining[index];if(chosen.every(other=>boundaryDistance(value.boundaryVariants,other.boundaryVariants)>threshold))visit(chosen.concat(value),remaining.slice(index+1).filter(other=>boundaryDistance(value.boundaryVariants,other.boundaryVariants)>threshold));if(best.length>=target)return;}}
  visit([],values);return{candidates:best,nodes};
}
function readBlueprint(){const source=HANDOFF_BLUEPRINT;if(!fs.existsSync(source))throw new Error('Classic v2 blueprint not found.');const document=JSON.parse(fs.readFileSync(source,'utf8'));return{document,levels:document.levels,source};}
function rangeDistance(value,min,max){return value<min?min-value:value>max?value-max:0;}
function coreMetricGate(value,row){const m=value.metrics;return m.techniqueRank===row.targetTechniqueRank&&m.dependencyDepth>=row.targetDependencyDepthMin&&m.dependencyDepth<=row.targetDependencyDepthMax&&m.openingMoveCount>=row.targetOpeningMoveCountMin&&m.openingMoveCount<=row.targetOpeningMoveCountMax&&m.effectiveEliminations===row.expectedTerminalExcludedCells&&m.strategicActionCount>=row.targetStrategicActionMin&&m.strategicActionCount<=row.targetStrategicActionMax;}
function coreMetricLoss(value,row){const m=value.metrics;return Math.abs(m.techniqueRank-row.targetTechniqueRank)*100+rangeDistance(m.dependencyDepth,row.targetDependencyDepthMin,row.targetDependencyDepthMax)*12+rangeDistance(m.openingMoveCount,row.targetOpeningMoveCountMin,row.targetOpeningMoveCountMax)*10+rangeDistance(m.strategicActionCount,row.targetStrategicActionMin,row.targetStrategicActionMax)*4+Math.abs(m.effectiveEliminations-row.expectedTerminalExcludedCells)*20;}
function metricGate(value,row){const g=geometry(value);return coreMetricGate(value,row)&&g.geometryBand===row.geometryBand&&g.shapeFamily===row.shapeFamily;}
function tutorialVariants(value,row){
  const count=row.givenCount||0;if(!count)return[value];
  value.givenVariants??={};if(!value.givenVariants[count])value.givenVariants[count]=combinations(value.solution,count).map(givens=>{const puzzle={size:value.size,regions:value.regions,solution:value.solution,givens},metrics=analyze(puzzle);return{...value,givens,metrics,sourceCandidate:value};});
  return value.givenVariants[count];
}

function ecdf(value,values){if(values.length<=1)return.5;let below=0,equal=0;for(const item of values){if(item<value)below++;else if(item===value)equal++;}return(below+(equal-1)/2)/(values.length-1);}
function median(values){const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:.5;}
function bucketKey(value){return`${value.size}:${value.metrics.techniqueRank}:${(value.givens||[]).length}`;}
const MORPH_FEATURES=['boundaryDensity','areaImbalance','meanCompactness','maxElongation','junctionDensity'];
function calibrateCandidates(candidates,geometryPool){
  const byBucket=new Map();for(const value of candidates){const key=bucketKey(value);if(!byBucket.has(key))byBucket.set(key,[]);byBucket.get(key).push(value);}
  // Keep v3 percentile windows anchored to the audited calibration population.
  // Search-only boundary mutations may enter selection, but must not move the
  // percentile scale they are being measured against.
  const size=geometryPool[0]?.size,calibrationPool=auditedCalibrationPools?.[size]||geometryPool.filter(value=>(value.candidateOrdinal??Infinity)<1000000),calibrationSet=new Set(calibrationPool.map(value=>value.canonicalTopologyHash));
  const calibrationBuckets=new Map();for(const value of calibrationPool){const key=bucketKey(value);if(!calibrationBuckets.has(key))calibrationBuckets.set(key,[]);calibrationBuckets.get(key).push(value);}
  const geometryValues=Object.fromEntries(MORPH_FEATURES.map(feature=>[feature,calibrationPool.map(value=>(value.actualGeometry??=geometry(value))[feature])]));
  for(const values of byBucket.values()){
    const basis=calibrationBuckets.get(bucketKey(values[0]))||values,distributions={depth:basis.map(value=>value.metrics.dependencyDepth),decision:basis.map(value=>value.metrics.decisionStepCount),strategic:basis.map(value=>value.metrics.strategicActionCount)};
    const percentile=(metric,distribution,isReference)=>{if(isReference)return ecdf(metric,distribution);let below=0,equal=0;for(const item of distribution){if(item<metric)below++;else if(item===metric)equal++;}return Math.max(0,Math.min(1,(below+equal*.5)/distribution.length));};
    for(const value of values){const g=value.actualGeometry??=geometry(value),source=value.sourceCandidate||value,isReference=calibrationSet.has(source.canonicalTopologyHash),components=[percentile(value.metrics.dependencyDepth,distributions.depth,isReference),percentile(value.metrics.decisionStepCount,distributions.decision,isReference),percentile(value.metrics.strategicActionCount,distributions.strategic,isReference)].filter((component,index)=>new Set(Object.values(distributions)[index]).size>1);value.reasoningLoad=median(components);value.morphology=Object.fromEntries(MORPH_FEATURES.map(feature=>[feature,percentile(g[feature],geometryValues[feature],isReference)]));value.morphologySignature=[g.areaImbalance,g.meanCompactness,g.maxElongation].map((metric,index)=>{const feature=['areaImbalance','meanCompactness','maxElongation'][index],p=percentile(metric,geometryValues[feature],isReference);return Math.min(2,Math.floor(p*3));}).join('-');}
  }
  return byBucket;
}
function tutorialGate(value,row){
  const m=value.metrics,decisions=m.trace.filter(step=>step.technique!=='adjacent'),spec=row.tutorialSpec;if(!spec||m.techniqueRank!==row.targetTechniqueRank||(value.givens||[]).length!==spec.givenCount||value.reasoningLoad>(row.level===10?.85:.75))return false;
  const openingRange=spec.openingUniquePlacements||spec.openingDecisionCount,openingValue=spec.openingUniquePlacements?m.openingUniquePlacementCount:m.openingDecisionCount;if(openingRange&&(openingValue<openingRange[0]||openingValue>openingRange[1]))return false;
  const rankNames={UNIT_LOCK:['region-row','region-column','row-region','column-region'],COMMON_CONFLICT:['common-conflict']},techniques=rankNames[spec.highestTechnique]||[];
  if(spec.requiredTechniqueOccurrencesMin&&(decisions.filter(step=>techniques.includes(step.technique)).length<spec.requiredTechniqueOccurrencesMin))return false;
  if(spec.requiredByDecisionStep){if(spec.learningObjective==='row-one-cat'&&decisions[0]?.technique!=='row-single')return false;if(spec.learningObjective==='column-one-cat'&&decisions[0]?.technique!=='column-single')return false;if(spec.learningObjective==='region-one-cat'&&decisions[0]?.technique!=='region-single')return false;if(spec.learningObjective==='eight-neighbor-exclusion'&&!m.trace.slice(0,8).some(step=>step.technique==='adjacent'))return false;if(techniques.length&&!decisions.slice(0,spec.requiredByDecisionStep).some(step=>techniques.includes(step.technique)))return false;}
  if(spec.requiredUnitFamilies){const families=new Set(decisions.filter(step=>step.technique.endsWith('-single')).map(step=>step.technique.split('-')[0]));if(families.size<spec.requiredUnitFamilies)return false;}
  return true;
}
function morphologyDistance(left,right){return Math.sqrt(MORPH_FEATURES.reduce((sum,feature)=>sum+(left.morphology[feature]-right.morphology[feature])**2,0));}
function multiplayerTier(value,cutoffs={beginnerLockCutoff:.25,normalConflictCutoff:.45,advancedSubset2Cutoff:.65}){const rank=value.metrics.techniqueRank,load=value.reasoningLoad;if(rank===0||rank===1&&load<=cutoffs.beginnerLockCutoff)return'beginner';if(rank===1||rank===2&&load<=cutoffs.normalConflictCutoff)return'normal';if(rank===2||rank===3&&load<=cutoffs.advancedSubset2Cutoff)return'advanced';return'challenge';}
function selectMultiplayerTier(candidates,count,already,seed,requireTwoSizes){
  const threshold=value=>Math.ceil(.15*2*value.size*(value.size-1)),compatible=(value,chosen)=>{value.boundaryVariants??=boundaryVariants(value);return already.concat(chosen).filter(other=>other.size===value.size).every(other=>{other.boundaryVariants??=boundaryVariants(other);return boundaryDistance(value.boundaryVariants,other.boundaryVariants)>threshold(value);});};let best=[];
  for(let attempt=0;attempt<800&&best.length<count;attempt++){const random=rng(seed+attempt*2654435761),order=shuffle(candidates.slice(),random),chosen=[];if(requireTwoSizes){for(const size of [...new Set(candidates.map(value=>value.size))].slice(0,2)){const value=order.find(item=>item.size===size&&compatible(item,chosen));if(value)chosen.push(value);}}
    for(const value of order)if(!chosen.includes(value)&&compatible(value,chosen)){chosen.push(value);if(chosen.length===count)break;}if(chosen.length>best.length)best=chosen;}
  return best;
}
function closestFairCohort(candidates,already,allowedSizes){
  let best=null;const buckets=new Map();for(const value of candidates)if(allowedSizes.includes(value.size)){const key=`${value.size}:${value.metrics.techniqueRank}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(value);}
  for(const values of buckets.values()){values.sort((a,b)=>a.reasoningLoad-b.reasoningLoad);for(let start=0;start+3<values.length;start++){const group=values.slice(start,start+4),span=group[3].reasoningLoad-group[0].reasoningLoad,chosen=selectMultiplayerTier(group,4,already,0xFA17,false);if(chosen.length===4&&(!best||span<best.span))best={values:chosen,span};}}
  return best?.values||[];
}
function buildMultiplayerCatalog(candidates,pack){
  const cutoffs={beginnerLockCutoff:.25,normalConflictCutoff:.45,advancedSubset2Cutoff:.65},groups={beginner:[],normal:[],advanced:[],challenge:[]};for(const value of candidates)if(value.size>=4&&value.size<=7&&!(value.givens||[]).length&&!retainedCanonical.has(canonical(value.size,value.regions)))groups[multiplayerTier(value,cutoffs)].push(value);
  const extraSizes={beginner:[4,5],normal:[5,7],advanced:[7],challenge:[7]},order=['challenge','advanced','normal','beginner'],selected={},used=[];for(const tier of order){const extra=closestFairCohort(groups[tier],used,extraSizes[tier]),base=selectMultiplayerTier(groups[tier].filter(value=>value.size===6),16,used.concat(extra),0xD1FF1C+tier.length*991,false),chosen=base.concat(extra);if(base.length<16||extra.length<4)throw new Error(`Multiplayer ${tier} lacks a 16-board 6x6 base plus one four-board mixed-size fairness cohort.`);selected[tier]=chosen;used.push(...chosen);}
  const poolVersion='multiplayer-v5-private-large-cohorts-1',encode=value=>{const canonicalHash=crypto.createHash('sha256').update(canonical(value.size,value.regions)).digest('hex'),fingerprint=crypto.createHash('sha256').update(JSON.stringify({size:value.size,regions:value.regions,givens:[]})).digest('hex');return{id:`mp-${canonicalHash.slice(0,16)}`,size:value.size,regions:value.regions,solution:value.solution,givens:[],puzzleFingerprint:fingerprint,givensFingerprint:crypto.createHash('sha256').update('[]').digest('hex'),scoringEligible:true,highestTechnique:value.metrics.highestTechnique,techniqueRank:value.metrics.techniqueRank,reasoningLoad:+value.reasoningLoad.toFixed(6),morphologySignature:value.morphologySignature};};
  const tiers=Object.fromEntries(Object.entries(selected).map(([tier,values])=>[tier,values.map(encode)]));
  if(largeCohorts)for(const[tier,levels]of Object.entries(largeCohorts.tiers||{})){if(!tiers[tier])throw new Error(`Unknown large-cohort tier: ${tier}`);tiers[tier].push(...levels.map(level=>({...level,regions:level.regions.slice(),solution:level.solution.slice(),givens:[]})));}
  const supply=Object.fromEntries(Object.entries(groups).map(([tier,values])=>[tier,{eligible:values.length,selected:tiers[tier].length,sizes:Object.fromEntries([...new Set(tiers[tier].map(value=>value.size))].sort((a,b)=>a-b).map(size=>[size,tiers[tier].filter(value=>value.size===size).length]))}]));return{schemaVersion:1,status:'RELEASE_APPROVED_WITH_DISCLOSED_LIMITATIONS',packVersion:pack.id,poolVersion,cutoffs,hardMinimum:16,releaseTarget:20,tiers,supply,releaseApproval:largeCohorts?.releaseApproval||null,largeCohorts:largeCohorts?{status:largeCohorts.status,releaseApproval:largeCohorts.releaseApproval,evidence:largeCohorts.evidence,limitations:largeCohorts.limitations,sourceSha256:largeCohorts.sourceSha256}:null};
}
function readV3Blueprint(){
  if(!fs.existsSync(CALIBRATION_GUIDE))throw new Error('Classic v3 calibration guide not found.');const guide=JSON.parse(fs.readFileSync(CALIBRATION_GUIDE,'utf8')),legacy=JSON.parse(fs.readFileSync(HANDOFF_BLUEPRINT,'utf8')),tutorial=new Map(guide.tutorialException.levelsSpec.map(row=>[row.level,row])),rank={UNIT_SINGLE:0,UNIT_LOCK:1,COMMON_CONFLICT:2,SMALL_UNIT_SUBSET_2:3,SMALL_UNIT_SUBSET_3:4},windows=guide.difficultyCalibration.beatPercentileWindowsAfterTutorial;
  const levels=legacy.levels.map(row=>{const spec=tutorial.get(row.level),beatRole=row.level===11?'challenge':row.beatRole,highestTechnique=row.level===11?'UNIT_LOCK':spec?.highestTechnique??row.targetHighestTechnique;return{...row,size:spec?.size??row.size,targetHighestTechnique:highestTechnique,targetTechniqueRank:rank[highestTechnique],givenCount:spec?.givenCount||0,beatRole,tutorialSpec:spec||null,reasoningLoadWindow:spec?[0,row.level===10?.85:.75]:(row.level===11?[.7,.9]:windows[beatRole]||[.2,.8])};});
  return{document:{...guide,levels},levels,source:CALIBRATION_GUIDE};
}
function farFromRetained(value){
  if(typeof value.farFromRetained==='boolean')return value.farFromRetained;
  value.boundaryVariants??=boundaryVariants(value);const threshold=Math.ceil(.15*2*value.size*(value.size-1));
  return value.farFromRetained=retainedLevels.filter(level=>level.size===value.size).every(level=>{level.boundaryVariants??=boundaryVariants(level);return boundaryDistance(value.boundaryVariants,level.boundaryVariants)>threshold;});
}
function rowGate(value,row){if(!farFromRetained(value)||value.metrics.techniqueRank!==row.targetTechniqueRank)return false;if(row.tutorialSpec)return tutorialGate(value,row);return !(value.givens||[]).length&&value.reasoningLoad>=row.reasoningLoadWindow[0]&&value.reasoningLoad<=row.reasoningLoadWindow[1];}
function selectGlobal(rows,rowCandidates){
  const pairCache=new Map(),all=[...new Set([...rowCandidates.values()].flat())];all.forEach((value,index)=>value.selectionId=index);
  const pairCompatible=(left,right)=>{if(left.size!==right.size)return true;const key=left.selectionId<right.selectionId?`${left.selectionId}:${right.selectionId}`:`${right.selectionId}:${left.selectionId}`;if(!pairCache.has(key)){left.boundaryVariants??=boundaryVariants(left);right.boundaryVariants??=boundaryVariants(right);pairCache.set(key,boundaryDistance(left.boundaryVariants,right.boundaryVariants)>Math.ceil(.15*2*left.size*(left.size-1)));}return pairCache.get(key);};
  let totalNodes=0,furthest=0,blocked={};
  for(let attempt=0;attempt<60;attempt++){
    let attemptNodes=0;const assigned=new Map(),used=new Set(),random=rng(0x610BA1+attempt*2654435761),order=rows.slice().sort((a,b)=>rowCandidates.get(a.level).length-rowCandidates.get(b.level).length||random()-.5);
    const compatible=(row,value)=>{const key=canonical(value.size,value.regions);if(used.has(key)||[...assigned.values()].some(other=>!pairCompatible(value,other)))return false;const signatures=[row.level-2,row.level-1,row.level,row.level+1,row.level+2].map(level=>level===row.level?value.morphologySignature:assigned.get(level)?.morphologySignature);for(let index=0;index+2<signatures.length;index++)if(signatures[index]&&signatures[index]===signatures[index+1]&&signatures[index]===signatures[index+2])return false;return true;};
    function visit(position){
      attemptNodes++;totalNodes++;if(attemptNodes>50000)return false;furthest=Math.max(furthest,position);if(assigned.size===order.length)return true;
      let row=null,eligible=null;
      for(const candidateRow of order){if(assigned.has(candidateRow.level))continue;const values=rowCandidates.get(candidateRow.level).filter(value=>compatible(candidateRow,value));if(!eligible||values.length<eligible.length){row=candidateRow;eligible=values;if(!values.length)break;}}
      if(!eligible.length){blocked[`${row.level}:${row.size}:${row.targetTechniqueRank}`]=(blocked[`${row.level}:${row.size}:${row.targetTechniqueRank}`]||0)+1;return false;}
      const chosen=[...assigned.values()].filter(value=>value.size===row.size),midpoint=(row.reasoningLoadWindow[0]+row.reasoningLoadWindow[1])/2;
      eligible=eligible.map(value=>({value,noise:random()})).sort((a,b)=>{const novelA=chosen.length?Math.min(...chosen.map(value=>morphologyDistance(a.value,value))):2,novelB=chosen.length?Math.min(...chosen.map(value=>morphologyDistance(b.value,value))):2;return novelB-novelA||Math.abs(a.value.reasoningLoad-midpoint)-Math.abs(b.value.reasoningLoad-midpoint)||a.noise-b.noise;});
      for(const {value} of eligible.slice(0,24)){const key=canonical(value.size,value.regions);assigned.set(row.level,value);used.add(key);if(visit(position+1))return true;assigned.delete(row.level);used.delete(key);}return false;
    }
    if(visit(0))return{selected:rows.map(row=>assigned.get(row.level)),nodes:totalNodes,attempts:attempt+1};
  }
  throw new Error(`Global selection failed after ${totalNodes} bounded backtracking nodes; furthest=${furthest}/${rows.length}; blocked=${JSON.stringify(Object.entries(blocked).sort((a,b)=>b[1]-a[1]).slice(0,12))}`);
}
function candidateKey(value){return `${canonical(value.size,value.regions)}:g:${(value.givens||[]).join(',')}`;}
function localMutations(value){
  const result=[],size=value.size,catCells=new Set(value.solution),seen=new Set();
  for(let index=0;index<value.regions.length;index++){
    if(catCells.has(index))continue;
    const row=Math.floor(index/size),col=index%size,source=value.regions[index],targets=new Set();
    for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){const r=row+dr,c=col+dc;if(r>=0&&c>=0&&r<size&&c<size&&value.regions[r*size+c]!==source)targets.add(value.regions[r*size+c]);}
    for(const target of targets){const regions=value.regions.slice();regions[index]=target;const key=canonical(size,regions);if(seen.has(key)||retainedCanonical.has(key))continue;seen.add(key);const puzzle={size,regions,solution:value.solution,...(value.givens?{givens:value.givens}: {})},check=Classic.validate(puzzle);if(!check.valid)continue;const metrics=analyze(puzzle);if(!metrics.solved)continue;result.push({...value,regions,solution:check.solution,metrics,sourceCandidate:null,canonicalTopologyHash:crypto.createHash('sha256').update(key).digest('hex')});}
  }
  return result;
}
function searchForCore(pool,row,limit=searchLimit){
  const started=Date.now(),initial=pool.flatMap(value=>tutorialVariants(value,row)).filter(value=>!retainedCanonical.has(canonical(value.size,value.regions))).sort((a,b)=>coreMetricLoss(a,row)-coreMetricLoss(b,row)).slice(0,24),visited=new Set(initial.map(candidateKey));
  let beam=initial.slice(0,12),best=beam[0],evaluated=0,generations=0;
  while(beam.length&&evaluated<limit){
    generations++;const next=[];
    for(const parent of beam){
      for(const value of localMutations(parent)){const key=candidateKey(value);if(visited.has(key))continue;visited.add(key);evaluated++;if(coreMetricLoss(value,row)<coreMetricLoss(best,row))best=value;if(coreMetricGate(value,row))return{candidate:value,evaluated,generations,milliseconds:Date.now()-started};next.push(value);if(evaluated>=limit)break;}
      if(evaluated>=limit)break;
    }
    next.sort((a,b)=>coreMetricLoss(a,row)-coreMetricLoss(b,row)||Math.abs(a.metrics.score-best.metrics.score)-Math.abs(b.metrics.score-best.metrics.score));
    // Keep the strongest candidates plus a deterministic spread so the search
    // can cross a short plateau without weakening any acceptance criterion.
    beam=next.slice(0,16);for(let index=20;index<next.length&&beam.length<24;index+=Math.max(1,Math.floor(next.length/8)))beam.push(next[index]);
  }
  return{candidate:null,best,evaluated,generations,milliseconds:Date.now()-started};
}
function expandRankCoverage(pool,size,rank,minimum,maxEvaluations=5000){
  const started=Date.now(),seen=new Set(pool.map(candidateKey)),accepted=pool.filter(value=>value.metrics.techniqueRank===rank&&!retainedCanonical.has(canonical(value.size,value.regions))),frontier=pool.filter(value=>value.metrics.techniqueRank===rank-1).sort((a,b)=>b.metrics.strategicActionCount-a.metrics.strategicActionCount).slice(0,120);let cursor=0,evaluated=0,compatible=compatibleSet(pool,size,rank,minimum);
  while(compatible.count<minimum&&cursor<frontier.length&&evaluated<maxEvaluations){const parent=frontier[cursor++];for(const value of localMutations(parent)){const key=candidateKey(value);if(seen.has(key))continue;seen.add(key);evaluated++;value.kernel='directional-boundary-mutation';value.candidateOrdinal=1000000+evaluated;if(value.metrics.techniqueRank===rank&&!retainedCanonical.has(canonical(value.size,value.regions))){pool.push(value);accepted.push(value);if(frontier.length<1600)frontier.push(value);if(accepted.length%10===0)compatible=compatibleSet(pool,size,rank,minimum);if(accepted.length%10===0)console.log(`size ${size} rank ${rank}: ${accepted.length} candidates, compatible set ${compatible.count}/${minimum}, after ${evaluated} mutations`);}else if(value.metrics.techniqueRank===rank-1&&frontier.length<1600)frontier.push(value);if(compatible.count>=minimum||evaluated>=maxEvaluations)break;}}
  compatible=compatibleSet(pool,size,rank,minimum);
  console.log(`rank coverage size ${size} rank ${rank}: ${accepted.length} candidates, compatible ${compatible.count}/${minimum}; evaluated ${evaluated}; ${Date.now()-started} ms`);return{accepted:accepted.length,compatible:compatible.count,evaluated,milliseconds:Date.now()-started};
}
function expandWindowCoverage(pool,rows,maxEvaluations=10000){
  const grouped=new Map();for(const row of rows.filter(row=>row.targetTechniqueRank===4&&!row.tutorialSpec)){const key=row.reasoningLoadWindow.join(':');if(!grouped.has(key))grouped.set(key,{row,demand:0});grouped.get(key).demand++;}const targets=[...grouped.values()].map(target=>({...target,minimum:target.demand}));let evaluated=0;
  const refresh=()=>{calibrateCandidates(pool,pool);return targets.map(target=>({...target,choices:rowGateChoices(target.row)}));},rowGateChoices=row=>pool.filter(value=>rowGate(value,row)),compatible=entry=>exactCompatibleSubset(entry.choices,entry.minimum).candidates;
  let status=refresh();
  while(status.some(entry=>compatible(entry).length<entry.minimum)&&evaluated<maxEvaluations){
    const blocked=status.filter(entry=>compatible(entry).length<entry.minimum),parents=[...new Set(blocked.flatMap(entry=>entry.choices.concat(pool.filter(value=>value.metrics.techniqueRank===4).sort((a,b)=>rangeDistance(a.reasoningLoad,...entry.row.reasoningLoadWindow)-rangeDistance(b.reasoningLoad,...entry.row.reasoningLoadWindow)).slice(0,20))))];let added=0;
    for(const parent of parents)for(const value of localMutations(parent)){evaluated++;if(value.metrics.techniqueRank===4&&!retainedCanonical.has(canonical(value.size,value.regions))&&!pool.some(item=>candidateKey(item)===candidateKey(value))){value.kernel='targeted-window-mutation';value.candidateOrdinal=2000000+evaluated;pool.push(value);added++;}if(evaluated>=maxEvaluations||added>=40)break;if(evaluated>=maxEvaluations||added>=40)break;}
    if(!added)break;status=refresh();console.log(`rank 4 window coverage: ${status.map(entry=>`${entry.row.reasoningLoadWindow.join('-')}=${compatible(entry).length}/${entry.minimum}`).join(', ')} after ${evaluated} mutations`);
  }
  if(status.some(entry=>compatible(entry).length<entry.minimum)){
    const seen=new Set(pool.map(candidateKey));let randomAccepted=0;
    for(let attempt=1;attempt<=200000&&status.some(entry=>compatible(entry).length<entry.minimum);attempt++){
      const random=rng(0xF04D11+attempt*2654435761),cats=solution(6,random),kernel=['balanced','weighted','directional'][attempt%3],regions=cats&&expandedRegionsFor(6,cats,random,kernel);if(!regions)continue;const key=canonical(6,regions);if(seen.has(`${key}:g:`)||retainedCanonical.has(key))continue;const check=Classic.validate({size:6,regions});if(!check.valid)continue;const metrics=analyze({size:6,regions,solution:check.solution});if(!metrics.solved||metrics.techniqueRank!==4)continue;const value={size:6,regions,solution:check.solution,metrics,kernel:`window-random-${kernel}`,seed:0xF04D11+attempt*2654435761,candidateOrdinal:3000000+attempt,canonicalTopologyHash:crypto.createHash('sha256').update(key).digest('hex')};seen.add(candidateKey(value));pool.push(value);randomAccepted++;
      if(randomAccepted%5===0){status=refresh();console.log(`rank 4 random window coverage: ${status.map(entry=>`${entry.row.reasoningLoadWindow.join('-')}=${compatible(entry).length}/${entry.minimum}`).join(', ')} after ${attempt} random attempts`);}
    }
    status=refresh();
  }
  const result=status.map(entry=>({window:entry.row.reasoningLoadWindow,demand:entry.demand,minimum:entry.minimum,eligible:entry.choices.length,compatible:compatible(entry).length}));if(result.some(entry=>entry.compatible<entry.minimum))throw new Error(`Rank-4 window coverage failed: ${JSON.stringify(result)}`);return{evaluated,windows:result};
}
function select(pool,row,used,selected,actualSize=row.size){
  const variants=pool.flatMap(value=>tutorialVariants(value,row)),eligible=value=>!used.has(value.sourceCandidate||value)&&!retainedCanonical.has(canonical(value.size,value.regions)),gated=variants.filter(value=>eligible(value)&&metricGate(value,row)),coreGated=variants.filter(value=>eligible(value)&&coreMetricGate(value,row)),all=variants.filter(eligible),choices=gated.length?gated:coreGated.length?coreGated:all;
  const target=(pool.length-1)*desiredPercent(row),ordered=choices.slice().sort((a,b)=>coreMetricLoss(a,row)-coreMetricLoss(b,row)||Math.abs(pool.indexOf(a.sourceCandidate||a)-target)-Math.abs(pool.indexOf(b.sourceCandidate||b)-target));
  const threshold=Math.ceil(.15*2*actualSize*(actualSize-1));
  const variation=value=>{const family=(value.actualGeometry??=geometry(value)).shapeFamily,priorFamilies=selected.slice(-4).map(other=>(other.actualGeometry??=geometry(other)).shapeFamily);if(priorFamilies.slice(-2).every(other=>other===family))return false;if(priorFamilies.length===4&&new Set(priorFamilies.concat(family)).size<3)return false;const pattern=value.solution.map(cell=>cell%value.size).join(''),recent=selected.filter(other=>other.size===value.size).slice(-9);return recent.filter(other=>other.solution.map(cell=>cell%other.size).join('')===pattern).length<2;};
  const far=ordered.filter(value=>{const variants=value.boundaryVariants||(value.boundaryVariants=boundaryVariants(value));return variation(value)&&selected.filter(other=>other.size===value.size).every(other=>boundaryDistance(variants,other.boundaryVariants)>threshold);});
  selectionDiagnostics.push({id:row.id,eligible:all.length,exactGate:gated.length,coreGate:coreGated.length,bestCoreLoss:ordered.length?coreMetricLoss(ordered[0],row):null,farWithinChosenPool:far.length,usedGeometryFallback:gated.length===0&&coreGated.length>0,usedCoreFallback:coreGated.length===0});
  if(!coreGated.length&&!allowCoreGaps)throw new Error(`${row.id} has no candidate satisfying technique/dependency/opening/terminal/strategic constraints; best core loss ${ordered.length?coreMetricLoss(ordered[0],row):'n/a'}.`);
  return far[0]||ordered[0];
}

const previous=require('../classic-levels.js'),retainedLevels=previous.slice(100),retainedCanonical=new Set(retainedLevels.map(level=>canonical(level.size,level.regions))),blueprint=readV3Blueprint(),neededSizes=probeLevels.size?new Set(blueprint.levels.filter(row=>probeLevels.has(row.level)).map(row=>row.size)):new Set([4,5,6,7]);
let cached=null;if(!process.argv.includes('--fresh')&&fs.existsSync(POOL_CACHE)){const value=JSON.parse(fs.readFileSync(POOL_CACHE,'utf8'));if(value.generatorVersion===GENERATOR_VERSION)cached=value.pools;}
let cacheChanged=!cached;const pools=Object.fromEntries([...neededSizes].map(size=>{const target=POOL_TARGETS[size],stored=cached?.[size];if(Array.isArray(stored)&&stored.length>=target)return[size,stored];cacheChanged=true;return[size,collect(size,target)];}));
if(cacheChanged&&!nonDestructive){const merged={...(cached||{}),...pools};fs.mkdirSync(path.dirname(POOL_CACHE),{recursive:true});fs.writeFileSync(POOL_CACHE,JSON.stringify({generatorVersion:GENERATOR_VERSION,pools:merged}));}
for(const pool of Object.values(pools))pool.sort((a,b)=>a.metrics.score-b.metrics.score||a.metrics.steps-b.metrics.steps);
const multiplayerOnly=process.argv.includes('--multiplayer-only'),rank3Coverage=pools[6]&&!multiplayerOnly?expandRankCoverage(pools[6],6,3,70,20000):null;
const rankCoverage=pools[6]&&!multiplayerOnly?expandRankCoverage(pools[6],6,4,35,10000):null;
const rank4WindowCoverage=pools[6]&&!multiplayerOnly?expandWindowCoverage(pools[6],blueprint.levels,400):null;
if(!nonDestructive&&rankCoverage&&rankCoverage.compatible>=35&&rank3Coverage&&rank3Coverage.compatible>=70)fs.writeFileSync(POOL_CACHE,JSON.stringify({generatorVersion:GENERATOR_VERSION,pools:{...(cached||{}),...pools}}));
const candidatesBySize={};
for(const size of neededSizes){const base=pools[size],counts=new Set(blueprint.levels.filter(row=>row.size===size&&row.givenCount).map(row=>row.givenCount)),all=base.slice();for(const count of counts)for(const value of base)all.push(...tutorialVariants(value,{givenCount:count}));const unique=[...new Map(all.map(value=>[candidateKey(value),value])).values()];calibrateCandidates(unique,base);candidatesBySize[size]=unique;}
if(process.argv.includes('--multiplayer-only')){
  const pack={id:'classic-original-100-v3-preserve-101-300',schema:3,generatorVersion:GENERATOR_VERSION},multiplayer=buildMultiplayerCatalog(Object.values(candidatesBySize).flat(),pack);
  const payload=`/* Generated by scripts/generate-classic-levels.js. */\n(function(root,data){if(typeof module==='object'&&module.exports)module.exports=data;else root.CAT_MULTIPLAYER_POOLS=data;})(typeof globalThis!=='undefined'?globalThis:this,${JSON.stringify(multiplayer)});\n`;
  fs.writeFileSync(MULTIPLAYER_OUTPUT,payload);fs.writeFileSync(MULTIPLAYER_MANIFEST,JSON.stringify(multiplayer,null,2)+'\n');
  const sizes=Object.fromEntries(Object.entries(multiplayer.tiers).map(([tier,levels])=>[tier,[...new Set(levels.map(level=>level.size))]]));
  console.log(JSON.stringify({poolVersion:multiplayer.poolVersion,supply:multiplayer.supply,sizes}));process.exit(0);
}
const activeRows=probeLevels.size?blueprint.levels.filter(row=>probeLevels.has(row.level)):blueprint.levels;
const rowCandidates=new Map(activeRows.map(row=>[row.level,candidatesBySize[row.size].filter(value=>rowGate(value,row))]));
const bucketDemand=new Map();for(const row of activeRows){const key=`${row.size}:${row.targetTechniqueRank}:${row.givenCount}`;bucketDemand.set(key,(bucketDemand.get(key)||0)+1);}
const preflight={rows:activeRows.map(row=>({level:row.level,eligible:rowCandidates.get(row.level).length,bucket:`${row.size}:${row.targetTechniqueRank}:${row.givenCount}`})),buckets:[]};
for(const[key,demand]of bucketDemand){const available=candidatesBySize[Number(key.split(':')[0])].filter(value=>bucketKey(value)===key&&!retainedCanonical.has(canonical(value.size,value.regions))).length,required=demand+Math.max(3,Math.ceil(demand*.25));preflight.buckets.push({key,demand,available,required,passed:available>=required});}
const failedRows=preflight.rows.filter(row=>row.eligible<2),failedBuckets=preflight.buckets.filter(row=>!row.passed);
if(probeLevels.size){for(const row of activeRows){const values=rowCandidates.get(row.level),bucketValues=candidatesBySize[row.size].filter(value=>bucketKey(value)===`${row.size}:${row.targetTechniqueRank}:${row.givenCount}`&&!retainedCanonical.has(canonical(value.size,value.regions))),sample=values.slice().sort((a,b)=>a.reasoningLoad-b.reasoningLoad)[Math.floor(values.length/2)];console.log(JSON.stringify({level:row.level,eligible:values.length,bucket:`${row.size}:${row.targetTechniqueRank}:${row.givenCount}`,window:row.reasoningLoadWindow,bucketCount:bucketValues.length,bucketLoads:[...new Set(bucketValues.map(value=>+value.reasoningLoad.toFixed(3)))].sort((a,b)=>a-b),sample:sample&&{kernel:sample.kernel,givens:sample.givens||[],reasoningLoad:+sample.reasoningLoad.toFixed(3),depth:sample.metrics.dependencyDepth,decisionSteps:sample.metrics.decisionStepCount,strategic:sample.metrics.strategicActionCount,openingUnique:sample.metrics.openingUniquePlacementCount,openingDecision:sample.metrics.openingDecisionCount,signature:sample.morphologySignature}}));}console.log(JSON.stringify({preflight:{failedRows,failedBuckets}}));process.exit(failedRows.length||failedBuckets.length?2:0);}
if(failedRows.length||failedBuckets.length)throw new Error(`V3 preflight failed: rows=${JSON.stringify(failedRows)}, buckets=${JSON.stringify(failedBuckets)}`);
const global=selectGlobal(activeRows,rowCandidates),selected=global.selected,manifest=[];
for(let offset=0;offset<activeRows.length;offset++){const row=activeRows[offset],candidate=selected[offset],actualGeometry=geometry(candidate),m=candidate.metrics,level={size:candidate.size,regions:candidate.regions,solution:candidate.solution,...(candidate.givens?.length?{givens:candidate.givens,givenProvenance:'DESIGN_GIVEN'}:{}),metrics:m,id:row.id,tier:row.tier},threshold=Math.ceil(.15*2*candidate.size*(candidate.size-1)),near=selected.filter(item=>item!==candidate&&item.size===candidate.size).every(item=>{candidate.boundaryVariants??=boundaryVariants(candidate);item.boundaryVariants??=boundaryVariants(item);return boundaryDistance(candidate.boundaryVariants,item.boundaryVariants)>threshold;}),acceptance={validAndUnique:Classic.validate(level).valid,noGuess:m.solved,techniqueTargetMet:m.techniqueRank===row.targetTechniqueRank,givenCountMet:(candidate.givens||[]).length===row.givenCount,tutorialObjectiveMet:row.tutorialSpec?tutorialGate(candidate,row):true,reasoningLoadWindowMet:row.tutorialSpec?candidate.reasoningLoad<=row.reasoningLoadWindow[1]:candidate.reasoningLoad>=row.reasoningLoadWindow[0]&&candidate.reasoningLoad<=row.reasoningLoadWindow[1],nearDuplicateDistanceMet:near};manifest.push({...row,generatorVersion:GENERATOR_VERSION,kernel:candidate.kernel,seed:candidate.seed>>>0,candidateOrdinal:candidate.candidateOrdinal,canonicalTopologyHash:candidate.canonicalTopologyHash,boundaryFingerprint:boundary(candidate.size,candidate.regions).join(''),actual:{size:candidate.size,givenCount:(candidate.givens||[]).length,givenProvenance:candidate.givens?.length?'DESIGN_GIVEN':null,highestTechnique:m.highestTechnique,techniqueRank:m.techniqueRank,steps:m.steps,decisionStepCount:m.decisionStepCount,score:m.score,dependencyDepth:m.dependencyDepth,reasoningLoad:candidate.reasoningLoad,openingUniquePlacementCount:m.openingUniquePlacementCount,openingDecisionCount:m.openingDecisionCount,openingTechniqueSet:m.openingTechniqueSet,effectiveEliminations:m.effectiveEliminations,strategicActionCount:m.strategicActionCount,morphologySignature:candidate.morphologySignature,morphologyPercentiles:candidate.morphology,...actualGeometry,trace:m.trace},acceptance});}
const first100=selected.map((candidate,index)=>({size:candidate.size,regions:candidate.regions,solution:candidate.solution,...(candidate.givens?.length?{givens:candidate.givens,givenProvenance:'DESIGN_GIVEN'}:{}),metrics:candidate.metrics,id:activeRows[index].id,tier:activeRows[index].tier})),levels=first100.concat(previous.slice(100));
if(levels.length!==300)throw new Error(`Expected 300 levels after preserving 101-300, got ${levels.length}`);
if(new Set(levels.map(level=>canonical(level.size,level.regions))).size!==300)throw new Error('Final 300 contain an isomorphic duplicate.');
const pack={id:'classic-original-100-v3-preserve-101-300',schema:3,generatorVersion:GENERATOR_VERSION};
const multiplayer=buildMultiplayerCatalog(Object.values(candidatesBySize).flat(),pack),multiplayerPayload=`/* Generated by scripts/generate-classic-levels.js. */\n(function(root,data){if(typeof module==='object'&&module.exports)module.exports=data;else root.CAT_MULTIPLAYER_POOLS=data;})(typeof globalThis!=='undefined'?globalThis:this,${JSON.stringify(multiplayer)});\n`;
const payload=`/* Generated by scripts/generate-classic-levels.js. Do not hand edit. */\n(function(root,data,pack){if(typeof module==='object'&&module.exports)module.exports=data;else{root.CAT_CLASSIC_LEVELS=data;root.CAT_CLASSIC_PACK=pack;}})(typeof globalThis!=='undefined'?globalThis:this,${JSON.stringify(levels)},${JSON.stringify(pack)});\n`;
const manifestPayload={schemaVersion:4,pack,generatorVersion:GENERATOR_VERSION,blueprintSource:path.basename(blueprint.source),poolTargets:POOL_TARGETS,preflight,rank3Coverage,rankCoverage,rank4WindowCoverage,globalSelection:{algorithm:'most-constrained bounded backtracking with originality, near-copy and consecutive-signature constraints',nodes:global.nodes,attempts:global.attempts},multiplayerPools:{poolVersion:multiplayer.poolVersion,supply:multiplayer.supply},limitations:['competitor canonical matrices/hashes were not supplied in the handoff, so competitor exact/near-copy comparison remains unverified','dependency parents use the shared logical-action API and counterfactual validation; explicit premise-to-fact ownership remains conservative'],levels:manifest};
if(dryRun){const misses=manifest.filter(row=>!Object.values(row.acceptance).every(Boolean));console.log(JSON.stringify({dryRun:true,levels:levels.length,v3Accepted:manifest.length-misses.length,acceptanceGaps:misses.map(row=>row.level),preserved:levels.length-100,globalSelection:{nodes:global.nodes,attempts:global.attempts},rank3Coverage,rankCoverage,rank4WindowCoverage,multiplayerSupply:multiplayer.supply},null,2));process.exit(misses.length?2:0);}
if(stagingDir){fs.mkdirSync(stagingDir,{recursive:true});fs.writeFileSync(path.join(stagingDir,'classic-levels.js'),payload);fs.writeFileSync(path.join(stagingDir,'multiplayer-levels.js'),multiplayerPayload);fs.writeFileSync(path.join(stagingDir,'multiplayer-pool-manifest.json'),JSON.stringify(multiplayer,null,2)+'\n');fs.writeFileSync(path.join(stagingDir,'classic-level-blueprint.json'),JSON.stringify(blueprint.document,null,2)+'\n');fs.writeFileSync(path.join(stagingDir,'classic-level-manifest.json'),JSON.stringify(manifestPayload,null,2)+'\n');console.log(JSON.stringify({stagingDir,levels:levels.length,v3Accepted:manifest.filter(row=>Object.values(row.acceptance).every(Boolean)).length,globalSelection:manifestPayload.globalSelection},null,2));process.exit(0);}
fs.writeFileSync(OUTPUT,payload);fs.writeFileSync(MULTIPLAYER_OUTPUT,multiplayerPayload);fs.writeFileSync(MULTIPLAYER_MANIFEST,JSON.stringify(multiplayer,null,2)+'\n');fs.writeFileSync(LOCAL_BLUEPRINT,JSON.stringify(blueprint.document,null,2)+'\n');fs.writeFileSync(MANIFEST,JSON.stringify(manifestPayload,null,2)+'\n');
const misses=manifest.filter(row=>!Object.values(row.acceptance).every(Boolean));if(misses.length)throw new Error(`Generated pack has ${misses.length} v3 acceptance gaps.`);console.log(`wrote ${levels.length} levels; v3 accepted 100/100; preserved 101-300; global search nodes ${global.nodes}`);
