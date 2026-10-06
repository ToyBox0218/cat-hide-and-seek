'use strict';

// Browser globals are executed in a VM, never a browser automation driver.
// The fake DOM is intentionally small: these are state/adapter integration
// tests, not substitutes for visual or real-network acceptance testing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const APP_PATH = path.join(__dirname, '..', 'app.js');
const ROOT = path.dirname(APP_PATH);
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

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, once: !!options.once });
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter(listener => listener.fn !== fn));
    },
    dispatchEvent(event) {
      if (typeof event === 'string') event = { type: event };
      event.target ??= this; event.currentTarget = this;
      event.preventDefault ??= () => { event.defaultPrevented = true; };
      for (const listener of [...(listeners.get(event.type) || [])]) {
        if (listener.once) this.removeEventListener(event.type, listener.fn);
        listener.fn.call(this, event);
      }
      this[`on${event.type}`]?.call(this, event);
      if (/^pointer(?:down|move|up|cancel)$/.test(event.type) && event.bubbles !== false) {
        let owner = this.ownerDocument, ancestor = this.parentNode;
        while (!owner && ancestor) { owner = ancestor.ownerDocument; ancestor = ancestor.parentNode; }
        if (owner && owner !== this) owner.dispatchEvent(event);
      }
      return !event.defaultPrevented;
    }
  };
}

function element(tagName = 'div') {
  const attributes = new Map(), classes = new Set(), descendants = new Map(), capturedPointers = new Set();
  let html = '';
  const node = {
    ...eventTarget(),
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
    focus() {},
    setPointerCapture(pointerId) { capturedPointers.add(pointerId); },
    releasePointerCapture(pointerId) { capturedPointers.delete(pointerId); },
    hasPointerCapture(pointerId) { return capturedPointers.has(pointerId); },
    contains(other) { for (let current = other; current; current = current.parentNode) if (current === this) return true; return false; },
    click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    replaceChildren(...children) { this.innerHTML = ''; this.append(...children); },
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
      const board = classes.has('cell') ? this.parentNode : this;
      const size = Number(board?.dataset.size) || Math.sqrt(board?.children.length || 36);
      const origin = board?.closest('.opponent') ? 500 : 100;
      const index = classes.has('cell') ? +this.dataset.index : null;
      if (index !== null) { const left = origin + (index % size) * 40, top = 200 + Math.floor(index / size) * 40; return { left, top, right: left + 40, bottom: top + 40, width: 40, height: 40, x: left, y: top }; }
      if (classes.has('battle-board') || this.children.some(child => child.classList.contains('cell'))) return { left: origin, top: 200, right: origin + size * 40, bottom: 200 + size * 40, width: size * 40, height: size * 40, x: origin, y: 200 };
      return { left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600, x: 0, y: 0 };
    },
    querySelector(selector) {
      selector = selector.replace(/\s*>\s*/g, ' ');
      if (selector.startsWith('.battle-board ')) return this.querySelector('.battle-board').querySelector(selector.slice(14));
      const cell = /^(?:\.cell)?\[data-index="(\d+)"\]$/.exec(selector);
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
    firstElementChild: { get: () => node.children[0] || null },
    offsetWidth: { get: () => 600 }
  });
  return node;
}

function harness({ mode = 'basic', size = 6, width = 1280, seed = 0x1873, battle, battleUI = false, survival = false, survivalUI = false, local = {}, session = {}, fakeAudio = false, AudioContext, matchEnabled, meowSamples = ['./assets/audio/cat-meow-soft.wav', './assets/audio/cat-meow-food.wav', './assets/audio/cat-meow-purr.wav'] } = {}) {
  const nodes = new Map(), messages = [], intervals = [], timers = new Map(), frames = new Map(), toolButtons = new Map();
  let documentOwner = null;
  const get = selector => {
    const tool = /^#toolbox \[data-item="([\w-]+)"\]$/.exec(selector);
    if (tool) return toolButtons.get(tool[1]) || null;
    const match = /^#board \.cell\[data-index="(\d+)"\]$/.exec(selector);
    if (match) return get('#board').children.find(node => +node.dataset.index === +match[1]) || null;
    const side = /^(\.battle-side\.(?:local|opponent))(?: (.+))?$/.exec(selector);
    if (side?.[2]) return get(side[1]).querySelector(side[2]);
    const player = /^\.battle-side\[data-player="([01])"\](?: (.+))?$/.exec(selector);
    if (player) {
      const root = ['local', 'opponent'].map(side => get(`.battle-side.${side}`)).find(node => +node.dataset.player === +player[1]);
      return root ? player[2] ? root.querySelector(player[2]) : root : null;
    }
    if (!nodes.has(selector)) { const node = element(); node.ownerDocument = documentOwner; if (/^\.[\w.-]+$/.test(selector)) node.className = selector.slice(1).replaceAll('.', ' '); nodes.set(selector, node); }
    return nodes.get(selector);
  };
  // Static page chrome is mounted once; renderBattle must never move it into a player section.
  get('.battle-center').appendChild(get('#battleGestureHint'));
  if (survivalUI) {
    get('#survivalBoard').className = 'battle-board survival-board';
    get('.survival-main-board').className = 'survival-main-board local';
    get('.survival-main-board').appendChild(get('#survivalBoard'));
  }
  Object.entries({ '#size': size, '#gameMode': mode, '#secondsA': 45, '#secondsB': 60,
    '#cap': 3, '#battleHP': 150, '#nick': 'Test Cat' }).forEach(([key, value]) => get(key).value = String(value));
  for (const item of ['magnifier', 'yarn', 'shield', 'hourglass']) {
    const button = element('button'); button.dataset.item = item; toolButtons.set(item, button); get('#toolbox').appendChild(button);
  }
  let now = 1_900_000_000_000, serial = 0, rng = seed >>> 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    ...eventTarget(), console, URL, URLSearchParams, Date: Clock, Uint32Array, Float32Array, AudioContext,
    CAT_MATCH_ENABLED: matchEnabled, CAT_MEOW_SAMPLES: meowSamples,
    crypto: {
      getRandomValues(array) {
        for (let i = 0; i < array.length; i++) { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; array[i] = rng >>> 0; }
        return array;
      }, randomUUID: () => `test-action-${++serial}`
    },
    document: { ...eventTarget(), querySelector: get, querySelectorAll: selector => selector === '#toolbox [data-item]' ? [...toolButtons.values()] : [...nodes.values(), context.document.body].flatMap(node => node.querySelectorAll(selector)), createElement: tag => { const node = element(tag); node.ownerDocument = context.document; return node; },
      elementFromPoint(x, y) {
        const grids = survivalUI ? [get('#survivalBoard')] : battleUI ? [get('.battle-side.local').querySelector('.battle-board'), get('.battle-side.opponent').querySelector('.battle-board')] : [get('#board')];
        return grids.flatMap(grid => grid.children).find(cell => { const rect = cell.getBoundingClientRect(); return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom; }) || null;
      }, hidden: false, body: element() },
    localStorage: storage(local), sessionStorage: storage(session),
    navigator: { clipboard: { writeText: async () => {} } },
    location: { href: 'https://example.test/game', search: '' },
    innerWidth: width, innerHeight: 900,
    setTimeout: (fn, delay = 0) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay, interval: delay }); intervals.push(() => { if (timers.has(id)) fn(); }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    matchMedia: () => ({ matches: false }),
    btoa: value => Buffer.from(value).toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString(),
    Peer: class { on() {} destroy() {} },
    CatBattle: battle
  });
  context.window = context; documentOwner = context.document;
  for (const node of nodes.values()) node.ownerDocument = context.document;
  context.document.body.ownerDocument = context.document;
  for (const filename of ['region-palette.js', 'game-audio.js', 'cell-gestures.js', 'board-strokes.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, filename), 'utf8'), context, { filename });
  }
  const audio = { calls: [], options: [], controllers: [], getState: () => audio.controllers.at(-1)?.getState() };
  if (fakeAudio) {
    const create = context.CatAudio.create;
    context.CatAudio = { ...context.CatAudio, create(...args) {
      audio.options.push(args[0]);
      const controller = create(...args); audio.controllers.push(controller);
      return Object.fromEntries(Object.entries(controller).map(([name, value]) => [name, typeof value === 'function' ? (...values) => {
        if (name !== 'getState') audio.calls.push({ method: name, args: json(values) });
        return value.apply(controller, values);
      } : value]));
    } };
  }
  if (battle === true || survival) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'battle-engine.js'), 'utf8'), context, { filename: 'battle-engine.js' });
  if (survival) for (const filename of ['survival-engine.js', 'survival-session.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, filename), 'utf8'), context, { filename });
  vm.runInContext(fs.readFileSync(APP_PATH, 'utf8'), context, { filename: APP_PATH });
  if (battleUI || survivalUI) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'battle-ui.js'), 'utf8'), context, { filename: 'battle-ui.js' });
  if (survival) vm.runInContext(fs.readFileSync(path.join(ROOT, 'survival-app.js'), 'utf8'), context, { filename: 'survival-app.js' });
  if (survivalUI) vm.runInContext(fs.readFileSync(path.join(ROOT, 'survival-ui.js'), 'utf8'), context, { filename: 'survival-ui.js' });
  vm.runInContext(`
    globalThis.appTest = { state, makePuzzle, cleanSettings, newGame, publicGame, act,
      applyItem, saveLocal, broadcast, onMessage, onOpen, onClose, renderLegacy: render,
      setDeadline, switchTurn, neighborCatCount, excluded, unresolved, normalizeRoom,
      randomRoom, peerIdForRoom, ROOM_RE, SHORT_ROOM_RE, rematchVote, startPeerGuest,
      settingsFromUI };
    render = () => {};
  `, context);
  if (battleUI) vm.runInContext('Object.assign(appTest, { battleChoose, renderBattle, battleMessage, startPractice, updateBattleTimers, clearBattleFX, observeBattleEvent });', context);
  if (survival) vm.runInContext('Object.assign(appTest, { startSurvivalHost, adoptSurvivalGuest, applySurvivalSnapshot, survivalStart, survivalChoose, survivalReconnect, survivalLeave, survivalCanMark, survivalMissLocked, disposeSurvivalRoom });', context);
  if (survivalUI) vm.runInContext('Object.assign(appTest, { renderSurvival, updateSurvivalTimers, clearSurvivalUI });', context);
  const api = context.appTest;
  api.state.transport = { open: () => true, send: message => messages.push(json(message)), close() {} };
  api.state.role = 'host'; api.state.you = 0; api.state.room = 'CAT-1234';
  return { ...api, context, get, messages, intervals, timers, frames, audio,
    dispatchDocument(type, extra = {}) { context.document.dispatchEvent({ type, ...extra }); },
    dispatchWindow(type, extra = {}) { context.dispatchEvent({ type, ...extra }); },
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
function ruleRelatedEmptyCells(puzzle, cat) {
  const { size, regions, solution } = puzzle, row = Math.floor(cat / size), column = cat % size;
  const empty = regions.flatMap((_, index) => solution.includes(index) ? [] : [index]);
  const groups = {
    row: empty.filter(index => Math.floor(index / size) === row),
    column: empty.filter(index => index % size === column),
    region: empty.filter(index => regions[index] === regions[cat]),
    adjacent: empty.filter(index => Math.abs(Math.floor(index / size) - row) <= 1 && Math.abs(index % size - column) <= 1)
  };
  for (const [name, cells] of Object.entries(groups)) assert.ok(cells.length, `fixture must cover the ${name} rule`);
  return [...new Set(Object.values(groups).flat())];
}
// The production controller defers a private mark until the 300 ms double-tap
// window closes. Browser click detail alone is not the cell-identity authority.
const GESTURE_WAIT = 310;
function doubleClick(cell, { pointerType = 'mouse', dblclick = true } = {}) {
  for (const detail of [1, 2]) {
    if (pointerType) cell.dispatchEvent({ type: 'pointerdown', button: 0, pointerType, pointerId: detail });
    if (pointerType) cell.dispatchEvent({ type: 'pointerup', button: 0, pointerType, pointerId: detail });
    cell.dispatchEvent({ type: 'click', button: 0, detail });
  }
  if (dblclick) cell.dispatchEvent({ type: 'dblclick', button: 0, detail: 2 });
}
function singleClick(h, cell) {
  pointerAt(cell, 'pointerdown'); pointerAt(cell, 'pointerup');
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
}
function pointerAt(cell, type, target = cell, extra = {}) {
  const rect = target.getBoundingClientRect();
  const event = { type, pointerType: 'mouse', pointerId: 7, button: 0,
    buttons: type === 'pointerup' ? 0 : 1, isPrimary: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, ...extra };
  cell.dispatchEvent(event); return event;
}
function dragMarks(h, grid, { from = 0, to = 5, pointerType = 'mouse', hold = 250 } = {}) {
  const cell = grid().children[from];
  pointerAt(cell, 'pointerdown', cell, { pointerType }); h.tick(hold);
  pointerAt(cell, 'pointermove', grid().children[to], { pointerType });
  pointerAt(cell, 'pointerup', grid().children[to], { pointerType });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 });
  return cell;
}
function stablePublic(h, game = h.state.game) { const value = json(h.publicGame(game)); delete value.serverTime; return value; }
function sentActions(h) { return h.messages.filter(message => message.type === 'action' || message.type === 'state').length; }

