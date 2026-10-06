'use strict';

// Source-level layout contracts only. This intentionally does not launch a
// browser, compute geometry, or claim visual acceptance at these widths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const Palette = require('../region-palette.js');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'battle-ui.js'), 'utf8');

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

// A small strict source-tree parser, not a simulated browser DOM. Unlike the
// gameplay tests' fake elements, it preserves actual parent/child relationships
// and checks balanced tags. It intentionally performs no layout or CSS matching.
function parseMarkup(source) {
  const root = { tag: '#root', attrs: {}, children: [] }, stack = [root];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tokens = source.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[\w:-]+\b(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (/^<!/.test(token)) continue;
    if (!token.startsWith('<')) { stack.at(-1).children.push({ tag: '#text', text: token }); continue; }
    const tag = token.match(/^<\/?([\w:-]+)/)[1].toLowerCase();
    if (token.startsWith('</')) {
      assert.equal(stack.at(-1).tag, tag, `balanced source markup at ${token}`);
      stack.pop();
      continue;
    }
    const attrs = {};
    const attributes = token.slice(token.indexOf(tag) + tag.length).replace(/\/?\s*>$/, '');
    for (const match of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
      attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    const node = { tag, attrs, children: [], parent: stack.at(-1) };
    node.parent.children.push(node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  assert.equal(stack.length, 1, 'all source tags are closed');
  return root;
}
const elements = node => node.children.filter(child => child.tag !== '#text');
const hasClass = (node, className) => (node.attrs?.class || '').split(/\s+/).includes(className);
function descendants(node, predicate) {
  return elements(node).flatMap(child => [...(predicate(child) ? [child] : []), ...descendants(child, predicate)]);
}
const byClass = (node, className) => descendants(node, child => hasClass(child, className));
const byId = (node, id) => descendants(node, child => child.attrs.id === id);
const textContent = node => node.tag === '#text' ? node.text : node.children.map(textContent).join('');
const treeShape = node => node.tag === '#text' ? node.text : { tag: node.tag, attrs: node.attrs, children: node.children.map(treeShape) };

function battleSideTree(local) {
  // Evaluate only the renderer's authored HTML template with fixed data. There
  // is no fake DOM, rendering call, network access, or browser measurement here.
  const template = ui.match(/root\.innerHTML=(`[^]*?`);\}/)?.[1];
  assert.ok(template, 'the battle-side source template exists');
  return parseMarkup(vm.runInNewContext(template, {
    local, maxHP: 150, state: { practice: false },
    player: { avatar: 'cat', nickname: '測試貓', hp: 150 },
    board: { combo: 0, number: 1, found: [], puzzle: { id: 'layout-fixture' } },
    playerAvatar: () => '<span class="avatar-character"></span>',
    escapeHTML: value => value, battleCat: () => '', stableHash: () => 0
  }, { timeout: 1000 }));
}

// Height is part of every fixture. These tests inspect authored contracts and
// arithmetic budgets, not real font metrics, DOM rectangles, or rendered fit.
const viewports = [
  [320, 720], [360, 800], [390, 844], [430, 932], [700, 900],
  [701, 900], [768, 900], [1099, 900], [1100, 900],
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

  test(`compact unboxed guidance stays above only the own board at ${width}x${height} (structural)`, () => {
    const instructions = style(['.gesture-hint', '#battleArena .local > .gesture-hint'], width, height);
    assert.equal(instructions.display, 'flex');
    assert.equal(instructions['min-width'], '0');
    assert.equal(instructions['max-width'], '100%');
    assert.equal(instructions['flex-wrap'], 'wrap', 'exceptionally narrow spaces wrap between action groups');
    assert.equal(instructions['font-size'], '16px');
    assert.equal(instructions['font-weight'], '650');
    assert.equal(instructions['line-height'], '1.5');
    assert.equal(instructions.color, '#6b503c');
    assert.equal(instructions['text-align'], 'center');
    assert.equal(instructions['justify-content'], 'center');
    assert.equal(instructions['overflow-wrap'], undefined, 'the instruction words are not fragmented');
    for (const [property, value] of Object.entries({ padding: '0', border: '0', 'border-radius': '0', background: 'none', 'box-shadow': 'none' }))
      assert.equal(instructions[property], value, `guidance has no card ${property}`);
    assert.equal(instructions.margin, width >= 1100 ? '0' : '8px 0');
    assert.equal(instructions['grid-row'], width >= 1100 ? '2' : undefined);
    assert.equal(instructions['grid-column'], width >= 1100 ? '1 / -1' : undefined);
    assert.equal(instructions.position, undefined, 'the line remains in normal flow');
    const action = style(['.gesture-action'], width, height);
    assert.equal(action.display, 'inline-flex');
    assert.equal(action['white-space'], 'nowrap', 'single and double activation stay intact as separate groups');
    assert.equal(action.color, undefined, 'action words inherit the warm text color');
    const mark = style(['.gesture-mark'], width, height);
    assert.equal(mark.color, '#58306f', 'only the private-mark symbol is purple');
    assert.equal(mark['line-height'], '1', 'the larger mark does not enlarge the 24px instruction line');
    assert.equal(style(['.gesture-divider'], width, height).color, '#93775b');
    const paw = style(['.gesture-paw'], width, height);
    assert.equal(paw.width, '18px');
    assert.equal(paw.height, '18px');
    assert.equal(paw.flex, '0 0 18px');
    assert.equal(paw.fill, 'currentColor');
    assert.equal(paw.color, undefined);
    const legacy = style(['.gesture-hint', '#game .center > .gesture-hint'], width, height);
    for (const property of ['display', 'font-size', 'font-weight', 'line-height', 'color', 'background', 'border', 'padding', 'box-shadow'])
      assert.equal(legacy[property], instructions[property], `legacy guidance shares ${property}`);
    assert.equal(legacy.width, '100%');
    assert.equal(legacy['grid-row'], width >= 1051 ? '2' : undefined);
    const combo = style(['.combo-badge', '#battleArena .combo-badge', '#battleArena .local .combo-badge', '#battleArena .local > .combo-badge'], width, height);
    assert.equal(combo['margin-bottom'], '0', 'the combo cannot overlap the guidance with its old negative margin');
    const card = style(['.board-card', '#battleArena .board-card', '#battleArena .local .board-card', '#battleArena .local > .board-card'], width, height);
    assert.equal(card['grid-template-columns'], width >= 1100 ? 'minmax(0, 1fr)' : undefined, 'the cream card reserves no phantom sidebar track');
  });

  test(`battle panels have no spare instruction track at ${width}x${height} (structural)`, () => {
    const layout = style(['.battle-layout', '#battleArena .battle-layout'], width, height);
    const stage = style(['#battleArena .battle-board-stage'], width, height);
    assert.equal(stage['margin-inline'], 'auto');
    if (width < 1100) {
      assert.equal(stage.width, '100%', 'both tablet and phone grids keep their available width');
      assert.equal(layout['grid-template-columns'], width <= 700 ? 'minmax(0, 1fr)' : width <= 1000 ? 'minmax(0, 1fr) 37px minmax(0, 1fr)' : 'minmax(0, 1fr) 65px minmax(0, 1fr)');
      return;
    }
    assert.equal(layout.width, 'min(100%, max(816px, calc(2 * var(--battle-board-size) + 128px)))');
    assert.equal(layout['margin-inline'], 'auto');
    assert.equal(layout['grid-template-columns'], 'minmax(0, 1fr) 48px minmax(0, 1fr)');
    assert.equal(layout.gap, '16px');
    for (const sideName of ['local', 'opponent']) {
      const side = style(['.battle-side', `.battle-side.${sideName}`, '#battleArena .battle-side', `#battleArena .battle-side.${sideName}`], width, height);
      assert.equal(side['grid-template-columns'], 'minmax(0, 1fr) 128px', 'the only side columns are player status and combo');
      assert.equal(side['grid-template-rows'], undefined, 'no explicit empty guidance row survives on the opponent side');
      assert.equal(side['grid-auto-rows'], 'max-content');
      assert.equal(side.gap, '6px 10px');
      const context = className => [`.${className}`, `.${sideName} .${className}`, `#battleArena .${className}`, `#battleArena .${sideName} .${className}`, `#battleArena .${sideName} > .${className}`];
      const player = style(context('battle-player'), width, height);
      const combo = style(context('combo-badge'), width, height);
      assert.equal(player['grid-row'], '1');
      assert.equal(player['grid-column'], '1');
      assert.equal(combo['grid-row'], '1');
      assert.equal(combo['grid-column'], '2');
      assert.equal(combo.margin, '0', 'desktop status contains no negative-margin overlap');
      const card = style(context('board-card'), width, height);
      const basket = style(context('cat-basket'), width, height);
      const firstBoardRow = sideName === 'local' ? 3 : 2;
      assert.equal(card['grid-row'], String(firstBoardRow));
      assert.equal(basket['grid-row'], String(firstBoardRow + 1));
      assert.equal(card['grid-column'], '1 / -1');
      assert.equal(basket['grid-column'], '1 / -1');
      assert.equal(card['grid-template-columns'], 'minmax(0, 1fr)');
      assert.equal(card.width, 'min(100%, calc(var(--battle-board-size) + 24px))', 'cream panels size to their square even when status needs more width');
      assert.equal(card['justify-self'], 'center');
      assert.equal(card.padding, '6px 10px 8px', 'cream chrome remains tight rather than holding sidebar padding');
      assert.equal(card.gap, '4px');
      const heading = style(context('board-heading'), width, height);
      assert.equal(heading['min-height'], '24px');
      assert.equal(heading.margin, '0');
      assert.equal(heading.padding, '0');
    }
  });

  test(`region edges use the same ordinary separators as every cell at ${width}x${height} (structural)`, () => {
    const contexts = [
      ['.cell', '#board .cell'],
      ['.cell', '#board .cell', '#board[data-size="6"] .cell'],
      ['.cell', '.battle-board .cell'],
      ['.cell', '.battle-board .cell', '.opponent .battle-board .cell']
    ];
    for (const selectors of contexts) {
      const ordinary = style(selectors, width, height);
      const edge = style([...selectors, ...selectors.flatMap(selector => [`${selector}.er`, `${selector}.eb`])], width, height);
      assert.deepEqual(edge, ordinary, 'color-boundary cells have no extra border, outline, or shadow');
    }
    const legacy = style(['#board', '#game #board'], width, height);
    const battle = style(['.battle-board'], width, height);
    const opponent = style(['.battle-board', '.opponent .battle-board'], width, height);
    for (const board of [legacy, battle, opponent]) {
      assert.equal(board.border, '0');
      assert.equal(board.outline, undefined);
      assert.equal(board['border-width'], undefined, 'no later breakpoint restores a board edge');
      assert.equal(board['touch-action'], 'manipulation');
      assert.doesNotMatch(board['box-shadow'], /(?:^|,)\s*(?:inset\s+)?0\s+0\s+0\s+\d/, 'no static outer outline masquerades as a shadow');
    }
    const scroll = style(['#boardWrap', '#game #boardWrap'], width, height);
    if (width <= 700) assert.equal(scroll['touch-action'], 'manipulation', 'board scrolling also allows pinch zoom');
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
    assert.equal(arena['--battle-board-size'], 'clamp(288px, calc(100dvh - 400px), 560px)');
    const stage = style(['#battleArena .battle-board-stage'], width, height);
    assert.equal(stage.width, 'min(100%, var(--battle-board-size))');
    const board = Math.max(288, Math.min(height - 400, 560));
    const arenaWidth = Math.min(1460, width - 48);
    const layoutWidth = Math.min(arenaWidth, Math.max(816, 2 * board + 128));
    const columnsWidth = layoutWidth - 48 - 2 * 16;
    const sideWidth = columnsWidth / 2;
    assert.ok(sideWidth >= 368, 'status has its own readable width floor');
    const panelWidth = Math.min(sideWidth, board + 24);
    const ownAvailable = panelWidth - 24;
    const opponentAvailable = panelWidth - 24;
    assert.equal(ownAvailable, board, 'the local cream panel hugs its square without sidebar space');
    assert.equal(opponentAvailable, board, 'the opponent cream panel has the same compact width');
    const cardChrome = 6 + 8 + 4 + 24 + 4; // vertical padding, borders, heading, gap
    assert.equal(cardChrome, 46);
    const chromeBudget = 20 + 92 + 32 + 64 + 24 + 18 + cardChrome + 44 + 39;
    assert.equal(chromeBudget, 379);
    assert.ok(board + chromeBudget <= height, 'ordinary text/content budget leaves headroom instead of clipping the page');
    assert.ok((board - 15) / 6 >= 50, 'six-by-six cells retain approximately 50px or more');
    const header = style(['.battle-header', '#battleArena .battle-header'], width, height);
    assert.equal(header['flex-direction'], 'row');
    const card = style(['.board-card', '#battleArena .board-card', '#battleArena .local .board-card', '#battleArena .local > .board-card'], width, height);
    assert.equal(card['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(card.padding, '6px 10px 8px');
    assert.equal(card.gap, '4px');
    const legacyBoard = style(['#boardWrap', '#game #boardWrap'], width, height);
    assert.equal(legacyBoard['max-height'], 'calc(100dvh - 340px)');
    assert.equal(legacyBoard.overflow, 'auto', 'explicit board zoom can scroll its board, without cropping controls');
    assert.equal(legacyBoard['grid-row'], '3', 'the board follows the always-visible gesture hint');
    const gesture = style(['.gesture-hint', '#game .center > .gesture-hint'], width, height);
    assert.equal(gesture['grid-row'], '2');
    assert.equal(gesture['grid-column'], '1 / -1');
    const title = style(['#battleArena .battle-brand h1'], width, height);
    assert.equal(title['font-size'], '32px');
    const emergency = style(['#battleArena', '#battleArena:has(.battle-toolbar > button:not(.hidden))'], width, height);
    assert.equal(emergency['--battle-board-size'], 'clamp(256px, calc(100dvh - 464px), 560px)');
    const pausedBoard = Math.max(256, Math.min(height - 464, 560));
    const pausedLayout = Math.min(arenaWidth, Math.max(816, 2 * pausedBoard + 128));
    const pausedSide = (pausedLayout - 48 - 2 * 16) / 2;
    assert.ok(pausedSide >= 368, 'reconnect/abort states keep the readable status-width floor');
    assert.equal(Math.min(pausedSide, pausedBoard + 24) - 24, pausedBoard, 'paused cream cards hug the smaller square without adding a sidebar');
    assert.ok(pausedBoard + chromeBudget + 64 <= height, 'visible reconnect/abort actions have a separate 64px budget');
    const toolbox = style(['.toolbox', '#game .toolbox'], width, height);
    assert.equal(toolbox['grid-column'], '2');
    assert.equal(toolbox['grid-row'], '3');
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
    // The board then owns 4px padding + five 1px gaps, without a region outline.
    const square = width - 20 - 16 - 4;
    assert.ok((square - 9) / 6 >= 44, 'ordinary local cells preserve roughly 44px touch targets');
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

test('the shared instruction line has an accessible compact action-group structure and original inline paw', () => {
  const tree = parseMarkup(html);
  const hints = byClass(tree, 'gesture-hint');
  assert.equal(hints.length, 2, 'one shared-board line and one reusable battle line');
  const battle = byId(tree, 'battleGestureHint');
  const legacy = byId(tree, 'gestureHint');
  assert.equal(battle.length, 1);
  assert.equal(legacy.length, 1);
  assert.equal(battle[0].parent.attrs.id, 'battleArena', 'initial storage is outside either cream card');
  assert.ok(hasClass(legacy[0].parent, 'center'));
  assert.equal(byId(tree, 'board')[0].attrs['aria-describedby'], 'gestureHint');
  const centerChildren = elements(legacy[0].parent);
  assert.equal(centerChildren[centerChildren.indexOf(legacy[0]) + 1].attrs.id, 'boardWrap', 'legacy guidance immediately precedes its board as a sibling');
  assert.deepEqual(battle[0].children.map(treeShape), legacy[0].children.map(treeShape), 'both modes use exactly the same visible actions and SVG');
  for (const hint of hints) {
    assert.equal(hint.tag, 'p', 'guidance is text, not a button or instruction card');
    assert.equal(hint.attrs.role, 'note', 'the description is a named note, not an interactive control');
    assert.equal(hint.attrs['aria-label'], '單點做私人標記，快速雙點同一格翻格');
    assert.deepEqual(elements(hint).map(node => node.attrs.class), ['gesture-action', 'gesture-divider', 'gesture-action']);
    const actions = byClass(hint, 'gesture-action');
    assert.equal(textContent(actions[0]).replace(/\s+/g, ' ').trim(), '單點 ✕ 標記');
    assert.equal(textContent(actions[1]).replace(/\s+/g, ' ').trim(), '雙點 翻格');
    assert.equal(byClass(actions[0], 'gesture-mark').length, 1);
    const paws = byClass(actions[1], 'gesture-paw');
    assert.equal(paws.length, 1);
    assert.equal(paws[0].tag, 'svg');
    assert.equal(paws[0].attrs.viewBox, '0 0 24 24');
    assert.equal(paws[0].attrs['aria-hidden'], 'true');
    assert.equal(paws[0].attrs.focusable, 'false');
    assert.deepEqual(elements(paws[0]).map(node => node.tag), ['ellipse', 'ellipse', 'ellipse', 'ellipse', 'path']);
    assert.equal(elements(paws[0]).at(-1).attrs.d, 'M6.5 16.2c.8-1.1 1.8-1.8 2.7-3.2 1.4-2.2 4.5-2.2 5.9 0 .9 1.4 1.9 2.1 2.7 3.2 1.7 2.5.3 4.8-2.1 4.8-1.6 0-2.3-.8-3.6-.8s-2 .8-3.6.8c-2.4 0-3.7-2.3-2-4.8Z');
    assert.equal(descendants(hint, node => ['img', 'image', 'use', 'button', 'a'].includes(node.tag)).length, 0, 'no external art, icon font, or extra control');
    assert.doesNotMatch(textContent(hint), /🐾/);
  }
});

test('battle source mounts one reusable local hint before the cream panel without changing the lock topology', () => {
  assert.match(ui, /const battleGestureHint=\$\('#battleGestureHint'\)/);
  assert.match(ui, /if\(local&&battleGestureHint&&battleGestureHint\.parentNode!==root\)root\.insertBefore\(battleGestureHint,root\.querySelector\('\.board-card'\)\)/);
  assert.equal((ui.match(/insertBefore\(battleGestureHint/g) || []).length, 1, 'one mount path, guarded against duplicate insertion');
  assert.doesNotMatch(ui + html + css, /battlePrimaryControls|primary-controls(?:-slot)?/);
  assert.doesNotMatch(ui, /battleGestureHint\.cloneNode|battle-lock-slot/);
  for (const local of [true, false]) {
    const tree = battleSideTree(local);
    assert.deepEqual(elements(tree).map(node => node.attrs.class), ['battle-player', 'combo-badge', 'board-card', 'cat-basket']);
    assert.equal(byClass(tree, 'gesture-hint').length, 0, 'side templates do not duplicate or render opponent instructions');
    const card = byClass(tree, 'board-card')[0];
    assert.deepEqual(elements(card).map(node => node.attrs.class), ['capture-callout', 'board-heading', 'battle-board-stage'], 'the cream panel contains no guidance slot or spare wrapper');
    const stage = byClass(tree, 'battle-board-stage')[0];
    assert.equal(stage.parent, card);
    assert.deepEqual(elements(stage).map(node => node.attrs.class), ['battle-lock hidden', 'battle-board']);
    assert.equal(byClass(tree, 'battle-lock')[0].parent, stage, 'the centered lock remains inside the board stage');
    assert.equal(byClass(tree, 'battle-board')[0].parent, stage);
    assert.equal(byClass(tree, 'battle-board')[0].attrs['aria-label'], local ? '你的尋貓棋盤' : '對手唯讀棋盤');
    assert.equal(byClass(tree, 'battle-board')[0].attrs['aria-describedby'], local ? 'battleGestureHint' : undefined);
    assert.equal(byClass(tree, 'cat-basket')[0].parent, tree, 'the basket follows the panel in normal flow');
  }
});

test('help remains in the visible header and retired marking and boundary controls stay absent', () => {
  const tree = parseMarkup(html);
  const help = byId(tree, 'battleHelp')[0];
  const header = byClass(tree, 'battle-header')[0];
  assert.ok(descendants(header, node => node === help).length === 1);
  const toolbar = byClass(tree, 'battle-toolbar')[0];
  assert.deepEqual(elements(toolbar).map(node => node.attrs.id), ['battleReconnect', 'battleAbort', 'battleReturn']);
  assert.doesNotMatch(html, /id="(?:battleNote|noteMode)(?:Status)?"|記號模式/);
  assert.doesNotMatch(html, /粗線圍住|區域邊界|boundary-sample/);
  assert.equal(byClass(tree, 'region-sample').length, 1);
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


test('region boundaries and marker-toggle styles are retired at every breakpoint', () => {
  assert.doesNotMatch(css, /\.cell\.(?:er|eb)\b|--region-edge|boundary-sample/);
  assert.doesNotMatch(css, /#(?:noteMode|battleNote)(?:Status)?\b|note-mode-active/);
  const sample = style(['.region-sample']);
  assert.match(sample.background, /#f1ce79.*#e297f6.*#60d8fb/);
  assert.equal(sample['border-right'], undefined);
});

test('private purple marks and confirmed dark gray misses preserve their region colors and contrast', () => {
  for (const [width, height] of viewports) {
    for (const board of ['#board', '.battle-board']) {
      const opened = style(['.cell', `${board} .cell`, '.cell.opened', `${board} .cell.opened`, `${board} .cell:is(.cat, .opened, .note)`], width, height);
      const note = style(['.cell', `${board} .cell`, '.cell.note', `${board} .cell.note`, `${board} .cell:is(.cat, .opened, .note)`], width, height);
      const cat = style(['.cell', `${board} .cell`, '.cell.cat', `${board} .cell.cat`, `${board} .cell:is(.cat, .opened, .note)`], width, height);
      for (const state of [opened, note, cat]) assert.equal(state['background-color'], 'var(--bg)');
      assert.equal(opened.color, '#493d35');
      assert.equal(note.color, '#58306f');
      assert.notEqual(opened.color, note.color);
      assert.match(opened['background-image'], /^radial-gradient/);
      assert.equal(note['background-image'], 'none');
      for (const background of Palette.colors) {
        assert.ok(Palette.contrastRatio(background, opened.color) >= 4.6);
        assert.ok(Palette.contrastRatio(background, note.color) >= 4.6);
      }
    }
  }
});

test('gesture touch policy is local and preserves page and pinch zoom', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:["',\s]|$)/i);
  for (const rule of rules) {
    const touch = rule.declarations.find(declaration => declaration.property === 'touch-action');
    if (!touch) continue;
    if (touch.value === 'none') {
      assert.deepEqual(rule.selectors, ['#battleArena .battle-board-stage > .battle-lock'], 'only the existing blocking miss overlay may consume all gestures');
    } else assert.equal(touch.value, 'manipulation');
    assert.ok(rule.selectors.every(selector => !/^(?:html|body|main|\*)$/.test(selector)), 'no page-wide touch restriction');
  }
});
