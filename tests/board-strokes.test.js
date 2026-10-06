'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Strokes = require('../board-strokes.js');

function harness(options = {}) {
  let time = 0, context = 'board-1', allowed = true;
  const marks = new Set(options.marked || []), resolved = new Set(), adds = [], starts = [], ends = [];
  const controller = Strokes.create({
    now:() => time, getContext:() => context, canAct:() => allowed,
    canMark:index => !resolved.has(index),
    onAdd:(index, key) => { adds.push([index, key]); marks.add(index); },
    onStart:record => starts.push(record), onEnd:record => ends.push(record),
    ...options
  });
  const event = (index = 0, overrides = {}) => ({id:1, type:'mouse', button:0, primary:true,
    x:index * 10, y:0, index, now:time, ...overrides});
  return {controller, marks, resolved, adds, starts, ends, event,
    time:value => { time = value; }, context:value => { context = value; }, allow:value => { allowed = value; },
    down:(index = 0, extras) => controller.down(event(index, extras)),
    move:(index = 1, extras) => controller.move(event(index, extras)),
    up:(index = 1, extras) => controller.up(event(index, extras)),
    start:() => { controller.down(event(0)); time += 250; return controller.move(event(1)); }};
}

test('UMD exports without DOM, timers, audio, transport or a performance object', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../board-strokes.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.CatBoardStrokes.create, 'function');
  assert.equal(sandbox.CatBoardStrokes.constants.HOLD_MS, 250);
  assert.equal(sandbox.CatBoardStrokes.constants.MOVE_PX, 8);
  assert.equal(sandbox.CatBoardStrokes.constants.MAX_CELLS, 576);
});

test('hold and movement are both necessary, with exact threshold boundaries', () => {
  const h = harness();
  h.down(); h.time(249); h.move(1, {x:8});
  assert.equal(h.controller.state().active, false);
  assert.deepEqual(h.adds, []);
  h.time(250); h.move(1, {x:8});
  assert.equal(h.controller.state().active, true);
  assert.deepEqual(h.adds, [[0, 'board-1'], [1, 'board-1']]);
  assert.equal(h.starts.length, 1);
  const stationary = harness();
  stationary.down(); stationary.time(1000); stationary.move(0, {x:7.9});
  assert.equal(stationary.controller.state().active, false);
  assert.deepEqual(stationary.adds, []);
});

test('a short ordinary click stays available to the tap/double adapter', () => {
  const h = harness();
  h.down(); h.time(100); h.up(0);
  assert.equal(h.ends[0].consumed, false);
  assert.equal(h.controller.state().consumed, false);
  assert.deepEqual(h.adds, []);
});

test('a drag before the hold threshold consumes its click without marking', () => {
  const h = harness();
  h.down(); h.time(50); h.move(1, {x:8});
  assert.equal(h.controller.state().consumed, true);
  assert.equal(h.controller.state().active, false);
  h.move(0); h.time(100); h.up(0);
  assert.equal(h.ends[0].consumed, true);
  assert.deepEqual(h.adds, []);
  h.down();
  assert.equal(h.controller.state().consumed, false);
  h.time(150); h.up(0);
  assert.equal(h.ends[1].consumed, false);
});

test('displacement first observed at early release consumes the click without marking', () => {
  const h = harness();
  h.down(); h.time(50); h.up(2);
  assert.equal(h.ends[0].consumed, true);
  assert.equal(h.ends[0].started, false);
  assert.deepEqual(h.adds, []);
});

test('a stationary long hold consumes release without marking or revealing', () => {
  const h = harness({onReveal:() => assert.fail('strokes must never reveal')});
  h.down(); h.time(1000); h.up(0);
  assert.deepEqual(h.adds, []);
  assert.equal(h.starts.length, 0);
  assert.equal(h.ends[0].started, false);
  assert.equal(h.ends[0].consumed, true);
  assert.equal(h.controller.state().consumed, true);
});

test('pointerup never activates an unstarted stroke even after hold plus displacement', () => {
  const h = harness();
  h.down(); h.time(500); h.up(4);
  assert.deepEqual(h.adds, []);
  assert.equal(h.ends[0].started, false);
  assert.equal(h.ends[0].consumed, true);
});