function assertUnopenedCell(cell, { note = false, disabled = false } = {}) {
  assert.equal(cell.textContent, note ? '×' : '', `unopened cell ${cell.dataset.index} retains its correct private-only or unopened glyph`);
  for (const name of ['opened', 'cat', 'auto-x', 'dimmed']) assert.equal(cell.classList.contains(name), false, `unopened cell ${cell.dataset.index} must not be ${name}`);
  assert.equal(cell.classList.contains('note'), note);
  assert.equal(cell.disabled, disabled);
  assert.doesNotMatch(cell.getAttribute('aria-label'), /自動排除|規則排除|已翻開|確認沒有貓/);
  if (note) assert.match(cell.getAttribute('aria-label'), /私人筆記.*尚未確認/);
  assert.equal(cell.style.opacity ?? '', ''); assert.equal(cell.style.filter ?? '', '');
}
function assertGuessBlocked(h, cell, game, message = 'the current restriction blocks left-click guesses') {
  const before = json(h.publicGame(game)), notes = [...h.state.notes], sent = h.messages.length;
  doubleClick(cell);
  assert.deepEqual(json(h.publicGame(game)), before, message); assert.deepEqual([...h.state.notes], notes); assert.equal(h.messages.length, sent);
}
function assertConfirmedEmpty(cell) {
  assert.equal(cell.textContent, '×'); assert.equal(cell.classList.contains('opened'), true);
  assert.equal(cell.classList.contains('note'), false); assert.equal(cell.classList.contains('auto-x'), false);
  assert.match(cell.getAttribute('aria-label'), /已翻開的空格.*確認沒有貓/);
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

// Widths exercise the real responsive sizing branch and generated DOM/ARIA only.
// Layout containment, clipping and visual alignment still need browser review.
for (const mode of ['basic', 'items', 'treasure', 'coop']) for (const width of [320, 360, 390, 430, 1280]) {
  test(`${mode} render at ${width}px preserves long names, populated baskets, intel and private-note controls`, () => {
    const h = harness({ mode, size: 24, width }), game = h.begin();
    const captures = game.puzzle.solution.slice(0, 23), target = game.puzzle.solution[23];
    game.found = captures;
    game.foundBy = Object.fromEntries(captures.map((index, position) => [index, position < 20 ? 0 : 1]));
    for (const who of [0, 1]) {
      game.players[who].nickname = `${who ? '對手' : '我的'}很長很長很長很長的貓咪名字 <貓&朋友>`;
      game.players[who].cats = who ? 3 : 20; game.players[who].score = who ? 3 : 20;
      game.players[who].fish = 4;
    }
    game.sharedFish = 4;
    const intel = [
      { type: 'magnifier', targets: [target], count: 1, at: h.now() - 2 },
      { type: 'magnifier', targets: [target], count: 2, at: h.now() - 1 },
      { type: 'yarn', targets: [target], hasCat: 1, at: h.now() }
    ];
    if (['items', 'coop'].includes(mode)) {
      if (mode === 'coop') game.sharedIntel = intel; else h.state.intel = intel;
    }
    h.enableRendering(); h.renderLegacy();
    assert.equal(h.context.innerWidth, width); assert.equal(h.get('#battleArena').classList.contains('hidden'), true);
    const board = h.get('#board'), size = Number.parseFloat(board.style.getPropertyValue('--s'));
    assert.equal(board.children.length, 24 * 24); assert.equal(board.dataset.size, '24');
    assert.ok(Number.isFinite(size) && size >= 18 && size <= 36, 'responsive cell size stays finite and usable');
    assert.equal(h.get('#p0').classList.contains('current'), true); assert.equal(h.get('#p0').getAttribute('aria-current'), 'true');
    assert.equal(h.get('#p1').classList.contains('inactive'), true); assert.equal(h.get('#p1').getAttribute('aria-current'), 'false');
    for (const who of [0, 1]) {
      const html = h.get(`#p${who}`).innerHTML;
      assert.match(html, /很長很長很長很長的貓咪名字 &lt;貓&amp;朋友&gt;/);
      assert.doesNotMatch(html, /<貓&朋友>/);
      assert.equal((html.match(/class="basket-cat"/g) || []).length, who ? 3 : 20, 'every collected cat retains its own authored basket markup');
      assert.match(html, /aria-label="貓咪籃子"/);
      if (['items', 'coop'].includes(mode)) {
        assert.match(html, /class="intel-list"/); assert.match(html, /周圍有 2 隻貓/); assert.match(html, /選取格有貓/);
        assert.doesNotMatch(html, /周圍有 1 隻貓/, 'only the two most recent intel entries occupy each card');
      } else assert.doesNotMatch(html, /class="intel-list"/);
    }
    assert.equal(h.get('#toolbox').classList.contains('hidden'), !['items', 'coop'].includes(mode));
    assert.equal(board.children.filter(cell => cell.classList.contains('cat')).length, 23);
    const before = json(h.publicGame(game)), sent = h.messages.length;
    singleClick(h, h.get('#board').children[target]);
    assertUnopenedCell(h.get('#board').children[target], { note: true });
    assert.equal(h.messages.length, sent); assert.deepEqual(json(h.publicGame(game)), before);
    for (const index of captures) assert.equal(h.get('#board').children[index].disabled, true);
    assert.equal(h.get('#board').children[target].disabled, false);
  });
}

test('basic misses expose an empty cell, no adjacent count, and switch turns once', () => {
  const h = harness(), game = h.begin(), index = emptyCell(game, h);
  vm.runInContext('neighborCatCount = () => { throw new Error("ordinary misses must not use adjacent counts"); };', h.context);
  h.act(0, h.action('guess', { index }));
  assert.deepEqual(json(game.misses), [index]); assert.equal(game.turn, 1); assert.equal(game.turnId, 2);
  assert.deepEqual(json(game.clues), {}); assert.equal(game.players[0].fish, 0);
  assert.equal(game.deadline, h.now() + 60_000);
  h.renderLegacy();
  const cell = h.get('#board').children[index];
  assertConfirmedEmpty(cell);
  assert.equal(h.messages.at(-1).state.clues[index], undefined);
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} found cats leave every unopened rule-related cell playable and real misses cannot be farmed`, () => {
  const h = harness({ mode }), game = h.begin(), cat = game.puzzle.solution[0];
  const related = ruleRelatedEmptyCells(game.puzzle, cat);
  h.enableRendering(); h.renderLegacy(); doubleClick(h.get('#board').children[cat]);
  assert.deepEqual(json(game.found), [cat]);
  for (let index = 0; index < game.puzzle.size ** 2; index++) if (index !== cat) {
    assertUnopenedCell(h.get('#board').children[index]);
    assert.equal(h.unresolved(game, index), true, `cell ${index} remains unresolved until explicitly opened`);
  }
  const sent = h.messages.length;
  singleClick(h, h.get('#board').children[related[0]]);
  assertUnopenedCell(h.get('#board').children[related[0]], { note: true });
  assert.equal(h.messages.length, sent, 'manual notes are private, even on a rule-related cell');
  assertNoPrivateKeys(json(h.publicGame(game)));
  for (const index of related) {
    if (game.turn !== 0) h.act(1, h.action('pass'));
    const beforeFish = mode === 'coop' ? game.sharedFish : game.players[0].fish;
    doubleClick(h.get('#board').children[index]);
    assert.equal(game.misses.includes(index), true, `rule-related cell ${index} accepts a real miss`);
    assert.equal(game.turn, 1); assertConfirmedEmpty(h.get('#board').children[index]);
    const afterFish = mode === 'coop' ? game.sharedFish : game.players[0].fish;
    assert.equal(afterFish, ['items', 'coop'].includes(mode) ? Math.min(4, beforeFish + 1) : beforeFish);
    const snapshot = json(h.publicGame(game)), count = h.messages.length;
    const repeat = h.action('guess', { index });
    h.act(game.turn, repeat); h.act(game.turn, repeat);
    assert.deepEqual(json(h.publicGame(game)), snapshot, 'repeated misses never change fish, score, turn or deadline');
    assert.equal(h.messages.length, count, 'already opened cells do not broadcast another result');
  }
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
  const h = harness(), game = h.begin();
  h.renderLegacy(); singleClick(h, h.get('#board').children[3]);
  assert.equal(h.messages.length, 0); assert.equal(h.state.notes.has(3), true);
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-host')), [3]);
  assert.equal(h.context.sessionStorage.getItem('p2pNotes-guest'), null);
  h.state.role = 'guest'; h.state.you = 1; h.state.notes = new Set([17]); h.saveLocal();
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-host')), [3]);
  assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-guest')), [17]);
  assertNoPrivateKeys(json(h.publicGame(game)));
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} snapshots and reconnect preserve factual empty cells and never recreate automatic marks or another player's notes`, () => {
  const host = harness({ mode }), game = host.begin(), cat = game.puzzle.solution[0];
  const [miss, hostNote, guestNote] = ruleRelatedEmptyCells(game.puzzle, cat);
  host.act(0, host.action('guess', { index: cat }));
  host.act(0, host.action('guess', { index: miss })); host.state.notes.add(hostNote);
  const snapshot = json(host.publicGame(game)); assertNoPrivateKeys(snapshot);
  const guest = harness({ mode }); guest.state.role = 'guest'; guest.state.you = 1;
  guest.enableRendering(); guest.onMessage({ type: 'state', state: snapshot });
  assertConfirmedEmpty(guest.get('#board').children[miss]);
  for (let index = 0; index < 36; index++) if (![cat, miss].includes(index)) assertUnopenedCell(guest.get('#board').children[index]);
  singleClick(guest, guest.get('#board').children[guestNote]);
  assertUnopenedCell(guest.get('#board').children[guestNote], { note: true });
  guest.onMessage({ type: 'state', state: json(snapshot) });
  guest.onClose(); guest.onOpen(); guest.onMessage({ type: 'state', state: json(snapshot) });
  assertConfirmedEmpty(guest.get('#board').children[miss]);
  for (let index = 0; index < 36; index++) if (![cat, miss].includes(index)) {
    assertUnopenedCell(guest.get('#board').children[index], { note: index === guestNote });
  }
  assert.equal(guest.state.notes.has(hostNote), false); assert.equal(guest.state.notes.has(guestNote), true);
});

for (const mode of ['items', 'coop']) test(`${mode} explicit scans can target rule-related cells and show only probed intel without factual X marks`, () => {
  for (const item of ['magnifier', 'yarn']) {
    const h = harness({ mode }), game = h.begin(), cat = game.puzzle.solution[0];
    h.act(0, h.action('guess', { index: cat }));
    game.players[0].fish = 4; game.sharedFish = 4;
    let targets;
    if (item === 'magnifier') targets = [ruleRelatedEmptyCells(game.puzzle, cat)[0]];
    else {
      for (let index = 0; index < 36 && !targets; index++) for (const next of [index % 6 < 5 ? index + 1 : -1, index + 6]) {
        if (next < 0 || next >= 36 || [index, next].includes(cat)) continue;
        if (game.puzzle.regions[index] !== game.puzzle.regions[cat] || game.puzzle.regions[next] !== game.puzzle.regions[cat]) continue;
        if (game.puzzle.regions.filter(region => region === game.puzzle.regions[cat]).length > 3) targets = [index, next];
      }
      assert.ok(targets, 'fixture has a connected proper subset in the already-found region');
    }
    assert.equal(h.applyItem(0, h.action('item', { item, target: targets[0], targets })), true);
    assert.deepEqual(json(game.misses), [], 'a scan never confirms an empty cell');
    const intel = mode === 'coop' ? game.sharedIntel : h.state.intel;
    assert.equal(intel.length, 1); assert.deepEqual(json(intel[0].targets), targets);
    if (item === 'yarn') assert.equal(intel[0].hasCat, 0, 'even a no-cat scan remains intel rather than an opened cell');
    h.renderLegacy();
    for (let index = 0; index < 36; index++) if (index !== cat) {
      const cell = h.get('#board').children[index]; assertUnopenedCell(cell);
      assert.equal(cell.classList.contains('probed'), targets.includes(index), 'only explicitly scanned targets get the probed accent');
    }
    const guest = harness({ mode }); guest.state.role = 'guest'; guest.state.you = 1;
    guest.onMessage({ type: 'state', state: json(h.publicGame(game)) }); guest.renderLegacy();
    for (let index = 0; index < 36; index++) if (index !== cat) {
      const cell = guest.get('#board').children[index]; assertUnopenedCell(cell);
      const unchanged = json(guest.publicGame(guest.state.game)), sent = guest.messages.length;
      doubleClick(cell);
      assert.deepEqual(json(guest.publicGame(guest.state.game)), unchanged); assert.equal(guest.messages.length, sent, 'off-turn guests cannot guess even though primary-click notes remain reachable');
      assert.equal(cell.classList.contains('probed'), mode === 'coop' && targets.includes(index), 'competitive scan intel stays private; cooperative intel stays shared');
    }
  }
});

test('a jointly requested teaching hint may retain text deductions without marking or disabling unopened cells', () => {
  const h = harness(), game = h.begin(), cat = game.puzzle.solution[0];
  h.act(0, h.action('guess', { index: cat }));
  h.act(0, h.action('hint')); assert.equal(game.hint, null);
  h.act(1, h.action('hint')); assert.equal(typeof game.hint, 'string'); assert.ok(game.hint.length);
  h.renderLegacy(); assert.equal(h.get('#message').textContent, game.hint);
  for (let index = 0; index < 36; index++) if (index !== cat) assertUnopenedCell(h.get('#board').children[index]);
});

test('cell styles cannot recreate automatic X marks or block direct private-note toggles', () => {
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.doesNotMatch(css, /\.auto-x\b/, 'automatic exclusion styling must not survive');
  const noteRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => /\.cell\.note\b/.test(selectors));
  assert.ok(noteRules.length, 'private notes retain their own visible style');
  for (const [, selectors, declarations] of noteRules) {
    assert.doesNotMatch(declarations, /pointer-events\s*:\s*none\b/i, `${selectors.trim()} cannot prevent toggling a private note`);
    assert.doesNotMatch(declarations, /\bcontent\s*:/i, `${selectors.trim()} must not duplicate the actual private-mark text`);
  }
  for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\.cell\.opened\b[^{}]*::?(?:before|after)\b/.test(selectors)) assert.doesNotMatch(declarations, /\bcontent\s*:\s*['"][^'"]+['"]/i, 'confirmed-empty text is rendered by the DOM, not a second generated glyph');
  }
});

