'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');

test('classic entry exposes start, hint, replay, navigation and progress controls',()=>{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  for(const id of ['chooseClassic','classicGame','classicLevel','classicHint','classicReplay','classicPrev','classicNext','classicCompletion'])assert.match(html,new RegExp(`id="${id}"`),id);
  const scripts=[...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(match=>match[1]);
  assert.ok(scripts.indexOf('classic-engine.js')<scripts.indexOf('classic-levels.js'));
  assert.ok(scripts.indexOf('classic-levels.js')<scripts.indexOf('classic-app.js'));
});

test('public connected-mode picker contains only 1V1 and four-seat survival',()=>{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const picker=html.match(/<select id="gameMode">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...picker.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]),['battle','survival']);
  assert.match(picker,/4 人大逃殺/);assert.match(picker,/最多四人/);
});

test('classic client persists boards and has a dedicated narrow-screen layout',()=>{
  const app=fs.readFileSync(path.join(ROOT,'classic-app.js'),'utf8'),css=fs.readFileSync(path.join(ROOT,'classic.css'),'utf8');
  assert.match(app,/catClassicProgressV1/);assert.match(app,/progress\.boards/);assert.match(app,/progress\.completed/);
  assert.match(app,/CatClassic\.nextHint/);assert.match(app,/classicReplay/);assert.match(app,/classicNext/);
  assert.match(css,/@media\(max-width:720px\)/);assert.match(css,/\.classic-layout\{grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/width:min\(92vw,590px\)/);
});
