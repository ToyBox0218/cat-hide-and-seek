'use strict';

// Deterministic public snapshots, fake DOM and authored CSS only. These checks
// do not claim browser rendering, physical viewport fit or network acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const source = read('tests/survival-app.test.js');
const boundary = source.indexOf("\ntest('");
assert.ok(boundary > 0);
const helperContext = {require, __dirname, console, Buffer, URL, URLSearchParams};
vm.runInNewContext(source.slice(0, boundary) + '\nglobalThis.helpers={fixture,makeHarness,singleClick};', helperContext);
const {fixture, makeHarness, singleClick} = helperContext.helpers;
const ui = h => vm.runInContext('survivalUI', h.context);
const json = value => JSON.parse(JSON.stringify(value));
const quotas = [4, 10, 16, 24];

function approachCheckpoint(minute=1, options={}) {
  const f=fixture(options), {h,authority,engine,sync}=f;
  for(const player of authority.players)player.score=minute===1?0:quotas[minute-2];
  h.advance(minute*60000-20001);engine.advance(authority,h.now());sync();
  assert.equal(h.state.game.status,'playing');
  assert.equal(h.state.game.nextQuota,quotas[minute-1]);
  assert.equal(ui(h).quotaCutin,null);
  return f;
}

for(const minute of [1,2,3,4])test(`checkpoint ${minute} enters once at 20 seconds and travels toward the persistent quota HUD`,()=>{
  const {h,grid}=approachCheckpoint(minute), cells=[...grid().children];
  h.advance(1);h.updateSurvivalTimers();
  const cutin=ui(h).quotaCutin;
  assert.ok(cutin);assert.equal(cutin.node.dataset.checkpoint,String(minute));
  assert.equal(cutin.node.className,'survival-quota-cutin');
  assert.equal(cutin.node.querySelector('strong').textContent,`${minute===1?0:quotas[minute-2]} / ${quotas[minute-1]}`);
  assert.equal(cutin.node.querySelector('b').textContent,'20 秒');
  assert.equal(cutin.node.getAttribute('aria-hidden'),'true','the persistent status provides the accessible text');
  for(const name of ['--from-x','--from-y','--to-x','--to-y'])assert.match(cutin.node.style.getPropertyValue(name),/px$/);
  assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),true);
  assert.match(h.get('#survivalQuotaWarning').textContent,/20 秒/);
  assert.deepEqual([...grid().children],cells);assert.ok(cells.every(cell=>!cell.disabled));
  h.updateSurvivalTimers();h.renderSurvival();assert.strictEqual(ui(h).quotaCutin,cutin);
  h.tick(1450);assert.equal(ui(h).quotaCutin,null);assert.equal(cutin.node.parentNode,null);
  h.updateSurvivalTimers();h.renderSurvival();assert.equal(ui(h).quotaCutin,null,'the warning never replays within a checkpoint');
  assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),true,'the HUD remains urgent after the entrance finishes');
});

test('a cut-in leaves board marks and gameplay available, and reaching target immediately cancels it',()=>{
  const {h,authority,sync,grid}=approachCheckpoint();
  h.advance(1);h.updateSurvivalTimers();const cutin=ui(h).quotaCutin;
  singleClick(h,grid().children[0]);assert.equal(h.state.notes.has(0),true);
  assert.strictEqual(ui(h).quotaCutin,cutin);
  authority.players[0].score=4;authority.revision++;sync();
  assert.equal(ui(h).quotaCutin,null);assert.equal(h.timers.has(cutin.timer),false);
  assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),false);
  assert.equal(h.get('#survivalQuotaCard').classList.contains('is-complete'),true);
  assert.equal(h.get('#survivalQuotaWarning').classList.contains('hidden'),true);
  assert.equal(h.get('#survivalQuotaRemaining').textContent,'已達標 ✓');
});

test('already met quotas and reduced motion show no entrance animation',()=>{
  for(const reduced of [false,true]){
    const {h,authority,sync}=approachCheckpoint();
    h.context.matchMedia=()=>({matches:reduced});
    if(!reduced){authority.players[0].score=4;authority.revision++;sync();}
    h.advance(1);h.updateSurvivalTimers();
    assert.equal(ui(h).quotaCutin,null);
    assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),reduced);
    assert.equal(h.get('#survivalQuotaWarning').classList.contains('hidden'),!reduced);
  }
});

test('urgency announces once while the readable visual timer continues to update',()=>{
  const {h}=approachCheckpoint();h.advance(1);h.updateSurvivalTimers();
  const announced=h.get('#survivalQuotaAnnouncement').textContent;
  assert.match(announced,/剩 20 秒，還差 4 隻/);
  h.advance(1000);h.updateSurvivalTimers();
  assert.match(h.get('#survivalQuotaWarning').textContent,/19 秒/);
  assert.equal(h.get('#survivalQuotaAnnouncement').textContent,announced);
  assert.equal(ui(h).announced.size,1);
  assert.match(read('survival-ui.js'),/id="survivalQuotaWarning"[^>]*role="timer"[^>]*aria-live="off"/);
});

