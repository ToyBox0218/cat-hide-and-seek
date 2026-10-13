'use strict';

// State, controller and authored-markup integration using the same deliberately
// small fake DOM as the legacy suite. These are not rendered-browser or real
// PeerJS/NAT acceptance tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const ROOT = path.join(__dirname, '..');
const json = value => JSON.parse(JSON.stringify(value));

// Reuse only helper declarations. Importing the entire test file would register
// its hundreds of legacy tests for a second time in this suite.
const legacySource = fs.readFileSync(path.join(__dirname, 'legacy-modes.test.js'), 'utf8');
const firstTest = legacySource.indexOf("\ntest('");
assert.ok(firstTest > 0, 'shared harness remains before the first legacy test');
const helperContext = {require, __dirname, console, Buffer, URL, URLSearchParams};
vm.runInNewContext(legacySource.slice(0, firstTest) + '\nglobalThis.shared = {harness, singleClick, doubleClick, pointerAt, dragMarks, assertNoPrivateKeys, GESTURE_WAIT};', helperContext);
const {harness, singleClick, doubleClick, pointerAt, dragMarks, assertNoPrivateKeys, GESTURE_WAIT} = helperContext.shared;
const makeHarness = options => harness({mode:'survival', survival:true, survivalUI:true, ...options});

function fixture({count=4, status='playing', who=0, tabbyEnabled=false, capacity=4, engineOptions={}, ...options}={}) {
  const h = makeHarness(options), engine = h.context.CatSurvival;
  const authority = engine.create({tabbyEnabled,capacity}, Array.from({length:count},(_,index)=>({
    id:`p${index+1}`, nickname:index ? `Friend ${index}` : 'Test Cat', avatar:index%6, ready:true, connected:true
  })), {now:h.now(), ...(typeof engineOptions === 'function' ? engineOptions(h) : engineOptions)});
  if (status !== 'lobby') {
    assert.equal(engine.start(authority,h.now()),true);
    if (status !== 'countdown') { h.advance(3000); engine.advance(authority,h.now()); }
  }
  h.state.role = who ? 'guest' : 'host'; h.state.you = who;
  h.state.survivalPlayerId = authority.players[who].id;
  h.state.survivalLinkStatus = who ? 'connected' : 'hosting';
  const submissions = [];
  h.state.survivalSession = {
    submit(action) {
      submissions.push(json(action));
      const result=engine.act(authority,h.state.survivalPlayerId,action,h.now());
      return h.state.role==='host' ? {...result,actionId:action.actionId} : action.actionId;
    },
    getState:()=>engine.publicGame(authority,h.now()),
    start:()=>engine.start(authority,h.now()),
    close() {}
  };
  function sync() { h.applySurvivalSnapshot(engine.publicGame(authority,h.now())); h.renderSurvival(); }
  sync(); h.enableRendering();
  return {h, engine, authority, sync, submissions, grid:()=>h.get('#survivalBoard')};
}

function noSurvivalSecrets(value) {
  assertNoPrivateKeys(value);
  const raw = JSON.stringify(value);
  assert.doesNotMatch(raw, /"(?:credential|token|opportunities|boardActions|hp|combo|damage)"\s*:/);
}

// Deterministic in-process fake PeerJS endpoints. No network request, signalling
// server, STUN/TURN, NAT traversal, browser rendering or human client is tested.
function fakePeerRoom(count=4,{seed=0x1873,roomCode='CAT-1234'}={}) {
  const peers=new Map(),jobs=[],connections=[],clients=[],unreachable=new Set(),peerInstances=[],held=[],holdTypes=new Set();let serial=0;
  class Connection extends EventEmitter {
    constructor(peer){super();this.peer=peer;this.open=false;this.sent=[];connections.push(this);}
    send(message){if(!this.open)throw Error('closed fake connection');const value=json(message);this.sent.push(value);const deliver=()=>{if(this.other.open)this.other.emit('data',value);};if(holdTypes.has(value.type))held.push({value,deliver});else jobs.push(deliver);}
    close(){if(!this.open)return;this.open=false;this.emit('close');jobs.push(()=>{if(this.other.open){this.other.open=false;this.other.emit('close');}});}
  }
  class Peer extends EventEmitter {
    constructor(id){super();this.id=id||`fake-guest-${++serial}`;this.open=false;this.destroyed=false;peerInstances.push(this);peers.set(this.id,this);jobs.push(()=>{if(!this.destroyed){this.open=true;this.emit('open',this.id);}});}
    connect(id){
      const remote=peers.get(id),client=new Connection(id),server=new Connection(this.id);client.other=server;server.other=client;
      if(!remote||remote.destroyed||unreachable.has(id)){jobs.push(()=>client.emit('error',{type:'peer-unavailable'}));return client;}
      jobs.push(()=>{remote.emit('connection',server);client.open=server.open=true;client.emit('open');server.emit('open');});return client;
    }
    destroy(){if(this.destroyed)return;this.destroyed=true;this.open=false;peers.delete(this.id);this.emit('close');}
  }
  function flush(){let turns=0;while(jobs.length){assert.ok(++turns<10000,'fake network must settle');jobs.shift()();}}
  function client(){const h=makeHarness({seed:seed+clients.length});h.context.Peer=Peer;h.enableRendering();clients.push(h);return h;}
  const host=client();host.get('#survivalTabby').checked=false;
  host.startSurvivalHost({room:roomCode});flush();
  function add(options={}){
    const guest=client();if(options.session)for(const [key,value]of Object.entries(options.session))guest.context.sessionStorage.setItem(key,value);
    guest.get('#roomInput').value=host.state.room;guest.startPeerGuest();flush();return guest;
  }
  for(let i=1;i<count;i++)add();
  function tick(ms){for(let remaining=ms;remaining>0;){const step=Math.min(100,remaining);clients.forEach(h=>h.tick(step));flush();remaining-=step;}}
  tick(100);
  function start(){assert.equal(host.survivalStart(),true);flush();tick(3000);}
  function release(type){holdTypes.delete(type);for(let i=held.length-1;i>=0;i--)if(held[i].value.type===type)jobs.unshift(held.splice(i,1)[0].deliver);flush();}
  function close(){host.disposeSurvivalRoom('test-cleanup');flush();for(const h of clients.slice(1))h.disposeSurvivalRoom('test-cleanup');flush();}
  return {host,clients,connections,unreachable,peerInstances,holdTypes,held,add,flush,tick,start,release,close};
}

