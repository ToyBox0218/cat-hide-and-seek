'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const Session = require('../survival-session.js');
const Engine = require('../survival-engine.js');
const P = Session.PROTOCOL;

// These are deterministic, in-process transport simulations, not real PeerJS/NAT tests.
class Clock {
  constructor() { this.at = 1000; this.next = 0; this.jobs = new Map(); }
  now = () => this.at;
  setTimer = (fn,delay) => { const id = ++this.next; this.jobs.set(id,{fn,at:this.at+delay}); return id; };
  clearTimer = id => this.jobs.delete(id);
  advance(amount) {
    const target = this.at+amount;
    for (let count = 0; count < 100000; count++) {
      let selected = null;
      for (const [id,job] of this.jobs) if (job.at <= target && (!selected || job.at < selected[1].at)) selected = [id,job];
      if (!selected) { this.at = target; return; }
      this.at = selected[1].at; this.jobs.delete(selected[0]); selected[1].fn();
    }
    throw new Error('Timer loop did not settle.');
  }
}
class Connection extends EventEmitter {
  constructor(peer) { super(); this.peer = peer; this.open = true; this.sent = []; this.drop = false; this.closeCalls = 0; }
  send(message) {
    if (!this.open) throw new Error('closed');
    const copy = JSON.parse(JSON.stringify(message)); this.sent.push(copy);
    if (!this.drop && this.other.open) this.other.emit('data',copy);
  }
  close() {
    this.closeCalls++;
    if (!this.open) return;
    this.open = false; this.emit('close');
    if (this.other.open) { this.other.open = false; this.other.emit('close'); }
  }
}
function pair(label) {
  const host = new Connection(`${label}-guest`), guest = new Connection(`${label}-host`);
  host.other = guest; guest.other = host; return {host,guest};
}
function room(size = 4, settings = {}, additions = {}) {
  const clock = new Clock(), states = [], acks = [], statuses = [], guests = [];
  let authority;
  const engine = Object.assign({},Engine,{create(...args) { authority = Engine.create(...args); return authority; }});
  const common = {now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer};
  const host = Session.createHost(Object.assign({engine,settings:Object.assign({tabbyEnabled:false},settings),hostProfile:{nickname:'Host',avatar:2},
    onState:value => states.push(value),onAck:value => acks.push(value),onStatus:value => statuses.push(value)},common,additions));
  function add(credential, nickname = 'Friend') {
    const connection = pair(`connection-${guests.length}`), result = {connection,states:[],acks:[],statuses:[],credential:null,seat:null};
    result.client = Session.createGuest(Object.assign({connection:connection.guest,profile:{nickname,avatar:1},credential,
      onState:value => result.states.push(value),onAck:value => result.acks.push(value),onStatus:value => result.statuses.push(value),
      onCredential:value => { result.credential = value; },onSeat:value => { result.seat = value; }},common));
    host.attach(connection.host); guests.push(result); return result;
  }
  for (let i = 1; i < size; i++) add(undefined,`Friend ${i}`);
  function start() { assert.equal(host.start(),true); clock.advance(3000); }
  function close() { host.close(); guests.forEach(guest => guest.client.close()); }
  return {host,clock,states,acks,statuses,guests,add,start,close,get authority() { return authority; }};
}
function action(value, index = 1, id = 'guess') {
  const board = value.authority.boards[index];
  return {type:'guess',actionId:id,boardId:board.puzzle.id,index:board.puzzle.solution.find(cell => !board.found.includes(cell))};
}
function statePlayer(value, id) { return value.host.getState().players.find(player => player.id === id); }
function halfJoined(value, credential) {
  const connection = pair('half-connected'); value.host.attach(connection.host);
  connection.guest.send({protocol:P,type:'join',profile:{nickname:'Pending'},...(credential ? {credential} : {})});
  connection.joined = connection.host.sent.find(message => message.type === 'joined');
  return connection;
}

test('UMD loads without a DOM or an imported networking service', () => {
  const context = {}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../survival-session.js'),'utf8'),context);
  assert.equal(typeof context.CatSurvivalSession.createHost,'function');
  assert.equal(typeof context.CatSurvivalSession.createGuest,'function');
  assert.equal(context.CatSurvivalSession.PROTOCOL,'cat-survival-v1');
});

