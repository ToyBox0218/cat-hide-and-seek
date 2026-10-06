/* Shared single-mark / double-reveal recognition. No DOM, board state or transport. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatCellGestures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const DOUBLE_MS = 300, MAX_CELLS = 576;

  /**
   * Bind pointerdown -> press(index, {pointerType, timeStamp}), then click ->
   * activate(intent, {detail, timeStamp}). Use pointerType="keyboard" for keys.
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
   * Timers use now(). Comparable input timestamps measure event-to-event gaps;
   * absent or incompatible timestamps fall back to now(). A timed double needs
   * a second same-source, same-cell click or press before the single deadline.
   * A native mouse detail=2 also accepts its proven same-cell predecessor after
   * that deadline. The most recent mouse activation proves the native sequence;
   * detail=2 alone never authorizes a reveal. Separate cells keep independent
   * pending singles, with at most cellCount timers and retained single records.
   *
   * onMark may return an idempotent rollback function that restores the exact
   * prior private mark, or false when no mark was changed. This receipt is
   * required to promote a committed single to a double. Rollback runs only in
   * its original eligible context, before reveal, and may return false to
   * refuse restoration. Native dblclick needs no additional activation handler.
   * After a double, ignore same-cell clicks for another doubleMs and native
   * detail >= 3, preventing triple-click tails from creating stray marks.
   *
   * canAct is checked at press, click and dispatch. Optional canReveal is captured
   * at both presses and rechecked before reveal; onBlockedReveal reports a pair
   * that was consumed because either press or dispatch was blocked. onReveal
   * may independently refuse a guess (e.g. a turn/hit cooldown); that never falls back to a mark.
   * onMark/onReveal should also validate their board state before mutating it.
   */
  function create(options) {
    options = options || {};
    for (const name of ['getContext', 'canAct', 'onMark', 'onReveal']) {
      if (typeof options[name] !== 'function') throw new TypeError(`${name} must be a function`);
    }
    for (const name of ['canReveal', 'onBlockedReveal']) {
      if (options[name] !== undefined && typeof options[name] !== 'function') {
        throw new TypeError(`${name} must be a function`);
      }
    }
    const canReveal = options.canReveal || options.canAct;
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
    const pending = new Map(), singles = new Map(), presses = new WeakMap();
    let lastMouse = null;
    const cellVersions = Array(cellCount).fill(0), recentDoubles = Array(cellCount).fill(null);
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
      singles.clear();
      lastMouse = null;
      recentDoubles.fill(null);
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
    function timing(event) {
      const stamp = event && event.timeStamp;
      return {at:now(), stamp:Number.isFinite(stamp) && stamp >= 0 ? stamp : null};
    }
    function withinWindow(later, earlier) {
      if (!later || !earlier) return false;
      let elapsed = later.at - earlier.at;
      // Compare event timestamps only to each other, never to performance.now().
      // Negative deltas indicate unrelated timestamp epochs or invalid ordering.
      if (later.stamp !== null && earlier.stamp !== null &&
          (later.stamp >= 1e12) === (earlier.stamp >= 1e12) && later.stamp >= earlier.stamp) {
        elapsed = later.stamp - earlier.stamp;
      }
      return elapsed >= 0 && elapsed < doubleMs;
    }
    function press(index, event) {
      if (disposed || !validIndex(index)) return null;
      const current = syncContext();
      const token = Object.freeze({index});
      const pointerType = event && typeof event.pointerType === 'string' ? event.pointerType : 'unknown';
      presses.set(token, {index, context:current, generation, cellVersion:cellVersions[index],
        eligible:!!options.canAct(index, current), revealEligible:!!canReveal(index, current),
        pointerType, pressed:timing(event),
        predecessor:singles.get(index), nativePredecessor:lastMouse});
      return token;
    }
    function dispatchSingle(entry, inputProvesDeadline = false) {
      if (pending.get(entry.index) !== entry) return;
      if (!eligible(entry)) { removePending(entry); return; }
      const remaining = inputProvesDeadline ? 0 : entry.deadline - now();
      if (remaining > 0) {
        // An early timer must not shorten the promised double-click window.
        clearTimer(entry.timer);
        entry.timer = setTimer(() => dispatchSingle(entry), remaining);
        return;
      }
      removePending(entry);
      entry.committed = true;
      const receipt = options.onMark(entry.index, entry.context);
      entry.changed = receipt !== false;
      entry.rollback = typeof receipt === 'function' ? receipt : null;
    }
    function activate(token, event) {
      const record = token && presses.get(token);
      if (!record) return 'ignored';
      presses.delete(token);
      if (!eligible(record)) return 'ignored';
      const detail = event && Number.isFinite(event.detail) ? event.detail : 0;
      if (detail >= 3) return 'ignored';
      if (record.pointerType !== 'mouse') lastMouse = null;
      const index = record.index, clicked = timing(event), time = clicked.at;
      const lastDouble = recentDoubles[index];
      if (lastDouble && (withinWindow(clicked, lastDouble) || withinWindow(record.pressed, lastDouble))) {
        return 'ignored';
      }
      const previous = singles.get(index);
      const compatible = previous && !previous.consumed && eligible(previous) &&
        previous.pointerType === record.pointerType;
      const nativeDouble = compatible && record.pointerType === 'mouse' && detail === 2 &&
        previous.detail === 1 && previous === lastMouse && previous === record.nativePredecessor;
      const timedDouble = compatible && (withinWindow(clicked, previous.clicked) ||
        previous === record.predecessor && withinWindow(record.pressed, previous.clicked));
      if (nativeDouble || timedDouble) {
        // Claim this pair before invoking reversible application callbacks.
        previous.consumed = true;
        removePending(previous);
        recentDoubles[index] = clicked;
        if (record.pointerType === 'mouse') lastMouse = null;
        if (previous.committed && previous.changed) {
          if (!previous.rollback || previous.rollback() === false) return 'ignored';
          previous.rollback = null;
          if (!eligible(record)) return 'ignored';
        }
        const blockedAtPress = !previous.revealEligible || !record.revealEligible;
        const blockedNow = !canReveal(index, record.context);
        if (!eligible(record)) return 'ignored';
        if (blockedAtPress || blockedNow) {
          if (options.onBlockedReveal) options.onBlockedReveal(index, record.context, {blockedAtPress, blockedNow});
          return 'blocked';
        }
        options.onReveal(index, record.context);
        return 'double';
      }
      // An orphan continuation after cancellation, board replacement or a
      // consumed double must not start a fresh mark on the new current board.
      if (record.pointerType === 'mouse' && detail === 2 &&
          (!lastMouse || lastMouse.index === index)) return 'ignored';
      const overdue = pending.get(index);
      if (overdue) {
        // Queued events can be processed close together even though their
        // comparable source timestamps prove the full single interval elapsed.
        dispatchSingle(overdue, compatible && previous === overdue);
        if (!eligible(record)) return 'ignored';
        // An unrelated source must not silently overwrite an unexpired single.
        if (pending.get(index) === overdue) return 'ignored';
      }
      const entry = {index, context:record.context, generation:record.generation,
        cellVersion:record.cellVersion, eligible:record.eligible, revealEligible:record.revealEligible,
        pointerType:record.pointerType, clicked, detail, deadline:time + doubleMs, timer:null,
        committed:false, changed:false, rollback:null, consumed:false};
      pending.set(index, entry);
      singles.set(index, entry);
      if (record.pointerType === 'mouse') lastMouse = entry;
      entry.timer = setTimer(() => dispatchSingle(entry), doubleMs);
      return 'pending';
    }
    function cancelPress(token) { return !!token && presses.delete(token); }
    function cancelCell(index) {
      if (!validIndex(index)) return;
      cellVersions[index]++;
      const entry = pending.get(index);
      if (entry) removePending(entry);
      singles.delete(index);
      if (lastMouse && lastMouse.index === index) lastMouse = null;
      recentDoubles[index] = null;
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