test('survival is the sixth optional mode and loads after its existing shared controllers', () => {
  const html = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const options = [...html.match(/<select id="gameMode">([\s\S]*?)<\/select>/)[1].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(options.map(match=>match[1]).sort(), ['basic','battle','coop','items','survival','treasure']);
  assert.deepEqual(options.filter(match=>/\bselected\b/.test(match[2])).map(match=>match[1]), ['battle']);
  assert.match(html, /六種模式/);
  const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(match=>match[1]);
  for (const [before,after] of [['battle-engine.js','survival-engine.js'],['survival-engine.js','survival-session.js'],['survival-session.js','app.js'],['cell-gestures.js','app.js'],['board-strokes.js','app.js'],['app.js','survival-app.js'],['battle-ui.js','survival-ui.js'],['survival-app.js','survival-ui.js']]) {
    assert.ok(scripts.includes(before)&&scripts.includes(after)&&scripts.indexOf(before)<scripts.indexOf(after),`${before} must precede ${after}`);
  }
});

test('survival authored shell has unique IDs and contains every quota and gesture instruction', () => {
  const html = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const ui = fs.readFileSync(path.join(ROOT,'survival-ui.js'),'utf8');
  const ids = [...(html+'\n'+ui).matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'setup and dynamically authored survival shell cannot reuse IDs');
  for (const required of ['survivalLobby','survivalBoard','survivalLock','survivalGestureHint','survivalScoreList','survivalFollow','survivalSpectatorNotice','survivalResult']) assert.ok(ids.includes(required));
  assert.match(ui,/單點.*私人標記.*快速雙點.*長按拖曳.*右鍵不操作/);
  for (const quota of [4,10,16,24]) assert.match(ui,new RegExp(`<strong>${quota} <small>隻`));
  assert.match(html+'\n'+ui,/2／4／6／8 秒/,'the shared help retains the escalating miss-lock rule');
  assert.doesNotMatch(html+'\n'+ui,/id="survival(?:Capacity|ReadyButton)"/);
  assert.match(ui,/立即開始/);assert.match(ui,/180 秒/);
  assert.doesNotMatch(ui, /class="[^"\n]*(?:battle-hp|battle-combo|attack-damage)/);
});

