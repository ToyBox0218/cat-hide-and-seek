'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Battle = require('../battle-engine.js');
const Survival = require('../survival-engine.js');
const PLAY_AT = Survival.constants.OPENING_COUNTDOWN;
let actionSequence = 0;
function seeded(seed) { return () => { seed = Math.imul(seed,1664525) + 1013904223; return (seed >>> 0) / 0x100000000; }; }
function profiles(count = 4) { return Array.from({length:count}, (_, i) => ({id:`player-${i}`, nickname:`貓友${i}`, avatar:i % 6, ready:true})); }
function puzzleMaker(seed = 7635) {
  const rng = seeded(seed);
  return options => Battle.generatePuzzle({...options, rng});
}
function lobby(settings = {}, count = 4, options = {}) {
  return Survival.create({tabbyEnabled:false, ...settings}, profiles(count), {now:0, makePuzzle:puzzleMaker(), ...options});
}
function game(settings = {}, count = 4, options = {}) {
  const value = lobby(settings, count, options);
  assert.equal(Survival.start(value, 0), true);
  assert.equal(Survival.advance(value, PLAY_AT), true);
  return value;
}
function guess(value, who, index, elapsed = 0, actionId) {
  return Survival.act(value, value.players[who].id, {type:'guess', index,
    boardId:value.boards[who].puzzle.id, actionId:actionId || `action-${++actionSequence}`}, PLAY_AT + elapsed);
}
function cat(value, who = 0) { return value.boards[who].puzzle.solution.find(index => !value.boards[who].found.includes(index)); }
function empty(value, who = 0) {
  const board = value.boards[who];
  return Array.from({length:36}, (_,i) => i).find(index => !board.puzzle.solution.includes(index) && !board.misses.includes(index));
}
function scores(value, values) { values.forEach((score, i) => { value.players[i].score = score; }); }
function specialGame(landing, count = 4) {
  const values = Array(count).fill(0), draws = [];
  values.push(landing / 36);
  const rng = () => { const next = values.length ? values.shift() : 0; draws.push(next); return next; };
  const value = game({tabbyEnabled:true}, count, {rng});
  return {value, values, draws};
}
function expectedBlast(landing) {
  return Array.from({length:36}, (_,i) => i).filter(i => Math.abs(Math.floor(i / 6) - Math.floor(landing / 6)) <= 1 && Math.abs(i % 6 - landing % 6) <= 1);
}

test('UMD runs in a browser with CatBattle and secure randomness, without DOM or Node', () => {
  const context = {CatBattle:Battle, crypto:require('node:crypto').webcrypto};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../survival-engine.js'),'utf8'),context);
  const value = context.CatSurvival.create({}, profiles(), {now:0, makePuzzle:puzzleMaker()});
  assert.equal(value.players.length,4);
  assert.equal(context.CatSurvival.start(value,0),true);
  assert.equal(context.CatSurvival.advance(value,3000),true);
  assert.equal(value.status,'playing');
});

test('settings fix capacity at four and keep the five-minute rules without HP or combo', () => {
  assert.deepEqual(Survival.settings(), {mode:'survival',size:6,tabbyEnabled:true,capacity:4});
  assert.deepEqual(Survival.settings({capacity:99,tabbyEnabled:false,hp:999,duration:999}), {mode:'survival',size:6,tabbyEnabled:false,capacity:4});
  assert.equal(Survival.settings({capacity:3}).capacity,4);
  assert.equal(Survival.settings({capacity:'6'}).capacity,4);
  assert.equal(Survival.settings({capacity:'invalid'}).capacity,4);
  assert.equal(Survival.constants.MIN_PLAYERS,2);
  assert.equal(Survival.constants.MAX_PLAYERS,4);
  assert.equal(Survival.constants.LOBBY_COUNTDOWN,180000);
  assert.deepEqual(Survival.constants.QUOTAS,[6,12,20,30]);
  assert.equal(Survival.constants.MATCH_DURATION,300000);
});

test('lobby preserves stable IDs, strips untrusted statistics and limits seats', () => {
  const value = Survival.create({capacity:4}, [], {now:0,makePuzzle:puzzleMaker()});
  for (const profile of profiles()) assert.equal(Survival.addPlayer(value,{...profile,score:999,status:'winner',solution:[1]},0),true);
  assert.deepEqual(value.players.map(player => player.id),profiles().map(player => player.id));
  assert.ok(value.players.every(player => player.score === 0 && player.errors === 0 && player.status === 'active'));
  assert.equal(Survival.addPlayer(value,{id:'fifth'},0),false);
  assert.equal(Survival.addPlayer(value,{id:'player-0'},0),false);
  assert.equal(Survival.addPlayer(value,{id:42},0),false);
  assert.equal(value.boards.length,4);
  assert.equal(Survival.start(value,0),true);
  assert.equal(Survival.addPlayer(value,{id:'late'},1),false);
});

test('two to four transport-confirmed connected players can start, without waiting for unconfirmed seats', () => {
  const alone = lobby({},1);
  assert.equal(Survival.start(alone,0),false);
  for (const count of [2,3,4]) {
    const value = lobby({},count);
    assert.equal(Survival.start(value,0),true);
    assert.equal(value.players.length,count);
  }
  const value = lobby({},2);
  assert.equal(Survival.setReady(value,'player-1',false,0),true);
  assert.equal(Survival.start(value,0),false);
  assert.equal(Survival.setConnected(value,'player-1',false,0),true);
  assert.equal(Survival.setReady(value,'player-1',true,0),false);
  assert.equal(Survival.setConnected(value,'player-1',true,1),true);
  assert.equal(value.players[1].ready,false);
  assert.equal(Survival.start(value,1),false);
  assert.equal(Survival.setReady(value,'player-1',true,1),true);
  assert.equal(Survival.start(value,1),true);
  assert.equal(Survival.setReady(value,'player-0',false,2),false);
});

