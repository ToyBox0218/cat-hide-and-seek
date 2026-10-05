'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Battle = require('../battle-engine.js');

const players = [{nickname:'橘子',avatar:0,connected:true},{nickname:'奶油',avatar:1,connected:true}];
function game(hp = 500) { const value = Battle.create({hp},players); Battle.start(value,0); return value; }
let actionSequence = 0;
function guess(value, who, index, now, actionId) {
  return Battle.act(value,who,{type:'guess',boardId:value.boards[who].puzzle.id,
    index,actionId:actionId || `test-${++actionSequence}`},now);
}
function cat(value,who = 0) { return value.boards[who].puzzle.solution.find(index => !value.boards[who].found.includes(index)); }
function empty(value,who = 0) { return Array.from({length:36},(_,i) => i).find(index => !value.boards[who].puzzle.solution.includes(index) && !value.boards[who].misses.includes(index) && !Battle.isExcluded(value.boards[who],index)); }
function seeded(seed) { return () => { seed = Math.imul(seed,1664525)+1013904223; return (seed >>> 0)/0x100000000; }; }

// Independent reference solver: row-by-row DFS, not the engine's permutation table.
function solve(regions) {
  const solutions = [];
  function search(row,columns,usedRegions,answer) {
    if (row === 6) { solutions.push(answer); return; }
    for (let column = 0; column < 6; column++) {
      const cell = row*6+column, region = regions[cell];
      if (columns.has(column) || usedRegions.has(region) || (row && Math.abs(column-answer[row-1]%6) <= 1)) continue;
      search(row+1,new Set([...columns,column]),new Set([...usedRegions,region]),answer.concat(cell));
    }
  }
  search(0,new Set(),new Set(),[]);
  return solutions;
}
function assertConnectedRegions(puzzle) {
  for (let region = 0; region < 6; region++) {
    const members = puzzle.regions.reduce((out,id,index) => id === region ? out.concat(index) : out,[]);
    assert.ok(members.length >= 3);
    const seen = new Set([members[0]]), queue = [members[0]];
    for (let at = 0; at < queue.length; at++) {
      const cell = queue[at], row = Math.floor(cell/6), column = cell%6;
      for (const [r,c] of [[row-1,column],[row+1,column],[row,column-1],[row,column+1]]) {
        const next = r*6+c;
        if (r < 0 || r >= 6 || c < 0 || c >= 6 || seen.has(next) || puzzle.regions[next] !== region) continue;
        seen.add(next); queue.push(next);
      }
    }
    assert.equal(seen.size,members.length);
  }
}

test('UMD loads in a browser without Node or a DOM', () => {
  const context = {Math,Date,Map,Set,Uint32Array}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../battle-engine.js'),'utf8'),context);
  assert.equal(typeof context.CatBattle.create,'function');
  assert.equal(context.CatBattle.create().boards.length,2);
});

test('1,080 generated puzzles are connected, minimum-three regions, valid and uniquely solvable', () => {
  const rng = seeded(123456789), history = [], boards = [];
  const firstCycle = new Set(), geometries = new Set(), ids = new Set();
  for (let sample = 0; sample < 1080; sample++) {
    const puzzle = Battle.generatePuzzle({rng,avoidSolutions:history,avoidBoards:boards,currentSolutions:history.slice(-2)});
    assert.deepEqual(Battle.validatePuzzle(puzzle),{valid:true,errors:[],solutionCount:1});
    const solutions = solve(puzzle.regions);
    assert.equal(solutions.length,1); assert.deepEqual(solutions[0],puzzle.solution);
    assertConnectedRegions(puzzle);
    assert.ok(!ids.has(puzzle.id)); ids.add(puzzle.id);
    const key = Battle.solutionPattern(puzzle.solution), geometry = Battle.boardKey(puzzle.regions);
    if (sample < 90) { assert.ok(!firstCycle.has(key)); firstCycle.add(key); }
    assert.ok(!history.slice(-2).includes(key),'never repeats either current player pattern');
    assert.ok(!boards.includes(geometry),'never repeats recent region topology');
    history.push(key); boards.push(geometry); geometries.add(geometry);
    if (history.length > 90) history.shift(); if (boards.length > 90) boards.shift();
  }
  assert.equal(firstCycle.size,90); assert.ok(geometries.size > 800);
});

