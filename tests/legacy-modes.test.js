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
    tagName: tagName.toUpperCase(), children: [], parentNode: null, dataset: {}, style: {
      setProperty(key, value) { this[key] = String(value); },
      getPropertyValue(key) { return this[key] || ''; }, removeProperty(key) { delete this[key]; }
    }, value: '',
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
    removeAttribute: key => attributes.delete(key),
    addEventListener() {}, removeEventListener() {}, focus() {},
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    cloneNode() { const clone = element(tagName); clone.className = this.className; clone.innerHTML = html; clone.textContent = this.textContent; return clone; },
    matches(selector) {
      return selector.split(',').some(value => {
        const simple = value.trim(), names = [...simple.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
        const tag = /^[a-z][\w-]*/i.exec(simple)?.[0];
        return (!tag || this.tagName === tag.toUpperCase()) && names.length > 0 && names.every(name => classes.has(name));
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; },
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect() {
      if (classes.has('cell')) { const index = +this.dataset.index; return { left: 100 + (index % 6) * 40, top: 200 + Math.floor(index / 6) * 40, width: 40, height: 40 }; }
      return { left: 0, top: 0, width: 600, height: 600 };
    },
    querySelector(selector) {
      selector = selector.replace(/\s*>\s*/g, ' ');
      if (selector.startsWith('.battle-board ')) return this.querySelector('.battle-board').querySelector(selector.slice(14));
      const cell = /^\.cell\[data-index="(\d+)"\]$/.exec(selector);
      if (cell) return (classes.has('battle-board') ? this : this.querySelector('.battle-board')).children.find(child => +child.dataset.index === +cell[1]) || null;
      if (!descendants.has(selector)) {
        const child = element(); child.parentNode = this;
        if (/^\.[\w-]+$/.test(selector)) {
          const className = selector.slice(1);
          const classAttribute = [...html.matchAll(/class="([^"]*)"/g)].find(match => match[1].split(/\s+/).includes(className));
          child.className = classAttribute ? classAttribute[1] : className;
        }
        descendants.set(selector, child);
      }
      return descendants.get(selector);
    },
    querySelectorAll(selector) {
      const all = [...this.children, ...descendants.values()];
      return all.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
  };
  Object.defineProperties(node, {
    className: { get: () => [...classes].join(' '), set: value => {
      classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    } },
    innerHTML: { get: () => html, set: value => { html = String(value); node.children.forEach(child => { child.parentNode = null; }); node.children = []; descendants.clear(); } },
    isConnected: { get: () => !!node.parentNode },
    offsetWidth: { get: () => 600 }
  });
  return node;
}

function harness({ mode = 'basic', size = 6, seed = 0x1873, battle, battleUI = false, local = {}, session = {} } = {}) {
  const nodes = new Map(), messages = [], intervals = [], timers = new Map(), frames = new Map();
  const get = selector => {
    const match = /^#board \.cell\[data-index="(\d+)"\]$/.exec(selector);
    if (match) return get('#board').children.find(node => +node.dataset.index === +match[1]) || null;
    const side = /^(\.battle-side\.(?:local|opponent))(?: (.+))?$/.exec(selector);
    if (side?.[2]) return get(side[1]).querySelector(side[2]);
    const player = /^\.battle-side\[data-player="([01])"\](?: (.+))?$/.exec(selector);
    if (player) {
      const root = ['local', 'opponent'].map(side => get(`.battle-side.${side}`)).find(node => +node.dataset.player === +player[1]);
      return root ? player[2] ? root.querySelector(player[2]) : root : null;
    }
    if (!nodes.has(selector)) { const node = element(); if (/^\.[\w.-]+$/.test(selector)) node.className = selector.slice(1).replaceAll('.', ' '); nodes.set(selector, node); }
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
    document: { querySelector: get, querySelectorAll: selector => [...nodes.values(), context.document.body].flatMap(node => node.querySelectorAll(selector)), createElement: element,
      addEventListener() {}, hidden: false, body: element() },
    localStorage: storage(local), sessionStorage: storage(session),
    navigator: { clipboard: { writeText: async () => {} } },
    location: { href: 'https://example.test/game', search: '' },
    innerWidth: 1280, innerHeight: 900,
    setTimeout: (fn, delay = 0) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay, interval: delay }); intervals.push(() => { if (timers.has(id)) fn(); }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    matchMedia: () => ({ matches: false }), addEventListener() {},
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
  if (battleUI) vm.runInContext('Object.assign(appTest, { battleChoose, renderBattle, battleMessage, startPractice, updateBattleTimers, clearBattleFX, observeBattleEvent });', context);
  const api = context.appTest;
  api.state.transport = { open: () => true, send: message => messages.push(json(message)), close() {} };
  api.state.role = 'host'; api.state.you = 0; api.state.room = 'CAT-1234';
  return { ...api, context, get, messages, intervals, timers, frames,
    now: () => now, advance: ms => { now += ms; },
    enableRendering() { vm.runInContext('render = appTest.renderLegacy;', context); },
    flushFrames() { const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn(now); },
    tick(ms) {
      const deadline = now + ms;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= deadline).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry; now = Math.max(now, timer.at);
        if (timer.interval) timer.at = now + timer.interval; else timers.delete(id);
        timer.fn();
      }
      now = deadline;
    },
    action: (type = 'guess', extra = {}) => ({ type, turnId: api.state.game.turnId, actionId: `direct-${++serial}`, ...extra }),
    begin() { const game = api.newGame(size); api.state.game = game;
      if (game.settings.mode === 'battle') { game.players.forEach(player => player.connected = true); context.CatBattle.start(game, now); now += 3000; context.CatBattle.advance(game, now); }
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
  assert.equal(game.status, 'lobby');
  h.onMessage({ type: 'battleReady', gameId: game.id });
  assert.equal(game.status, 'countdown'); assert.equal(game.startAt, h.now() + 3000); assert.equal(game.players[1].nickname, 'Guest Cat');
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
  h.onMessage({ type: 'battleReady', gameId: game.id });
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
  const next = json(snapshot); next.revision++; next.boards[1].puzzle.id += '-own-rollover'; h.onMessage({ type: 'state', state: next });
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
  assert.equal(h.state.game.status, 'countdown');
  h.advance(3000); for (const interval of h.intervals) interval();
  assert.equal(h.state.game.status, 'playing');
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
  assert.notEqual(game, previous); assert.equal(game.status, 'countdown'); assert.equal(game.startAt, h.now() + 3000); assert.equal(game.winner, null);
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
  h.onMessage({ type: 'battleReady', gameId: h.state.game.id });
  assert.equal(h.publicGame(h.state.game).players[1].avatar, 4);
});

test('avatar idle animation includes a reduced-motion opt out', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
  assert.match(css, /@keyframes avatarIdle/);
  assert.match(css, /@keyframes avatarBlink/);
  assert.match(css, /prefers-reduced-motion: reduce[^}]*lively-avatar[^}]*animation: none !important/s);
});