for (const count of [2,3,4]) test(`fake DOM survival lobby has ${count} players, four fixed seats and a host immediate start control`, () => {
  const {h,authority,engine,sync} = fixture({count,status:'lobby'});
  noSurvivalSecrets(h.state.game);
  assert.equal(h.get('#survivalSeats').innerHTML.match(/class="survival-seat /g).length,4);
  assert.equal(h.get('#survivalCapacityBadge').textContent,`${count}／4 位`);
  assert.equal(h.get('#survivalStartButton').disabled,false);
  assert.equal(h.get('#survivalStartButton').classList.contains('hidden'),false);
  assert.equal(h.get('#survivalLobbyClock').textContent,'3:00');
  assert.match(h.get('#survivalLobbyNotice').textContent,new RegExp(`${count} 位貓友已入座`));
  for(const player of authority.players.slice(1))engine.setConnected(authority,player.id,false,h.now());sync();
  assert.equal(h.get('#survivalStartButton').disabled,true);
  assert.equal(h.get('#survivalStartButton').classList.contains('hidden'),true);
  assert.equal(h.get('#survivalLobbyClock').textContent,'不計時');
  assert.match(h.get('#survivalLobbyNotice').textContent,/不足 2 人/);
});

test('fake DOM survival host waits alone and guests never get the host immediate start control', () => {
  const {h,authority,engine,sync} = fixture({count:1,status:'lobby'});
  assert.equal(h.get('#survivalStartButton').disabled,true);
  assert.equal(h.get('#survivalLobbyClock').textContent,'不計時');
  engine.addPlayer(authority,{id:'p2',nickname:'Friend',connected:true,ready:true},h.now());sync();
  h.state.role='guest'; h.state.you=1; h.state.survivalPlayerId=authority.players[1].id; sync();
  assert.equal(h.get('#survivalStartButton').classList.contains('hidden'),true);
});

test('fake DOM countdown displays the shared host deadline and blocks all input', () => {
  const {h,grid} = fixture({status:'countdown'});
  assert.equal(h.get('#survivalCountdown').classList.contains('hidden'),false);
  assert.equal(h.get('#survivalCountdown strong').textContent,'3');
  h.advance(1000); h.updateSurvivalTimers();
  assert.equal(h.get('#survivalCountdown strong').textContent,'2');
  assert.equal(h.survivalCanMark(h.state.game),false);
  assert.equal(h.get('#survivalStartButton').disabled,true);
  assert.equal(grid().children.length,0);
});

test('fake DOM scoreboard uses cumulative cats and errors with private notes only on the own board', () => {
  const {h,authority,sync,grid} = fixture();
  authority.players[0].score=17; authority.players[0].errors=3;
  authority.boards[0].number=4; h.state.notes.add(5); sync();
  assert.equal(h.get('#survivalMainScore').textContent,'17');
  assert.equal(h.get('#survivalMainErrors').textContent,'3');
  assert.match(h.get('#survivalBoardNumber').textContent,/第 4 盤/);
  assert.equal(grid().children.length,36);
  assert.equal(grid().children[5].classList.contains('note'),true);
  assert.equal(h.get('#survivalMini').children.length,36);
  assert.equal(h.get('#survivalMini').children.some(cell=>cell.classList.contains('note')),false);
  assert.match(h.get('#survivalScoreList').innerHTML,/>17<\/b><small>／3/);
  noSurvivalSecrets(h.state.game);
});

test('fake DOM last minute removes quota elimination UI and keeps the five-minute clock', () => {
  const {h,authority,engine,sync} = fixture();
  authority.players.forEach(player=>{player.score=24;});
  h.advance(240000); engine.advance(authority,h.now()); sync();
  assert.equal(h.state.game.status,'playing');
  assert.equal(h.get('#survivalMinuteLabel').textContent,'最後一分鐘');
  assert.equal(h.get('#survivalClock').textContent,'1:00');
  assert.equal(h.get('#survivalQuotaCard').classList.contains('is-final'),true);
  assert.equal(h.get('#survivalQuotaMeter').classList.contains('hidden'),true);
  assert.match(h.get('#survivalQuotaTime').textContent,/不再設配額/);
  assert.match(h.get('#survivalQuotaRemaining').textContent,/比貓數，再比猜錯較少/);
});

test('fake DOM quota warnings use cumulative progress and the current host minute', () => {
  const {h,authority,engine,sync} = fixture();
  authority.players.forEach(player=>{player.score=6;});
  h.advance(60000); engine.advance(authority,h.now()); sync();
  assert.match(h.get('#survivalQuotaTarget').textContent,/6\s*\/\s*10/);
  assert.match(h.get('#survivalQuotaRemaining').textContent,/還差 4 隻/);
  assert.equal(h.get('#survivalQuotaMeter').getAttribute('aria-valuenow'),'6');
  assert.equal(h.get('#survivalQuotaMeter').getAttribute('aria-valuemax'),'10');
  h.advance(40000); h.updateSurvivalTimers();
  assert.equal(h.get('#survivalQuotaWarning').classList.contains('hidden'),false);
  assert.match(h.get('#survivalQuotaWarning').textContent,/20 秒.*差 4 隻/);
  h.advance(5000); h.updateSurvivalTimers();
  assert.match(h.get('#survivalQuotaWarning').textContent,/15 秒.*差 4 隻/);
});

test('fake DOM eliminated players can switch read-only views without exposing private notes', () => {
  const {h,authority,sync,grid} = fixture();
  h.state.notes.add(5); authority.players[0].status='eliminated'; authority.players[0].reason='quota'; sync();
  assert.match(h.get('#survivalSpectatorNotice').textContent,/觀戰.*未達/);
  assert.equal(grid().getAttribute('aria-readonly'),'true');
  assert.equal(grid().children.every(cell=>cell.tagName==='SPAN'&&cell.getAttribute('aria-disabled')==='true'),true);
  assert.equal(grid().children.some(cell=>cell.classList.contains('note')),false);
  assert.equal(h.survivalCanMark(h.state.game),false);
  const before=json(h.state.game),notes=[...h.state.notes];
  doubleClick(grid().children[5]); singleClick(h,grid().children[6]);
  assert.deepEqual(json(h.state.game),before); assert.deepEqual([...h.state.notes],notes);
  h.get('#survivalFollow').dispatchEvent({type:'change',target:{value:'2'}});
  assert.equal(h.get('#survivalMainName').textContent,'Friend 2');
  assert.equal(grid().dataset.player,'2');
});

test('fake DOM shared champions and no-survivor results are explicit', () => {
  const {h,authority,engine,sync} = fixture();
  authority.players.forEach(player=>{player.score=30;player.errors=2;});
  h.advance(300000); engine.advance(authority,h.now()); sync();
  assert.equal(h.get('#survivalResult').classList.contains('hidden'),false);
  assert.match(h.get('#survivalResultTitle').textContent,/4 位貓友，共享冠軍/);
  assert.match(h.get('#survivalResultCopy').textContent,/貓數與猜錯次數完全相同/);
  assert.equal(h.get('#survivalWinners').innerHTML.match(/survival-winner-avatar/g).length,4);
  const none=fixture();none.h.advance(60000);none.engine.advance(none.authority,none.h.now());none.sync();
  assert.equal(none.h.state.game.status,'finished');
  assert.equal(none.h.get('#survivalResultTitle').textContent,'這一局，沒有冠軍');
});

test('fake DOM reconnect blocks controls without resetting the running clock or declaring a winner', () => {
  const {h,grid} = fixture({who:1});
  h.state.survivalLinkStatus='reconnecting';h.state.survivalReconnectUntil=h.now()+15000;h.renderSurvival();
  assert.equal(h.survivalCanMark(h.state.game),false);
  assert.equal(grid().children.every(cell=>cell.disabled),true);
  assert.equal(h.get('#survivalLock').classList.contains('hidden'),false);
  assert.match(h.get('#survivalConnectionNotice').textContent,/場上時間仍會繼續/);
  assert.equal(h.get('#survivalRetry').classList.contains('hidden'),false);
  h.advance(5000);h.updateSurvivalTimers();
  assert.equal(h.get('#survivalClock').textContent,'4:55');
  assert.match(h.get('#survivalConnectionNotice').textContent,/10 秒/);
  assert.equal(h.state.game.winner,null);
});

test('survival public host state is detached from authority, answers and local private marks', () => {
  const {h,authority,grid,submissions} = fixture();
  assert.notStrictEqual(h.state.game,authority);
  assert.notStrictEqual(h.state.game.boards[0],authority.boards[0]);
  const before=json(h.state.game);
  singleClick(h,grid().children[5]);
  assert.equal(h.state.notes.has(5),true);
  assert.equal(submissions.length,0);
  assert.deepEqual(json(h.state.game),before);
  noSurvivalSecrets(h.state.game);
  assert.equal(h.context.CatSurvival.act(h.state.game,'p1',{type:'guess',index:0,boardId:h.state.game.boards[0].puzzle.id,actionId:'forged'},h.now()).reason,'not-authority');
});

for (const pointerType of ['mouse','touch','pen']) test(`survival ${pointerType} single marks privately and a rapid double reveals exactly once`, () => {
  const {h,authority,grid,submissions} = fixture();
  const index=authority.boards[0].puzzle.solution[0],cell=grid().children[index];
  pointerAt(cell,'pointerdown',cell,{pointerType});pointerAt(cell,'pointerup',cell,{pointerType});cell.dispatchEvent({type:'click',detail:1,button:0});
  assert.equal(h.state.notes.has(index),false);h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index),true);assert.equal(submissions.length,0);
  h.tick(GESTURE_WAIT);doubleClick(grid().children[index],{pointerType});
  assert.equal(submissions.length,1);
  assert.deepEqual(json(authority.boards[0].found),[index]);
  assert.equal(h.state.notes.has(index),false);h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index),false);assert.equal(submissions.length,1);
  noSurvivalSecrets(h.state.game);
});

test('survival native mouse double at 350 ms restores the first private toggle and reveals once', () => {
  const {h,authority,grid,submissions} = fixture();
  const index=authority.boards[0].puzzle.solution[0],cell=grid().children[index];
  pointerAt(cell,'pointerdown');pointerAt(cell,'pointerup');cell.dispatchEvent({type:'click',detail:1,button:0});
  h.tick(350);assert.equal(h.state.notes.has(index),true);
  pointerAt(cell,'pointerdown');pointerAt(cell,'pointerup');cell.dispatchEvent({type:'click',detail:2,button:0});cell.dispatchEvent({type:'dblclick',detail:2,button:0});
  assert.equal(submissions.length,1);assert.equal(h.state.notes.has(index),false);
  assert.equal(authority.boards[0].found.includes(index),true);
});

for (const key of ['Enter',' ','Spacebar']) test(`survival keyboard ${JSON.stringify(key)} uses the shared single/double input and ignores repeat`, () => {
  const {h,authority,grid,submissions} = fixture();
  const index=authority.boards[0].puzzle.solution[0];
  const activate=(repeat=false)=>{const cell=grid().children[index];cell.dispatchEvent({type:'keydown',key,repeat});if(!repeat)cell.dispatchEvent({type:'click',detail:0,button:0});};
  activate();h.tick(GESTURE_WAIT);assert.equal(h.state.notes.has(index),true);
  activate(true);assert.equal(submissions.length,0);
  h.tick(GESTURE_WAIT);activate();activate();
  assert.equal(submissions.length,1);assert.equal(authority.boards[0].found.includes(index),true);assert.equal(h.state.notes.has(index),false);
});