test('purple private-note and dark-gray confirmed-empty glyphs retain readable contrast on every base region color', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const privateLegends = [...html.matchAll(/class="sample note-sample">([^<]+)<\/i>/g)];
  assert.equal(privateLegends.length, 2);
  assert.ok(privateLegends.every(match => match[1] === '×'), 'both legends use a purple X for private marks');
  assert.match(html, /深灰 × 代表已確認的空格；紫色 ×/);
  for (const file of ['app.js', 'battle-ui.js', 'index.html']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /◇/, `${file} must not show the old diamond marker`);
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const luminance = hex => hex.match(/[\da-f]{2}/gi).map(component => parseInt(component, 16) / 255)
    .map(component => component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4)
    .reduce((sum, component, index) => sum + component * [0.2126, 0.7152, 0.0722][index], 0);
  const palette = require('../region-palette.js');
  for (const [state, expected] of [['note', '#58306f'], ['opened', '#493d35']]) {
    const colors = rules.filter(([, selectors]) => selectors.includes(`.cell.${state}`))
      .flatMap(([, , declarations]) => [...declarations.matchAll(/(?:^|;)\s*color\s*:\s*(#[\da-f]{6})\b/gi)].map(match => match[1]));
    assert.equal(colors.at(-1), expected, `${state} has the distinct final scoped text color`);
    for (const background of palette.colors) {
      const ratio = (Math.max(luminance(background), luminance(expected)) + 0.05) / (Math.min(luminance(background), luminance(expected)) + 0.05);
      assert.ok(ratio >= 4.5, `${state} contrast on ${background}: ${ratio}`);
    }
  }
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

for (const who of [0, 1]) test(`battle player ${who} misses escalate 2/4/6/8/8 seconds without HP loss or replay growth and a cat resets the next miss`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  const board = game.boards[who], opponent = game.boards[1 - who];
  const misses = board.puzzle.regions.flatMap((_, index) => board.puzzle.solution.includes(index) ? [] : [index]);
  assert.equal(h.act(who, battleAction(h, who)).accepted, true); h.advance(300);
  assert.equal(board.combo, 1); assert.equal(board.missStreak, 0);
  for (const [attempt, duration] of [2000, 4000, 6000, 8000, 8000].entries()) {
    const hp = json(game.players.map(player => player.hp));
    const action = battleAction(h, who, { index: misses[attempt] });
    const result = h.act(who, action);
    assert.equal(result.accepted, true); assert.equal(board.combo, 0);
    assert.equal(board.missStreak, attempt + 1); assert.equal(board.cooldownDuration, duration);
    assert.equal(board.cooldownStartedAt, h.now()); assert.equal(board.cooldownUntil, h.now() + duration);
    assert.equal(result.event.missStreak, attempt + 1); assert.equal(result.event.cooldownDuration, duration);
    assert.equal(result.event.damage, 0); assert.deepEqual(json(game.players.map(player => player.hp)), hp);
    const publicBoard = h.publicGame(game).boards[who];
    assert.equal(publicBoard.missStreak, attempt + 1); assert.equal(publicBoard.cooldownDuration, duration);
    assertNoPrivateKeys(json(h.publicGame(game)));
    const beforeReplay = json(h.publicGame(game));
    assert.equal(h.act(who, action).reason, 'duplicate');
    assert.equal(h.act(who, battleAction(h, who, { index: misses[attempt] })).reason, 'resolved-cell');
    assert.equal(h.act(who, battleAction(h, who, { index: misses[attempt + 1] })).reason, 'cooldown');
    assert.deepEqual(json(h.publicGame(game)), beforeReplay, 'duplicate, resolved, and early clicks cannot extend a penalty');
    assert.equal(h.act(1 - who, battleAction(h, 1 - who, { index: opponent.puzzle.solution[attempt] })).accepted, true);
    assert.equal(opponent.missStreak, 0); assert.equal(opponent.cooldownDuration, 300);
    assert.equal(board.cooldownUntil, h.now() + duration, 'an opponent capture cannot change this player’s lock');
    h.advance(duration - 1);
    assert.equal(h.act(who, battleAction(h, who, { index: misses[attempt + 1] })).reason, 'cooldown');
    h.advance(1);
    const afterExpiry = json(h.publicGame(game));
    assert.equal(h.act(who, action).reason, 'duplicate');
    assert.equal(h.act(who, battleAction(h, who, { index: misses[attempt] })).reason, 'resolved-cell');
    assert.deepEqual(json(h.publicGame(game)), afterExpiry, 'an expired miss cannot be used to grow the next penalty');
  }
  assert.equal(h.act(who, battleAction(h, who, { index: board.puzzle.solution[1] })).accepted, true);
  assert.equal(board.missStreak, 0); assert.equal(board.combo, 1); assert.equal(board.cooldownDuration, 300);
  h.advance(300);
  const hp = json(game.players.map(player => player.hp));
  assert.equal(h.act(who, battleAction(h, who, { index: misses[5] })).accepted, true);
  assert.equal(board.missStreak, 1); assert.equal(board.combo, 0); assert.equal(board.cooldownDuration, 2000);
  assert.equal(board.cooldownUntil, h.now() + 2000); assert.deepEqual(json(game.players.map(player => player.hp)), hp);
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

for (const you of [0, 1]) test(`shared center guidance stays outside both player panels for player ${you}`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.state.you = you; h.renderBattle();
  const hint = h.get('#battleGestureHint'), rail = h.get('.battle-center'), local = h.get('.battle-side.local'), opponent = h.get('.battle-side.opponent');
  const assertPlacement = () => {
    assert.strictEqual(hint.parentNode, rail, 'guidance stays in the shared center rail');
    assert.equal(rail.children.filter(node => node === hint).length, 1);
    assert.equal(local.children.includes(hint), false, 'the own board has no extra guidance row');
    assert.equal(opponent.children.includes(hint), false, 'no instruction is placed on the read-only board');
    assert.doesNotMatch(local.innerHTML + opponent.innerHTML, /primary-controls|gesture-hint/, 'the board template contains no duplicate sidebar or hidden copy');
  };
  assertPlacement();
  const before = battleNodeReferences(h);
  for (let count = 0; count < 3; count++) { h.renderBattle(); assertPlacement(); }
  assertBattleNodesUnchanged(h, before, 'guidance-only stable render');
  for (const status of ['paused', 'playing', 'finished']) { game.status = status; h.renderBattle(); assertPlacement(); }
  h.begin(); h.renderBattle(); assertPlacement();
});

test('offline practice preserves the same single shared center guidance', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  h.enableRendering(); h.startPractice();
  assert.equal(h.state.practice, true);
  assert.strictEqual(h.get('#battleGestureHint').parentNode, h.get('.battle-center'));
  assert.equal(h.get('.battle-center').children.filter(node => node === h.get('#battleGestureHint')).length, 1);
});

test('battle UI renders opponent cells read-only and preserves manual notes during hit cooldown', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.renderBattle();
  const own = h.get('.battle-side.local').querySelector('.battle-board');
  const opponent = h.get('.battle-side.opponent').querySelector('.battle-board');
  assert.equal(own.children.length, 36); assert.equal(opponent.children.length, 36);
  assert.equal(own.children.every(cell => cell.tagName === 'BUTTON' && typeof cell.onclick === 'function'), true);
  assert.equal(opponent.children.every(cell => cell.tagName === 'SPAN' && cell.onclick === undefined && cell.getAttribute('aria-readonly') === 'true'), true);
  game.boards[0].cooldownUntil = h.now() + 1000; game.boards[0].cooldownKind = 'hit'; singleClick(h, own.children[0]);
  assert.equal(h.state.notes.has(0), true); assert.equal(sentActions(h), 0); assert.equal(game.boards[0].found.length, 0);
  h.battleChoose(game.boards[0].puzzle.solution[0]);
  assert.equal(sentActions(h), 0); assert.equal(game.boards[0].found.length, 0);
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

test('battle rendered note markers appear only on the local board and hit cooldown disables guesses, not notes', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.state.notes.add(0); game.boards[0].cooldownUntil = h.now() + 300; game.boards[0].cooldownKind = 'hit';
  h.renderBattle();
  let own = h.get('.battle-side.local').querySelector('.battle-board');
  const opponent = h.get('.battle-side.opponent').querySelector('.battle-board');
  assert.equal(own.children[0].classList.contains('note'), true);
  assert.equal(opponent.children.some(cell => cell.classList.contains('note')), false);
  assert.equal(own.children.every(cell => !cell.disabled), true, 'primary-click marking stays reachable during a hit cooldown');
  assertGuessBlocked(h, own.children[game.boards[0].puzzle.solution[0]], game);
  h.renderBattle(); own = h.get('.battle-side.local').querySelector('.battle-board');
  assert.equal(own.children.every(cell => !cell.disabled), true);
  h.advance(2000); h.renderBattle(); own = h.get('.battle-side.local').querySelector('.battle-board');
  assert.equal(own.children.every(cell => !cell.disabled), true);
});

for (const practice of [false, true]) test(`${practice ? 'offline practice' : 'battle'} keeps rule-related cells unmarked, accepts their real misses after cooldown, and never repeats damage`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  h.enableRendering();
  if (practice) { h.startPractice(); h.advance(3000); h.updateBattleTimers(); }
  else h.begin();
  const game = h.state.game, board = game.boards[0], cat = board.puzzle.solution[0];
  const related = ruleRelatedEmptyCells(board.puzzle, cat);
  const own = () => h.get('.battle-side.local').querySelector('.battle-board');
  h.renderBattle(); doubleClick(own().children[cat]);
  assert.deepEqual(json(board.found), [cat]); assert.equal(game.players[1].hp, 145);
  for (let index = 0; index < 36; index++) if (index !== cat) assertUnopenedCell(own().children[index]);
  assertGuessBlocked(h, own().children[related[1]], game);
  const sent = h.messages.length;
  own().children[related[0]].click();
  assertUnopenedCell(own().children[related[0]]);
  assert.equal(h.messages.length, sent, 'a private single queues no authority action during the real hit cooldown');
  h.tick(299); h.updateBattleTimers();
  assert.equal(h.battleChoose(related[1]), undefined);
  assert.equal(board.misses.length, 0, 'a 299 ms-old hit still blocks guesses');
  h.tick(1); h.updateBattleTimers();
  assertUnopenedCell(own().children[related[0]], { note: true });
  for (let index = 0; index < 36; index++) if (index !== cat) assertUnopenedCell(own().children[index], { note: index === related[0] });
  const hp = json(game.players.map(player => player.hp));
  h.advance(GESTURE_WAIT); // Begin a fresh gesture burst after the blocked double above.
  for (const [attempt, index] of related.entries()) {
    const duration = Math.min(2000 * (attempt + 1), 8000);
    doubleClick(own().children[index]);
    assert.equal(board.misses.includes(index), true, `rule-related cell ${index} accepts a real miss`);
    assertConfirmedEmpty(own().children[index]); assert.equal(own().children[index].disabled, true);
    assert.equal(board.combo, 0); assert.equal(board.cooldownUntil, h.now() + duration);
    assert.equal(board.missStreak, attempt + 1); assert.equal(board.cooldownDuration, duration);
    assert.deepEqual(json(game.players.map(player => player.hp)), hp, 'a real miss causes no hit damage');
    const before = json(h.publicGame(game));
    own().children[index].click(); h.battleChoose(index);
    assert.deepEqual(json(h.publicGame(game)), before, 'repeated UI clicks leave an opened miss unchanged');
    h.advance(duration - 1); h.updateBattleTimers();
    for (const remaining of related.filter(value => !board.misses.includes(value))) assert.equal(own().children[remaining].disabled, true, 'the miss lock blocks every unopened cell, including private marks');
    h.advance(1); h.updateBattleTimers();
    const afterCooldown = json(h.publicGame(game));
    assert.equal(h.act(0, battleAction(h, 0, { index })).reason, 'resolved-cell');
    assert.deepEqual(json(h.publicGame(game)), afterCooldown, 'a fresh action ID cannot reopen a miss or restart cooldown');
    for (const remaining of related.filter(value => !board.misses.includes(value))) assertUnopenedCell(own().children[remaining]);
  }
  assert.deepEqual(json(board.misses), related); assert.deepEqual(json(game.players.map(player => player.hp)), hp);
  assert.equal(board.found.length, 1); assert.equal(board.puzzle.id, game.boards[0].puzzle.id);
  if (practice) { assert.equal(h.state.transport, null); assert.equal(h.messages.length, 0); }
});

test('battle snapshots, stable rerenders and reconnect preserve only actual misses and local private notes on both views', () => {
  const host = harness({ mode: 'battle', battle: true, battleUI: true }), game = host.begin();
  const fixtures = game.boards.map(board => {
    const cat = board.puzzle.solution[0], [miss, note] = ruleRelatedEmptyCells(board.puzzle, cat);
    return { cat, miss, note };
  });
  for (const who of [0, 1]) assert.equal(host.act(who, battleAction(host, who, { index: fixtures[who].cat })).accepted, true);
  host.advance(300);
  for (const who of [0, 1]) assert.equal(host.act(who, battleAction(host, who, { index: fixtures[who].miss })).accepted, true);
  host.advance(2000); host.state.notes.add(fixtures[0].note);
  host.renderBattle();
  const snapshot = json(host.publicGame(game)); assertNoPrivateKeys(snapshot);
  const guest = harness({ mode: 'battle', battle: true, battleUI: true });
  guest.advance(5300); guest.state.role = 'guest'; guest.state.you = 1;
  guest.enableRendering(); guest.onMessage({ type: 'state', state: json(snapshot) });
  guest.state.notes.add(fixtures[1].note); guest.renderBattle();
  const verify = h => {
    for (const side of ['local', 'opponent']) {
      const who = side === 'local' ? h.state.you : 1 - h.state.you;
      const grid = h.get(`.battle-side.${side}`).querySelector('.battle-board'), { cat, miss, note } = fixtures[who];
      assertConfirmedEmpty(grid.children[miss]);
      assert.equal(grid.children[cat].classList.contains('cat'), true);
      for (let index = 0; index < 36; index++) if (![cat, miss].includes(index)) {
        assertUnopenedCell(grid.children[index], { note: side === 'local' && index === note });
        assert.notEqual(grid.children[index].dataset.renderState, 'auto-x');
      }
      if (side === 'opponent') assert.equal(grid.children.every(cell => cell.tagName === 'SPAN' && cell.getAttribute('aria-readonly') === 'true'), true);
    }
  };
  verify(host); verify(guest);
  for (let attempt = 0; attempt < 3; attempt++) { host.renderBattle(); guest.onMessage({ type: 'state', state: json(snapshot) }); verify(host); verify(guest); }
  host.onClose(); host.advance(10000); host.onMessage({ type: 'hello', nickname: 'Guest Cat' });
  host.onMessage({ type: 'battleReady', gameId: game.id }); host.renderBattle();
  guest.onClose(); guest.onOpen(); guest.onMessage({ type: 'state', state: json(host.publicGame(game)) });
  assert.equal(game.status, 'playing'); assert.equal(guest.state.game.status, 'playing');
  verify(host); verify(guest);
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

test('public entry defaults to battle while every legacy mode and generic create/join flow remain selectable', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const picker = html.match(/<select id="gameMode">([\s\S]*?)<\/select>/)[1];
  const options = [...picker.matchAll(/<option value="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(options.filter(([, , attributes]) => /\bselected\b/.test(attributes)).map(([, mode]) => mode), ['battle']);
  assert.deepEqual(options.map(([, mode]) => mode).sort(), ['basic', 'battle', 'coop', 'items', 'survival', 'treasure']);
  const sizes = html.match(/<select id="size">([\s\S]*?)<\/select>/)[1];
  assert.match(sizes, /<option value="6" selected>/);
  assert.equal((sizes.match(/ selected/g) || []).length, 1);
  for (const id of ['chooseHost', 'chooseJoin', 'host', 'join', 'manualHost', 'manualJoin']) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"`), `${id} keeps its ordinary room entry`);
  }
  assert.match(html, /<button id="previewBattle" class="hidden"/);
  assert.doesNotMatch(html, /<script>\s*startPractice\(\)/);
  assert.match(html, /<h1>貓咪捉迷藏<\/h1>/);
  const h = harness({ mode: 'battle', battle: true, battleUI: true });
  assert.equal(h.state.game, null, 'page setup never silently starts a practice match');
  assert.equal(h.get('#size').disabled, true); assert.equal(h.settingsFromUI().size, 6);
  assert.equal(h.settingsFromUI().mode, 'battle');
  for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle']) {
    h.get('#gameMode').value = mode; h.get('#gameMode').dispatchEvent('change');
    assert.equal(h.settingsFromUI().mode, mode); assert.equal(h.newGame(6).settings.mode, mode);
    assert.equal(h.get('#size').disabled, mode === 'battle');
    assert.equal(h.get('#battleSettings').classList.contains('hidden'), mode !== 'battle');
    assert.equal(h.get('.turn-settings').classList.contains('hidden'), mode === 'battle');
    for (const id of ['chooseHost', 'chooseJoin', 'host', 'join', 'manualHost', 'manualJoin']) {
      assert.equal(typeof h.get(`#${id}`).onclick, 'function', `${mode}: ${id} is still connected to the shared entry flow`);
    }
  }
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

test('capture CSS keeps the authored 520 ms pop and 420 ms attack arrival with reduced-motion alternatives', () => {
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(css, /animation:\s*cozyFoundCatPop 520ms/);
  assert.match(css, /animation:\s*cozyCaptureCallout 750ms/);
  assert.match(css, /animation:\s*cozyCatArc 300ms linear 120ms/);
  assert.match(css, /animation:\s*cozyPawChase 300ms linear 120ms/);
  assert.match(css, /\.hp-meter > i\.hp-fill\s*\{[^}]*transition:\s*none;/);
  assert.match(css, /\.hp-meter > i\.hp-lag\s*\{[^}]*transition:\s*width 350ms/);
  assert.match(css, /animation:\s*cozyHpImpact 160ms/);
  assert.match(css, /animation:\s*cozyDamageNumber 620ms ease-out 420ms/);
  assert.match(css, /\.board-card > \.capture-callout\s*\{[^}]*pointer-events:\s*none;/);
  const reduced = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)].map(match => {
    let depth = 1, end = match.index + match[0].length;
    for (; depth && end < css.length; end++) { if (css[end] === '{') depth++; else if (css[end] === '}') depth--; }
    return css.slice(match.index, end);
  }).join('\n');
  assert.match(reduced, /\.board-card > \.capture-callout\.show\s*\{[^}]*opacity:\s*1;/);
  assert.match(reduced, /\.hp-meter > \.battle-damage\s*\{[^}]*animation:\s*none !important;[^}]*opacity:\s*1;/);
  assert.match(reduced, /\.hp-meter > i\.hp-fill, \.hp-meter > i\.hp-lag\s*\{[^}]*transition:\s*none !important;/);
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
  h.renderBattle();
  const grid = h.get('.battle-side.local').querySelector('.battle-board');
  assert.equal(grid.children.every(cell => cell.disabled), true);
  const target = grid.children[game.boards[0].puzzle.solution[0]];
  target.click(); doubleClick(target); contextMenu(target); h.battleChoose(game.boards[0].puzzle.solution[0]);
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
  h.battleChoose(authority.boards[1].puzzle.solution[0]);
  singleClick(h, h.get('.battle-side.local').querySelector('.battle-board').children[authority.boards[1].puzzle.solution[0]]);
  assert.equal(h.state.notes.size, 0); assert.equal(h.messages.filter(message => message.type === 'action').length, count);
  h.context.CatBattle.advance(authority, h.now());
  h.onMessage({ type: 'state', state: json(h.publicGame(authority)) });
  assert.equal(h.state.game.status, 'playing'); assert.equal(h.state.game.startAt, startAt);
  h.battleChoose(authority.boards[1].puzzle.solution[0]);
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
  h.battleChoose(authority.boards[1].puzzle.solution[0]);
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

test('battle miss lock shows local seconds and progress while the opponent remains active and all own inputs stay blocked', () => {
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
  const privateCell = game.boards[0].puzzle.solution[0], sent = sentActions(h);
  singleClick(h, own.querySelector('.battle-board').children[privateCell]); h.battleChoose(privateCell);
  assert.equal(h.state.notes.has(privateCell), false); assert.equal(sentActions(h), sent);
  own = h.get('.battle-side.local');
  assert.equal(own.querySelector('.battle-board').children[privateCell].disabled, true);
  assert.equal(own.querySelector('.battle-lock').classList.contains('notes-available'), false);
  assertNoPrivateKeys(json(h.publicGame(game)));
});

test('battle interval removes the miss lock at its exact deadline and never displays negative time or progress', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const miss = game.boards[0].puzzle.regions.findIndex((_, index) => !game.boards[0].puzzle.solution.includes(index));
  h.act(0, battleAction(h, 0, { index: miss }));
  h.advance(1999); for (const interval of h.intervals) interval();
  assert.equal(h.get('.battle-side.local').querySelector('.battle-lock').classList.contains('hidden'), false);
  assert.equal(h.get('.battle-side.local').querySelector('.battle-board').children[game.boards[0].puzzle.solution[0]].disabled, true, 'the locked board rejects guesses and private marking');
  h.advance(1); for (const interval of h.intervals) interval();
  let own = h.get('.battle-side.local');
  assert.equal(own.querySelector('.battle-lock').classList.contains('hidden'), true, 'the centered lock leaves immediately at expiry');
  assert.equal(h.get('#battleNotice').textContent, '可以找貓了！', 'unlock status does not duplicate the persistent gesture line');
  assert.equal(own.querySelector('.battle-board').children[game.boards[0].puzzle.solution[0]].disabled, false);
  h.advance(10000); h.updateBattleTimers(); own = h.get('.battle-side.local');
  const lock = own.querySelector('.battle-lock');
  assert.doesNotMatch(String(lock.querySelector('.lock-seconds').textContent), /-\d/);
  const width = Number.parseFloat(lock.querySelector('.lock-progress > i').style.width);
  assert.ok(Number.isFinite(width) && width >= 0 && width <= 100);
});

for (const duration of [4000, 6000, 8000]) test(`battle ${duration / 1000}-second lock uses public duration for guest progress, blocked inputs and exact unlock`, () => {
  const host = harness({ mode: 'battle', battle: true }), authority = host.begin();
  const board = authority.boards[1], misses = board.puzzle.regions.flatMap((_, index) => board.puzzle.solution.includes(index) ? [] : [index]);
  for (let attempt = 0; attempt < duration / 2000; attempt++) {
    assert.equal(host.act(1, battleAction(host, 1, { index: misses[attempt] })).accepted, true);
    if (attempt + 1 < duration / 2000) host.advance(board.cooldownDuration);
  }
  const snapshot = json(host.publicGame(authority));
  // Duration is authoritative even when an older intermediary omits the optional start time.
  snapshot.boards[1].cooldownStartedAt = null;
  const guest = harness({ mode: 'battle', battle: true, battleUI: true });
  guest.state.role = 'guest'; guest.state.you = 1; guest.enableRendering();
  guest.onMessage({ type: 'state', state: snapshot });
  const own = guest.get('.battle-side.local'), lock = own.querySelector('.battle-lock');
  const seconds = () => Number.parseFloat(lock.querySelector('.lock-seconds').textContent);
  const progress = () => Number.parseFloat(lock.querySelector('.lock-progress > i').style.width);
  assert.equal(seconds(), duration / 1000); assert.equal(progress(), 100);
  assert.equal(lock.classList.contains('hidden'), false);
  const index = board.puzzle.solution[0], grid = own.querySelector('.battle-board');
  assert.equal(grid.children[index].disabled, true);

  guest.advance(duration / 2); guest.updateBattleTimers();
  assert.equal(seconds(), duration / 2000); assert.equal(progress(), 50, 'remaining time is divided by the actual 4/6/8-second penalty');
  const beforeNote = JSON.stringify(guest.state.game), sent = guest.messages.length;
  grid.children[index].click();
  assert.equal(guest.state.notes.has(index), false); assert.equal(grid.children[index].disabled, true);
  assert.equal(lock.classList.contains('notes-available'), false);
  assert.equal(JSON.stringify(guest.state.game), beforeNote); assert.equal(guest.messages.length, sent);
  assert.equal(grid.children[index].disabled, true);
  guest.advance(duration / 2 - 1); guest.updateBattleTimers();
  assert.equal(lock.classList.contains('hidden'), false); assert.equal(grid.children[index].disabled, true);
  assert.ok(progress() > 0 && progress() < 1); assert.equal(seconds(), 0.1);
  guest.advance(1); guest.updateBattleTimers();
  assert.equal(seconds(), 0); assert.equal(progress(), 0); assert.equal(lock.classList.contains('hidden'), true);
  assert.equal(grid.children[index].disabled, false); assert.equal(guest.state.notes.has(index), false);

  guest.advance(10000); guest.updateBattleTimers();
  assert.equal(seconds(), 0); assert.equal(progress(), 0); assert.equal(guest.messages.length, sent);
});

for (const duration of [6000, 8000]) test(`battle reconnect preserves the ${duration / 1000}-second miss streak, remaining deadline and progress fraction`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const board = game.boards[0], misses = board.puzzle.regions.flatMap((_, index) => board.puzzle.solution.includes(index) ? [] : [index]);
  for (let attempt = 0; attempt < duration / 2000; attempt++) {
    assert.equal(h.act(0, battleAction(h, 0, { index: misses[attempt] })).accepted, true);
    if (attempt + 1 < duration / 2000) { h.advance(board.cooldownDuration); h.updateBattleTimers(); }
  }
  h.advance(duration / 4); h.updateBattleTimers();
  const lock = () => h.get('.battle-side.local').querySelector('.battle-lock');
  const progress = () => Number.parseFloat(lock().querySelector('.lock-progress > i').style.width);
  const remaining = duration * 3 / 4, boardId = board.puzzle.id, oldDeadline = board.cooldownUntil, streak = board.missStreak;
  assert.equal(progress(), 75);
  h.onClose(); assert.equal(game.status, 'paused');
  const pauseSnapshot = json(h.publicGame(game));
  assert.equal(pauseSnapshot.boards[0].missStreak, streak); assert.equal(pauseSnapshot.boards[0].cooldownDuration, duration);
  assert.equal(pauseSnapshot.boards[0].cooldownUntil - pauseSnapshot.pausedAt, remaining);
  const note = board.puzzle.solution[0], sent = h.messages.length;
  h.get('.battle-side.local').querySelector('.battle-board').children[note].click();
  assert.equal(h.state.notes.has(note), false); assert.equal(h.messages.length, sent, 'the paused miss lock still blocks private notes');
  h.advance(12000); h.updateBattleTimers();
  assert.equal(game.status, 'paused'); assert.equal(board.cooldownUntil, oldDeadline); assert.equal(board.missStreak, streak);
  h.onMessage({ type: 'hello', nickname: 'Reconnected Cat' }); h.onMessage({ type: 'battleReady', gameId: game.id });
  h.renderBattle();
  assert.equal(game.status, 'playing'); assert.equal(board.puzzle.id, boardId);
  assert.equal(board.cooldownUntil, oldDeadline + 12000); assert.equal(board.cooldownUntil - h.now(), remaining);
  assert.equal(board.cooldownDuration, duration); assert.equal(board.missStreak, streak); assert.equal(progress(), 75);
  assert.equal(Number.parseFloat(lock().querySelector('.lock-seconds').textContent), remaining / 1000);
  assert.equal(h.state.notes.has(note), false); assert.equal(h.act(0, battleAction(h, 0)).reason, 'cooldown');
  const restored = json(h.publicGame(game)); assertNoPrivateKeys(restored);
  assert.equal(restored.boards[0].cooldownUntil, board.cooldownUntil); assert.equal(restored.boards[0].missStreak, streak);
  h.advance(remaining); h.updateBattleTimers();
  assert.equal(progress(), 0);
  assert.equal(h.act(0, battleAction(h, 0, { index: misses[streak] })).accepted, true);
  assert.equal(board.missStreak, streak + 1); assert.equal(board.cooldownDuration, 8000, 'reconnect preserves escalation rather than resetting it');
});

test('miss lock blocks every gesture and expiry restores private single marks and deliberate double reveals', () => {
  const { h, game, board, grid } = gestureFixture('battle'), [cat, target] = board.puzzle.solution;
  const miss = ruleRelatedEmptyCells(board.puzzle, cat)[0];
  h.act(0, battleAction(h, 0, { index: cat })); h.advance(300); h.updateBattleTimers();
  h.act(0, battleAction(h, 0, { index: miss }));
  const lock = h.get('.battle-side.local').querySelector('.battle-lock');
  assert.equal(lock.classList.contains('lock-pop'), true); assert.doesNotMatch(lock.querySelector('.lock-note').textContent, /現在可以做記號/);
  for (const index of [cat, target, miss]) assert.equal(grid().children[index].disabled, true);
  const before = stablePublic(h), sent = sentActions(h);
  for (let attempt = 0; attempt < 3; attempt++) {
    grid().children[target].click(); doubleClick(grid().children[target]); contextMenu(grid().children[target]); h.battleChoose(target);
  }
  h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(target), false); assertUnopenedCell(grid().children[target], { disabled: true });
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent); assert.equal(h.state.pendingAction, null);
  h.advance(2000 - GESTURE_WAIT); h.updateBattleTimers();
  assert.equal(board.found.includes(target), false, 'expiry cannot submit an earlier activation');
  assert.equal(lock.classList.contains('hidden'), true); assert.equal(h.get('#battleNotice').textContent, '可以找貓了！', 'unlock status does not duplicate the persistent gesture line');
  singleClick(h, grid().children[target]);
  assert.equal(h.state.notes.has(target), true); assert.equal(board.found.includes(target), false); assert.equal(sentActions(h), sent);
  doubleClick(grid().children[target]);
  assert.equal(board.found.includes(target), true); assert.equal(board.missStreak, 0); assert.equal(h.state.notes.has(target), false);
});

for (const activation of ['mouse', 'touch', 'Enter', ' ']) test(`a ${activation === ' ' ? 'Space' : activation} press begun during miss lock stays inert after expiry`, () => {
  const { h, game, board, grid } = gestureFixture('battle'), index = board.puzzle.solution[0];
  const miss = ruleRelatedEmptyCells(board.puzzle, index)[0]; h.act(0, battleAction(h, 0, { index: miss }));
  const cell = grid().children[index];
  if (['mouse', 'touch'].includes(activation)) cell.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: activation, pointerId: 1 });
  else cell.dispatchEvent({ type: 'keydown', key: activation, repeat: false });
  const before = stablePublic(h), sent = sentActions(h);
  h.advance(2000); h.updateBattleTimers();
  if (['mouse', 'touch'].includes(activation)) cell.dispatchEvent({ type: 'pointerup', button: 0, pointerType: activation, pointerId: 1 });
  else cell.dispatchEvent({ type: 'keyup', key: activation });
  cell.click(); h.tick(GESTURE_WAIT);
  assertUnopenedCell(grid().children[index]); assert.equal(h.state.notes.has(index), false);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  cell.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', pointerId: 2 });
  cell.dispatchEvent({ type: 'pointerup', button: 0, pointerType: 'mouse', pointerId: 2 }); cell.click(); h.tick(GESTURE_WAIT);
  assert.equal(board.found.includes(index), false); assert.equal(h.state.notes.has(index), true);
  doubleClick(grid().children[index]); assert.equal(board.found.includes(index), true); assert.equal(h.state.notes.has(index), false);
});

for (const activation of ['pointer', 'Enter', ' ']) test(`a pre-lock ${activation === ' ' ? 'Space' : activation} guess press is discarded when authority enters miss lock before release`, () => {
  const host = harness({ mode: 'battle', battle: true }), authority = host.begin();
  const guest = harness({ mode: 'battle', battle: true, battleUI: true });
  guest.state.role = 'guest'; guest.state.you = 1; guest.enableRendering();
  guest.onMessage({ type: 'state', state: json(host.publicGame(authority)) });
  const board = authority.boards[1], index = board.puzzle.solution[0];
  const miss = board.puzzle.regions.findIndex((_, index) => !board.puzzle.solution.includes(index));
  const cell = guest.get('.battle-side.local').querySelector('.battle-board').children[index];
  if (activation === 'pointer') cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', pointerId: 1 });
  else cell.dispatchEvent({ type: 'keydown', key: activation, repeat: false });
  host.act(1, battleAction(host, 1, { index: miss }));
  guest.onMessage({ type: 'state', state: json(host.publicGame(authority)) });
  const sent = guest.messages.length, snapshot = JSON.stringify(guest.state.game);
  if (activation === 'pointer') cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', pointerId: 1 });
  else cell.dispatchEvent({ type: 'keyup', key: activation });
  cell.click();
  assert.equal(guest.messages.length, sent); assert.equal(JSON.stringify(guest.state.game), snapshot);
  assert.equal(guest.state.notes.has(index), false, 'an old guess intent cannot silently turn into a note');
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', pointerId: 2 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', pointerId: 2 }); cell.click();
  assert.equal(guest.state.notes.has(index), false, 'even a fresh press cannot edit while the lock is active');
  assert.equal(guest.messages.length, sent);
});

