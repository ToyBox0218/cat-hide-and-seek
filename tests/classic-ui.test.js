'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');

test('classic entry exposes start, hint, replay, navigation and progress controls',()=>{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  for(const id of ['chooseClassic','classicGame','classicLevel','classicHint','classicReplay','classicPrev','classicNext','classicCompletion','classicMute','classicResult','classicResultReplay','classicResultNext'])assert.match(html,new RegExp(`id="${id}"`),id);
  const scripts=[...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(match=>match[1].split('?')[0]);
  assert.ok(scripts.indexOf('classic-engine.js')<scripts.indexOf('classic-levels.js'));
  assert.ok(scripts.indexOf('classic-levels.js')<scripts.indexOf('classic-app.js'));
  assert.ok(scripts.indexOf('board-strokes.js')<scripts.indexOf('board-pointer-adapter.js'));
  assert.ok(scripts.indexOf('board-pointer-adapter.js')<scripts.indexOf('app.js'));
  assert.match(html,/classic\.css\?v=20261013e/);assert.match(html,/classic-app\.js\?v=20261013e/);assert.match(html,/app\.js\?v=20261013e/);
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
  assert.match(app,/className='cell classic-cell'/);assert.match(app,/class="cat-art/);assert.match(app,/CatCellGestures\.create/);assert.match(app,/CatBoardPointerAdapter\.create/);assert.match(app,/onAdd:\(index,context\)=>setCross\(index,true/);assert.match(app,/classList\.add\('battle-header'\)/);assert.match(app,/classList\.add\('board-card'\)/);assert.match(app,/classList\.add\('battle-board'\)/);
  assert.match(css,/@media\(max-width:760px\)/);assert.match(css,/\.classic-layout\{grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/\.classic-game \.classic-board \.classic-cell/);assert.match(css,/body\.is-classic/);assert.match(css,/\.classic-board\.marking-stroke/);assert.match(css,/touch-action:pinch-zoom/);
});

test('classic lifecycle cancels gestures and hints never mutate or schedule a move',()=>{
  const app=fs.readFileSync(path.join(ROOT,'classic-app.js'),'utf8');
  const hint=app.match(/function showHint\(\)\{([\s\S]*?)\n\}/)[1];
  assert.doesNotMatch(hint,/state\.cats\.(?:add|delete)|state\.crosses\.(?:add|delete)|save\(|setTimeout/);
  assert.match(app,/function hide\(\)\{closeResult\(\);cancelGestures\(\);state\.viewEpoch\+\+/);
  assert.match(app,/function load\([^]*?closeResult\(\);cancelGestures\(\);state\.viewEpoch\+\+/);
  assert.match(app,/state\.pointerAdapter\?\.reset\(reason\)/);assert.match(app,/visibilitychange/);assert.match(fs.readFileSync(path.join(ROOT,'board-pointer-adapter.js'),'utf8'),/pointercancel/);assert.match(fs.readFileSync(path.join(ROOT,'board-pointer-adapter.js'),'utf8'),/lostpointercapture/);
  assert.match(app,/已恢復.*個標記/);assert.match(app,/全新關卡/);
});

test('classic accessibility, completion and audio hooks are isolated from multiplayer mechanics',()=>{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8'),app=fs.readFileSync(path.join(ROOT,'classic-app.js'),'utf8'),css=fs.readFileSync(path.join(ROOT,'classic.css'),'utf8');
  assert.match(app,/aria-describedby/,'classic board describes operation and hint text');
  assert.match(app,/ArrowUp.*ArrowDown.*ArrowLeft.*ArrowRight/);
  assert.match(app,/CatGameAudioControls/);assert.match(app,/classicCue\('win'/);assert.match(app,/classicCue\('miss'/);
  assert.match(app,/showResult/);assert.match(html,/aria-labelledby="classicResultTitle"/);assert.match(css,/prefers-reduced-motion:reduce/);
  assert.doesNotMatch(app,/\bhp\b|opponent|damage|combo/i);
});

test('classic entry makes new game and resume explicit without guessing legacy mark ownership',()=>{
  const app=fs.readFileSync(path.join(ROOT,'classic-app.js'),'utf8'),css=fs.readFileSync(path.join(ROOT,'classic.css'),'utf8');
  assert.match(app,/id="continueClassic"/);assert.match(app,/function startNew\(\)/);assert.match(app,/function resume\(\)/);
  assert.match(app,/localStorage\.removeItem\(storeKey\)/);assert.match(app,/確認清除並開始/);assert.match(app,/state\.newGameArmed/);
  assert.match(app,/facts\.hasProgress/);assert.match(app,/目前沒有可繼續的進度/);
  assert.match(css,/\.classic-entry\{/);assert.match(css,/\.classic-cell:is\(\.cat,\.note\)\{background-color:var\(--bg/);
});