test('a stroke adds each traversed cell once and never removes existing marks', () => {
  const h = harness({marked:[0, 2]});
  h.start(); h.move(2); h.move(0); h.move(2); h.move(3); h.up(3);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1, 2, 3]);
  assert.deepEqual([...h.marks].sort(), [0, 1, 2, 3]);
  assert.equal(h.ends[0].started, true);
  assert.equal(h.ends[0].consumed, true);
  assert.equal(h.controller.state().active, false);
  assert.equal(h.controller.state().pointerCount, 0);
});

test('resolved cells are filtered individually without canceling the stroke', () => {
  const h = harness();
  h.resolved.add(0); h.resolved.add(2);
  h.start(); h.move(2); h.move(3); h.up(3);
  assert.deepEqual(h.adds.map(entry => entry[0]), [1, 3]);
  assert.equal(h.starts.length, 1);
});

test('segment interpolation covers fast moves, early bent paths and final release segment', () => {
  const calls = [];
  const h = harness({indicesBetween:(from, to, context) => {
    calls.push([from.index, to.index, context]);
    const direction = Math.sign(to.index - from.index), result = [];
    if (direction) for (let i = from.index; i !== to.index; i += direction) result.push(i);
    return result;
  }});
  h.down(0); h.time(100); h.move(3); h.time(250); h.move(5); h.up(8);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(calls, [[0, 3, 'board-1'], [3, 5, 'board-1'], [5, 8, 'board-1']]);
});

test('onStart cancels competing gestures before the first mark is added', () => {
  const order = [];
  const h = harness({onStart:() => order.push('start'), onAdd:index => order.push(index)});
  h.start(); h.move(2);
  assert.deepEqual(order, ['start', 0, 1, 2]);
});

for (const invalidation of ['lock', 'end', 'board']) {
  test(`${invalidation} cancels current stroke and never resumes when the held pointer becomes eligible`, () => {
    const h = harness();
    h.start();
    if (invalidation === 'lock') h.allow(false); else h.context(invalidation);
    h.move(2);
    assert.equal(h.controller.state().active, false);
    assert.equal(h.ends[0].reason, 'context');
    h.allow(true); h.context('board-1'); h.move(3); h.up(3);
    assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
    h.time(1000); h.start();
    assert.equal(h.starts.length, 2);
  });
}

test('a press that begins blocked cannot start after unlock', () => {
  const h = harness();
  h.allow(false); h.down(); h.allow(true); h.time(1000); h.move(2); h.up(2);
  assert.deepEqual(h.adds, []);
  h.start();
  assert.equal(h.starts.length, 1);
});

test('explicit transient invalidation quarantines a held, unstarted press', () => {
  const h = harness();
  h.down(); h.controller.cancel('lock'); h.time(1000); h.move(2); h.up(2);
  assert.deepEqual(h.adds, []);
  assert.equal(h.ends[0].reason, 'lock');
  assert.equal(h.ends[0].consumed, true);
  h.start();
  assert.equal(h.starts.length, 1);
});

test('sync detects invalidation without requiring another pointer movement', () => {
  const h = harness();
  h.start(); h.context('new-board');
  assert.equal(h.controller.sync().active, false);
  assert.equal(h.ends.length, 1);
  h.controller.sync();
  assert.equal(h.ends.length, 1);
});

for (const reason of ['pointercancel', 'lostpointercapture']) {
  test(`${reason} consumes the click and cannot restart from stale moves`, () => {
    const h = harness();
    h.start(); h.controller.pointerCancel(h.event(1), reason); h.move(2); h.up(2);
    assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
    assert.equal(h.ends[0].reason, reason);
    assert.equal(h.controller.state().pointerCount, 0);
    assert.equal(h.controller.state().consumed, true);
  });
}

test('an active stroke released outside adds the final clipped in-board segment before ending', () => {
  const segments = [];
  const h = harness({indicesBetween:(from, to) => {
    segments.push([from.index, to.index]);
    return to.index === null ? [2, 3, 4, 5] : [0, 1];
  }});
  h.start(); h.up(null, {x:200});
  assert.deepEqual(segments, [[0, 1], [1, null]]);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1, 2, 3, 4, 5]);
  assert.equal(h.ends[0].reason, 'outside');
  assert.equal(h.ends[0].consumed, true);
  assert.equal(h.controller.state().active, false);
  assert.equal(h.controller.state().pointerCount, 0);
});