test('fresh opponents receive different answers and layouts across 100 games', () => {
  for (let sample = 0; sample < 100; sample++) {
    const value = Battle.create();
    assert.notEqual(Battle.solutionPattern(value.boards[0].puzzle.solution),Battle.solutionPattern(value.boards[1].puzzle.solution));
    assert.notEqual(Battle.boardKey(value.boards[0].puzzle.regions),Battle.boardKey(value.boards[1].puzzle.regions));
    assert.equal(value.status,'lobby');
  }
});

test('settings are always battle 6×6 and HP defaults / limits are authoritative', () => {
  assert.equal(Battle.create().players[0].maxHP,150);
  for (const [requested,expected] of [[-10,50],[0,50],[1,50],[49,50],[50,50],[225,225],[499,499],[900,500]]) {
    const value = Battle.create({maxHP:requested,size:24,mode:'items',hitCooldown:0});
    assert.deepEqual(value.settings,{mode:'battle',size:6,maxHP:expected,hp:expected});
    assert.deepEqual(value.players.map(p => [p.hp,p.maxHP]),[[expected,expected],[expected,expected]]);
  }
  assert.equal(Battle.create({hp:'abc'}).settings.hp,150);
});

test('damage progresses 5, 10, 15 … 35, 40 and combo/HP persist into next board', () => {
  const value = game(), original = value.boards[0].puzzle.id, opponentBoard = value.boards[1].puzzle.id;
  let damage = 0;
  for (let hit = 1; hit <= 8; hit++) {
    const result = guess(value,0,cat(value),hit*300);
    assert.equal(result.accepted,true); assert.equal(result.event.damage,5*hit);
    damage += 5*hit; assert.equal(value.players[1].hp,500-damage);
    assert.equal(value.players[0].hp,500); assert.equal(value.boards[0].combo,hit);
    assert.equal(value.boards[1].puzzle.id,opponentBoard);
    if (hit === 6) {
      assert.equal(result.event.advanced,true); assert.equal(value.boards[0].number,2);
      assert.notEqual(value.boards[0].puzzle.id,original); assert.deepEqual(value.boards[0].found,[]);
      assert.deepEqual(value.boards[0].misses,[]); assert.equal(value.boards[0].cooldownUntil,2100);
    }
  }
  assert.equal(value.players[1].hp,320); assert.equal(value.boards[0].found.length,2);
});

test('players act simultaneously with separate boards and cooldowns', () => {
  const value = game();
  assert.equal(guess(value,0,cat(value,0),1000).accepted,true);
  assert.equal(guess(value,1,cat(value,1),1000).accepted,true);
  assert.equal(value.players[0].hp,495); assert.equal(value.players[1].hp,495);
  assert.deepEqual(value.boards.map(b => b.combo),[1,1]);
  assert.equal(guess(value,0,cat(value,0),1299).reason,'cooldown');
  assert.equal(guess(value,0,cat(value,0),1300).accepted,true);
});

test('a miss marks its cell, resets only that player combo and applies exactly two seconds', () => {
  const value = game(); guess(value,0,cat(value),1000); guess(value,1,cat(value,1),1000);
  const health = value.players.map(p => p.hp), missed = empty(value);
  const result = guess(value,0,missed,1300);
  assert.equal(result.event.type,'miss'); assert.equal(result.event.damage,0);
  assert.deepEqual(value.players.map(p => p.hp),health);
  assert.deepEqual(value.boards.map(b => b.combo),[0,1]);
  assert.deepEqual(value.boards[0].misses,[missed]); assert.equal(value.boards[0].cooldownUntil,3300);
  assert.equal(guess(value,0,cat(value),3299).reason,'cooldown');
  assert.equal(guess(value,0,cat(value),3300).event.damage,5);
});