test('miss-lock presses are cancelled across disconnect and a paused lock keeps new presses blocked', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const board = game.boards[0], index = board.puzzle.solution[0];
  const miss = board.puzzle.regions.findIndex((_, index) => !board.puzzle.solution.includes(index));
  h.act(0, battleAction(h, 0, { index: miss }));
  const cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  h.onClose();
  const epoch = h.state.battleInputEpoch, before = json(h.publicGame(game));
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', pointerId: 1 }); cell.click();
  assert.equal(h.state.notes.has(index), false, 'a pre-disconnect press is invalidated');

  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', pointerId: 2 });
  h.tick(500);
  assert.equal(h.state.battleInputEpoch, epoch, 'ordinary paused refresh does not repeatedly change the input boundary');
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', pointerId: 2 }); cell.click();
  assert.equal(h.state.notes.has(index), false); assert.equal(game.status, 'paused');
  const after = json(h.publicGame(game)); delete before.serverTime; delete after.serverTime;
  assert.deepEqual(after, before);
  const lock = h.get('.battle-side.local').querySelector('.battle-lock');
  assert.equal(Number.parseFloat(lock.querySelector('.lock-seconds').textContent), 2);
  assert.equal(Number.parseFloat(lock.querySelector('.lock-progress > i').style.width), 100);
});

test('a cancelled locked pointer press cannot become a post-unlock guess', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const board = game.boards[0], index = board.puzzle.solution[0];
  const miss = board.puzzle.regions.findIndex((_, index) => !board.puzzle.solution.includes(index));
  h.act(0, battleAction(h, 0, { index: miss }));
  const cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  cell.dispatchEvent({ type: 'pointercancel', pointerType: 'touch', pointerId: 1 });
  h.advance(2000); h.updateBattleTimers();
  const before = json(h.publicGame(game)), sent = h.messages.length;
  cell.click();
  assert.equal(h.state.notes.has(index), false); assert.equal(h.messages.length, sent); assert.deepEqual(json(h.publicGame(game)), before);
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', pointerId: 2 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', pointerId: 2 }); cell.click();
  h.tick(GESTURE_WAIT); assert.equal(board.found.includes(index), false); assert.equal(h.state.notes.has(index), true, 'a fresh activation still marks after cancellation');
});

test('a queued locked press from the old board cannot mark or guess on the next puzzle', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const board = game.boards[0], cats = [...board.puzzle.solution];
  for (const index of cats.slice(0, 5)) { h.act(0, battleAction(h, 0, { index })); h.advance(300); }
  const empty = board.puzzle.regions.flatMap((_, index) => cats.includes(index) ? [] : [index]);
  h.act(0, battleAction(h, 0, { index: empty[0] }));
  const oldCell = h.get('.battle-side.local').querySelector('.battle-board').children[empty[1]];
  oldCell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', pointerId: 1 });
  h.advance(2000); h.act(0, battleAction(h, 0, { index: cats[5] }));
  assert.notEqual(game.boards[0].puzzle.id, board.puzzle.id); assert.equal(oldCell.parentNode, null);
  const before = json(h.publicGame(game)), sent = h.messages.length;
  oldCell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', pointerId: 1 }); oldCell.click();
  assert.equal(h.state.notes.size, 0); assert.equal(h.messages.length, sent); assert.deepEqual(json(h.publicGame(game)), before);
});

test('a fresh miss pops once and shows one unlock notice without rerender replay or replaced board nodes', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const references = battleNodeReferences(h), root = h.get('.battle-side.local');
  assert.doesNotMatch(root.innerHTML, /battle-lock-slot/, 'a miss lock must not reserve an above-board strip');
  const miss = game.boards[0].puzzle.regions.findIndex((_, index) => !game.boards[0].puzzle.solution.includes(index));
  h.act(0, battleAction(h, 0, { index: miss }));
  const lock = root.querySelector('.battle-lock'), effects = [...h.state.battleClassEffects].filter(effect => effect.className === 'lock-pop');
  assert.equal(effects.length, 1); assert.equal(lock.classList.contains('lock-pop'), true);
  h.renderBattle(); h.renderBattle();
  assert.deepEqual([...h.state.battleClassEffects].filter(effect => effect.className === 'lock-pop'), effects);
  h.tick(520); assert.equal(lock.classList.contains('lock-pop'), false);
  h.renderBattle(); assert.equal(lock.classList.contains('lock-pop'), false);
  h.tick(1480); assert.equal(lock.classList.contains('hidden'), true);
  assert.equal(h.get('#battleNotice').textContent, '可以找貓了！', 'unlock status does not duplicate the persistent gesture line');
  assert.equal(playedAudio(h).filter(sound => sound.kind === 'unlock').length, 1);
  h.renderBattle(); h.updateBattleTimers(); assert.equal(playedAudio(h).filter(sound => sound.kind === 'unlock').length, 1);
  h.tick(1100); h.renderBattle();
  assert.equal(lock.classList.contains('is-unlocked'), false); assert.equal(lock.classList.contains('hidden'), true);
  assertBattleNodesUnchanged(h, references, 'miss pop, strict lock and unlock notice');
});

test('joining or reconnecting into a miss lock blocks editing without replaying its pop or unlock sound', () => {
  const host = harness({ mode: 'battle', battle: true }), authority = host.begin();
  const board = authority.boards[1], index = board.puzzle.solution[0];
  const miss = board.puzzle.regions.findIndex((_, index) => !board.puzzle.solution.includes(index));
  host.act(1, battleAction(host, 1, { index: miss }));
  const guest = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true });
  guest.state.role = 'guest'; guest.state.you = 1; guest.enableRendering();
  const receive = () => guest.onMessage({ type: 'state', state: json(host.publicGame(authority)) });
  receive();
  let root = guest.get('.battle-side.local'), lock = root.querySelector('.battle-lock');
  assert.equal(lock.classList.contains('lock-pop'), false);
  const sounds = json(playedAudio(guest)), sent = guest.messages.length;
  root.querySelector('.battle-board').children[index].click(); assert.equal(guest.state.notes.has(index), false);
  assert.equal(guest.messages.length, sent); assert.deepEqual(playedAudio(guest), sounds);
  guest.onClose(); host.onClose(); host.advance(5000); guest.advance(5000);
  assert.equal(guest.state.game.status, 'paused');
  root.querySelector('.battle-board').children[index].click(); assert.equal(guest.state.notes.has(index), false);
  host.onMessage({ type: 'hello', nickname: 'Guest Cat' }); host.onMessage({ type: 'battleReady', gameId: authority.id });
  guest.onOpen(); receive(); root = guest.get('.battle-side.local'); lock = root.querySelector('.battle-lock');
  assert.equal(guest.state.game.status, 'playing');
  assert.equal(lock.classList.contains('lock-pop'), false); assert.equal(lock.classList.contains('is-unlocked'), false);
  guest.tick(2100);
  assert.equal(playedAudio(guest).some(sound => sound.kind === 'unlock'), false);

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
  const before = battleNodeReferences(h);
  const oldBoard = game.boards[0], oldID = oldBoard.puzzle.id, solution = [...oldBoard.puzzle.solution];
  for (const index of solution) {
    assert.equal(h.act(0, battleAction(h, 0, { index })).accepted, true);
    h.renderBattle(); h.advance(300);
    assert.ok(h.state.battleFXBatches.length <= 3);
    assert.ok(h.context.document.body.children.filter(node => node.classList.contains('battle-cat-launch')).length <= 3);
  }
  assert.notEqual(game.boards[0].puzzle.id, oldID); assert.equal(game.lastEvent.advanced, true);
  const after = battleNodeReferences(h);
  for (const side of ['local', 'opponent']) {
    for (const key of ['root', 'portrait', 'avatar', 'card', 'hp', 'combo']) assert.strictEqual(after[side][key], before[side][key], `${side} ${key} survives rollover`);
  }
  assert.notStrictEqual(after.local.cells[0], before.local.cells[0], 'a new board ID rebuilds the local puzzle cells');
  after.opponent.cells.forEach((cell, index) => assert.strictEqual(cell, before.opponent.cells[index], 'local rollover cannot rebuild the opponent board'));
  const launch = h.context.document.body.children.find(node => node.classList.contains('battle-cat-launch') && node.dataset.eventId === game.lastEvent.id);
  assert.ok(launch, 'the sixth hit must still launch after its old board is replaced');
  const index = solution.at(-1);
  h.context.expectedCatKey = `${oldID}:${index}`;
  assert.equal(launch.innerHTML, vm.runInContext('battleCat(stableHash(expectedCatKey))', h.context));
  assert.equal(Number.parseFloat(launch.style.left), 120 + (index % 6) * 40);
  assert.equal(Number.parseFloat(launch.style.top), 220 + Math.floor(index / 6) * 40);
  assert.equal(game.players[1].hp, 45); assert.equal(game.boards[0].combo, 6);
});

function battleNodeReferences(h) {
  return Object.fromEntries(['local', 'opponent'].map(side => {
    const root = h.get(`.battle-side.${side}`), portrait = root.querySelector('.portrait'), grid = root.querySelector('.battle-board');
    return [side, { root, portrait, avatar: portrait.querySelector('.lively-avatar'), card: root.querySelector('.board-card'),
      hp: root.querySelector('.hp-meter'), combo: root.querySelector('.combo-badge'), grid, cells: [...grid.children] }];
  }));
}

function assertBattleNodesUnchanged(h, previous, message) {
  const current = battleNodeReferences(h);
  for (const side of ['local', 'opponent']) {
    for (const key of ['root', 'portrait', 'avatar', 'card', 'hp', 'combo', 'grid']) {
      assert.strictEqual(current[side][key], previous[side][key], `${message}: ${side} ${key} must survive`);
    }
    assert.equal(current[side].cells.length, previous[side].cells.length);
    current[side].cells.forEach((cell, index) => assert.strictEqual(cell, previous[side].cells[index], `${message}: ${side} cell ${index} must survive`));
  }
}

test('a 300 ms hit cooldown unlocks guesses in place without restarting avatars or capture highlights', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin();
  h.enableRendering(); h.renderBattle(); const before = battleNodeReferences(h);
  const [first, next] = game.boards[0].puzzle.solution;
  h.act(0, battleAction(h, 0, { index: first })); h.renderBattle();
  assertBattleNodesUnchanged(h, before, 'own hit');
  const cell = before.local.cells[first], cat = cell.querySelector('.cat-art');
  const timers = [...h.state.battleFXTimers], meows = json(playedAudio(h).filter(sound => sound.kind === 'meow'));
  assert.equal(cell.classList.contains('found-glow'), true); assert.equal(before.local.combo.classList.contains('combo-glow'), true);
  assert.equal(before.local.cells[next].disabled, false, 'primary-click marking remains reachable');
  assert.equal(h.state.battleCooldownActive, true); assertGuessBlocked(h, before.local.cells[next], game);
  h.context.cooldownRerenders = 0;
  vm.runInContext('render = () => { cooldownRerenders++; appTest.renderLegacy(); };', h.context);
  h.tick(299); h.updateBattleTimers();
  assert.equal(h.state.battleCooldownActive, true, 'the hit cooldown must not unlock early');
  assertGuessBlocked(h, before.local.cells[next], game, 'guessing is still blocked at 299 ms');
  assertBattleNodesUnchanged(h, before, '299 ms timer update');
  h.tick(1); h.updateBattleTimers();
  assert.equal(before.local.cells[next].disabled, false);
  assert.equal(h.state.battleCooldownActive, false, 'guessing becomes ready at the 300 ms deadline');
  assert.equal(h.context.cooldownRerenders, 0, 'the cooldown interval updates input readiness without a full render');
  assert.equal(cell.disabled, true, 'the captured cell remains unavailable');
  assertBattleNodesUnchanged(h, before, '300 ms cooldown unlock');
  assert.strictEqual(cell.querySelector('.cat-art'), cat, 'the captured artwork is not recreated on cooldown unlock');
  assert.equal(cell.classList.contains('found-glow'), true); assert.equal(before.local.combo.classList.contains('combo-glow'), true);
  assert.deepEqual([...h.state.battleFXTimers], timers, 'cooldown unlock cannot replace active capture timers');
  assert.deepEqual(playedAudio(h).filter(sound => sound.kind === 'meow'), meows, 'cooldown unlock cannot replay the cat voice');
  h.tick(600);
  assert.equal(cell.classList.contains('found-glow'), false); assert.equal(before.local.combo.classList.contains('combo-glow'), false);
});

test('opponent HP updates and private-note toggles preserve both cards, avatars and live capture effects', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin();
  h.enableRendering(); h.renderBattle();
  const first = game.boards[0].puzzle.solution[0]; h.act(0, battleAction(h, 0, { index: first }));
  const before = battleNodeReferences(h), cat = before.local.cells[first].querySelector('.cat-art');
  const voice = json(playedAudio(h).filter(sound => sound.kind === 'meow'));
  h.act(1, battleAction(h, 1)); h.renderBattle();
  assert.equal(game.players[0].hp, 145); assert.equal(game.players[1].hp, 145);
  assert.equal(before.local.hp.getAttribute('aria-valuenow'), '145'); assert.equal(before.opponent.hp.getAttribute('aria-valuenow'), '145');
  assertBattleNodesUnchanged(h, before, 'incoming opponent hit');
  assert.strictEqual(before.local.cells[first].querySelector('.cat-art'), cat);
  assert.equal(before.local.cells[first].classList.contains('found-glow'), true);
  assert.equal(before.local.combo.classList.contains('combo-glow'), true);
  const noteIndex = game.boards[0].puzzle.solution[1];
  game.boards[0].cooldownUntil = h.now() + 1000;
  singleClick(h, before.local.cells[noteIndex]);
  assert.equal(h.state.notes.has(noteIndex), true); assert.equal(before.local.cells[noteIndex].classList.contains('note'), true);
  assertBattleNodesUnchanged(h, before, 'private-note edit');
  assert.equal(before.local.cells[noteIndex].disabled, false, 'primary-click marking remains reachable');
  assertGuessBlocked(h, before.local.cells[noteIndex], game, 'private marking preserves the active cooldown');
  assertBattleNodesUnchanged(h, before, 'private-note edit');
  assert.equal(before.local.cells[first].classList.contains('found-glow'), true);
  assert.deepEqual(playedAudio(h).filter(sound => sound.kind === 'meow'), voice, 'incoming HP and note edits never repeat a local cat voice');
});

test('duplicate or fresh identical snapshots preserve DOM identity and never replay capture highlights or voices', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), authority = h.begin();
  h.state.role = 'guest'; h.state.you = 1; h.state.game = null; h.enableRendering();
  const receive = snapshot => { h.onMessage({ type: 'state', state: json(snapshot) }); h.renderBattle(); };
  receive(h.publicGame(authority)); const initial = battleNodeReferences(h);
  h.advance(300);
  const index = authority.boards[1].puzzle.solution[0];
  h.context.CatBattle.act(authority, 1, { type: 'guess', actionId: 'guest-node-capture', boardId: authority.boards[1].puzzle.id, index }, h.now());
  const snapshot = json(h.publicGame(authority)); receive(snapshot);
  assertBattleNodesUnchanged(h, initial, 'fresh own-capture snapshot');
  const after = battleNodeReferences(h), timers = [...h.state.battleFXTimers], voices = json(playedAudio(h).filter(sound => sound.kind === 'meow'));
  assert.equal(voices.length, 1); assert.equal(after.local.cells[index].classList.contains('found-glow'), true);
  receive(snapshot); receive({ ...snapshot, revision: snapshot.revision + 1 });
  assertBattleNodesUnchanged(h, after, 'duplicate event snapshot');
  assert.deepEqual([...h.state.battleFXTimers], timers); assert.deepEqual(playedAudio(h).filter(sound => sound.kind === 'meow'), voices);
  h.tick(950); h.renderBattle();
  assert.equal(after.local.cells[index].classList.contains('found-glow'), false);
  assert.equal(after.local.combo.classList.contains('combo-glow'), false);
  assertBattleNodesUnchanged(h, after, 'expired effect rerender');
  receive({ ...snapshot, revision: snapshot.revision + 2 });
  assert.equal(after.local.cells[index].classList.contains('found-glow'), false, 'an expired highlight is not reapplied for the stored event');
  assert.deepEqual(playedAudio(h).filter(sound => sound.kind === 'meow'), voices);
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

// The redesigned controls and audio adapter use the same authoritative game
// paths as the legacy tests above. These checks intentionally avoid a browser.
const playedAudio = h => h.audio.calls.filter(call => call.method === 'play').map(call => ({ kind: call.args[0], ...call.args[1] }));