test('an outside release never starts a stroke and invalid coordinates never trace', () => {
  const h = harness({indicesBetween:() => assert.fail('unstarted release must not trace')});
  h.down(); h.time(1000); h.up(null, {x:200});
  assert.deepEqual(h.adds, []);
  assert.equal(h.ends[0].started, false);
  assert.equal(h.ends[0].consumed, true);
  const other = harness({indicesBetween:(_from, to) => {
    assert.ok(Number.isFinite(to.x));
    return [0, 1];
  }});
  other.start(); other.up(null, {x:NaN});
  assert.deepEqual(other.adds.map(entry => entry[0]), [0, 1]);
  assert.equal(other.ends[0].reason, 'outside');
});

test('an off-board move can return through a caller-clipped segment', () => {
  const h = harness({indicesBetween:(from, to) => to.index === null ? [2, 3] : [to.index]});
  h.start(); h.move(null, {x:200}); h.move(4); h.up(4);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1, 2, 3, 4]);
});

test('blur forgets pointers so missed releases cannot wedge future input', () => {
  const h = harness();
  h.start(); h.controller.reset('blur'); h.move(2); h.up(2);
  assert.equal(h.controller.state().pointerCount, 0);
  assert.equal(h.controller.state().consumed, true);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
  h.start();
  assert.equal(h.starts.length, 2);
});

test('a second touch cancels and suspends all marking until every pointer releases', () => {
  const h = harness();
  h.down(0, {type:'touch'}); h.time(250); h.move(1, {type:'touch'});
  h.down(2, {id:2, type:'touch', primary:false});
  assert.equal(h.ends[0].reason, 'multiple-pointers');
  assert.equal(h.controller.state().suspended, true);
  h.move(3, {type:'touch'}); h.up(2, {id:2, type:'touch'});
  h.time(1000); h.move(4, {type:'touch'});
  assert.equal(h.controller.state().suspended, true);
  h.down(5, {id:3, type:'touch', primary:false}); h.up(4, {type:'touch'});
  h.controller.pointerCancel(h.event(5, {id:3, type:'touch'}));
  assert.equal(h.controller.state().suspended, false);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
  h.start();
  assert.equal(h.starts.length, 2);
});

test('two touches before hold never mark, even if the primary touch remains down', () => {
  const h = harness();
  h.down(0, {type:'touch'}); h.down(1, {id:2, type:'touch', primary:false});
  h.up(1, {id:2, type:'touch'}); h.time(1000); h.move(2, {type:'touch'}); h.up(2, {type:'touch'});
  assert.deepEqual(h.adds, []);
  assert.equal(h.ends[0].consumed, true);
});

test('callback context changes stop the remaining segment immediately', () => {
  let h;
  h = harness({indicesBetween:() => [0, 1, 2, 3], onAdd:index => {
    h.adds.push(index); h.context('replacement');
  }});
  h.start();
  assert.deepEqual(h.adds, [0]);
  assert.equal(h.controller.state().active, false);
});

test('a lock inside canMark or onStart prevents any stale marking', () => {
  let h;
  h = harness({canMark:() => { h.allow(false); return true; }});
  h.start();
  assert.deepEqual(h.adds, []);
  const other = harness({onStart:() => other.controller.cancel('start-invalidated')});
  other.start();
  assert.deepEqual(other.adds, []);
  assert.equal(other.ends[0].consumed, true);
});

test('context replacement by the segment callback is checked before dispatch', () => {
  let h;
  h = harness({indicesBetween:() => { h.context('replacement'); return [0, 1]; }});
  h.start();
  assert.deepEqual(h.adds, []);
  assert.equal(h.starts.length, 0);
});

test('marks can be added again in a fresh stroke without ever toggling them off', () => {
  const h = harness();
  h.start(); h.up(); h.time(500); h.start(); h.up();
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1, 0, 1]);
  assert.deepEqual([...h.marks], [0, 1]);
  assert.equal(h.starts.length, 2);
});

test('mouse, touch and pen share the same hold-and-drag behavior', () => {
  for (const type of ['mouse', 'touch', 'pen']) {
    const h = harness();
    h.down(0, {type}); h.time(250); h.move(1, {type}); h.up(1, {type});
    assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
    assert.equal(h.ends[0].type, type);
  }
});