test('battle guest readiness starts one shared countdown and rejects all guesses and notes before its deadline', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  const game = h.state.game = h.newGame(6);
  h.onMessage({ type: 'hello', nickname: 'Guest Cat' });
  assert.equal(game.status, 'lobby');
  h.onMessage({ type: 'battleReady', gameId: game.id });
  const startAt = game.startAt;
  assert.equal(game.status, 'countdown'); assert.equal(startAt, h.now() + 3000);
  assert.equal(h.messages.at(-1).state.startAt, startAt);
  h.onMessage({ type: 'hello', nickname: 'Guest Cat' });
  assert.equal(game.startAt, startAt, 'duplicate hello must not restart the countdown');
  const count = h.messages.length;
  for (const mode of ['guess', 'note']) {
    h.state.mode = mode; h.renderBattle();
    assert.equal(h.get('.battle-side.local').querySelector('.battle-board').children.every(cell => cell.disabled), true);
    h.battleChoose(game.boards[0].puzzle.solution[0]);
  }
  assert.equal(h.messages.length, count); assert.equal(h.state.notes.size, 0);
  h.advance(2999);
  assert.equal(h.act(0, battleAction(h, 0)).accepted, false);
  assert.equal(h.act(1, battleAction(h, 1)).accepted, false);
  assert.deepEqual(json(game.players.map(player => player.hp)), [150, 150]);
  assert.deepEqual(json(game.boards.map(board => board.found.length)), [0, 0]);
  assert.equal(game.status, 'countdown'); assert.equal(game.startAt, startAt);
});

