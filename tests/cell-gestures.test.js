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
      const before = marks.has(index);
      if (before) marks.delete(index); else marks.add(index);
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        if (before) marks.add(index); else marks.delete(index);
        actions.push(['restore', index, key]);
        return true;
      };
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
    click:(index, detail = 1, pointerType = 'unknown', timeStamp) =>
      controller.activate(controller.press(index, {pointerType, timeStamp}), {detail, timeStamp})};
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
  test(`without native mouse proof, exact-deadline clicks stay separate regardless of task order (timer first: ${runTimerFirst})`, () => {
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


for (const gap of [300, 380, 800]) for (const timerFirst of [false, true]) for (const marked of [false, true]) {
  test(`native mouse double at ${gap} ms restores the exact first-mark state (timer first=${timerFirst}, marked=${marked})`, () => {
    const h = harness({marked:marked ? [2] : []});
    h.click(2, 1, 'mouse');
    if (timerFirst) h.tick(gap); else h.jump(gap);
    assert.equal(h.click(2, 2, 'mouse'), 'double');
    h.tick(1000);
    assert.equal(h.actions.filter(action => action[0] === 'reveal').length, 1);
    assert.equal(h.actions.filter(action => action[0] === 'mark').length, timerFirst ? 1 : 0);
    assert.equal(h.actions.filter(action => action[0] === 'restore').length, timerFirst ? 1 : 0);
    assert.equal(h.marks.has(2), marked);
    assert.equal(h.timers.size, 0);
  });
}

for (const pointerType of ['touch', 'keyboard', 'mouse']) {
  test(`${pointerType} second press begun inside the window remains paired across a late release`, () => {
    const h = harness();
    h.click(2, 1, pointerType, 20);
    h.tick(240);
    const held = h.controller.press(2, {pointerType, timeStamp:260});
    h.tick(160);
    assert.deepEqual(h.actions, [['mark', 2, 'board-1']]);
    assert.equal(h.controller.activate(held, {detail:pointerType === 'mouse' ? 2 : 1, timeStamp:420}), 'double');
    h.tick(1000);
    assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'restore', 'reveal']);
    assert.equal(h.marks.has(2), false);
  });
}

for (const pointerType of ['touch', 'keyboard', 'unknown', 'mouse']) {
  test(`${pointerType} detail=1 at exactly 300 ms starts a separate single`, () => {
    const h = harness();
    h.click(2, 1, pointerType); h.tick(300);
    assert.equal(h.click(2, 1, pointerType), 'pending');
    h.tick(300);
    assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'mark']);
    assert.equal(h.marks.size, 0);
  });
}

for (const pointerType of ['touch', 'keyboard', 'unknown', 'pen']) {
  test(`${pointerType} detail=2 has no mouse-native deadline override`, () => {
    const h = harness();
    h.click(2, 1, pointerType); h.tick(380);
    assert.equal(h.click(2, 2, pointerType), 'pending');
    h.tick(300);
    assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'mark']);
  });
}

test('mouse detail=2 with no predecessor cannot reveal or queue a mark', () => {
  const h = harness();
  assert.equal(h.click(2, 2, 'mouse'), 'ignored');
  h.tick(1000);
  assert.deepEqual(h.actions, []);
});

test('native mouse recognition cannot borrow a different-cell predecessor', () => {
  const h = harness();
  h.click(2, 1, 'mouse'); h.tick(380);
  assert.equal(h.click(3, 2, 'mouse'), 'pending');
  h.tick(300);
  assert.deepEqual(h.actions.map(action => action.slice(0, 2)), [['mark', 2], ['mark', 3]]);
});

test('an intervening mouse cell prevents promoting an older committed same-cell single', () => {
  const h = harness();
  h.click(2, 1, 'mouse'); h.tick(380);
  h.click(3, 1, 'mouse'); h.tick(20);
  h.click(2, 2, 'mouse'); h.tick(300);
  assert.equal(h.actions.some(action => action[0] === 'reveal'), false);
  assert.equal(h.actions.some(action => action[0] === 'restore'), false);
});

