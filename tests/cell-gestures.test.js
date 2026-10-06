'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Gestures = require('../cell-gestures.js');

function harness(options = {}) {
  let time = 0, nextTimer = 0, context = 'board-1', allowed = true;
  const timers = new Map(), marks = new Set(options.marked || []), actions = [];
  const now = () => time;
  const setTimer = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, {at:time + delay, callback});
    return id;
  };
  const clearTimer = id => timers.delete(id);
  const controller = Gestures.create({
    getContext:() => context, canAct:() => allowed,
    onMark:(index, key) => {
      actions.push(['mark', index, key]);
      if (marks.has(index)) marks.delete(index); else marks.add(index);
    },
    onReveal:(index, key) => actions.push(['reveal', index, key]),
    now, setTimer, clearTimer, ...options
  });
  function tick(ms) {
    const target = time + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      time = timer.at;
      timers.delete(id);
      timer.callback();
    }
    time = target;
  }
  return {controller, actions, marks, timers, tick,
    jump:ms => { time += ms; },
    context:value => { context = value; },
    allow:value => { allowed = value; },
    click:(index, detail = 1) => controller.activate(controller.press(index), {detail})};
}

test('UMD loads without a DOM and exports the same public API', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../cell-gestures.js'), 'utf8'), context);
  assert.equal(typeof context.CatCellGestures.create, 'function');
  assert.equal(context.CatCellGestures.constants.DOUBLE_MS, 300);
  assert.equal(context.CatCellGestures.constants.MAX_CELLS, 576);
});

test('single click waits the full window then toggles the private mark once', () => {
  const h = harness();
  assert.equal(h.click(4), 'pending');
  assert.equal(h.controller.pendingCount(), 1);
  h.tick(299);
  assert.deepEqual(h.actions, []);
  h.tick(1);
  assert.deepEqual(h.actions, [['mark', 4, 'board-1']]);
  assert.deepEqual([...h.marks], [4]);
  assert.equal(h.controller.pendingCount(), 0);
  h.tick(1000);
  assert.equal(h.actions.length, 1);
  h.click(4); h.tick(300);
  assert.equal(h.marks.has(4), false);
});

for (const initiallyMarked of [false, true]) {
  test(`double click reveals once with no intermediate toggle (${initiallyMarked ? 'marked' : 'unmarked'} cell)`, () => {
    const h = harness({marked:initiallyMarked ? [4] : []});
    h.click(4); h.tick(100);
    assert.equal(h.click(4, 2), 'double');
    assert.deepEqual(h.actions, [['reveal', 4, 'board-1']]);
    assert.equal(h.marks.has(4), initiallyMarked);
    assert.equal(h.controller.pendingCount(), 0);
    assert.equal(h.timers.size, 0);
    h.tick(1000);
    assert.equal(h.actions.length, 1);
  });
}

test('a reveal adapter that declines the guess never falls back to a mark', () => {
  let declined = 0;
  const h = harness({onReveal:() => { declined++; return false; }});
  h.click(2); h.tick(90); h.click(2, 2); h.tick(1000);
  assert.equal(declined, 1);
  assert.deepEqual(h.actions, []);
  assert.equal(h.marks.size, 0);
});

test('different cells never combine into a double, including native detail=2', () => {
  const h = harness();
  h.click(2); h.tick(80); h.click(3, 2);
  h.tick(220);
  assert.deepEqual(h.actions, [['mark', 2, 'board-1']]);
  h.tick(80);
  assert.deepEqual(h.actions, [['mark', 2, 'board-1'], ['mark', 3, 'board-1']]);
});

test('interleaved cells keep independent pending singles and double candidates', () => {
  const h = harness();
  h.click(2); h.tick(80); h.click(3); h.tick(80); h.click(2, 1); h.tick(300);
  assert.deepEqual(h.actions, [['reveal', 2, 'board-1'], ['mark', 3, 'board-1']]);
});

test('the last millisecond inside the window is a double', () => {
  const h = harness();
  h.click(2); h.tick(299);
  assert.equal(h.click(2, 2), 'double');
  h.tick(300);
  assert.deepEqual(h.actions, [['reveal', 2, 'board-1']]);
});

