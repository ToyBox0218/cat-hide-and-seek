/* Shared single-mark / double-reveal recognition. No DOM, board state or transport. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatCellGestures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const DOUBLE_MS = 300, MAX_CELLS = 576;

  /**
   * Bind pointerdown -> press(index), click -> activate(intent, {detail}).
   * Pointer Events cover mouse, pen and touch: do not also activate on touchend,
   * pointerup or dblclick. A press token is single-use, including ignored presses.
   * Capture keyboard intent at non-repeating Enter/Space keydown, then use the
   * generated click (detail=0). An assistive click with no preceding physical
   * press may create its own fresh intent at click time in the DOM adapter.
   *
   * getContext must return a stable primitive or object identity covering the
   * board and action eligibility generation. cancel() must be called on any
   * intervening invalidation that could otherwise become valid again, such as
   * disconnect/reconnect or background/foreground. A press that began blocked
   * remains blocked even if the board unlocks before its click arrives.
   *
   * All timing uses now(), never DOM event.timeStamp (whose epoch varies).
   * A double requires two same-cell clicks strictly less than doubleMs apart.
   * At the deadline the single wins even if its timer has not run yet. Separate
   * cells keep independent pending singles, with at most cellCount timers.
   * After a double, ignore same-cell clicks for another doubleMs and native
   * detail >= 3, preventing triple-click tails from creating stray marks.
   *
   * canAct is checked at press, click and dispatch. onReveal may independently
   * refuse a guess (e.g. a turn/hit cooldown); that never falls back to a mark.
   * onMark/onReveal should also validate their board state before mutating it.
   */
  function create(options) {
    options = options || {};
    for (const name of ['getContext', 'canAct', 'onMark', 'onReveal']) {
      if (typeof options[name] !== 'function') throw new TypeError(`${name} must be a function`);
    }
    const doubleMs = options.doubleMs === undefined ? DOUBLE_MS : options.doubleMs;
    const cellCount = options.cellCount === undefined ? MAX_CELLS : options.cellCount;
    if (!Number.isFinite(doubleMs) || doubleMs <= 0) throw new RangeError('doubleMs must be positive');
    if (!Number.isInteger(cellCount) || cellCount < 1 || cellCount > MAX_CELLS) {
      throw new RangeError(`cellCount must be between 1 and ${MAX_CELLS}`);
    }
    const now = options.now || (() => root.performance && typeof root.performance.now === 'function' ?
      root.performance.now() : Date.now());
    const setTimer = options.setTimer || ((callback, delay) => root.setTimeout(callback, delay));
    const clearTimer = options.clearTimer || (timer => root.clearTimeout(timer));
    const pending = new Map(), presses = new WeakMap();
    const cellVersions = Array(cellCount).fill(0), doubleUntil = Array(cellCount).fill(-Infinity);
    let generation = 0, context, hasContext = false, disposed = false;

    function validIndex(index) { return Number.isInteger(index) && index >= 0 && index < cellCount; }
    function removePending(entry) {
      if (pending.get(entry.index) !== entry) return;
      pending.delete(entry.index);
      clearTimer(entry.timer);
    }
    function cancel() {
      generation++;
      for (const entry of pending.values()) clearTimer(entry.timer);
      pending.clear();
      doubleUntil.fill(-Infinity);
    }
    function syncContext() {
      const next = options.getContext();
      if (hasContext && !Object.is(context, next)) cancel();
      context = next;
      hasContext = true;
      return context;
    }
    function eligible(record) {
      if (disposed) return false;
      const current = syncContext();
      return record.eligible && record.generation === generation &&
        record.cellVersion === cellVersions[record.index] && Object.is(record.context, current) &&
        !!options.canAct(record.index, current);
    }
    function press(index) {
      if (disposed || !validIndex(index)) return null;
      const current = syncContext();
      const token = Object.freeze({index});
      presses.set(token, {index, context:current, generation, cellVersion:cellVersions[index],
        eligible:!!options.canAct(index, current)});
      return token;
    }
    function dispatchSingle(entry) {
      if (pending.get(entry.index) !== entry) return;
      if (!eligible(entry)) { removePending(entry); return; }
      const remaining = entry.deadline - now();
      if (remaining > 0) {
        // An early timer must not shorten the promised double-click window.
        clearTimer(entry.timer);
        entry.timer = setTimer(() => dispatchSingle(entry), remaining);
        return;
      }
      removePending(entry);
      options.onMark(entry.index, entry.context);
    }
    function activate(token, event) {
      const record = token && presses.get(token);
      if (!record) return 'ignored';
      presses.delete(token);
      if (!eligible(record)) return 'ignored';
      if (event && Number.isFinite(event.detail) && event.detail >= 3) return 'ignored';
      const index = record.index, time = now();
      if (time < doubleUntil[index]) return 'ignored';
      const previous = pending.get(index);
      if (previous) {
        if (time < previous.deadline && eligible(previous)) {
          removePending(previous);
          doubleUntil[index] = time + doubleMs;
          options.onReveal(index, record.context);
          return 'double';
        }
        // Process an overdue single before starting another, independently of
        // whether the browser happened to run the timeout or click task first.
        dispatchSingle(previous);
        if (!eligible(record)) return 'ignored';
      }
      const entry = {...record, deadline:time + doubleMs, timer:null};
      pending.set(index, entry);
      entry.timer = setTimer(() => dispatchSingle(entry), doubleMs);
      return 'pending';
    }
    function cancelPress(token) { return !!token && presses.delete(token); }
    function cancelCell(index) {
      if (!validIndex(index)) return;
      cellVersions[index]++;
      const entry = pending.get(index);
      if (entry) removePending(entry);
      doubleUntil[index] = -Infinity;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      if (options.signal) options.signal.removeEventListener('abort', dispose);
    }
    if (options.signal) {
      if (options.signal.aborted) dispose();
      else options.signal.addEventListener('abort', dispose, {once:true});
    }
    return Object.freeze({press, activate, cancelPress, cancelCell, cancel, dispose,
      pendingCount:() => pending.size});
  }

  return Object.freeze({create, constants:Object.freeze({DOUBLE_MS, MAX_CELLS})});
});
