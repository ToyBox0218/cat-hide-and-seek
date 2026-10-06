/* Private ADD-only board strokes. No DOM, timers, reveal, audio or transport. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatBoardStrokes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const HOLD_MS = 250, MOVE_PX = 8, MAX_CELLS = 576;

  /**
   * Events: {id, type, button, primary, x, y, index, now}. Coordinates and now
   * use one consistent space/monotonic clock; omit now to use options.now().
   * button defaults to 0, primary defaults to true. An off-board index is null.
   * Feed all board-related pointers, including non-primary touches, so a second
   * pointer cancels marking and leaves native pinch/zoom to the DOM adapter.
   * Feed coalesced events in timestamp order when available.
   *
   * getContext returns a stable identity for board + eligibility generation.
   * canAct(context) is board-wide; canMark(index, context) filters opened cells.
   * onAdd MUST only add a private mark, never toggle/reveal/send. Recheck state
   * in that callback too. Existing marks can be skipped by canMark or idempotently
   * added by onAdd. indicesBetween(from, to, context) returns crossed indices;
   * endpoints are included automatically. Supply it for fast moves across cells.
   * Its points are immutable {x,y,index}. Every cell is visited at most once.
   *
   * onStart cancels pending tap/double recognition. onEnd receives
   * {id, type, context, reason, consumed, started, visitedCount}; consumed means
   * suppress the trailing click. A stationary hold or movement past movePx also
   * consumes its click, even when no stroke starts.
   * No timer starts a stroke: both hold time and movement are required on move.
   *
   * Call cancel(reason) on EACH transient lock/end/board invalidation, even if
   * it becomes valid again before another event. Held pointers stay quarantined
   * until released. sync() also detects current context/eligibility changes.
   * pointerCancel(event, reason) removes one canceled/lost-capture pointer.
   * reset(reason) forgets all pointers after blur/visibility changes, where the
   * eventual release may never arrive. Stale moves/up cannot resume a stroke.
   * state().consumed is sticky until the next fresh pointer sequence.
   */
  function create(options) {
    options = options || {};
    for (const name of ['getContext', 'canAct', 'canMark', 'onAdd']) {
      if (typeof options[name] !== 'function') throw new TypeError(`${name} must be a function`);
    }
    for (const name of ['indicesBetween', 'onStart', 'onEnd', 'now']) {
      if (options[name] !== undefined && typeof options[name] !== 'function') {
        throw new TypeError(`${name} must be a function`);
      }
    }
    const holdMs = options.holdMs === undefined ? HOLD_MS : options.holdMs;
    const movePx = options.movePx === undefined ? MOVE_PX : options.movePx;
    const cellCount = options.cellCount === undefined ? MAX_CELLS : options.cellCount;
    if (!Number.isFinite(holdMs) || holdMs <= 0) throw new RangeError('holdMs must be positive');
    if (!Number.isFinite(movePx) || movePx <= 0) throw new RangeError('movePx must be positive');
    if (!Number.isInteger(cellCount) || cellCount < 1 || cellCount > MAX_CELLS) {
      throw new RangeError(`cellCount must be between 1 and ${MAX_CELLS}`);
    }
    const now = options.now || (() => root.performance && typeof root.performance.now === 'function' ?
      root.performance.now() : Date.now());
    const pointers = new Set();
    let candidate = null, consumed = false, suspended = false, disposed = false, overflow = false;

    function validIndex(index) { return Number.isInteger(index) && index >= 0 && index < cellCount; }
    function validId(id) { return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)); }
    function timeOf(event) { return event && Number.isFinite(event.now) ? event.now : now(); }
    function pointOf(event) {
      return Object.freeze({x:event.x, y:event.y, index:validIndex(event.index) ? event.index : null});
    }
    function validPoint(event) { return event && Number.isFinite(event.x) && Number.isFinite(event.y); }
    function state() {
      return Object.freeze({active:!!candidate && candidate.started, tracking:!!candidate,
        consumed, suspended, pointerCount:pointers.size});
    }
    function finish(reason, eatClick) {
      const record = candidate;
      candidate = null;
      consumed = consumed || !!eatClick || !!(record && record.started);
      if (record && options.onEnd) options.onEnd(Object.freeze({id:record.id, type:record.type,
        context:record.context, reason, consumed, started:record.started, visitedCount:record.visited.size}));
    }
    function cancel(reason = 'cancel') {
      suspended = pointers.size > 0 || overflow;
      finish(reason, pointers.size > 0);
      return state();
    }
    function sync() {
      if (candidate && (!Object.is(candidate.context, options.getContext()) || !options.canAct(candidate.context))) {
        cancel('context');
      }
      return state();
    }
    function live(record) {
      sync();
      return !disposed && candidate === record && !suspended;
    }
    function release(id) {
      pointers.delete(id);
      if (!pointers.size && !overflow) suspended = false;
    }
    function down(event) {
      if (disposed || !event || !validId(event.id) || pointers.has(event.id)) return state();
      if (!pointers.size && !overflow) { consumed = false; suspended = false; }
      // Bound even malformed pointer streams. reset() recovers from overflow.
      if (pointers.size >= MAX_CELLS) { overflow = true; return cancel('pointer-overflow'); }
      pointers.add(event.id);
      if (pointers.size > 1 || suspended || overflow) return cancel('multiple-pointers');
      const context = options.getContext();
      if (!validPoint(event) || !validIndex(event.index) || event.primary === false ||
          (event.button !== undefined && event.button !== 0) || !options.canAct(context)) {
        return cancel('ineligible');
      }
      const point = pointOf(event), time = timeOf(event);
      if (!Number.isFinite(time)) return cancel('invalid-time');
      candidate = {id:event.id, type:event.type || 'mouse', context, origin:point, last:point,
        began:time, lastTime:time, distanceSquared:0, started:false, path:new Set([point.index]), visited:new Set()};
      return state();
    }
    function collect(record, next) {
      const indices = options.indicesBetween ? options.indicesBetween(record.last, next, record.context) : [];
      if (!live(record)) return;
      // The callback is expected to return at most one board's worth of indices.
      // A bounded scan also prevents a malformed/infinite iterator stalling input.
      if (indices && typeof indices[Symbol.iterator] === 'function') {
        let count = 0;
        for (const index of indices) {
          if (validIndex(index)) record.path.add(index);
          if (++count >= MAX_CELLS) break;
        }
      }
      if (validIndex(next.index)) record.path.add(next.index);
      record.last = next;
    }
    function addPath(record) {
      for (const index of record.path) {
        if (!live(record)) break;
        if (record.visited.has(index)) continue;
        record.visited.add(index);
        if (!options.canMark(index, record.context) || !live(record)) continue;
        options.onAdd(index, record.context);
      }
      record.path.clear();
    }
    function move(event) {
      if (disposed || !event) return state();
      // A mouse/pen may release outside the window without delivering pointerup.
      // Recover even a quarantined pointer when its next hover proves release.
      if (pointers.has(event.id) && event.type !== 'touch' &&
          event.buttons !== undefined && !(event.buttons & 1)) {
        cancel('released');
        release(event.id);
        return state();
      }
      if (!candidate || event.id !== candidate.id) return state();
      const record = candidate;
      if (!live(record)) return state();
      if (!validPoint(event)) return cancel('invalid-point');
      const time = timeOf(event);
      if (!Number.isFinite(time) || time < record.lastTime) return state();
      record.lastTime = time;
      const next = pointOf(event), dx = next.x - record.origin.x, dy = next.y - record.origin.y;
      record.distanceSquared = Math.max(record.distanceSquared, dx * dx + dy * dy);
      if (record.distanceSquared >= movePx * movePx) consumed = true;
      collect(record, next);
      if (!live(record)) return state();
      if (!record.started && time - record.began >= holdMs && record.distanceSquared >= movePx * movePx) {
        record.started = true;
        consumed = true;
        if (options.onStart) options.onStart(Object.freeze({id:record.id, type:record.type, context:record.context}));
      }
      if (record.started && live(record)) addPath(record);
      return state();
    }
    function up(event) {
      if (disposed || !event || !pointers.has(event.id)) return state();
      const record = candidate && candidate.id === event.id ? candidate : null;
      if (record && live(record)) {
        if (!validPoint(event)) finish('outside', true);
        else {
          const dx = event.x - record.origin.x, dy = event.y - record.origin.y;
          if (dx * dx + dy * dy >= movePx * movePx) consumed = true;
          // Only an existing stroke receives the final segment; up never starts one.
          // An outside endpoint can still cross eligible cells before leaving.
          if (record.started) { collect(record, pointOf(event)); if (live(record)) addPath(record); }
          const outside = !validIndex(event.index);
          if (candidate === record) finish(outside ? 'outside' : 'up', outside || timeOf(event) - record.began >= holdMs);
        }
      }
      release(event.id);
      return state();
    }
    function pointerCancel(event, reason = 'pointercancel') {
      if (!event || !pointers.has(event.id)) return state();
      cancel(reason);
      release(event.id);
      return state();
    }
    function reset(reason = 'blur') {
      cancel(reason);
      pointers.clear();
      overflow = false;
      suspended = false;
      return state();
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      reset('dispose');
    }
    return Object.freeze({down, move, up, pointerCancel, cancel, reset, sync, dispose, state});
  }

  return Object.freeze({create, constants:Object.freeze({HOLD_MS, MOVE_PX, MAX_CELLS})});
});
