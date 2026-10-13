'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');

test('classic entry exposes start, hint, replay, navigation and progress controls',()=>{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  for(const id of ['chooseClassic','classicGame','classicLevel','classicHint','classicReplay','classicPrev','classicNext','classicCompletion'])assert.match(html,new RegExp(`id="${id}"`),id);
  const scripts=[...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(match=>match[1].split('?')[0]);
  assert.ok(scripts.indexOf('classic-engine.js')<scripts.indexOf('classic-levels.js'));
  assert.ok(scripts.indexOf('classic-levels.js')<scripts.indexOf('classic-app.js'));
});

test('public connected-mode picker contains only 1V1 and four-seat survival',()=>{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const picker=html.match(/<select id="gameMode">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...picker.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]),['battle','survival']);
  assert.match(picker,/4 人大逃殺/);assert.match(picker,/最多四人/);
});

test('classic client reuses connected board primitives with isolated responsive styling',()=>{
  const app=fs.readFileSync(path.join(ROOT,'classic-app.js'),'utf8'),css=fs.readFileSync(path.join(ROOT,'classic.css'),'utf8');
  assert.match(app,/catClassicProgressV1/);assert.match(app,/progress\.boards/);assert.match(app,/progress\.completed/);
  assert.match(app,/CatClassic\.nextHint/);assert.match(app,/classicReplay/);assert.match(app,/classicNext/);
  assert.match(app,/className='cell classic-cell'/);assert.match(app,/class="cat-art/);assert.match(app,/CatCellGestures\.create/);assert.match(app,/CatBoardStrokes\.create/);assert.match(app,/indicesBetween/);assert.match(app,/document\.addEventListener\('pointermove',moveStroke/);assert.match(app,/onAdd:\(index,context\)=>setCross\(index,true/);assert.match(app,/classList\.add\('battle-header'\)/);assert.match(app,/classList\.add\('board-card'\)/);assert.match(app,/classList\.add\('battle-board'\)/);
  assert.match(css,/@media\(max-width:760px\)/);assert.match(css,/\.classic-layout\{grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/\.classic-game \.classic-board \.classic-cell/);assert.match(css,/body\.is-classic/);assert.match(css,/\.classic-board\.marking-stroke/);assert.match(css,/touch-action:pinch-zoom/);
});

test('classic lifecycle cancels gestures and hints never mutate or schedule a move',()=>{
  const app=fs.readFileSync(path.join(ROOT,'classic-app.js'),'utf8');
  const hint=app.match(/function showHint\(\)\{([\s\S]*?)\n\}/)[1];
  assert.doesNotMatch(hint,/state\.cats\.(?:add|delete)|state\.crosses\.(?:add|delete)|save\(|setTimeout/);
  assert.match(app,/function hide\(\)\{cancelGestures\(\);state\.viewEpoch\+\+/);
  assert.match(app,/function load\([^]*?cancelGestures\(\);state\.viewEpoch\+\+/);
  assert.match(app,/state\.strokes\?\.reset\(reason\)/);assert.match(app,/visibilitychange/);assert.match(app,/pointercancel/);assert.match(app,/lostcapture/);
  assert.match(app,/已恢復.*個標記/);assert.match(app,/全新關卡/);
});

test('classic entry makes new game and resume explicit without guessing legacy mark ownership',()=>{
  const app=fs.readFileSync(path.join(ROOT,'classic-app.js'),'utf8'),css=fs.readFileSync(path.join(ROOT,'classic.css'),'utf8');
  assert.match(app,/id="continueClassic"/);assert.match(app,/function startNew\(\)/);assert.match(app,/function resume\(\)/);
  assert.match(app,/localStorage\.removeItem\(storeKey\)/);assert.match(app,/確認清除並開始/);assert.match(app,/state\.newGameArmed/);
  assert.match(app,/facts\.hasProgress/);assert.match(app,/目前沒有可繼續的進度/);
  assert.match(css,/\.classic-entry\{/);assert.match(css,/\.classic-cell:is\(\.cat,\.note\)\{background-color:var\(--bg/);
});