test('battle host interval starts at the authoritative countdown deadline and broadcasts that transition once', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  h.state.game = h.newGame(6); h.onMessage({ type: 'hello', nickname: 'Guest Cat' });
  h.onMessage({ type: 'battleReady', gameId: h.state.game.id });
  const game = h.state.game, startAt = game.startAt;
  h.advance(2999); for (const interval of h.intervals) interval();
  assert.equal(game.status, 'countdown');
  h.advance(1); for (const interval of h.intervals) interval();
  assert.equal(game.status, 'playing'); assert.equal(game.startAt, startAt);
  const revisions = h.messages.filter(message => message.type === 'state' && message.state.status === 'playing').map(message => message.state.revision);
  assert.equal(revisions.length, 1);
  for (const interval of h.intervals) interval();
  assert.equal(h.messages.filter(message => message.type === 'state' && message.state.status === 'playing').length, 1);
  assert.equal(h.act(0, battleAction(h, 0)).accepted, true);
});

test('battle guest never self-activates when its countdown clock reaches zero', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  const authority = h.newGame(6); authority.players.forEach(player => { player.connected = true; });
  h.context.CatBattle.start(authority, h.now());
  h.state.role = 'guest'; h.state.you = 1; h.state.game = null;
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) });
  const startAt = h.state.game.startAt;
  h.advance(6000); for (const interval of h.intervals) interval();
  h.renderBattle();
  assert.equal(h.state.game.status, 'countdown'); assert.equal(h.state.game.startAt, startAt);
  const count = h.messages.filter(message => message.type === 'action').length;
  for (const mode of ['guess', 'note']) { h.state.mode = mode; h.battleChoose(authority.boards[1].puzzle.solution[0]); }
  assert.equal(h.state.notes.size, 0); assert.equal(h.messages.filter(message => message.type === 'action').length, count);
  h.context.CatBattle.advance(authority, h.now());
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) });
  assert.equal(h.state.game.status, 'playing'); assert.equal(h.state.game.startAt, startAt);
  h.state.mode = 'guess'; h.battleChoose(authority.boards[1].puzzle.solution[0]);
  assert.equal(h.messages.filter(message => message.type === 'action').length, count + 1);
  assert.equal(h.state.game.players[0].hp, 150, 'only the host may resolve the guest request');
});

test('battle guest ignores older and duplicate snapshot revisions without reverting state or replaying attacks', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), authority = h.begin();
  h.state.role = 'guest'; h.state.you = 1; h.state.game = null;
  h.context.fxCalls = [];
  vm.runInContext('battleAttackFX = event => fxCalls.push(event);', h.context);
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) }); h.renderBattle(); h.flushFrames();
  const previous = json(h.publicGame(authority));
  h.context.CatBattle.act(authority, 0, { type: 'guess', actionId: 'remote-hit', boardId: authority.boards[0].puzzle.id, index: authority.boards[0].puzzle.solution[0] }, h.now());
  const hit = json(h.publicGame(authority));
  h.onMessage({ type: 'state', state: hit }); h.renderBattle(); h.flushFrames();
  assert.equal(h.context.fxCalls.length, 1);
  h.onMessage({ type: 'state', state: json(hit) }); h.renderBattle(); h.flushFrames();
  const repeatedEvent = json(hit); repeatedEvent.revision++;
  h.onMessage({ type: 'state', state: repeatedEvent }); h.renderBattle(); h.flushFrames();
  h.onMessage({ type: 'state', state: previous }); h.renderBattle(); h.flushFrames();
  assert.equal(h.context.fxCalls.length, 1); assert.equal(h.state.game.revision, repeatedEvent.revision);
  assert.equal(h.state.game.players[1].hp, 145); assert.deepEqual(json(h.state.game.boards[0].found), json(hit.boards[0].found));
});

test('battle clock handshake measures a midpoint offset before notifying host that the guest is ready', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), authority = h.newGame(6);
  h.state.role = 'guest'; h.state.you = 1; h.state.game = null;
  h.onMessage({ type: 'battlePrepare', gameId: authority.id });
  const sync = h.messages.find(message => message.type === 'battleSync');
  assert.ok(sync); assert.equal(sync.gameId, authority.id); assert.equal(sync.sentAt, h.now());
  assert.equal(h.messages.some(message => message.type === 'battleReady'), false);
  h.advance(40);
  h.onMessage({ type: 'battleClock', gameId: authority.id, echo: sync.sentAt, serverTime: h.now() + 100 });
  assert.equal(h.state.clockOffset, 120);
  assert.equal(h.messages.at(-1).type, 'battleReady'); assert.equal(h.messages.at(-1).gameId, authority.id);
  vm.runInContext('startPeerHost(false)', h.context);
  assert.equal(h.state.clockOffset, 0, 'becoming the next host clears the previous host clock offset');
});