test('clearing all empty cells does not replace a board or award a victory', () => {
  const value = game(), original = value.boards[0].puzzle.id;
  const empties = Array.from({length:36},(_,i) => i).filter(i => !value.boards[0].puzzle.solution.includes(i));
  empties.forEach((index,i) => assert.equal(guess(value,0,index,i*2000).accepted,true));
  assert.equal(value.boards[0].puzzle.id,original); assert.equal(value.boards[0].number,1);
  assert.equal(value.boards[0].found.length,0); assert.equal(value.boards[0].misses.length,30);
  assert.equal(value.status,'playing'); assert.equal(value.players[1].hp,500);
});

test('first lethal arrival wins; HP clamps to zero and later competing hits cannot damage', () => {
  const value = game(50);
  for (let i = 1; i <= 3; i++) {
    guess(value,0,cat(value,0),i*300); guess(value,1,cat(value,1),i*300);
  }
  assert.deepEqual(value.players.map(p => p.hp),[20,20]);
  const winning = guess(value,1,cat(value,1),1200);
  assert.equal(winning.accepted,true); assert.equal(value.status,'finished'); assert.equal(value.winner,1);
  const after = guess(value,0,cat(value,0),1200);
  assert.equal(after.reason,'not-playing'); assert.deepEqual(value.players.map(p => p.hp),[0,20]);
  assert.equal(Battle.reconnect(value,1500),false); assert.equal(Battle.abort(value,1500),false);
});

test('invalid messages, invalid actors and missing board/action IDs never change authority state', () => {
  const value = game(), boardId = value.boards[0].puzzle.id, index = cat(value);
  const baseline = JSON.stringify(value);
  const badActions = [null,{}, {type:'item',actionId:'a',boardId,index}, {type:'guess',boardId,index},
    {type:'guess',actionId:'',boardId,index}, {type:'guess',actionId:'x'.repeat(129),boardId,index},
    {type:'guess',actionId:'a',index}, {type:'guess',actionId:'a',boardId:'old',index},
    ...[-1,36,2.5,'2',NaN,Infinity,null].map(cell => ({type:'guess',actionId:'a',boardId,index:cell}))];
  for (const action of badActions) assert.equal(Battle.act(value,0,action,1000).accepted,false);
  for (const who of [-1,2,'0',null,undefined]) assert.equal(Battle.act(value,who,{type:'guess',actionId:'a',boardId,index},1000).accepted,false);
  for (const time of [NaN,Infinity,-1,'1000']) assert.equal(Battle.act(value,0,{type:'guess',actionId:'a',boardId,index},time).accepted,false);
  assert.equal(JSON.stringify(value),baseline);
});

test('client claims cannot select the opponent board or set damage/HP/combo', () => {
  const value = game();
  const action = {type:'guess',actionId:'untrusted',boardId:value.boards[1].puzzle.id,index:cat(value,1),damage:999,hp:0,combo:99};
  assert.equal(Battle.act(value,0,action,0).reason,'stale-board');
  action.boardId = value.boards[0].puzzle.id; action.index = cat(value);
  assert.equal(Battle.act(value,0,action,0).event.damage,5); assert.equal(value.players[1].hp,495);
});

test('duplicate IDs, repeated cells, and replay after board replacement cannot double-damage', () => {
  const value = game(), oldId = value.boards[0].puzzle.id;
  const first = {type:'guess',actionId:'same',boardId:oldId,index:cat(value)};
  assert.equal(Battle.act(value,0,first,0).accepted,true);
  assert.equal(Battle.act(value,0,first,300).reason,'duplicate');
  assert.equal(Battle.act(value,0,{...first,index:cat(value)},300).reason,'duplicate');
  assert.equal(Battle.act(value,0,{...first,actionId:'other'},300).reason,'resolved-cell');
  for (let i = 1; i < 6; i++) guess(value,0,cat(value),i*300);
  assert.notEqual(value.boards[0].puzzle.id,oldId);
  const hp = value.players[1].hp;
  assert.equal(Battle.act(value,0,first,2000).reason,'stale-board'); assert.equal(value.players[1].hp,hp);
  // The host-supplied player index scopes IDs, so coincidental peer IDs are harmless.
  assert.equal(guess(value,1,cat(value,1),2000,'same').accepted,true);
});