for (const runTimerFirst of [false, true]) {
  test(`at the exact deadline, two singles win regardless of task order (timer first: ${runTimerFirst})`, () => {
    const h = harness();
    h.click(2);
    if (runTimerFirst) h.tick(300); else h.jump(300);
    assert.equal(h.click(2, 2), 'pending');
    assert.deepEqual(h.actions, [['mark', 2, 'board-1']]);
    h.tick(300);
    assert.deepEqual(h.actions, [['mark', 2, 'board-1'], ['mark', 2, 'board-1']]);
    assert.equal(h.marks.size, 0);
  });
}

test('a throttled late timer preserves separate singles', () => {
  const h = harness();
  h.click(2); h.jump(1200); h.click(2, 2);
  assert.deepEqual(h.actions, [['mark', 2, 'board-1']]);
  h.tick(300);
  assert.equal(h.actions.length, 2);
});

test('an early timer is rescheduled rather than shrinking the double window', () => {
  const h = harness();
  h.click(2); h.jump(100);
  [...h.timers.values()][0].callback();
  assert.equal(h.timers.size, 1);
  assert.deepEqual(h.actions, []);
  h.tick(199); h.click(2, 2); h.tick(500);
  assert.deepEqual(h.actions, [['reveal', 2, 'board-1']]);
});

for (const detail of [0, 1, 3]) {
  test(`triple-click tail produces no mark even with detail=${detail}`, () => {
    const h = harness();
    h.click(2); h.tick(70); h.click(2, 2); h.tick(70);
    assert.equal(h.click(2, detail), 'ignored');
    h.tick(1000);
    assert.deepEqual(h.actions, [['reveal', 2, 'board-1']]);
    h.click(2); h.tick(300);
    assert.equal(h.actions[1][0], 'mark');
  });
}

test('cancel discards pending clicks and all held presses but permits fresh interaction', () => {
  const h = harness();
  h.click(2);
  const held = h.controller.press(3);
  h.controller.cancel();
  assert.equal(h.timers.size, 0);
  assert.equal(h.controller.activate(held, {detail:1}), 'ignored');
  h.tick(1000);
  assert.deepEqual(h.actions, []);
  h.click(3); h.tick(300);
  assert.deepEqual(h.actions, [['mark', 3, 'board-1']]);
});

test('cancelPress rejects a canceled pointer/keyboard press without canceling other clicks', () => {
  const h = harness();
  h.click(2);
  const canceled = h.controller.press(3);
  assert.equal(h.controller.cancelPress(canceled), true);
  assert.equal(h.controller.cancelPress(canceled), false);
  assert.equal(h.controller.activate(canceled, {detail:1}), 'ignored');
  h.tick(300);
  assert.deepEqual(h.actions, [['mark', 2, 'board-1']]);
});

test('cancelCell invalidates that cell only, including its unconsumed presses', () => {
  const h = harness();
  h.click(2); h.click(3);
  const first = h.controller.press(2), second = h.controller.press(3);
  h.controller.cancelCell(2);
  assert.equal(h.controller.pendingCount(), 1);
  assert.equal(h.controller.activate(first, {detail:1}), 'ignored');
  assert.equal(h.controller.activate(second, {detail:1}), 'double');
  h.tick(300);
  assert.deepEqual(h.actions, [['reveal', 3, 'board-1']]);
  h.click(2); h.tick(300);
  assert.equal(h.actions[1][1], 2);
});

test('board or phase context change invalidates pending singles and stale held presses', () => {
  const h = harness();
  h.click(2);
  const held = h.controller.press(3);
  h.context('board-2');
  assert.equal(h.controller.activate(held, {detail:1}), 'ignored');
  assert.equal(h.timers.size, 0);
  h.tick(1000);
  assert.deepEqual(h.actions, []);
  h.click(2); h.tick(300);
  assert.deepEqual(h.actions, [['mark', 2, 'board-2']]);
});

test('a context change is also detected by timer dispatch without another input', () => {
  const h = harness();
  h.click(2); h.click(3); h.context('ended'); h.tick(300);
  assert.deepEqual(h.actions, []);
  assert.equal(h.timers.size, 0);
});

test('a press that began during a lock stays invalid after unlock', () => {
  const h = harness();
  h.allow(false);
  const held = h.controller.press(2);
  h.allow(true);
  assert.equal(h.controller.activate(held, {detail:1}), 'ignored');
  h.tick(300);
  assert.deepEqual(h.actions, []);
  h.click(2); h.tick(300);
  assert.equal(h.actions.length, 1);
});

test('eligibility is rechecked on click and delayed single dispatch', () => {
  const h = harness();
  const held = h.controller.press(2);
  h.allow(false);
  assert.equal(h.controller.activate(held), 'ignored');
  h.allow(true); h.click(3); h.allow(false); h.tick(300);
  assert.deepEqual(h.actions, []);
});