for (const pointerType of ['mouse','touch','pen']) test(`survival ${pointerType} long-hold drag adds private marks without erasing or revealing`, () => {
  const {h,authority,grid,submissions} = fixture();
  h.state.notes.add(2);h.renderSurvival();
  const before=json(h.state.game);
  dragMarks(h,grid,{from:0,to:5,pointerType});h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes].sort((a,b)=>a-b),[0,1,2,3,4,5]);
  assert.equal(submissions.length,0);assert.equal(authority.boards[0].found.length,0);
  assert.deepEqual(json(h.state.game),before);
  assert.equal(h.state.boardStrokes.state().pointerCount,0);
});

test('survival right button and context menu are no-ops and leave the browser menu available', () => {
  const {h,grid,submissions} = fixture();
  const cell=grid().children[5],before=json(h.state.game);
  pointerAt(cell,'pointerdown',cell,{button:2,buttons:2});pointerAt(cell,'pointerup',cell,{button:2,buttons:0});
  cell.dispatchEvent({type:'click',button:2,detail:1});const event={type:'contextmenu',button:2};cell.dispatchEvent(event);h.tick(GESTURE_WAIT);
  assert.notEqual(event.defaultPrevented,true);assert.equal(h.state.notes.size,0);assert.equal(submissions.length,0);assert.deepEqual(json(h.state.game),before);
});

for (const cancellation of ['pointercancel','blur','visibility','disconnect','elimination']) test(`survival ${cancellation} invalidates a pending private single before it can commit`, () => {
  const {h,authority,sync,grid,submissions} = fixture();
  const cell=grid().children[5];pointerAt(cell,'pointerdown');
  if(cancellation!=='pointercancel'){pointerAt(cell,'pointerup');cell.dispatchEvent({type:'click',button:0,detail:1});}
  if(cancellation==='visibility'){h.context.document.hidden=true;h.dispatchDocument('visibilitychange');}
  else if(cancellation==='disconnect'){h.state.survivalLinkStatus='reconnecting';h.renderLegacy();}
  else if(cancellation==='elimination'){authority.players[0].status='eliminated';authority.players[0].reason='quota';sync();}
  else if(cancellation==='blur')h.dispatchWindow('blur');
  else {cell.dispatchEvent({type:cancellation,pointerId:7});pointerAt(cell,'pointerup');cell.dispatchEvent({type:'click',button:0,detail:1});}
  h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.size,0);assert.equal(submissions.length,0);
});

test('survival miss locks disable single, double, keyboard and drag until the authoritative deadline', () => {
  const {h,authority,sync,grid,submissions} = fixture();
  const miss=authority.boards[0].puzzle.regions.findIndex((_,index)=>!authority.boards[0].puzzle.solution.includes(index));
  doubleClick(grid().children[miss]);assert.equal(submissions.length,1);
  const board=authority.boards[0],target=authority.boards[0].puzzle.solution[0];
  assert.equal(board.cooldownDuration,2000);assert.equal(h.survivalMissLocked(h.state.game),true);
  assert.equal(grid().children.every(cell=>cell.disabled),true);
  assert.equal(h.get('#survivalLock').classList.contains('hidden'),false);
  assert.match(h.get('#survivalLockCopy').textContent,/翻格與私人標記都暫停/);
  singleClick(h,grid().children[target]);doubleClick(grid().children[target]);
  const cell=grid().children[target];cell.dispatchEvent({type:'keydown',key:'Enter',repeat:false});cell.dispatchEvent({type:'click',detail:0});
  dragMarks(h,grid,{from:0,to:5});h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.size,0);assert.equal(submissions.length,1);
  h.advance(board.cooldownUntil-h.now());sync();
  assert.equal(h.survivalMissLocked(h.state.game),false);assert.equal(h.get('#survivalLock').classList.contains('hidden'),true);
  singleClick(h,grid().children[target]);assert.equal(h.state.notes.has(target),true);
});

test('survival hit cooldown allows notes while blocking additional reveals', () => {
  const {h,authority,grid,submissions} = fixture();
  const [first,next,note]=authority.boards[0].puzzle.solution;
  doubleClick(grid().children[first]);doubleClick(grid().children[next]);
  assert.equal(submissions.length,1);assert.equal(h.survivalMissLocked(h.state.game),false);
  assert.equal(h.survivalCanMark(h.state.game),true);
  singleClick(h,grid().children[note]);assert.equal(h.state.notes.has(note),true);
  assert.equal(submissions.length,1);
});

test('survival rollover clears only own notes and invalidates an old cell gesture', () => {
  const {h,authority,engine,sync,grid,submissions} = fixture();
  const oldBoard=authority.boards[0],last=oldBoard.puzzle.solution.at(-1),oldCell=grid().children[last];
  h.state.notes.add(last);h.state.notes.add(5);
  for(const index of oldBoard.puzzle.solution.slice(0,-1)){
    engine.act(authority,'p1',{type:'guess',index,boardId:oldBoard.puzzle.id,actionId:`setup-${index}`},h.now());h.advance(300);
  }
  sync();pointerAt(oldCell,'pointerdown');
  assert.equal(engine.act(authority,'p1',{type:'guess',index:last,boardId:oldBoard.puzzle.id,actionId:'rollover'},h.now()).accepted,true);sync();
  assert.notEqual(authority.boards[0].puzzle.id,oldBoard.puzzle.id);
  assert.equal(h.state.notes.size,0);
  const before=json(h.state.game);pointerAt(oldCell,'pointerup');oldCell.dispatchEvent({type:'click',button:0,detail:1});h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.size,0);assert.deepEqual(json(h.state.game),before);assert.equal(submissions.length,0);
});

test('survival other-player rollover preserves local notes and stable local board nodes', () => {
  const {h,authority,engine,sync,grid} = fixture();
  h.state.notes.add(5);h.renderSurvival();const cell=grid().children[5];
  const board=authority.boards[1];
  for(const index of board.puzzle.solution){engine.act(authority,'p2',{type:'guess',index,boardId:board.puzzle.id,actionId:`other-${index}`},h.now());h.advance(300);}
  sync();assert.notEqual(authority.boards[1].puzzle.id,board.puzzle.id);
  assert.equal(h.state.notes.has(5),true);assert.strictEqual(grid().children[5],cell);assert.equal(cell.classList.contains('note'),true);
});

test('survival guest sends one scoped guess and waits for public authority before removing a note', () => {
  const {h,authority,grid,submissions,sync} = fixture({who:1});
  const index=authority.boards[1].puzzle.solution[0];h.state.notes.add(index);h.renderSurvival();
  doubleClick(grid().children[index]);assert.equal(submissions.length,1);
  assert.deepEqual(Object.keys(submissions[0]).sort(),['actionId','boardId','index','type']);
  assert.equal(h.state.notes.has(index),true);assert.equal(h.state.game.boards[1].found.includes(index),false);
  assert.ok(h.state.pendingAction);
  doubleClick(grid().children[index]);assert.equal(submissions.length,1);
  sync();assert.equal(h.state.notes.has(index),false);assert.equal(h.state.pendingAction,null);assert.equal(h.state.game.boards[1].found.includes(index),true);
});

