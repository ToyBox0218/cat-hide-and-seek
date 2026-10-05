'use strict';

// Browser globals are executed in a VM, never a browser automation driver.
// The fake DOM is intentionally small: these are state/adapter integration
// tests, not substitutes for visual or real-network acceptance testing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const APP_PATH = path.join(__dirname, '..', 'app.js');
const json = value => JSON.parse(JSON.stringify(value));

function storage(initial = {}) {
  const values = { ...initial };
  return new Proxy({
    getItem: key => Object.hasOwn(values, key) ? values[key] : null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: key => { delete values[key]; },
    clear: () => { for (const key of Object.keys(values)) delete values[key]; }
  }, {
    get: (target, key) => key in target ? target[key] : values[key],
    set: (_, key, value) => { values[key] = String(value); return true; }
  });
}

function element(tagName = 'div') {
  const attributes = new Map(), classes = new Set(), descendants = new Map();
  let html = '';
  const node = {
    tagName: tagName.toUpperCase(), children: [], dataset: {}, style: { setProperty() {} }, value: '',
    textContent: '', checked: false, disabled: false, open: false,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force) {
        const include = force === undefined ? !classes.has(name) : force;
        include ? classes.add(name) : classes.delete(name); return include;
      }
    },
    setAttribute: (key, value) => attributes.set(key, String(value)),
    getAttribute: key => attributes.get(key) ?? null,
    addEventListener() {}, removeEventListener() {}, focus() {}, remove() {},
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }),
    querySelector(selector) { if (!descendants.has(selector)) descendants.set(selector, element()); return descendants.get(selector); }, querySelectorAll: () => []
  };
  Object.defineProperties(node, {
    className: { get: () => [...classes].join(' '), set: value => {
      classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    } },
    innerHTML: { get: () => html, set: value => { html = value; node.children = []; descendants.clear(); } }
  });
  return node;
}

function harness({ mode = 'basic', size = 6, seed = 0x1873, battle, battleUI = false, local = {}, session = {} } = {}) {
  const nodes = new Map(), messages = [], intervals = [];
  const get = selector => {
    const match = /^#board \.cell\[data-index="(\d+)"\]$/.exec(selector);
    if (match) return get('#board').children.find(node => +node.dataset.index === +match[1]) || null;
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  Object.entries({ '#size': size, '#gameMode': mode, '#secondsA': 45, '#secondsB': 60,
    '#cap': 3, '#battleHP': 150, '#nick': 'Test Cat' }).forEach(([key, value]) => get(key).value = String(value));
  let now = 1_900_000_000_000, serial = 0, rng = seed >>> 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    console, URL, URLSearchParams, Date: Clock, Uint32Array,
    crypto: {
      getRandomValues(array) {
        for (let i = 0; i < array.length; i++) { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; array[i] = rng >>> 0; }
        return array;
      }, randomUUID: () => `test-action-${++serial}`
    },
    document: { querySelector: get, querySelectorAll: () => [], createElement: element,
      addEventListener() {}, hidden: false, body: element() },
    localStorage: storage(local), sessionStorage: storage(session),
    navigator: { clipboard: { writeText: async () => {} } },
    location: { href: 'https://example.test/game', search: '' },
    innerWidth: 1280, innerHeight: 900,
    setTimeout: () => ++serial, clearTimeout() {},
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    requestAnimationFrame: () => ++serial, addEventListener() {},
    btoa: value => Buffer.from(value).toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString(),
    Peer: class { on() {} destroy() {} },
    CatBattle: battle
  });
  context.window = context;
  if (battle === true) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'battle-engine.js'), 'utf8'), context, { filename: 'battle-engine.js' });
  vm.runInContext(fs.readFileSync(APP_PATH, 'utf8'), context, { filename: APP_PATH });
  if (battleUI) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'battle-ui.js'), 'utf8'), context, { filename: 'battle-ui.js' });
  vm.runInContext(`
    globalThis.appTest = { state, makePuzzle, cleanSettings, newGame, publicGame, act,
      applyItem, saveLocal, broadcast, onMessage, onOpen, onClose, renderLegacy: render,
      setDeadline, switchTurn, neighborCatCount, excluded, unresolved, normalizeRoom,
      randomRoom, peerIdForRoom, ROOM_RE, SHORT_ROOM_RE, rematchVote, startPeerGuest,
      settingsFromUI };
    render = () => {};
  `, context);
  if (battleUI) vm.runInContext('Object.assign(appTest, { battleChoose, renderBattle, battleMessage, startPractice });', context);
  const api = context.appTest;
  api.state.transport = { open: () => true, send: message => messages.push(json(message)), close() {} };
  api.state.role = 'host'; api.state.you = 0; api.state.room = 'CAT-1234';
  return { ...api, context, get, messages, intervals,
    now: () => now, advance: ms => { now += ms; },
    action: (type = 'guess', extra = {}) => ({ type, turnId: api.state.game.turnId, actionId: `direct-${++serial}`, ...extra }),
    begin() { const game = api.newGame(size); api.state.game = game;
      if (game.settings.mode === 'battle') { game.players.forEach(player => player.connected = true); context.CatBattle.start(game, now); }
      else { game.status = 'playing'; game.turn = 0; game.turnId = 1; api.setDeadline(); }
      return game; }
  };
}

