/* Five-minute, host-authoritative cat survival. No DOM, transport or hidden data in snapshots. */
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(root, node ? require('./battle-engine.js') : root.CatBattle,
    node ? require('node:crypto').webcrypto : null);
  if (node) module.exports = api;
  else root.CatSurvival = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, Battle, nodeCrypto) {
  'use strict';

  const SIZE = 6, CELLS = 36, MIN_PLAYERS = 2, MAX_PLAYERS = 4;
  const LOBBY_COUNTDOWN = 180000, OPENING_COUNTDOWN = 3000, MATCH_DURATION = 300000, MINUTE = 60000, DISCONNECT_GRACE = 15000;
  const HIT_COOLDOWN = 300, MISS_COOLDOWN = 2000, MAX_MISS_COOLDOWN = 8000;
  const QUOTAS = Object.freeze([4, 10, 16, 24]), HISTORY_LIMIT = 90, ACTION_HISTORY_LIMIT = 256, EVENT_HISTORY_LIMIT = 32;
  const contexts = new WeakMap();
  let sequence = 0;

  function cryptoWord() {
    const crypto = root.crypto && typeof root.crypto.getRandomValues === 'function' ? root.crypto : nodeCrypto;
    if (!crypto) throw new Error('Survival requires secure browser randomness.');
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  // Rejection sampling, rather than modulo reduction, gives all 36 landing cells
  // and all eligible cats exactly the same production probability.
  function randomInteger(length, rng) {
    if (rng) {
      const value = rng();
      if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Test RNG must return a number in [0, 1).');
      return Math.floor(value * length);
    }
    const limit = Math.floor(0x100000000 / length) * length;
    let word;
    do { word = cryptoWord(); } while (word >= limit);
    return word % length;
  }
  function uniqueId(prefix) { return `${prefix}-${(++sequence).toString(36)}-${cryptoWord().toString(36)}`; }
  function settings(input) {
    return {mode:'survival', size:SIZE, tabbyEnabled:!input || input.tabbyEnabled !== false, capacity:MAX_PLAYERS};
  }
  function isAuthority(game) { return !!game && contexts.has(game); }
  function time(game, at) {
    if (at == null) {
      const context = contexts.get(game);
      at = context && context.now ? context.now() : Date.now();
    }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return null;
    return Math.max(game._lastNow || 0, at);
  }
  function record(game, type, at, fields) {
    game._lastNow = at;
    game.revision++;
    game.lastEvent = Object.assign({id:`${game.id}:${game.revision}`, sequence:game.revision, type, at}, fields);
    game.events.push(game.lastEvent);
    if (game.events.length > EVENT_HISTORY_LIMIT) game.events.shift();
    return game.lastEvent;
  }
  function eligible(player) { return player.connected && player.ready && player.status === 'active'; }
  function eligibleCount(game) { return game.players.filter(eligible).length; }
  function reconcileLobby(game, at) {
    if (game.status !== 'lobby') return;
    if (eligibleCount(game) < MIN_PLAYERS) {
      if (game.lobbyDeadline !== null) {
        game.lobbyStartedAt = null; game.lobbyDeadline = null;
        record(game, 'lobby-countdown-cancelled', at);
      }
    } else if (game.lobbyDeadline === null) {
      game.lobbyStartedAt = at; game.lobbyDeadline = at + LOBBY_COUNTDOWN;
      record(game, 'lobby-countdown', at);
    }
  }
  function retainLobbyPlayers(game, predicate) {
    const context = contexts.get(game), removedIds = [];
    const keep = game.players.map(player => {
      const retained = predicate(player);
      if (!retained) removedIds.push(player.id);
      return retained;
    });
    game.players = game.players.filter((_, who) => keep[who]);
    game.boards = game.boards.filter((_, who) => keep[who]);
    context.opportunities = context.opportunities.filter((_, who) => keep[who]);
    context.boardActions = context.boardActions.filter((_, who) => keep[who]);
    return removedIds;
  }
  function beginCountdown(game, at) {
    if (game.status !== 'lobby' || eligibleCount(game) < MIN_PLAYERS) return false;
    // A transport handshake still in progress is not a match participant. The
    // session binds later messages by ID, so removed seats cannot confirm late.
    const removedIds = retainLobbyPlayers(game, eligible);
    game.status = 'countdown'; game.countdownStartedAt = at;
    game.lobbyStartedAt = null; game.lobbyDeadline = null;
    game.startAt = at + OPENING_COUNTDOWN; game.endAt = game.startAt + MATCH_DURATION;
    record(game, 'countdown', at, {removedIds});
    return true;
  }
  function makeBoard(game, number, previous) {
    const context = contexts.get(game);
    const currentSolutions = game.boards.map(board => Battle.solutionPattern(board.puzzle.solution));
    const puzzle = context.makePuzzle({
      rng:context.rng || (() => cryptoWord() / 0x100000000),
      avoidSolutions:context.history.patterns.slice(), avoidBoards:context.history.boards.slice(), currentSolutions
    });
    const validation = Battle.validatePuzzle(puzzle);
    if (!validation.valid) throw new Error(`Invalid survival puzzle: ${validation.errors.join(' ')}`);
    const pattern = Battle.solutionPattern(puzzle.solution), key = Battle.boardKey(puzzle.regions);
    if (currentSolutions.includes(pattern)) throw new Error('Survival boards must have different current answers.');
    if (context.history.boards.includes(key)) throw new Error('Survival puzzle repeated a recent board.');
    context.history.patterns.push(pattern); context.history.boards.push(key);
    if (context.history.patterns.length > HISTORY_LIMIT) context.history.patterns.shift();
    if (context.history.boards.length > HISTORY_LIMIT) context.history.boards.shift();
    return {
      puzzle:{id:uniqueId('survival-board'), size:SIZE, regions:puzzle.regions.slice(), solution:puzzle.solution.slice()},
      found:[], misses:[], number, missStreak:previous ? previous.missStreak : 0,
      cooldownUntil:previous ? previous.cooldownUntil : 0,
      cooldownStartedAt:previous ? previous.cooldownStartedAt : null,
      cooldownKind:previous ? previous.cooldownKind : null,
      cooldownDuration:previous ? previous.cooldownDuration : 0,
      revealedTabbies:[], blastRevealed:[]
    };
  }
  function create(input, players, options) {
    if (!Battle || typeof Battle.generatePuzzle !== 'function') throw new Error('CatBattle must load before CatSurvival.');
    options = options || {};
    const now = typeof options.now === 'function' ? options.now : null;
    const initialTime = now ? now() : options.now == null ? Date.now() : options.now;
    if (typeof initialTime !== 'number' || !Number.isFinite(initialTime) || initialTime < 0) throw new Error('Invalid survival creation time.');
    const game = {
      id:uniqueId('survival'), settings:settings(input), players:[], boards:[], status:'lobby',
      winner:null, winnerIds:[], revision:0, countdownStartedAt:null, startAt:null, startedAt:null,
      lobbyStartedAt:null, lobbyDeadline:null,
      endAt:null, endedAt:null, endReason:null, checkpoint:0, lastEvent:null, events:[], _lastNow:initialTime
    };
    contexts.set(game, {
      now, rng:typeof options.rng === 'function' ? options.rng : null,
      makePuzzle:typeof options.makePuzzle === 'function' ? options.makePuzzle : Battle.generatePuzzle,
      history:{patterns:[], boards:[]}, opportunities:[], boardActions:[], actionIds:[], opportunityMinute:-1
    });
    for (const profile of players || []) {
      if (!addPlayer(game, profile, initialTime)) throw new Error('Invalid, duplicate or excess survival player.');
    }
    return game;
  }
  function addPlayer(game, profile, at) {
    if (!isAuthority(game) || !profile || typeof profile.id !== 'string' || !profile.id.length || profile.id.length > 128) return false;
    const stamp = time(game, at); if (stamp === null) return false;
    advance(game, stamp);
    if (game.status !== 'lobby' || game.players.length >= game.settings.capacity || game.players.some(player => player.id === profile.id)) return false;
    const who = game.players.length, board = makeBoard(game, 1);
    game.players.push({
      id:profile.id, nickname:String(profile.nickname || '貓友').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0,24) || '貓友',
      avatar:Number.isInteger(profile.avatar) && profile.avatar >= 0 && profile.avatar < 6 ? profile.avatar : who % 6,
      connected:profile.connected !== false, ready:profile.connected !== false && profile.ready === true,
      score:0, errors:0, status:'active', reason:null,
      disconnectDeadline:profile.connected === false ? stamp + DISCONNECT_GRACE : null
    });
    game.boards.push(board);
    contexts.get(game).opportunities.push(null);
    contexts.get(game).boardActions.push(new Set());
    record(game, 'join', stamp, {playerId:profile.id, who});
    reconcileLobby(game, stamp);
    return true;
  }
  function setReady(game, id, ready, at) {
    if (!isAuthority(game)) return false;
    const stamp = time(game, at); if (stamp === null) return false;
    advance(game, stamp);
    const who = game.players.findIndex(player => player.id === id), player = game.players[who];
    if (game.status !== 'lobby' || !player || !player.connected || typeof ready !== 'boolean' || player.ready === ready) return false;
    player.ready = ready; record(game, 'ready', stamp, {playerId:id, who, ready});
    reconcileLobby(game, stamp);
    return true;
  }
  function setConnected(game, id, connected, at) {
    if (!isAuthority(game) || typeof connected !== 'boolean') return false;
    const stamp = time(game, at); if (stamp === null) return false;
    advance(game, stamp);
    const who = game.players.findIndex(player => player.id === id), player = game.players[who];
    if (!player || player.connected === connected) return false;
    player.connected = connected;
    if (game.status === 'lobby' && !connected) player.ready = false;
    player.disconnectDeadline = !connected && player.status === 'active' && ['lobby','countdown','playing'].includes(game.status) ? stamp + DISCONNECT_GRACE : null;
    record(game, connected ? 'reconnect' : 'disconnect', stamp, {playerId:id, who, connected});
    reconcileLobby(game, stamp);
    return true;
  }
  function start(game, at) {
    if (!isAuthority(game)) return false;
    const stamp = time(game, at); if (stamp === null) return false;
    const wasLobby = game.status === 'lobby';
    advance(game, stamp);
    if (wasLobby && game.status !== 'lobby' && game.countdownStartedAt !== null) return true;
    return beginCountdown(game, stamp);
  }
  function assignOpportunities(game, minute) {
    const context = contexts.get(game);
    context.opportunityMinute = minute;
    context.opportunities = game.players.map((player, who) => {
      if (!game.settings.tabbyEnabled || player.status !== 'active') return null;
      const board = game.boards[who], candidates = board.puzzle.solution.filter(index => !board.found.includes(index));
      return candidates.length ? {minute, boardId:board.puzzle.id, index:candidates[randomInteger(candidates.length, context.rng)], used:false} : null;
    });
  }
  function finish(game, ids, reason, at) {
    game.status = 'finished'; game.winnerIds = ids.slice(); game.winner = ids.length === 1 ? ids[0] : null;
    game.endedAt = at; game.endReason = reason;
    record(game, 'finish', at, {winnerIds:ids.slice(), reason});
  }
  function resolveSurvivors(game, at, final) {
    const active = game.players.filter(player => player.status === 'active');
    if (!active.length) { finish(game, [], 'no-survivors', at); return true; }
    if (final) {
      const score = Math.max(...active.map(player => player.score));
      const leaders = active.filter(player => player.score === score);
      const errors = Math.min(...leaders.map(player => player.errors));
      finish(game, leaders.filter(player => player.errors === errors).map(player => player.id), 'time', at);
      return true;
    }
    if (active.length === 1) { finish(game, [active[0].id], 'last-survivor', at); return true; }
    return false;
  }
  function advance(game, at) {
    if (!isAuthority(game)) return false;
    const stamp = time(game, at); if (stamp === null) return false;
    const revision = game.revision;
    while (['lobby','countdown','playing'].includes(game.status)) {
      const deadlines = [];
      if (game.status === 'lobby' && game.lobbyDeadline !== null) deadlines.push(game.lobbyDeadline);
      else if (game.status === 'countdown') deadlines.push(game.startAt);
      else if (game.status === 'playing') {
        if (game.checkpoint < QUOTAS.length) deadlines.push(game.startAt + (game.checkpoint + 1) * MINUTE);
        deadlines.push(game.endAt);
      }
      for (const player of game.players) if (player.status === 'active' && player.disconnectDeadline !== null) deadlines.push(player.disconnectDeadline);
      const deadline = Math.min(...deadlines);
      if (deadline > stamp) break;
      if (game.status === 'lobby') {
        // Waiting-room seats may be reused, but every retained player keeps the
        // same ID and board. No champion decision happens before a match starts.
        const removedIds = retainLobbyPlayers(game, player => player.disconnectDeadline === null || player.disconnectDeadline > deadline);
        if (removedIds.length) record(game, 'lobby-expiry', deadline, {removedIds});
        reconcileLobby(game, deadline);
        if (game.lobbyDeadline !== null && game.lobbyDeadline <= deadline) beginCountdown(game, deadline);
        continue;
      }
      if (game.status === 'countdown' && deadline === game.startAt) {
        game.status = 'playing'; game.startedAt = game.startAt;
        assignOpportunities(game, 0); record(game, 'start', deadline);
      }
      const eliminatedIds = [], retiredIds = [];
      const quotaDue = game.status === 'playing' && game.checkpoint < QUOTAS.length && deadline === game.startAt + (game.checkpoint + 1) * MINUTE;
      if (quotaDue) {
        const quota = QUOTAS[game.checkpoint];
        // Freeze and apply the entire checkpoint before deciding whether anybody won.
        for (const player of game.players) {
          if (player.status === 'active' && player.score < quota) {
            player.status = 'eliminated'; player.reason = 'quota'; player.disconnectDeadline = null;
            eliminatedIds.push(player.id);
          }
        }
        game.checkpoint++;
      }
      for (const player of game.players) {
        if (player.status === 'active' && player.disconnectDeadline !== null && player.disconnectDeadline <= deadline) {
          player.status = 'retired'; player.reason = 'disconnect'; player.disconnectDeadline = null;
          retiredIds.push(player.id);
        }
      }
      if (quotaDue || retiredIds.length) record(game, quotaDue ? 'checkpoint' : 'retirement', deadline, {
        checkpoint:game.checkpoint, quota:quotaDue ? QUOTAS[game.checkpoint - 1] : null, eliminatedIds, retiredIds
      });
      if (resolveSurvivors(game, deadline, game.status === 'playing' && deadline === game.endAt)) break;
      if (quotaDue) assignOpportunities(game, game.checkpoint);
    }
    game._lastNow = stamp;
    return game.revision !== revision;
  }
  function abort(game, reason, at) {
    if (!isAuthority(game) || ['finished','aborted'].includes(game.status)) return false;
    const stamp = time(game, at); if (stamp === null) return false;
    advance(game, stamp);
    if (game.status === 'finished') return false;
    game.status = 'aborted'; game.endedAt = stamp; game.winnerIds = []; game.winner = null;
    game.lobbyStartedAt = null; game.lobbyDeadline = null;
    game.endReason = typeof reason === 'string' ? reason.slice(0,120) : 'host-lost';
    record(game, 'abort', stamp, {reason:game.endReason});
    return true;
  }
  function blastCells(landing) {
    const row = Math.floor(landing / SIZE), column = landing % SIZE, cells = [];
    for (let r = Math.max(0,row - 1); r <= Math.min(SIZE - 1,row + 1); r++) {
      for (let c = Math.max(0,column - 1); c <= Math.min(SIZE - 1,column + 1); c++) cells.push(r * SIZE + c);
    }
    return cells;
  }
  const rejected = reason => ({accepted:false, reason});
  function act(game, id, action, at) {
    if (!isAuthority(game)) return rejected('not-authority');
    const stamp = time(game, at); if (stamp === null) return rejected('invalid-time');
    advance(game, stamp);
    if (game.status === 'countdown') return rejected('countdown');
    if (game.status !== 'playing') return rejected('not-playing');
    const who = game.players.findIndex(player => player.id === id), player = game.players[who];
    if (!player) return rejected('invalid-player');
    if (player.status !== 'active') return rejected(player.status);
    if (!player.connected) return rejected('disconnected');
    if (!action || typeof action !== 'object' || action.type !== 'guess') return rejected('invalid-action');
    if (typeof action.actionId !== 'string' || !action.actionId.length || action.actionId.length > 128) return rejected('invalid-action-id');
    const board = game.boards[who], context = contexts.get(game);
    if (action.boardId !== board.puzzle.id) return rejected('stale-board');
    const scopedId = JSON.stringify([id, action.actionId]);
    if (context.actionIds.includes(scopedId) || context.boardActions[who].has(action.actionId)) return rejected('duplicate');
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= CELLS) return rejected('invalid-cell');
    if (board.found.includes(action.index) || board.misses.includes(action.index)) return rejected('resolved-cell');
    if (stamp < board.cooldownUntil) return rejected('cooldown');

    context.actionIds.push(scopedId);
    if (context.actionIds.length > ACTION_HISTORY_LIMIT) context.actionIds.shift();
    context.boardActions[who].add(action.actionId);
    const fields = {playerId:id, who, index:action.index, boardId:board.puzzle.id, boardNumber:board.number,
      found:[], misses:[], advanced:false, score:0, errors:0};
    board.cooldownStartedAt = stamp;
    let type;
    if (!board.puzzle.solution.includes(action.index)) {
      type = 'miss'; player.errors++;
      board.missStreak = Math.min(Number.MAX_SAFE_INTEGER, board.missStreak + 1);
      board.cooldownDuration = Math.min(MAX_MISS_COOLDOWN, MISS_COOLDOWN * board.missStreak);
      board.cooldownKind = 'miss'; board.misses.push(action.index); fields.misses.push(action.index);
    } else {
      type = 'hit'; board.missStreak = 0; board.cooldownDuration = HIT_COOLDOWN; board.cooldownKind = 'hit';
      board.found.push(action.index); player.score++; fields.found.push(action.index);
      const opportunity = context.opportunities[who];
      if (opportunity && !opportunity.used && opportunity.boardId === board.puzzle.id && opportunity.index === action.index) {
        opportunity.used = true; board.revealedTabbies.push(action.index); fields.tabby = true;
        const landing = randomInteger(CELLS, context.rng), cells = blastCells(landing);
        fields.blast = {landing, cells, found:[], misses:[]};
        // The manual hit and every blast reveal belong to this same old board.
        // Empty reveals never increment errors, and blast hits never reset locks.
        for (const index of cells) {
          if (board.found.includes(index) || board.misses.includes(index)) continue;
          board.blastRevealed.push(index);
          if (board.puzzle.solution.includes(index)) {
            board.found.push(index); player.score++; fields.found.push(index); fields.blast.found.push(index);
          } else {
            board.misses.push(index); fields.misses.push(index); fields.blast.misses.push(index);
          }
        }
      }
    }
    board.cooldownUntil = stamp + board.cooldownDuration;
    fields.score = player.score; fields.errors = player.errors;
    fields.missStreak = board.missStreak; fields.cooldownDuration = board.cooldownDuration;
    if (board.found.length === SIZE) {
      game.boards[who] = makeBoard(game, board.number + 1, board);
      context.boardActions[who] = new Set();
      // No replacement target on the next board until the next minute begins.
      context.opportunities[who] = null;
      fields.advanced = true;
    }
    const event = record(game, type, stamp, fields);
    return {accepted:true, event:publicEvent(event)};
  }
  function publicEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const result = {};
    for (const key of ['id','sequence','type','at','playerId','who','index','boardId','boardNumber','ready','connected',
      'advanced','tabby','score','errors','missStreak','cooldownDuration','checkpoint','quota','reason']) {
      if (Object.prototype.hasOwnProperty.call(event,key) && ['string','number','boolean'].includes(typeof event[key])) result[key] = event[key];
    }
    for (const key of ['winnerIds','eliminatedIds','retiredIds','removedIds']) {
      if (Array.isArray(event[key])) result[key] = event[key].filter(value => typeof value === 'string');
    }
    for (const key of ['found','misses']) {
      if (Array.isArray(event[key])) result[key] = event[key].filter(value => Number.isInteger(value) && value >= 0 && value < CELLS);
    }
    if (event.blast && Number.isInteger(event.blast.landing) && event.blast.landing >= 0 && event.blast.landing < CELLS) {
      result.blast = {landing:event.blast.landing};
      for (const key of ['cells','found','misses']) result.blast[key] = Array.isArray(event.blast[key]) ?
        event.blast[key].filter(value => Number.isInteger(value) && value >= 0 && value < CELLS) : [];
    }
    return result;
  }
  function publicGame(game, at) {
    if (!game) return null;
    const serverTime = time(game, at) ?? Math.max(game._lastNow || 0, Date.now());
    const elapsed = game.startedAt === null ? 0 : Math.max(0, Math.min(MATCH_DURATION, (game.endedAt === null ? serverTime : game.endedAt) - game.startedAt));
    // Explicit nested projections keep future authority fields private by default.
    return {
      id:game.id, settings:settings(game.settings), status:game.status, revision:game.revision,
      winner:game.winner, winnerIds:game.winnerIds.slice(), countdownStartedAt:game.countdownStartedAt,
      lobbyStartedAt:game.lobbyStartedAt, lobbyDeadline:game.lobbyDeadline, eligibleCount:eligibleCount(game),
      startAt:game.startAt, startedAt:game.startedAt, endAt:game.endAt, endedAt:game.endedAt, endReason:game.endReason,
      serverTime, countdownRemaining:game.status === 'countdown' ? Math.max(0,game.startAt - serverTime) : 0,
      elapsed, remaining:Math.max(0,MATCH_DURATION - elapsed), minute:Math.min(4, Math.floor(elapsed / MINUTE)),
      checkpoint:game.checkpoint, nextQuota:game.checkpoint < QUOTAS.length ? QUOTAS[game.checkpoint] : null,
      nextCheckpointAt:game.startAt !== null && game.checkpoint < QUOTAS.length ? game.startAt + (game.checkpoint + 1) * MINUTE : null,
      players:game.players.map(player => ({
        id:player.id, nickname:player.nickname, avatar:player.avatar, score:player.score, errors:player.errors,
        connected:player.connected, ready:player.ready, status:player.status, reason:player.reason, disconnectDeadline:player.disconnectDeadline
      })),
      boards:game.boards.map(board => ({
        puzzle:{id:board.puzzle.id, size:SIZE, regions:board.puzzle.regions.slice()},
        found:board.found.slice(), misses:board.misses.slice(), number:board.number, missStreak:board.missStreak,
        cooldownUntil:board.cooldownUntil, cooldownKind:board.cooldownKind,
        cooldownDuration:board.cooldownDuration, cooldownStartedAt:board.cooldownStartedAt,
        revealedTabbies:board.revealedTabbies.slice(), blastRevealed:board.blastRevealed.slice()
      })),
      lastEvent:publicEvent(game.lastEvent), events:game.events.slice(-EVENT_HISTORY_LIMIT).map(publicEvent)
    };
  }
  return Object.freeze({create, addPlayer, setReady, setConnected, start, advance, act, abort, publicGame, settings,
    constants:Object.freeze({SIZE, CELLS, MIN_PLAYERS, MAX_PLAYERS, LOBBY_COUNTDOWN, OPENING_COUNTDOWN, MATCH_DURATION, MINUTE,
      DISCONNECT_GRACE, HIT_COOLDOWN, MISS_COOLDOWN, MAX_MISS_COOLDOWN, QUOTAS, HISTORY_LIMIT, ACTION_HISTORY_LIMIT, EVENT_HISTORY_LIMIT})});
});