for(const count of [2,3,4])test(`fake PeerJS app ${count}-seat room confirms generic joins and lets only the host start immediately`,()=>{
  const room=fakePeerRoom(count);
  try{
    assert.equal(room.host.state.game.players.length,count);
    assert.equal(room.host.state.survivalLinkStatus,'hosting');
    assert.equal(room.host.state.game.eligibleCount,count);assert.equal(room.host.state.game.settings.capacity,4);
    for(const [index,client] of room.clients.entries()){
      assert.equal(client.state.game.settings.mode,'survival');assert.equal(client.state.you,index);
      assert.equal(client.state.survivalPlayerId,`p${index+1}`);assert.equal(client.state.game.players.length,count);
      noSurvivalSecrets(client.state.game);
      if(index){assert.equal(client.state.survivalLinkStatus,'connected');assert.equal(client.survivalStart(),false);}
    }
    assert.equal(room.host.survivalStart(),true);room.flush();room.tick(100);
    const startAt=room.host.state.game.startAt;
    for(const client of room.clients){assert.equal(client.state.game.status,'countdown');assert.equal(client.state.game.startAt,startAt);assert.equal(client.survivalCanMark(),false);}
    room.tick(3000);
    for(const client of room.clients){assert.equal(client.state.game.status,'playing');assert.equal(client.state.game.startAt,startAt);assert.equal(client.survivalCanMark(),true);}
  }finally{room.close();}
});

test('fake PeerJS app enforces capacity and rejects new players once the match starts',()=>{
  const room=fakePeerRoom(4);
  try{
    const extra=room.add();room.tick(100);
    assert.equal(room.host.state.game.players.length,4);
    assert.equal(extra.state.survivalLinkStatus,'closed');assert.match(extra.get('#setupStatus').textContent,/已滿/);
    assert.equal(room.host.survivalStart(),true);room.flush();room.tick(3000);
    const late=room.add();room.tick(100);
    assert.equal(room.host.state.game.players.length,4);assert.equal(late.state.survivalLinkStatus,'closed');assert.match(late.get('#setupStatus').textContent,/已開始/);
  }finally{room.close();}
});

test('fake PeerJS app credentials are room/game scoped and never appear in invites or public snapshots',async()=>{
  const room=fakePeerRoom(4);
  try{
    const tokens=room.clients.slice(1).map(h=>JSON.parse(h.context.sessionStorage.getItem('catSurvivalSeats'))['CAT-1234']);
    assert.equal(new Set(tokens.map(value=>value.credential)).size,3);
    for(const seat of tokens){assert.equal(seat.gameId,room.host.state.game.id);assert.match(seat.credential,/^[a-f0-9]{48}$/);}
    for(const h of room.clients){
      noSurvivalSecrets(h.state.game);assert.equal(h.context.sessionStorage.getItem('p2pHost'),null);assert.equal(h.context.sessionStorage.getItem('p2pGuest'),null);
      let invite;h.context.navigator.clipboard.writeText=async value=>{invite=value;};await h.get('#copyInvite').onclick();
      assert.equal(invite,'https://example.test/game?room=CAT-1234');
      assert.equal(new URL(invite).searchParams.size,1);
      for(const seat of tokens){assert.equal(invite.includes(seat.credential),false);assert.equal(JSON.stringify(h.state.game).includes(seat.credential),false);}
    }
    const publicPackets=room.connections.flatMap(connection=>connection.sent).filter(message=>['offer','snapshot','ack'].includes(message.type));
    for(const packet of publicPackets)for(const seat of tokens)assert.equal(JSON.stringify(packet).includes(seat.credential),false);
  }finally{room.close();}
});

test('fake PeerJS app reclaims its same seat and private notes after a short disconnect',()=>{
  const room=fakePeerRoom(4);
  try{
    room.start();const guest=room.clients[1],id=guest.state.survivalPlayerId,oldBoard=guest.state.game.boards[guest.state.you].puzzle.id;
    singleClick(guest,guest.get('#survivalBoard').children[5]);assert.equal(guest.state.notes.has(5),true);
    const connection=room.connections.find(value=>value.peer===room.host.state.peer.id&&value.open);
    connection.close();room.flush();room.tick(100);
    assert.equal(guest.state.survivalLinkStatus,'reconnecting');assert.equal(guest.survivalCanMark(),false);
    assert.equal(guest.survivalReconnect(),true);room.flush();room.tick(100);
    assert.equal(guest.state.survivalPlayerId,id);assert.equal(guest.state.you,1);assert.equal(guest.state.survivalLinkStatus,'connected');
    assert.equal(guest.state.game.boards[1].puzzle.id,oldBoard);assert.equal(guest.state.notes.has(5),true);
    assert.equal(room.host.state.game.players.length,4);assert.equal(room.host.state.game.players[1].connected,true);
    noSurvivalSecrets(guest.state.game);
  }finally{room.close();}
});

test('fake PeerJS app host departure aborts guests without selecting a champion',()=>{
  const room=fakePeerRoom(4);
  try{
    room.start();room.host.disposeSurvivalRoom('host-left');room.flush();
    for(const guest of room.clients.slice(1)){
      assert.equal(guest.state.game.status,'aborted');assert.equal(guest.state.game.winner,null);assert.deepEqual(json(guest.state.game.winnerIds),[]);
      assert.equal(guest.survivalCanMark(),false);assert.match(guest.get('#survivalResultCopy').textContent,/不判勝負/);
    }
  }finally{room.close();}
});

for(const cancellation of ['pointercancel','lostpointercapture','blur','visibility','disconnect','elimination'])test(`survival ${cancellation} stops an active private stroke and suppresses its release click`,()=>{
  const {h,authority,sync,grid,submissions}=fixture(),cell=grid().children[0];
  pointerAt(cell,'pointerdown');h.tick(250);pointerAt(cell,'pointermove',grid().children[1]);
  assert.deepEqual([...h.state.notes],[0,1]);
  if(['pointercancel','lostpointercapture'].includes(cancellation))pointerAt(cell,cancellation);
  if(cancellation==='blur')h.dispatchWindow('blur');
  if(cancellation==='visibility'){h.context.document.hidden=true;h.dispatchDocument('visibilitychange');}
  if(cancellation==='disconnect'){h.state.survivalLinkStatus='reconnecting';h.renderLegacy();}
  if(cancellation==='elimination'){authority.players[0].status='eliminated';sync();}
  const notes=[...h.state.notes],before=json(h.state.game);
  pointerAt(cell,'pointermove',grid().children[5]);pointerAt(cell,'pointerup',grid().children[5]);cell.dispatchEvent({type:'click',button:0,detail:1});h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes],notes);assert.deepEqual(json(h.state.game),before);assert.equal(submissions.length,0);
});