function emptyCell(game, h) {
  return game.puzzle.regions.findIndex((_, index) => !game.puzzle.solution.includes(index) && h.unresolved(game, index));
}
function assertNoPrivateKeys(value, at = 'snapshot') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!key.startsWith('_') && !['solution', 'solutions', 'treasures', 'actionIds', 'notes', 'privateIntel'].includes(key), `${at}.${key} leaked`);
    assertNoPrivateKeys(child, `${at}.${key}`);
  }
}

// Exact-cover search: choose the smallest remaining row/column/region domain.
// Adjacent-row diagonal exclusions enforce the eight-neighbor rule.
function solutionCount(puzzle, limit = 2) {
  const n = puzzle.size, chosen = Array(n).fill(-1), rows = new Set(), columns = new Set(), regions = new Set();
  let count = 0;
  const cells = Array.from({ length: n * n }, (_, index) => ({ index, row: Math.floor(index / n), col: index % n, region: puzzle.regions[index] }));
  function visit() {
    if (rows.size === n) { count++; return; }
    const groups = Array.from({ length: 3 * n }, () => []);
    for (const cell of cells) {
      if (rows.has(cell.row) || columns.has(cell.col) || regions.has(cell.region)) continue;
      if ((cell.row > 0 && chosen[cell.row - 1] >= 0 && Math.abs(chosen[cell.row - 1] - cell.col) <= 1) ||
          (cell.row + 1 < n && chosen[cell.row + 1] >= 0 && Math.abs(chosen[cell.row + 1] - cell.col) <= 1)) continue;
      groups[cell.row].push(cell); groups[n + cell.col].push(cell); groups[2 * n + cell.region].push(cell);
    }
    let best = null;
    for (let index = 0; index < 3 * n; index++) {
      if ((index < n ? rows : index < 2 * n ? columns : regions).has(index % n)) continue;
      if (!groups[index].length) return;
      if (best === null || groups[index].length < best.length) best = groups[index];
    }
    for (const cell of best) {
      chosen[cell.row] = cell.col; rows.add(cell.row); columns.add(cell.col); regions.add(cell.region);
      visit();
      rows.delete(cell.row); columns.delete(cell.col); regions.delete(cell.region); chosen[cell.row] = -1;
      if (count >= limit) return;
    }
  }
  visit(); return count;
}

function assertPuzzle(puzzle) {
  const n = puzzle.size;
  assert.equal(puzzle.regions.length, n * n); assert.equal(puzzle.solution.length, n);
  assert.equal(new Set(puzzle.solution.map(index => Math.floor(index / n))).size, n);
  assert.equal(new Set(puzzle.solution.map(index => index % n)).size, n);
  assert.equal(new Set(puzzle.solution.map(index => puzzle.regions[index])).size, n);
  assert.ok(puzzle.regions.every(region => Number.isInteger(region) && region >= 0 && region < n));
  for (const a of puzzle.solution) for (const b of puzzle.solution) if (a !== b) {
    assert.ok(Math.abs(Math.floor(a / n) - Math.floor(b / n)) > 1 || Math.abs(a % n - b % n) > 1, 'cats must not touch');
  }
  for (let region = 0; region < n; region++) {
    const members = puzzle.regions.flatMap((value, index) => value === region ? [index] : []);
    assert.ok(members.length >= 3, `region ${region} has fewer than three cells`);
    const reached = new Set([members[0]]), queue = [members[0]];
    for (let pos = 0; pos < queue.length; pos++) {
      const index = queue[pos], row = Math.floor(index / n), col = index % n;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const rr = row + dr, cc = col + dc, next = rr * n + cc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n && puzzle.regions[next] === region && !reached.has(next)) { reached.add(next); queue.push(next); }
      }
    }
    assert.equal(reached.size, members.length, `region ${region} is disconnected`);
  }
  assert.equal(solutionCount(puzzle), 1, 'the puzzle must have exactly one valid solution');
}

test('legacy settings retain all four modes, supported sizes, and a disabled streak cap by default', () => {
  const h = harness();
  for (const mode of ['basic', 'items', 'treasure', 'coop']) for (const size of [6, 12, 20, 24]) {
    const settings = h.cleanSettings({ mode, size });
    assert.equal(settings.mode, mode); assert.equal(settings.size, size); assert.equal(settings.streakLimitEnabled, false);
  }
  assert.equal(h.cleanSettings({ mode: 'scout' }).mode, 'basic');
  assert.equal(h.cleanSettings({ streakLimitEnabled: 'true' }).streakLimitEnabled, false);
  assert.equal(h.cleanSettings({ streakLimitEnabled: true }).streakLimitEnabled, true);
  assert.equal(h.cleanSettings({ mode: 'battle', size: 24 }).size, 6);
});