test('host alone can wait indefinitely and an unconfirmed second connection does not arm the lobby countdown', () => {
  const value = lobby({},1), revision = value.revision;
  assert.equal(Survival.advance(value,1000000),false);
  assert.equal(value.revision,revision); assert.equal(value.status,'lobby');
  assert.equal(value.lobbyDeadline,null); assert.equal(value.lobbyStartedAt,null);
  Survival.addPlayer(value,{id:'second',ready:false},1000001);
  assert.equal(Survival.publicGame(value,1000001).eligibleCount,1);
  assert.equal(value.lobbyDeadline,null);
  assert.equal(Survival.start(value,1000001),false);
  Survival.setReady(value,'second',true,1000002);
  assert.equal(value.lobbyStartedAt,1000002);
  assert.equal(value.lobbyDeadline,1180002);
  assert.equal(Survival.publicGame(value,1000002).eligibleCount,2);
});

test('second confirmed human arms exactly 180 seconds; third and fourth confirmations never extend it', () => {
  const value = lobby({},1);
  Survival.addPlayer(value,{id:'second',ready:false},100);
  Survival.setReady(value,'second',true,200);
  assert.equal(value.lobbyDeadline,180200);
  for (const [id,at] of [['third',1000],['fourth',10000]]) {
    assert.equal(Survival.addPlayer(value,{id,ready:false},at),true);
    assert.equal(value.lobbyDeadline,180200);
    assert.equal(Survival.setReady(value,id,true,at + 1),true);
    assert.equal(value.lobbyDeadline,180200);
  }
  assert.equal(Survival.publicGame(value,10001).eligibleCount,4);
  assert.equal(Survival.addPlayer(value,{id:'fifth',ready:true},10002),false);
  assert.equal(value.players.length,4); assert.equal(value.lobbyStartedAt,200);
});

test('dropping below two confirmed connections cancels waiting; reconnect confirmation starts a fresh 180 seconds', () => {
  const value = lobby({},2);
  assert.equal(value.lobbyDeadline,180000);
  Survival.setConnected(value,'player-1',false,30000);
  assert.equal(value.lobbyDeadline,null); assert.equal(value.lobbyStartedAt,null);
  Survival.setConnected(value,'player-1',true,40000);
  assert.equal(value.lobbyDeadline,null,'the replacement transport must confirm first');
  Survival.setReady(value,'player-1',true,40001);
  assert.equal(value.lobbyStartedAt,40001); assert.equal(value.lobbyDeadline,220001);
  Survival.advance(value,180000);
  assert.equal(value.status,'lobby'); assert.equal(value.lobbyDeadline,220001);
  Survival.advance(value,220001);
  assert.equal(value.status,'countdown'); assert.equal(value.countdownStartedAt,220001);
});

test('dropping from three eligible players to two preserves the original countdown through seat expiry', () => {
  const value = lobby({},3);
  Survival.setConnected(value,'player-2',false,1000);
  assert.equal(value.lobbyDeadline,180000);
  Survival.advance(value,16000);
  assert.equal(value.players.length,2); assert.equal(value.lobbyDeadline,180000);
  Survival.advance(value,180000);
  assert.equal(value.status,'countdown'); assert.equal(value.countdownStartedAt,180000);
});

test('loss of protocol readiness cancels the countdown even if both transports still report connected', () => {
  const value = lobby({},2);
  Survival.setReady(value,'player-1',false,500);
  assert.equal(value.lobbyDeadline,null);
  assert.ok(value.players.every(player => player.connected));
  Survival.setReady(value,'player-1',true,800);
  assert.equal(value.lobbyDeadline,180800);
});

test('automatic start occurs at the host deadline, followed by the existing three-second intro and five-minute clock', () => {
  const value = lobby({},2);
  assert.equal(Survival.advance(value,179999),false);
  assert.equal(value.status,'lobby');
  const snapshot = Survival.publicGame(value,179999);
  assert.equal(snapshot.lobbyDeadline,180000); assert.equal(snapshot.lobbyStartedAt,0); assert.equal(snapshot.eligibleCount,2);
  assert.equal(Survival.advance(snapshot,180000),false,'a client cannot start its snapshot');
  assert.equal(Survival.advance(value,180000),true);
  assert.equal(value.status,'countdown'); assert.equal(value.countdownStartedAt,180000);
  assert.equal(value.lobbyDeadline,null); assert.equal(value.lobbyStartedAt,null);
  assert.equal(value.startAt,183000); assert.equal(value.endAt,483000); assert.equal(value.startedAt,null);
  assert.equal(Survival.advance(value,182999),false);
  assert.equal(Survival.advance(value,183000),true);
  assert.equal(value.startedAt,183000); assert.equal(Survival.publicGame(value,183000).remaining,300000);
});

test('manual immediate start can precede auto-start and a manual/automatic exact-deadline race starts only once', () => {
  const immediate = lobby({},2);
  assert.equal(Survival.start(immediate,1000),true);
  assert.equal(immediate.startAt,4000); assert.equal(immediate.lobbyDeadline,null);
  assert.equal(Survival.start(immediate,1000),false);
  assert.equal(immediate.events.filter(event => event.type === 'countdown').length,1);
  for (const first of ['manual','auto']) {
    const value = lobby({},2);
    assert.equal(first === 'manual' ? Survival.start(value,180000) : Survival.advance(value,180000),true);
    const revision = value.revision;
    assert.equal(Survival.start(value,180000),false);
    assert.equal(Survival.advance(value,180000),false);
    assert.equal(value.revision,revision);
    assert.equal(value.events.filter(event => event.type === 'countdown').length,1);
  }
});

test('starting with two eligible players atomically removes unconfirmed and disconnected lobby seats', () => {
  const value = lobby({},2), boards = value.boards.map(board => board.puzzle.id);
  Survival.addPlayer(value,{id:'half-joined',ready:false},1000);
  Survival.addPlayer(value,{id:'offline',connected:false,ready:true},2000);
  assert.equal(Survival.publicGame(value,2000).eligibleCount,2);
  assert.equal(Survival.start(value,3000),true);
  assert.deepEqual(value.players.map(player => player.id),['player-0','player-1']);
  assert.deepEqual(value.boards.map(board => board.puzzle.id),boards);
  assert.deepEqual(value.lastEvent.removedIds,['half-joined','offline']);
  assert.equal(Survival.setReady(value,'half-joined',true,3000),false);
  assert.equal(Survival.setConnected(value,'offline',true,3000),false);
});

test('automatic start excludes an unconfirmed third connection and a confirmation exactly at the deadline is too late', () => {
  const value = lobby({},2);
  Survival.addPlayer(value,{id:'unconfirmed',ready:false},179000);
  assert.equal(Survival.setReady(value,'unconfirmed',true,180000),false);
  assert.equal(value.status,'countdown'); assert.equal(value.players.length,2);
  assert.deepEqual(value.lastEvent.removedIds,['unconfirmed']);
});

