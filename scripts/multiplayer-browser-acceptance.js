'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const endpoint=process.argv[2]||'http://127.0.0.1:9444',pageUrl=process.argv[3]||'http://127.0.0.1:3010/?multiplayer-browser-test=1',reportPath=path.resolve(process.argv[4]||'artifacts/multiplayer-browser-acceptance.json');
const sourceArg=process.argv[5]||'',officialMatch=/^official:(8|10|12)$/.exec(sourceArg),officialSize=officialMatch?Number(officialMatch[1]):0;
const fixturePath=sourceArg&&!officialSize?path.resolve(sourceArg):null;
const fixtureSize=Number(process.argv[6]||0),targetSize=officialSize||fixtureSize;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const officialCatalogData=require('../multiplayer-levels.js'),officialPools=require('../puzzle-pools.js');
const runtimeFiles=['multiplayer-levels.js','multiplayer-pool-manifest.json','multiplayer-large-cohorts.json','puzzle-pools.js','battle-engine.js','survival-engine.js','survival-session.js','app.js','battle-ui.js','survival-ui.js'];
const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex');
const runtimeSha256=Object.fromEntries(runtimeFiles.map(file=>[file,sha256(file)]));

function fixtureCatalog(file){
  if(!file)return null;
  const source=JSON.parse(fs.readFileSync(file,'utf8'));
  if(source.tiers){
    assert.ok([8,10,12].includes(fixtureSize),'Pass fixture size 8, 10, or 12.');
    const base=Object.values(source.tiers).flat().filter(level=>level.size===fixtureSize);assert.equal(base.length,4,`Expected one four-board ${fixtureSize}x${fixtureSize} cohort.`);
    const tiers={};for(const tier of ['beginner','normal','advanced','challenge'])tiers[tier]=Array.from({length:16},(_,index)=>{const level=base[index%4],group=Math.floor(index/4)+1,lane=index%4+1,id=`fixture-${fixtureSize}-${tier}-${group}-${lane}-${level.id}`,puzzleFingerprint=crypto.createHash('sha256').update(`${id}|${level.regions.join(',')}`).digest('hex');return{...level,id,puzzleFingerprint};});
    return{packVersion:'large-cohort-browser-candidate',poolVersion:`large-${fixtureSize}x${fixtureSize}-browser-only`,tiers};
  }
  const size=source.size,flat=source.regions.flat(),answer=source.validation.solution.map(cell=>cell.index);
  assert.equal(source.accepted,true,'The injected large-board fixture must be accepted by its research validator.');
  assert.equal(source.releaseEligible,false,'Research fixtures must remain explicitly non-release content.');
  function turn(values,indices,quarterTurns){
    let result=values.slice(),mapped=indices.slice();
    for(let turnIndex=0;turnIndex<quarterTurns;turnIndex++){
      const next=Array(size*size),nextIndices=[];
      for(let row=0;row<size;row++)for(let column=0;column<size;column++)next[column*size+(size-1-row)]=result[row*size+column];
      for(const index of mapped){const row=Math.floor(index/size),column=index%size;nextIndices.push(column*size+(size-1-row));}
      result=next;mapped=nextIndices.sort((left,right)=>left-right);
    }
    return{regions:result,solution:mapped};
  }
  const base=Array.from({length:4},(_,index)=>turn(flat,answer,index));
  const make=(tier,index)=>{const shape=base[index%4],id=`fixture-12-${tier}-${String(index+1).padStart(2,'0')}`,fingerprint=crypto.createHash('sha256').update(`${id}|${shape.regions.join(',')}`).digest('hex');return{id,size,regions:shape.regions,solution:shape.solution,givens:[],puzzleFingerprint:fingerprint,givensFingerprint:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',scoringEligible:true,highestTechnique:source.logic.metrics.highestTechnique,techniqueRank:source.logic.metrics.highestTechniqueRank,reasoningLoad:0.72,morphologySignature:'research-fixture'};};
  const tiers={};for(const tier of ['beginner','normal','advanced','challenge'])tiers[tier]=Array.from({length:16},(_,index)=>make(tier,index));
  return{packVersion:'research-fixture-not-release',poolVersion:'constructive-12x12-browser-only',tiers};
}
const injectedCatalog=fixtureCatalog(fixturePath);
const testDifficulty=targetSize===10?'normal':targetSize?'advanced':'challenge';

async function browser(){
  let version;for(let attempt=0;attempt<50;attempt++){try{version=await fetch(endpoint+'/json/version').then(response=>response.json());if(version.webSocketDebuggerUrl)break;}catch{}await wait(200);}
  if(!version?.webSocketDebuggerUrl)throw Error('No DevTools browser endpoint');
  const socket=new WebSocket(version.webSocketDebuggerUrl),pending=new Map();let serial=0;
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{const message=JSON.parse(event.data);if(!message.id||!pending.has(message.id))return;const job=pending.get(message.id);pending.delete(message.id);message.error?job.reject(Error(JSON.stringify(message.error))):job.resolve(message.result);};
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  async function page(name){
    const {browserContextId}=await send('Target.createBrowserContext'),{targetId}=await send('Target.createTarget',{url:pageUrl,browserContextId}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(result.exceptionDetails)throw Error(`${name}: ${result.exceptionDetails.exception?.description||result.exceptionDetails.text}`);return result.result.value;};
    const until=async(expression,label,timeout=25000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression).catch(()=>false))return true;await wait(100);}throw Error(`${name}: timed out waiting for ${label}`);};
    const initialize=async()=>{await until(`document.readyState==='complete'&&typeof state==='object'&&typeof document.querySelector('#chooseHost')?.onclick==='function'`,'app load');
      if(injectedCatalog)await evaluate(`(async()=>{if(!globalThis.CAT_MULTIPLAYER_POOLS)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='./multiplayer-levels.js?fixture-bootstrap=1';script.onload=resolve;script.onerror=reject;document.head.appendChild(script)});const fixture=${JSON.stringify(injectedCatalog)};for(const key of Object.keys(globalThis.CAT_MULTIPLAYER_POOLS))delete globalThis.CAT_MULTIPLAYER_POOLS[key];Object.assign(globalThis.CAT_MULTIPLAYER_POOLS,fixture);return CatPuzzlePools.validCatalog(globalThis.CAT_MULTIPLAYER_POOLS)})()`);
      await evaluate(`localStorage.clear();sessionStorage.clear();window.__browserCues=[];state.sound={muted:false,play(kind,options){if(!this.muted)window.__browserCues.push({kind,combo:options?.combo||0,id:options?.id||''});return !this.muted;},unlock(){return Promise.resolve(true)},preload(){return Promise.resolve(true)},setMuted(value){this.muted=!!value},setVolume(){},stopAll(){},resetMatch(){},getState(){return{muted:this.muted}}};true`);};
    await initialize();
    const reload=async()=>{await evaluate(`state.peer?.destroy?.();true`).catch(()=>{});await wait(250);await send('Page.reload',{ignoreCache:true},sessionId);await initialize();};
    return{name,sessionId,browserContextId,evaluate,until,reload,media:value=>send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value}]},sessionId)};
  }
  return{send,page,socket};
}
function hostSetup(mode,name,difficulty='challenge'){return `(()=>{document.querySelector('#chooseHost').click();document.querySelector('#nick').value=${JSON.stringify(name)};document.querySelector('#gameMode').value=${JSON.stringify(mode)};document.querySelector('#gameMode').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#multiplayerDifficulty').value=${JSON.stringify(difficulty)};document.querySelector('#host').click();return true})()`;}
function guestSetup(room,name){return `(()=>{document.querySelector('#chooseJoin').click();document.querySelector('#nick').value=${JSON.stringify(name)};document.querySelector('#roomInput').value=${JSON.stringify(room)};document.querySelector('#join').click();return true})()`;}
const correctIndex=(player=0)=>`(()=>{const board=state.game.boards[${player}],answer=board.puzzle.solution||CatClassic.enumerate(board.puzzle,null,1)[0];return answer.find(index=>!board.found.includes(index))})()`;
const wrongIndex=(player=0)=>`(()=>{const board=state.game.boards[${player}],answer=board.puzzle.solution||CatClassic.enumerate(board.puzzle,null,1)[0];return[...Array(board.puzzle.size**2).keys()].find(index=>!answer.includes(index)&&!board.misses.includes(index))})()`;
const noteIndex=(player=0)=>`(()=>{const board=state.game.boards[${player}];return[...Array(board.puzzle.size**2).keys()].find(index=>!board.found.includes(index)&&!board.misses.includes(index))})()`;
const selectionEvidence=(player=0)=>`(()=>{const board=state.game.boards[${player}],selection=board.selection,resource=performance.getEntriesByType('resource').map(item=>item.name).find(name=>/multiplayer-levels\\.js/.test(name))||null;return{size:board.puzzle.size,rank:selection.techniqueRank,load:selection.reasoningLoad,levelId:selection.levelId,puzzleFingerprint:selection.puzzleFingerprint,packVersion:selection.packVersion,poolVersion:selection.poolVersion,cohort:selection.cohort,lane:selection.lane,epoch:selection.epoch,cursor:selection.cursor,givensFingerprint:selection.givensFingerprint,scoringEligible:selection.scoringEligible,matchId:state.game.id,roundSeed:state.game.settings.roundSeed,difficulty:state.game.settings.difficulty,regions:board.puzzle.regions,catalogLoaded:!!globalThis.CAT_MULTIPLAYER_POOLS,catalogResource:resource}})()`;
function formalizeSelection(item,lane){
  const sequence=officialPools.create({tier:item.difficulty,matchId:item.matchId,roundSeed:item.roundSeed,packVersion:item.packVersion,poolVersion:item.poolVersion}),selection={packVersion:item.packVersion,poolVersion:item.poolVersion,tier:item.difficulty,epoch:item.epoch,cursor:item.cursor,lane:item.lane,cohort:item.cohort,size:item.size,techniqueRank:item.rank,reasoningLoad:item.load,levelId:item.levelId,puzzleFingerprint:item.puzzleFingerprint,givensFingerprint:item.givensFingerprint,scoringEligible:item.scoringEligible},expected=sequence.at(item.epoch*sequence.size+item.cursor,lane),level=Object.values(officialCatalogData.tiers).flat().find(value=>value.id===item.levelId),regionsSha256=crypto.createHash('sha256').update(item.regions.join(',')).digest('hex');
  return{...item,regions:undefined,regionsSha256,formalSelectionValid:sequence.assertSelection(selection,lane)&&expected.puzzle.regions.join(',')===item.regions.join(',')&&!!level&&level.puzzleFingerprint===item.puzzleFingerprint&&level.regions.join(',')===item.regions.join(',')};
}
async function hostRequestedSize(page,mode,name){
  const attempts=officialSize?40:1;
  for(let attempt=1;attempt<=attempts;attempt++){
    await page.evaluate(hostSetup(mode,name,testDifficulty));
    await page.until(mode==='battle'?`state.peer?.open&&/^CAT-/.test(state.room)&&state.game?.boards?.[0]?.selection`:`state.peer?.open&&state.survivalLinkStatus==='hosting'&&state.game?.boards?.[0]?.selection`,`${mode} room`);
    const selected=await page.evaluate('state.game.boards[0].puzzle.size');
    if(!officialSize||selected===officialSize)return attempt;
    await page.reload();
  }
  throw Error(`Official ${mode} selector did not reach ${officialSize}x${officialSize} within ${attempts} attempts.`);
}

