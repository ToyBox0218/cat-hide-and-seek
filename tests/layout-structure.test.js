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

function mediaMatches(conditions, width, reducedMotion) {
  const height = 900;
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

function style(selectors, width = 1280, reducedMotion = false) {
  const result = {}, priority = {};
  for (const rule of rules) {
    if (!mediaMatches(rule.media, width, reducedMotion)) continue;
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

for (const width of [320, 360, 390, 430, 768, 1280]) {
  test(`shared-board cards use content-sized rows and wrap names/cats at ${width}px (structural)`, () => {
    const card = style(['.player-card', '#game > .arena > .player-card'], width);
    assert.equal(card.height, 'auto');
    assert.equal(card['min-height'], '0');
    assert.equal(card.overflow, 'visible');
    assert.equal(card['grid-auto-rows'], 'max-content');
    const name = style(['.player-name', '#game .player-card > .player-name'], width);
    assert.equal(name['white-space'], 'normal');
    assert.equal(name['overflow-wrap'], 'anywhere');
    assert.equal(name.overflow, 'visible');
    const basket = style(['.basket', '#game .player-card > .basket'], width);
    assert.equal(basket.display, 'flex');
    assert.equal(basket['flex-wrap'], 'wrap');
    assert.equal(basket.height, 'auto');
    assert.equal(basket.position, 'relative');
    assert.equal(basket['max-width'], 'none');
    assert.equal(basket['max-height'], undefined, '24 cats cannot be cut off by a height limit');
    const intel = style(['.intel-list', '#game .player-card > .intel-list'], width);
    assert.equal(intel.display, 'block');
    assert.equal(intel['overflow-wrap'], 'anywhere');
    assert.equal(intel['font-size'], '14px');
  });

  test(`battle bottom panel follows content instead of reserving footer space at ${width}px (structural)`, () => {
    const arena = style(['#battleArena'], width);
    assert.equal(arena['min-height'], '0');
    const header = style(['.battle-header', '#battleArena .battle-header'], width);
    assert.equal(header.position, width <= 700 ? 'sticky' : 'relative', 'mobile title remains sticky while the bottom toolbar stays in-flow');
    assert.ok(/^max\((16|20)px, env\(safe-area-inset-bottom\)\)$/.test(arena['padding-bottom']));
    const toolbar = style(['.battle-toolbar', '#battleArena .battle-toolbar'], width);
    assert.equal(toolbar.position, 'static');
    assert.equal(toolbar.transform, 'none');
    assert.equal(toolbar.height, 'auto');
    assert.equal(toolbar['min-height'], '0');
    assert.equal(toolbar['flex-wrap'], 'wrap');
    assert.equal(toolbar['border-radius'], '18px 18px 0 0');
    const instructions = style(['.battle-instructions', '#battleArena .battle-instructions'], width);
    assert.equal(instructions.margin, '0 auto');
    assert.equal(instructions['border-radius'], '0 0 18px 18px');
    assert.equal(instructions['font-size'], '14px');
    const button = style(['.battle-toolbar button', '.battle-toolbar > button', '#battleArena .battle-toolbar > button'], width);
    assert.equal(button['min-height'], '44px');
    assert.equal(button['font-size'], '14px');
  });

  test(`cooldown slot retains its space and hidden feedback cannot cover cells at ${width}px (structural)`, () => {
    const slot = style(['#battleArena .battle-lock-slot'], width);
    assert.equal(slot.height, '64px');
    assert.equal(slot.overflow, 'hidden');
    assert.equal(slot['pointer-events'], 'none');
    const hidden = style(['.hidden', '#battleArena .battle-lock-slot > .battle-lock.hidden'], width);
    assert.equal(hidden.display, 'grid');
    assert.equal(hidden.visibility, 'hidden');
    const lock = style(['#battleArena .battle-lock', '#battleArena .battle-lock-slot > .battle-lock'], width);
    assert.equal(lock.inset, '0');
    assert.equal(lock.height, '100%');
    assert.equal(lock.transform, 'none');
    assert.equal(lock['pointer-events'], 'none');
    if (width <= 700) {
      const opponent = style(['#battleArena .battle-lock-slot', '#battleArena .opponent .battle-lock-slot'], width);
      assert.equal(opponent.height, '40px');
      const board = style(['.opponent .board-card'], width);
      assert.equal(board['grid-column'], '2');
      const sides = style(['.battle-layout', '#battleArena .battle-layout'], width);
      assert.equal(sides['grid-template-columns'], 'minmax(0, 1fr)');
    }
  });
}

test('the retired absolute basket and mobile fixed-footer reservation are absent', () => {
  assert.doesNotMatch(css, /\.player-card:{1,2}after\s*\{/);
  for (const rule of rules) {
    if (rule.selectors.includes('.battle-toolbar'))
      assert.ok(!rule.declarations.some(d => d.property === 'position' && d.value === 'fixed'));
    if (rule.selectors.includes('#battleArena'))
      assert.ok(!rule.declarations.some(d => d.property === 'padding-bottom' && /(?:91|145)px/.test(d.value)));
  }
});

test('readable hierarchy is scoped to interface text rather than board tile scaling', () => {
  assert.equal(style([':root'])['--text-body'], '16px');
  assert.equal(style([':root'])['--text-support'], '14px');
  assert.equal(style([':root'])['--text-heading'], '24px');
  assert.equal(style(['.brand h1'], 320)['font-size'], '28px');
  assert.equal(style(['.help-dialog h2'])['font-size'], '26px');
  assert.equal(style(['.help-dialog h3'])['font-size'], '20px');
  const repair = css.slice(css.indexOf('/* Readable, content-sized room layouts.'));
  assert.doesNotMatch(repair, /(?:html|body|\.cell|\.battle-board)\s*\{[^}]*font-size:/);
});

test('temporary note-mode status stays fully visible and new feedback respects reduced motion', () => {
  const temporary = style(["#battleArena #battleNote[data-temporary='true']:disabled"]);
  assert.equal(temporary.opacity, '1');
  assert.equal(temporary.filter, 'none');
  const reduced = style(['#battleArena .battle-lock-slot .battle-lock.lock-pop'], 320, true);
  assert.equal(reduced.animation, 'none');
  assert.equal(reduced.transform, 'none');
  assert.equal(reduced.opacity, '1');
});
