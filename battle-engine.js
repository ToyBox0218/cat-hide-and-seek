/* Cat battle authority and independently generated 6×6 puzzles. No DOM or transport. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatBattle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SIZE = 6, CELLS = SIZE * SIZE, HIT_COOLDOWN = 300, MISS_COOLDOWN = 2000, OPENING_COUNTDOWN = 3000;
  const MISS_COOLDOWN_STEP = 2000, MAX_MISS_COOLDOWN = 8000;
  const HISTORY_LIMIT = 90, ACTION_HISTORY_LIMIT = 256;
  // Verified fallback seeds. Fresh boards first grow all six regions from scratch.
  // Only seeds with a non-guess logical proof enter the fallback catalog; their
  // transforms still cover all 90 mathematically possible answer patterns.
  const BASES = [
    '024135:000111031111331121331422333445333555',
    '024153:000122001122333324333344333354333555',
    '025314:000111001122001322001322443325444555',
    '031425:000133221133321133333335344445344455',
    '031524:001111021111021111421113444433445555',
    '041352:000111022111022111222334222534225544',
    '042513:000001022211022223042223044453445555',
    '042531:000000000111002111222433225443255544',
    '053142:000000000001000211035241335244335544',
    '130425:200011220113222133244435244435444445',
    '130524:200011201111224443444453444453444455',
    '135024:000012301112333522334555444555445555',
    '135042:000011001111001122300142335444335555',
    '135204:002222001122001122333112445512445555',
    '135240:300012301112333312333342553344553333',
    '140253:000011220011220011223354223554222554',
    '140352:000011000011200031225334225554225554',
    '142035:001111300111302211332411333445333555',
    '142053:001111011111022111322211355444355554',
    '142530:500011502213502233552433555444555544',
    '152403:000011022111442331442335455555455555',
    '153024:003111033111332221332555344555345555',
    '153042:002211032221332222322222522544555544',
    '203514:110003112223444223444423444455444555',
    '204135:000222110222133322334444344445344555',
    '204153:100022111322333322333344333354333554',
    '205314:000000100000110022144332445322445552',
    '240351:000011231111233331233331533334553444',
    '240513:000011201111201113221113444553555533',
    '240531:200000200013222013222113224444255544',
    '241350:200000222111523144553334555444555555',
    '241503:000111220113220333444553455555555555',
    '250413:220001222231222231244533244553444553',
    '251304:000011022001422333442333443335444455',
    '251403:220001222221222231422233422255442555',
    '253041:330021330221330221355544355544555555',
    '253140:330001330211332211534444544444555544',
    '302415:100033112233112233444335443355443355',
    '302514:110033110333222333444333444553444553',
    '304152:110022100022132222332224552224555244',
    '304251:110000100022332222333224553224553224',
    '305142:000002122022132222132222335442555544',
    '314025:111002111022111022333425334445333445',
    '314052:111000111022311124313554333554335544',
    '315024:110002110222110222333222344452355552',
    '315042:110002111122333332354442555544555554',
    '315240:110002511302553332553342553344555554',
    '350241:200011201111203444553444553444553444',
    '351402:000001000301225331425331445531555331',
    '351420:200011220111222333243333544333555333',
    '352041:000001000001022011322411355444355444',
    '402531:000000100000112233112233112433555444',
    '403152:000000112200132240133444555554555554',
    '413025:111005311005322205342555444555445555',
    '413502:111000111200111222111223444233455533',
    '413520:114200114200554223554233554443555444',
    '415203:111100111100111302443322443355443555',
    '415302:110000111111111122143322445322455322',
    '420315:221100211110223333443333443355333335',
    '420351:000000221100221111222341223344255554',
    '420513:100000111000224003244003445553555553',
    '420531:111000111110211110224133544443555444',
    '425031:111002111002111022334022354422355444',
    '425130:330002311112333412534444555444554444',
    '502413:333330113330122330122333142533144555',
    '503142:222200122220112222135222335442555444',
    '513042:110000312222332244333444555445555555',
    '514203:111000112220422220433522443522445522',
    '524031:111100111120111120334422354424355444',
    '524130:111100111220331120534444554444554444',
    '530241:222000223110223133223334255444554444',
    '531402:221000221110221333443333453333455333',
    '531420:222200222110222110222330254430554440'
  ];

  const NEIGHBORS = Array.from({length: CELLS}, (_, index) => {
    const row = Math.floor(index / SIZE), column = index % SIZE;
    return [[row-1,column],[row+1,column],[row,column-1],[row,column+1]]
      .filter(([r,c]) => r >= 0 && r < SIZE && c >= 0 && c < SIZE)
      .map(([r,c]) => r * SIZE + c);
  });
  const ANSWERS = [];
  (function enumerate(columns, used) {
    if (columns.length === SIZE) { ANSWERS.push(columns.map((column,row) => row * SIZE + column)); return; }
    for (let column = 0; column < SIZE; column++) {
      if (!(used & (1 << column)) && (!columns.length || Math.abs(column-columns[columns.length-1]) > 1)) {
        enumerate(columns.concat(column), used | (1 << column));
      }
    }
  })([], 0);

  let sequence = 0, catalog;
  function random() {
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      return root.crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
    }
    return Math.random();
  }
  function pick(values, rng) { return values[Math.min(values.length-1, Math.max(0, Math.floor(rng() * values.length)))]; }
  function shuffled(values, rng) {
    const copy = values.slice();
    for (let i = copy.length-1; i > 0; i--) {
      const j = Math.min(i, Math.max(0, Math.floor(rng() * (i+1))));
      [copy[i],copy[j]] = [copy[j],copy[i]];
    }
    return copy;
  }
  function uniqueId(prefix) { return `${prefix}-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.floor(random()*0x100000000).toString(36)}`; }
  function pattern(solution) { return solution.slice().sort((a,b) => a-b).map(index => index % SIZE).join(''); }
  function boardKey(regions) {
    const labels = new Map();
    return regions.map(region => {
      if (!labels.has(region)) labels.set(region, labels.size);
      return labels.get(region);
    }).join('');
  }
  function transformedIndex(index, symmetry) {
    let row = Math.floor(index / SIZE), column = index % SIZE;
    if (symmetry >= 4) column = SIZE-1-column;
    for (let turn = 0; turn < symmetry % 4; turn++) [row,column] = [column,SIZE-1-row];
    return row * SIZE + column;
  }
  // These are per loaded engine, shared by battle and survival, including quick
  // rematches. They are deliberately absent from game state and public snapshots.
  // A page reload starts a fresh history; nothing is persisted or sent to guests.
  const recentPatterns = [], recentGeometry = [], geometryCache = new Map();
  const GROWTH_ATTEMPTS = 16, REPAIR_STEPS = 256, FALLBACK_ATTEMPTS = 24;
  let generationSequence = 0;
  function generationRandom(source) {
    const entropy = Number(source());
    let state = ((Number.isFinite(entropy) ? Math.floor(entropy * 0x100000000) : 0) ^ Math.imul(++generationSequence,0x9e3779b9)) >>> 0;
    // Seed once, instead of asking crypto for every cell. The call counter also
    // prevents a stuck/deterministic entropy source from repeating one geometry.
    return function () {
      state += 0x6d2b79f5;
      let value = Math.imul(state ^ state >>> 15,state | 1);
      value ^= value + Math.imul(value ^ value >>> 7,value | 61);
      return ((value ^ value >>> 14) >>> 0) / 0x100000000;
    };
  }
  const TRANSFORMS = Array.from({length:8}, (_,symmetry) => Array.from({length:CELLS}, (_,cell) => transformedIndex(cell,symmetry)));
  function geometry(regions) {
    const key = boardKey(regions);
    if (geometryCache.has(key)) return geometryCache.get(key);
    let topology = null;
    const boundaries = TRANSFORMS.map(transform => {
      const values = Array(CELLS); regions.forEach((region,cell) => { values[transform[cell]] = region; });
      const normalized = boardKey(values);
      if (topology === null || normalized < topology) topology = normalized;
      let low = 0, high = 0, edge = 0;
      for (let cell = 0; cell < CELLS; cell++) {
        for (const next of [cell % SIZE < SIZE-1 ? cell+1 : -1,cell < CELLS-SIZE ? cell+SIZE : -1]) {
          if (next < 0) continue;
          if (values[cell] !== values[next]) {
            if (edge < 32) low |= 1 << edge; else high |= 1 << (edge-32);
          }
          edge++;
        }
      }
      return [low,high];
    });
    const result = {topology,boundaries};
    if (geometryCache.size >= 384) geometryCache.delete(geometryCache.keys().next().value);
    geometryCache.set(key,result); return result;
  }
  function popcount(value) {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  function geometryDistance(one,two) {
    const fixed = two.boundaries[0];
    return Math.min(...one.boundaries.map(bits => popcount(bits[0] ^ fixed[0]) + popcount(bits[1] ^ fixed[1])));
  }
  /** A bounded, non-guess proof using only the visible region map.
   * Each row, column and region contains one cat. If every remaining place for
   * that cat conflicts with a cell, that cell is empty. This covers singles,
   * region/line locks and shared adjacency exclusions; there is no trial cat,
   * answer-table lookup, contradiction search or hidden answer in this solver.
   */
  function solveLogically(regions, record) {
    if (!Array.isArray(regions) || regions.length !== CELLS || regions.some(region => !Number.isInteger(region) || region < 0 || region >= SIZE)) {
      return {solved:false,steps:[]};
    }
    const groups = Array.from({length:SIZE*3}, () => []), active = Array(CELLS).fill(true);
    const conflicts = Array.from({length:CELLS}, () => new Uint8Array(CELLS));
    for (let cell = 0; cell < CELLS; cell++) {
      const row = Math.floor(cell/SIZE), column = cell%SIZE;
      groups[row].push(cell); groups[SIZE+column].push(cell); groups[SIZE*2+regions[cell]].push(cell);
      for (let other = 0; other < CELLS; other++) {
        if (cell === other) continue;
        const r = Math.floor(other/SIZE), c = other%SIZE;
        if (row === r || column === c || regions[cell] === regions[other] || (Math.abs(row-r) <= 1 && Math.abs(column-c) <= 1)) conflicts[cell][other] = 1;
      }
    }
    const steps = [];
    // Each productive pass removes a cell, so 36 passes are a strict upper bound.
    for (let pass = 0; pass < CELLS; pass++) {
      let changed = false;
      for (let group = 0; group < groups.length; group++) {
        const candidates = groups[group].filter(cell => active[cell]), excluded = [];
        if (!candidates.length) return {solved:false,steps};
        for (let cell = 0; cell < CELLS; cell++) {
          if (active[cell] && candidates.every(other => conflicts[cell][other])) {
            active[cell] = false; excluded.push(cell); changed = true;
          }
        }
        if (record && excluded.length) steps.push({kind:group < SIZE ? 'row' : group < SIZE*2 ? 'column' : 'region',group:group%SIZE,candidates,excluded});
      }
      if (!changed) break;
    }
    return {solved:active.filter(Boolean).length === SIZE && groups.every(group => group.filter(cell => active[cell]).length === 1),steps};
  }
  function growRegions(solution,rng) {
    const regions = Array(CELLS).fill(-1), counts = Array(SIZE).fill(1);
    solution.forEach((cell,region) => { regions[cell] = region; });
    const weights = Array.from({length:SIZE}, () => 0.5 + rng()*1.5);
    for (let filled = SIZE; filled < CELLS; filled++) {
      const frontier = []; let total = 0;
      for (let cell = 0; cell < CELLS; cell++) if (regions[cell] < 0) {
        for (const neighbor of NEIGHBORS[cell]) if (regions[neighbor] >= 0) {
          const region = regions[neighbor], weight = weights[region] * (counts[region] < 3 ? 5 : 1) / (counts[region] > 9 ? 4 : 1);
          frontier.push({cell,region,weight}); total += weight;
        }
      }
      let draw = rng()*total, selected = frontier[frontier.length-1];
      for (const entry of frontier) { draw -= entry.weight; if (draw <= 0) { selected = entry; break; } }
      regions[selected.cell] = selected.region; counts[selected.region]++;
    }
    if (counts.some(count => count < 3)) return null;
    const cats = new Set(solution); let alternatives = countSolutions(regions);
    // Repair a fresh connected partition, not a rotated or recolored template.
    // Retain only moves that preserve its cats and do not add competing answers.
    for (let attempt = 0; attempt < REPAIR_STEPS && alternatives > 1; attempt++) {
      const cell = Math.floor(rng()*CELLS), source = regions[cell], target = regions[pick(NEIGHBORS[cell],rng)];
      if (cats.has(cell) || source === target || counts[source] <= 3) continue;
      regions[cell] = target;
      if (!regionConnected(regions,source)) { regions[cell] = source; continue; }
      const next = countSolutions(regions);
      if (next > alternatives) { regions[cell] = source; continue; }
      alternatives = next; counts[source]--; counts[target]++;
    }
    return alternatives === 1 && solveLogically(regions).solved ? regions : null;
  }

  function getCatalog() {
    if (catalog) return catalog;
    catalog = new Map();
    for (const encoded of BASES) {
      const [columns, cells] = encoded.split(':');
      const baseSolution = Array.from(columns, (column,row) => row*SIZE + Number(column));
      if (!solveLogically(Array.from(cells,Number)).solved) continue;
      for (let symmetry = 0; symmetry < 8; symmetry++) {
        const regions = Array(CELLS), solution = baseSolution.map(index => transformedIndex(index,symmetry)).sort((a,b) => a-b);
        Array.from(cells, Number).forEach((region,index) => { regions[transformedIndex(index,symmetry)] = region; });
        const key = pattern(solution);
        if (!catalog.has(key)) catalog.set(key, []);
        const bucket = catalog.get(key);
        if (!bucket.some(entry => boardKey(entry.regions) === boardKey(regions))) bucket.push({regions,solution});
      }
    }
    return catalog;
  }
  function countSolutions(regions, limit) {
    let count = 0;
    for (const answer of ANSWERS) {
      let seen = 0;
      for (const index of answer) seen |= 1 << regions[index];
      if (seen === (1 << SIZE)-1 && ++count >= (limit || Infinity)) break;
    }
    return count;
  }
  function regionConnected(regions, region) {
    const cells = regions.reduce((out,value,index) => value === region ? out.concat(index) : out, []);
    if (!cells.length) return false;
    const seen = new Set([cells[0]]), queue = [cells[0]];
    for (let head = 0; head < queue.length; head++) {
      for (const next of NEIGHBORS[queue[head]]) {
        if (regions[next] === region && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return seen.size === cells.length;
  }
  function validatePuzzle(puzzle) {
    const errors = [];
    if (!puzzle || puzzle.size !== SIZE || !Array.isArray(puzzle.regions) || puzzle.regions.length !== CELLS) {
      return {valid:false, errors:['Puzzle must have a 6×6 region grid.'], solutionCount:0};
    }
    const regions = puzzle.regions;
    if (regions.some(region => !Number.isInteger(region) || region < 0 || region >= SIZE)) {
      return {valid:false, errors:['Region labels must be integers 0–5.'], solutionCount:0};
    }
    for (let region = 0; region < SIZE; region++) {
      if (regions.filter(value => value === region).length < 3) errors.push(`Region ${region} has fewer than three cells.`);
      if (!regionConnected(regions,region)) errors.push(`Region ${region} is disconnected.`);
    }
    const solution = puzzle.solution;
    if (!Array.isArray(solution) || solution.length !== SIZE || solution.some(index => !Number.isInteger(index) || index < 0 || index >= CELLS)) {
      errors.push('Puzzle must provide six valid answer cells.');
    } else {
      const rows = new Set(solution.map(index => Math.floor(index/SIZE)));
      const columns = new Set(solution.map(index => index%SIZE));
      const groups = new Set(solution.map(index => regions[index]));
      if (rows.size !== SIZE || columns.size !== SIZE || groups.size !== SIZE) errors.push('Answers must use every row, column and region exactly once.');
      for (let a = 0; a < solution.length; a++) for (let b = a+1; b < solution.length; b++) {
        if (Math.abs(Math.floor(solution[a]/SIZE)-Math.floor(solution[b]/SIZE)) <= 1 && Math.abs(solution[a]%SIZE-solution[b]%SIZE) <= 1) {
          errors.push('Answer cats touch in the eight-neighbor neighborhood.');
        }
      }
    }
    const solutionCount = countSolutions(regions,2);
    if (solutionCount !== 1) errors.push('Puzzle does not have exactly one solution.');
    else if (!solveLogically(regions).solved) errors.push('Puzzle lacks a non-guess logical deduction proof.');
    return {valid:errors.length === 0, errors, solutionCount};
  }
  function varyRegions(base, rng) {
    const regions = base.regions.slice(), cats = new Set(base.solution);
    const counts = Array.from({length:SIZE}, (_,region) => regions.filter(value => value === region).length);
    // A boundary cell may move only if both regions remain connected, each keeps
    // at least three cells, the intended cats stay in their regions, and the
    // exhaustive 90-permutation solver still finds exactly one answer.
    for (let attempt = 0; attempt < 48; attempt++) {
      const cell = Math.min(CELLS-1, Math.max(0, Math.floor(rng()*CELLS)));
      const source = regions[cell], target = regions[pick(NEIGHBORS[cell],rng)];
      if (cats.has(cell) || source === target || counts[source] <= 3) continue;
      regions[cell] = target;
      if (!regionConnected(regions,source) || countSolutions(regions,2) !== 1) { regions[cell] = source; continue; }
      counts[source]--; counts[target]++;
    }
    const labels = shuffled([0,1,2,3,4,5],rng);
    return regions.map(region => labels[region]);
  }
  /** Bounded generation; caller history and same-page history both avoid repeats.
   * Exact region topology is compared modulo labels, rotations and reflections.
   * We also choose the least similar of independently grown candidates by actual
   * internal boundary edits, rather than treating color changes as new puzzles.
   */
  function generatePuzzle(options) {
    options = Array.isArray(options) ? {avoidSolutions:options} : options || {};
    const rng = generationRandom(typeof options.rng === 'function' ? options.rng : random);
    const history = Array.isArray(options.avoidSolutions) ? options.avoidSolutions : [];
    const forbidden = new Set(options.currentSolutions || []), byPattern = getCatalog();
    const available = Array.from(byPattern.keys()).filter(key => !forbidden.has(key));
    if (!available.length) throw new Error('No eligible answer pattern remains.');
    let eligible = available.filter(key => !history.includes(key));
    if (!eligible.length) {
      const oldest = Math.min(...available.map(key => history.lastIndexOf(key)));
      eligible = available.filter(key => history.lastIndexOf(key) === oldest);
    }
    const fresh = eligible.filter(key => !recentPatterns.includes(key));
    if (fresh.length) eligible = fresh;
    else {
      const oldest = Math.min(...eligible.map(key => recentPatterns.lastIndexOf(key)));
      eligible = eligible.filter(key => recentPatterns.lastIndexOf(key) === oldest);
    }
    const key = pick(eligible,rng), variants = byPattern.get(key), solution = variants[0].solution.slice();
    const avoided = recentGeometry.slice(), avoidedTopologies = new Set(avoided.map(entry => entry.topology));
    for (const encoded of options.avoidBoards || []) if (typeof encoded === 'string' && /^[0-5]{36}$/.test(encoded)) {
      const entry = geometry(Array.from(encoded,Number));
      if (!avoidedTopologies.has(entry.topology)) { avoided.push(entry); avoidedTopologies.add(entry.topology); }
    }
    let best = null, bestDistance = -1;
    function consider(regions) {
      if (!regions) return;
      const shape = geometry(regions);
      if (avoidedTopologies.has(shape.topology)) return;
      const distance = avoided.length ? Math.min(...avoided.map(previous => geometryDistance(shape,previous))) : 60;
      if (distance > bestDistance) { best = {regions,shape}; bestDistance = distance; }
    }
    for (let attempt = 0; attempt < GROWTH_ATTEMPTS; attempt++) consider(growRegions(solution,rng));
    // Fresh growth is probabilistic; bounded catalog deformation covers difficult
    // answers. Every accepted fallback gets the same proof and topology checks.
    if (!best || bestDistance < 10) {
      for (let attempt = 0; attempt < FALLBACK_ATTEMPTS; attempt++) {
        const regions = varyRegions(pick(variants,rng),rng);
        if (solveLogically(regions).solved) consider(regions);
        if (bestDistance >= 12) break;
      }
    }
    if (!best) {
      for (const base of variants) consider(base.regions.slice());
    }
    if (!best) throw new Error('No unused logical board geometry remains in the requested history window.');
    const labels = shuffled([0,1,2,3,4,5],rng), regions = best.regions.map(region => labels[region]);
    const puzzle = {id:uniqueId('battle-board'), size:SIZE, regions, solution};
    const validation = validatePuzzle(puzzle);
    if (!validation.valid) throw new Error(`Invalid battle puzzle: ${validation.errors.join(' ')}`);
    recentPatterns.push(key); recentGeometry.push(best.shape);
    if (recentPatterns.length > HISTORY_LIMIT) recentPatterns.shift();
    if (recentGeometry.length > HISTORY_LIMIT) recentGeometry.shift();
    return puzzle;
  }
  function settings(input) {
    input = input || {};
    const requested = Number(input.maxHP == null ? input.hp : input.maxHP);
    const maxHP = Number.isFinite(requested) ? Math.round(Math.max(50,Math.min(500,requested))) : 150;
    return {mode:'battle', size:SIZE, maxHP, hp:maxHP};
  }
  function makeBoard(game, number, combo) {
    const currentSolutions = game.boards.filter(Boolean).map(board => pattern(board.puzzle.solution));
    const puzzle = generatePuzzle({avoidSolutions:game._history.patterns, avoidBoards:game._history.boards, currentSolutions});
    game._history.patterns.push(pattern(puzzle.solution));
    game._history.boards.push(boardKey(puzzle.regions));
    if (game._history.patterns.length > HISTORY_LIMIT) game._history.patterns.shift();
    if (game._history.boards.length > HISTORY_LIMIT) game._history.boards.shift();
    return {puzzle, found:[], misses:[], number, combo, missStreak:0,
      cooldownUntil:0, cooldownStartedAt:null, cooldownKind:null, cooldownDuration:0};
  }
  function create(input, players, previousGame) {
    const clean = settings(input), game = {
      id:uniqueId('battle'), settings:clean,
      players:[0,1].map(who => {
        const player = Array.isArray(players) && players[who] || {};
        return {nickname:String(player.nickname || (who ? '等待貓友' : '奶油虎斑')).slice(0,24),
          avatar:Number.isInteger(player.avatar) && player.avatar >= 0 && player.avatar < 6 ? player.avatar : who,
          hp:clean.maxHP, maxHP:clean.maxHP, cats:0, connected:player.connected !== false};
      }),
      boards:[], status:'lobby', winner:null, revision:0, startedAt:null, startAt:null, countdownStartedAt:null, pausedAt:null, endedAt:null,
      lastEvent:null, actionIds:[], _boardActions:[[],[]], _history:{patterns:[],boards:[]},
      _pausedCooldowns:null, _pausedFrom:null, _pausedCountdown:null, _lastNow:0
    };
    if (previousGame && previousGame._history) {
      const previous = previousGame._history;
      game._history.patterns = (Array.isArray(previous.patterns) ? previous.patterns : []).filter(key => getCatalog().has(key)).slice(-HISTORY_LIMIT);
      game._history.boards = (Array.isArray(previous.boards) ? previous.boards : []).filter(key => typeof key === 'string' && /^[0-5]{36}$/.test(key)).slice(-HISTORY_LIMIT);
    }
    game.boards.push(makeBoard(game,1,0)); game.boards.push(makeBoard(game,1,0));
    return game;
  }
  function time(game, now) {
    const value = now == null ? Date.now() : now;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.max(Number.isFinite(game._lastNow) ? game._lastNow : 0,value);
  }
  function isAuthority(game) {
    return !!game && Array.isArray(game.boards) && game.boards.length === 2 &&
      game.boards.every(board => board && board.puzzle && Array.isArray(board.puzzle.solution));
  }
  function eventIdentity(game) {
    return {id:`${game.id}:${game.revision}`, sequence:game.revision};
  }
  function transition(game, status, type, now) {
    game.status = status; game._lastNow = now; game.revision++;
    game.lastEvent = {...eventIdentity(game), type, at:now};
    return true;
  }
  function start(game, now) {
    if (!isAuthority(game) || game.status !== 'lobby' || game.players.some(player => player.connected === false)) return false;
    const at = time(game,now); if (at === null) return false;
    game.countdownStartedAt = at; game.startAt = at + OPENING_COUNTDOWN; game.startedAt = null;
    return transition(game,'countdown','countdown',at);
  }
  // Called only on the host's authority state. A snapshot/client clock reaching
  // zero must not itself authorize an attack or alter the shared start deadline.
  function advance(game, now) {
    if (!isAuthority(game) || game.status !== 'countdown' || game.players.some(player => player.connected === false)) return false;
    const at = time(game,now); if (at === null || !Number.isFinite(game.startAt) || at < game.startAt) return false;
    game.startedAt = game.startAt;
    return transition(game,'playing','start',at);
  }
  function pause(game, now) {
    if (!isAuthority(game) || !['playing','countdown'].includes(game.status)) return false;
    const at = time(game,now); if (at === null) return false;
    game._pausedCooldowns = game.boards.map(board => Math.max(0,board.cooldownUntil-at));
    game._pausedFrom = game.status;
    game._pausedCountdown = game.status === 'countdown' ? Math.max(0,game.startAt-at) : null;
    game.pausedAt = at;
    return transition(game,'paused','pause',at);
  }
  function reconnect(game, now) {
    if (!isAuthority(game) || game.status !== 'paused' || game.players.some(player => player.connected === false)) return false;
    const at = time(game,now); if (at === null) return false;
    const status = game._pausedFrom === 'countdown' ? 'countdown' : 'playing';
    game.boards.forEach((board,who) => {
      const saved = game._pausedCooldowns && game._pausedCooldowns[who];
      const remaining = Number.isFinite(saved) ? Math.max(0,saved) : 0;
      // Shift both ends of an in-progress lock, keeping the same visual fraction.
      // Old saves have no cooldownStartedAt; that field remains optional.
      const elapsed = Number.isFinite(board.cooldownStartedAt) && Number.isFinite(game.pausedAt) ? Math.max(0,game.pausedAt-board.cooldownStartedAt) : null;
      board.cooldownUntil = at + remaining;
      if (remaining > 0 && elapsed !== null) board.cooldownStartedAt = at-elapsed;
    });
    if (status === 'countdown') {
      const remaining = Number.isFinite(game._pausedCountdown) ? Math.max(0,Math.min(OPENING_COUNTDOWN,game._pausedCountdown)) : 0;
      game.startAt = at + remaining; game.countdownStartedAt = game.startAt - OPENING_COUNTDOWN;
    }
    game._pausedCooldowns = null; game._pausedFrom = null; game._pausedCountdown = null; game.pausedAt = null;
    return transition(game,status,'reconnect',at);
  }
  function abort(game, now, reason) {
    if (!game || ['finished','aborted'].includes(game.status)) return false;
    const at = time(game,now); if (at === null) return false;
    game.winner = null; game.endedAt = at;
    transition(game,'aborted','abort',at);
    if (typeof reason === 'string') game.lastEvent.reason = reason.slice(0,120);
    return true;
  }
  const rejected = reason => ({accepted:false, reason});
  function missStreak(board) {
    // Missing fields in saved games mean no known consecutive misses. Do not
    // reconstruct a streak from all missed cells, which may predate a hit.
    return Number.isSafeInteger(board.missStreak) && board.missStreak >= 0 ? board.missStreak : 0;
  }
  function cooldownDuration(board) {
    if (Number.isFinite(board.cooldownDuration) && board.cooldownDuration >= 0) return board.cooldownDuration;
    // Preserve an older save's actual lock length, including pre-change 2s
    // penalties. Reconnect shifts both timestamps, so their difference is stable.
    return Number.isFinite(board.cooldownStartedAt) && Number.isFinite(board.cooldownUntil) ?
      Math.max(0,board.cooldownUntil-board.cooldownStartedAt) : 0;
  }
  function act(game, who, action, now) {
    if (!game || !['playing','countdown'].includes(game.status)) return rejected('not-playing');
    if (who !== 0 && who !== 1) return rejected('invalid-player');
    if (!action || typeof action !== 'object' || action.type !== 'guess') return rejected('invalid-action');
    if (typeof action.actionId !== 'string' || !action.actionId.length || action.actionId.length > 128) return rejected('invalid-action-id');
    const board = game.boards[who];
    if (!board || !Array.isArray(board.puzzle.solution)) return rejected('not-authority');
    if (action.boardId !== board.puzzle.id) return rejected('stale-board');
    const scopedId = `${who}:${action.actionId}`;
    if (game.actionIds.includes(scopedId) || game._boardActions[who].includes(action.actionId)) return rejected('duplicate');
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= CELLS) return rejected('invalid-cell');
    // Only opened cells are resolved. Deductions never prevent a player's guess.
    if (board.found.includes(action.index) || board.misses.includes(action.index)) return rejected('resolved-cell');
    const at = time(game,now); if (at === null) return rejected('invalid-time');
    if (game.players.some(player => player.connected === false)) return rejected('disconnected');
    if (game.status === 'countdown' && !advance(game,at)) return rejected('countdown');
    if (at < board.cooldownUntil) return rejected('cooldown');
    // Recent IDs are bounded; active-board IDs cannot be evicted (max. 36 each).
    // After replacement every replay of that old action fails the board ID check.
    game.actionIds.push(scopedId);
    if (game.actionIds.length > ACTION_HISTORY_LIMIT) game.actionIds.shift();
    game._boardActions[who].push(action.actionId);
    game._lastNow = at; game.revision++;
    const event = {...eventIdentity(game), who, index:action.index, boardId:board.puzzle.id, boardNumber:board.number, at};
    board.cooldownStartedAt = at;
    if (!board.puzzle.solution.includes(action.index)) {
      board.missStreak = Math.min(Number.MAX_SAFE_INTEGER,missStreak(board)+1);
      board.cooldownDuration = Math.min(MAX_MISS_COOLDOWN,MISS_COOLDOWN+(board.missStreak-1)*MISS_COOLDOWN_STEP);
      board.misses.push(action.index); board.combo = 0; board.cooldownUntil = at+board.cooldownDuration;
      board.cooldownKind = 'miss';
      event.type = 'miss'; event.combo = 0; event.damage = 0;
    } else {
      board.missStreak = 0; board.cooldownDuration = HIT_COOLDOWN;
      board.found.push(action.index); board.combo++; board.cooldownUntil = at+HIT_COOLDOWN;
      board.cooldownKind = 'hit';
      const damage = board.combo * 5, opponent = game.players[1-who];
      opponent.hp = Math.max(0,opponent.hp-damage); game.players[who].cats++;
      Object.assign(event,{type:'hit', damage, combo:board.combo, advanced:false});
      if (opponent.hp === 0) {
        game.status = 'finished'; game.winner = who; game.endedAt = at; event.winner = who;
      } else if (board.found.length === SIZE) {
        const next = makeBoard(game,board.number+1,board.combo);
        next.cooldownUntil = board.cooldownUntil; next.cooldownStartedAt = board.cooldownStartedAt;
        next.cooldownKind = board.cooldownKind; next.cooldownDuration = board.cooldownDuration;
        game.boards[who] = next;
        game._boardActions[who] = []; event.advanced = true;
      }
    }
    event.missStreak = board.missStreak; event.cooldownDuration = board.cooldownDuration;
    game.lastEvent = event;
    return {accepted:true, event:{...event}};
  }
  function publicEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const result = {};
    for (const key of ['id','sequence','type','who','index','boardId','boardNumber','at','damage','combo','advanced','winner','reason','missStreak','cooldownDuration']) {
      if (Object.prototype.hasOwnProperty.call(event,key) && ['string','number','boolean'].includes(typeof event[key])) result[key] = event[key];
    }
    return result;
  }
  function publicGame(game, now) {
    if (!game) return null;
    const serverTime = time(game,now) ?? time(game,Date.now());
    // Deliberately no object spreads from private state: adding future authority
    // fields cannot accidentally disclose answers, histories, notes or action IDs.
    return {
      id:game.id, settings:settings(game.settings), status:game.status, winner:game.winner,
      revision:game.revision, startedAt:game.startedAt, pausedAt:game.pausedAt, endedAt:game.endedAt, serverTime,
      startAt:Number.isFinite(game.startAt) ? game.startAt : null,
      countdownStartedAt:Number.isFinite(game.countdownStartedAt) ? game.countdownStartedAt : null,
      pausedFrom:game.status === 'paused' ? game._pausedFrom === 'countdown' ? 'countdown' : 'playing' : null,
      countdownRemaining:game.status === 'paused' && game._pausedFrom === 'countdown' ?
        Number.isFinite(game._pausedCountdown) ? Math.max(0,Math.min(OPENING_COUNTDOWN,game._pausedCountdown)) : 0 :
        game.status === 'countdown' && Number.isFinite(game.startAt) ? Math.max(0,game.startAt-serverTime) : 0,
      players:game.players.map(player => ({nickname:player.nickname, avatar:player.avatar, hp:player.hp,
        maxHP:player.maxHP, cats:player.cats, connected:player.connected})),
      boards:game.boards.map(board => ({
        puzzle:{id:board.puzzle.id, size:SIZE, regions:board.puzzle.regions.slice()},
        found:board.found.slice(), misses:board.misses.slice(), number:board.number,
        combo:board.combo, missStreak:missStreak(board), cooldownUntil:board.cooldownUntil,
        cooldownDuration:cooldownDuration(board),
        cooldownStartedAt:Number.isFinite(board.cooldownStartedAt) ? board.cooldownStartedAt : null,
        cooldownKind:['hit','miss'].includes(board.cooldownKind) ? board.cooldownKind : null
      })),
      lastEvent:publicEvent(game.lastEvent)
    };
  }
  return Object.freeze({create, start, advance, pause, reconnect, abort, act, publicGame, generatePuzzle, validatePuzzle,
    settings, solutionPattern:pattern, boardKey, solveLogically,
    constants:Object.freeze({SIZE,HIT_COOLDOWN,MISS_COOLDOWN,MISS_COOLDOWN_STEP,MAX_MISS_COOLDOWN,OPENING_COUNTDOWN,HISTORY_LIMIT,ACTION_HISTORY_LIMIT,ANSWER_PATTERNS:ANSWERS.length})});
});