test('double callback is gated again rather than acting after a newly locked cell', () => {
  const h = harness();
  h.click(2);
  const second = h.controller.press(2);
  h.allow(false);
  assert.equal(h.controller.activate(second, {detail:2}), 'ignored');
  h.tick(300);
  assert.deepEqual(h.actions, []);
});

test('a reentrant single callback that replaces the board invalidates the later overdue click', () => {
  let h;
  h = harness({onMark:() => h.context('new-board')});
  h.click(2); h.jump(300);
  assert.equal(h.click(2), 'ignored');
  assert.equal(h.controller.pendingCount(), 0);
});

test('single-use tokens prevent touch compatibility replay and extra dblclick activation', () => {
  const h = harness();
  const touch = h.controller.press(2);
  assert.equal(h.controller.activate(touch, {detail:1}), 'pending');
  assert.equal(h.controller.activate(touch, {detail:1}), 'ignored');
  h.tick(100);
  const nextTouch = h.controller.press(2);
  assert.equal(h.controller.activate(nextTouch, {detail:1}), 'double');
  assert.equal(h.controller.activate(nextTouch, {detail:2}), 'ignored');
  h.tick(1000);
  assert.deepEqual(h.actions, [['reveal', 2, 'board-1']]);
});

test('keyboard/assistive click detail=0 uses the same single and double semantics', () => {
  const h = harness();
  h.click(2, 0); h.tick(300);
  assert.deepEqual([...h.marks], [2]);
  h.click(2, 0); h.tick(100); h.click(2, 0); h.tick(300);
  assert.deepEqual(h.actions, [['mark', 2, 'board-1'], ['reveal', 2, 'board-1']]);
  assert.equal(h.marks.has(2), true);
});

test('DOM event timestamp epochs do not affect recognition', () => {
  const h = harness();
  h.controller.activate(h.controller.press(2), {detail:1, timeStamp:Date.now()});
  h.tick(100);
  h.controller.activate(h.controller.press(2), {detail:2, timeStamp:-100000});
  assert.deepEqual(h.actions, [['reveal', 2, 'board-1']]);
});

test('a full 24x24 board and large invalid-input burst have bounded pending work', () => {
  const h = harness();
  for (let index = 0; index < 10000; index++) h.click(index);
  assert.equal(h.controller.pendingCount(), 576);
  assert.equal(h.timers.size, 576);
  for (let index = 0; index < 10000; index++) h.click(index);
  assert.equal(h.controller.pendingCount(), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.actions.length, 576);
  for (let index = 0; index < 10000; index++) h.click(index);
  h.tick(1000);
  assert.equal(h.actions.length, 576);
});

test('an aborted controller cannot act and releases its timers', () => {
  const abort = new AbortController(), h = harness({signal:abort.signal});
  h.click(2);
  const held = h.controller.press(3);
  abort.abort();
  assert.equal(h.timers.size, 0);
  assert.equal(h.controller.activate(held), 'ignored');
  assert.equal(h.controller.press(2), null);
  h.tick(1000);
  assert.deepEqual(h.actions, []);
});

test('already aborted and disposed controllers reject new and stale presses', () => {
  const abort = new AbortController(); abort.abort();
  const h = harness({signal:abort.signal});
  assert.equal(h.click(2), 'ignored');
  h.controller.dispose(); h.controller.dispose();
  const other = harness(), held = other.controller.press(2);
  other.controller.dispose(); other.controller.cancel();
  assert.equal(other.controller.activate(held), 'ignored');
  assert.equal(other.click(2), 'ignored');
  assert.equal(h.timers.size + other.timers.size, 0);
});

test('invalid indices, foreign tokens and malformed setup are rejected safely', () => {
  const h = harness({cellCount:36}), other = harness();
  for (const index of [-1, 36, 576, 1.5, NaN, Infinity, '2', null]) {
    assert.equal(h.controller.press(index), null);
    h.controller.cancelCell(index);
  }
  for (const token of [null, undefined, {}, other.controller.press(2)]) {
    assert.equal(h.controller.activate(token), 'ignored');
  }
  assert.throws(() => Gestures.create({}), /getContext/);
  assert.throws(() => harness({doubleMs:0}), /doubleMs/);
  assert.throws(() => harness({cellCount:577}), /cellCount/);
});