test('replay defense remains bounded and safe after recent action ID eviction', () => {
  const value = game(); let at = 0;
  const first = {type:'guess',actionId:'first-ever',boardId:value.boards[0].puzzle.id,index:cat(value)};
  Battle.act(value,0,first,at); at += 300;
  // Many misses reset combo and slow damage, allowing >256 real accepted actions.
  for (let board = 0; board < 8; board++) {
    const targetId = value.boards[0].puzzle.id;
    while (value.boards[0].puzzle.id === targetId) {
      let miss = empty(value);
      if (miss !== undefined) {
        assert.equal(guess(value,0,miss,at).accepted,true); at += 2000;
        if (empty(value) !== undefined) continue;
      }
      assert.equal(guess(value,0,cat(value),at).accepted,true); at += 300;
      // Reset each hit using a second player's miss is not enough: combo belongs
      // to this board. Keep target alive for a replay stress test without altering
      // any replay or puzzle data, and separately verify real HP rules above.
      value.players[1].hp = 500;
    }
  }
  assert.equal(value.actionIds.length,Battle.constants.ACTION_HISTORY_LIMIT);
  assert.ok(!value.actionIds.includes('0:first-ever'));
  const hp = value.players[1].hp;
  assert.equal(Battle.act(value,0,first,at).reason,'stale-board'); assert.equal(value.players[1].hp,hp);
  assert.ok(value._boardActions.every(ids => ids.length <= 36));
});

test('pause freezes both cooldowns and all progress; reconnect restores remaining time', () => {
  const value = game(); guess(value,0,cat(value),1000); guess(value,1,empty(value,1),1000);
  const snapshot = JSON.stringify(value.boards.map(({puzzle,found,misses,number,combo}) => ({puzzle,found,misses,number,combo})));
  assert.equal(Battle.pause(value,1100),true); assert.equal(value.status,'paused');
  assert.equal(guess(value,0,cat(value),10000).reason,'not-playing');
  assert.equal(Battle.pause(value,1200),false);
  assert.equal(Battle.reconnect(value,20000),true); assert.equal(value.status,'playing');
  assert.deepEqual(value.boards.map(b => b.cooldownUntil),[20200,21900]);
  assert.equal(JSON.stringify(value.boards.map(({puzzle,found,misses,number,combo}) => ({puzzle,found,misses,number,combo}))),snapshot);
  assert.equal(guess(value,0,cat(value),20199).reason,'cooldown');
  assert.equal(guess(value,0,cat(value),20200).event.damage,10);
});

test('authority can resume after JSON persistence without dropping replay protection', () => {
  const original = game(); guess(original,0,cat(original),1000,'persist-me'); Battle.pause(original,1100);
  const restored = JSON.parse(JSON.stringify(original)); Battle.reconnect(restored,20000);
  const action = {type:'guess',actionId:'persist-me',boardId:restored.boards[0].puzzle.id,index:cat(restored)};
  assert.equal(Battle.act(restored,0,action,20300).reason,'duplicate');
  assert.equal(guess(restored,0,cat(restored),20300).event.damage,10);
});

test('abort is terminal, preserves progress and does not award either player a win', () => {
  const value = game(); guess(value,0,cat(value),0);
  const hp = value.players.map(p => p.hp); Battle.pause(value,100);
  assert.equal(Battle.abort(value,61000,'reconnect-timeout'),true);
  assert.equal(value.status,'aborted'); assert.equal(value.winner,null); assert.equal(value.lastEvent.reason,'reconnect-timeout');
  assert.equal(Battle.reconnect(value,62000),false); assert.equal(Battle.start(value,62000),false);
  assert.equal(guess(value,1,cat(value,1),62000).accepted,false); assert.deepEqual(value.players.map(p => p.hp),hp);
});