test('basic misses expose an empty cell, no adjacent count, and switch turns once', () => {
  const h = harness(), game = h.begin(), index = emptyCell(game, h);
  vm.runInContext('neighborCatCount = () => { throw new Error("ordinary misses must not use adjacent counts"); };', h.context);
  h.act(0, h.action('guess', { index }));
  assert.deepEqual(json(game.misses), [index]); assert.equal(game.turn, 1); assert.equal(game.turnId, 2);
  assert.deepEqual(json(game.clues), {}); assert.equal(game.players[0].fish, 0);
  assert.equal(game.deadline, h.now() + 60_000);
  h.renderLegacy();
  const cell = h.get('#board').children[index];
  assert.equal(cell.textContent, ''); assert.ok(cell.classList.contains('opened'));
  assert.match(cell.getAttribute('aria-label'), /已翻開的空格/);
  assert.equal(h.messages.at(-1).state.clues[index], undefined);
});

test('basic hits keep the turn beyond the old cap and duplicate actions cannot score twice', () => {
  const h = harness(), game = h.begin();
  for (const index of game.puzzle.solution.slice(0, 4)) {
    const action = h.action('guess', { index }); h.act(0, action); h.act(0, action);
  }
  assert.equal(game.turn, 0); assert.equal(game.streak, 4); assert.equal(game.players[0].cats, 4); assert.equal(game.players[0].score, 4);
  assert.equal(game.turnId, 5);
});

test('legacy host rejects wrong-turn, stale-turn, out-of-bounds and late actions', () => {
  const h = harness(), game = h.begin(), index = game.puzzle.solution[0];
  h.act(1, h.action('guess', { index }));
  h.act(0, h.action('guess', { index, turnId: game.turnId - 1 }));
  for (const invalid of [-1, 36, 1.5, NaN]) h.act(0, h.action('guess', { index: invalid }));
  assert.equal(game.found.length, 0); assert.equal(game.turn, 0);
  h.advance(45_000); h.act(0, h.action('guess', { index }));
  assert.equal(game.found.length, 0); assert.equal(game.turn, 1);
});

test('explicit streak cap still switches at the configured hit count', () => {
  const h = harness(), game = h.begin(); game.settings.streakLimitEnabled = true; game.settings.streakLimit = 2;
  h.act(0, h.action('guess', { index: game.puzzle.solution[0] }));
  h.act(0, h.action('guess', { index: game.puzzle.solution[1] }));
  assert.equal(game.turn, 1); assert.equal(game.streak, 0); assert.equal(game.lastEvent.type, 'cat'); assert.equal(game.lastEvent.next, 1);
});

test('item misses grant at most four fish to the acting player', () => {
  const h = harness({ mode: 'items' }), game = h.begin();
  for (let i = 0; i < 10; i++) h.act(game.turn, h.action('guess', { index: emptyCell(game, h) }));
  assert.deepEqual(json(game.players.map(player => player.fish)), [4, 4]);
  assert.equal(game.sharedFish, 0); assert.equal(game.misses.length, 10);
});

test('magnifier intel is private for host and sent only by targeted intel message for guest', () => {
  const h = harness({ mode: 'items' }), game = h.begin(); game.players[0].fish = 4;
  const target = emptyCell(game, h), count = h.neighborCatCount(game.puzzle, target);
  assert.equal(h.applyItem(0, h.action('item', { item: 'magnifier', target })), true);
  assert.equal(game.players[0].fish, 2); assert.equal(game.itemUsedThisTurn, true);
  assert.equal(h.state.intel[0].count, count); assert.equal(game.sharedIntel.length, 0);
  assert.equal(h.messages.some(message => message.type === 'intel'), false);
  assert.equal(h.publicGame(game).intel, undefined); assert.equal(h.publicGame(game).lastEvent.count, undefined);
  assert.equal(h.applyItem(0, h.action('item', { item: 'hourglass' })), false);
  h.switchTurn(); game.players[1].fish = 2;
  assert.equal(h.applyItem(1, h.action('item', { item: 'magnifier', target })), true);
  assert.equal(h.state.intel.length, 1); assert.equal(h.messages.filter(message => message.type === 'intel').length, 1);
  assert.equal(h.messages.find(message => message.type === 'intel').intel.count, count);
  assert.equal(h.messages.filter(message => message.type === 'state').some(message => JSON.stringify(message).includes('magnifier"')), true, 'item event may disclose kind, never the intel result');
  for (const message of h.messages.filter(message => message.type === 'state')) {
    assert.equal(message.state.sharedIntel.length, 0); assert.equal(message.state.intel, undefined);
    assert.equal(message.state.lastEvent?.count, undefined);
  }
});