test('first join inside twenty seconds shows current urgency without replaying an entrance',()=>{
  const {h}=approachCheckpoint();h.advance(5001);h.updateSurvivalTimers();
  const joined=makeHarness();joined.state.survivalPlayerId='p1';joined.state.survivalLinkStatus='connected';
  const snapshot=json(h.state.game);snapshot.serverTime=h.now();
  joined.applySurvivalSnapshot(snapshot,{historical:true});joined.renderSurvival();
  assert.equal(ui(joined).quotaCutin,null);
  assert.equal(joined.get('#survivalQuotaCard').classList.contains('is-urgent'),true);
  assert.match(joined.get('#survivalQuotaWarning').textContent,/15 秒/);
  joined.updateSurvivalTimers();joined.renderSurvival();assert.equal(ui(joined).quotaCutin,null);
});

for(const interrupt of ['hidden','reconnect','finished','aborted','leave'])test(`${interrupt} removes an active quota entrance and its timer`,()=>{
  const {h,authority,sync}=approachCheckpoint();h.advance(1);h.updateSurvivalTimers();
  const cutin=ui(h).quotaCutin;assert.ok(cutin);
  if(interrupt==='hidden'){h.context.document.hidden=true;h.dispatchDocument('visibilitychange');}
  else if(interrupt==='reconnect')vm.runInContext('survivalStatus({status:"reconnecting"})',h.context);
  else if(interrupt==='leave')h.disposeSurvivalRoom('quota-test');
  else {authority.status=interrupt;authority.revision++;sync();}
  assert.equal(ui(h).quotaCutin,null);assert.equal(h.timers.has(cutin.timer),false);assert.equal(cutin.node.parentNode,null);
  if(interrupt==='hidden'){h.context.document.hidden=false;h.dispatchDocument('visibilitychange');h.renderSurvival();}
  if(interrupt==='reconnect'){vm.runInContext('survivalStatus({status:"connected"})',h.context);h.applySurvivalSnapshot({...json(h.state.game),serverTime:h.now()},{historical:true});h.renderSurvival();}
  if(['hidden','reconnect'].includes(interrupt)){
    assert.equal(ui(h).quotaCutin,null);assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),true);
  }
});

test('disconnecting before the threshold and reconnecting within it does not replay the missed entrance',()=>{
  const {h}=approachCheckpoint();
  vm.runInContext('survivalStatus({status:"reconnecting"})',h.context);h.advance(1001);h.updateSurvivalTimers();
  vm.runInContext('survivalStatus({status:"connected"})',h.context);h.applySurvivalSnapshot({...json(h.state.game),serverTime:h.now()},{historical:true});h.renderSurvival();
  assert.equal(ui(h).quotaCutin,null);assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),true);
});

test('spectator quota and risk describe the selected player, with no personal entrance',()=>{
  const {h,authority,sync}=approachCheckpoint();
  authority.players[0].status='eliminated';authority.players[0].reason={type:'quota',minute:1,required:4};
  authority.players[1].score=1;authority.players[2].score=4;authority.revision++;sync();
  h.advance(1);h.updateSurvivalTimers();
  assert.equal(ui(h).quotaCutin,null);assert.equal(h.get('#survivalQuotaTarget').textContent,'1 / 4');
  assert.equal(h.get('#survivalQuotaLabel').textContent,'觀戰 · Friend 1');
  assert.match(h.get('#survivalQuotaWarning').textContent,/Friend 1.*差 3 隻/);
  assert.doesNotMatch(h.get('#survivalQuotaWarning').textContent,/你/);
  assert.equal(h.get('#survivalQuotaMeter').getAttribute('aria-label'),'Friend 1的累計配額進度');
  h.get('#survivalFollow').onchange({target:{value:'2'}});
  assert.equal(h.get('#survivalQuotaTarget').textContent,'4 / 4');
  assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),false);
  assert.equal(h.get('#survivalQuotaCard').classList.contains('is-complete'),true);
  assert.equal(ui(h).quotaCutin,null);
});

test('the fifth minute has no elimination warning or cut-in, including in its final twenty seconds',()=>{
  const {h,authority,engine,sync}=fixture();authority.players.forEach(player=>{player.score=24;});
  h.advance(240000);engine.advance(authority,h.now());sync();
  for(const delay of [0,39999,1,10000]){
    h.advance(delay);h.updateSurvivalTimers();
    assert.equal(ui(h).quotaCutin,null);assert.equal(h.get('#survivalQuotaWarning').classList.contains('hidden'),true);
    assert.equal(h.get('#survivalQuotaCard').classList.contains('is-urgent'),false);
    assert.equal(h.get('#survivalQuotaCard').classList.contains('is-final'),true);
  }
});