test('HTML loads palette and audio modules before their adapters and omits redundant guess buttons', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const module of ['region-palette.js', 'game-audio.js', 'cell-gestures.js', 'board-strokes.js']) {
    assert.ok(html.indexOf(module) >= 0, `${module} must ship in the page`);
    assert.ok(html.indexOf(module) < html.indexOf('app.js'), `${module} must load before app.js`);
  }
  for (const filename of ['index.html', 'app.js', 'battle-ui.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, filename), 'utf8'), /\b(?:guessMode|battleGuess|noteMode|battleNote)\b/, `${filename} still references an obsolete guess button`);
  }
  for (const id of ['mute', 'battleMute', 'helpDialog', 'battleHelp', 'copyGameRoom', 'battleCopyRoom', 'rematch']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} remains available`);
  }
});

function declaredMeowSamples(html) {
  const declaration = /window\.CAT_MEOW_SAMPLES\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  assert.ok(declaration, 'the page must declare its real cat sample sources');
  return json(vm.runInNewContext(declaration[1]));
}

test('public page declares all three licensed WAV clips before initializing the game', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.deepEqual(declaredMeowSamples(html), ['./assets/audio/cat-meow-soft.wav', './assets/audio/cat-meow-food.wav', './assets/audio/cat-meow-purr.wav']);
  assert.ok(html.indexOf('window.CAT_MEOW_SAMPLES') < html.indexOf('app.js'));
  const provenance = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/audio/provenance.json'), 'utf8'));
  const attribution = fs.readFileSync(path.join(ROOT, 'assets/audio/ATTRIBUTION.md'), 'utf8');
  assert.equal(provenance.source.license, 'CC0 1.0 Universal');
  assert.equal(provenance.source.page, 'https://opengameart.org/content/cat-purr-meow');
  assert.match(attribution, /Kerzoven/); assert.match(attribution, /CC0 1\.0/);
  assert.equal(provenance.files.length, 3);
  for (const record of provenance.files) {
    const wav = fs.readFileSync(path.join(ROOT, record.distributed_path));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(createHash('sha256').update(wav).digest('hex'), record.candidate_sha256, 'distributed clip matches its provenance');
    assert.ok(Number.isFinite(record.candidate_duration_seconds) && record.candidate_duration_seconds > 0);
    assert.ok(declaredMeowSamples(html).includes(`./${record.distributed_path}`));
  }
});

test('standalone preview embeds the exact real WAV clips without fetching local files', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-battle-preview-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'preview.html');
  const report = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-preview.js'), destination], { encoding: 'utf8' }));
  assert.equal(report.selfContained, true); assert.equal(report.published, false);
  const html = fs.readFileSync(destination, 'utf8'), samples = declaredMeowSamples(html);
  assert.equal(samples.length, 3);
  for (const [index, filename] of ['cat-meow-soft.wav', 'cat-meow-food.wav', 'cat-meow-purr.wav'].entries()) {
    assert.match(samples[index], /^data:audio\/(?:wav|wave|x-wav);base64,/);
    assert.deepEqual(Buffer.from(samples[index].split(',')[1], 'base64'), fs.readFileSync(path.join(ROOT, 'assets/audio', filename)));
  }
  assert.doesNotMatch(html, /<script\s+src=|<link\s+rel="stylesheet"|url\(['"]?\.\/assets/);
});

test('game audio receives the page-provided sample sources including offline data URIs', () => {
  for (const meowSamples of [
    ['./assets/audio/cat-meow-soft.wav', './assets/audio/cat-meow-food.wav', './assets/audio/cat-meow-purr.wav'],
    ['data:audio/wav;base64,UklGRg==', 'data:audio/wav;base64,V0FWRQ==', 'data:audio/wav;base64,UENNIQ==']
  ]) {
    const h = harness({ fakeAudio: true, meowSamples }); h.begin(); h.renderLegacy();
    assert.equal(h.audio.options.length, 1, 'rendering reuses one audio controller');
    assert.deepEqual(json(h.audio.options[0].samples), meowSamples);
  }
});

function gestureFixture(mode, { fakeAudio = true } = {}) {
  const battle = ['battle', 'practice'].includes(mode);
  const h = harness({ mode: battle ? 'battle' : mode, battle, battleUI: battle, fakeAudio });
  h.enableRendering();
  if (mode === 'practice') { h.startPractice(); h.advance(3000); h.updateBattleTimers(); }
  else h.begin();
  h.renderLegacy();
  const game = h.state.game, board = battle ? game.boards[0] : game;
  const grid = () => battle ? h.get('.battle-side.local').querySelector('.battle-board') : h.get('#board');
  return { h, game, board, grid, battle };
}

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) {
  test(`${mode} single click toggles only a private purple X and double click reveals without a residual mark`, () => {
    const { h, game, board, grid, battle } = gestureFixture(mode);
    const [first, second] = board.puzzle.solution, before = stablePublic(h), sent = sentActions(h);
    const sounds = json(playedAudio(h).filter(sound => sound.kind !== 'ui'));
    for (const expected of [true, false, true]) {
      grid().children[first].click();
      assert.equal(h.state.notes.has(first), !expected, 'single click waits before changing a private mark');
      h.tick(GESTURE_WAIT);
      assertUnopenedCell(grid().children[first], { note: expected });
      assert.equal(h.state.notes.has(first), expected);
      assert.deepEqual(stablePublic(h), before, 'marks change no score, turn, HP, fish, cooldown or board revision');
      assert.equal(sentActions(h), sent);
      assert.deepEqual(playedAudio(h).filter(sound => sound.kind !== 'ui'), sounds);
    }
    doubleClick(grid().children[first]);
    assert.deepEqual(json(board.found), [first]); assert.equal(h.state.notes.has(first), false);
    assert.equal(grid().children[first].classList.contains('note'), false);
    h.tick(GESTURE_WAIT);
    assert.equal(h.state.notes.has(first), false, 'no first-click timer runs after a double reveal');
    doubleClick(grid().children[second], { pointerType: 'touch' });
    assert.deepEqual(json(board.found), [first, second]);
    h.tick(GESTURE_WAIT);
    assert.equal(h.state.notes.size, 0); assertNoPrivateKeys(json(h.publicGame(game)));
    if (battle) assert.equal(game.players[1].hp, 135);
  });

  test(`${mode} rapid different cells remain independent single marks and slow same-cell taps never reveal`, () => {
    const { h, board, grid } = gestureFixture(mode), [first, second] = board.puzzle.solution;
    const before = stablePublic(h), sent = sentActions(h);
    grid().children[first].click(); h.tick(80); grid().children[second].click(); h.tick(GESTURE_WAIT);
    assert.equal(h.state.notes.has(first), true); assert.equal(h.state.notes.has(second), true);
    assert.deepEqual(json(board.found), []); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
    singleClick(h, grid().children[first]); assert.equal(h.state.notes.has(first), false);
    singleClick(h, grid().children[first]); assert.equal(h.state.notes.has(first), true);
    assert.deepEqual(json(board.found), []); assert.deepEqual(stablePublic(h), before);
  });

  test(`${mode} triple taps and duplicate native dblclick do not create extra reveals or marks`, () => {
    const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
    const cell = grid().children[index];
    doubleClick(cell); const after = stablePublic(h), sent = sentActions(h);
    cell.dispatchEvent({ type: 'click', button: 0, detail: 3 });
    cell.dispatchEvent({ type: 'dblclick', button: 0, detail: 2 });
    h.tick(GESTURE_WAIT);
    assert.deepEqual(json(board.found), [index]); assert.equal(h.state.notes.has(index), false);
    assert.deepEqual(stablePublic(h), after); assert.equal(sentActions(h), sent);
  });
}

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) for (const initiallyMarked of [false, true]) test(`${mode} native mouse double at 350 ms reveals an ${initiallyMarked ? 'already marked' : 'unmarked'} cell exactly once`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  if (initiallyMarked) { h.state.notes.add(index); h.renderLegacy(); }
  let cell = grid().children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 });
  h.tick(350);
  assert.equal(h.state.notes.has(index), !initiallyMarked, 'the expired first click has committed its private toggle');
  cell = grid().children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 2 });
  cell.dispatchEvent({ type: 'dblclick', button: 0, detail: 2 });
  const after = stablePublic(h), sent = sentActions(h);
  cell.dispatchEvent({ type: 'click', button: 0, detail: 3 }); h.tick(GESTURE_WAIT);
  assert.deepEqual(json(board.found), [index]); assert.equal(h.state.notes.has(index), false);
  assert.deepEqual(stablePublic(h), after); assert.equal(sentActions(h), sent);
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} identical rendering between the second press and click preserves a marked cell and its reveal intent`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  singleClick(h, grid().children[index]);
  const cell = grid().children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(50);
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, pointerId: 1 });
  h.renderLegacy();
  assert.strictEqual(grid().children[index], cell, 'same-board snapshots cannot replace the pressed button');
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 2 }); h.tick(GESTURE_WAIT);
  assert.deepEqual(json(board.found), [index]); assert.equal(h.state.notes.has(index), false);
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) test(`${mode} native mouse detail two without a predecessor cannot reveal or mark`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  const before = stablePublic(h), sent = sentActions(h), cell = grid().children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 2 }); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), false); assert.equal(board.found.length, 0);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['basic', 'battle', 'practice']) for (const pointerType of ['touch', 'pen']) test(`${mode} ${pointerType} taps beyond the custom window stay independent despite detail two`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  const before = stablePublic(h), sent = sentActions(h);
  for (const detail of [1, 2]) {
    const cell = grid().children[index];
    cell.dispatchEvent({ type: 'pointerdown', pointerType, button: 0, pointerId: 1 });
    cell.dispatchEvent({ type: 'pointerup', pointerType, button: 0, pointerId: 1 });
    cell.dispatchEvent({ type: 'click', button: 0, detail }); h.tick(350);
    assert.equal(h.state.notes.has(index), detail === 1);
  }
  assert.equal(board.found.length, 0); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['battle', 'practice']) for (const pointerType of ['mouse', 'touch']) test(`${mode} a reveal pair whose second press began during hit cooldown never queues a reveal after expiry`, () => {
  const { h, board, grid } = gestureFixture(mode), [captured, index] = board.puzzle.solution;
  singleClick(h, grid().children[index]); doubleClick(grid().children[captured]);
  const cell = grid().children[index], before = stablePublic(h), sent = sentActions(h);
  cell.dispatchEvent({ type: 'pointerdown', pointerType, button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'pointerup', pointerType, button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(200);
  cell.dispatchEvent({ type: 'pointerdown', pointerType, button: 0, pointerId: 1 }); h.tick(120);
  cell.dispatchEvent({ type: 'pointerup', pointerType, button: 0, pointerId: 1 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 2 }); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), true); assert.deepEqual(json(board.found), [captured]);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} single marks remain private off-turn and resolved cells stay protected`, () => {
  const { h, game, grid } = gestureFixture(mode), [cat, target] = game.puzzle.solution;
  const miss = ruleRelatedEmptyCells(game.puzzle, cat)[0];
  doubleClick(grid().children[cat]); doubleClick(grid().children[miss]);
  assert.equal(game.turn, 1);
  const before = stablePublic(h), sent = sentActions(h), sounds = json(playedAudio(h).filter(sound => sound.kind !== 'ui'));
  for (const expected of [true, false, true]) {
    const cell = grid().children[target]; assert.equal(cell.tagName, 'BUTTON'); assert.equal(cell.disabled, false);
    cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 1 });
    cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', button: 0, pointerId: 1 });
    assert.equal(h.state.notes.has(target), !expected);
    cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
    assertUnopenedCell(grid().children[target], { note: expected });
  }
  for (const resolved of [cat, miss]) { assert.equal(grid().children[resolved].disabled, true); doubleClick(grid().children[resolved]); assert.equal(h.state.notes.has(resolved), false); }
  assertConfirmedEmpty(grid().children[miss]);
  doubleClick(grid().children[target]); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(target), true, 'a disallowed double cannot undo an existing private mark');
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  assert.deepEqual(playedAudio(h).filter(sound => sound.kind !== 'ui'), sounds);
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) for (const key of ['Enter', ' ', 'Spacebar']) test(`${mode} ${key.trim() || 'Space'} keyboard activations use single-mark and double-reveal without key-repeat actions`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  const activate = () => {
    const cell = grid().children[index];
    cell.dispatchEvent({ type: 'keydown', key, repeat: false });
    if (key === 'Enter') cell.dispatchEvent({ type: 'click', detail: 0 });
    cell.dispatchEvent({ type: 'keyup', key });
    if (key !== 'Enter') cell.dispatchEvent({ type: 'click', detail: 0 });
  };
  activate(); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), true); assert.deepEqual(json(board.found), []);
  activate(); activate(); h.tick(GESTURE_WAIT);
  assert.deepEqual(json(board.found), [index]); assert.equal(h.state.notes.has(index), false);
  const next = board.puzzle.solution[1], cell = grid().children[next], before = stablePublic(h);
  cell.dispatchEvent({ type: 'keydown', key, repeat: false });
  if (key === 'Enter') cell.dispatchEvent({ type: 'click', detail: 0 });
  for (let repeat = 0; repeat < 3; repeat++) {
    const event = { type: 'keydown', key, repeat: true }; cell.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, 'holding a key prevents native repeated activations');
    if (!event.defaultPrevented) cell.dispatchEvent({ type: 'click', detail: 0 });
  }
  cell.dispatchEvent({ type: 'keyup', key });
  if (key !== 'Enter') cell.dispatchEvent({ type: 'click', detail: 0 });
  h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(next), true, 'one genuine keyboard activation makes exactly one private mark');
  assert.equal(board.found.includes(next), false); assert.deepEqual(stablePublic(h), before);
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle']) test(`${mode} guest double activation sends one authority request and no speculative reveal`, () => {
  const battle = mode === 'battle';
  const host = harness({ mode, battle }), authority = host.begin();
  if (!battle) host.act(0, host.action('pass'));
  const guest = harness({ mode, battle, battleUI: battle }); guest.state.role = 'guest'; guest.state.you = 1; guest.enableRendering();
  guest.onMessage({ type: 'state', state: json(host.publicGame(authority)) }); guest.renderLegacy();
  const board = battle ? guest.state.game.boards[1] : guest.state.game;
  const index = (battle ? authority.boards[1] : authority).puzzle.solution[0];
  const grid = () => battle ? guest.get('.battle-side.local').querySelector('.battle-board') : guest.get('#board');
  singleClick(guest, grid().children[index]); assert.equal(guest.state.notes.has(index), true);
  const before = stablePublic(guest), actions = guest.messages.filter(message => message.type === 'action').length;
  const cell = grid().children[index]; doubleClick(cell); cell.dispatchEvent({ type: 'dblclick', detail: 2 }); cell.dispatchEvent({ type: 'click', detail: 3 });
  guest.tick(GESTURE_WAIT);
  const sent = guest.messages.filter(message => message.type === 'action').slice(actions);
  assert.equal(sent.length, 1); assert.equal(sent[0].action.type, 'guess'); assert.equal(sent[0].action.index, index);
  assert.equal(guest.state.notes.has(index), true, 'a pre-existing private mark stays until authority confirms the reveal');
  assert.ok(guest.state.pendingAction); assert.deepEqual(json(board.found), []); assert.deepEqual(stablePublic(guest), before);
  doubleClick(grid().children[index]); guest.tick(GESTURE_WAIT);
  assert.equal(guest.messages.filter(message => message.type === 'action').length, actions + 1);
  assert.equal(guest.state.notes.has(index), true, 'the pending-action guard cannot fall back to a single mark');
});

for (const mode of ['battle', 'practice']) test(`${mode} a double during hit cooldown leaves a private mark intact and applies no delayed reveal`, () => {
  const { h, game, board, grid } = gestureFixture(mode), [first, second] = board.puzzle.solution;
  singleClick(h, grid().children[second]); doubleClick(grid().children[first]);
  assert.equal(h.state.notes.has(second), true);
  const before = stablePublic(h), sent = sentActions(h);
  doubleClick(grid().children[second]); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(second), true); assert.deepEqual(json(board.found), [first]);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent); assert.equal(game.players[1].hp, 145);
  doubleClick(grid().children[second]); assert.equal(h.state.notes.has(second), false); assert.deepEqual(json(board.found), [first, second]);
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) for (const cancellation of ['disconnect', 'reconnect', 'finished', 'boardchange', 'background', 'blur']) test(`${mode} ${cancellation} cancels every pending private single without replay`, () => {
  const { h, game, board, grid, battle } = gestureFixture(mode), [first, second] = board.puzzle.solution;
  grid().children[first].click(); grid().children[second].click();
  assert.equal(h.state.notes.size, 0);
  if (cancellation === 'disconnect') h.onClose();
  if (cancellation === 'reconnect') h.onOpen();
  if (cancellation === 'finished') { game.status = 'finished'; game.winner = 0; h.renderLegacy(); }
  if (cancellation === 'boardchange') { h.begin(); h.renderLegacy(); }
  if (cancellation === 'background') { h.context.document.hidden = true; h.dispatchDocument('visibilitychange'); }
  if (cancellation === 'blur') h.dispatchWindow('blur');
  const before = stablePublic(h), sent = sentActions(h);
  h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.size, 0, `${cancellation} prevents a late private mark`);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  if (cancellation === 'background') { h.context.document.hidden = false; h.dispatchDocument('visibilitychange'); }
  h.renderLegacy(); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.size, 0, 'resuming or rendering cannot resurrect cancelled singles');
});

for (const mode of ['battle', 'practice']) test(`${mode} entering a strict miss lock cancels pending singles on every cell`, () => {
  const { h, board, grid } = gestureFixture(mode), [first, second] = board.puzzle.solution;
  grid().children[first].click(); grid().children[second].click();
  h.act(0, battleAction(h, 0, { index: ruleRelatedEmptyCells(board.puzzle, first)[0] }));
  const before = stablePublic(h), sent = sentActions(h);
  h.tick(2000 + GESTURE_WAIT);
  assert.equal(h.state.notes.size, 0); assert.equal(board.found.length, 0);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['basic', 'battle', 'practice']) for (const cancellation of ['pointercancel', 'blur']) test(`${mode} ${cancellation} invalidates a held press and its late activation`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  const cell = grid().children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 9 });
  cell.dispatchEvent({ type: cancellation, pointerType: 'touch', button: 0, pointerId: 9 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', button: 0, pointerId: 9 }); cell.click();
  const before = stablePublic(h), sent = sentActions(h); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), false); assert.equal(board.found.length, 0);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  const fresh = grid().children[index];
  fresh.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 10 });
  fresh.dispatchEvent({ type: 'pointerup', pointerType: 'touch', button: 0, pointerId: 10 }); fresh.click(); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), true);
});

// Context-menu behavior here is simulated through VM DOM events. These assertions
// verify handlers and state effects, not a physical mouse or browser's menu behavior.
function contextMenu(cell, { press = true } = {}) {
  if (press) {
    cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2, pointerId: 22 });
    cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 2, pointerId: 22 });
  }
  const event = { type: 'contextmenu', button: 2 };
  cell.dispatchEvent(event);
  return event;
}

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) test(`${mode} right-button and keyboard-menu events are native no-ops`, () => {
  const { h, board, grid, battle } = gestureFixture(mode), index = board.puzzle.solution[0];
  const before = stablePublic(h), sent = sentActions(h), sounds = json(playedAudio(h));
  for (const marked of [false, true]) {
    if (marked) singleClick(h, grid().children[index]);
    const cell = grid().children[index];
    const events = [
      { type: 'pointerdown', button: 2, buttons: 2, pointerType: 'mouse', pointerId: 22 },
      { type: 'pointerup', button: 2, buttons: 0, pointerType: 'mouse', pointerId: 22 },
      { type: 'click', button: 2, detail: 1 },
      { type: 'auxclick', button: 2, detail: 1 },
      { type: 'contextmenu', button: 2 },
      { type: 'keydown', key: 'ContextMenu', repeat: false },
      { type: 'keyup', key: 'ContextMenu' },
      { type: 'contextmenu', button: 0 },
      { type: 'keydown', key: 'F10', shiftKey: true, repeat: false },
      { type: 'keyup', key: 'F10', shiftKey: true },
      { type: 'contextmenu', button: 0 }
    ];
    for (const event of events) {
      cell.dispatchEvent(event);
      assert.notEqual(event.defaultPrevented, true, `${event.type} keeps browser behavior`);
    }
    h.tick(GESTURE_WAIT);
    assertUnopenedCell(grid().children[index], { note: marked });
    assert.equal(h.state.notes.has(index), marked);
    assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
    assert.equal(h.state.pendingAction, null); assert.equal(h.state.selectedCell, null);
    assertNoPrivateKeys(json(h.publicGame(h.state.game)));
    if (battle) assert.equal(h.get('.battle-side.opponent').querySelector('.battle-board').children.some(cell => cell.classList.contains('note')), false);
  }
  assert.deepEqual(playedAudio(h).filter(sound => sound.kind !== 'ui'), sounds.filter(sound => sound.kind !== 'ui'));
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) test(`${mode} a native menu does not add or cancel a queued primary mark`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  const before = stablePublic(h), sent = sentActions(h);
  grid().children[index].click(); h.tick(80);
  assert.notEqual(contextMenu(grid().children[index]).defaultPrevented, true);
  assert.equal(h.state.notes.has(index), false);
  h.tick(GESTURE_WAIT); assert.equal(h.state.notes.has(index), true);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent); assert.equal(board.found.length, 0);
});

test('battle primary marking starts during hit cooldown without an authority action', () => {
  const { h, game, board, grid } = gestureFixture('battle'), [cat, index] = board.puzzle.solution;
  h.act(0, battleAction(h, 0, { index: cat }));
  const before = stablePublic(h), sent = sentActions(h), deadline = board.cooldownUntil;
  grid().children[index].click(); h.tick(299);
  assert.equal(h.state.notes.has(index), false); assert.equal(board.found.includes(index), false);
  h.tick(1); assert.equal(h.state.notes.has(index), true);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  assert.equal(board.cooldownUntil, deadline); assert.equal(board.found.includes(index), false);
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} primary marks work off-turn and while a guess is pending without authorizing reveals`, () => {
  const h = harness({ mode }), game = h.begin(), index = game.puzzle.solution[0];
  h.enableRendering(); h.renderLegacy(); h.act(0, h.action('pass'));
  const before = stablePublic(h), sent = sentActions(h);
  assert.equal(h.get('#board').children[index].disabled, false);
  singleClick(h, h.get('#board').children[index]); assert.equal(h.state.notes.has(index), true);
  doubleClick(h.get('#board').children[index]); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), true); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  h.act(1, h.action('pass')); h.state.pendingAction = { index: (index + 1) % 36, actionId: 'in-flight-guess', turnId: game.turnId }; h.renderLegacy();
  const pending = json(h.state.pendingAction), pendingSnapshot = stablePublic(h), pendingSent = sentActions(h);
  singleClick(h, h.get('#board').children[index]); assert.equal(h.state.notes.has(index), false);
  doubleClick(h.get('#board').children[index]); h.tick(GESTURE_WAIT);
  assert.deepEqual(json(h.state.pendingAction), pending); assert.deepEqual(stablePublic(h), pendingSnapshot); assert.equal(sentActions(h), pendingSent);
});

