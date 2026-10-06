'use strict';

// Focused fake-DOM regressions for the aborted match presentation. The real
// engine and app recovery timer are exercised; this does not render a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const json = value => JSON.parse(JSON.stringify(value));

// Import only helper declarations, so the app and legacy suites are not
// registered a second time when node --test discovers this file.
const source = fs.readFileSync(path.join(__dirname, 'survival-app.test.js'), 'utf8');
const boundary = source.indexOf("\ntest('");
assert.ok(boundary > 0, 'app fixture helpers remain before the first test');
const context = {require, __dirname, console, Buffer, URL, URLSearchParams};
vm.runInNewContext(source.slice(0, boundary) +
  '\nglobalThis.helpers = {fixture, makeHarness, fakePeerRoom, singleClick, doubleClick, pointerAt, GESTURE_WAIT};', context);
const {fixture, makeHarness, fakePeerRoom, singleClick, doubleClick, pointerAt, GESTURE_WAIT} = context.helpers;
const ui = h => vm.runInContext('survivalUI', h.context);

function assertAbortedLabels(h) {
  assert.equal(h.state.game.status, 'aborted');
  assert.equal(h.get('#survivalResult').classList.contains('hidden'), false);
  assert.match(h.get('#survivalResultCopy').textContent, /不判勝負/);
  assert.match(h.get('#survivalAlive').textContent, /中止|未完成|不判勝負/,
    'the central count must explicitly describe an aborted match');
  assert.doesNotMatch(h.get('#survivalAlive').textContent, /仍在場上|存活/);
  assert.match(h.get('#survivalMinuteLabel').textContent, /中止/);
  assert.doesNotMatch(h.get('#survivalScoreList').innerHTML, /仍在場上|survival-crown|♛|👑/);
  assert.match(h.get('#survivalScoreList').innerHTML, /中止|未完成/,
    'player rows must not continue to claim a live match');
  const choices = [...h.get('#survivalFollow').innerHTML.matchAll(/<option[^>]*>([^<]*)<\/option>/g)];
  assert.equal(choices.length, h.state.game.players.length);
  for (const [, label] of choices) assert.match(label, /中止|未完成/);
  const quotaCopy = ['#survivalQuotaLabel', '#survivalQuotaTarget', '#survivalQuotaTime', '#survivalQuotaRemaining']
    .map(selector => h.get(selector).textContent).join(' ');
  assert.match(quotaCopy, /中止|不判勝負|未結算/);
  assert.doesNotMatch(quotaCopy, /已結算|共享冠軍|衝刺/);
  assert.equal(h.get('#survivalQuotaMeter').classList.contains('hidden'), true);
  assert.equal(h.get('#survivalQuotaWarning').classList.contains('hidden'), true);
  for (const name of ['is-urgent', 'is-complete', 'is-final'])
    assert.equal(h.get('#survivalQuotaCard').classList.contains(name), false);
  assert.match(h.get('#survivalBoardNotice').textContent, /中止.*不判勝負.*回看/);
  assert.equal(h.get('#survivalWinners').innerHTML, '');
  const icon = h.get('.survival-result-icon');
  assert.ok(icon.classList.contains('hidden') || (icon.textContent && !/[♛👑]/u.test(icon.textContent)),
    'the result icon must be hidden or explicitly neutral after abort');
}

function assertReadOnly(h) {
  const grid = h.get('#survivalBoard');
  assert.equal(h.survivalCanMark(), false);
  assert.equal(grid.getAttribute('aria-readonly'), 'true');
  assert.equal(grid.children.length, 36);
  assert.equal(grid.children.every(cell => cell.tagName === 'SPAN' && cell.getAttribute('aria-disabled') === 'true'), true);
  assert.equal(grid.children.some(cell => cell.classList.contains('note')), false);
  assert.equal(h.get('#survivalGestureHint').classList.contains('hidden'), true);
  const before = json(h.state.game), notes = [...h.state.notes];
  doubleClick(grid.children[0]); singleClick(h, grid.children[1]);
  assert.deepEqual(json(h.state.game), before);
  assert.deepEqual([...h.state.notes], notes);
}

