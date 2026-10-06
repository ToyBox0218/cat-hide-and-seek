'use strict';

// Authored CSS/markup budgets and deterministic fake-DOM lifecycle tests only.
// No browser, actual font metrics, device rendering, or PeerJS network is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = value => JSON.parse(JSON.stringify(value));

// Share existing helpers without registering either complete test suite again.
const appSource = read('tests/survival-app.test.js');
const appBoundary = appSource.indexOf("\ntest('");
assert.ok(appBoundary > 0);
const appContext = {require, __dirname, console, Buffer, URL, URLSearchParams};
vm.runInNewContext(appSource.slice(0, appBoundary) + '\nglobalThis.helpers = {fixture, makeHarness};', appContext);
const {fixture, makeHarness} = appContext.helpers;
const layoutSource = read('tests/layout-structure.test.js');
const layoutStart = layoutSource.indexOf('function splitSelectors(');
const layoutEnd = layoutSource.indexOf('const battleContext =');
assert.ok(layoutStart > 0 && layoutEnd > layoutStart);
const layoutContext = {assert};
vm.runInNewContext(`const css = ${JSON.stringify(read('style.css') + '\n' + read('survival.css'))};\n` +
  layoutSource.slice(layoutStart, layoutEnd) + '\nglobalThis.helpers = {style, parseMarkup, byId, byClass};', layoutContext);