test('battle reconnect suppresses historical hit effects but permits the next live event', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), authority = h.begin();
  h.state.role = 'guest'; h.state.you = 1; h.state.game = null;
  h.context.fxCalls = [];
  vm.runInContext('battleAttackFX = event => fxCalls.push(event);', h.context);
  const hit = index => h.context.CatBattle.act(authority, 0, { type: 'guess', actionId: `reconnect-hit-${index}`, boardId: authority.boards[0].puzzle.id, index }, h.now());
  assert.equal(hit(authority.boards[0].puzzle.solution[0]).accepted, true);
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) }); h.renderBattle(); h.flushFrames();
  assert.equal(h.context.fxCalls.length, 0, 'joining a match must not replay its last attack');
  h.advance(300); assert.equal(hit(authority.boards[0].puzzle.solution[1]).accepted, true);
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) }); h.renderBattle(); h.flushFrames();
  assert.equal(h.context.fxCalls.length, 1);
  h.onClose(); assert.equal(h.state.game.status, 'paused');
  h.state.mode = 'guess'; h.battleChoose(authority.boards[1].puzzle.solution[0]);
  assert.equal(h.messages.some(message => message.type === 'action'), false);
  h.onOpen();
  h.advance(300); assert.equal(hit(authority.boards[0].puzzle.solution[2]).accepted, true);
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) }); h.renderBattle(); h.flushFrames();
  assert.equal(h.context.fxCalls.length, 1, 'reconnect snapshot only synchronizes the historical hit');
  h.advance(300); assert.equal(hit(authority.boards[0].puzzle.solution[3]).accepted, true);
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) }); h.renderBattle(); h.flushFrames();
  assert.equal(h.context.fxCalls.length, 2);
});

test('battle rematch resets event identity so the new match can animate the same sequence number once', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), previous = h.begin();
  h.context.fxCalls = [];
  vm.runInContext('battleAttackFX = event => fxCalls.push(event);', h.context);
  h.renderBattle(); h.act(0, battleAction(h, 0)); h.renderBattle(); h.flushFrames();
  assert.equal(h.context.fxCalls.length, 1);
  const oldSequence = previous.lastEvent.sequence, oldID = previous.id;
  previous.status = 'finished'; previous.winner = 0; previous.players[1].hp = 0;
  h.renderBattle(); h.rematchVote(0); h.rematchVote(1); h.renderBattle();
  const game = h.state.game;
  assert.notEqual(game.id, oldID); assert.equal(game.status, 'countdown');
  h.advance(3000); h.context.CatBattle.advance(game, h.now()); h.renderBattle();
  h.act(0, battleAction(h, 0)); h.renderBattle(); h.flushFrames();
  assert.equal(game.lastEvent.sequence, oldSequence);
  assert.equal(h.context.fxCalls.length, 2); assert.notEqual(game.lastEvent.id, previous.lastEvent.id);
  h.renderBattle(); h.flushFrames(); assert.equal(h.context.fxCalls.length, 2);
});

test('battle opening displays 3, 2, 1 from the shared deadline and clears for authoritative play', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  const game = h.state.game = h.newGame(6); game.players[1].connected = true;
  h.context.CatBattle.start(game, h.now()); h.enableRendering(); h.renderBattle();
  const opening = h.get('#battleOpening');
  assert.equal(opening.classList.contains('hidden'), false);
  assert.equal(String(opening.querySelector('.opening-count').textContent), '3');
  h.advance(1000); h.updateBattleTimers();
  assert.equal(String(opening.querySelector('.opening-count').textContent), '2');
  h.advance(1000); h.updateBattleTimers();
  assert.equal(String(opening.querySelector('.opening-count').textContent), '1');
  h.advance(1000); for (const interval of h.intervals) interval();
  assert.equal(game.status, 'playing'); assert.equal(opening.classList.contains('is-countdown'), false);
  assert.equal(h.get('.battle-side.local').querySelector('.battle-board').children.every(cell => !cell.disabled), true);
  h.advance(2000); for (const interval of h.intervals) interval();
  assert.equal(opening.classList.contains('hidden'), true);
  assert.doesNotMatch(opening.querySelector('.opening-count').textContent, /-\d/);
});