test('an engine host abort replaces the live counter and player labels without rewriting player history', () => {
  const {h, engine, authority, sync} = fixture({count:2});
  assert.equal(h.get('#survivalAlive').textContent, '2／2 位仍在場上');
  const players = json(authority.players), boards = json(authority.boards);
  assert.equal(engine.abort(authority, 'host-disconnected', h.now()), true);
  sync();
  assert.deepEqual(json(authority.players), players, 'abort retains the last authoritative player states');
  assert.deepEqual(json(authority.boards), boards, 'abort retains the board history');
  assert.equal(h.state.game.winner, null);
  assert.deepEqual(json(h.state.game.winnerIds), []);
  assertAbortedLabels(h);
  assertReadOnly(h);
});

test('a guest recovery timeout uses neutral aborted labels while the host match can still continue', () => {
  const room = fakePeerRoom(3);
  try {
    room.start();
    const guest = room.clients[1], hostId = room.host.state.peer.id;
    room.unreachable.add(hostId);
    room.connections.find(connection => connection.peer === hostId && connection.open).close();
    room.flush(); room.tick(15100);
    assert.equal(guest.state.survivalLinkStatus, 'aborted');
    assert.equal(room.host.state.game.status, 'playing');
    assert.equal(guest.state.game.players.every(player => player.status === 'active'), true,
      'the guest still holds its last public player statuses after its local timeout');
    assertAbortedLabels(guest);
    assertReadOnly(guest);
  } finally { room.close(); }
});

for (const winnerFields of ['winnerIds', 'legacy winner']) {
  test(`historical and reconnect aborts suppress stale ${winnerFields} and remove previously rendered crowns`, () => {
    const {h, authority, engine, sync} = fixture({count:2, who:1, fakeAudio:true});
    authority.players.forEach(player => { player.score = 30; player.errors = 2; });
    h.advance(300000); engine.advance(authority, h.now()); sync();
    assert.match(h.get('#survivalWinners').innerHTML, /survival-winner-avatar/);
    assert.match(h.get('#survivalScoreList').innerHTML, /survival-crown/);
    const snapshot = json(h.state.game);
    snapshot.status = 'aborted'; snapshot.revision++; snapshot.endReason = 'host-disconnected';
    if (winnerFields === 'legacy winner') { snapshot.winnerIds = []; snapshot.winner = 1; }
    const preserved = json(snapshot);
    vm.runInContext('survivalStatus({status:"reconnecting"})', h.context);
    h.audio.calls.length = 0;
    assert.equal(h.applySurvivalSnapshot(snapshot, {historical:true}), true);
    vm.runInContext('survivalStatus({status:"connected"})', h.context);
    h.renderSurvival();
    assert.equal(h.get('#survivalWinners').innerHTML, '', 'stale winning avatars must be cleared');
    assert.doesNotMatch(h.get('#survivalScoreList').innerHTML, /survival-crown|♛|👑/);
    assertAbortedLabels(h);
    assert.deepEqual(json(snapshot), preserved, 'rendering must not repair or mutate the received history');
    assert.equal(h.audio.calls.some(call => call.method === 'play' && ['win','lose','meow'].includes(call.args[0])), false);

    const joined = makeHarness({fakeAudio:true});
    joined.state.role = 'guest'; joined.state.survivalPlayerId = snapshot.players[1].id;
    joined.state.survivalLinkStatus = 'connected';
    joined.applySurvivalSnapshot(json(snapshot), {historical:true}); joined.renderSurvival();
    assertAbortedLabels(joined);
    assertReadOnly(joined);
    assert.equal(joined.audio.calls.some(call => call.method === 'play'), false, 'opening history stays silent');
  });
}