(async()=>{const cdp=await browser(),report={passed:false,actualBrowser:true,isolatedBrowserContexts:true,transport:'PeerJS Cloud/WebRTC data connection',fixture:injectedCatalog?{source:fixturePath,size:fixtureSize||12,releaseEligible:false}:null,officialCatalog:officialSize?{injected:false,requestedSize:officialSize,difficulty:testDifficulty,expectedPackVersion:'classic-original-100-v3-preserve-101-300',expectedPoolVersion:'multiplayer-v5-private-large-cohorts-1',runtimeSha256}:null,trustModel:'trusted-host authority; guest snapshots and opponent UI expose aggregate progress only; no claim against DevTools or a malicious host',battle:{},survival:{}};const pages=[];
  try{
    const host=await cdp.page('battle-host'),guest=await cdp.page('battle-guest');pages.push(host,guest);await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},guest.sessionId);
    const battleSelectionAttempts=await hostRequestedSize(host,'battle','Host');const battleRoom=await host.evaluate('state.room');
    await guest.evaluate(guestSetup(battleRoom,'Guest'));await Promise.all([host.until(`state.game?.settings?.mode==='battle'&&state.game.status==='playing'`,'battle playing'),guest.until(`state.game?.settings?.mode==='battle'&&state.game.status==='playing'`,'battle playing')]);
    assert.equal(await host.evaluate('state.transport.open()'),true);assert.equal(await guest.evaluate('state.transport.open()'),true);
    const battleFairness=await Promise.all([host,guest].map(async(page,index)=>{const evidence=formalizeSelection(await page.evaluate(selectionEvidence(index)),index),privacy=await page.evaluate(`(()=>{const other=state.game.boards[${1-index}];return{otherPrivate:!other.puzzle.regions&&other.selection===null,otherCells:document.querySelectorAll('.battle-side.opponent .cell').length}})()`);return{...evidence,...privacy};}));
    assert.equal(battleFairness[0].size,battleFairness[1].size);assert.equal(battleFairness[0].rank,battleFairness[1].rank);assert.ok(Math.abs(battleFairness[0].load-battleFairness[1].load)<=0.25);assert.notEqual(battleFairness[0].levelId,battleFairness[1].levelId);assert.equal(battleFairness[1].otherPrivate,true,JSON.stringify(battleFairness));assert.ok(battleFairness.every(item=>item.otherCells===0),JSON.stringify(battleFairness));
    if(officialSize){assert.ok(battleFairness.every(item=>item.size===officialSize&&item.formalSelectionValid&&item.poolVersion===report.officialCatalog.expectedPoolVersion&&item.packVersion===report.officialCatalog.expectedPackVersion&&item.levelId.startsWith(`research-${officialSize}-`)),JSON.stringify(battleFairness));assert.match(battleFairness[0].catalogResource||'',/multiplayer-levels\.js/);assert.equal(battleFairness[1].catalogLoaded,false);}
    const hostFirst=await host.evaluate(correctIndex(0));await host.evaluate(`battleChoose(${hostFirst})`);await guest.until(`state.game.boards[0].foundCount===1`,'opponent first hit');await wait(350);
    const hostSecond=await host.evaluate(correctIndex(0));await host.evaluate(`battleChoose(${hostSecond})`);await guest.until(`state.game.boards[0].foundCount===2`,'opponent second hit');await wait(350);
    const hostMiss=await host.evaluate(wrongIndex(0));await host.evaluate(`battleChoose(${hostMiss})`);await guest.until(`state.game.boards[0].missesCount===1`,'opponent miss');
    assert.equal(await host.evaluate('state.game.boards[0].combo'),0);await wait(2200);
    const hostAfterMiss=await host.evaluate(correctIndex(0));await host.evaluate(`battleChoose(${hostAfterMiss})`);await guest.until(`state.game.boards[0].foundCount===3`,'post-miss hit');assert.equal(await host.evaluate('state.game.boards[0].combo'),1);await wait(350);
    const guestHit=await guest.evaluate(correctIndex(1));await guest.evaluate(`battleChoose(${guestHit})`);await host.until(`state.game.boards[1].found.length===1`,'guest hit');
    const battleCues={host:await host.evaluate('window.__browserCues.slice()'),guest:await guest.evaluate('window.__browserCues.slice()')};
    assert.ok(battleCues.host.some(cue=>cue.kind==='combo'&&cue.combo===2));assert.ok(battleCues.host.some(cue=>cue.kind==='miss'));assert.ok(battleCues.guest.some(cue=>cue.kind==='found'&&cue.combo===2));
    const duplicateBefore=await guest.evaluate('window.__browserCues.length');await guest.evaluate('render();render();true');assert.equal(await guest.evaluate('window.__browserCues.length'),duplicateBefore);
    await guest.evaluate(`(()=>{const snapshot=structuredClone(state.game);onClose();onMessage({type:'state',state:snapshot});return true})()`);assert.equal(await guest.evaluate('window.__browserCues.length'),duplicateBefore);
    await host.evaluate(`togglePrivateCell(${await host.evaluate(noteIndex(0))})`);await guest.evaluate(`togglePrivateCell(${await guest.evaluate(noteIndex(1))})`);assert.equal(await host.evaluate('state.notes.size'),1);assert.equal(await guest.evaluate('state.notes.size'),1);
    await host.evaluate(`document.querySelector('#battleMute').click()`);assert.equal(await host.evaluate('state.muted'),true);const mutedBefore=await host.evaluate('window.__browserCues.length');await host.evaluate('playGestureCue("ui",{id:"muted-browser-check"})');assert.equal(await host.evaluate('window.__browserCues.length'),mutedBefore);
    await guest.media('reduce');await guest.evaluate('render();true');assert.equal(await guest.evaluate(`(()=>{const node=document.createElement('div');node.className='battle-cat-launch';document.querySelector('#battleArena').appendChild(node);const ok=matchMedia('(prefers-reduced-motion: reduce)').matches&&getComputedStyle(node).display==='none';node.remove();return ok})()`),true);
    const narrow=await guest.evaluate(`({width:innerWidth,height:innerHeight,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,localCells:document.querySelectorAll('.battle-side.local .cell').length})`);assert.equal(narrow.width,390);assert.equal(narrow.horizontalOverflow,false);assert.equal(narrow.localCells,battleFairness[1].size**2);
    report.battle={clients:2,room:battleRoom,selectionAttempts:battleSelectionAttempts,transportOpen:true,fairness:battleFairness,trustedHostAnswerAccess:battleFairness[0].otherPrivate===false,narrowViewport:narrow,consecutiveHitCombos:[1,2],missReset:true,opponentCue:true,duplicateRenderSilent:true,reconnectSnapshotSilent:true,privateNotesPerClient:[1,1],mute:true,reducedMotion:true};

    const sHost=await cdp.page('survival-host'),sGuests=[];pages.push(sHost);const survivalSelectionAttempts=await hostRequestedSize(sHost,'survival','S1');const survivalRoom=await sHost.evaluate('state.room');
    for(let index=2;index<=4;index++){const page=await cdp.page(`survival-${index}`);pages.push(page);sGuests.push(page);await page.evaluate(guestSetup(survivalRoom,`S${index}`));}
    await Promise.all([sHost,...sGuests].map((page,index)=>page.until(`state.game?.settings?.mode==='survival'&&state.game.players.length===4&&state.survivalLinkStatus!== 'joining'`,`four survival seats ${index}`,30000)));
    await sHost.evaluate(`document.querySelector('#survivalStartButton').click()`);await Promise.all([sHost,...sGuests].map(page=>page.until(`state.game.status==='playing'`,'survival playing',15000)));
    const survivalPages=[sHost,...sGuests];
    for(let index=0;index<4;index++)assert.equal(await survivalPages[index].evaluate('state.you'),index);
    const survivalFairness=await Promise.all(survivalPages.map(async(page,index)=>{const evidence=formalizeSelection(await page.evaluate(selectionEvidence(index)),index),opponentsPrivate=await page.evaluate(`state.game.boards.filter((_,who)=>who!==${index}).every(board=>!board.puzzle.regions&&board.selection===null)`);return{...evidence,opponentsPrivate};}));
    assert.equal(new Set(survivalFairness.map(item=>item.size)).size,1);assert.equal(new Set(survivalFairness.map(item=>item.rank)).size,1);assert.ok(Math.max(...survivalFairness.map(item=>item.load))-Math.min(...survivalFairness.map(item=>item.load))<=0.25);assert.equal(new Set(survivalFairness.map(item=>item.levelId)).size,4);assert.ok(survivalFairness.every(item=>item.opponentsPrivate));
    if(officialSize){assert.ok(survivalFairness.every(item=>item.size===officialSize&&item.formalSelectionValid&&item.poolVersion===report.officialCatalog.expectedPoolVersion&&item.packVersion===report.officialCatalog.expectedPackVersion&&item.levelId.startsWith(`research-${officialSize}-`)),JSON.stringify(survivalFairness));assert.match(survivalFairness[0].catalogResource||'',/multiplayer-levels\.js/);assert.ok(survivalFairness.slice(1).every(item=>item.catalogLoaded===false));}
    const first=await sHost.evaluate(correctIndex(0));await sHost.evaluate(`survivalChoose(${first})`);await Promise.all(sGuests.map(page=>page.until(`state.game.boards[0].foundCount===1`,'survival first hit')));await wait(350);
    const second=await sHost.evaluate(correctIndex(0));await sHost.evaluate(`survivalChoose(${second})`);await Promise.all(sGuests.map(page=>page.until(`state.game.boards[0].foundCount===2`,'survival second hit')));await wait(350);
    const miss=await sHost.evaluate(wrongIndex(0));await sHost.evaluate(`survivalChoose(${miss})`);await Promise.all(sGuests.map(page=>page.until(`state.game.boards[0].missesCount===1`,'survival miss')));assert.equal(await sHost.evaluate('state.game.boards[0].feedbackStreak'),0);await wait(2200);
    const afterMiss=await sHost.evaluate(correctIndex(0));await sHost.evaluate(`survivalChoose(${afterMiss})`);await Promise.all(sGuests.map(page=>page.until(`state.game.boards[0].foundCount===3`,'survival post-miss hit')));assert.equal(await sHost.evaluate('state.game.boards[0].feedbackStreak'),1);
    const otherHit=await sGuests[0].evaluate(officialSize===12?`(()=>{const board=state.game.boards[1],answer=CatClassic.enumerate(board.puzzle,null,1)[0];return answer.find(index=>index>=36&&!board.found.includes(index))})()`:correctIndex(1));
    assert.ok(Number.isInteger(otherHit)&&(!officialSize||officialSize!==12||otherHit>=36));
    await sGuests[0].evaluate(`survivalChoose(${otherHit});window.__acceptedAction=state.pendingAction;true`);
    if(officialSize===12)await sGuests[0].until(`window.__acceptedAction?.acknowledged===true`,'accepted high-index guest ack',5000);
    await sHost.until(`state.game.boards[1].foundCount===1`,'survival other hit');
    const survivalCues=await Promise.all(survivalPages.map(page=>page.evaluate('window.__browserCues.slice()')));assert.ok(survivalCues[0].some(cue=>cue.kind==='combo'&&cue.combo===2));assert.ok(survivalCues[1].some(cue=>cue.kind==='found'&&cue.combo===2));
    await wait(300);const survivalDuplicateBefore=await sGuests[2].evaluate('window.__browserCues.length');await sGuests[2].evaluate('render();render();true');await wait(100);assert.equal(await sGuests[2].evaluate('window.__browserCues.length'),survivalDuplicateBefore);
    await sGuests[2].evaluate(`applySurvivalSnapshot(structuredClone(state.game),{historical:true})`);assert.equal(await sGuests[2].evaluate('window.__browserCues.length'),survivalDuplicateBefore);
    for(let index=0;index<4;index++){const note=await survivalPages[index].evaluate(noteIndex(index));await survivalPages[index].evaluate(`togglePrivateCell(${note})`);assert.equal(await survivalPages[index].evaluate('state.notes.size'),1);}
    assert.deepEqual(await Promise.all(survivalPages.map(page=>page.evaluate('state.notes.size'))),[1,1,1,1]);
    await sGuests[1].evaluate(`document.querySelector('#survivalMute').click()`);assert.equal(await sGuests[1].evaluate('state.muted'),true);const survivalMutedBefore=await sGuests[1].evaluate('window.__browserCues.length');await sGuests[1].evaluate('playGestureCue("ui",{id:"muted-survival-browser-check"})');assert.equal(await sGuests[1].evaluate('window.__browserCues.length'),survivalMutedBefore);
    await sGuests[2].media('reduce');assert.equal(await sGuests[2].evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches&&getComputedStyle(document.querySelector('#survivalArena .cell')).transitionDuration==='0s'`),true);
    report.survival={clients:4,room:survivalRoom,selectionAttempts:survivalSelectionAttempts,seatIndices:[0,1,2,3],transportStatus:await Promise.all(survivalPages.map(page=>page.evaluate('state.survivalLinkStatus'))),fairness:survivalFairness,guestAcceptedAction:{index:otherHit,acceptedAck:officialSize===12?await sGuests[0].evaluate('window.__acceptedAction?.acknowledged===true'):true},consecutiveFeedback:[1,2],missReset:true,opponentCue:true,duplicateRenderSilent:true,reconnectSnapshotSilent:true,privateNotesPerClient:[1,1,1,1],mute:true,reducedMotion:true,noBlast:await sHost.evaluate(`!('blast' in (state.game.lastEvent||{}))&&!document.querySelector('[class*="blast"],[class*="tabby"]')`)};
    report.passed=true;fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{for(const page of pages)await cdp.send('Target.disposeBrowserContext',{browserContextId:page.browserContextId}).catch(()=>{});cdp.socket.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