test('yarn validates connected same-region subsets before spending fish', () => {
  const h = harness({ mode: 'items' }), game = h.begin(); game.players[0].fish = 4;
  assert.equal(h.applyItem(0, h.action('item', { item: 'yarn', targets: [0, 35] })), false);
  assert.equal(game.players[0].fish, 4); assert.equal(game.itemUsedThisTurn, false);
  let pair;
  for (let index = 0; index < 36 && !pair; index++) for (const next of [index % 6 < 5 ? index + 1 : -1, index + 6]) {
    if (next >= 0 && next < 36 && game.puzzle.regions[index] === game.puzzle.regions[next]) pair = [index, next];
  }
  assert.ok(pair); assert.equal(h.applyItem(0, h.action('item', { item: 'yarn', targets: pair })), true);
  assert.equal(game.players[0].fish, 2); assert.equal(h.state.intel[0].hasCat, pair.some(index => game.puzzle.solution.includes(index)) ? 1 : 0);
});

test('shield consumes one miss, preserves turn, and grants no fish for that miss', () => {
  const h = harness({ mode: 'items' }), game = h.begin(); game.players[0].fish = 4;
  assert.equal(h.applyItem(0, h.action('item', { item: 'shield' })), true);
  h.act(0, h.action('guess', { index: emptyCell(game, h) }));
  assert.equal(game.turn, 0); assert.equal(game.shield, null); assert.equal(game.players[0].fish, 1); assert.equal(game.lastEvent.type, 'shield');
  assert.equal(game.itemUsedThisTurn, true);
  h.act(0, h.action('guess', { index: emptyCell(game, h) }));
  assert.equal(game.turn, 1); assert.equal(game.players[0].fish, 2); assert.equal(game.itemUsedThisTurn, false);
});

test('hourglass adds exactly ten seconds and rejects insufficient balance/stale use', () => {
  const h = harness({ mode: 'items' }), game = h.begin(), deadline = game.deadline;
  assert.equal(h.applyItem(0, h.action('item', { item: 'hourglass' })), false);
  game.players[0].fish = 4;
  assert.equal(h.applyItem(0, h.action('item', { item: 'hourglass', turnId: 999 })), false);
  assert.equal(h.applyItem(0, h.action('item', { item: 'hourglass' })), true);
  assert.equal(game.deadline, deadline + 10_000); assert.equal(game.players[0].fish, 2);
  assert.equal(h.applyItem(0, h.action('item', { item: 'hourglass' })), false);
  assert.equal(game.deadline, deadline + 10_000);
});

test('treasure cat scores two points and only found treasure identities become public', () => {
  const h = harness({ mode: 'treasure' }), game = h.begin();
  assert.equal(game.treasures.length, 2);
  h.act(0, h.action('guess', { index: game.treasures[0] }));
  const ordinary = game.puzzle.solution.find(index => !game.treasures.includes(index));
  h.act(0, h.action('guess', { index: ordinary }));
  assert.equal(game.players[0].score, 3); assert.equal(game.players[0].cats, 2);
  const snapshot = json(h.publicGame(game));
  assert.deepEqual(snapshot.foundTreasures, [game.treasures[0]]); assertNoPrivateKeys(snapshot);
});

test('cooperative mode shares fish and intel, then finishes with a shared winner', () => {
  const h = harness({ mode: 'coop' }), game = h.begin();
  h.act(0, h.action('guess', { index: emptyCell(game, h) }));
  h.act(1, h.action('guess', { index: emptyCell(game, h) }));
  assert.equal(game.sharedFish, 2); assert.deepEqual(json(game.players.map(player => player.fish)), [0, 0]);
  assert.equal(h.applyItem(0, h.action('item', { item: 'magnifier', target: game.puzzle.solution[0] })), true);
  assert.equal(game.sharedFish, 0); assert.equal(game.sharedIntel.length, 1); assert.equal(h.state.intel.length, 0);
  assert.equal(json(h.publicGame(game)).sharedIntel.length, 1);
  for (const index of game.puzzle.solution) h.act(game.turn, h.action('guess', { index }));
  assert.equal(game.status, 'finished'); assert.equal(game.winner, 'coop'); assert.equal(game.deadline, null);
  assert.equal(game.found.length, 6); assert.equal(game.players.reduce((sum, player) => sum + player.cats, 0), 6);
});

test('public legacy snapshots never include solutions, secret treasure sets or local notes', () => {
  for (const mode of ['basic', 'items', 'treasure', 'coop']) {
    const h = harness({ mode }), game = h.begin(); h.state.notes.add(8); h.state.intel.push({ type: 'magnifier', targets: [8], count: 2 });
    const snapshot = json(h.publicGame(game)); assertNoPrivateKeys(snapshot);
    assert.equal(snapshot.intel, undefined); assert.equal(snapshot.puzzle.regions.length, 36);
    assert.equal(game.puzzle.solution.length, 6); assert.ok(game.treasures.length > 0);
  }
});