test('a confirmed third player one millisecond before the deadline participates; a new join exactly on it cannot', () => {
  const before = lobby({},2);
  Survival.addPlayer(before,{id:'third',ready:false},179998);
  Survival.setReady(before,'third',true,179999);
  Survival.advance(before,180000);
  assert.equal(before.players.length,3);
  const exact = lobby({},2);
  assert.equal(Survival.addPlayer(exact,{id:'third',ready:true},180000),false);
  assert.equal(exact.status,'countdown'); assert.equal(exact.players.length,2);
});

test('disconnect just before the waiting deadline cancels it; exactly on the deadline follows match disconnect rules', () => {
  const before = lobby({},2);
  Survival.setConnected(before,'player-1',false,179999);
  Survival.advance(before,180000);
  assert.equal(before.status,'lobby'); assert.equal(before.lobbyDeadline,null);
  const exact = lobby({},2);
  Survival.setConnected(exact,'player-1',false,180000);
  assert.equal(exact.status,'countdown'); assert.equal(exact.players.length,2);
  assert.equal(exact.players[1].disconnectDeadline,195000);
  assert.equal(exact.players[1].status,'active');
});

test('an offline third player reconnecting exactly on auto-start cannot join the already selected participants', () => {
  const value = lobby({},3);
  Survival.setConnected(value,'player-2',false,170000);
  assert.equal(value.lobbyDeadline,180000);
  assert.equal(Survival.setConnected(value,'player-2',true,180000),false);
  assert.equal(value.status,'countdown'); assert.equal(value.players.length,2);
});

test('lobby expiry and auto-start at the same instant remove the stale seat once before beginning', () => {
  const value = lobby({},3);
  Survival.setConnected(value,'player-2',false,165000);
  Survival.advance(value,180000);
  assert.equal(value.status,'countdown'); assert.equal(value.players.length,2);
  assert.deepEqual(value.events.filter(event => event.type === 'lobby-expiry').map(event => event.removedIds),[['player-2']]);
  assert.equal(value.events.filter(event => event.type === 'countdown').length,1);
  assert.equal(value.countdownStartedAt,180000);
});

test('a late host tick keeps original automatic start and quota deadlines rather than extending either', () => {
  const value = lobby({},2);
  Survival.advance(value,300000);
  assert.equal(value.startedAt,183000);
  assert.equal(value.status,'finished'); assert.equal(value.endedAt,243000);
  assert.equal(value.endReason,'no-survivors'); assert.deepEqual(value.winnerIds,[]);
});

test('two-player survival retains simultaneous all-fail, sole-survivor and five-minute exact-tie rules', () => {
  const fail = game({},2); Survival.advance(fail,PLAY_AT + 60000);
  assert.deepEqual(fail.winnerIds,[]); assert.equal(fail.endReason,'no-survivors');
  const sole = game({},2); scores(sole,[6,5]); Survival.advance(sole,PLAY_AT + 60000);
  assert.deepEqual(sole.winnerIds,['player-0']);
  const tied = game({},2); scores(tied,[30,30]); Survival.advance(tied,PLAY_AT + 300000);
  assert.deepEqual(tied.winnerIds,['player-0','player-1']); assert.equal(tied.endReason,'time');
});

test('a disconnected lobby seat keeps its board for 15 seconds, resets readiness and cannot restart its grace', () => {
  const value = lobby({},2), board = value.boards[1];
  assert.equal(Survival.setConnected(value,'player-1',false,1000),true);
  assert.equal(value.players[1].ready,false);
  assert.equal(value.players[1].disconnectDeadline,16000);
  assert.equal(Survival.setConnected(value,'player-1',false,10000),false);
  assert.equal(value.players[1].disconnectDeadline,16000);
  assert.equal(Survival.advance(value,15999),false);
  assert.equal(value.players.length,2); assert.equal(value.boards[1],board);
  assert.equal(Survival.start(value,15999),false);
  assert.equal(value.status,'lobby'); assert.deepEqual(value.winnerIds,[]);
});

test('lobby reconnect before 15 seconds restores the same seat but requires fresh transport confirmation', () => {
  const value = lobby({},2), boardId = value.boards[1].puzzle.id;
  Survival.setConnected(value,'player-1',false,1000);
  assert.equal(Survival.setConnected(value,'player-1',true,15999),true);
  assert.equal(value.players[1].disconnectDeadline,null);
  assert.equal(value.players[1].ready,false);
  assert.equal(value.boards[1].puzzle.id,boardId);
  assert.equal(Survival.start(value,16000),false);
  assert.equal(Survival.setReady(value,'player-1',true,16000),true);
  assert.equal(Survival.start(value,16000),true);
});

test('a lobby seat expires exactly at 15 seconds, freeing capacity without a retirement or champion', () => {
  const value = lobby({capacity:4}), retained = [0,2,3].map(who => [value.players[who].id,value.boards[who].puzzle.id]);
  Survival.setConnected(value,'player-1',false,0);
  assert.equal(Survival.advance(value,15000),true);
  assert.equal(value.status,'lobby'); assert.equal(value.endedAt,null); assert.deepEqual(value.winnerIds,[]);
  assert.deepEqual(value.players.map((player,who) => [player.id,value.boards[who].puzzle.id]),retained);
  assert.ok(value.players.every(player => player.status === 'active'));
  assert.equal(value.lastEvent.type,'lobby-expiry'); assert.equal(value.lastEvent.at,15000);
  assert.deepEqual(Survival.publicGame(value,15000).lastEvent.removedIds,['player-1']);
  assert.equal(Survival.addPlayer(value,{id:'replacement',nickname:'新貓友'},15000),true);
  assert.equal(Survival.setReady(value,'replacement',true,15000),true);
  assert.equal(Survival.start(value,15000),true);
});

test('lobby reconnect exactly at expiry cannot resurrect the old player ID or board', () => {
  const value = lobby(), oldBoardId = value.boards[1].puzzle.id;
  Survival.setConnected(value,'player-1',false,0);
  assert.equal(Survival.setConnected(value,'player-1',true,15000),false);
  assert.equal(value.players.some(player => player.id === 'player-1'),false);
  assert.equal(value.boards.some(board => board.puzzle.id === oldBoardId),false);
  assert.equal(Survival.setReady(value,'player-1',true,15000),false);
  assert.equal(value.status,'lobby');
});