test('battle miss lock shows local seconds and progress while the opponent remains active and private notes remain usable', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const miss = game.boards[0].puzzle.regions.findIndex((_, index) => !game.boards[0].puzzle.solution.includes(index));
  assert.equal(h.act(0, battleAction(h, 0, { index: miss })).accepted, true);
  let own = h.get('.battle-side.local'), lock = own.querySelector('.battle-lock');
  assert.equal(lock.classList.contains('hidden'), false);
  assert.match(String(lock.querySelector('.lock-seconds').textContent), /2(?:\.0)?/);
  assert.equal(h.get('.battle-side.opponent').querySelector('.battle-lock').classList.contains('hidden'), true);
  assert.equal(own.querySelector('.battle-board').children.every(cell => cell.disabled), true);
  assert.equal(h.act(1, battleAction(h, 1)).accepted, true, 'one player missing must not lock the opponent');
  h.advance(1000); h.updateBattleTimers();
  own = h.get('.battle-side.local'); lock = own.querySelector('.battle-lock');
  assert.match(String(lock.querySelector('.lock-seconds').textContent), /1(?:\.0)?/);
  const progress = Number.parseFloat(lock.querySelector('.lock-progress > i').style.width);
  assert.equal(progress, 50);
  const privateCell = game.boards[0].puzzle.solution[0], sent = h.messages.length;
  h.state.mode = 'note'; h.battleChoose(privateCell);
  assert.equal(h.state.notes.has(privateCell), true); assert.equal(h.messages.length, sent);
  own = h.get('.battle-side.local');
  assert.equal(own.querySelector('.battle-board').children[privateCell].disabled, false);
  assert.equal(own.querySelector('.battle-lock').classList.contains('notes-available'), true);
  assertNoPrivateKeys(json(h.publicGame(game)));
});

test('battle interval removes the miss lock at its exact deadline and never displays negative time or progress', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const miss = game.boards[0].puzzle.regions.findIndex((_, index) => !game.boards[0].puzzle.solution.includes(index));
  h.act(0, battleAction(h, 0, { index: miss }));
  h.advance(1999); for (const interval of h.intervals) interval();
  assert.equal(h.get('.battle-side.local').querySelector('.battle-lock').classList.contains('hidden'), false);
  assert.equal(h.get('.battle-side.local').querySelector('.battle-board').children[game.boards[0].puzzle.solution[0]].disabled, true);
  h.advance(1); for (const interval of h.intervals) interval();
  let own = h.get('.battle-side.local');
  assert.equal(own.querySelector('.battle-lock').classList.contains('hidden'), true);
  assert.equal(own.querySelector('.battle-board').children[game.boards[0].puzzle.solution[0]].disabled, false);
  h.advance(10000); h.updateBattleTimers(); own = h.get('.battle-side.local');
  const lock = own.querySelector('.battle-lock');
  assert.doesNotMatch(String(lock.querySelector('.lock-seconds').textContent), /-\d/);
  const width = Number.parseFloat(lock.querySelector('.lock-progress > i').style.width);
  assert.ok(Number.isFinite(width) && width >= 0 && width <= 100);
});

test('battle attack launches matching cat artwork from the hit cell and observes each event only once', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.renderBattle();
  const index = game.boards[0].puzzle.solution[0];
  h.act(0, battleAction(h, 0, { index })); h.renderBattle(); h.flushFrames();
  const launches = () => h.context.document.body.children.filter(node => node.classList.contains('battle-cat-launch'));
  assert.equal(launches().length, 1);
  const launch = launches()[0], cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  assert.ok(launch.innerHTML.includes(cell.innerHTML), 'the flight must use the revealed cell cat art');
  assert.equal(Number.parseFloat(launch.style.left), 120 + (index % 6) * 40);
  assert.equal(Number.parseFloat(launch.style.top), 220 + Math.floor(index / 6) * 40);
  assert.equal(game.players[1].hp, 145, 'damage is authoritative before visual impact');
  const timerIDs = [...h.timers.keys()];
  h.observeBattleEvent(game.lastEvent); h.renderBattle(); h.flushFrames();
  assert.equal(launches().length, 1); assert.deepEqual([...h.timers.keys()], timerIDs);
  h.tick(1600); assert.equal(launches().length, 0); assert.equal(game.players[1].hp, 145);
});

