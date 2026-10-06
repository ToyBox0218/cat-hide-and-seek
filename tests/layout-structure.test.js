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

function expandedDeclarations(declaration) {
  const { property, value } = declaration;
  const parts = value.split(/\s+/);
  if (['margin', 'padding'].includes(property) && parts.every(part => /^(?:-?\d+(?:px)?|auto)$/.test(part))) {
    const [top, right = top, bottom = top, left = right] = parts;
    return [declaration, ...['top', 'right', 'bottom', 'left'].map((edge, index) => ({ ...declaration, property: `${property}-${edge}`, value: [top, right, bottom, left][index] }))];
  }
  if (property === 'gap') return [declaration, { ...declaration, property: 'row-gap', value: parts[0] }, { ...declaration, property: 'column-gap', value: parts[1] || parts[0] }];
  return [declaration];
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
    for (const declaration of rule.declarations.flatMap(expandedDeclarations)) {
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

const battleContext = (className, sideName) => [
  `.${className}`, `#battleArena .${className}`,
  ...(sideName ? [`.${sideName} .${className}`, `#battleArena .${sideName} .${className}`, `#battleArena .${sideName} > .${className}`] : []),
  ...(sideName && className === 'battle-side' ? [`.battle-side.${sideName}`, `#battleArena .battle-side.${sideName}`] : [])
];
const rowSpan = value => {
  assert.match(value || '', /^\d+\s*\/\s*\d+$/, 'the authored span uses explicit grid lines');
  return value.split('/').map(Number);
};
const parentRow = (span, relativeRow) => rowSpan(span)[0] + Number(relativeRow) - 1;

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

  test(`one unboxed instruction occupies the natural center gap at ${width}x${height} (structural)`, () => {
    const instructions = style(['.gesture-hint', '#battleArena .battle-center > .gesture-hint'], width, height);
    assert.equal(instructions.display, 'flex');
    assert.equal(instructions['min-width'], '0');
    assert.equal(instructions['max-width'], '100%');
    assert.equal(instructions['font-size'], '16px');
    assert.equal(instructions['font-weight'], '650');
    assert.equal(instructions['line-height'], '1.5');
    assert.equal(instructions.color, '#6b503c');
    assert.equal(instructions['text-align'], 'center');
    assert.equal(instructions['justify-content'], 'center');
    assert.equal(instructions['overflow-wrap'], undefined, 'instruction words are not fragmented');
    for (const [property, value] of Object.entries({ padding: '0', border: '0', 'border-radius': '0', background: 'none', 'box-shadow': 'none' }))
      assert.equal(instructions[property], value, `guidance has no card ${property}`);
    assert.equal(instructions.margin, '0');
    assert.equal(instructions.position, undefined, 'guidance participates in the real layout');
    const rail = style(battleContext('battle-center'), width, height);
    const vs = style([...battleContext('battle-vs'), '#battleArena .battle-center > .battle-vs'], width, height);
    const divider = style(['.gesture-divider', '#battleArena .battle-center .gesture-divider'], width, height);
    if (width <= 700) {
      assert.equal(rail['grid-row'], '2', 'the mobile instruction sits between the two real player sections');
      assert.equal(instructions['flex-direction'] || 'row', 'row', 'mobile uses one compact line where the width permits');
      assert.equal(instructions['flex-wrap'], 'wrap', 'exceptionally narrow spaces wrap between intact action groups');
      assert.equal(vs.display, 'none');
      assert.notEqual(divider.display, 'none');
    } else {
      assert.equal(rail['grid-column'], '2');
      assert.equal(instructions['flex-direction'], 'column', 'the center rail has exactly two action lines');
      assert.equal(instructions['flex-wrap'], 'nowrap');
      assert.equal(instructions['grid-row'], width >= 1100 ? '2 / 4' : '3 / 5', 'guidance is alongside the board panel, not above a player');
      assert.equal(instructions['align-self'], 'center');
      assert.equal(divider.display, 'none', 'the separator is unnecessary between stacked action lines');
      assert.equal(vs['grid-row'], width >= 1100 ? '1' : '1 / 3');
      assert.equal(vs['margin-top'], '0');
    }
    const action = style(['.gesture-action'], width, height);
    assert.equal(action.display, 'inline-flex');
    assert.equal(action['white-space'], 'nowrap', 'single and double activation stay intact as separate groups');
    assert.equal(action.color, undefined, 'action words inherit the warm text color');
    const mark = style(['.gesture-mark'], width, height);
    assert.equal(mark.color, '#58306f', 'only the private-mark symbol is purple');
    assert.equal(mark['line-height'], '1', 'the mark does not enlarge the 24px instruction line');
    assert.equal(style(['.gesture-divider'], width, height).color, '#93775b');
    const paw = style(['.gesture-paw'], width, height);
    assert.equal(paw.width, '18px');
    assert.equal(paw.height, '18px');
    assert.equal(paw.flex, '0 0 18px');
    assert.equal(paw.fill, 'currentColor');
    assert.equal(paw.color, undefined);
    const legacy = style(['.gesture-hint', '#game .center > .gesture-hint'], width, height);
    for (const property of ['display', 'font-size', 'font-weight', 'line-height', 'color', 'background', 'border', 'padding', 'box-shadow'])
      assert.equal(legacy[property], instructions[property], `legacy guidance retains ${property}`);
    assert.equal(legacy.width, '100%');
    assert.equal(legacy['grid-row'], width >= 1051 ? '2' : undefined);
    assert.equal(legacy['flex-direction'], undefined, 'battle-only stacking never changes the legacy hint');
    assert.equal(legacy['flex-wrap'], 'wrap');
  });

  test(`both battle panels share the same parent rows at ${width}x${height} (structural)`, () => {
    const layout = style(battleContext('battle-layout'), width, height);
    const stage = style(battleContext('battle-board-stage'), width, height);
    assert.equal(stage['margin-inline'], 'auto');
    if (width <= 700) {
      assert.equal(layout['grid-template-columns'], 'minmax(0, 1fr)');
      assert.equal(stage.width, '100%', 'phones keep the full-width local grid');
      assert.equal(style(battleContext('battle-side', 'local'), width, height)['grid-row'], '1');
      assert.equal(style(battleContext('battle-side', 'opponent'), width, height)['grid-row'], '3');
      return;
    }
    const desktop = width >= 1100;
    const sideSpan = desktop ? '1 / 5' : '1 / 6';
    const panelSpan = desktop ? '2 / 4' : '3 / 5';
    assert.equal(layout['grid-template-columns'], 'minmax(0, 1fr) 96px minmax(0, 1fr)');
    assert.equal(layout['grid-template-rows'], `repeat(${desktop ? 4 : 5}, max-content)`, 'only status, heading, square and basket tracks exist');
    assert.equal(layout['align-items'], 'stretch');
    const rail = style(battleContext('battle-center'), width, height);
    assert.equal(rail.display, 'grid');
    assert.equal(rail['grid-row'], sideSpan);
    assert.equal(rail['grid-template-rows'], 'subgrid', 'the rail shares the board rows instead of measuring its own text');
    if (desktop) {
      assert.equal(layout.width, 'min(100%, max(864px, calc(2 * var(--battle-board-size) + 176px)))');
      assert.equal(layout['margin-inline'], 'auto');
      assert.equal(layout['row-gap'], '6px');
      assert.equal(layout['column-gap'], '16px');
    } else assert.equal(stage.width, '100%');
    for (const [sideName, column] of [['local', '1'], ['opponent', '3']]) {
      const side = style(battleContext('battle-side', sideName), width, height);
      assert.equal(side.display, 'grid');
      assert.equal(side['grid-column'], column);
      assert.equal(side['grid-row'], sideSpan);
      assert.equal(side['grid-template-rows'], 'subgrid', 'different nickname heights contribute to one shared status row');
      assert.equal(side['grid-template-columns'], desktop ? 'minmax(0, 1fr) 128px' : 'minmax(0, 1fr)');
      const player = style(battleContext('battle-player', sideName), width, height);
      const combo = style(battleContext('combo-badge', sideName), width, height);
      assert.equal(player['grid-row'], '1');
      assert.equal(player['grid-column'], desktop ? '1' : '1 / -1');
      assert.equal(player['align-self'], 'stretch');
      assert.equal(player['grid-template-rows'], 'minmax(min-content, 1fr) 28px', 'HP has a bottom-aligned fixed row below wrapping names');
      assert.equal(combo['grid-row'], desktop ? '1' : '2');
      assert.equal(combo['grid-column'], desktop ? '2' : '1 / -1');
      assert.equal(combo.margin, '0', 'status contains no negative-margin overlap');
      const card = style(battleContext('board-card', sideName), width, height);
      const basket = style(battleContext('cat-basket', sideName), width, height);
      assert.equal(card['grid-row'], panelSpan);
      assert.equal(basket['grid-row'], desktop ? '4' : '5');
      assert.equal(card['grid-column'], '1 / -1');
      assert.equal(basket['grid-column'], '1 / -1');
      assert.equal(card.display, 'grid');
      assert.equal(card['grid-template-columns'], 'minmax(0, 1fr)', 'there is no phantom sidebar track');
      assert.equal(card['grid-template-rows'], 'subgrid', 'both variable-height headings contribute to one shared header track');
      assert.equal(card['row-gap'], '4px', 'nested subgrids use the same deliberate heading-to-square gap');
      assert.equal(card.padding, '6px 10px 8px');
      assert.ok([undefined, 'auto', 'stretch'].includes(card['align-self']), 'cards stretch over the same two parent rows');
      if (desktop) {
        assert.equal(card.width, 'min(100%, calc(var(--battle-board-size) + 24px))');
        assert.equal(card['justify-self'], 'center');
      }
      const heading = style(battleContext('board-heading', sideName), width, height);
      assert.equal(heading['grid-row'], '1');
      assert.equal(heading['min-height'], '24px');
      assert.equal(heading.margin, '0');
      assert.equal(heading.padding, '0');
      assert.equal(stage['grid-row'], '2');
      assert.equal(stage['align-self'], 'start');
      assert.equal(parentRow(card['grid-row'], stage['grid-row']), desktop ? 3 : 4, 'both colored grids start in the same parent square row');
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
    assert.equal(arena['--battle-board-size'], 'clamp(288px, calc(100dvh - 376px), 560px)');
    const stage = style(['#battleArena .battle-board-stage'], width, height);
    assert.equal(stage.width, 'min(100%, var(--battle-board-size))');
    const board = Math.max(288, Math.min(height - 376, 560));
    const arenaWidth = Math.min(1460, width - 48);
    const layoutWidth = Math.min(arenaWidth, Math.max(864, 2 * board + 176));
    const columnsWidth = layoutWidth - 96 - 2 * 16;
    const sideWidth = columnsWidth / 2;
    assert.ok(sideWidth >= 368, 'status has its own readable width floor');
    const panelWidth = Math.min(sideWidth, board + 24);
    const ownAvailable = panelWidth - 24;
    const opponentAvailable = panelWidth - 24;
    assert.equal(ownAvailable, board, 'the local cream panel hugs its square without sidebar space');
    assert.equal(opponentAvailable, board, 'the opponent cream panel has the same compact width');
    const cardChrome = 6 + 8 + 4 + 24 + 4; // vertical padding, borders, heading, gap
    assert.equal(cardChrome, 46);
    const chromeBudget = 20 + 92 + 32 + 64 + 12 + cardChrome + 44 + 39;
    assert.equal(chromeBudget, 349, 'guidance consumes horizontal rail space, not a vertical row');
    assert.ok(board + chromeBudget <= height, 'ordinary text/content budget leaves headroom instead of clipping the page');
    assert.ok((board - 15) / 6 >= 50, 'six-by-six cells retain approximately 50px or more');
    const header = style(['.battle-header', '#battleArena .battle-header'], width, height);
    assert.equal(header['flex-direction'], 'row');
    const card = style(['.board-card', '#battleArena .board-card', '#battleArena .local .board-card', '#battleArena .local > .board-card'], width, height);
    assert.equal(card['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(card.padding, '6px 10px 8px');
    assert.equal(card['row-gap'], '4px');
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
    assert.equal(emergency['--battle-board-size'], 'clamp(272px, calc(100dvh - 440px), 560px)');
    const pausedBoard = Math.max(272, Math.min(height - 440, 560));
    const pausedLayout = Math.min(arenaWidth, Math.max(864, 2 * pausedBoard + 176));
    const pausedSide = (pausedLayout - 96 - 2 * 16) / 2;
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

for (const width of [701, 768, 1099, 1100, 1280]) {
  test(`unequal names, combos and headings preserve shared starts at ${width}px (content-track arithmetic, not browser proof)`, () => {
    const height = 900;
    const layout = style(battleContext('battle-layout'), width, height);
    const rowCount = Number(layout['grid-template-rows'].match(/^repeat\((\d+), max-content\)$/)[1]);
    const placements = ['local', 'opponent'].map(sideName => {
      const side = style(battleContext('battle-side', sideName), width, height);
      const card = style(battleContext('board-card', sideName), width, height);
      assert.equal(side['grid-template-rows'], 'subgrid');
      assert.equal(card['grid-template-rows'], 'subgrid');
      const resolve = className => parentRow(side['grid-row'], style(battleContext(className, sideName), width, height)['grid-row']);
      const resolveCard = className => parentRow(side['grid-row'], parentRow(card['grid-row'], style(battleContext(className, sideName), width, height)['grid-row']));
      return { player: resolve('battle-player'), combo: resolve('combo-badge'), heading: resolveCard('board-heading'), square: resolveCard('battle-board-stage'), basket: resolve('cat-basket') };
    });
    // Synthetic content heights deliberately trade the taller name and heading
    // between opponents. These sums isolate row contributions; identical card
    // chrome and subgrid gap adjustments are omitted, not browser-measured.
    const scenarios = [
      [{ player: 116, combo: 44, heading: 24 }, { player: 64, combo: 44, heading: 72 }],
      [{ player: 64, combo: 44, heading: 72 }, { player: 116, combo: 44, heading: 24 }],
      [{ player: 64, combo: 104, heading: 48 }, { player: 152, combo: 44, heading: 24 }]
    ];
    for (const scenario of scenarios) {
      const ownRows = scenario.map((fixture, index) => {
        const rows = Array(rowCount).fill(0);
        for (const [item, contentHeight] of Object.entries({ ...fixture, square: 288, basket: 44 })) {
          const row = placements[index][item];
          assert.ok(row >= 1 && row <= rowCount, `${item} stays inside the explicitly shared parent tracks`);
          rows[row - 1] = Math.max(rows[row - 1], contentHeight);
        }
        return rows;
      });
      const sharedRows = ownRows[0].map((value, row) => Math.max(value, ownRows[1][row]));
      const offset = (rows, row) => rows.slice(0, row - 1).reduce((sum, value) => sum + value, 0);
      for (const item of ['heading', 'square', 'basket']) {
        const starts = placements.map(placement => offset(sharedRows, placement[item]));
        assert.equal(starts[0], starts[1], `${item} shares one start despite asymmetric preceding content`);
      }
      const independentSquareStarts = placements.map((placement, index) => offset(ownRows[index], placement.square));
      assert.notEqual(independentSquareStarts[0], independentSquareStarts[1], 'each fixture exposes the old independent-side drift');
      const playerEnds = placements.map(placement => offset(sharedRows, placement.player) + sharedRows[placement.player - 1]);
      assert.equal(playerEnds[0], playerEnds[1], 'stretched player rows give both fixed-height HP meters the same bottom');
      const hint = style(['.gesture-hint', '#battleArena .battle-center > .gesture-hint'], width, height);
      assert.deepEqual(rowSpan(hint['grid-row']), [placements[0].heading, placements[0].square + 1], 'the hint spans the shared panel rows without introducing a height track');
    }
  });
}

test('two intact action groups fit the authored desktop rail and the narrow mobile gap (typographic arithmetic)', () => {
  const action = style(['.gesture-action']);
  const hint = style(['.gesture-hint']);
  const paw = style(['.gesture-paw']);
  assert.equal(action.gap, '4px');
  const fontSize = parseFloat(hint['font-size']);
  // Four full-width CJK glyphs, one largest icon, and two authored flex gaps.
  // This is a font-size budget, not a claim about every fallback font's metrics.
  const groupWidth = 4 * fontSize + parseFloat(paw.width) + 2 * parseFloat(action.gap);
  const railWidth = Number(style(battleContext('battle-layout'))['grid-template-columns'].match(/\) (\d+)px /)[1]);
  assert.equal(groupWidth, 90);
  assert.ok(groupWidth <= railWidth, 'both action groups have breathing room inside the 96px rail');
  assert.ok(2 * groupWidth + fontSize + 2 * 6 <= 320 - 20, 'the one-line mobile instruction fits the narrowest arena fixture');
  const battleHint = byId(parseMarkup(html), 'battleGestureHint')[0];
  for (const group of byClass(battleHint, 'gesture-action')) {
    const words = group.children.filter(node => node.tag === '#text');
    assert.ok(words.every(node => node.text === node.text.trim()), 'CSS gaps provide spacing without extra anonymous whitespace widths');
  }
});

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
  assert.equal(hints.length, 2, 'one legacy hint and one static central battle hint');
  const battle = byId(tree, 'battleGestureHint');
  const legacy = byId(tree, 'gestureHint');
  assert.equal(battle.length, 1);
  assert.equal(legacy.length, 1);
  assert.ok(hasClass(battle[0].parent, 'battle-center'), 'the battle hint starts in its final center rail');
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
    assert.equal(textContent(actions[0]), '單點✕標記');
    assert.equal(textContent(actions[1]), '雙點翻格');
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

test('battle markup owns one stable center rail between intact side sections without hint reparenting', () => {
  const tree = parseMarkup(html);
  const layouts = byClass(tree, 'battle-layout');
  assert.equal(layouts.length, 1);
  const layout = layouts[0];
  assert.equal(layout.parent.attrs.id, 'battleArena');
  assert.deepEqual(elements(layout).map(node => ({ tag: node.tag, class: node.attrs.class })), [
    { tag: 'section', class: 'battle-side local' },
    { tag: 'aside', class: 'battle-center' },
    { tag: 'section', class: 'battle-side opponent' }
  ], 'mobile source order is local board, instruction, opponent board');
  const rail = byClass(layout, 'battle-center')[0];
  assert.equal(rail.attrs['aria-label'], '棋盤操作');
  assert.deepEqual(elements(rail).map(node => node.attrs.class), ['battle-vs', 'gesture-hint']);
  assert.equal(elements(rail)[1].attrs.id, 'battleGestureHint');
  assert.equal(elements(rail)[0].attrs['aria-hidden'], 'true');
  assert.equal(textContent(elements(rail)[0]), 'VS');
  assert.equal(byClass(tree, 'battle-center').length, 1);
  for (const side of byClass(layout, 'battle-side')) {
    assert.equal(elements(side).length, 0, 'only the renderer owns player-section contents');
    assert.equal(byClass(side, 'gesture-hint').length, 0);
  }
  assert.doesNotMatch(ui, /(?:const|let|var)\s+battleGestureHint|\$\(['"]#battleGestureHint['"]\)/, 'the stable source hint needs no JavaScript mount or lookup');
  assert.doesNotMatch(ui, /(?:insertBefore|appendChild|replaceChild|cloneNode)\([^)]*battleGestureHint|battleGestureHint\.(?:remove|cloneNode)/);
  assert.doesNotMatch(css, /\.local\s*>\s*\.gesture-hint|\.opponent\s*>\s*\.gesture-hint/, 'neither side gets a private instruction row');
  assert.doesNotMatch(ui + html + css, /battlePrimaryControls|primary-controls(?:-slot)?/);
  assert.doesNotMatch(ui, /battle-lock-slot/);
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