test('addPlayer resolves lobby expiry before enforcing the capacity limit', () => {
  const value = lobby({capacity:4});
  Survival.setConnected(value,'player-2',false,0);
  assert.equal(Survival.addPlayer(value,{id:'replacement'},14999),false);
  assert.equal(Survival.addPlayer(value,{id:'replacement'},15000),true);
  assert.deepEqual(value.players.map(player => player.id),['player-0','player-1','player-3','replacement']);
  assert.equal(value.boards.length,4);
  assert.equal(value.players[3].ready,false);
});

test('immediate start removes a disconnected lobby seat without waiting for its grace deadline', () => {
  const value = lobby({},3);
  Survival.setConnected(value,'player-1',false,0);
  assert.equal(Survival.start(value,14999),true);
  assert.equal(value.status,'countdown'); assert.equal(value.players.length,2);
  assert.deepEqual(value.players.map(player => player.id),['player-0','player-2']);
  assert.equal(value.startAt,17999);
});

test('lobby expiry groups simultaneous seats and processes distinct deadlines in order without awarding a lone host', () => {
  const value = lobby();
  Survival.setConnected(value,'player-1',false,0);
  Survival.setConnected(value,'player-2',false,0);
  Survival.setConnected(value,'player-3',false,5000);
  Survival.advance(value,40000);
  assert.deepEqual(value.players.map(player => player.id),['player-0']);
  assert.equal(value.boards.length,1); assert.equal(value.status,'lobby');
  assert.deepEqual(value.winnerIds,[]); assert.equal(value.winner,null);
  const events = value.events.filter(event => event.type === 'lobby-expiry');
  assert.deepEqual(events.map(event => [event.at,event.removedIds]),[[15000,['player-1','player-2']],[20000,['player-3']]]);
});

test('lobby reindex preserves retained boards and aligns private tabby and replay state for the later match', () => {
  const value = lobby({tabbyEnabled:true},4,{rng:() => 0});
  const retainedBoard = value.boards[2];
  Survival.setConnected(value,'player-1',false,0);
  Survival.advance(value,15000);
  assert.equal(value.players[1].id,'player-2'); assert.equal(value.boards[1],retainedBoard);
  Survival.addPlayer(value,{id:'replacement',ready:true},15000);
  assert.equal(Survival.start(value,15000),true);
  Survival.advance(value,18000);
  const action = {type:'guess',actionId:'after-reindex',boardId:retainedBoard.puzzle.id,index:retainedBoard.puzzle.solution[0]};
  const result = Survival.act(value,'player-2',action,18000);
  assert.equal(result.accepted,true); assert.equal(result.event.playerId,'player-2'); assert.equal(result.event.who,1);
  assert.equal(result.event.tabby,true);
  assert.equal(Survival.act(value,'player-2',action,18300).reason,'duplicate');
  assert.equal(value.players[0].score,0); assert.equal(value.players[2].score,0); assert.equal(value.players[3].score,0);
});

test('disconnecting after countdown starts still retires the seat instead of removing or reindexing it', () => {
  const value = lobby(); Survival.start(value,0);
  const ids = value.players.map(player => player.id), boards = value.boards.map(board => board.puzzle.id);
  Survival.setConnected(value,'player-1',false,1000);
  Survival.advance(value,16000);
  assert.deepEqual(value.players.map(player => player.id),ids);
  assert.deepEqual(value.boards.map(board => board.puzzle.id),boards);
  assert.equal(value.players[1].status,'retired'); assert.equal(value.players[1].reason,'disconnect');
  assert.equal(value.status,'playing');
});

test('countdown ends at one shared timestamp and duration begins after it', () => {
  const value = lobby();
  assert.equal(Survival.start(value,1000),true);
  assert.equal(value.startAt,4000);
  assert.equal(value.endAt,304000);
  assert.equal(Survival.advance(value,3999),false);
  assert.equal(Survival.act(value,'player-0',{type:'guess',index:cat(value),boardId:value.boards[0].puzzle.id,actionId:'early'},3999).reason,'countdown');
  assert.equal(Survival.publicGame(value,3999).countdownRemaining,1);
  assert.equal(Survival.advance(value,4000),true);
  assert.equal(value.startedAt,4000);
  assert.equal(Survival.publicGame(value,4000).remaining,300000);
  assert.equal(Survival.advance(value,4000),false);
});

test('every current board has valid, unique independent answers and recent layouts do not repeat', () => {
  const seen = [], value = game({},4,{makePuzzle:options => {
    const puzzle = Battle.generatePuzzle({...options,rng:seeded(81 + seen.length)});
    assert.equal(Battle.validatePuzzle(puzzle).valid,true);
    assert.ok(!options.currentSolutions.includes(Battle.solutionPattern(puzzle.solution)));
    assert.ok(!options.avoidBoards.includes(Battle.boardKey(puzzle.regions)));
    seen.push(puzzle); return puzzle;
  }});
  for (let round = 0; round < 2; round++) {
    for (let who = 0; who < 4; who++) {
      for (let found = 0; found < 6; found++) assert.equal(guess(value,who,cat(value,who),(round * 24 + who * 6 + found) * 300).accepted,true);
    }
  }
  assert.equal(new Set(seen.map(puzzle => Battle.solutionPattern(puzzle.solution))).size,seen.length);
  assert.equal(new Set(seen.map(puzzle => Battle.boardKey(puzzle.regions))).size,seen.length);
  assert.equal(new Set(value.boards.map(board => board.puzzle.id)).size,4);
});

test('59.999-second accepted rescue counts, but the exact 60-second checkpoint runs before a guess', () => {
  const before = game(); scores(before,[5,6,6,6]);
  assert.equal(guess(before,0,cat(before),59999).accepted,true);
  Survival.advance(before,PLAY_AT + 60000);
  assert.equal(before.players[0].status,'active');
  const exact = game(); scores(exact,[5,6,6,6]);
  assert.equal(guess(exact,0,cat(exact),60000).reason,'eliminated');
  assert.equal(exact.players[0].score,5);
  assert.equal(exact.players[0].status,'eliminated');
  assert.equal(exact.checkpoint,1);
});

