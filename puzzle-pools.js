/* Deterministic, version-locked multiplayer puzzle sequencing. */
(function(root,factory){
  const node=typeof module==='object'&&module.exports&&typeof require==='function';
  const api=factory(node?require('./multiplayer-levels.js'):root.CAT_MULTIPLAYER_POOLS,root);
  if(node)module.exports=api;else root.CatPuzzlePools=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(defaultCatalog,root){
  'use strict';
  const TIERS=Object.freeze(['beginner','normal','advanced','challenge']);
  function hash(text){let value=2166136261;for(let index=0;index<text.length;index++){value^=text.charCodeAt(index);value=Math.imul(value,16777619);}value+=value<<13;value^=value>>>7;value+=value<<3;value^=value>>>17;value+=value<<5;return value>>>0;}
  function rng(seed){let value=seed>>>0;return()=>{value+=0x6d2b79f5;let next=Math.imul(value^value>>>15,value|1);next^=next+Math.imul(next^next>>>7,next|61);return((next^next>>>14)>>>0)/0x100000000;};}
  function shuffle(values,seed){const result=values.slice(),random=rng(seed);for(let index=result.length-1;index>0;index--){const other=Math.floor(random()*(index+1));[result[index],result[other]]=[result[other],result[index]];}return result;}
  function validCatalog(catalog){
    if(!catalog||typeof catalog.packVersion!=='string'||typeof catalog.poolVersion!=='string'||!catalog.tiers)return false;
    return TIERS.every(tier=>Array.isArray(catalog.tiers[tier])&&catalog.tiers[tier].length>=16&&catalog.tiers[tier].every(level=>
      level&&level.scoringEligible===true&&Number.isInteger(level.size)&&level.size>=4&&level.size<=15&&Array.isArray(level.regions)&&level.regions.length===level.size*level.size&&
      Array.isArray(level.solution)&&level.solution.length===level.size&&Array.isArray(level.givens)&&level.givens.length===0&&
      Number.isInteger(level.techniqueRank)&&level.techniqueRank>=0&&level.techniqueRank<=4&&Number.isFinite(level.reasoningLoad)&&level.reasoningLoad>=0&&level.reasoningLoad<=1&&
      typeof level.id==='string'&&/^[a-f0-9]{64}$/.test(level.puzzleFingerprint)&&/^[a-f0-9]{64}$/.test(level.givensFingerprint)));
  }
  function create(options){
    options=options||{};const catalog=options.catalog||defaultCatalog||root?.CAT_MULTIPLAYER_POOLS;
    if(!validCatalog(catalog))throw new Error('Multiplayer puzzle catalog is unavailable or invalid.');
    const tier=String(options.tier||'normal');if(!TIERS.includes(tier))throw new Error(`Unknown multiplayer difficulty: ${tier}`);
    if(options.packVersion&&options.packVersion!==catalog.packVersion)throw new Error('Multiplayer puzzle pack version mismatch.');
    if(options.poolVersion&&options.poolVersion!==catalog.poolVersion)throw new Error('Multiplayer puzzle pool version mismatch.');
    const matchId=String(options.matchId||'');const roundSeed=String(options.roundSeed||'');
    if(!matchId||!roundSeed)throw new Error('A match ID and round seed are required for multiplayer puzzles.');
    const pool=catalog.tiers[tier],seedBase=[catalog.packVersion,catalog.poolVersion,tier,matchId,roundSeed].join('|'),orders=[];
    const groups=new Map();for(const level of pool){const key=`${level.size}:${level.techniqueRank}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(level);}
    const cohorts=[];for(const [key,values] of groups){values.sort((a,b)=>a.reasoningLoad-b.reasoningLoad||a.id.localeCompare(b.id));for(let offset=0;offset+3<values.length;offset+=4){const levels=values.slice(offset,offset+4);if(levels[3].reasoningLoad-levels[0].reasoningLoad<=0.25)cohorts.push({key,levels});}}
    if(!cohorts.length)throw new Error(`Multiplayer ${tier} pool has no four-board fairness cohort.`);
    function order(epoch){
      if(orders[epoch])return orders[epoch];
      let result=shuffle(cohorts,hash(`${seedBase}|${epoch}`));
      if(epoch&&result[0].key===order(epoch-1)[cohorts.length-1].key&&result.length>1)[result[0],result[1]]=[result[1],result[0]];
      orders[epoch]=result;return result;
    }
    function at(sequenceIndex,lane=0){
      if(!Number.isSafeInteger(sequenceIndex)||sequenceIndex<0)throw new Error('Puzzle sequence index must be a non-negative integer.');
      if(!Number.isInteger(lane)||lane<0||lane>3)throw new Error('Puzzle lane must be an integer from zero to three.');
      const epoch=Math.floor(sequenceIndex/cohorts.length),cursor=sequenceIndex%cohorts.length,cohort=order(epoch)[cursor];
      const laneOrder=shuffle([0,1,2,3],hash(`${seedBase}|${epoch}|${cursor}|lanes`)),level=cohort.levels[laneOrder[lane]];
      return Object.freeze({
        packVersion:catalog.packVersion,poolVersion:catalog.poolVersion,tier,epoch,cursor,lane,cohort:cohort.key,size:level.size,techniqueRank:level.techniqueRank,reasoningLoad:level.reasoningLoad,levelId:level.id,
        puzzleFingerprint:level.puzzleFingerprint,givensFingerprint:level.givensFingerprint,scoringEligible:true,
        puzzle:{id:`${level.id}:${epoch}:${cursor}`,size:level.size,regions:level.regions.slice(),solution:level.solution.slice(),givens:[]}
      });
    }
    function assertSelection(selection,lane=selection?.lane){
      if(!selection||selection.packVersion!==catalog.packVersion||selection.poolVersion!==catalog.poolVersion||selection.tier!==tier)return false;
      const expected=at(selection.epoch*cohorts.length+selection.cursor,lane);
      return selection.lane===expected.lane&&selection.cohort===expected.cohort&&selection.levelId===expected.levelId&&selection.puzzleFingerprint===expected.puzzleFingerprint&&selection.givensFingerprint===expected.givensFingerprint&&selection.scoringEligible===true;
    }
    return Object.freeze({packVersion:catalog.packVersion,poolVersion:catalog.poolVersion,tier,size:cohorts.length,at,assertSelection});
  }
  return Object.freeze({create,validCatalog,TIERS});
});