test('survival miss lock cancels an active stroke and holding through expiry does not restart it',()=>{
  const {h,authority,engine,sync,grid,submissions}=fixture(),cell=grid().children[0];
  pointerAt(cell,'pointerdown',cell,{pointerType:'touch'});h.tick(250);pointerAt(cell,'pointermove',grid().children[1],{pointerType:'touch'});
  const board=authority.boards[0],miss=board.puzzle.regions.findIndex((_,index)=>index>5&&!board.puzzle.solution.includes(index));
  assert.equal(engine.act(authority,'p1',{type:'guess',index:miss,boardId:board.puzzle.id,actionId:'server-miss'},h.now()).accepted,true);sync();
  const notes=[...h.state.notes];h.tick(2000);h.updateSurvivalTimers();
  pointerAt(cell,'pointermove',grid().children[5],{pointerType:'touch'});pointerAt(cell,'pointerup',grid().children[5],{pointerType:'touch'});cell.dispatchEvent({type:'click',button:0,detail:1});h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes],notes);assert.equal(submissions.length,0);
  dragMarks(h,grid,{from:6,to:11,pointerType:'touch'});assert.equal(h.state.notes.has(11),miss!==11);
});

test('fake PeerJS app ignores a stale-game credential and maps invalid or occupied seats to clear join errors',()=>{
  const first=fakePeerRoom(2),saved=first.clients[1].context.sessionStorage.getItem('catSurvivalSeats'),oldGame=first.host.state.game.id;
  first.close();
  const room=fakePeerRoom(1,{seed:0x7722});
  try{
    assert.notEqual(room.host.state.game.id,oldGame);
    const returning=room.add({session:{catSurvivalSeats:saved}});room.tick(100);
    assert.equal(returning.state.survivalLinkStatus,'connected');assert.equal(returning.state.you,1);
    const credential=JSON.parse(returning.context.sessionStorage.getItem('catSurvivalSeats'))['CAT-1234'];
    assert.equal(credential.gameId,room.host.state.game.id);
    const invalid=room.add({session:{catSurvivalSeats:JSON.stringify({'CAT-1234':{gameId:room.host.state.game.id,credential:'a'.repeat(48)}})}});room.tick(100);
    assert.equal(invalid.state.survivalLinkStatus,'closed');assert.match(invalid.get('#setupStatus').textContent,/無法恢復原座位/);
    const occupied=room.add({session:{catSurvivalSeats:returning.context.sessionStorage.getItem('catSurvivalSeats')}});room.tick(100);
    assert.equal(occupied.state.survivalLinkStatus,'closed');assert.match(occupied.get('#setupStatus').textContent,/另一個連線/);
    assert.equal(room.host.state.game.players.length,2);
  }finally{room.close();}
});

test('fake PeerJS app failed automatic reconnects stop at 15 seconds and late return is a spectator',()=>{
  const room=fakePeerRoom(4);
  try{
    room.start();const guest=room.clients[1],hostPeer=room.host.state.peer.id,seat=guest.state.survivalPlayerId,credential=guest.context.sessionStorage.getItem('catSurvivalSeats');
    room.unreachable.add(hostPeer);
    room.connections.find(connection=>connection.peer===hostPeer&&connection.open).close();room.flush();
    const startedAt=room.host.state.game.startedAt;
    room.tick(14900);assert.equal(guest.state.survivalLinkStatus,'reconnecting');
    room.tick(200);
    assert.equal(guest.state.survivalLinkStatus,'aborted');assert.equal(guest.state.game.status,'aborted');assert.equal(guest.state.game.winner,null);
    assert.equal(room.host.state.game.status,'playing');assert.equal(room.host.state.game.startedAt,startedAt);
    assert.equal(room.host.state.game.players[1].status,'retired');
    assert.equal(guest.context.sessionStorage.getItem('catSurvivalSeats'),credential,'a retired match seat keeps its spectator credential');
    room.unreachable.delete(hostPeer);assert.equal(guest.survivalReconnect(),true);room.flush();room.tick(100);
    assert.equal(guest.state.survivalPlayerId,seat);assert.equal(guest.state.game.players[1].status,'retired');
    assert.equal(guest.context.sessionStorage.getItem('catSurvivalSeats'),credential);
    assert.equal(guest.survivalCanMark(),false);assert.equal(guest.get('#survivalBoard').getAttribute('aria-readonly'),'true');
    assert.match(guest.get('#survivalSpectatorNotice').textContent,/觀戰/);
  }finally{room.close();}
});

test('survival room disposal cancels pending action timers and gestures',()=>{
  const {h,authority,grid}=fixture({who:1});
  doubleClick(grid().children[authority.boards[1].puzzle.solution[0]]);
  const actionTimers=[...h.state.survivalActionTimers];assert.equal(actionTimers.length,1);assert.ok(h.state.pendingAction);
  h.disposeSurvivalRoom('test-leave');
  assert.equal(h.state.survivalActionTimers.size,0);assert.equal(h.state.pendingAction,null);
  assert.equal(actionTimers.some(timer=>h.timers.has(timer)),false);
  assert.equal(h.state.survivalSession,null);assert.equal(h.state.survivalLinkStatus,'closed');
});