test('every quota boundary accepts a complete action one millisecond before and eliminates before one exactly on time', () => {
  for (const [minute,quota] of [[1,6],[2,12],[3,20],[4,30]]) {
    const before = game(); scores(before,[quota - 1,quota,quota,quota]);
    assert.equal(guess(before,0,cat(before),minute * 60000 - 1).accepted,true);
    Survival.advance(before,PLAY_AT + minute * 60000);
    assert.equal(before.players[0].status,'active');
    const exact = game(); scores(exact,[quota - 1,quota,quota,quota]);
    assert.equal(guess(exact,0,cat(exact),minute * 60000).reason,'eliminated');
    assert.equal(exact.players[0].score,quota - 1);
    assert.equal(exact.players[0].status,'eliminated');
    assert.equal(exact.checkpoint,minute);
  }
});

test('checkpoint failures are simultaneous, including everybody failing with no champion', () => {
  const value = game(); scores(value,[5,5,5,5]);
  Survival.advance(value,PLAY_AT + 60000);
  assert.ok(value.players.every(player => player.status === 'eliminated'));
  assert.equal(value.status,'finished');
  assert.deepEqual(value.winnerIds,[]);
  assert.equal(value.winner,null);
  assert.equal(value.endedAt,PLAY_AT + 60000);
  assert.equal(value.endReason,'no-survivors');
});

test('one qualifying survivor wins early after all checkpoint eliminations', () => {
  for (let winner = 0; winner < 4; winner++) {
    const value = game(); scores(value,[5,5,5,5]); value.players[winner].score = 6;
    Survival.advance(value,PLAY_AT + 60000);
    assert.deepEqual(value.winnerIds,[`player-${winner}`]);
    assert.equal(value.winner,`player-${winner}`);
    assert.equal(value.endReason,'last-survivor');
    assert.equal(value.players.filter(player => player.status === 'eliminated').length,3);
  }
});

test('late advance resolves elapsed deadlines in order and stops at the true early win', () => {
  const value = game(); scores(value,[12,6,6,6]);
  Survival.advance(value,PLAY_AT + 300000);
  assert.equal(value.endedAt,PLAY_AT + 120000);
  assert.equal(value.checkpoint,2);
  assert.deepEqual(value.winnerIds,['player-0']);
});

test('all four quotas are cumulative, 240–300 seconds is quota-free, and 42 is never required', () => {
  const value = game();
  for (const [minute,quota] of [[1,6],[2,12],[3,20],[4,30]]) {
    scores(value,Array(4).fill(quota));
    Survival.advance(value,PLAY_AT + minute * 60000);
    assert.equal(value.status,'playing');
    assert.equal(value.checkpoint,minute);
    assert.equal(Survival.publicGame(value,PLAY_AT + minute * 60000).nextQuota,[12,20,30,null][minute - 1]);
  }
  assert.equal(Survival.publicGame(value,PLAY_AT + 240000).nextCheckpointAt,null);
  Survival.advance(value,PLAY_AT + 299999);
  assert.equal(value.status,'playing');
  Survival.advance(value,PLAY_AT + 300000);
  assert.equal(value.status,'finished');
  assert.deepEqual(value.winnerIds,profiles().map(player => player.id));
});

test('end ranks active players by all-match score, then all-match errors, preserving exact joint winners', () => {
  const value = game(); scores(value,[40,40,40,39]);
  value.players.forEach((player,i) => { player.errors = [2,1,1,0][i]; });
  Survival.advance(value,PLAY_AT + 300000);
  assert.deepEqual(value.winnerIds,['player-1','player-2']);
  assert.equal(value.winner,null);
  assert.equal(value.players[3].errors,0);
  assert.equal(value.endReason,'time');
});

test('a first-minute manual error still breaks an otherwise exact tie at the final deadline', () => {
  const value = game();
  assert.equal(guess(value,0,empty(value),0).accepted,true);
  scores(value,[30,30,30,30]);
  for (let minute = 1; minute <= 5; minute++) Survival.advance(value,PLAY_AT + minute * 60000);
  assert.equal(value.players[0].errors,1);
  assert.deepEqual(value.winnerIds,['player-1','player-2','player-3']);
});

test('eliminated and retired players never become champions even with larger retained scores', () => {
  const value = game(); scores(value,[200,100,35,34]);
  value.players[0].status = 'eliminated'; value.players[0].reason = 'quota';
  value.players[1].status = 'retired'; value.players[1].reason = 'disconnect';
  Survival.advance(value,PLAY_AT + 300000);
  assert.deepEqual(value.winnerIds,['player-2']);
  assert.equal(value.players[0].score,200);
  assert.equal(Survival.publicGame(value).players.length,4);
});

test('the exact match deadline rejects a last guess and no accepted action can change finished results', () => {
  const value = game(); scores(value,[30,30,30,30]);
  assert.equal(guess(value,0,cat(value),299999).accepted,true);
  assert.equal(guess(value,1,cat(value,1),300000).reason,'not-playing');
  assert.deepEqual(value.winnerIds,['player-0']);
  const snapshot = Survival.publicGame(value,PLAY_AT + 300000);
  assert.equal(guess(value,2,cat(value,2),300001).accepted,false);
  assert.deepEqual(value.winnerIds,snapshot.winnerIds);
});

test('wrong guesses lock 2/4/6/8/8 seconds; manual rescue resets the next penalty and total errors persist', () => {
  const value = game(); let elapsed = 0;
  for (const duration of [2000,4000,6000,8000,8000]) {
    const result = guess(value,0,empty(value),elapsed);
    assert.equal(result.accepted,true);
    assert.equal(result.event.cooldownDuration,duration);
    assert.equal(guess(value,0,empty(value),elapsed + duration - 1).reason,'cooldown');
    elapsed += duration;
  }
  assert.equal(value.players[0].errors,5);
  assert.equal(guess(value,0,cat(value),elapsed).accepted,true);
  assert.equal(value.boards[0].missStreak,0);
  assert.equal(value.players[0].errors,5);
  assert.equal(guess(value,0,empty(value),elapsed + 299).reason,'cooldown');
  assert.equal(guess(value,0,empty(value),elapsed + 300).event.cooldownDuration,2000);
  assert.equal(value.players[0].errors,6);
});