for (const invalidate of ['cancel', 'cancelCell', 'context', 'dispose']) {
  test(`${invalidate} discards a committed single's native proof and rollback receipt`, () => {
    const h = harness();
    h.click(2, 1, 'mouse'); h.tick(320);
    const held = h.controller.press(2, {pointerType:'mouse'});
    if (invalidate === 'context') h.context('board-2');
    else h.controller[invalidate](2);
    assert.equal(h.controller.activate(held, {detail:2}), 'ignored');
    assert.equal(h.click(2, 2, 'mouse'), 'ignored');
    h.tick(1000);
    assert.deepEqual(h.actions, [['mark', 2, 'board-1']]);
    assert.equal(h.marks.has(2), true);
  });
}

test('canceling the held second press preserves the first single without revealing', () => {
  const h = harness();
  h.click(2, 1, 'touch'); h.tick(240);
  const held = h.controller.press(2, {pointerType:'touch'});
  h.controller.cancelPress(held); h.tick(160);
  assert.equal(h.controller.activate(held, {detail:1}), 'ignored');
  assert.deepEqual(h.actions, [['mark', 2, 'board-1']]);
});

test('queued touch timestamps preserve a physical quick pair after the single timer has fired', () => {
  const h = harness();
  h.click(2, 1, 'touch', 100);
  h.tick(500);
  const held = h.controller.press(2, {pointerType:'touch', timeStamp:200});
  h.tick(50);
  assert.equal(h.controller.activate(held, {detail:1, timeStamp:220}), 'double');
  assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'restore', 'reveal']);
  assert.equal(h.marks.size, 0);
});

for (const [first, second] of [[1700000000000, 100], [100, 1700000000000], [100, -1]]) {
  test(`incompatible event timestamp epochs fall back to controller time (${first}, ${second})`, () => {
    const h = harness();
    h.click(2, 1, 'touch', first); h.tick(100);
    assert.equal(h.click(2, 1, 'touch', second), 'double');
    assert.deepEqual(h.actions.map(action => action[0]), ['reveal']);
  });
}

test('a late native double whose reveal callback declines leaves the exact pre-click mark', () => {
  let reveals = 0;
  const h = harness({marked:[2], onReveal:() => { reveals++; return false; }});
  h.click(2, 1, 'mouse'); h.tick(380); h.click(2, 2, 'mouse'); h.tick(1000);
  assert.equal(reveals, 1);
  assert.equal(h.marks.has(2), true);
  assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'restore']);
});

test('a refused or unavailable rollback never promotes a committed single', () => {
  for (const receipt of [undefined, true, () => false]) {
    let reveals = 0, marks = 0;
    const h = harness({onMark:() => { marks++; return receipt; }, onReveal:() => { reveals++; }});
    h.click(2, 1, 'mouse'); h.tick(380);
    assert.equal(h.click(2, 2, 'mouse'), 'ignored');
    h.tick(1000);
    assert.equal(marks, 1); assert.equal(reveals, 0);
  }
});

test('a single callback reporting no mutation needs no undo before native promotion', () => {
  let reveals = 0;
  const h = harness({onMark:() => false, onReveal:() => { reveals++; }});
  h.click(2, 1, 'mouse'); h.tick(380);
  assert.equal(h.click(2, 2, 'mouse'), 'double');
  assert.equal(reveals, 1);
});

test('rollback that changes the board invalidates reveal dispatch', () => {
  let h;
  h = harness({onMark:() => () => { h.context('new-board'); return true; }});
  h.click(2, 1, 'mouse'); h.tick(380);
  assert.equal(h.click(2, 2, 'mouse'), 'ignored');
  assert.deepEqual(h.actions, []);
  assert.equal(h.controller.pendingCount(), 0);
});