for(const retry of ['join','retry'])test(`fake PeerJS app expired lobby seat forgets only its credential and explicit ${retry} obtains a new seat`,()=>{
  const room=fakePeerRoom(4);
  try{
    const guest=room.clients[1],oldSeat=guest.state.survivalPlayerId,gameId=guest.state.game.id,hostPeer=room.host.state.peer.id;
    const saved=JSON.parse(guest.context.sessionStorage.getItem('catSurvivalSeats'));
    saved['CAT-9876']={gameId:'another-game',credential:'b'.repeat(48)};
    guest.context.sessionStorage.setItem('catSurvivalSeats',JSON.stringify(saved));
    room.unreachable.add(hostPeer);room.connections.find(connection=>connection.peer===hostPeer&&connection.open).close();room.flush();room.tick(15100);
    assert.equal(room.host.state.game.status,'lobby');assert.equal(room.host.state.game.players.length,3);
    assert.equal(room.host.state.game.players.some(player=>player.id===oldSeat),false);
    assert.equal(room.clients[2].state.survivalPlayerId,'p3');assert.equal(room.clients[2].state.you,1,'remaining players remap their numeric seat from stable IDs');
    room.unreachable.delete(hostPeer);
    if(retry==='join')guest.startPeerGuest();else assert.equal(guest.survivalReconnect(),true);
    room.flush();room.tick(100);
    assert.equal(guest.state.survivalLinkStatus,'closed');assert.match(guest.get('#setupStatus').textContent,/原座位已釋出/);
    assert.equal(guest.state.survivalReconnectUntil,null);assert.equal(guest.state.survivalReconnectTimer,null);assert.equal(guest.state.survivalRecoveryTimer,null);
    const remaining=JSON.parse(guest.context.sessionStorage.getItem('catSurvivalSeats'));
    assert.equal(remaining['CAT-1234'],undefined);assert.deepEqual(remaining['CAT-9876'],saved['CAT-9876']);
    room.tick(2000);assert.equal(room.host.state.game.players.length,3,'a rejected stale seat does not silently create a new player');
    if(retry==='join')guest.startPeerGuest();else assert.equal(guest.survivalReconnect(),true);
    room.flush();room.tick(100);
    assert.equal(guest.state.survivalLinkStatus,'connected');assert.equal(guest.state.game.status,'lobby');
    assert.notEqual(guest.state.survivalPlayerId,oldSeat);assert.equal(guest.state.survivalPlayerId,'p5');assert.equal(room.host.state.game.players.length,4);
    const fresh=JSON.parse(guest.context.sessionStorage.getItem('catSurvivalSeats'));
    assert.equal(fresh['CAT-1234'].gameId,gameId);assert.notEqual(fresh['CAT-1234'].credential,saved['CAT-1234'].credential);
    assert.deepEqual(fresh['CAT-9876'],saved['CAT-9876']);
  }finally{room.close();}
});

test('survival stale seat rejection cannot delete credentials for a newer game in the same room',()=>{
  const {h}=fixture({status:'lobby',who:1});
  h.state.survivalExpectedGameId=h.state.game.id;
  const saved={'CAT-1234':{gameId:'newer-game',credential:'c'.repeat(48)},'CAT-4321':{gameId:'another-room',credential:'d'.repeat(48)}};
  h.context.sessionStorage.setItem('catSurvivalSeats',JSON.stringify(saved));
  vm.runInContext('survivalStatus({status:"rejected",reason:"seat-unavailable"});',h.context);
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('catSurvivalSeats')),saved);
});

for(const failure of ['network-error','disconnected','offline'])test(`fake PeerJS app host ${failure} aborts every client without a crown`,()=>{
  const room=fakePeerRoom(4);
  try{
    room.start();
    if(failure==='network-error')room.host.state.peer.emit('error',{type:'network',message:'simulated signalling loss'});
    else if(failure==='disconnected')room.host.state.peer.emit('disconnected');
    else room.host.dispatchWindow('offline');
    room.flush();room.tick(15100);
    for(const client of room.clients){
      assert.equal(client.state.game.status,'aborted');assert.equal(client.state.game.winner,null);assert.deepEqual(json(client.state.game.winnerIds),[]);
      assert.equal(client.survivalCanMark(),false);assert.match(client.get('#survivalResultCopy').textContent,/不判勝負/);
      assert.equal(client.state.game.events.some(event=>event.type==='finish'&&event.reason==='last-survivor'),false);
    }
  }finally{room.close();}
});

test('fake PeerJS app room collision replaces the peer without aborting authority and closes stale connections',()=>{
  const room=fakePeerRoom(1,{roomCode:null});
  try{
    const oldPeer=room.host.state.peer,session=room.host.state.survivalSession,gameId=room.host.state.game.id,oldRoom=room.host.state.room;
    oldPeer.emit('error',{type:'unavailable-id'});room.flush();room.tick(100);
    assert.equal(oldPeer.destroyed,true);assert.notStrictEqual(room.host.state.peer,oldPeer);assert.notEqual(room.host.state.room,oldRoom);
    assert.strictEqual(room.host.state.survivalSession,session);assert.equal(room.host.state.game.id,gameId);
    assert.equal(room.host.state.game.status,'lobby');assert.equal(room.host.state.survivalLinkStatus,'hosting');
    const stale={closeCalls:0,close(){this.closeCalls++;}};oldPeer.emit('connection',stale);
    assert.equal(stale.closeCalls,1);
    oldPeer.emit('open',oldPeer.id);oldPeer.emit('close');oldPeer.emit('error',{type:'network'});oldPeer.emit('disconnected');room.flush();
    assert.equal(room.host.state.game.status,'lobby');assert.equal(room.host.state.survivalLinkStatus,'hosting');
    const guest=room.add();room.tick(100);
    assert.equal(guest.state.survivalLinkStatus,'connected');assert.equal(room.host.state.game.players.length,2);
  }finally{room.close();}
});

test('fake PeerJS app fresh generic join disposes the old survival session and peer before reconnecting',()=>{
  const room=fakePeerRoom(4);
  try{
    const guest=room.clients[1],oldPeer=guest.state.peer,oldSession=guest.state.survivalSession,oldSeat=guest.state.survivalPlayerId;
    guest.startPeerGuest();
    assert.equal(oldPeer.destroyed,true);assert.notStrictEqual(guest.state.peer,oldPeer);assert.equal(guest.state.survivalSession,null);
    assert.equal(oldSession.submit({type:'guess',index:0,boardId:'obsolete',actionId:'obsolete'}),false);
    room.flush();room.tick(100);
    assert.notStrictEqual(guest.state.survivalSession,oldSession);assert.equal(guest.state.survivalLinkStatus,'connected');
    assert.equal(guest.state.survivalPlayerId,oldSeat);assert.equal(room.host.state.game.players.length,4);
  }finally{room.close();}
});