test('six rescues advance exactly once and preserve the 300 ms lock on the new independent board', () => {
  const value = game(), oldId = value.boards[0].puzzle.id;
  for (let i = 0; i < 6; i++) assert.equal(guess(value,0,cat(value),i * 300).event.advanced,i === 5);
  assert.equal(value.players[0].score,6);
  assert.equal(value.boards[0].number,2);
  assert.notEqual(value.boards[0].puzzle.id,oldId);
  assert.equal(value.boards[0].cooldownUntil,PLAY_AT + 1800);
  assert.equal(guess(value,0,cat(value),1799).reason,'cooldown');
  assert.equal(guess(value,0,cat(value),1800).accepted,true);
});

test('action IDs are player-scoped, duplicates and stale boards cannot score twice', () => {
  const value = game(), original = value.boards[0].puzzle.id, cell = cat(value);
  assert.equal(guess(value,0,cell,0,'shared').accepted,true);
  assert.equal(guess(value,0,cat(value),300,'shared').reason,'duplicate');
  assert.equal(guess(value,1,cat(value,1),300,'shared').accepted,true);
  assert.equal(guess(value,0,cell,300,'different').reason,'resolved-cell');
  for (let i = 1; i < 6; i++) assert.equal(guess(value,0,cat(value),300 + i * 300).accepted,true);
  assert.equal(Survival.act(value,'player-0',{type:'guess',index:cell,boardId:original,actionId:'new-replay'},PLAY_AT + 2500).reason,'stale-board');
  assert.equal(value.players[0].score,6);
});

test('current-board duplicate protection survives eviction from the bounded recent-action history', () => {
  const value = game();
  assert.equal(guess(value,0,cat(value),0,'long-lived').accepted,true);
  for (let i = 0; i < 270; i++) {
    const who = 1 + i % 3;
    assert.equal(guess(value,who,cat(value,who),Math.floor(i / 3) * 300).accepted,true);
  }
  assert.equal(guess(value,0,cat(value),27000,'long-lived').reason,'duplicate');
  assert.equal(value.players[0].score,1);
});

test('invalid and locked actions do not change score or errors, but still process elapsed deadlines first', () => {
  const value = game();
  for (const action of [{}, {type:'mark'}, {type:'guess',actionId:'a',boardId:value.boards[0].puzzle.id,index:36}]) {
    assert.equal(Survival.act(value,'player-0',action,PLAY_AT).accepted,false);
  }
  assert.equal(Survival.act(value,'unknown',{},PLAY_AT).reason,'invalid-player');
  assert.equal(value.players[0].score,0); assert.equal(value.players[0].errors,0);
  assert.equal(Survival.act(value,'unknown',{},PLAY_AT + 60000).reason,'not-playing');
  assert.equal(value.status,'finished'); assert.deepEqual(value.winnerIds,[]);
});

test('invalid time cannot mutate authority and public snapshots cannot authorize mutations', () => {
  const value = game(), baseline = JSON.stringify(value);
  for (const at of [-1,NaN,Infinity,'3000']) {
    assert.equal(Survival.advance(value,at),false);
    assert.equal(Survival.act(value,'player-0',{},at).reason,'invalid-time');
    assert.equal(Survival.setConnected(value,'player-0',false,at),false);
    assert.equal(JSON.stringify(value),baseline);
  }
  const snapshot = Survival.publicGame(value,PLAY_AT);
  assert.equal(Survival.advance(snapshot,PLAY_AT + 60000),false);
  assert.equal(Survival.start(snapshot,PLAY_AT),false);
  assert.equal(Survival.act(snapshot,'player-0',{},PLAY_AT).reason,'not-authority');
});

test('guest disconnect keeps the room clock and lock running; rejoin before 15 seconds retains its seat', () => {
  const value = game();
  assert.equal(guess(value,1,empty(value,1),0).accepted,true);
  const boardId = value.boards[1].puzzle.id;
  assert.equal(Survival.setConnected(value,'player-1',false,PLAY_AT + 1000),true);
  assert.equal(value.players[1].disconnectDeadline,PLAY_AT + 16000);
  assert.equal(guess(value,1,cat(value,1),2000).reason,'disconnected');
  Survival.advance(value,PLAY_AT + 15999);
  assert.equal(value.status,'playing'); assert.equal(value.players[1].status,'active');
  assert.equal(Survival.setConnected(value,'player-1',true,PLAY_AT + 15999),true);
  assert.equal(value.boards[1].puzzle.id,boardId);
  assert.equal(value.players[1].disconnectDeadline,null);
  assert.equal(guess(value,1,cat(value,1),15999).accepted,true);
  assert.equal(value.players[1].errors,1);
  assert.equal(value.endAt,PLAY_AT + 300000);
});

test('rejoin exactly at 15 seconds cannot escape retirement and retired players remain spectators', () => {
  const value = game();
  Survival.setConnected(value,'player-1',false,PLAY_AT);
  assert.equal(Survival.setConnected(value,'player-1',true,PLAY_AT + 15000),true);
  assert.equal(value.players[1].connected,true);
  assert.equal(value.players[1].status,'retired');
  assert.equal(value.players[1].reason,'disconnect');
  assert.equal(guess(value,1,cat(value,1),15000).reason,'retired');
});

test('offline players still owe quota; a failed quota is resolved before their later disconnect deadline', () => {
  const value = game(); scores(value,[6,5,6,6]);
  Survival.setConnected(value,'player-1',false,PLAY_AT + 55000);
  Survival.advance(value,PLAY_AT + 70000);
  assert.equal(value.players[1].status,'eliminated');
  assert.equal(value.players[1].reason,'quota');
  assert.equal(value.players[1].disconnectDeadline,null);
});

test('same-instant quota and disconnect retirements are grouped before selecting a winner', () => {
  const value = game(); scores(value,[5,5,6,6]);
  Survival.setConnected(value,'player-2',false,PLAY_AT + 45000);
  Survival.setConnected(value,'player-3',false,PLAY_AT + 45000);
  Survival.advance(value,PLAY_AT + 60000);
  assert.deepEqual(value.players.map(player => player.status),['eliminated','eliminated','retired','retired']);
  assert.deepEqual(value.winnerIds,[]);
  assert.equal(value.endReason,'no-survivors');
});