for (const mode of ['items', 'coop']) for (const item of ['magnifier', 'yarn']) test(`${mode} right-click leaves armed ${item} and private notes unchanged`, () => {
  const h = harness({ mode }), game = h.begin(), index = game.puzzle.solution[0];
  game.players[0].fish = 4; game.sharedFish = 4; h.enableRendering(); h.renderLegacy();
  h.get(`#toolbox [data-item="${item}"]`).click();
  const before = stablePublic(h), sent = sentActions(h);
  assert.notEqual(contextMenu(h.get('#board').children[index]).defaultPrevented, true); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), false); assert.equal(h.state.tool, item);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  assert.deepEqual(json(h.state.yarnTargets), []); assert.equal(h.state.intel.length, 0);
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) test(`${mode} leaves resolved, opponent and unrelated context menus untouched`, () => {
  const battle = mode === 'battle' || mode === 'practice';
  const h = harness({ mode: battle ? 'battle' : mode, battle, battleUI: battle }); h.enableRendering();
  if (mode === 'practice') { h.startPractice(); h.advance(3000); h.updateBattleTimers(); } else h.begin();
  h.renderLegacy();
  const game = h.state.game, board = battle ? game.boards[0] : game, cat = board.puzzle.solution[0];
  const miss = ruleRelatedEmptyCells(board.puzzle, cat)[0];
  const grid = () => battle ? h.get('.battle-side.local').querySelector('.battle-board') : h.get('#board');
  doubleClick(grid().children[cat]);
  if (battle) { h.advance(300); h.updateBattleTimers(); }
  doubleClick(grid().children[miss]);
  const before = json(h.publicGame(game)), sent = h.messages.length, notes = [...h.state.notes];
  const targets = [grid().children[cat], grid().children[miss], h.get('#battleHelp'), h.get('#helpDialog'), h.get('#nick'), h.context.document.body, h.context.document];
  if (battle) targets.push(h.get('.battle-side.opponent').querySelector('.battle-board').children[0]);
  for (const cell of targets) {
    const event = contextMenu(cell);
    assert.notEqual(event.defaultPrevented, true, 'non-playable or unrelated targets retain their native menu');
    assert.deepEqual([...h.state.notes], notes); assert.deepEqual(json(h.publicGame(game)), before); assert.equal(h.messages.length, sent);
  }
});

test(`battle miss lock rejects right-click, keyboard, touch and direct activations`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const board = game.boards[0], [target, retained] = board.puzzle.solution;
  h.state.notes.add(retained);
  const miss = ruleRelatedEmptyCells(board.puzzle, target)[0]; h.act(0, battleAction(h, 0, { index: miss }));
  const before = json(h.publicGame(game)), sent = h.messages.length;
  const grid = h.get('.battle-side.local').querySelector('.battle-board');
  for (const index of [target, retained]) {
    const cell = grid.children[index]; assert.equal(cell.disabled, true);
    contextMenu(cell); contextMenu(cell, { press: false });
    for (const key of ['Enter', ' ', 'Spacebar']) { cell.dispatchEvent({ type: 'keydown', key, repeat: false }); cell.dispatchEvent({ type: 'keyup', key }); cell.dispatchEvent({ type: 'click', detail: 0 }); }
    cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 1 });
    cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', button: 0, pointerId: 1 }); cell.dispatchEvent({ type: 'click', detail: 1 });
    h.battleChoose(index);
    assert.equal(h.state.notes.has(index), index === retained);
  }
  assert.deepEqual([...h.state.notes], [retained]);
  assert.deepEqual(json(h.publicGame(game)), before); assert.equal(h.messages.length, sent); assert.equal(h.state.pendingAction, null);
  for (const target of [h.get('#battleHelp'), h.context.document.body, h.context.document]) assert.notEqual(contextMenu(target).defaultPrevented, true);
});

test(`a press on the lock modal cannot fall through to the newly unlocked board`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const board = game.boards[0], index = board.puzzle.solution[0], miss = ruleRelatedEmptyCells(board.puzzle, index)[0];
  h.act(0, battleAction(h, 0, { index: miss }));
  const root = h.get('.battle-side.local'), cell = root.querySelector('.battle-board').children[index];
  root.querySelector('.battle-lock').dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 1 });
  h.advance(2000); h.updateBattleTimers();
  const before = json(h.publicGame(game)), sent = h.messages.length;
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', button: 0, pointerId: 1 }); cell.dispatchEvent({ type: 'click', detail: 1, button: 0 });
  assert.equal(h.state.notes.has(index), false); assert.deepEqual(json(h.publicGame(game)), before); assert.equal(h.messages.length, sent);
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 2 });
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', button: 0, pointerId: 2 }); cell.dispatchEvent({ type: 'click', detail: 1, button: 0 });
  h.tick(GESTURE_WAIT); assert.equal(h.state.notes.has(index), true); assert.equal(board.found.includes(index), false);
});

test('a right press on the lock modal cannot create a late private note on the newly unlocked board', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const board = game.boards[0], index = board.puzzle.solution[0], miss = ruleRelatedEmptyCells(board.puzzle, index)[0];
  h.act(0, battleAction(h, 0, { index: miss }));
  const root = h.get('.battle-side.local'), cell = root.querySelector('.battle-board').children[index];
  root.querySelector('.battle-lock').dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2, pointerId: 1 });
  h.advance(2000); h.updateBattleTimers();
  const before = stablePublic(h, game), sent = sentActions(h);
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 2, pointerId: 1 }); contextMenu(cell, { press: false });
  assert.equal(h.state.notes.has(index), false); assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
  assert.notEqual(contextMenu(cell).defaultPrevented, true); assert.equal(h.state.notes.has(index), false);
  singleClick(h, cell); assert.equal(h.state.notes.has(index), true);
});

for (const key of ['ContextMenu', 'F10']) test(`a ${key === 'F10' ? 'Shift+F10' : key} press begun locked cannot create a private note after expiry`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const board = game.boards[0], index = board.puzzle.solution[0], miss = ruleRelatedEmptyCells(board.puzzle, index)[0];
  h.act(0, battleAction(h, 0, { index: miss }));
  const cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  cell.dispatchEvent({ type: 'keydown', key, shiftKey: key === 'F10', repeat: false });
  h.advance(2000); h.updateBattleTimers();
  const before = stablePublic(h, game), sent = sentActions(h);
  cell.dispatchEvent({ type: 'keyup', key, shiftKey: key === 'F10' }); cell.dispatchEvent({ type: 'contextmenu', button: 0 });
  assert.equal(h.state.notes.has(index), false); assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
  cell.dispatchEvent({ type: 'keydown', key, shiftKey: key === 'F10', repeat: false });
  const menu = { type: 'contextmenu', button: 0 }; cell.dispatchEvent(menu);
  assert.notEqual(menu.defaultPrevented, true); assert.equal(h.state.notes.has(index), false);
  singleClick(h, cell); assert.equal(h.state.notes.has(index), true);
  assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
});

test('battle guest primary marking affects only its own board and never sends an authority request', () => {
  const host = harness({ mode: 'battle', battle: true }), authority = host.begin();
  const guest = harness({ mode: 'battle', battle: true, battleUI: true }); guest.state.role = 'guest'; guest.state.you = 1; guest.enableRendering();
  guest.onMessage({ type: 'state', state: json(host.publicGame(authority)) });
  const root = guest.get('.battle-side.local'), opponent = guest.get('.battle-side.opponent'), index = authority.boards[1].puzzle.solution[0];
  assert.equal(+root.dataset.player, 1); assert.equal(+opponent.dataset.player, 0);
  const before = stablePublic(guest), sent = sentActions(guest);
  singleClick(guest, root.querySelector('.battle-board').children[index]);
  assert.equal(guest.state.notes.has(index), true); assertUnopenedCell(root.querySelector('.battle-board').children[index], { note: true });
  assert.equal(opponent.querySelector('.battle-board').children.some(cell => cell.classList.contains('note')), false);
  assert.equal(guest.state.pendingAction, null); assert.equal(sentActions(guest), sent); assert.deepEqual(stablePublic(guest), before);
  assertNoPrivateKeys(stablePublic(guest));
});

for (const cancellation of ['pointercancel', 'blur']) test(`a ${cancellation} right-click on an unlocked battle cell cannot be replayed`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const index = game.boards[0].puzzle.solution[0], cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  const before = stablePublic(h, game), sent = sentActions(h);
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2, pointerId: 1 });
  cell.dispatchEvent({ type: cancellation, pointerType: 'mouse', button: 2, pointerId: 1 });
  for (let repeat = 0; repeat < 2; repeat++) {
    contextMenu(cell, { press: false });
    assert.equal(h.state.notes.has(index), false); assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
  }
  assert.notEqual(contextMenu(cell).defaultPrevented, true); assert.equal(h.state.notes.has(index), false);
  singleClick(h, cell); assert.equal(h.state.notes.has(index), true);
});

test(`a right mouse press begun locked cannot add a note after expiry`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const board = game.boards[0], index = board.puzzle.solution[0], miss = ruleRelatedEmptyCells(board.puzzle, index)[0];
  h.act(0, battleAction(h, 0, { index: miss }));
  const cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2, pointerId: 1 });
  h.advance(2000); h.updateBattleTimers();
  const before = stablePublic(h, game), sent = sentActions(h);
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', button: 2, pointerId: 1 }); contextMenu(cell, { press: false });
  assert.equal(h.state.notes.has(index), false); assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
  assert.notEqual(contextMenu(cell).defaultPrevented, true); assert.equal(h.state.notes.has(index), false);
  singleClick(h, cell); assert.equal(h.state.notes.has(index), true);
  assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
});

for (const cancellation of ['pointercancel', 'blur']) test(`a ${cancellation} right-click intent has no late effect after miss-lock expiry`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const board = game.boards[0], index = board.puzzle.solution[0], miss = ruleRelatedEmptyCells(board.puzzle, index)[0];
  h.act(0, battleAction(h, 0, { index: miss }));
  const cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2, pointerId: 1 });
  cell.dispatchEvent({ type: cancellation, pointerType: 'mouse', button: 2, pointerId: 1 });
  h.advance(2000); h.updateBattleTimers();
  const before = stablePublic(h, game), sent = sentActions(h);
  contextMenu(cell, { press: false }); assert.equal(h.state.notes.has(index), false);
  assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
  assert.notEqual(contextMenu(cell).defaultPrevented, true); assert.equal(h.state.notes.has(index), false);
  singleClick(h, cell); assert.equal(h.state.notes.has(index), true);
});