for (const status of ['finished', 'aborted']) test(`battle ${status} clears every in-flight effect and timer without replaying the final snapshot`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.renderBattle(); h.act(0, battleAction(h, 0)); h.renderBattle(); h.flushFrames();
  assert.ok(h.context.document.body.children.some(node => node.classList.contains('battle-cat-launch')));
  const fxTimers = [...h.timers].filter(([, timer]) => !timer.interval).map(([id]) => id);
  assert.ok(fxTimers.length > 0);
  if (status === 'finished') { game.status = status; game.winner = 0; game.players[1].hp = 0; game.revision++; }
  else h.context.CatBattle.abort(game, h.now());
  h.renderBattle();
  assert.equal(h.frames.size, 0); assert.equal(fxTimers.some(id => h.timers.has(id)), false);
  assert.equal(h.context.document.body.children.some(node => /battle-(cat-launch|paw-shot|spark)/.test(node.className)), false);
  const snapshot = json(h.publicGame(game));
  h.state.role = 'guest'; h.state.you = 1; h.state.game = json(snapshot);
  h.onMessage({ type: 'state', state: json(snapshot) }); h.renderBattle(); h.flushFrames();
  h.onMessage({ type: 'state', state: json(snapshot) }); h.renderBattle(); h.flushFrames();
  h.tick(1600);
  assert.equal(h.frames.size, 0);
  assert.equal(h.context.document.body.children.some(node => /battle-(cat-launch|paw-shot|spark)/.test(node.className)), false);
  assert.deepEqual(json(h.state.game.players.map(player => player.hp)), json(snapshot.players.map(player => player.hp)));
});

test('battle disconnect immediately cancels in-flight attacks and their cleanup timers', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }); h.begin(); h.renderBattle();
  h.act(0, battleAction(h, 0)); h.renderBattle();
  assert.ok(h.state.battleFXNodes.size > 0);
  assert.ok(h.state.battleFXTimers.size > 0);
  h.onClose(); assert.equal(h.state.game.status, 'paused');
  assert.equal(h.state.battleFXNodes.size, 0); assert.equal(h.state.battleFXTimers.size, 0);
  h.flushFrames();
  assert.equal(h.context.document.body.children.some(node => /battle-(cat-launch|paw-shot|spark)/.test(node.className)), false);
});

test('battle sixth-cat rollover launches from the old cell with its original art and bounds concurrent attack batches', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.renderBattle();
  const oldBoard = game.boards[0], oldID = oldBoard.puzzle.id, solution = [...oldBoard.puzzle.solution];
  for (const index of solution) {
    assert.equal(h.act(0, battleAction(h, 0, { index })).accepted, true);
    h.renderBattle(); h.advance(300);
    assert.ok(h.state.battleFXBatches.length <= 3);
    assert.ok(h.context.document.body.children.filter(node => node.classList.contains('battle-cat-launch')).length <= 3);
  }
  assert.notEqual(game.boards[0].puzzle.id, oldID); assert.equal(game.lastEvent.advanced, true);
  const launch = h.context.document.body.children.find(node => node.classList.contains('battle-cat-launch') && node.dataset.eventId === game.lastEvent.id);
  assert.ok(launch, 'the sixth hit must still launch after its old board is replaced');
  const index = solution.at(-1);
  h.context.expectedCatKey = `${oldID}:${index}`;
  assert.equal(launch.innerHTML, vm.runInContext('battleCat(stableHash(expectedCatKey))', h.context));
  assert.equal(Number.parseFloat(launch.style.left), 120 + (index % 6) * 40);
  assert.equal(Number.parseFloat(launch.style.top), 220 + Math.floor(index / 6) * 40);
  assert.equal(game.players[1].hp, 45); assert.equal(game.boards[0].combo, 6);
});

test('battle reduced-motion mode keeps damage feedback without launching moving cats or changing combat timing', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.context.matchMedia = () => ({ matches: true }); h.renderBattle();
  h.act(0, battleAction(h, 0)); h.renderBattle();
  assert.equal(h.context.document.body.children.some(node => /battle-(cat-launch|paw-shot|spark)/.test(node.className)), false);
  const target = h.get('.battle-side.opponent').querySelector('.hp-meter');
  assert.equal(target.children.filter(node => node.classList.contains('battle-damage')).length, 1);
  assert.equal(game.players[1].hp, 145); assert.equal(game.boards[0].cooldownUntil, h.now() + 300);
  h.tick(1600);
  assert.equal(target.children.filter(node => node.classList.contains('battle-damage')).length, 0);
  assert.equal(h.state.battleFXTimers.size, 0); assert.equal(game.players[1].hp, 145);
});