for (const count of [2,3,4]) test(`${count} simulated human seats automatically become eligible and share one host countdown`, () => {
  const value = room(count);
  assert.equal(value.host.getState().players.length,count);
  assert.ok(value.host.getState().players.every(player => player.ready && player.connected));
  assert.equal(value.host.getState().eligibleCount,count);
  value.start(); value.clock.advance(100);
  assert.equal(value.host.getState().status,'playing');
  assert.ok(value.guests.every(guest => guest.client.getState().status === 'playing'));
  assert.equal(new Set(value.host.getState().players.map(player => player.id)).size,count);
  assert.ok(value.guests.every(guest => guest.seat.playerId !== value.host.playerId));
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('four-seat capacity, duplicate connections and pending handshakes are bounded', () => {
  const value = room(4,{capacity:4});
  const extra = value.add(); assert.equal(extra.statuses.at(-1).reason,'room-full');
  assert.equal(value.host.getState().players.length,4);
  assert.equal(value.host.attach(value.guests[0].connection.host),false);
  value.guests[0].connection.guest.close();
  assert.equal(statePlayer(value,'p2').ready,false);
  assert.equal(value.host.getState().eligibleCount,3);
  const pending = Array.from({length:Session.constants.MAX_PENDING},(_,i) => pair(`pending-${i}`));
  pending.forEach(connection => assert.equal(value.host.attach(connection.host),true));
  const overflow = pair('overflow'); assert.equal(value.host.attach(overflow.host),false); assert.equal(overflow.host.open,false);
  value.clock.advance(Session.constants.HANDSHAKE_TIMEOUT);
  assert.ok(pending.every(connection => !connection.host.open));
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('host ignores legacy hello traffic and supports replaying the routing offer', () => {
  const value = room(1), connection = pair('late-router');
  value.host.attach(connection.host);
  connection.guest.send({type:'hello',nickname:'Legacy'});
  assert.equal(value.host.getState().players.length,1);
  const offer = connection.host.sent.find(message => message.type === 'offer');
  const client = Session.createGuest({connection:connection.guest,profile:{nickname:'Routed'},now:value.clock.now,
    setTimer:value.clock.setTimer,clearTimer:value.clock.clearTimer});
  assert.equal(client.receive(offer),true);
  assert.equal(value.host.getState().players.length,2);
  assert.equal(client.playerId,'p2');
  client.close(); value.close(); assert.equal(value.clock.jobs.size,0);
});

test('actions are connection-bound and manual ready traffic cannot change transport eligibility', () => {
  const value = room(), guest = value.guests[0];
  guest.connection.guest.send({protocol:P,type:'ready',ready:false,playerId:value.host.playerId,who:0});
  assert.equal(statePlayer(value,'p2').ready,true); assert.equal(statePlayer(value,'p1').ready,true);
  assert.equal(value.host.localReady(false),false); assert.equal(guest.client.ready(false),false);
  assert.equal(value.host.getState().eligibleCount,4);
  guest.connection.guest.send({protocol:P,type:'start'});
  assert.equal(value.host.getState().status,'lobby'); assert.equal(guest.acks.at(-1).reason,'host-only');
  value.start();
  const guess = Object.assign(action(value),{playerId:value.host.playerId,who:0,now:0,timestamp:Number.MAX_SAFE_INTEGER});
  guest.connection.guest.send({protocol:P,type:'action',playerId:value.host.playerId,action:guess});
  assert.equal(guest.acks.at(-1).accepted,true); assert.equal(guest.acks.at(-1).event.playerId,'p2');
  assert.equal(statePlayer(value,'p2').score,1); assert.equal(statePlayer(value,'p1').score,0);
  assert.equal(guest.acks.at(-1).hostTime,value.clock.at);
  guest.connection.guest.send({protocol:P,type:'abort'});
  assert.equal(value.host.getState().status,'playing'); assert.equal(guest.acks.at(-1).reason,'host-only');
  value.close();
});

test('replayed IDs, stale boards, malformed actions and hostile timestamps never change scores', () => {
  const value = room(); value.start(); const guest = value.guests[0], guess = action(value);
  guest.client.submit(guess); assert.equal(guest.acks.at(-1).accepted,true);
  guest.client.submit(guess); assert.equal(guest.acks.at(-1).reason,'duplicate');
  guest.client.submit(Object.assign({},guess,{actionId:'stale',boardId:'previous-board'}));
  assert.equal(guest.acks.at(-1).reason,'stale-board');
  guest.connection.guest.send({protocol:P,type:'action',action:{type:'guess',actionId:'bad',boardId:guess.boardId,index:999}});
  assert.equal(guest.acks.at(-1).reason,'invalid-action');
  value.clock.advance(300);
  guest.connection.guest.send({protocol:P,type:'action',action:Object.assign(action(value,1,'future'),{at:Number.MAX_SAFE_INTEGER})});
  assert.equal(guest.acks.at(-1).accepted,true); assert.equal(statePlayer(value,'p2').score,2);
  assert.equal(value.host.getState().status,'playing');
  value.close();
});

test('one captured host receipt time resolves a checkpoint before a late action', () => {
  let hostNowCalls = 0, current = 1000;
  const value = room(4,{}, {now:() => { hostNowCalls++; return current; }});
  value.host.start();
  current = 64000; // First quota is due at 4,000 + 60,000, regardless of claimed client time.
  const guess = action(value);
  hostNowCalls = 0;
  value.guests[0].connection.guest.send({protocol:P,type:'action',action:Object.assign(guess,{at:4000})});
  assert.equal(hostNowCalls,1);
  assert.equal(value.guests[0].acks.at(-1).accepted,false);
  assert.equal(value.host.getState().status,'finished');
  assert.equal(statePlayer(value,'p2').score,0);
  value.close();
});

test('credentials are random, never public, and nickname/room/seat guesses cannot reclaim a seat', () => {
  const value = room(), owner = value.guests[0];
  assert.match(owner.credential,/^[a-f0-9]{48}$/);
  assert.equal(new Set(value.guests.map(guest => guest.credential)).size,3);
  for (const guest of value.guests) for (const message of guest.connection.host.sent) {
    for (const other of value.guests) {
      if (message.type === 'joined' && guest === other) continue;
      assert.equal(JSON.stringify(message).includes(other.credential),false);
    }
  }
  assert.equal(JSON.stringify(value.host.getState()).includes(owner.credential),false);
  assert.equal(JSON.stringify(value.states).includes(owner.credential),false);
  const duplicate = value.add(owner.credential); assert.equal(duplicate.statuses.at(-1).reason,'seat-already-connected');
  const forged = value.add('0'.repeat(48),'Friend 1'); assert.equal(forged.statuses.at(-1).reason,'invalid-credential');
  value.start(); owner.connection.guest.close();
  const impostor = value.add(undefined,'Friend 1'); assert.equal(impostor.statuses.at(-1).reason,'match-already-started');
  assert.equal(statePlayer(value,'p2').connected,false);
  value.close();
});

test('valid credentials reconnect before 15 seconds; replay protection survives the replacement transport', () => {
  const value = room(); value.start(); const original = value.guests[0], guess = action(value);
  original.client.submit(guess); original.connection.guest.close();
  const deadline = statePlayer(value,'p2').disconnectDeadline;
  value.clock.advance(14900);
  assert.equal(value.host.getState().status,'playing'); assert.equal(statePlayer(value,'p2').status,'active');
  const recovered = value.add(original.credential,'Untrusted changed name');
  assert.equal(recovered.seat.playerId,'p2'); assert.equal(recovered.seat.spectator,false);
  assert.equal(statePlayer(value,'p2').disconnectDeadline,null); assert.ok(value.clock.at < deadline);
  assert.equal(statePlayer(value,'p2').nickname,'Friend 1');
  recovered.client.submit(guess); assert.equal(recovered.acks.at(-1).reason,'duplicate');
  original.client.close(); value.close(); assert.equal(value.clock.jobs.size,0);
});

test('at exactly 15 seconds a disconnected seat retires and credential recovery is spectator-only', () => {
  const value = room(); value.start(); const original = value.guests[0]; original.connection.guest.close();
  assert.equal(original.statuses.at(-1).status,'reconnecting');
  value.clock.advance(15000);
  assert.equal(statePlayer(value,'p2').status,'retired');
  assert.equal(original.client.getState().status,'aborted');
  assert.deepEqual(original.client.getState().winnerIds,[]);
  const recovered = value.add(original.credential);
  assert.equal(recovered.seat.playerId,'p2'); assert.equal(recovered.seat.spectator,true);
  assert.equal(recovered.client.submit(action(value)),false);
  recovered.connection.guest.send({protocol:P,type:'action',action:action(value)});
  assert.equal(recovered.acks.at(-1).accepted,false);
  assert.equal(statePlayer(value,'p2').score,0); assert.equal(statePlayer(value,'p2').status,'retired');
  value.close();
});

test('late reconnect at the deadline cannot race the next periodic tick', () => {
  const value = room(); value.start(); const original = value.guests[0]; original.connection.guest.close();
  value.clock.at += 15000; // Deliberately skip every scheduled tick.
  const recovered = value.add(original.credential);
  assert.equal(recovered.seat.spectator,true); assert.equal(statePlayer(value,'p2').status,'retired');
  value.close();
});

test('explicit host departure aborts all guests immediately without awarding champions', () => {
  const value = room(); value.start(); value.host.close('host-left');
  for (const guest of value.guests) {
    assert.equal(guest.client.getState().status,'aborted'); assert.deepEqual(guest.client.getState().winnerIds,[]);
    assert.equal(guest.statuses.at(-1).status,'aborted'); assert.equal(guest.connection.guest.open,false);
    assert.equal(guest.connection.guest.listenerCount('data'),0);
  }
  assert.equal(value.clock.jobs.size,0); assert.equal(value.host.tick(),false); assert.equal(value.host.start(),false);
});

test('silent transport failure has bounded heartbeat detection and no host migration', () => {
  const value = room(); value.start(); const guest = value.guests[0];
  guest.connection.host.drop = true; guest.connection.guest.drop = true;
  value.clock.advance(Session.constants.LIVENESS_TIMEOUT+100);
  assert.equal(statePlayer(value,'p2').connected,false);
  assert.equal(guest.statuses.at(-1).status,'reconnecting');
  assert.equal(value.host.getState().status,'playing');
  value.clock.advance(Session.constants.RECONNECT_GRACE);
  assert.equal(guest.client.getState().status,'aborted'); assert.deepEqual(guest.client.getState().winnerIds,[]);
  assert.equal(statePlayer(value,'p2').status,'retired'); value.close();
});

test('host and remote observers receive only detached, whitelisted public snapshots', () => {
  const value = room();
  value.authority.seed = 'private-seed'; value.authority.privateMarks = ['secret'];
  value.authority.players[0].credential = 'should-never-be-public';
  value.authority.boards[0].privateMarks = [1,2,3];
  value.authority.boards[0].puzzle.hiddenTabby = 5;
  value.start(); value.clock.advance(100);
  const forbidden = new Set(['solution','seed','privateMarks','hiddenTabby','credential','opportunities','_history','actionIds']);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key,item] of Object.entries(value)) { assert.equal(forbidden.has(key),false,`private key ${key}`); inspect(item); }
  }
  inspect(value.host.getState()); value.states.forEach(inspect); value.guests.forEach(guest => guest.states.forEach(inspect));
  const publicState = value.host.getState(); publicState.players[0].score = 500; publicState.boards[0].puzzle.regions.fill(-1);
  assert.equal(value.host.getState().players[0].score,0); assert.ok(value.host.getState().boards[0].puzzle.regions.every(region => region >= 0));
  value.close();
});

test('action acknowledgements are immediate while independent player snapshots coalesce to 100ms', () => {
  const value = room(); value.start(); value.clock.advance(100);
  const before = value.guests[0].connection.host.sent.filter(message => message.type === 'snapshot').length;
  value.guests.forEach((guest,index) => { guest.client.submit(action(value,index+1,`coalesced-${index}`)); assert.equal(guest.acks.at(-1).accepted,true); });
  value.host.submit(action(value,0,'local-coalesced'));
  assert.equal(value.acks.at(-1).accepted,true);
  assert.equal(value.guests[0].connection.host.sent.filter(message => message.type === 'snapshot').length,before);
  value.clock.advance(99);
  assert.ok(value.guests[0].connection.host.sent.filter(message => message.type === 'snapshot').length <= before+1);
  value.clock.advance(1);
  assert.equal(value.guests[0].connection.host.sent.filter(message => message.type === 'snapshot').length,before+1);
  assert.deepEqual(value.guests[0].client.getState().players.map(player => player.score),[1,1,1,1]);
  assert.equal(value.guests[0].client.getState().events.filter(event => event.type === 'hit').length,4);
  value.close();
});

test('guest estimates host time from bounded round trips and rejects unsolicited/old clock replies', () => {
  const clock = new Clock(), connection = pair('clock'), statuses = [];
  const host = Session.createHost({engine:Engine,now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});
  const guest = Session.createGuest({connection:connection.guest,now:() => clock.at+25000,setTimer:clock.setTimer,clearTimer:clock.clearTimer,
    onStatus:value => statuses.push(value)});
  host.attach(connection.host);
  assert.equal(guest.getServerTime(),clock.at);
  connection.host.send({protocol:P,type:'pong',id:'not-requested',hostTime:999999999});
  assert.equal(guest.getServerTime(),clock.at);
  clock.advance(2000); assert.equal(guest.getServerTime(),clock.at);
  assert.ok(statuses.some(status => status.status === 'clock' && status.offset === -25000 && status.rtt === 0));
  host.close(); guest.close(); assert.equal(clock.jobs.size,0);
});

test('malformed traffic and floods close only the offending connection', () => {
  const value = room(); const guest = value.guests[0];
  for (let i = 0; i < 4; i++) guest.connection.guest.send({protocol:P,type:'ready',ready:'true'});
  assert.equal(guest.connection.guest.open,false); assert.equal(guest.statuses.at(-1).reason,'malformed-messages');
  const flood = value.guests[1];
  for (let i = 0; i < 70 && flood.connection.guest.open; i++) flood.connection.guest.send({protocol:P,type:'ping',id:`flood-${i}`});
  assert.equal(flood.connection.guest.open,false); assert.equal(flood.statuses.at(-1).reason,'rate-limit');
  assert.equal(value.guests[2].connection.guest.open,true); assert.equal(value.host.getState().status,'lobby'); value.close();
});

test('closing a guest deliberately removes timers/listeners without a reconnect notification', () => {
  const value = room(), guest = value.guests[0]; guest.client.close();
  assert.equal(guest.statuses.at(-1).status,'closed');
  assert.equal(guest.statuses.some(status => status.status === 'reconnecting'),false);
  assert.equal(guest.connection.guest.listenerCount('data'),0);
  assert.equal(guest.connection.host.listenerCount('data'),0);
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('an eliminated host keeps serving active guests and cannot keep guessing', () => {
  const value = room(); value.start();
  for (let hit = 0; hit < 4; hit++) {
    value.guests.forEach((guest,index) => guest.client.submit(action(value,index+1,`quota-${hit}`)));
    if (hit < 3) assert.equal(value.host.submit(action(value,0,`below-quota-${hit}`)).accepted,true);
    value.clock.advance(300);
  }
  value.clock.advance(value.authority.startAt+60000-value.clock.at);
  assert.equal(statePlayer(value,'p1').status,'eliminated');
  assert.equal(statePlayer(value,'p1').score,3);
  assert.ok(value.host.getState().players.slice(1).every(player => player.status === 'active' && player.score === 4));
  assert.equal(value.host.getState().status,'playing');
  assert.equal(value.host.submit(action(value,0,'eliminated-host')).accepted,false);
  const guest = value.guests[0]; guest.client.submit(action(value,1,'still-serving'));
  assert.equal(guest.acks.at(-1).accepted,true); assert.equal(statePlayer(value,'p2').score,5);
  value.clock.advance(100); assert.equal(guest.client.getState().players[1].score,5);
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('host and guest share cumulative 4/10/16/24 checkpoints and a quota-free final minute', () => {
  const value = room(2), guest = value.guests[0]; value.start();
  let rescues = 0;
  const quotas = [4,10,16,24];
  for (const [index,quota] of quotas.entries()) {
    assert.equal(value.host.getState().nextQuota,quota);
    while (rescues < quota) {
      assert.equal(value.host.submit(action(value,0,`host-rescue-${rescues}`)).accepted,true);
      guest.client.submit(action(value,1,`guest-rescue-${rescues}`));
      assert.equal(guest.acks.at(-1).accepted,true);
      rescues++; value.clock.advance(300);
    }
    value.clock.advance(value.authority.startAt + (index + 1) * 60000 - value.clock.at);
    for (const snapshot of [value.host.getState(),guest.client.getState()]) {
      assert.equal(snapshot.status,'playing');
      assert.equal(snapshot.checkpoint,index + 1);
      assert.equal(snapshot.nextQuota,quotas[index + 1] ?? null);
      assert.deepEqual(snapshot.players.map(player => player.score),[quota,quota]);
      assert.ok(snapshot.players.every(player => player.status === 'active'));
    }
  }
  assert.equal(guest.client.getState().nextCheckpointAt,null);
  value.clock.advance(value.authority.endAt - value.clock.at - 1);
  assert.equal(value.host.getState().status,'playing');
  value.clock.advance(1);
  for (const snapshot of [value.host.getState(),guest.client.getState()]) {
    assert.equal(snapshot.status,'finished');
    assert.equal(snapshot.checkpoint,4);
    assert.deepEqual(snapshot.players.map(player => player.score),[24,24]);
    assert.deepEqual(snapshot.winnerIds,['p1','p2']);
    assert.equal(snapshot.endReason,'time');
  }
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('credential generation fails closed rather than accepting weak or duplicate secrets', () => {
  const weak = room(1,{}, {randomToken:() => 'short'});
  const rejected = weak.add(); assert.equal(rejected.statuses.at(-1).reason,'credential-unavailable');
  assert.equal(weak.host.getState().players.length,1); weak.close();
  const repeated = room(1,{}, {randomToken:() => 'a'.repeat(32)});
  repeated.add(); const duplicate = repeated.add(); assert.equal(duplicate.statuses.at(-1).reason,'credential-unavailable');
  assert.equal(repeated.host.getState().players.length,2); repeated.close();
  const unavailable = room(1,{}, {randomToken:() => { throw new Error('unavailable'); }});
  assert.equal(unavailable.add().statuses.at(-1).reason,'credential-unavailable'); unavailable.close();
});

test('an invalid or stale snapshot cannot replace the current public state', () => {
  const value = room(); value.start(); const guest = value.guests[0], baseline = guest.client.getState();
  assert.equal(guest.client.receive({protocol:P,type:'snapshot',snapshot:Object.assign({},baseline,{revision:baseline.revision-1,status:'lobby'})}),false);
  assert.equal(guest.client.receive({protocol:P,type:'snapshot',snapshot:Object.assign({},baseline,{id:'different-game'})}),false);
  assert.equal(guest.client.receive({protocol:P,type:'snapshot',snapshot:Object.assign({},baseline,{boards:[]})}),false);
  assert.equal(guest.client.getState().status,'playing'); value.close();
});

test('the first offer identifies the game before a reused room address can receive cached credentials', () => {
  const previous = room(2), cached = {gameId:previous.host.getState().id,credential:previous.guests[0].credential};
  const previousOffer = previous.guests[0].connection.host.sent.find(message => message.type === 'offer');
  assert.equal(previousOffer.gameId,cached.gameId); previous.close();
  const replacement = room(1), connection = pair('connection-0'); // Same public transport names, fresh game.
  replacement.host.attach(connection.host);
  const offer = connection.host.sent.find(message => message.type === 'offer');
  assert.equal(offer.gameId,replacement.host.getState().id);
  assert.notEqual(offer.gameId,cached.gameId);
  assert.equal(offer.hostId,previousOffer.hostId);
  assert.equal(Object.hasOwn(offer,'credential'),false);
  const client = Session.createGuest({connection:connection.guest,profile:{nickname:'Returning friend'},
    credential:cached.gameId === offer.gameId ? cached.credential : undefined,
    now:replacement.clock.now,setTimer:replacement.clock.setTimer,clearTimer:replacement.clock.clearTimer});
  client.receive(offer);
  assert.equal(client.playerId,'p2'); assert.equal(client.getState().id,offer.gameId);
  assert.ok(connection.guest.sent.every(message => !JSON.stringify(message).includes(cached.credential)));
  const newCredential = connection.host.sent.find(message => message.type === 'joined').credential;
  assert.notEqual(newCredential,cached.credential);
  replacement.close(); client.close(); assert.equal(replacement.clock.jobs.size,0);
});

test('host departure after a finished match preserves its already-established champion', () => {
  const value = room(); value.start();
  for (let hit = 0; hit < 4; hit++) { value.guests[0].client.submit(action(value,1,`winner-${hit}`)); value.clock.advance(300); }
  value.clock.advance(value.authority.startAt+60000-value.clock.at);
  assert.equal(value.host.getState().status,'finished'); assert.deepEqual(value.host.getState().winnerIds,['p2']);
  value.host.close('host-left-after-results');
  assert.equal(value.host.getState().status,'finished'); assert.deepEqual(value.host.getState().winnerIds,['p2']);
  for (const guest of value.guests) {
    const closing = guest.connection.host.sent.find(message => message.type === 'aborted');
    assert.equal(closing.snapshot.status,'finished'); assert.deepEqual(closing.snapshot.winnerIds,['p2']);
    assert.equal(guest.client.getState().status,'finished'); assert.deepEqual(guest.client.getState().winnerIds,['p2']);
    assert.equal(guest.statuses.at(-1).status,'aborted');
  }
  assert.equal(value.clock.jobs.size,0);
});

test('the host alone can wait indefinitely and cannot start before a confirmed second human', () => {
  const value = room(1);
  assert.equal(statePlayer(value,'p1').ready,true); assert.equal(value.host.getState().eligibleCount,1);
  assert.equal(value.host.getState().lobbyDeadline,null); assert.equal(value.host.start(),false);
  value.clock.advance(180000);
  assert.equal(value.host.getState().status,'lobby'); assert.equal(value.host.getState().lobbyDeadline,null);
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('join confirmation is sent only after valid seat and snapshot callbacks, without a ready button', () => {
  const value = room(1), connection = pair('ack-order'), calls = [];
  const rawSend = connection.guest.send.bind(connection.guest);
  connection.guest.send = message => {
    if (message.type === 'join-confirm') {
      assert.deepEqual(calls,['seat','snapshot']); assert.equal(value.host.getState().eligibleCount,1);
    }
    rawSend(message);
  };
  const client = Session.createGuest({connection:connection.guest,now:value.clock.now,setTimer:value.clock.setTimer,clearTimer:value.clock.clearTimer,
    onSeat:() => calls.push('seat'),onState:() => calls.push('snapshot')});
  value.host.attach(connection.host);
  assert.deepEqual(calls,['seat','snapshot','snapshot']);
  assert.equal(value.host.getState().eligibleCount,2); assert.equal(value.host.getState().lobbyDeadline,value.clock.at+180000);
  assert.ok(connection.guest.sent.some(message => message.type === 'join-confirm'));
  assert.equal(connection.guest.sent.some(message => message.type === 'ready'),false);
  value.close(); client.close(); assert.equal(value.clock.jobs.size,0);
});

test('unconfirmed admitted seats count toward the four-player cap but not the start minimum', () => {
  const value = room(1), pending = Array.from({length:3},() => halfJoined(value));
  assert.equal(value.host.getState().players.length,4); assert.equal(value.host.getState().eligibleCount,1);
  assert.equal(value.host.getState().lobbyDeadline,null); assert.equal(value.host.start(),false);
  const fifth = halfJoined(value); assert.equal(fifth.host.sent.at(-1).reason,'room-full');
  pending[0].guest.send({protocol:P,type:'ready',ready:true});
  assert.equal(value.host.getState().eligibleCount,1);
  pending[0].guest.send({protocol:P,type:'join-confirm',gameId:value.host.getState().id,playerId:'p1'});
  assert.equal(statePlayer(value,'p2').ready,true); assert.equal(statePlayer(value,'p3').ready,false);
  assert.equal(value.host.getState().eligibleCount,2);
  assert.equal(value.host.start(),true); assert.deepEqual(value.host.getState().players.map(player => player.id),['p1','p2']);
  assert.equal(pending[1].host.sent.at(-1).reason,'seat-unavailable'); assert.equal(pending[2].host.sent.at(-1).reason,'seat-unavailable');
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('unconfirmed handshakes expire and eventually release their waiting-room seats', () => {
  const value = room(1), pending = halfJoined(value);
  for (let second = 2; second <= 8; second += 2) {
    value.clock.advance(2000); pending.guest.send({protocol:P,type:'ping',id:`pending-${second}`});
  }
  value.clock.advance(2000);
  assert.equal(pending.host.sent.at(-1).reason,'handshake-timeout');
  assert.equal(statePlayer(value,'p2').connected,false); assert.equal(value.host.getState().eligibleCount,1);
  value.clock.advance(15000); assert.equal(value.host.getState().players.length,1);
  assert.equal(value.add(pending.joined.credential).statuses.at(-1).reason,'seat-unavailable');
  assert.equal(value.add().seat.playerId,'p3'); value.close(); assert.equal(value.clock.jobs.size,0);
});

test('the second confirmed human starts 180 seconds; third and fourth humans do not extend it', () => {
  const value = room(2), deadline = value.host.getState().lobbyDeadline;
  assert.equal(deadline,value.clock.at+180000);
  value.clock.advance(60000); value.add(); assert.equal(value.host.getState().lobbyDeadline,deadline);
  value.clock.advance(60000); value.add(); assert.equal(value.host.getState().lobbyDeadline,deadline);
  assert.equal(value.add().statuses.at(-1).reason,'room-full');
  value.clock.advance(deadline-value.clock.at-1); assert.equal(value.host.getState().status,'lobby');
  value.clock.advance(1); assert.equal(value.host.getState().status,'countdown');
  assert.equal(value.host.getState().countdownStartedAt,deadline);
  assert.equal(value.host.getState().startAt,deadline+3000);
  value.clock.advance(3000); assert.equal(value.host.getState().status,'playing');
  assert.equal(value.host.getState().events.filter(event => event.type === 'countdown').length,1);
  assert.equal(value.host.start(),false); value.close(); assert.equal(value.clock.jobs.size,0);
});

test('falling below two eligible humans cancels the wait; confirmed recovery begins a fresh 180 seconds', () => {
  const value = room(2), original = value.guests[0], firstDeadline = value.host.getState().lobbyDeadline;
  value.clock.advance(60000); original.connection.guest.close();
  assert.equal(value.host.getState().lobbyDeadline,null); assert.equal(value.host.getState().eligibleCount,1);
  value.clock.advance(1000); const recovered = value.add(original.credential);
  assert.equal(recovered.seat.playerId,'p2'); assert.equal(value.host.getState().lobbyDeadline,value.clock.at+180000);
  assert.ok(value.host.getState().lobbyDeadline > firstDeadline);
  original.client.close(); value.close(); assert.equal(value.clock.jobs.size,0);
});

test('immediate start excludes a half-connected seat and invalidates its resume credential', () => {
  const value = room(2), pending = halfJoined(value), id = pending.joined.seat.playerId;
  assert.equal(value.host.getState().eligibleCount,2); assert.equal(value.host.getState().players.length,3);
  assert.equal(value.host.start(),true); assert.equal(value.host.getState().status,'countdown');
  assert.equal(statePlayer(value,id),undefined); assert.equal(pending.host.open,false);
  assert.equal(pending.host.sent.at(-1).reason,'seat-unavailable');
  assert.equal(value.add(pending.joined.credential).statuses.at(-1).reason,'seat-unavailable');
  assert.equal(value.host.getState().players.length,2); value.close(); assert.equal(value.clock.jobs.size,0);
});

test('a join confirmation at the exact auto-start deadline cannot enter the old waiting room', () => {
  const value = room(2), deadline = value.host.getState().lobbyDeadline;
  value.clock.advance(deadline-value.clock.at-1); const pending = halfJoined(value);
  assert.equal(value.host.getState().players.length,3);
  value.clock.at = deadline; // Skip the scheduled tick to race the received confirmation itself.
  pending.guest.send({protocol:P,type:'join-confirm',gameId:value.host.getState().id});
  assert.equal(value.host.getState().status,'countdown'); assert.equal(value.host.getState().players.length,2);
  assert.equal(pending.host.sent.at(-1).reason,'seat-unavailable');
  assert.equal(pending.host.sent.some(message => message.type === 'join-confirmed'),false);
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('a host immediate-start click at the automatic deadline reports the single successful transition', () => {
  const value = room(2); value.clock.at = value.host.getState().lobbyDeadline;
  assert.equal(value.host.start(),true); assert.equal(value.host.start(),false);
  assert.equal(value.host.getState().events.filter(event => event.type === 'countdown').length,1);
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('lobby expiry updates retained guest indices by stable ID and frees one seat', () => {
  const value = room(4), removed = value.guests[0], retained = value.guests[1];
  const boardId = retained.client.getState().boards[2].puzzle.id;
  assert.equal(retained.seat.index,2); removed.connection.guest.close(); value.clock.advance(15000);
  assert.deepEqual(value.host.getState().players.map(player => player.id),['p1','p3','p4']);
  assert.equal(retained.seat.index,1); assert.equal(retained.seat.playerId,'p3');
  assert.equal(retained.client.getState().boards[1].puzzle.id,boardId);
  assert.equal(value.add(removed.credential).statuses.at(-1).reason,'seat-unavailable');
  assert.equal(value.add().seat.playerId,'p5'); assert.equal(value.host.getState().players.length,4);
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('an unconfirmed rejoin cannot stop an active player’s disconnect deadline', () => {
  const value = room(); value.start(); const original = value.guests[0]; original.connection.guest.close();
  const deadline = statePlayer(value,'p2').disconnectDeadline;
  value.clock.advance(14900); const pending = halfJoined(value,original.credential);
  assert.equal(statePlayer(value,'p2').connected,false); assert.equal(statePlayer(value,'p2').disconnectDeadline,deadline);
  pending.guest.send({protocol:P,type:'action',action:action(value)});
  assert.equal(pending.host.sent.at(-1).reason,'join-unconfirmed'); assert.equal(statePlayer(value,'p2').score,0);
  value.clock.at = deadline; pending.guest.send({protocol:P,type:'join-confirm',gameId:value.host.getState().id});
  assert.equal(statePlayer(value,'p2').status,'retired');
  assert.equal(pending.host.sent.at(-1).type,'join-confirmed'); assert.equal(pending.host.sent.at(-1).seat.spectator,true);
  value.close(); assert.equal(value.clock.jobs.size,0);
});

test('an invalid initial joined snapshot never sends confirmation or makes a guest eligible', () => {
  const value = room(1), connection = pair('invalid-snapshot');
  const rawSend = connection.host.send.bind(connection.host);
  connection.host.send = message => rawSend(message.type === 'joined' ?
    Object.assign({},message,{snapshot:Object.assign({},message.snapshot,{boards:[]})}) : message);
  const client = Session.createGuest({connection:connection.guest,now:value.clock.now,setTimer:value.clock.setTimer,clearTimer:value.clock.clearTimer});
  value.host.attach(connection.host);
  assert.equal(value.host.getState().eligibleCount,1);
  assert.equal(connection.guest.sent.some(message => message.type === 'join-confirm'),false);
  assert.equal(client.playerId,null); assert.equal(value.host.start(),false);
  client.close(); value.close(); assert.equal(value.clock.jobs.size,0);
});