test('a right-click from a replaced battle puzzle is ignored while the current puzzle remains usable', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  const board = game.boards[0], cats = [...board.puzzle.solution], empty = ruleRelatedEmptyCells(board.puzzle, cats[0])[0];
  const oldCell = h.get('.battle-side.local').querySelector('.battle-board').children[empty];
  oldCell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2, pointerId: 1 });
  for (const index of cats) { h.act(0, battleAction(h, 0, { index })); h.advance(300); }
  h.updateBattleTimers();
  assert.notEqual(board.puzzle.id, game.boards[0].puzzle.id); assert.equal(oldCell.parentNode, null);
  const before = stablePublic(h, game), sent = sentActions(h);
  contextMenu(oldCell, { press: false }); contextMenu(oldCell);
  assert.equal(h.state.notes.size, 0); assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
  singleClick(h, h.get('.battle-side.local').querySelector('.battle-board').children[empty]);
  assert.equal(h.state.notes.has(empty), true); assert.deepEqual(stablePublic(h, game), before);
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} stale board context-menu events cannot mark a new game`, () => {
  const h = harness({ mode }), first = h.begin(); h.enableRendering(); h.renderLegacy();
  const index = first.puzzle.solution[0], oldCell = h.get('#board').children[index];
  oldCell.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 2, pointerId: 1 });
  const game = h.begin(); h.renderLegacy();
  assert.notEqual(first.puzzle.id, game.puzzle.id); assert.equal(oldCell.parentNode, null);
  const before = stablePublic(h, game), sent = sentActions(h);
  contextMenu(oldCell, { press: false }); contextMenu(oldCell);
  assert.equal(h.state.notes.size, 0); assert.deepEqual(stablePublic(h, game), before); assert.equal(sentActions(h), sent);
});

test('ordinary paused battle still allows private notes when there is no miss lock', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.enableRendering(); h.renderBattle();
  h.onClose();
  const index = game.boards[0].puzzle.solution[0], cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  const before = json(h.publicGame(game)), epoch = h.state.battleInputEpoch;
  cell.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 1 }); h.tick(60);
  assert.equal(h.state.battleInputEpoch, epoch);
  const sent = h.messages.length; // Periodic transport pings during the wait are unrelated to note activation.
  cell.dispatchEvent({ type: 'pointerup', pointerType: 'touch', button: 0, pointerId: 1 }); cell.click(); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), true); singleClick(h, cell); assert.equal(h.state.notes.has(index), false);
  const after = json(h.publicGame(game)); delete before.serverTime; delete after.serverTime;
  assert.deepEqual(after, before); assert.equal(h.messages.length, sent); assert.equal(game.status, 'paused');
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) for (const pointerType of ['mouse', 'touch']) test(`${mode} ${pointerType} hold-and-drag fills crossed cells once with private ADD-only marks`, () => {
  const { h, game, board, grid, battle } = gestureFixture(mode);
  const resolved = [1, 2, 3, 4].filter(index => !board.puzzle.solution.includes(index)).slice(0, 2);
  board.misses.push(...resolved); h.state.notes.add(0); h.state.notes.add(5); h.renderLegacy();
  const before = stablePublic(h), sent = sentActions(h), sounds = json(playedAudio(h));
  const cell = grid().children[0];
  pointerAt(cell, 'pointerdown', cell, { pointerType }); h.tick(249);
  assert.equal(h.state.notes.size, 2, 'a stationary hold never draws'); h.tick(1);
  pointerAt(cell, 'pointermove', grid().children[5], { pointerType });
  pointerAt(cell, 'pointermove', grid().children[0], { pointerType });
  pointerAt(cell, 'pointermove', grid().children[5], { pointerType });
  pointerAt(cell, 'pointerup', grid().children[5], { pointerType });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 });
  cell.dispatchEvent({ type: 'dblclick', button: 0, detail: 2 }); h.tick(GESTURE_WAIT);
  const expected = [0, 1, 2, 3, 4, 5].filter(index => !resolved.includes(index));
  assert.deepEqual([...h.state.notes].sort((a, b) => a - b), expected);
  for (const index of expected) assertUnopenedCell(grid().children[index], { note: true });
  for (const index of resolved) assertConfirmedEmpty(grid().children[index]);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  assert.equal(h.state.pendingAction, null); assert.deepEqual(playedAudio(h), sounds);
  if (mode !== 'practice') assert.deepEqual(JSON.parse(h.context.sessionStorage.getItem('p2pNotes-host')).sort((a, b) => a - b), expected);
  assertNoPrivateKeys(json(h.publicGame(game)));
  if (battle) assert.equal(h.get('.battle-side.opponent').querySelector('.battle-board').children.some(node => node.classList.contains('note')), false);
});

for (const mode of ['basic', 'items', 'treasure', 'coop', 'battle', 'practice']) for (const pointerType of ['mouse', 'touch']) for (const gesture of ['stationary hold', 'quick drag']) test(`${mode} ${pointerType} ${gesture} cannot become a private click or reveal`, () => {
  const { h, board, grid } = gestureFixture(mode), index = board.puzzle.solution[0];
  const before = stablePublic(h), sent = sentActions(h), cell = grid().children[index];
  pointerAt(cell, 'pointerdown', cell, { pointerType }); h.tick(gesture === 'stationary hold' ? 250 : 30);
  if (gesture === 'quick drag') pointerAt(cell, 'pointermove', cell, { pointerType, clientX: cell.getBoundingClientRect().left + 28 });
  pointerAt(cell, 'pointerup', cell, { pointerType });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.size, 0); assert.equal(board.found.length, 0);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  doubleClick(grid().children[index], { pointerType });
  assert.deepEqual(json(board.found), [index], 'a later fresh deliberate double remains available');
});

for (const mode of ['basic', 'battle', 'practice']) test(`${mode} native PointerEvent prototype properties survive the stroke adapter`, () => {
  const { h, grid } = gestureFixture(mode), cell = grid().children[0];
  const dispatch = (type, target = cell) => {
    const rect = target.getBoundingClientRect();
    const prototype = { type, pointerType: 'touch', pointerId: 19, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      isPrimary: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      cancelable: true, timeStamp: h.now() };
    const event = Object.create(prototype); cell.dispatchEvent(event); return event;
  };
  const before = stablePublic(h), sent = sentActions(h);
  dispatch('pointerdown'); h.tick(250); const move = dispatch('pointermove', grid().children[5]);
  assert.equal(move.defaultPrevented, true, 'a confirmed stroke may suppress browser scrolling');
  dispatch('pointerup', grid().children[5]); cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['basic', 'battle']) test(`${mode} coalesced pointer samples paint their actual bend instead of only the endpoint chord`, () => {
  const { h, grid } = gestureFixture(mode), cell = grid().children[0];
  const before = stablePublic(h), sent = sentActions(h);
  pointerAt(cell, 'pointerdown'); h.tick(250);
  const bend = grid().children[6].getBoundingClientRect();
  pointerAt(cell, 'pointermove', grid().children[11], { getCoalescedEvents: () => [Object.create({
    clientX: bend.left + bend.width / 2, clientY: bend.top + bend.height / 2, timeStamp: h.now()
  })] });
  pointerAt(cell, 'pointerup', grid().children[11]); cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes].sort((a, b) => a - b), [0, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

test('all native coalesced samples preserve a long stroke around three board edges', () => {
  for (const mode of ['basic', 'battle']) {
    const { h, grid } = gestureFixture(mode), cell = grid().children[0];
    const before = stablePublic(h), sent = sentActions(h);
    pointerAt(cell, 'pointerdown'); h.tick(250);
    const samples = [30, 35, ...Array(12).fill(5)].map(index => {
      const rect = grid().children[index].getBoundingClientRect();
      return Object.create({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, buttons: 1, timeStamp: h.now() });
    });
    pointerAt(cell, 'pointermove', grid().children[5], { getCoalescedEvents: () => samples });
    pointerAt(cell, 'pointerup', grid().children[5]); cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
    assert.deepEqual([...h.state.notes].sort((a, b) => a - b), [0, 5, 6, 11, 12, 17, 18, 23, 24, 29, 30, 31, 32, 33, 34, 35], mode);
    assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  }
});

test('a mouse move with no held button recovers a missed release without eating the next primary click', () => {
  for (const mode of ['basic', 'battle']) {
    const { h, grid } = gestureFixture(mode), cell = grid().children[0];
    const before = stablePublic(h), sent = sentActions(h);
    pointerAt(cell, 'pointerdown'); h.tick(250); pointerAt(cell, 'pointermove', grid().children[1]);
    assert.deepEqual([...h.state.notes], [0, 1]);
    // The release occurred outside the window, so its pointerup was never delivered.
    pointerAt(cell, 'pointermove', grid().children[5], { buttons: 0 });
    assert.deepEqual([...h.state.notes], [0, 1]);
    assert.equal(cell.hasPointerCapture(7), false); assert.equal(h.state.boardStrokes.state().pointerCount, 0);
    singleClick(h, grid().children[2]);
    assert.deepEqual([...h.state.notes], [0, 1, 2], `${mode} accepts the very next fresh click`);
    assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  }
});

test('old-cell blur after a new pointerdown cannot cancel a reused pointer ID on the new cell', () => {
  for (const mode of ['basic', 'battle']) {
    const { h, grid } = gestureFixture(mode), previous = grid().children[0], next = grid().children[2];
    const before = stablePublic(h), sent = sentActions(h);
    pointerAt(previous, 'pointerdown'); h.tick(250); pointerAt(previous, 'pointermove', grid().children[1]);
    pointerAt(previous, 'pointermove', grid().children[5], { buttons: 0 });
    assert.deepEqual([...h.state.notes], [0, 1]);
    pointerAt(next, 'pointerdown');
    // Native focus changes blur the previous button after the next pointerdown.
    previous.dispatchEvent({ type: 'blur' });
    // A late click on A must not finish B's current pointer with the same ID.
    previous.dispatchEvent({ type: 'click', button: 0, detail: 1 });
    assert.equal(h.state.boardStrokes.state().pointerCount, 1);
    pointerAt(next, 'pointerup'); next.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
    assert.deepEqual([...h.state.notes], [0, 1, 2], `${mode} keeps the new press with reused pointer ID 7`);
    assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  }
});

test('cell blur cancels an active stroke before later movement and leaves fresh input usable', () => {
  for (const mode of ['basic', 'battle']) {
    const { h, grid } = gestureFixture(mode), cell = grid().children[0];
    const before = stablePublic(h), sent = sentActions(h);
    pointerAt(cell, 'pointerdown'); h.tick(250); pointerAt(cell, 'pointermove', grid().children[1]);
    cell.dispatchEvent({ type: 'blur' });
    assert.equal(cell.hasPointerCapture(7), false);
    pointerAt(cell, 'pointermove', grid().children[5]); pointerAt(cell, 'pointerup', grid().children[5]);
    cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
    assert.deepEqual([...h.state.notes], [0, 1], `${mode} stops drawing at cell blur`);
    singleClick(h, grid().children[2]); assert.deepEqual([...h.state.notes], [0, 1, 2]);
    assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  }
});

for (const mode of ['basic', 'battle']) test(`${mode} releasing an active stroke outside the board paints its last crossed cells and suppresses the click`, () => {
  const { h, grid } = gestureFixture(mode), cell = grid().children[0];
  const before = stablePublic(h), sent = sentActions(h);
  pointerAt(cell, 'pointerdown'); h.tick(250); pointerAt(cell, 'pointermove', grid().children[1]);
  const last = grid().children[5], edge = last.getBoundingClientRect();
  pointerAt(cell, 'pointerup', last, { clientX: edge.right + 60 });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(cell.hasPointerCapture(7), false);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['basic', 'items', 'treasure', 'coop']) test(`${mode} private strokes remain usable off-turn without spending currency or transmitting actions`, () => {
  const { h, game, grid } = gestureFixture(mode); h.act(0, h.action('pass'));
  const before = stablePublic(h), sent = sentActions(h);
  dragMarks(h, grid, { pointerType: 'touch' }); h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent); assert.equal(game.turn, 1);
});

for (const mode of ['basic', 'battle']) test(`${mode} guest strokes never send an authority request or leak marks to snapshots`, () => {
  const battle = mode === 'battle', host = harness({ mode, battle }), authority = host.begin();
  const guest = harness({ mode, battle, battleUI: battle }); guest.state.role = 'guest'; guest.state.you = 1; guest.enableRendering();
  guest.onMessage({ type: 'state', state: json(host.publicGame(authority)) }); guest.renderLegacy();
  const grid = () => battle ? guest.get('.battle-side.local').querySelector('.battle-board') : guest.get('#board');
  const before = stablePublic(guest), sent = sentActions(guest);
  dragMarks(guest, grid, { pointerType: 'touch' }); guest.tick(GESTURE_WAIT);
  assert.deepEqual([...guest.state.notes].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(stablePublic(guest), before); assert.equal(sentActions(guest), sent); assert.equal(guest.state.pendingAction, null);
  assert.deepEqual(JSON.parse(guest.context.sessionStorage.getItem('p2pNotes-guest')), [0, 1, 2, 3, 4, 5]);
  assert.equal(guest.context.sessionStorage.getItem('p2pNotes-host'), null); assertNoPrivateKeys(json(guest.publicGame(guest.state.game)));
});

for (const mode of ['basic', 'battle']) for (const initiallyMarked of [false, true]) test(`${mode} guest native mouse double restores the exact private mark while waiting for authority`, () => {
  const battle = mode === 'battle', host = harness({ mode, battle }), authority = host.begin();
  if (!battle) host.act(0, host.action('pass'));
  const guest = harness({ mode, battle, battleUI: battle }); guest.state.role = 'guest'; guest.state.you = 1; guest.enableRendering();
  guest.onMessage({ type: 'state', state: json(host.publicGame(authority)) }); guest.renderLegacy();
  const board = battle ? authority.boards[1] : authority, index = board.puzzle.solution[0];
  const grid = () => battle ? guest.get('.battle-side.local').querySelector('.battle-board') : guest.get('#board');
  if (initiallyMarked) { guest.state.notes.add(index); guest.renderLegacy(); }
  const before = stablePublic(guest), sent = guest.messages.filter(message => message.type === 'action').length;
  let cell = grid().children[index]; pointerAt(cell, 'pointerdown'); pointerAt(cell, 'pointerup');
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); guest.tick(350);
  assert.equal(guest.state.notes.has(index), !initiallyMarked);
  cell = grid().children[index]; pointerAt(cell, 'pointerdown'); pointerAt(cell, 'pointerup');
  cell.dispatchEvent({ type: 'click', button: 0, detail: 2 }); guest.tick(GESTURE_WAIT);
  assert.equal(guest.state.notes.has(index), initiallyMarked, 'native promotion undoes only its own first-click toggle');
  assert.deepEqual(stablePublic(guest), before); assert.ok(guest.state.pendingAction);
  assert.equal(guest.messages.filter(message => message.type === 'action').length, sent + 1);
});

for (const mode of ['battle', 'practice']) test(`${mode} a stroke started during the real hit cooldown stays private and skips the captured cell`, () => {
  const { h, board, grid } = gestureFixture(mode), cat = board.puzzle.solution[0];
  h.act(0, battleAction(h, 0, { index: cat }));
  const from = cat === 0 ? 1 : 0, before = stablePublic(h), sent = sentActions(h);
  dragMarks(h, grid, { from, to: 5, pointerType: 'touch' });
  assert.equal(board.cooldownUntil - h.now(), 50, 'drawing begins before the 300 ms hit cooldown expires');
  const expected = Array.from({ length: 6 - from }, (_, offset) => from + offset).filter(index => index !== cat);
  assert.deepEqual([...h.state.notes].sort((a, b) => a - b), expected);
  h.tick(GESTURE_WAIT); assert.deepEqual(json(board.found), [cat]);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['battle', 'practice']) test(`${mode} an opponent-board drag never starts a local stroke`, () => {
  const { h } = gestureFixture(mode), grid = () => h.get('.battle-side.opponent').querySelector('.battle-board');
  const before = stablePublic(h), sent = sentActions(h);
  dragMarks(h, grid, { pointerType: 'touch' }); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.size, 0); assert.equal(h.state.boardStrokes?.state().active || false, false);
  assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

test('a 24 by 24 legacy board interpolates a complete row without action or per-cell timers', () => {
  const h = harness({ size: 24 }); h.begin(); h.enableRendering(); h.renderLegacy();
  const grid = () => h.get('#board'), before = stablePublic(h), sent = sentActions(h), timers = h.timers.size;
  vm.runInContext('globalThis.strokeNoteSaves = 0; const strokeSave = saveLocal; saveLocal = (...args) => { strokeNoteSaves++; return strokeSave(...args); };', h.context);
  dragMarks(h, grid, { to: 23, pointerType: 'touch' });
  assert.deepEqual([...h.state.notes], Array.from({ length: 24 }, (_, index) => index));
  assert.ok(h.timers.size <= timers, 'drawing adds no timer for traversed cells');
  assert.equal(h.context.strokeNoteSaves, 1, 'one stroke persists its completed private notes in one write');
  h.tick(GESTURE_WAIT); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['basic', 'battle', 'practice']) for (const cancellation of ['pointercancel', 'lostpointercapture', 'blur', 'background', 'disconnect', 'reconnect', 'finished', 'boardchange']) test(`${mode} ${cancellation} stops an active stroke and suppresses its late click`, () => {
  const { h, game, grid } = gestureFixture(mode), cell = grid().children[0];
  pointerAt(cell, 'pointerdown'); h.tick(250); pointerAt(cell, 'pointermove', grid().children[1]);
  assert.deepEqual([...h.state.notes], [0, 1]);
  if (cancellation === 'pointercancel' || cancellation === 'lostpointercapture') pointerAt(cell, cancellation);
  if (cancellation === 'blur') h.dispatchWindow('blur');
  if (cancellation === 'background') { h.context.document.hidden = true; h.dispatchDocument('visibilitychange'); }
  if (cancellation === 'disconnect') h.onClose();
  if (cancellation === 'reconnect') h.onOpen();
  if (cancellation === 'finished') { game.status = 'finished'; h.renderLegacy(); }
  if (cancellation === 'boardchange') { h.begin(); h.renderLegacy(); }
  const notes = [...h.state.notes], before = stablePublic(h), sent = sentActions(h);
  pointerAt(cell, 'pointermove', grid().children[5]); pointerAt(cell, 'pointerup', grid().children[5]);
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes], notes); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['battle', 'practice']) test(`${mode} a strict miss lock ends an active stroke and a held press cannot resume at expiry`, () => {
  const { h, board, grid } = gestureFixture(mode), cell = grid().children[0];
  pointerAt(cell, 'pointerdown', cell, { pointerType: 'touch' }); h.tick(250);
  pointerAt(cell, 'pointermove', grid().children[1], { pointerType: 'touch' });
  const miss = board.puzzle.regions.findIndex((_, index) => index > 5 && !board.puzzle.solution.includes(index));
  h.act(0, battleAction(h, 0, { index: miss }));
  const notes = [...h.state.notes], before = stablePublic(h), sent = sentActions(h);
  h.tick(2000); h.updateBattleTimers();
  pointerAt(cell, 'pointermove', grid().children[5], { pointerType: 'touch' });
  pointerAt(cell, 'pointerup', grid().children[5], { pointerType: 'touch' });
  cell.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes], notes); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  dragMarks(h, grid, { from: 6, to: 11, pointerType: 'touch' }); h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(11), !board.misses.includes(11), 'a fresh post-lock stroke works only on unresolved cells');
});

for (const mode of ['basic', 'battle', 'practice']) test(`${mode} a second touch cancels drawing and late releases cannot turn into taps`, () => {
  const { h, grid } = gestureFixture(mode), first = grid().children[0], second = grid().children[5];
  pointerAt(first, 'pointerdown', first, { pointerType: 'touch', pointerId: 1 }); h.tick(250);
  pointerAt(first, 'pointermove', grid().children[1], { pointerType: 'touch', pointerId: 1 });
  const before = stablePublic(h), sent = sentActions(h), notes = [...h.state.notes];
  pointerAt(second, 'pointerdown', second, { pointerType: 'touch', pointerId: 2, isPrimary: false });
  pointerAt(first, 'pointermove', grid().children[4], { pointerType: 'touch', pointerId: 1 });
  pointerAt(second, 'pointerup', second, { pointerType: 'touch', pointerId: 2, isPrimary: false });
  pointerAt(first, 'pointerup', grid().children[4], { pointerType: 'touch', pointerId: 1 });
  first.dispatchEvent({ type: 'click', button: 0, detail: 1 }); second.dispatchEvent({ type: 'click', button: 0, detail: 1 }); h.tick(GESTURE_WAIT);
  assert.deepEqual([...h.state.notes], notes); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
});

for (const mode of ['items', 'coop']) for (const item of ['magnifier', 'yarn']) test(`${mode} explicitly armed ${item} consumes deliberate single selection without accidental double guessing`, () => {
  const { h, game, grid } = gestureFixture(mode), target = game.puzzle.solution[0];
  game.players[0].fish = 4; game.sharedFish = 4; h.renderLegacy();
  const tool = h.get(`#toolbox [data-item="${item}"]`);
  grid().children[target].click(); // A pending mark must be cancelled when scan selection begins.
  tool.click(); assert.equal(h.state.tool, item);
  doubleClick(grid().children[target]); h.tick(GESTURE_WAIT);
  assert.deepEqual(json(game.found), []); assert.deepEqual(json(game.misses), []);
  assert.equal(h.state.notes.has(target), false, 'selecting a scan target never leaves a queued private mark');
  if (item === 'magnifier') {
    assert.equal(game.itemUsedThisTurn, true); assert.equal((mode === 'coop' ? game.sharedIntel : h.state.intel).length, 1);
  } else {
    assert.equal(game.itemUsedThisTurn, false);
    assert.ok(h.state.yarnTargets.length <= 1, 'same-cell double activation cannot create duplicate yarn targets');
  }
});

test('quick match is hidden unless explicitly enabled and keeps the enabled service hook', () => {
  for (const matchEnabled of [undefined, false, 'true']) {
    const button = harness({ matchEnabled }).get('#quickMatch');
    assert.equal(button.classList.contains('hidden') || button.hidden === true, true, `CAT_MATCH_ENABLED=${matchEnabled} must hide the unavailable action`);
    assert.equal(button.disabled, true);
  }
  const enabled = harness({ matchEnabled: true }).get('#quickMatch');
  assert.equal(enabled.classList.contains('hidden') || enabled.hidden === true, false);
  assert.equal(enabled.disabled, false); assert.equal(typeof enabled.onclick, 'function');
});

for (const size of [6, 12, 20, 24]) test(`rendered ${size}×${size} regions use unique stable colors across peers and rerenders`, () => {
  const h = harness({ size }), first = h.begin(); h.renderLegacy();
  const colors = json(h.context.CatPalette.build(first.puzzle));
  assert.equal(colors.length, size); assert.equal(new Set(colors).size, size);
  const inspect = (instance, expected) => instance.get('#board').children.forEach(cell => assert.equal(cell.style.getPropertyValue('--bg'), expected[+cell.dataset.region]));
  inspect(h, colors); h.renderLegacy(); inspect(h, colors);
  const guest = harness({ size, seed: 0x8821 }); guest.state.role = 'guest'; guest.state.you = 1;
  guest.onMessage({ type: 'state', state: json(h.publicGame(first)) }); guest.renderLegacy(); inspect(guest, colors);
  assert.deepEqual(json(guest.context.CatPalette.build(guest.state.game.puzzle)), colors, 'public snapshots retain the host mapping without private answers');
  guest.onClose(); guest.onOpen(); guest.onMessage({ type: 'state', state: json(h.publicGame(first)) }); guest.renderLegacy(); inspect(guest, colors);
  const second = h.begin(); assert.notEqual(second.puzzle.id, first.puzzle.id);
  h.renderLegacy(); const nextColors = json(h.context.CatPalette.build(second.puzzle));
  assert.equal(new Set(nextColors).size, size); inspect(h, nextColors);
});

test('battle boards preserve each public board’s palette for both local and opponent views', () => {
  const host = harness({ mode: 'battle', battle: true, battleUI: true }), game = host.begin(); host.renderBattle();
  assert.notEqual(game.boards[0].puzzle.id, game.boards[1].puzzle.id);
  const guest = harness({ mode: 'battle', battle: true, battleUI: true }); guest.state.role = 'guest'; guest.state.you = 1;
  guest.onMessage({ type: 'state', state: json(host.publicGame(game)) }); guest.renderBattle();
  for (let player = 0; player < 2; player++) {
    const colors = json(host.context.CatPalette.build(game.boards[player].puzzle));
    assert.equal(new Set(colors).size, 6);
    for (const instance of [host, guest]) {
      const side = player === instance.state.you ? 'local' : 'opponent';
      for (const cell of instance.get(`.battle-side.${side}`).querySelector('.battle-board').children) {
        assert.equal(cell.style.getPropertyValue('--bg'), colors[+cell.dataset.region]);
      }
    }
  }
});

test('page load and authoritative rendering do not create an AudioContext before a user gesture', () => {
  let constructions = 0;
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true, AudioContext: class { constructor() { constructions++; throw new Error('test audio backend'); } } });
  const game = h.begin(); h.renderBattle();
  h.act(0, battleAction(h, 0)); h.renderBattle(); h.tick(1600);
  assert.equal(constructions, 0); assert.equal(h.audio.calls.some(call => call.method === 'unlockFromGesture'), false);
  assert.equal(game.players[1].hp, 145);
  h.context.document.hidden = true; h.dispatchDocument('visibilitychange');
  h.context.document.hidden = false; h.dispatchDocument('visibilitychange');
  assert.equal(constructions, 0, 'tab recovery must not count as an audio-unlock gesture');
  h.dispatchDocument('pointerdown');
  assert.equal(constructions, 1, 'the first permitted context construction belongs to the pointer gesture');
});

test('every fresh own battle capture routes a real-meow cue, with a separate combo accent after the first', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin(); h.renderBattle();
  h.audio.calls.length = 0;
  h.act(0, battleAction(h, 0)); h.renderBattle(); h.flushFrames();
  let sounds = playedAudio(h);
  for (const kind of ['meow', 'launch', 'impact']) {
    assert.equal(sounds.filter(sound => sound.kind === kind).length, 1, `one ${kind} request per event`);
    assert.ok(sounds.find(sound => sound.kind === kind).id.includes(game.lastEvent.id), `${kind} uses the authoritative event identity`);
  }
  assert.equal(sounds.find(sound => sound.kind === 'meow').combo, 1);
  assert.equal(sounds.some(sound => sound.kind === 'combo' || sound.kind === 'found'), false);
  const firstSounds = json(sounds);
  h.observeBattleEvent(game.lastEvent); h.renderBattle(); h.flushFrames();
  assert.deepEqual(playedAudio(h), firstSounds, 'rendering and observing one event again never queue it twice');
  h.advance(300); h.act(0, battleAction(h, 0, { index: game.boards[0].puzzle.solution[1] })); h.renderBattle();
  sounds = playedAudio(h).slice(firstSounds.length);
  assert.equal(sounds.filter(sound => sound.kind === 'meow').length, 1, 'a combo must not replace the cat voice');
  assert.equal(sounds.find(sound => sound.kind === 'meow').combo, 2);
  assert.ok(sounds.find(sound => sound.kind === 'meow').id.includes(game.lastEvent.id));
  assert.equal(sounds.filter(sound => sound.kind === 'combo').length, 1);
  assert.equal(sounds.find(sound => sound.kind === 'combo').combo, 2);
  assert.equal(sounds.some(sound => sound.kind === 'found'), false);
  assert.equal(game.players[1].hp, 135, 'audio never changes authoritative damage');
});

test('the winning battle capture meows once after cancellation and delays its win accent without an attack', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin();
  h.renderBattle(); game.players[1].hp = 5; h.audio.calls.length = 0;
  h.act(0, battleAction(h, 0)); h.renderBattle(); h.flushFrames();
  assert.equal(game.status, 'finished'); assert.equal(game.winner, 0);
  const sounds = json(playedAudio(h)), meows = sounds.filter(sound => sound.kind === 'meow');
  assert.equal(meows.length, 1); assert.ok(meows[0].id.includes(game.lastEvent.id));
  assert.equal(sounds.filter(sound => sound.kind === 'win').length, 1);
  assert.ok(sounds.find(sound => sound.kind === 'win').delay >= 0.5, 'the recorded cat gets room before the win accent');
  assert.equal(sounds.some(sound => ['launch', 'impact'].includes(sound.kind)), false);
  const stop = h.audio.calls.findIndex(call => call.method === 'stopAll');
  const voice = h.audio.calls.findIndex(call => call.method === 'play' && call.args[0] === 'meow');
  assert.ok(stop >= 0 && voice > stop, 'terminal cleanup cannot immediately cancel the winning cat voice');
  assert.equal(h.state.battleFXNodes.size, 0); assert.equal(h.state.battleFXTimers.size, 0);
  h.renderBattle(); h.observeBattleEvent(game.lastEvent); h.updateBattleTimers();
  assert.deepEqual(playedAudio(h), sounds, 'the final render and stored event cannot replay the voice');
});

test('a guest hears its fresh winning battle capture once but never replays a terminal snapshot', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), authority = h.begin();
  authority.players[0].hp = 5;
  h.state.role = 'guest'; h.state.you = 1; h.state.game = null;
  const receive = snapshot => { h.onMessage({ type: 'state', state: json(snapshot) }); h.renderBattle(); };
  receive(h.publicGame(authority)); h.audio.calls.length = 0;
  h.advance(300);
  assert.equal(h.context.CatBattle.act(authority, 1, { type: 'guess', actionId: 'guest-winning-meow', boardId: authority.boards[1].puzzle.id, index: authority.boards[1].puzzle.solution[0] }, h.now()).accepted, true);
  const final = json(h.publicGame(authority)); receive(final);
  const sounds = json(playedAudio(h));
  assert.equal(sounds.filter(sound => sound.kind === 'meow').length, 1);
  assert.equal(sounds.filter(sound => sound.kind === 'win').length, 1);
  receive(final); receive({ ...final, revision: final.revision + 1 });
  assert.deepEqual(playedAudio(h), sounds);
  h.onClose(); h.onOpen(); receive(final); h.renderBattle();
  assert.deepEqual(playedAudio(h), sounds, 'reconnection cannot replay the stored terminal voice');
  const joiner = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true });
  joiner.state.role = 'guest'; joiner.state.you = 1;
  joiner.onMessage({ type: 'state', state: final }); joiner.renderBattle();
  assert.equal(playedAudio(joiner).some(sound => ['meow', 'combo', 'win', 'lose'].includes(sound.kind)), false);
});