for (const blockedPress of ['first', 'second', 'dispatch']) {
  test(`reveal eligibility blocked at ${blockedPress} consumes the pair without a delayed reveal or extra mark`, () => {
    let revealAllowed = blockedPress !== 'first';
    const blocked = [], h = harness({canReveal:() => revealAllowed,
      onBlockedReveal:(index, context, reason) => blocked.push({index, context, reason})});
    h.click(2, 1, 'mouse'); h.tick(320);
    revealAllowed = blockedPress !== 'second';
    const held = h.controller.press(2, {pointerType:'mouse'});
    revealAllowed = blockedPress !== 'dispatch';
    assert.equal(h.controller.activate(held, {detail:2}), 'blocked');
    revealAllowed = true; h.tick(1000);
    assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'restore']);
    assert.equal(h.marks.size, 0);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason.blockedAtPress, blockedPress !== 'dispatch');
    assert.equal(blocked[0].reason.blockedNow, blockedPress === 'dispatch');
  });
}

test('single marking remains available while reveal eligibility alone is blocked', () => {
  const h = harness({canReveal:() => false});
  h.click(2, 1, 'touch'); h.tick(300);
  assert.deepEqual(h.actions.map(action => action[0]), ['mark']);
});

test('native pair, duplicate token, native dblclick replay and slow triple tail reveal only once', () => {
  const h = harness();
  h.click(2, 1, 'mouse'); h.tick(380);
  const second = h.controller.press(2, {pointerType:'mouse'});
  assert.equal(h.controller.activate(second, {detail:2}), 'double');
  assert.equal(h.controller.activate(second, {detail:2}), 'ignored');
  assert.equal(h.controller.activate(second, {detail:2}), 'ignored');
  h.tick(400);
  assert.equal(h.click(2, 3, 'mouse'), 'ignored');
  assert.equal(h.click(2, 2, 'mouse'), 'ignored');
  h.tick(1000);
  assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'restore', 'reveal']);
});


test('compressed dispatch of physically slow touch taps commits two singles rather than losing the second', () => {
  const h = harness();
  h.click(2, 1, 'touch', 100);
  h.tick(100);
  assert.equal(h.click(2, 1, 'touch', 500), 'pending');
  assert.deepEqual(h.actions.map(action => action[0]), ['mark']);
  h.tick(300);
  assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'mark']);
  assert.equal(h.marks.size, 0);
});

test('changing input source cannot promote a mouse sequence through an intervening touch', () => {
  const h = harness();
  h.click(2, 1, 'mouse'); h.tick(380);
  h.click(3, 1, 'touch'); h.tick(20);
  assert.equal(h.click(2, 2, 'mouse'), 'ignored');
  h.tick(300);
  assert.deepEqual(h.actions.map(action => action.slice(0, 2)), [['mark', 2], ['mark', 3]]);
});

test('an exact-deadline second press cannot extend touch recognition even with a later release', () => {
  const h = harness();
  h.click(2, 1, 'touch', 100); h.tick(300);
  const held = h.controller.press(2, {pointerType:'touch', timeStamp:400});
  h.tick(100);
  assert.equal(h.controller.activate(held, {detail:1, timeStamp:500}), 'pending');
  h.tick(300);
  assert.deepEqual(h.actions.map(action => action[0]), ['mark', 'mark']);
});

test('invalid optional reveal hooks are rejected when the controller is created', () => {
  assert.throws(() => harness({canReveal:true}), /canReveal/);
  assert.throws(() => harness({onBlockedReveal:true}), /onBlockedReveal/);
});


test('a touch triple tail begun during suppression cannot become a mark after a held release', () => {
  const h = harness();
  h.click(2, 1, 'touch', 100); h.tick(100); h.click(2, 1, 'touch', 200);
  h.tick(100);
  const held = h.controller.press(2, {pointerType:'touch', timeStamp:300});
  h.tick(400);
  assert.equal(h.controller.activate(held, {detail:1, timeStamp:700}), 'ignored');
  h.tick(1000);
  assert.deepEqual(h.actions.map(action => action[0]), ['reveal']);
});

test('queued touch input physically after suppression remains a fresh single', () => {
  const h = harness();
  h.click(2, 1, 'touch', 100); h.tick(100); h.click(2, 1, 'touch', 200);
  h.tick(100);
  assert.equal(h.click(2, 1, 'touch', 600), 'pending');
  h.tick(300);
  assert.deepEqual(h.actions.map(action => action[0]), ['reveal', 'mark']);
});
