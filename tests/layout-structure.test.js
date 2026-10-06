'use strict';

// Source-level layout contracts only. This intentionally does not launch a
// browser, compute geometry, or claim visual acceptance at these widths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

function splitSelectors(input) {
  const selectors = []; let depth = 0, start = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '(' || input[i] === '[') depth++;
    if (input[i] === ')' || input[i] === ']') depth--;
    if (input[i] === ',' && depth === 0) { selectors.push(input.slice(start, i).trim()); start = i + 1; }
  }
  selectors.push(input.slice(start).trim());
  return selectors;
}

// Parse balanced rule blocks while ignoring quoted strings and CSS comments.
// Keeping media conditions lets each contract exercise the requested breakpoints.
function parseRules(source, media = [], rules = []) {
  let i = 0;
  while (i < source.length) {
    while (/\s/.test(source[i] || '') && i < source.length) i++;
    if (i >= source.length) break;
    const open = source.indexOf('{', i);
    assert.notEqual(open, -1, 'every rule has an opening brace');
    const header = source.slice(i, open).trim();
    let depth = 1, quote = null, end = open + 1;
    for (; end < source.length && depth; end++) {
      const c = source[end];
      if (quote) { if (c === '\\') end++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    assert.equal(depth, 0, `balanced braces for ${header.slice(0, 70)}`);
    const body = source.slice(open + 1, end - 1);
    if (header.startsWith('@media')) parseRules(body, [...media, header], rules);
    else if (!header.startsWith('@')) {
      const declarations = body.split(';').map(raw => {
        const colon = raw.indexOf(':');
        if (colon < 0) return null;
        const value = raw.slice(colon + 1).trim();
        return { property: raw.slice(0, colon).trim(), value: value.replace(/\s*!important\s*$/, ''), important: /!important\s*$/.test(value) };
      }).filter(Boolean);
      rules.push({ selectors: splitSelectors(header), declarations, media });
    }
    i = end;
  }
  return rules;
}
const rules = parseRules(css.replace(/\/\*[\s\S]*?\*\//g, ''));

function mediaMatches(conditions, width, height, reducedMotion) {
  return conditions.every(condition => {
    for (const [, kind, axis, value] of condition.matchAll(/(min|max)-(width|height)\s*:\s*(\d+)px/g)) {
      const actual = axis === 'width' ? width : height;
      if (kind === 'min' ? actual < +value : actual > +value) return false;
    }
    if (/orientation:\s*landscape/.test(condition) && width <= height) return false;
    if (/prefers-reduced-motion:\s*reduce/.test(condition) && !reducedMotion) return false;
    return true;
  });
}

function style(selectors, width = 1280, height = 900, reducedMotion = false) {
  const result = {}, priority = {};
  for (const rule of rules) {
    if (!mediaMatches(rule.media, width, height, reducedMotion)) continue;
    const matches = rule.selectors.filter(selector => selectors.includes(selector));
    if (!matches.length) continue;
    // These fixtures enumerate exact matching selectors rather than emulating
    // the DOM. The selected contracts use simple ID/class/type specificity.
    const specificity = Math.max(...matches.map(selector =>
      (selector.match(/#[\w-]+/g) || []).length * 100 +
      (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length * 10));
    for (const declaration of rule.declarations) {
      const rank = specificity + (declaration.important ? 10000 : 0);
      if (rank < (priority[declaration.property] ?? -1)) continue;
      result[declaration.property] = declaration.value;
      priority[declaration.property] = rank;
    }
  }
  return result;
}

// Height is part of every fixture. These tests inspect authored contracts and
// arithmetic budgets, not real font metrics, DOM rectangles, or rendered fit.
const viewports = [
  [320, 720], [360, 800], [390, 844], [430, 932], [768, 900],
  [1280, 720], [1366, 768], [1920, 1080]
];

for (const [width, height] of viewports) {
  test(`shared-board cards keep names, intel and 24-cat baskets in flow at ${width}x${height} (structural)`, () => {
    const card = style(['.player-card', '#game > .arena > .player-card'], width, height);
    assert.equal(card.height, 'auto');
    assert.equal(card['min-height'], '0');
    assert.equal(card.overflow, 'visible');
    assert.equal(card['grid-auto-rows'], 'max-content');
    const name = style(['.player-name', '#game .player-card > .player-name'], width, height);
    assert.equal(name['white-space'], 'normal');
    assert.equal(name['overflow-wrap'], 'anywhere');
    assert.equal(name.overflow, 'visible');
    const basket = style(['.basket', '#game .player-card > .basket'], width, height);
    assert.equal(basket.display, 'flex');
    assert.equal(basket['flex-wrap'], 'wrap');
    assert.equal(basket.height, 'auto');
    assert.equal(basket.position, 'relative');
    assert.equal(basket['max-width'], 'none');
    assert.equal(basket['max-height'], undefined, '24 cats cannot be cut off by a height limit');
    const intel = style(['.intel-list', '#game .player-card > .intel-list'], width, height);
    assert.equal(intel.display, 'block');
    assert.equal(intel['overflow-wrap'], 'anywhere');
    assert.equal(intel['font-size'], '14px');
    if (width >= 1051) {
      assert.equal(card['grid-template-columns'], '64px minmax(0, 1fr)');
      assert.equal(basket['grid-row'], '5');
      assert.equal(intel['grid-row'], '6', 'intel has its own row after the complete basket');
      assert.equal(name['grid-column'], '2');
    }
  });

  test(`battle secondary actions have no empty backing at ${width}x${height} (structural)`, () => {
    const arena = style(['#battleArena'], width, height);
    assert.equal(arena['min-height'], '0');
    const header = style(['.battle-header', '#battleArena .battle-header'], width, height);
    assert.equal(header.position, width <= 700 ? 'sticky' : 'relative');
    assert.ok(/^max\((12|16|20)px, env\(safe-area-inset-bottom\)\)$/.test(arena['padding-bottom']));
    const toolbar = style(['.battle-toolbar', '#battleArena .battle-toolbar'], width, height);
    assert.equal(toolbar.position, 'static');
    assert.equal(toolbar.transform, 'none');
    assert.equal(toolbar.height, 'auto');
    assert.equal(toolbar['min-height'], '0');
    assert.equal(toolbar['flex-wrap'], 'wrap');
    assert.equal(toolbar['border-radius'], '14px');
    const emptyToolbar = style(['.battle-toolbar', '#battleArena .battle-toolbar', '#battleArena .battle-toolbar:not(:has(> button:not(.hidden)))'], width, height);
    assert.equal(emptyToolbar.display, 'none');
    const instructions = style(['.battle-instructions', '#battleArena .battle-instructions'], width, height);
    assert.equal(instructions['font-size'], '14px');
    const button = style(['.battle-toolbar button', '.battle-toolbar > button', '#battleArena .battle-toolbar > button'], width, height);
    assert.equal(button['min-height'], '44px');
    assert.equal(button['font-size'], '14px');
  });

  test(`primary marking control is readable beside or above own board at ${width}x${height} (structural)`, () => {
    const controls = style(['#battleArena .primary-controls'], width, height);
    assert.equal(controls.display, 'grid');
    assert.equal(controls['min-width'], '0');
    assert.equal(controls['grid-template-columns'], 'minmax(0, 1fr)');
    const button = style(['#battleNote', '#battleArena .primary-controls #battleNote'], width, height);
    assert.equal(button['font-size'], '16px');
    assert.equal(button['min-height'], width >= 1100 ? '52px' : '48px');
    assert.equal(button.width, '100%');
    assert.equal(button['white-space'], 'normal');
    const status = style(['#battleNoteStatus', '#battleArena #battleNoteStatus', '#battleArena .primary-controls #battleNoteStatus'], width, height);
    assert.equal(status['font-size'], '14px');
    assert.equal(status['overflow-wrap'], 'anywhere');
    assert.equal(status.order, '0');
    const slot = style(['#battleArena .primary-controls-slot', '#battleArena .local .primary-controls-slot'], width, height);
    assert.equal(slot['grid-column'], width >= 1100 ? '2' : undefined);
    assert.equal(slot.position, undefined, 'primary controls do not float over the board');
  });

  test(`centered miss overlay covers the board and reserves no strip at ${width}x${height} (structural)`, () => {
    const stage = style(['#battleArena .battle-board-stage'], width, height);
    assert.equal(stage.position, 'relative');
    assert.equal(stage['aspect-ratio'], '1');
    assert.equal(stage.isolation, 'isolate');
    const lock = style(['#battleArena .battle-lock', '#battleArena .battle-board-stage > .battle-lock'], width, height);
    assert.equal(lock.position, 'absolute');
    assert.equal(lock.inset, '0');
    assert.equal(lock.width, '100%');
    assert.equal(lock.height, '100%');
    assert.equal(lock['align-content'], 'center');
    assert.equal(lock['justify-items'], 'center');
    assert.equal(lock['pointer-events'], 'auto');
    assert.equal(lock['touch-action'], 'none');
    assert.equal(lock['z-index'], '20');
    assert.equal(lock.transform, 'none');
    const hidden = style(['.hidden', '#battleArena .battle-board-stage > .battle-lock', '#battleArena .battle-board-stage > .battle-lock.hidden'], width, height);
    assert.equal(hidden.display, 'none');
    if (width <= 700) {
      assert.equal(stage.width, '100%', 'small screens keep the full-width local board');
      const sides = style(['.battle-layout', '#battleArena .battle-layout'], width, height);
      assert.equal(sides['grid-template-columns'], 'minmax(0, 1fr)');
      const opponent = style(['.opponent .board-card'], width, height);
      assert.equal(opponent['grid-column'], '2');
    }
  });
}

for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080]]) {
  test(`desktop ${width}x${height} has an explicit height and width budget (arithmetic, not browser proof)`, () => {
    const arena = style(['#battleArena'], width, height);
    assert.equal(arena['--battle-board-size'], 'clamp(288px, calc(100dvh - 376px), 560px)');
    const stage = style(['#battleArena .battle-board-stage'], width, height);
    assert.equal(stage.width, 'min(100%, var(--battle-board-size))');
    const board = Math.max(288, Math.min(height - 376, 560));
    const arenaWidth = Math.min(1460, width - 48);
    const columnsWidth = arenaWidth - 48 - 2 * 16;
    const ownAvailable = columnsWidth * 1.3 / 2.3 - 24 - 12 - 160;
    const opponentAvailable = columnsWidth / 2.3 - 24;
    assert.ok(board <= ownAvailable && board <= opponentAvailable, 'the requested square fits both column budgets');
    const chromeBudget = 20 + 92 + 32 + 64 + 12 + 52 + 44 + 39;
    assert.ok(board + chromeBudget <= height, 'ordinary text/content budget leaves headroom instead of clipping the page');
    assert.ok((board - 15) / 6 >= 50, 'six-by-six cells retain approximately 50px or more');
    const header = style(['.battle-header', '#battleArena .battle-header'], width, height);
    assert.equal(header['flex-direction'], 'row');
    const card = style(['.board-card', '#battleArena .board-card', '#battleArena .local .board-card'], width, height);
    assert.equal(card['grid-template-columns'], 'minmax(0, 1fr) 160px');
    const legacyBoard = style(['#boardWrap', '#game #boardWrap'], width, height);
    assert.equal(legacyBoard['max-height'], 'calc(100dvh - 340px)');
    assert.equal(legacyBoard.overflow, 'auto', 'explicit board zoom can scroll its board, without cropping controls');
    const title = style(['#battleArena .battle-brand h1'], width, height);
    assert.equal(title['font-size'], '32px');
    const emergency = style(['#battleArena', '#battleArena:has(.battle-toolbar > button:not(.hidden))'], width, height);
    assert.equal(emergency['--battle-board-size'], 'clamp(272px, calc(100dvh - 440px), 560px)');
    const pausedBoard = Math.max(272, Math.min(height - 440, 560));
    assert.ok(pausedBoard + chromeBudget + 64 <= height, 'visible reconnect/abort actions have a separate 64px budget');
    const toolbox = style(['.toolbox', '#game .toolbox'], width, height);
    assert.equal(toolbox['grid-column'], '2');
    assert.equal(toolbox['grid-row'], '2');
    assert.equal(toolbox['flex-direction'], 'column', 'optional item actions grow alongside the board, not underneath it');
    const legacyOuter = style(['#board', '#game #board'], width, height);
    assert.equal(legacyOuter.width, 'calc(var(--n) * var(--s) + 8px)');
    assert.equal(legacyOuter.height, 'calc(var(--n) * var(--s) + 8px)');
  });
}

for (const width of [320, 360, 390, 430]) {
  test(`mobile ${width}px preserves full-width local cells and a scrollable document (arithmetic, not browser proof)`, () => {
    const arena = style(['#battleArena'], width, 844);
    assert.equal(arena.width, 'calc(100% - 20px)');
    const card = style(['.board-card', '#battleArena .local .board-card'], width, 844);
    assert.equal(card['padding-inline'], '8px');
    // 20px arena gutters + 16px card padding + 4px card border.
    // The board then owns 4px padding + 4px border + five 1px gaps.
    const square = width - 20 - 16 - 4;
    assert.ok((square - 13) / 6 >= 44, 'ordinary local cells preserve roughly 44px touch targets');
    assert.equal(arena['max-height'], undefined, 'phone content is allowed to scroll normally');
  });
}

test('retired cooldown strip, automatic marking, absolute basket and fixed-footer reservation are absent', () => {
  assert.doesNotMatch(css, /battle-lock-slot|notes-available|data-temporary/);
  assert.doesNotMatch(css, /\.player-card:{1,2}after\s*\{/);
  for (const rule of rules) {
    if (rule.selectors.includes('.battle-toolbar'))
      assert.ok(!rule.declarations.some(d => d.property === 'position' && d.value === 'fixed'));
    if (rule.selectors.includes('#battleArena'))
      assert.ok(!rule.declarations.some(d => d.property === 'padding-bottom' && /(?:91|145)px/.test(d.value)));
  }
});

test('primary controls are mounted beside the local grid and help stays in the visible header', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'battle-ui.js'), 'utf8');
  assert.match(html, /id="battlePrimaryControls" class="primary-controls"><button id="battleNote"[\s\S]*?id="battleNoteStatus"/);
  assert.match(html, /<header class="battle-header">[\s\S]*?id="battleHelp"[\s\S]*?<\/header>/);
  const toolbar = html.match(/<div class="battle-toolbar">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(toolbar, /id="battleReconnect"/);
  assert.doesNotMatch(toolbar, /battleNote|battleHelp/);
  assert.match(ui, /class="primary-controls-slot"/);
  assert.match(ui, /class="battle-board-stage"><div class="battle-lock hidden"/);
  assert.match(ui, /slot\.appendChild\(battlePrimaryControls\)/);
  assert.doesNotMatch(ui, /battle-lock-slot/);
});

test('readable hierarchy stays scoped to interface text and lock arrival respects reduced motion', () => {
  assert.equal(style([':root'])['--text-body'], '16px');
  assert.equal(style([':root'])['--text-support'], '14px');
  assert.equal(style([':root'])['--text-heading'], '24px');
  assert.equal(style(['.brand h1'], 320)['font-size'], '28px');
  assert.equal(style(['.help-dialog h2'])['font-size'], '26px');
  assert.equal(style(['.help-dialog h3'])['font-size'], '20px');
  const repair = css.slice(css.indexOf('/* Readable, content-sized room layouts.'));
  assert.doesNotMatch(repair, /(?:html|body|\.cell|\.battle-board)\s*\{[^}]*font-size:/);
  const reduced = style(['#battleArena .battle-board-stage > .battle-lock.lock-pop'], 320, 720, true);
  assert.equal(reduced.animation, 'none');
  assert.equal(reduced.transform, 'none');
  assert.equal(reduced.opacity, '1');
});