test('abort cancels pending input and live capture effects, then keeps all public boards read-only', () => {
  const {h, authority, engine, sync, grid, submissions} = fixture({tabbyEnabled:true, fakeAudio:true});
  h.state.role = 'guest'; h.state.survivalLinkStatus = 'connected';
  let blast;
  for (let attempt = 0; attempt < 6 && !blast; attempt++) {
    const board = authority.boards[0], index = board.puzzle.solution.find(cell => !board.found.includes(cell));
    const result = engine.act(authority, authority.players[0].id,
      {type:'guess', index, boardId:board.puzzle.id, actionId:`abort-effect-${attempt}`}, h.now());
    assert.equal(result.accepted, true);
    sync(); blast = result.event.blast;
    if (!blast) h.tick(300);
  }
  assert.ok(blast, 'the fixture must start a real tabby reveal effect');
  const tracked = [...ui(h).effects], effectTimers = [...ui(h).timers];
  assert.ok(tracked.length > 0 && effectTimers.length > 0);
  assert.equal(h.get('#survivalFX').children.length, 1);
  h.tick(300);
  const unresolved = grid().children.filter(cell => !cell.classList.contains('opened'));
  doubleClick(unresolved[0]);
  assert.ok(h.state.pendingAction, 'an unacknowledged guest action is pending');
  const actionTimers = [...h.state.survivalActionTimers];
  pointerAt(unresolved[1], 'pointerdown'); pointerAt(unresolved[1], 'pointerup');
  unresolved[1].dispatchEvent({type:'click', detail:1, button:0});
  const notes = [...h.state.notes], sent = submissions.length;
  assert.equal(engine.abort(authority, 'host-disconnected', h.now()), true);
  sync();
  vm.runInContext('survivalStatus({status:"aborted"})', h.context);
  assert.equal(h.state.pendingAction, null);
  assert.equal(ui(h).effects.size, 0); assert.equal(ui(h).timers.size, 0);
  assert.equal(h.get('#survivalFX').children.length, 0);
  assert.equal(tracked.some(({node, className}) => node.classList.contains(className)), false);
  assert.equal([...effectTimers, ...actionTimers].some(id => h.timers.has(id)), false);
  assert.ok(h.audio.calls.some(call => call.method === 'stopAll'));
  h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes], notes, 'the pending private single click cannot commit after abort');
  assert.equal(submissions.length, sent);
  assertReadOnly(h);
  h.get('#survivalFollow').onchange({target:{value:'2'}});
  assert.equal(grid().dataset.player, '2');
  assertReadOnly(h);
});

for (const tied of [false, true]) {
  test(`normal five-minute ${tied ? 'shared' : 'single'} champions retain winner text and crowns`, () => {
    const {h, authority, engine, sync} = fixture({count:2});
    authority.players.forEach(player => { player.score = 30; player.errors = 2; });
    if (!tied) authority.players[0].errors = 1;
    h.advance(300000); engine.advance(authority, h.now()); sync();
    assert.equal(h.state.game.status, 'finished');
    assert.equal(h.state.game.endReason, 'time');
    assert.equal(h.state.game.winnerIds.length, tied ? 2 : 1);
    assert.match(h.get('#survivalResultTitle').textContent, tied ? /2 位貓友，共享冠軍/ : /Test Cat，留下來的尋貓王/);
    assert.equal((h.get('#survivalWinners').innerHTML.match(/survival-winner-avatar/g) || []).length, tied ? 2 : 1);
    assert.equal((h.get('#survivalScoreList').innerHTML.match(/survival-crown/g) || []).length, tied ? 2 : 1);
    assert.match(h.get('#survivalScoreList').innerHTML, /完成本局/);
    assertReadOnly(h);
  });
}

test('a real quota elimination keeps its reason and checkpoint history when the match later aborts', () => {
  const {h, authority, engine, sync} = fixture({count:3});
  authority.players[1].score = 6; authority.players[2].score = 6;
  h.advance(60000); engine.advance(authority, h.now()); sync();
  assert.equal(h.state.game.status, 'playing');
  assert.equal(h.state.game.players[0].status, 'eliminated');
  assert.equal(h.state.game.players[0].reason, 'quota');
  assert.equal(h.get('#survivalSpectatorNotice').classList.contains('hidden'), false);
  assert.match(h.get('#survivalSpectatorNotice').textContent, /未達第 1 分鐘配額（0／6 隻）/);
  assert.match(h.get('#survivalScoreList').innerHTML, /觀戰中/);
  const player = json(h.state.game.players[0]);
  const checkpoint = json(h.state.game.events.find(event => event.type === 'checkpoint'));
  engine.abort(authority, 'host-disconnected', h.now()); sync();
  assert.deepEqual(json(h.state.game.players[0]), player);
  assert.deepEqual(json(h.state.game.events.find(event => event.type === 'checkpoint')), checkpoint);
  assert.match(vm.runInContext('suiReason(state.game.players[0])', h.context), /未達第 1 分鐘配額（0／6 隻）/);
  assertAbortedLabels(h);
});