test('private notes are role-isolated in storage and toggling a note never transmits an action', () => {
  const h = harness(), game = h.begin(); h.state.mode = 'note';
  h.renderLegacy(); h.get('#board').children[3].onclick();
  assert.equal(h.messages.length, 0); assert.equal(h.state.notes.has(3), true);
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-host')), [3]);
  assert.equal(h.context.sessionStorage.getItem('p2pNotes-guest'), null);
  h.state.role = 'guest'; h.state.you = 1; h.state.notes = new Set([17]); h.saveLocal();
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-host')), [3]);
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-guest')), [17]);
  assertNoPrivateKeys(json(h.publicGame(game)));
});

test('new guest puzzle clears local notes/intel but ordinary state refresh preserves them', () => {
  const h = harness(), game = h.begin(); h.state.role = 'guest'; h.state.you = 1;
  h.state.notes.add(9); h.state.intel.push({ targets: [9], count: 1 });
  h.onMessage({ type: 'state', state: json(h.publicGame(game)) });
  assert.equal(h.state.notes.has(9), true); assert.equal(h.state.intel.length, 1);
  const next = json(h.publicGame(game)); next.puzzle.id += '-rematch';
  h.onMessage({ type: 'state', state: next });
  assert.equal(h.state.notes.size, 0); assert.equal(h.state.intel.length, 0);
});

test('short room codes normalize whitespace/case and preserve compatible long room IDs', () => {
  const h = harness();
  assert.equal(h.normalizeRoom('  cAt- 00 42\n'), 'CAT-0042');
  assert.equal(h.peerIdForRoom(h.normalizeRoom('cat-0042')), 'cat-hide-seek-v1-cat-0042');
  assert.equal(h.ROOM_RE.test('CAT-0042'), true); assert.equal(h.ROOM_RE.test('CAT-123'), false);
  assert.equal(h.ROOM_RE.test('CAT-ABCDEF-123456'), true); assert.equal(h.peerIdForRoom('CAT-ABCDEF-123456'), 'CAT-ABCDEF-123456');
  for (let i = 0; i < 100; i++) assert.match(h.randomRoom(), /^CAT-\d{4}$/);
  h.get('#roomInput').value = '  cAt- 00 42 '; h.startPeerGuest();
  assert.equal(h.state.room, 'CAT-0042'); assert.equal(h.state.role, 'guest');
});