const {style, parseMarkup, byId, byClass} = layoutContext.helpers;
const sourceUI = read('survival-ui.js');
const shellSource = sourceUI.match(/function suiBuildShell\(root,game\)\s*\{\s*root\.innerHTML=(`[^]*?`);/);
assert.ok(shellSource, 'survival shell stays available to the source-tree checks');
const shell = parseMarkup(vm.runInNewContext(shellSource[1]));
const px = value => { assert.match(value, /^\d+(?:\.\d+)?px$/); return Number.parseFloat(value); };
const ui = h => vm.runInContext('survivalUI', h.context);
const sounds = h => h.audio.calls.filter(call => call.method === 'play').map(call => ({kind:call.args[0], ...call.args[1]}));

function hit(f, who=0) {
  const {h, authority, engine, sync} = f, board = authority.boards[who];
  const index = board.puzzle.solution.find(cell => !board.found.includes(cell));
  const result = engine.act(authority, authority.players[who].id,
    {type:'guess', boardId:board.puzzle.id, index, actionId:`layout-${who}-${h.now()}-${index}`}, h.now());
  assert.equal(result.accepted, true);
  sync();
  return result.event;
}

function tabby(f, who=0) {
  for (let attempt=0; attempt<6; attempt++) {
    const event = hit(f, who);
    if (event.blast) {
      assert.equal(event.advanced, false, 'this fixture exercises a burst on the current board');
      return event;
    }
    f.h.tick(300);
  }
  assert.fail('the deterministic first board must contain a tabby opportunity');
}

test('four-player shell contains one main board and exactly one compact public preview', () => {
  assert.equal(byClass(shell, 'battle-board').length, 1);
  assert.equal(byId(shell, 'survivalBoard').length, 1);
  assert.equal(byId(shell, 'survivalMini').length, 1);
  assert.equal(byClass(shell, 'survival-preview').length, 1);
  const {h, grid} = fixture({count:4,capacity:4});
  assert.equal((h.get('#survivalScoreList').innerHTML.match(/class="survival-score-row /g) || []).length, 4);
  assert.equal(grid().children.length, 36);
  assert.equal(grid().children.every(cell => cell.tagName === 'BUTTON'), true);
  assert.equal(h.get('#survivalMini').children.length, 36);
  assert.equal(h.get('#survivalMini').children.every(cell => cell.tagName === 'SPAN' && cell.getAttribute('aria-readonly') === 'true'), true);
  h.state.notes.add(0); h.renderSurvival();
  assert.equal(grid().children[0].classList.contains('note'), true);
  assert.equal(h.get('#survivalMini').children.some(cell => cell.classList.contains('note')), false, 'the public preview never receives private marks');
});

for (const [width, height] of [[1280,720], [1366,768], [1920,1080]]) {
  test(`survival ${width}x${height} has explicit desktop width/height budgets (source arithmetic)`, () => {
    const arena = style(['#survivalArena'], width, height);
    assert.equal(arena['--survival-board-size'], 'clamp(288px, calc(100dvh - 340px), 560px)');
    assert.equal(arena['--survival-main-width'], 'calc(var(--survival-board-size) + 24px)');
    const board = Math.min(560, Math.max(288, height - 340));
    const main = board + 24, rail = px(arena['--survival-rail-width']), friends = px(arena['--survival-friends-width']);
    const gap = px(arena['--survival-layout-gap']);
    assert.ok(main + rail + friends + gap * 2 <= width - 32, 'three authored columns stay within the viewport inset');
    assert.equal(style(['.survival-match-layout'], width, height)['grid-template-columns'], 'var(--survival-main-width) var(--survival-rail-width) var(--survival-friends-width)');
    assert.equal(style(['.survival-board-stage'], width, height)['aspect-ratio'], '1');
    assert.equal(style(['.survival-board-card'], width, height).padding, '10px');
    assert.equal(style(['.survival-friends'], width, height)['grid-template-columns'], 'minmax(0, 1fr) 120px');
    // Ordinary one-line desktop content budget: header 76; connection 24;
    // player heading 56; board card 24 padding/border + 30 heading + 30 footer;
    // notice 21; explicit margins/padding 52. Fonts/wrapping still need a browser.
    const mainBudget = 12 + 76 + 8 + 24 + 10 + 56 + 8 + board + 24 + 30 + 30 + 8 + 21 + 16;
    const row = style(['#survivalArena button:not(.cell)', '#survivalArena .survival-score-row'], width, height);
    const list = style(['.survival-score-list'], width, height);
    const fourPlayers = 4 * px(row['min-height']) + 3 * px(list.gap);
    const friendsBudget = 12 + 76 + 8 + 24 + 10 + 28 + 31 + 4 + 10 + fourPlayers + 16;
    assert.ok(mainBudget <= height, `ordinary main-column budget is ${mainBudget}px`);
    assert.ok(friendsBudget <= height, `four-player list budget is ${friendsBudget}px`);
    assert.ok((board - 6 - 5) / 6 >= 44, 'all desktop cells retain at least a 44px arithmetic target');
    assert.equal(style(['body.is-survival #game'], width, height).overflow, 'visible');
  });
}

for (const width of [320,360,390,430]) {
  test(`survival ${width}px mobile keeps a full square and readable controls (source arithmetic)`, () => {
    const height = 900, arena = style(['#survivalArena'], width, height);
    assert.equal(arena.width, 'min(584px, calc(100% - 20px))');
    assert.equal(arena['--survival-board-size'], 'min(560px, calc(100vw - 44px))');
    const board = width - 44, card = width - 20;
    assert.equal(card - 2 * 10 - 2 * 2, board, 'the square fits exactly inside panel padding/borders');
    const sharedBoard = style(['.battle-board', '#survivalBoard'], width, height);
    const cell = (board - 2 * px(sharedBoard.padding) - 5 * px(sharedBoard.gap)) / 6;
    assert.ok(cell >= 44, `the 6x6 source cell budget is ${cell.toFixed(2)}px`);
    assert.equal(style(['.survival-match-layout'], width, height)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(style(['.survival-center-rail'], width, height)['grid-row'], '1');
    assert.equal(style(['.survival-main-board'], width, height)['grid-row'], '2');
    assert.equal(style(['.survival-friends'], width, height)['grid-row'], '3');
    assert.equal(style(['.survival-friends'], width, height)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(style(['.survival-preview'], width, height).width, '168px');
    assert.equal(style(['.survival-row-name > b'], width, height)['overflow-wrap'], 'anywhere');
    const control = style(['#survivalArena button:not(.cell)', '#survivalArena select'], width, height);
    assert.ok(px(control['min-height']) >= 44);
    assert.ok(px(control['font-size']) >= 16);
    if (width <= 380) assert.equal(style(['#survivalExit'], width, height)['grid-column'], '1 / -1', 'narrow toolbar gains a full second row instead of shrinking text');
    assert.equal(arena['max-height'], undefined, 'mobile content can continue down the page');
  });
}

test('functional labels stay at least 14px and body/action text at least 16px across mobile and desktop', () => {
  for (const width of [320,430,1280,1920]) {
    for (const selector of ['.survival-connection-row','.survival-seat-state','.survival-board-foot','.survival-board-notice','.survival-friends-caption','.survival-row-name > small','.survival-row-score small','.survival-follow-control label','.survival-preview > p','#survivalGestureHint .gesture-drag'])
      assert.ok(px(style([selector],width,900)['font-size']) >= 14, `${selector} at ${width}`);
    for (const selector of ['#survivalArena','.survival-soft','.survival-seat b','.survival-row-name > b','.survival-rules > p','.survival-final-rule p','#survivalGestureHint'])
      assert.ok(px(style([selector],width,900)['font-size']) >= 16, `${selector} at ${width}`);
  }
});

test('timer/score/follow updates preserve all local board cells and private marks', () => {
  const f = fixture({count:4,capacity:4}), {h,grid} = f;
  h.state.notes.add(0); h.renderSurvival();
  const nodes = [...grid().children], preview = [...h.get('#survivalMini').children];
  h.tick(1000); h.updateSurvivalTimers(); hit(f,1);
  assert.deepEqual([...grid().children], nodes);
  assert.deepEqual([...h.get('#survivalMini').children], preview, 'public reveals patch the existing preview cells');
  h.get('#survivalFollow').onchange({target:{value:'2'}});
  assert.deepEqual([...grid().children], nodes, 'choosing another preview never replaces the live input board');
  assert.equal(h.get('#survivalMini').dataset.player, '2');
  assert.equal(grid().children[0].classList.contains('note'), true);
});

test('elimination changes the main grid to public spans and followed-player changes replace only that view', () => {
  const f = fixture(), {h,authority,sync,grid} = f, oldCells = [...grid().children];
  h.state.notes.add(0); h.renderSurvival();
  authority.players[0].status = 'eliminated'; authority.players[0].reason = 'quota'; authority.revision++; sync();
  assert.equal(grid().getAttribute('aria-readonly'), 'true');
  assert.equal(grid().children.every(cell => cell.tagName === 'SPAN' && !cell.classList.contains('note')), true);
  assert.notStrictEqual(grid().children[0], oldCells[0]);
  assert.equal(h.get('#survivalPreview').classList.contains('hidden'), true, 'spectating retains just one visible public board');
  h.get('#survivalFollow').onchange({target:{value:'2'}});
  assert.equal(grid().dataset.player, '2');
  assert.equal(grid().dataset.boardId, authority.boards[2].puzzle.id);
  const cells = [...grid().children]; h.tick(500); sync();
  assert.deepEqual([...grid().children], cells);
});

test('fresh/replayed/out-of-order snapshots cannot replay capture sound or tabby effects', () => {
  const f = fixture({tabbyEnabled:true,fakeAudio:true}), {h} = f;
  const initial = json(h.state.game); tabby(f);
  assert.equal(h.get('#survivalFX').children.length, 1);
  const calls = json(sounds(h)), timers = [...ui(h).timers], current = json(h.state.game);
  h.renderSurvival(); h.applySurvivalSnapshot(current); h.renderSurvival();
  assert.equal(h.applySurvivalSnapshot(initial), false);
  assert.deepEqual(json(sounds(h)), calls);
  assert.deepEqual([...ui(h).timers], timers);
  const joined = makeHarness({fakeAudio:true});
  joined.state.survivalPlayerId = 'p1'; joined.state.survivalLinkStatus = 'connected';
  joined.applySurvivalSnapshot(current,{historical:true}); joined.renderSurvival();
  assert.equal(sounds(joined).length, 0);
  assert.equal(ui(joined).effects.size, 0);
  assert.equal(joined.get('#survivalFX').children.length, 0);
});

for (const interruption of ['background','reconnect','finished','aborted','leave']) {
  test(`${interruption} immediately clears live tabby timers/classes/nodes without replay`, () => {
    const f = fixture({tabbyEnabled:true,fakeAudio:true}), {h,authority,sync,grid} = f;
    tabby(f);
    const tracked = [...ui(h).effects], timerIDs = [...ui(h).timers], seen = [...ui(h).seen], cells = [...grid().children];
    assert.ok(tracked.length > 0 && timerIDs.length > 0);
    assert.equal(h.get('#survivalFX').children.length, 1);
    h.audio.calls.length = 0;
    if (interruption === 'background') { h.context.document.hidden=true; h.dispatchDocument('visibilitychange'); }
    else if (interruption === 'reconnect') vm.runInContext('survivalStatus({status:"reconnecting"})',h.context);
    else if (interruption === 'leave') h.disposeSurvivalRoom('test-leave');
    else { authority.status=interruption; authority.revision++; sync(); }
    assert.equal(ui(h).effects.size, 0);
    assert.equal(ui(h).timers.size, 0);
    assert.equal(h.get('#survivalFX').children.length, 0);
    assert.equal(tracked.some(({node,className})=>node.classList.contains(className)), false);
    assert.equal(timerIDs.some(id=>h.timers.has(id)), false);
    assert.ok(h.audio.calls.some(call=>call.method==='stopAll'), 'active or queued audio is also stopped');
    if (['background','reconnect'].includes(interruption)) {
      assert.deepEqual([...grid().children], cells, 'interruptions preserve existing input nodes');
      assert.ok(seen.every(id=>ui(h).seen.has(id)), 'interruptions preserve consumed event identities');
      if (interruption === 'background') { h.context.document.hidden=false; h.dispatchDocument('visibilitychange'); }
      else { vm.runInContext('survivalStatus({status:"connected"})',h.context); h.applySurvivalSnapshot(json(h.state.game),{historical:true}); h.renderSurvival(); }
      assert.equal(ui(h).effects.size, 0);
      assert.equal(sounds(h).some(sound=>['meow','boardClear'].includes(sound.kind)), false);
      h.tick(300); hit(f);
      assert.equal(sounds(h).filter(sound=>sound.kind==='meow').length, 1, 'new authoritative captures resume after synchronization');
    }
    h.tick(1600);
    assert.equal(ui(h).effects.size, 0);
    assert.equal(ui(h).timers.size, 0);
  });
}

test('changing the followed public board cancels the previous board burst before drawing the new view', () => {
  const f=fixture({tabbyEnabled:true}), {h,authority,sync,grid}=f;
  authority.players[0].status='eliminated'; authority.players[0].reason='quota'; authority.revision++; sync();
  assert.equal(grid().dataset.player,'1');
  tabby(f,1);
  const effects=[...ui(h).effects], timers=[...ui(h).timers], oldBoard=grid().dataset.boardId;
  assert.equal(h.get('#survivalFX').children.length,1);
  h.get('#survivalFollow').onchange({target:{value:'2'}});
  assert.equal(grid().dataset.player,'2'); assert.notEqual(grid().dataset.boardId,oldBoard);
  assert.equal(h.get('#survivalFX').children.length,0);
  assert.equal(ui(h).effects.size,0); assert.equal(ui(h).timers.size,0);
  assert.equal(effects.some(({node,className})=>node.classList.contains(className)),false);
  assert.equal(timers.some(id=>h.timers.has(id)),false);
});

test('rapid captures replace the existing glow timer so the older hit cannot truncate newer feedback', () => {
  const f=fixture(), {h,grid}=f;
  hit(f); h.tick(300); hit(f);
  assert.equal([...ui(h).effects].filter(effect=>effect.node===grid()&&effect.className==='survival-capture-glow').length,1);
  h.tick(599);
  assert.equal(grid().classList.contains('survival-capture-glow'),true);
  h.tick(1);
  assert.equal(grid().classList.contains('survival-capture-glow'),false);
  assert.equal(ui(h).effects.size,0); assert.equal(ui(h).timers.size,0);
});

for (const reducedMotion of [false,true]) {
  test(`tabby feedback expires and respects reduced motion ${reducedMotion}`, () => {
    const f = fixture({tabbyEnabled:true}), {h,grid} = f;
    h.context.matchMedia=()=>({matches:reducedMotion});
    const event=tabby(f), publicState=json(h.state.game);
    assert.equal(h.get('#survivalFX').children.length, reducedMotion ? 0 : 1);
    assert.equal(grid().classList.contains('survival-static-highlight'), reducedMotion);
    for (const index of event.blast.cells) assert.equal(grid().children[index].classList.contains('survival-blast-flash'), true);
    assert.ok(ui(h).effects.size <= 32);
    if (reducedMotion) {
      const reduced=style(['#survivalArena *'],1280,720,true);
      assert.equal(reduced.animation,'none'); assert.equal(reduced.transition,'none');
      assert.equal(style(['.survival-tabby-burst'],1280,720,true).display,'none');
    }
    h.tick(1500);
    assert.equal(ui(h).effects.size,0); assert.equal(ui(h).timers.size,0);
    assert.equal(h.get('#survivalFX').children.length,0);
    assert.deepEqual(json(h.state.game),publicState,'visual cleanup never applies game actions');
  });
}

test('survival mute persists, consumes a muted hit, and unmuting cannot replay it', () => {
  const f=fixture({fakeAudio:true}), {h}=f;
  h.get('#survivalMute').click();
  assert.equal(h.state.muted,true); assert.equal(h.context.localStorage.p2pMuted,'1');
  assert.equal(h.get('#survivalMute').getAttribute('aria-pressed'),'true');
  assert.equal(h.audio.getState().muted,true);
  hit(f);
  assert.equal(h.audio.getState().activeVoices,0);
  assert.ok(h.audio.getState().rememberedIds>0,'the audio controller consumes the event while muted');
  const before=json(sounds(h));
  h.get('#survivalMute').click(); h.renderSurvival();
  assert.equal(h.audio.getState().muted,false); assert.equal(h.context.localStorage.p2pMuted,'0');
  assert.deepEqual(json(sounds(h)),before);
  const restored=fixture({fakeAudio:true,local:{p2pMuted:'1'}}).h;
  assert.equal(restored.get('#survivalMute').getAttribute('aria-pressed'),'true');
  assert.equal(restored.audio.getState().contextCreated,false,'restoring settings never starts audio');
});