test('right button, secondary-only, missing position and invalid cell starts do not mark', () => {
  for (const extras of [{button:2}, {primary:false}, {x:NaN}, {index:-1}, {index:576}, {index:'2'}]) {
    const h = harness();
    h.down(0, extras); h.time(1000); h.move(2); h.up(2);
    assert.deepEqual(h.adds, []);
  }
});

test('missing button during mouse movement cancels the held stroke', () => {
  const h = harness();
  h.start(); h.move(2, {buttons:0}); h.move(3); h.up(3);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
  assert.equal(h.ends[0].reason, 'released');
  assert.equal(h.controller.state().pointerCount, 0);
  assert.equal(h.controller.state().suspended, false);
});

test('a missed mouse release is recovered by hover so the first fresh click works', () => {
  const h = harness();
  h.down(); h.time(50); h.move(2, {buttons:1});
  h.time(100); h.move(3, {buttons:0});
  assert.deepEqual(h.adds, []);
  assert.equal(h.ends[0].reason, 'released');
  assert.equal(h.ends[0].consumed, true);
  assert.equal(h.controller.state().consumed, true);
  assert.equal(h.controller.state().pointerCount, 0);
  assert.equal(h.controller.state().suspended, false);
  h.down(3);
  assert.equal(h.controller.state().tracking, true);
  assert.equal(h.controller.state().consumed, false);
  h.time(150); h.up(3);
  assert.equal(h.ends[1].consumed, false);
});

test('hover recovers a canceled mouse pointer while touch buttons zero stays held', () => {
  const h = harness();
  h.down(); h.controller.cancel('lock'); h.move(2, {buttons:0}); h.down();
  assert.equal(h.controller.state().tracking, true);
  const touch = harness();
  touch.down(0, {type:'touch'}); touch.move(0, {type:'touch', buttons:0});
  assert.equal(touch.controller.state().tracking, true);
  assert.equal(touch.controller.state().pointerCount, 1);
});

test('out-of-order coalesced samples do not move the path backwards', () => {
  const h = harness();
  h.start(); h.move(9, {now:100}); h.move(2, {now:260}); h.up(2, {now:270});
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1, 2]);
});

test('full board, duplicate and invalid path data remain bounded to 576 visited cells', () => {
  const h = harness({indicesBetween:() => Array.from({length:10000}, (_, index) => index)});
  h.start(); h.move(500); h.move(575); h.up(575);
  assert.equal(h.adds.length, 576);
  assert.equal(h.marks.size, 576);
  assert.equal(h.ends[0].visitedCount, 576);
  const small = harness({cellCount:36, indicesBetween:() => [0, -1, 36, NaN, null, 1, 1, 2]});
  small.start(); small.up(2);
  assert.deepEqual(small.adds.map(entry => entry[0]), [0, 1, 2]);
});

test('an infinite segment iterator is bounded and does not hang input', () => {
  const h = harness({indicesBetween:function* () { while (true) yield 0; }});
  h.start(); h.up();
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
});

test('malformed pointer floods are bounded and recover with an explicit reset', () => {
  const h = harness();
  for (let id = 0; id < 10000; id++) h.down(0, {id});
  assert.equal(h.controller.state().pointerCount, 576);
  assert.equal(h.controller.state().suspended, true);
  h.controller.reset(); h.start();
  assert.equal(h.starts.length, 1);
});

test('dispose cancels once and prevents fresh or stale input', () => {
  const h = harness();
  h.start(); h.controller.dispose(); h.controller.dispose(); h.move(2); h.up(2); h.start();
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0].reason, 'dispose');
  assert.equal(h.controller.state().pointerCount, 0);
});

test('invalid setup and unknown pointer events are safely rejected', () => {
  assert.throws(() => Strokes.create({}), /getContext/);
  assert.throws(() => harness({holdMs:0}), /holdMs/);
  assert.throws(() => harness({movePx:0}), /movePx/);
  assert.throws(() => harness({cellCount:577}), /cellCount/);
  assert.throws(() => harness({indicesBetween:4}), /indicesBetween/);
  const h = harness();
  h.controller.down(null); h.controller.move(null); h.controller.up(null); h.controller.pointerCancel(null);
  h.down(0, {id:NaN}); h.start(); h.move(2, {id:2}); h.up(2, {id:2});
  assert.equal(h.controller.state().active, true);
  assert.deepEqual(h.adds.map(entry => entry[0]), [0, 1]);
});