test('an offscreen urgent HUD gains a compact visible target and loses it on completion or return',()=>{
  const {h,authority,sync}=approachCheckpoint();h.context.innerWidth=390;h.context.innerHeight=844;
  const card=h.get('#survivalQuotaCard'),originalRect=card.getBoundingClientRect;
  card.getBoundingClientRect=()=>({left:150,top:-150,width:180,height:120,right:330,bottom:-30});
  h.advance(1);h.updateSurvivalTimers();
  const dock=ui(h).quotaDock;assert.ok(dock);assert.equal(dock.className,'survival-quota-dock');
  assert.equal(dock.textContent,'🐾 0 / 4 · 20 秒');
  dock.getBoundingClientRect=()=>({left:205,top:12,width:173,height:38,right:378,bottom:50});
  h.updateSurvivalTimers();
  assert.equal(ui(h).quotaCutin.node.style.getPropertyValue('--to-x'),'291.5px');
  assert.equal(ui(h).quotaCutin.node.style.getPropertyValue('--to-y'),'31px');
  h.tick(1450);assert.equal(ui(h).quotaCutin,null);assert.strictEqual(ui(h).quotaDock,dock,'the small countdown remains readable after the entrance');
  card.getBoundingClientRect=originalRect;h.updateSurvivalTimers();assert.equal(ui(h).quotaDock,null);
  card.getBoundingClientRect=()=>({left:150,top:-150,width:180,height:120});h.updateSurvivalTimers();assert.ok(ui(h).quotaDock);
  authority.players[0].score=4;authority.revision++;sync();assert.equal(ui(h).quotaDock,null);
});

function revealTabby(f,who=0,{delay=0}={}){
  for(let i=0;i<6;i++){
    const {h,engine,authority,sync}=f,board=authority.boards[who],index=board.puzzle.solution.find(cell=>!board.found.includes(cell));
    const result=engine.act(authority,authority.players[who].id,{type:'guess',boardId:board.puzzle.id,index,actionId:`tabby-audio-${who}-${i}`},h.now());
    assert.equal(result.accepted,true);
    if(result.event.blast&&delay)h.advance(delay);
    sync();
    if(result.event.blast)return result.event;
    h.tick(300);
  }
  assert.fail('the deterministic board must expose a special event');
}
const audioCues=h=>h.audio.calls.filter(call=>call.method==='play').map(call=>({kind:call.args[0],...call.args[1]}));

test('delayed live tabby events retain their effect and align unique launch/impact cues, with no replay',()=>{
  const f=fixture({tabbyEnabled:true,fakeAudio:true}),{h}=f;
  const event=revealTabby(f,0,{delay:2500});
  const sequence=h.get('#survivalFX').children[0];assert.ok(sequence);
  assert.equal(sequence.dataset.eventId,event.id);
  const launch=audioCues(h).find(cue=>cue.kind==='launch'),impact=audioCues(h).find(cue=>cue.kind==='impact');
  assert.equal(launch.id,`${event.id}:tabby-launch`);assert.equal(launch.delay,.35);
  assert.equal(impact.id,`${event.id}:tabby-impact`);assert.equal(impact.delay,.9);
  const before=json(audioCues(h));h.applySurvivalSnapshot({...json(h.state.game),serverTime:h.now()});h.renderSurvival();
  assert.deepEqual(json(audioCues(h)),before);assert.equal(h.get('#survivalFX').children.length,1);
});

test('special audio is limited to the visible own or followed board, and follow changes stop scheduled cues',()=>{
  const offscreen=fixture({tabbyEnabled:true,fakeAudio:true});revealTabby(offscreen,1);
  assert.equal(audioCues(offscreen.h).some(cue=>['launch','impact'].includes(cue.kind)),false);
  const f=fixture({tabbyEnabled:true,fakeAudio:true}),{h,authority,sync}=f;
  authority.players[0].status='eliminated';authority.players[0].reason='quota';authority.revision++;sync();
  revealTabby(f,1);
  assert.equal(audioCues(h).filter(cue=>cue.kind==='launch').length,1);
  assert.equal(audioCues(h).filter(cue=>cue.kind==='impact').length,1);
  h.audio.calls.length=0;h.get('#survivalFollow').onchange({target:{value:'2'}});
  assert.equal(h.get('#survivalFX').children.length,0);
  assert.ok(h.audio.calls.some(call=>call.method==='stopAll'));
});

test('authored effects preserve input and reduced-motion cues with bounded lifetimes',()=>{
  const css=read('survival.css'),script=read('survival-ui.js');
  assert.match(css,/\.survival-quota-cutin\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css,/\.survival-fx\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css,/\.survival-quota-dock\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css,/@keyframes survivalQuotaCutin[^]*?left:\s*var\(--to-x\)/);
  assert.match(css,/@keyframes survivalTabbyLeap[^]*?left:\s*var\(--landing-x\)/);
  assert.match(css,/\.survival-tabby-sequence\.is-static \.survival-tabby-score\s*\{[^}]*animation:\s*none/);
  assert.match(script,/survivalUI\.overlays\.size>=3/);
  assert.match(script,/survivalUI\.blastGeometry\.size>8/);
  assert.doesNotMatch(script,/suiNow\(\)-event\.at>1800/,'new live events are not discarded for ordinary delivery latency');
  assert.doesNotMatch(script,/\[6,12,20,30\]/);
  assert.doesNotMatch(css,/survival-tabby-burst|survivalPaw/,'superseded effect rules are removed');
});
