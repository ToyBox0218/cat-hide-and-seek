'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const repo=path.resolve(__dirname,'..'),sourceInput=process.argv[2]||process.env.CAT_LARGE_COHORT_SOURCE;
if(!sourceInput)throw new Error('Pass the reviewed cohort directory or set CAT_LARGE_COHORT_SOURCE.');
const sourceRoot=path.resolve(sourceInput),output=path.join(repo,'multiplayer-large-cohorts.json');
const manifest=JSON.parse(fs.readFileSync(path.join(sourceRoot,'cohort-manifest.json'),'utf8'));
const tierBySize={8:'advanced',10:'normal',12:'advanced'},matchedLoadBySize={8:.56,10:.4,12:.58},tiers={normal:[],advanced:[]},evidence=[];
for(const cohort of manifest.cohorts){
  if(!tierBySize[cohort.size])continue;
  const document=JSON.parse(fs.readFileSync(path.join(sourceRoot,cohort.file),'utf8')),tier=tierBySize[cohort.size],matchedLoad=matchedLoadBySize[cohort.size];
  if(document.cohortSize!==4||document.techniqueRank!==2||document.candidates.length!==4)throw new Error(`Unexpected cohort shape: ${cohort.file}`);
  for(const candidate of document.candidates){
    if(candidate.validation.status!=='UNIQUE'||!candidate.engineMetrics.solved)throw new Error(`Unverified large candidate: ${candidate.id}`);
    const regions=candidate.regions.flat(),fingerprint=crypto.createHash('sha256').update(JSON.stringify({size:candidate.size,regions,givens:[]})).digest('hex');
    tiers[tier].push({id:candidate.id,size:candidate.size,regions,solution:candidate.solution.slice(),givens:[],puzzleFingerprint:fingerprint,givensFingerprint:crypto.createHash('sha256').update('[]').digest('hex'),scoringEligible:true,highestTechnique:candidate.engineMetrics.highestTechnique,techniqueRank:candidate.engineMetrics.techniqueRank,reasoningLoad:matchedLoad,researchLoad:candidate.researchLoad,dependencyDepth:candidate.engineMetrics.dependencyDepth,morphologySignature:`research-${candidate.construction.family}-${candidate.construction.peelSignature}`,source:'large-board-research-cohort-20261016'});
  }
  evidence.push({size:cohort.size,tier,rank:cohort.rank,count:4,matchedReasoningLoad:matchedLoad,researchLoad:cohort.loadEvidence,minD4BoundaryDistance:cohort.minD4BoundaryDistance,minRhythmDistance:cohort.minRhythmDistance,sourceFile:cohort.file});
}
const sourceFiles=['cohort-manifest.json',...manifest.cohorts.map(cohort=>cohort.file),'test-results.json'];
const inheritedLimitations=manifest.limitations.filter(value=>!/not release approved until runtime, private-board and UI validation complete/i.test(value));
const releaseApproval={status:'APPROVED_FOR_INTEGRATED_MULTIPLAYER_RUNTIME',validatedAt:'2026-10-16',evidence:['artifacts/multiplayer-official-size8-final.json','artifacts/multiplayer-official-size10-final.json','artifacts/multiplayer-official-size12-final.json'],scope:'Integrated 1V1 Battle and four-player Survival runtime only.',trustModel:'Trusted-host authority. Guest snapshots and opponent UI expose aggregate progress only; no claim against DevTools or a malicious host.'};
const payload={schemaVersion:1,status:'RUNTIME_UI_VALIDATED_RELEASE_APPROVED',generatedFrom:path.basename(path.dirname(sourceRoot))+'/'+path.basename(sourceRoot),sourceSha256:Object.fromEntries(sourceFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,file))).digest('hex')])),releaseApproval,limitations:[...inheritedLimitations,'Each large size currently has exactly one four-board fairness cohort; do not describe it as a 20-board large-size pool.','Matched reasoningLoad is a cohort scheduling score. researchLoad preserves the within-size research percentile.','Approval applies only to the integrated runtime and does not turn these cohorts into a standalone broad large-board pool.'],evidence,tiers};
fs.writeFileSync(output,JSON.stringify(payload,null,2)+'\n');
console.log(JSON.stringify({output,counts:Object.fromEntries(Object.entries(tiers).map(([tier,levels])=>[tier,levels.length])),sizes:Object.fromEntries(Object.entries(tiers).map(([tier,levels])=>[tier,[...new Set(levels.map(level=>level.size))]]))},null,2));