test('simultaneous disconnect expirations never crown the last iterated seat', () => {
  const value = game();
  for (const player of value.players) Survival.setConnected(value,player.id,false,PLAY_AT);
  Survival.advance(value,PLAY_AT + 15000);
  assert.ok(value.players.every(player => player.status === 'retired'));
  assert.deepEqual(value.winnerIds,[]);
  assert.equal(value.endReason,'no-survivors');
});

test('chronological disconnect handling cannot crown somebody who failed an earlier quota', () => {
  const value = game(); scores(value,[5,6,6,6]);
  for (let who = 1; who < 4; who++) Survival.setConnected(value,`player-${who}`,false,PLAY_AT + 55000);
  Survival.advance(value,PLAY_AT + 75000);
  assert.equal(value.players[0].status,'eliminated');
  assert.equal(value.endReason,'no-survivors');
  assert.equal(value.endedAt,PLAY_AT + 70000);
});

test('host elimination does not stop the remaining players or the authority clock', () => {
  const value = game(); scores(value,[5,6,6,6]);
  Survival.advance(value,PLAY_AT + 60000);
  assert.equal(value.players[0].status,'eliminated');
  assert.equal(value.status,'playing');
  assert.equal(guess(value,1,cat(value,1),60000).accepted,true);
  scores(value,[5,12,12,12]);
  Survival.advance(value,PLAY_AT + 120000);
  assert.equal(value.checkpoint,2);
});

test('tabby opportunities are secret until revealed and fully disabled when requested', () => {
  const {value} = specialGame(0);
  const before = Survival.publicGame(value,PLAY_AT);
  assert.ok(before.boards.every(board => board.revealedTabbies.length === 0));
  assert.equal(JSON.stringify(before).includes('opportunit'),false);
  const special = value.boards[0].puzzle.solution[0];
  const result = guess(value,0,special);
  assert.equal(result.event.tabby,true);
  assert.deepEqual(value.boards[0].revealedTabbies,[special]);
  const ordinary = game({tabbyEnabled:false});
  assert.equal(guess(ordinary,0,cat(ordinary)).event.tabby,undefined);
});

test('production randomness rejects biased integer tails for both target selection and landing', () => {
  let words = [], reads = 0;
  const crypto = {getRandomValues(array) { reads++; array[0] = words.length ? words.shift() : 100; return array; }};
  const context = {CatBattle:Battle,crypto}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../survival-engine.js'),'utf8'),context);
  const api = context.CatSurvival, value = api.create({},profiles(),{now:0,makePuzzle:puzzleMaker()});
  api.start(value,0);
  words = [0xffffffff,0xfffffffe,0xfffffffd,0xfffffffc,0,1,2,3]; reads = 0;
  api.advance(value,3000);
  assert.equal(reads,8);
  words = [0xffffffff,35]; reads = 0;
  const result = api.act(value,'player-0',{type:'guess',actionId:'crypto',boardId:value.boards[0].puzzle.id,index:value.boards[0].puzzle.solution[0]},3000);
  assert.equal(result.event.tabby,true);
  assert.equal(result.event.blast.landing,35);
  assert.equal(reads,2);
});

test('tabby landings cover all 36 cells, including all corners and already revealed or empty cells', () => {
  for (let landing = 0; landing < 36; landing++) {
    const {value,draws} = specialGame(landing);
    const board = value.boards[0], target = board.puzzle.solution[0];
    const result = guess(value,0,target);
    assert.equal(result.event.blast.landing,landing);
    assert.deepEqual(result.event.blast.cells,expectedBlast(landing));
    assert.equal(result.event.blast.cells.length,([0,5,30,35].includes(landing) ? 4 : [0,5].includes(landing % 6) || [0,5].includes(Math.floor(landing / 6)) ? 6 : 9));
    assert.equal(draws.length,5,'no reroll or chaining');
    assert.equal(value.players[0].score,1 + result.event.blast.found.length);
    assert.equal(value.players[0].errors,0);
  }
});

test('blast reveals every unopened cell in its clipped 3×3, scores cats once and marks empties without errors', () => {
  const {value} = specialGame(14), board = value.boards[0], target = board.puzzle.solution[0];
  const cells = expectedBlast(14), expectedCats = cells.filter(index => board.puzzle.solution.includes(index) && index !== target);
  const expectedMisses = cells.filter(index => !board.puzzle.solution.includes(index));
  const result = guess(value,0,target);
  assert.deepEqual(result.event.blast.found,expectedCats);
  assert.deepEqual(result.event.blast.misses,expectedMisses);
  assert.equal(value.players[0].score,1 + expectedCats.length);
  assert.equal(value.players[0].errors,0);
  assert.equal(board.missStreak,0);
  for (const index of cells) assert.ok(board.found.includes(index) || board.misses.includes(index));
  const score = value.players[0].score;
  assert.equal(guess(value,0,target,300).reason,'resolved-cell');
  assert.equal(value.players[0].score,score);
});

test('blast skips previously found cats and previous manual errors, never resetting or duplicating their statistics', () => {
  const {value,values} = specialGame(0), board = value.boards[0], target = board.puzzle.solution[0];
  const ordinary = board.puzzle.solution[1];
  const error = empty(value);
  assert.equal(guess(value,0,error,0).accepted,true);
  assert.equal(guess(value,0,ordinary,2000).accepted,true);
  // Put the blast on an already rescued cat; landing itself is never re-rolled.
  values[0] = ordinary / 36;
  const result = guess(value,0,target,2300);
  assert.equal(result.event.blast.landing,ordinary);
  assert.equal(result.event.blast.found.includes(ordinary),false);
  assert.equal(value.players[0].errors,1);
  assert.equal(value.players[0].score,2 + result.event.blast.found.length);
  assert.equal(new Set(board.found).size,board.found.length);
  assert.equal(new Set(board.misses).size,board.misses.length);
});

test('manual special hit and blast finish the old board atomically before exactly one fresh board', () => {
  const {value,values,draws} = specialGame(0), old = value.boards[0], target = old.puzzle.solution[0];
  const last = old.puzzle.solution[5];
  for (let i = 1; i < 5; i++) assert.equal(guess(value,0,old.puzzle.solution[i],(i - 1) * 300).accepted,true);
  values[0] = last / 36;
  const result = guess(value,0,target,1200);
  assert.equal(result.event.advanced,true);
  assert.equal(result.event.boardId,old.puzzle.id);
  assert.equal(result.event.blast.found.includes(last),true);
  assert.equal(old.found.length,6);
  assert.equal(value.players[0].score,6);
  assert.equal(value.boards[0].number,2);
  assert.deepEqual(value.boards[0].found,[]);
  assert.deepEqual(value.boards[0].misses,[]);
  assert.deepEqual(value.boards[0].blastRevealed,[]);
  assert.equal(draws.length,5,'the blast never chains or reassigns a target');
  assert.equal(guess(value,0,cat(value),1500).event.tabby,undefined);
});