test('survival settings always use four seats and the new lobby has no manual ready control',()=>{
  const h=makeHarness();
  for(const capacity of [1,2,3,4,5,8,100]){
    assert.equal(h.cleanSettings({mode:'survival',capacity,size:24}).capacity,4);
    assert.equal(h.context.CatSurvival.settings({capacity}).capacity,4);
  }
  assert.equal(h.settingsFromUI().capacity,4);
  const source=fs.readFileSync(path.join(ROOT,'survival-ui.js'),'utf8');
  assert.doesNotMatch(source,/survivalReady\(|id="survivalReadyButton"/);
});

test('fake PeerJS app host can wait alone indefinitely without a lobby or match countdown',()=>{
  const room=fakePeerRoom(1);
  try{
    assert.equal(room.host.survivalStart(),false);room.tick(360000);
    const game=room.host.state.game;
    assert.equal(game.status,'lobby');assert.equal(game.eligibleCount,1);
    for(const field of ['lobbyStartedAt','lobbyDeadline','startAt','startedAt','endAt'])assert.equal(game[field],null);
    assert.equal(game.winner,null);assert.deepEqual(json(game.winnerIds),[]);
    assert.equal(room.host.get('#survivalLobbyClock').textContent,'不計時');
    assert.equal(room.host.get('#survivalStartButton').classList.contains('hidden'),true);
  }finally{room.close();}
});

test('fake PeerJS app second confirmed player starts one live 180-second countdown that later joins preserve',()=>{
  const room=fakePeerRoom(1);
  try{
    const second=room.add();room.tick(100);
    const started=room.host.state.game.lobbyStartedAt,deadline=room.host.state.game.lobbyDeadline;
    assert.equal(deadline-started,180000);
    for(const h of [room.host,second]){assert.equal(h.state.game.lobbyDeadline,deadline);assert.equal(h.get('#survivalLobbyClock').textContent,'3:00');assert.equal(h.state.game.startAt,null);}
    assert.equal(room.host.get('#survivalStartButton').classList.contains('hidden'),false);
    assert.equal(second.get('#survivalStartButton').classList.contains('hidden'),true);
    room.tick(1000);
    assert.equal(room.host.get('#survivalLobbyClock').textContent,'2:59');assert.equal(second.get('#survivalLobbyClock').textContent,'2:59');
    for(const count of [3,4]){room.add();room.tick(100);assert.equal(room.host.state.game.eligibleCount,count);assert.equal(room.host.state.game.lobbyStartedAt,started);assert.equal(room.host.state.game.lobbyDeadline,deadline);}
    for(const h of room.clients){assert.equal(h.state.game.lobbyDeadline,deadline);assert.match(h.get('#survivalLobbyNotice').textContent,/新加入的貓友不會重設倒數/);}
    assert.equal(room.connections.flatMap(connection=>connection.sent).filter(message=>message.type==='ready').length,0,'no user-driven readiness packet is required');
  }finally{room.close();}
});

test('fake PeerJS app fewer than two confirmed players cancels the lobby timer and recovery starts a full new 180 seconds',()=>{
  const room=fakePeerRoom(2);
  try{
    const guest=room.clients[1],hostPeer=room.host.state.peer.id,deadline=room.host.state.game.lobbyDeadline;
    room.tick(1200);room.unreachable.add(hostPeer);room.connections.find(connection=>connection.peer===hostPeer&&connection.open).close();room.flush();room.tick(100);
    assert.equal(room.host.state.game.status,'lobby');assert.equal(room.host.state.game.eligibleCount,1);assert.equal(room.host.state.game.lobbyDeadline,null);assert.equal(room.host.state.game.lobbyStartedAt,null);
    assert.equal(room.host.get('#survivalLobbyClock').textContent,'不計時');assert.equal(room.host.get('#survivalStartButton').classList.contains('hidden'),true);
    room.tick(1000);room.unreachable.delete(hostPeer);assert.equal(guest.survivalReconnect(),true);room.flush();room.tick(100);
    const game=room.host.state.game;
    assert.equal(game.eligibleCount,2);assert.equal(game.lobbyDeadline-game.lobbyStartedAt,180000);assert.ok(game.lobbyDeadline>deadline);
    assert.equal(guest.state.game.lobbyDeadline,game.lobbyDeadline);assert.equal(room.host.get('#survivalLobbyClock').textContent,'3:00');
  }finally{room.close();}
});

test('fake PeerJS app 180-second deadline automatically begins one three-second intro before the five-minute match',()=>{
  const room=fakePeerRoom(2);
  try{
    const deadline=room.host.state.game.lobbyDeadline;
    room.tick(deadline-room.host.now()-100);
    assert.equal(room.host.state.game.status,'lobby');assert.equal(room.host.get('#survivalLobbyClock').textContent,'0:01');
    room.tick(100);
    for(const h of room.clients){assert.equal(h.state.game.status,'countdown');assert.equal(h.state.game.countdownStartedAt,deadline);assert.equal(h.state.game.startAt,deadline+3000);assert.equal(h.state.game.endAt,deadline+303000);assert.equal(h.survivalCanMark(),false);}
    assert.equal(room.host.survivalStart(),false,'the host cannot restart an automatic intro');
    room.tick(2900);assert.equal(room.host.state.game.status,'countdown');room.tick(100);
    for(const h of room.clients){assert.equal(h.state.game.status,'playing');assert.equal(h.state.game.startedAt,deadline+3000);assert.equal(h.state.game.endAt-h.state.game.startedAt,300000);assert.equal(h.survivalCanMark(),true);}
  }finally{room.close();}
});

test('fake PeerJS app join-confirm and its acknowledgment complete admission before connected status or lobby eligibility',()=>{
  const room=fakePeerRoom(1);
  try{
    room.holdTypes.add('join-confirm');const guest=room.add();room.tick(100);
    assert.equal(guest.state.survivalLinkStatus,'joining');assert.equal(room.host.state.game.eligibleCount,1);assert.equal(room.host.state.game.lobbyDeadline,null);assert.equal(room.host.survivalStart(),false);
    assert.equal(room.held.length,1);assert.equal(room.held[0].value.gameId,room.host.state.game.id);
    room.holdTypes.add('join-confirmed');room.release('join-confirm');room.tick(100);
    assert.equal(room.host.state.game.eligibleCount,2);assert.equal(guest.state.survivalLinkStatus,'joining','guest waits for the host acknowledgment');
    const deadline=room.host.state.game.lobbyDeadline;
    room.release('join-confirmed');room.tick(100);
    assert.equal(guest.state.survivalLinkStatus,'connected');assert.equal(guest.state.game.lobbyDeadline,deadline);
  }finally{room.close();}
});

for(const start of ['immediate','automatic'])test(`fake PeerJS app ${start} start excludes a pending third handshake and rejects its late confirmation`,()=>{
  const room=fakePeerRoom(2);
  try{
    const deadline=room.host.state.game.lobbyDeadline;
    if(start==='automatic')room.tick(deadline-room.host.now()-100);
    room.holdTypes.add('join-confirm');const late=room.add();room.tick(start==='automatic'?0:100);
    assert.equal(late.state.survivalLinkStatus,'joining');assert.equal(room.host.state.survivalSession.getState().eligibleCount,2);
    if(start==='immediate')assert.equal(room.host.survivalStart(),true);else room.tick(100);
    room.flush();room.tick(100);
    assert.equal(room.host.state.game.status,'countdown');assert.equal(room.host.state.game.players.length,2);assert.equal(room.host.state.game.boards.length,2);
    const startAt=room.host.state.game.startAt;room.release('join-confirm');room.tick(100);
    assert.equal(late.state.survivalLinkStatus,'closed');assert.equal(room.host.state.game.players.length,2);assert.equal(room.host.state.game.startAt,startAt);
    assert.equal(room.host.state.game.players.some(player=>player.id===late.state.survivalPlayerId),false);
  }finally{room.close();}
});