test('public snapshot whitelists nested fields and has no solutions, histories, or action IDs', () => {
  const value = game(); guess(value,0,cat(value),1000);
  value.secret = 'private'; value.players[0].notes = ['private']; value.boards[0].secret = 'private';
  value.boards[0].puzzle.secret = 'private'; value.lastEvent.solution = [1,2,3];
  const pub = Battle.publicGame(value,43210), json = JSON.stringify(pub);
  assert.equal(pub.serverTime,43210); assert.equal(pub.boards.length,2);
  for (const forbidden of ['solution','actionIds','_boardActions','_history','private','notes','secret']) assert.ok(!json.includes(forbidden),forbidden);
  assert.deepEqual(pub.boards[0].found,value.boards[0].found); assert.deepEqual(pub.boards[1].puzzle.regions,value.boards[1].puzzle.regions);
  pub.boards[0].puzzle.regions[0] = 99; pub.boards[0].found.push(99); pub.players[0].hp = 0;
  assert.notEqual(value.boards[0].puzzle.regions[0],99); assert.ok(!value.boards[0].found.includes(99)); assert.equal(value.players[0].hp,500);
  assert.equal(Battle.act(Battle.publicGame(value),0,{type:'guess',actionId:'x',boardId:value.boards[0].puzzle.id,index:cat(value)},2000).reason,'not-authority');
});

test('validator rejects disconnected / too-small regions, touching cats, and ambiguous boards', () => {
  const valid = Battle.generatePuzzle({rng:seeded(44)});
  const missing = {...valid,regions:valid.regions.slice(1)}; assert.equal(Battle.validatePuzzle(missing).valid,false);
  const badLabels = {...valid,regions:valid.regions.map(() => 0)}; assert.equal(Battle.validatePuzzle(badLabels).valid,false);
  const touching = {...valid,solution:[0,7,14,21,28,35]}; assert.equal(Battle.validatePuzzle(touching).valid,false);
  const ambiguous = {size:6,regions:Array.from({length:36},(_,i) => Math.floor(i/6)),solution:valid.solution};
  assert.equal(Battle.validatePuzzle(ambiguous).valid,false); assert.equal(Battle.validatePuzzle(ambiguous).solutionCount,2);
});


test('auto-excluded cells cannot become misses or reset a combo', () => {
  const value = game(); guess(value,0,cat(value),0);
  const board = value.boards[0], blocked = Array.from({length:36},(_,i) => i).filter(i => !board.found.includes(i) && Battle.isExcluded(board,i));
  const snapshot = JSON.stringify(value);
  assert.ok(blocked.length > 0);
  for (const index of blocked) assert.equal(guess(value,0,index,300).reason,'excluded-cell');
  assert.equal(JSON.stringify(value),snapshot);
});

test('a disconnected player blocks guesses from either player until connection resumes', () => {
  const value = game(); value.players[1].connected = false;
  const snapshot = JSON.stringify(value);
  assert.equal(guess(value,0,cat(value),300).reason,'disconnected');
  assert.equal(guess(value,1,cat(value,1),300).reason,'disconnected');
  assert.equal(JSON.stringify(value),snapshot);
  value.players[1].connected = true;
  assert.equal(guess(value,0,cat(value),300).accepted,true);
});


test('a deterministic RNG still cannot repeat recent geometry after exhausting 90 patterns', () => {
  const history = [], boards = [];
  for (let i = 0; i < 270; i++) {
    const puzzle = Battle.generatePuzzle({rng:() => 0,avoidSolutions:history,avoidBoards:boards,currentSolutions:history.slice(-2)});
    const key = Battle.solutionPattern(puzzle.solution), shape = Battle.boardKey(puzzle.regions);
    assert.ok(!history.slice(-2).includes(key)); assert.ok(!boards.includes(shape));
    history.push(key); boards.push(shape);
    if (history.length > 90) history.shift(); if (boards.length > 90) boards.shift();
  }
});

test('rematches can inherit puzzle history without inheriting progress or private action data', () => {
  const previous = game(); guess(previous,0,cat(previous),0,'old-action');
  const previousPatterns = previous._history.patterns.slice(), next = Battle.create(previous.settings,previous.players,previous);
  assert.equal(next.status,'lobby'); assert.deepEqual(next.players.map(p => p.hp),[500,500]);
  assert.deepEqual(next.boards.map(b => b.combo),[0,0]); assert.deepEqual(next.actionIds,[]);
  assert.ok(next.boards.every(b => !previousPatterns.includes(Battle.solutionPattern(b.puzzle.solution))));
  assert.equal(next._history.patterns.length,previousPatterns.length+2);
  assert.equal(previous._history.patterns.length,previousPatterns.length);
});