test('a board clear does not bank or reroll a tabby opportunity in the same minute', () => {
  const {value,draws} = specialGame(0), board = value.boards[0], target = board.puzzle.solution[0];
  for (let i = 1; i < 6; i++) assert.equal(guess(value,0,board.puzzle.solution[i],(i - 1) * 300).accepted,true);
  assert.equal(guess(value,0,target,1500).event.advanced,true);
  for (let i = 0; i < 6; i++) assert.equal(guess(value,0,cat(value),1800 + i * 300).event.tabby,undefined);
  assert.equal(value.boards[0].number,3);
  assert.equal(draws.length,5);
});

test('each minute replaces the unconsumed target using only the current board’s unfound cats, including the final minute', () => {
  const {value,values,draws} = specialGame(0), firstBoard = value.boards[0];
  const firstTarget = firstBoard.puzzle.solution[0], ordinary = firstBoard.puzzle.solution[1];
  assert.equal(guess(value,0,ordinary,0).event.tabby,undefined);
  values.length = 0; values.push(0.999,0,0,0);
  scores(value,[6,6,6,6]);
  Survival.advance(value,PLAY_AT + 60000);
  const replacement = firstBoard.puzzle.solution[5];
  assert.equal(guess(value,0,firstTarget,60000).event.tabby,undefined);
  assert.equal(guess(value,0,replacement,60300).event.tabby,true);
  for (let minute = 2; minute <= 4; minute++) {
    scores(value,Array(4).fill([0,6,12,20,30][minute]));
    const target = cat(value), priorDraws = draws.length;
    values.length = 0; values.push(0,0,0,0,0);
    Survival.advance(value,PLAY_AT + minute * 60000);
    assert.equal(draws.length,priorDraws + 4);
    assert.equal(guess(value,0,target,minute * 60000).event.tabby,true);
  }
  assert.equal(value.checkpoint,4);
});

test('an entire pre-deadline tabby action counts atomically toward quota', () => {
  const {value,values} = specialGame(0), board = value.boards[0];
  const extra = board.puzzle.solution[5]; values[0] = extra / 36;
  scores(value,[4,6,6,6]);
  const result = guess(value,0,board.puzzle.solution[0],59999);
  assert.equal(result.event.blast.found.includes(extra),true);
  assert.ok(value.players[0].score >= 6);
  Survival.advance(value,PLAY_AT + 60000);
  assert.equal(value.players[0].status,'active');
});

test('public snapshot and its bounded event history whitelist only revealed facts at every nested level', () => {
  const {value} = specialGame(14);
  guess(value,0,cat(value));
  value.privateToken = 'TOP_SECRET'; value.players[0].credential = 'TOP_SECRET';
  value.settings.seed = 'TOP_SECRET'; value.boards[0].future = 'TOP_SECRET';
  value.boards[0].puzzle.secret = 'TOP_SECRET'; value.lastEvent.actionId = 'TOP_SECRET';
  value.lastEvent.hiddenTarget = 'TOP_SECRET'; value.lastEvent.blast.privateAnswer = 'TOP_SECRET';
  const snapshot = Survival.publicGame(value,PLAY_AT);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['TOP_SECRET','solution','history','actionId','opportunit','credential','privateAnswer']) assert.equal(serialized.includes(secret),false,secret);
  assert.deepEqual(Object.keys(snapshot.boards[0].puzzle).sort(),['id','regions','size']);
  assert.deepEqual(Object.keys(snapshot.players[0]).sort(),['avatar','connected','disconnectDeadline','errors','id','nickname','ready','reason','score','status']);
  snapshot.boards[0].found.push(999); snapshot.boards[0].puzzle.regions[0] = 999;
  snapshot.lastEvent.blast.cells.push(999); snapshot.events[0].type = 'corrupt';
  assert.equal(value.boards[0].found.includes(999),false);
  assert.notEqual(value.boards[0].puzzle.regions[0],999);
  assert.equal(value.lastEvent.blast.cells.includes(999),false);
  assert.notEqual(value.events[0].type,'corrupt');
});

test('event history retains multiple coalesced player actions and evicts to a 32-event bound', () => {
  const value = game();
  for (let i = 0; i < 40; i++) assert.equal(guess(value,i % 4,cat(value,i % 4),Math.floor(i / 4) * 300).accepted,true);
  const snapshot = Survival.publicGame(value,PLAY_AT + 3000);
  assert.equal(value.events.length,32); assert.equal(snapshot.events.length,32);
  assert.ok(snapshot.events.every(event => event.type === 'hit'));
  assert.deepEqual(snapshot.events.slice(-4).map(event => event.playerId),profiles().map(profile => profile.id));
  assert.equal(new Set(snapshot.events.map(event => event.id)).size,32);
  assert.deepEqual(snapshot.lastEvent,snapshot.events.at(-1));
});

test('abort ends without a champion and authority cannot be restarted or replayed', () => {
  const value = game();
  assert.equal(Survival.abort(value,'host-lost',PLAY_AT + 1200),true);
  assert.equal(value.status,'aborted'); assert.deepEqual(value.winnerIds,[]);
  assert.equal(value.endReason,'host-lost');
  assert.equal(Survival.start(value,PLAY_AT + 1500),false);
  assert.equal(Survival.abort(value,'again',PLAY_AT + 1500),false);
  assert.equal(guess(value,0,cat(value),1500).reason,'not-playing');
});

test('aborting while waiting clears the lobby countdown and cannot auto-start later', () => {
  const value = lobby({},2);
  assert.equal(value.lobbyDeadline,180000);
  assert.equal(Survival.abort(value,'host-lost',1000),true);
  assert.equal(value.lobbyDeadline,null); assert.equal(value.lobbyStartedAt,null);
  assert.equal(Survival.advance(value,1000000),false);
  assert.equal(value.status,'aborted'); assert.equal(value.startAt,null);
});