test('guest snapshots never replay historical audio, including duplicates, old revisions and reconnects', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), authority = h.begin();
  h.state.role = 'guest'; h.state.you = 1; h.state.game = null;
  const hit = ordinal => {
    h.advance(300);
    assert.equal(h.context.CatBattle.act(authority, 0, { type: 'guess', actionId: `audio-hit-${ordinal}`, boardId: authority.boards[0].puzzle.id, index: authority.boards[0].puzzle.solution[ordinal] }, h.now()).accepted, true);
    return json(h.publicGame(authority));
  };
  const receive = snapshot => { h.onMessage({ type: 'state', state: json(snapshot) }); h.renderBattle(); h.flushFrames(); };
  const initial = hit(0); receive(initial); assert.deepEqual(playedAudio(h), [], 'joining suppresses the stored last event');
  const fresh = hit(1); receive(fresh); const live = json(playedAudio(h)); assert.ok(live.some(sound => sound.kind === 'damage'));
  assert.equal(live.some(sound => ['meow', 'found', 'combo'].includes(sound.kind)), false, 'opponent hits use incoming damage feedback without local success cues');
  receive(fresh); receive(initial); assert.deepEqual(playedAudio(h), live);
  const repeated = json(fresh); repeated.revision++; receive(repeated); assert.deepEqual(playedAudio(h), live);
  h.onClose(); h.onOpen(); const reconnect = hit(2); receive(reconnect); assert.deepEqual(playedAudio(h), live);
  receive(hit(3)); assert.ok(playedAudio(h).length > live.length, 'the next live event after synchronization is audible');
});

for (const cleanup of ['pause', 'disconnect', 'finished', 'aborted', 'background']) test(`battle ${cleanup} cancels scheduled audio without replaying the stored hit`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin(); h.renderBattle();
  h.act(0, battleAction(h, 0)); h.renderBattle(); assert.ok(playedAudio(h).some(sound => sound.kind === 'impact'));
  h.audio.calls.length = 0;
  if (cleanup === 'disconnect') h.onClose();
  else if (cleanup === 'background') { h.context.document.hidden = true; h.dispatchDocument('visibilitychange'); }
  else {
    if (cleanup === 'pause') h.context.CatBattle.pause(game, h.now());
    if (cleanup === 'aborted') h.context.CatBattle.abort(game, h.now());
    if (cleanup === 'finished') { game.status = 'finished'; game.winner = 0; game.players[1].hp = 0; game.revision++; }
    h.renderBattle();
  }
  assert.ok(h.audio.calls.some(call => call.method === 'stopAll'), `${cleanup} must stop queued or active voices`);
  const afterCleanup = json(playedAudio(h));
  h.renderBattle(); h.flushFrames(); h.tick(1600);
  assert.equal(playedAudio(h).filter(sound => ['meow', 'found', 'combo', 'launch', 'impact'].includes(sound.kind)).length, 0, 'cleanup never replays the existing attack');
  assert.deepEqual(playedAudio(h), afterCleanup);
});

test('classic captures keep an event-keyed real-meow cue on top of the separate combo accent', () => {
  const h = harness({ fakeAudio: true }), game = h.begin(); h.renderLegacy(); h.audio.calls.length = 0;
  h.act(0, h.action('guess', { index: game.puzzle.solution[0] })); h.renderLegacy();
  const sounds = json(playedAudio(h));
  assert.equal(sounds.filter(sound => sound.kind === 'meow').length, 1);
  assert.ok(sounds.find(sound => sound.kind === 'meow').id, 'classic hit audio carries a deduplication identity');
  assert.equal(sounds.some(sound => ['found', 'combo'].includes(sound.kind)), false);
  h.renderLegacy(); h.renderLegacy(); assert.deepEqual(playedAudio(h), sounds);
  h.advance(300); h.act(0, h.action('guess', { index: game.puzzle.solution[1] })); h.renderLegacy();
  const all = playedAudio(h), voices = all.filter(sound => sound.kind === 'meow'), combos = all.filter(sound => sound.kind === 'combo');
  assert.equal(voices.length, 2); assert.equal(new Set(voices.map(sound => sound.id)).size, 2);
  assert.deepEqual(voices.map(sound => sound.combo), [1, 2]);
  assert.equal(combos.length, 1); assert.equal(combos[0].combo, 2);
  assert.equal(all.some(sound => sound.kind === 'found'), false);
});

test('the last classic cat still meows once and a terminal history snapshot stays silent', () => {
  const h = harness({ fakeAudio: true }), game = h.begin(); h.renderLegacy(); h.audio.calls.length = 0;
  for (const index of game.puzzle.solution) {
    h.act(0, h.action('guess', { index })); h.renderLegacy(); h.advance(300);
  }
  assert.equal(game.status, 'finished');
  const sounds = json(playedAudio(h)), meows = sounds.filter(sound => sound.kind === 'meow');
  assert.equal(meows.length, 6); assert.equal(new Set(meows.map(sound => sound.id)).size, 6);
  assert.equal(sounds.filter(sound => sound.kind === 'win').length, 1);
  h.renderLegacy(); h.renderLegacy(); assert.deepEqual(playedAudio(h), sounds);
  const joiner = harness({ fakeAudio: true }); joiner.state.role = 'guest'; joiner.state.you = 1;
  joiner.onMessage({ type: 'state', state: json(h.publicGame(game)) }); joiner.renderLegacy();
  assert.equal(playedAudio(joiner).some(sound => ['meow', 'combo', 'win', 'lose'].includes(sound.kind)), false);
});

test('classic joining and reconnecting synchronize old hit sounds without replaying them', () => {
  const host = harness(), authority = host.begin();
  const snapshot = () => json(host.publicGame(authority));
  host.act(0, host.action('guess', { index: authority.puzzle.solution[0] })); const old = snapshot();
  const guest = harness({ fakeAudio: true }); guest.state.role = 'guest'; guest.state.you = 1;
  const receive = value => { guest.onMessage({ type: 'state', state: json(value) }); guest.renderLegacy(); };
  receive(old); assert.deepEqual(playedAudio(guest), []);
  host.advance(300); host.act(0, host.action('guess', { index: authority.puzzle.solution[1] })); const live = snapshot();
  receive(live); const sounds = json(playedAudio(guest)); assert.ok(sounds.some(sound => ['meow', 'found', 'combo'].includes(sound.kind)));
  receive(live); receive(old); receive(live); assert.deepEqual(playedAudio(guest), sounds);
  guest.onClose(); guest.onOpen();
  host.advance(300); host.act(0, host.action('guess', { index: authority.puzzle.solution[2] })); receive(snapshot());
  assert.deepEqual(playedAudio(guest), sounds, 'reconnect does not play the latest historical hit');
  host.advance(300); host.act(0, host.action('guess', { index: authority.puzzle.solution[3] })); receive(snapshot());
  assert.ok(playedAudio(guest).length > sounds.length, 'new authoritative actions after reconnect can play');
});

test('shared battle countdown emits each beat once and does not repeat during rerenders', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true });
  const game = h.state.game = h.newGame(6); game.players[1].connected = true; h.context.CatBattle.start(game, h.now());
  h.renderBattle(); h.renderBattle();
  const countdowns = () => playedAudio(h).filter(sound => sound.kind === 'countdown');
  assert.equal(countdowns().length, 1);
  for (let beat = 2; beat <= 3; beat++) {
    h.advance(1000); h.updateBattleTimers(); h.renderBattle();
    assert.equal(countdowns().length, beat);
  }
  assert.equal(new Set(countdowns().map(sound => sound.id)).size, 3, 'each countdown beat has its own stable identity');
  h.advance(1000); h.updateBattleTimers(); h.renderBattle();
  assert.equal(game.status, 'playing'); assert.equal(countdowns().length, 3);
});

test('sixth battle cat queues one board-clear accent and rematch resets the audio match identity', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin(); h.renderBattle();
  const firstID = game.id, solutions = [...game.boards[0].puzzle.solution]; h.audio.calls.length = 0;
  for (const index of solutions) { h.act(0, battleAction(h, 0, { index })); h.renderBattle(); h.advance(300); }
  const voices = playedAudio(h).filter(sound => sound.kind === 'meow');
  assert.equal(voices.length, 6, 'every capture, including rollover, keeps its own cat voice');
  assert.equal(new Set(voices.map(sound => sound.id)).size, 6);
  assert.deepEqual(voices.map(sound => sound.combo), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(playedAudio(h).filter(sound => sound.kind === 'combo').map(sound => sound.combo), [2, 3, 4, 5, 6]);
  const clear = playedAudio(h).filter(sound => sound.kind === 'boardClear');
  assert.equal(clear.length, 1); assert.ok(clear[0].id.includes(game.lastEvent.id));
  h.renderBattle(); assert.equal(playedAudio(h).filter(sound => sound.kind === 'boardClear').length, 1);
  game.status = 'finished'; game.winner = 0; game.players[1].hp = 0; h.renderBattle();
  h.audio.calls.length = 0; h.rematchVote(0); h.rematchVote(1); h.renderBattle();
  assert.notEqual(h.state.game.id, firstID);
  assert.ok(h.audio.calls.some(call => call.method === 'resetMatch'), 'a rematch starts a fresh audio deduplication scope');
});

test('mute buttons and volume settings stay synchronized and survive reload without autoplay', () => {
  let constructions = 0;
  const AudioContext = class { constructor() { constructions++; throw new Error('test audio backend'); } };
  const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true, AudioContext, local: { p2pMuted: '1', catAudioVolume: '0.37' } });
  h.begin(); h.renderBattle();
  assert.equal(h.state.muted, true); assert.equal(constructions, 0);
  assert.equal(h.get('#mute').getAttribute('aria-pressed'), 'true'); assert.equal(h.get('#battleMute').getAttribute('aria-pressed'), 'true');
  assert.equal(Number(h.get('#soundVolume').value), 37); assert.match(h.get('#soundVolumeValue').textContent, /37/);
  h.get('#soundVolume').value = '62'; h.get('#soundVolume').dispatchEvent('input');
  assert.equal(Number(h.context.localStorage.catAudioVolume), 0.62);
  assert.equal(h.audio.getState().volume, 0.62); assert.equal(h.audio.getState().muted, true); assert.equal(constructions, 0);
  h.get('#battleMute').click();
  assert.equal(h.state.muted, false); assert.equal(h.context.localStorage.p2pMuted, '0');
  assert.equal(h.get('#mute').getAttribute('aria-pressed'), 'false'); assert.equal(h.get('#battleMute').getAttribute('aria-pressed'), 'false');
  h.get('#mute').click(); h.renderBattle();
  assert.equal(h.state.muted, true); assert.equal(h.context.localStorage.p2pMuted, '1');
  assert.equal(h.audio.getState().muted, true);
  const beforeReload = constructions;
  const restored = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true, AudioContext,
    local: { p2pMuted: h.context.localStorage.p2pMuted, catAudioVolume: h.context.localStorage.catAudioVolume } });
  restored.begin(); restored.renderBattle();
  assert.equal(restored.state.muted, true); assert.equal(Number(restored.get('#soundVolume').value), 62);
  assert.equal(constructions, beforeReload, 'restoring persisted sound settings never unlocks audio');
});

test('battle glow hooks are event-bound and cleared with their tracked effect timers', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.renderBattle();
  const index = game.boards[0].puzzle.solution[0]; h.act(0, battleAction(h, 0, { index })); h.renderBattle();
  const cell = h.get('.battle-side.local').querySelector('.battle-board').children[index];
  const badge = h.get('.battle-side.local').querySelector('.combo-badge');
  assert.equal(cell.classList.contains('found-glow'), true); assert.equal(badge.classList.contains('combo-glow'), true);
  const callout = h.get('.battle-side.local').querySelector('.capture-callout');
  assert.equal(badge.dataset.comboTier, '1'); assert.equal(callout.textContent, '抓到了！');
  assert.equal(callout.classList.contains('show'), true);
  for (const [node, className] of [[cell, 'found-glow'], [badge, 'combo-glow'], [callout, 'show']]) {
    assert.ok([...h.state.battleClassEffects].some(effect => effect.node === node && effect.className === className));
  }
  const timers = [...h.state.battleFXTimers]; h.observeBattleEvent(game.lastEvent);
  assert.deepEqual([...h.state.battleFXTimers], timers, 'reobserving an event cannot add glow timers');
  h.clearBattleFX();
  assert.equal(cell.classList.contains('found-glow'), false); assert.equal(badge.classList.contains('combo-glow'), false);
  assert.equal(callout.classList.contains('show'), false);
  assert.equal(h.state.battleClassEffects.size, 0); assert.equal(h.state.battleFXTimers.size, 0);
  assert.equal(timers.some(id => h.timers.has(id)), false);
});

test('capture callouts reuse one node and replace their timeout at each fresh combo', () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.renderBattle();
  const callout = h.get('.battle-side.local').querySelector('.capture-callout');
  const solutions = [...game.boards[0].puzzle.solution], labels = ['抓到了！', '2 連喵！', '3 連喵！', '喵喵連擊 ×4'];
  for (let index = 0; index < 4; index++) {
    h.act(0, battleAction(h, 0, { index: solutions[index] })); h.renderBattle();
    assert.strictEqual(h.get('.battle-side.local').querySelector('.capture-callout'), callout);
    assert.equal(callout.textContent, labels[index]); assert.equal(callout.classList.contains('show'), true);
    assert.equal([...h.state.battleClassEffects].filter(effect => effect.node === callout && effect.className === 'show').length, 1);
    if (index < 3) h.tick(300);
  }
  h.tick(749); assert.equal(callout.classList.contains('show'), true, 'an older capture cannot hide the newest callout');
  h.tick(1); assert.equal(callout.classList.contains('show'), false);
  h.renderBattle(); assert.equal(callout.classList.contains('show'), false, 'rendering the stored event does not restart its callout');
});

for (const reducedMotion of [false, true]) test(`HP value is immediate while its damage residue is presentation-only, reduced motion ${reducedMotion}`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.context.matchMedia = () => ({ matches: reducedMotion }); h.renderBattle();
  const hp = h.get('.battle-side.opponent').querySelector('.hp-meter'), fill = hp.querySelector('.hp-fill'), lag = hp.querySelector('.hp-lag');
  assert.equal(Number.parseFloat(fill.style.width), 100); assert.equal(Number.parseFloat(lag.style.width), 100);
  h.act(0, battleAction(h, 0)); h.renderBattle();
  const ratio = 145 / 150 * 100;
  assert.equal(game.players[1].hp, 145); assert.equal(hp.getAttribute('aria-valuenow'), '145');
  assert.equal(Number.parseFloat(fill.style.width), ratio);
  assert.equal(Number.parseFloat(lag.style.width), reducedMotion ? ratio : 100);
  assert.equal(h.frames.size > 0, !reducedMotion);
  h.flushFrames(); assert.equal(Number.parseFloat(lag.style.width), ratio);
  assert.equal(game.players[1].hp, 145, 'frame completion cannot apply damage again');
});

for (const interruption of ['pause', 'background']) test(`${interruption} before an HP residue frame cancels it and settles the bar at authoritative HP`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin(); h.renderBattle();
  h.act(0, battleAction(h, 0)); h.renderBattle();
  const hp = h.get('.battle-side.opponent').querySelector('.hp-meter'), lag = hp.querySelector('.hp-lag');
  assert.ok(h.frames.size > 0); assert.equal(Number.parseFloat(lag.style.width), 100);
  if (interruption === 'pause') { h.context.CatBattle.pause(game, h.now()); h.renderBattle(); }
  else {
    h.context.document.hidden = true; h.dispatchDocument('visibilitychange');
    assert.equal(h.frames.size, 0);
    h.context.document.hidden = false; h.dispatchDocument('visibilitychange');
  }
  assert.equal(h.frames.size, 0); assert.equal(h.state.battleFXFrames.size, 0);
  assert.equal(Number.parseFloat(lag.style.width), 145 / 150 * 100, 'cancelling the frame cannot strand a full HP residue');
  h.flushFrames(); assert.equal(game.players[1].hp, 145);
});

for (const reducedMotion of [false, true]) test(`board-clear celebration is bounded and cleaned up with reduced motion ${reducedMotion}`, () => {
  const h = harness({ mode: 'battle', battle: true, battleUI: true }), game = h.begin();
  h.context.matchMedia = () => ({ matches: reducedMotion }); h.renderBattle();
  for (const index of [...game.boards[0].puzzle.solution]) {
    h.act(0, battleAction(h, 0, { index })); h.renderBattle();
    assert.ok(h.state.battleClassEffects.size <= 6, '900 ms class effects stay bounded by the 300 ms hit cadence');
    assert.ok(h.state.battleFXBatches.length <= 3); h.tick(300);
  }
  const grid = h.get('.battle-side.local').querySelector('.battle-board');
  const card = h.get('.battle-side.local').querySelector('.board-card');
  assert.equal(grid.classList.contains('board-clear-glow'), true);
  assert.equal(card.children.filter(node => node.classList.contains('board-clear-celebration')).length, 1);
  assert.equal(game.players[1].hp, 45); assert.equal(game.boards[0].combo, 6);
  if (reducedMotion) assert.equal(h.context.document.body.children.some(node => /battle-(cat-launch|paw-shot|spark)/.test(node.className)), false);
  h.tick(1200);
  assert.equal(grid.classList.contains('board-clear-glow'), false);
  assert.equal(card.children.filter(node => node.classList.contains('board-clear-celebration')).length, 0);
  assert.equal(h.state.battleClassEffects.size, 0); assert.equal(h.state.battleFXTimers.size, 0); assert.equal(h.state.battleFXNodes.size, 0);
});

test('miss cooldown gives one timed unlock sound and pulse, while interrupted cooldowns remain silent', () => {
  for (const interrupted of [false, true]) {
    const h = harness({ mode: 'battle', battle: true, battleUI: true, fakeAudio: true }), game = h.begin(); h.renderBattle();
    const miss = game.boards[0].puzzle.regions.findIndex((_, index) => !game.boards[0].puzzle.solution.includes(index));
    h.audio.calls.length = 0; h.act(0, battleAction(h, 0, { index: miss })); h.renderBattle();
    assert.equal(playedAudio(h).filter(sound => sound.kind === 'miss').length, 1);
    assert.equal(playedAudio(h).filter(sound => sound.kind === 'lock').length, 1);
    if (interrupted) h.onClose();
    h.tick(1999); assert.equal(playedAudio(h).filter(sound => sound.kind === 'unlock').length, 0);
    h.tick(1);
    assert.equal(playedAudio(h).filter(sound => sound.kind === 'unlock').length, interrupted ? 0 : 1);
    const card = h.get('.battle-side.local').querySelector('.board-card');
    assert.equal(card.classList.contains('unlock-pulse'), !interrupted);
    h.updateBattleTimers(); h.updateBattleTimers();
    assert.equal(playedAudio(h).filter(sound => sound.kind === 'unlock').length, interrupted ? 0 : 1);
    h.tick(1100); assert.equal(card.classList.contains('unlock-pulse'), false); assert.equal(h.state.battleClassEffects.size, 0);
  }
});

for (const mode of ['battle', 'practice']) test(`${mode} a rapid third touch after sixth-cat rollover cannot mark the replacement board`, () => {
  const { h, game, board, grid } = gestureFixture(mode), cats = [...board.puzzle.solution], oldId = board.puzzle.id;
  for (const index of cats.slice(0, 5)) { h.act(0, battleAction(h, 0, { index })); h.tick(300); }
  const index = cats[5]; doubleClick(grid().children[index], { pointerType: 'touch' });
  assert.notEqual(game.boards[0].puzzle.id, oldId); assert.equal(game.boards[0].combo, 6);
  const next = grid().children[index], before = stablePublic(h), sent = sentActions(h);
  h.tick(50);
  next.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'touch', pointerId: 3 });
  next.dispatchEvent({ type: 'pointerup', button: 0, pointerType: 'touch', pointerId: 3 });
  next.dispatchEvent({ type: 'click', button: 0, detail: 1 });
  h.tick(GESTURE_WAIT);
  assert.equal(h.state.notes.has(index), false); assert.deepEqual(stablePublic(h), before); assert.equal(sentActions(h), sent);
  singleClick(h, grid().children[index]); assert.equal(h.state.notes.has(index), true, 'a later deliberate single remains available');
});