for (const size of [6, 12, 20, 24]) test(`generated ${size}×${size} legacy puzzles have connected ≥3-cell regions and exactly one solution`, () => {
  const h = harness({ size, seed: 0xABCD + size });
  for (let i = 0; i < 6; i++) assertPuzzle(h.makePuzzle(size));
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} rematch requires both votes and resets per-game/private state`, () => {
  const h = harness({ mode }), game = h.begin(), oldPuzzle = game.puzzle.id, oldStarter = game.starter;
  h.state.notes.add(5); h.state.intel.push({ count: 1 }); game.players[0].fish = 3;
  h.act(0, h.action('guess', { index: game.puzzle.solution[0] }));
  h.rematchVote(0); assert.equal(game.puzzle.id, oldPuzzle);
  h.rematchVote(1);
  assert.notEqual(game.puzzle.id, oldPuzzle); assert.equal(game.starter, 1 - oldStarter);
  assert.equal(game.found.length, 0); assert.equal(game.misses.length, 0); assert.equal(game.sharedFish, 0);
  assert.equal(game.players[0].score, 0); assert.equal(game.players[0].fish, 0);
  assert.equal(h.state.notes.size, 0); assert.equal(h.state.intel.length, 0); assert.equal(game.status, 'playing');
});

function battleAction(h, who, extra = {}) {
  return h.action('guess', { boardId: h.state.game.boards[who].puzzle.id,
    index: h.state.game.boards[who].puzzle.solution[0], ...extra });
}

test('battle newGame routes to the engine with independent six-cell-answer boards and lobby startup', () => {
  const h = harness({ mode: 'battle', size: 24, battle: true });
  const game = h.newGame(24); h.state.game = game;
  assert.equal(game.settings.mode, 'battle'); assert.equal(game.settings.size, 6); assert.equal(game.status, 'lobby');
  assert.equal(game.boards.length, 2); assert.equal(game.players[0].nickname, 'Test Cat');
  assert.equal(game.players[1].connected, false);
  assert.notEqual(game.boards[0].puzzle.id, game.boards[1].puzzle.id);
  assert.notDeepEqual(json(game.boards[0].puzzle.solution), json(game.boards[1].puzzle.solution));
  h.onMessage({ type: 'hello', nickname: 'Guest Cat', avatar: 4 });
  assert.equal(game.status, 'playing'); assert.equal(game.players[1].nickname, 'Guest Cat');
  assert.equal(game.players[1].connected, true); assert.equal(h.messages.at(-1).type, 'state');
});

test('battle act adapter accepts both players independently of legacy turns and acknowledges authoritative results', () => {
  const h = harness({ mode: 'battle', battle: true }), game = h.begin();
  game.turn = 0; game.turnId = 123;
  const guestAction = battleAction(h, 1, { turnId: -1, damage: 99999, combo: 1000, who: 0 });
  const result = h.act(1, guestAction);
  assert.equal(result.accepted, true); assert.equal(game.players[0].hp, 145); assert.equal(game.players[1].hp, 150);
  assert.equal(game.boards[1].found.length, 1); assert.equal(game.boards[0].found.length, 0);
  assert.equal(game.boards[1].combo, 1);
  assert.deepEqual(h.messages[0], { type: 'battleAck', actionId: guestAction.actionId, accepted: true });
  assertNoPrivateKeys(h.messages[1].state);
  const hostAction = battleAction(h, 0); h.state.pendingAction = hostAction;
  assert.equal(h.act(0, hostAction).accepted, true);
  assert.equal(h.state.pendingAction, null); assert.equal(game.players[1].hp, 145);
  assert.equal(game.turn, 0); assert.equal(game.turnId, 123);
});

test('battle host wire adapter rejects stale/other-player board IDs and duplicate actions without applying client state', () => {
  const h = harness({ mode: 'battle', battle: true }), game = h.begin(), originalHP = game.players.map(player => player.hp);
  const wrongBoard = battleAction(h, 1, { boardId: game.boards[0].puzzle.id });
  h.onMessage({ type: 'action', action: wrongBoard, state: { players: [{ hp: 0 }, { hp: 0 }] } });
  assert.equal(h.messages[0].accepted, false); assert.equal(h.messages[0].reason, 'stale-board');
  assert.deepEqual(json(game.players.map(player => player.hp)), json(originalHP));
  const valid = battleAction(h, 1); h.onMessage({ type: 'action', action: valid });
  assert.equal(game.players[0].hp, 145);
  h.onMessage({ type: 'action', action: valid });
  assert.equal(game.players[0].hp, 145); assert.equal(h.messages.at(-2).reason, 'duplicate');
});

test('battle public snapshots use a recursive allowlist and do not share mutable private state', () => {
  const h = harness({ mode: 'battle', battle: true }), game = h.begin();
  game.futurePrivate = { solution: [999], token: 'secret-marker' };
  game.boards[0].secret = { solution: [999] }; game.boards[0].puzzle.secret = 'secret-marker';
  game.players[0].privateIntel = 'secret-marker'; game.lastEvent = { type: 'hit', damage: 5, secret: { solution: [999] } };
  h.state.notes.add(8); h.state.intel.push({ count: 2 });
  const snapshot = h.publicGame(game); assertNoPrivateKeys(snapshot);
  assert.equal(JSON.stringify(snapshot).includes('secret-marker'), false);
  assert.equal(Object.keys(snapshot).some(key => key.startsWith('_')), false);
  snapshot.boards[0].puzzle.regions[0] = 999; snapshot.boards[0].found.push(999); snapshot.players[0].hp = 0;
  assert.notEqual(game.boards[0].puzzle.regions[0], 999); assert.equal(game.boards[0].found.length, 0); assert.equal(game.players[0].hp, 150);
});

test('battle disconnect pauses both players and hello resumes the same boards with remaining cooldown', () => {
  const h = harness({ mode: 'battle', battle: true }), game = h.begin();
  const boardIDs = game.boards.map(board => board.puzzle.id);
  const miss = game.boards[0].puzzle.regions.findIndex((_, index) => !game.boards[0].puzzle.solution.includes(index));
  h.act(0, battleAction(h, 0, { index: miss })); h.advance(500); h.onClose();
  assert.equal(game.status, 'paused'); assert.equal(game.players[1].connected, false); assert.equal(h.state.disconnectAt, h.now());
  assert.equal(h.act(1, battleAction(h, 1)).reason, 'not-playing');
  h.advance(10_000); h.onMessage({ type: 'hello', nickname: 'Guest Cat', avatar: 1 });
  assert.equal(game.status, 'playing'); assert.equal(game.players[1].connected, true); assert.equal(h.state.disconnectAt, null);
  assert.deepEqual(json(game.boards.map(board => board.puzzle.id)), json(boardIDs));
  assert.equal(game.boards[0].cooldownUntil - h.now(), 1500);
  assert.equal(h.act(0, battleAction(h, 0)).reason, 'cooldown');
  h.advance(1500); assert.equal(h.act(0, battleAction(h, 0)).accepted, true);
});

test('battle guest acknowledgements clear only the matching pending action and snapshots clear notes only on own rollover', () => {
  const h = harness({ mode: 'battle', battle: true }), game = h.begin(); h.state.role = 'guest'; h.state.you = 1;
  h.state.pendingAction = { actionId: 'pending' }; h.state.notes.add(7);
  h.onMessage({ type: 'battleAck', actionId: 'older', accepted: false }); assert.ok(h.state.pendingAction);
  h.onMessage({ type: 'battleAck', actionId: 'pending', accepted: false }); assert.equal(h.state.pendingAction, null);
  const snapshot = json(h.publicGame(game)); snapshot.serverTime = h.now() + 1250;
  snapshot.boards[0].puzzle.id += '-opponent-rollover'; h.onMessage({ type: 'state', state: snapshot });
  assert.equal(h.state.clockOffset, 1250); assert.equal(h.state.notes.has(7), true);
  const next = json(snapshot); next.boards[1].puzzle.id += '-own-rollover'; h.onMessage({ type: 'state', state: next });
  assert.equal(h.state.notes.size, 0);
  assert.equal(h.context.CatBattle.act(h.state.game, 1, { type: 'guess', actionId: 'not-authority', boardId: next.boards[1].puzzle.id, index: 0 }, h.now()).reason, 'not-authority');
});

test('battle UI renders opponent cells read-only and keeps local notes usable during cooldown', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.renderBattle();
  const own = h.get('.battle-side.local').querySelector('.battle-board');
  const opponent = h.get('.battle-side.opponent').querySelector('.battle-board');
  assert.equal(own.children.length, 36); assert.equal(opponent.children.length, 36);
  assert.equal(own.children.every(cell => cell.tagName === 'BUTTON' && typeof cell.onclick === 'function'), true);
  assert.equal(opponent.children.every(cell => cell.tagName === 'SPAN' && cell.onclick === undefined && cell.getAttribute('aria-readonly') === 'true'), true);
  game.boards[0].cooldownUntil = h.now() + 2000; h.state.mode = 'note'; h.battleChoose(0);
  assert.equal(h.state.notes.has(0), true); assert.equal(h.messages.length, 0); assert.equal(game.boards[0].found.length, 0);
  h.state.mode = 'guess'; h.battleChoose(game.boards[0].puzzle.solution[0]);
  assert.equal(h.messages.length, 0); assert.equal(game.boards[0].found.length, 0);
});

test('battle guest UI sends a request without locally changing HP or revealing a cell, and blocks repeated clicks', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), authority = h.begin();
  h.state.game = json(h.publicGame(authority)); h.state.role = 'guest'; h.state.you = 1;
  const game = h.state.game, index = authority.boards[1].puzzle.solution[0];
  h.battleChoose(index); h.battleChoose(index);
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].type, 'action');
  assert.equal(h.messages[0].action.boardId, game.boards[1].puzzle.id); assert.equal(h.messages[0].action.index, index);
  assert.equal(game.players[0].hp, 150); assert.equal(game.boards[1].found.length, 0); assert.ok(h.state.pendingAction);
});

test('battle disconnect expiry aborts without a winner and does not auto-resume on a later hello', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.onClose(); h.advance(60_000);
  for (const interval of h.intervals) interval();
  assert.equal(game.status, 'aborted'); assert.equal(game.winner, null);
  h.onMessage({ type: 'hello', nickname: 'Late Guest' });
  assert.equal(game.status, 'aborted'); assert.equal(game.winner, null);
});

test('battle rendered note markers appear only on the local board and cooldown disables guesses, not notes', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.state.notes.add(0); game.boards[0].cooldownUntil = h.now() + 2000;
  h.renderBattle();
  let own = h.get('.battle-side.local').querySelector('.battle-board');
  const opponent = h.get('.battle-side.opponent').querySelector('.battle-board');
  assert.equal(own.children[0].classList.contains('note'), true);
  assert.equal(opponent.children.some(cell => cell.classList.contains('note')), false);
  assert.equal(own.children.every(cell => cell.disabled), true);
  h.state.mode = 'note'; h.renderBattle(); own = h.get('.battle-side.local').querySelector('.battle-board');
  assert.equal(own.children.every(cell => !cell.disabled), true);
  h.advance(2000); h.state.mode = 'guess'; h.renderBattle(); own = h.get('.battle-side.local').querySelector('.battle-board');
  assert.equal(own.children.every(cell => !cell.disabled), true);
});

test('battle UI clears local notes only when the local player advances to a new puzzle', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.renderBattle(); h.state.notes.add(0);
  const initialOwnID = game.boards[0].puzzle.id, initialOpponentID = game.boards[1].puzzle.id;
  for (const index of [...game.boards[1].puzzle.solution]) {
    assert.equal(h.act(1, battleAction(h, 1, { index })).accepted, true); h.advance(300);
  }
  h.renderBattle();
  assert.notEqual(game.boards[1].puzzle.id, initialOpponentID); assert.equal(game.boards[0].puzzle.id, initialOwnID);
  assert.equal(h.state.notes.has(0), true);
  for (const index of [...game.boards[0].puzzle.solution]) {
    assert.equal(h.act(0, battleAction(h, 0, { index })).accepted, true); h.advance(300);
  }
  h.renderBattle();
  assert.notEqual(game.boards[0].puzzle.id, initialOwnID); assert.equal(h.state.notes.size, 0);
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-host')), []);
  assert.equal(game.boards[0].combo, 6); assert.equal(game.boards[1].combo, 6);
});

test('local practice explicitly labels its inactive opponent and never pretends to be P2P', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  h.startPractice(); h.renderBattle();
  assert.equal(h.state.practice, true); assert.equal(h.state.transport, null); assert.equal(h.state.peer, null);
  assert.equal(h.state.room, '本機練習'); assert.match(h.get('#battleConnection').textContent, /本機練習.*對手不會行動/);
  assert.equal(h.get('#battleCopyRoom').classList.contains('hidden'), true);
  assert.equal(h.get('#leavePractice').classList.contains('hidden'), false);
  const initial = JSON.stringify(h.state.game);
  h.advance(15_000); for (const interval of h.intervals) interval();
  assert.equal(JSON.stringify(h.state.game), initial); assert.equal(h.messages.length, 0);
  h.get('#leavePractice').onclick();
  assert.equal(h.state.practice, false); assert.equal(h.state.game, null);
  assert.equal(h.get('#game').classList.contains('hidden'), true); assert.equal(h.get('#setup').classList.contains('hidden'), false);
});

test('battle rematch replaces both boards only after both votes and resets HP, combo and notes', () => {
  const h = harness({ mode: 'battle', battle: true }), previous = h.begin();
  h.state.notes.add(3); previous.status = 'finished'; previous.winner = 0; previous.players[1].hp = 0;
  h.rematchVote(0); assert.equal(h.state.game, previous);
  h.rematchVote(1);
  const game = h.state.game;
  assert.notEqual(game, previous); assert.equal(game.status, 'playing'); assert.equal(game.winner, null);
  for (let who = 0; who < 2; who++) {
    assert.notEqual(game.boards[who].puzzle.id, previous.boards[who].puzzle.id);
    assert.equal(game.players[who].hp, 150); assert.equal(game.boards[who].combo, 0); assert.equal(game.boards[who].number, 1);
  }
  assert.equal(h.state.notes.size, 0);
});

test('public entry keeps basic mode as default and offers battle only in the mode picker', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const picker = html.match(/<select id="gameMode">([\s\S]*?)<\/select>/)[1];
  assert.match(picker, /<option value="basic" selected>/);
  assert.match(picker, /<option value="battle">/);
  assert.equal((picker.match(/ selected/g) || []).length, 1);
  assert.match(html, /<button id="previewBattle" class="hidden"/);
  assert.doesNotMatch(html, /<script>\s*startPractice\(\)/);
  assert.match(html, /<h1>貓咪捉迷藏<\/h1>/);
});

test('all six selected avatars are identical in setup, classic cards and battle portraits', () => {
  for (let avatar = 0; avatar < 6; avatar++) {
    const classic = harness({ local: { catAvatar: String(avatar) } });
    assert.equal(classic.state.avatar, avatar);
    const expected = vm.runInContext(`playerAvatar(${avatar}, 'avatar-character')`, classic.context);
    assert.ok(classic.get('#avatarChoices').children[avatar].innerHTML.includes(expected));
    classic.begin(); classic.renderLegacy();
    assert.ok(classic.get('#p0').innerHTML.includes(expected));
    const battle = harness({ mode: 'battle', battle: true, battleUI: true, local: { catAvatar: String(avatar) } });
    battle.begin(); battle.renderBattle();
    assert.ok(battle.get('.battle-side.local').innerHTML.includes(expected));
    assert.equal(battle.publicGame(battle.state.game).players[0].avatar, avatar);
  }
});

test('avatar selection persists and reconnect snapshots keep the selected guest character', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  h.get('#avatarChoices').children[5].onclick();
  assert.equal(h.state.avatar, 5); assert.equal(h.context.localStorage.catAvatar, '5');
  h.begin(); h.onMessage({ type: 'hello', nickname: 'Guest', avatar: 4 });
  assert.equal(h.state.game.players[0].avatar, 5); assert.equal(h.state.game.players[1].avatar, 4);
  h.onClose(); h.onMessage({ type: 'hello', nickname: 'Guest', avatar: 4 });
  assert.equal(h.publicGame(h.state.game).players[1].avatar, 4);
});

test('avatar idle animation includes a reduced-motion opt out', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert.match(css, /@keyframes avatarIdle/);
  assert.match(css, /@keyframes avatarBlink/);
  assert.match(css, /prefers-reduced-motion: reduce[^}]*lively-avatar[^}]*animation: none !important/s);
});
