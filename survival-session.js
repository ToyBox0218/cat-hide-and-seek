/* Private friend rooms: one host authority, with no DOM or PeerJS dependency. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatSurvivalSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const PROTOCOL = 'cat-survival-v1';
  const SNAPSHOT_INTERVAL = 100, HANDSHAKE_TIMEOUT = 10000, RECONNECT_GRACE = 15000;
  const HEARTBEAT_INTERVAL = 2000, LIVENESS_TIMEOUT = 6500, MAX_CLOCK_RTT = 5000;
  const MAX_SEATS = 4, MAX_PENDING = 4, MAX_CONNECTIONS = 8, MAX_MESSAGES_PER_SECOND = 60;
  const noop = () => {};

  function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function finiteTime(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
  function credentialValid(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{32,256}$/.test(value); }
  function idValid(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function profile(value, id) {
    value = record(value) ? value : {};
    return {id, nickname:typeof value.nickname === 'string' ? value.nickname.slice(0,24) : '貓友',
      avatar:Number.isInteger(value.avatar) && value.avatar >= 0 && value.avatar < 6 ? value.avatar : 0,
      connected:true, ready:false};
  }
  function secureToken() {
    const bytes = new Uint8Array(24);
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') root.crypto.getRandomValues(bytes);
    else if (typeof require === 'function') bytes.set(require('node:crypto').randomBytes(bytes.length));
    else throw new Error('Secure random numbers are required for survival room credentials.');
    return Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
  }
  function actionInput(value) {
    if (!record(value) || value.type !== 'guess' || !idValid(value.actionId) || !idValid(value.boardId) ||
        !Number.isInteger(value.index) || value.index < 0 || value.index >= 36) return null;
    // In particular, playerId, who, time, answers and marks never cross into authority.
    return {type:'guess', actionId:value.actionId, boardId:value.boardId, index:value.index};
  }
  function optionsOf(options) {
    options = options || {};
    return {now:typeof options.now === 'function' ? options.now : () => Date.now(),
      setTimer:options.setTimer || ((fn,delay) => root.setTimeout(fn,delay)),
      clearTimer:options.clearTimer || (id => root.clearTimeout(id)),
      onState:options.onState || noop, onStatus:options.onStatus || noop, onAck:options.onAck || noop};
  }
  function timers(options) {
    const pending = new Set();
    return {
      set(fn, delay) {
        let id;
        id = options.setTimer(() => { pending.delete(id); fn(); }, delay);
        pending.add(id); return id;
      },
      clear(id) { if (pending.has(id)) { pending.delete(id); options.clearTimer(id); } },
      clearAll() { for (const id of pending) options.clearTimer(id); pending.clear(); }
    };
  }
  function bind(connection, name, fn, list) {
    connection.on(name,fn); list.push([name,fn]);
  }
  function unbind(connection, list) {
    const remove = typeof connection.off === 'function' ? connection.off : connection.removeListener;
    if (typeof remove === 'function') for (const [name,fn] of list) remove.call(connection,name,fn);
    list.length = 0;
  }
  function wire(type, fields) { return Object.assign({protocol:PROTOCOL,type},fields); }
  function terminal(snapshot) { return snapshot && (snapshot.status === 'finished' || snapshot.status === 'aborted'); }

  function createHost(input) {
    input = input || {};
    const options = optionsOf(input), engine = input.engine || root.CatSurvival;
    for (const method of ['create','addPlayer','setReady','setConnected','start','advance','act','abort','publicGame']) {
      if (!engine || typeof engine[method] !== 'function') throw new Error(`Survival engine requires ${method}.`);
    }
    const timeouts = timers(options), connections = new Set(), seats = new Map(), expiredCredentials = new Set();
    const randomToken = input.randomToken || secureToken;
    let closed = false, lastTime = 0, nextSeat = 1, dirty = false, flushTimer = null, lastFlush = -Infinity;
    function time() {
      const value = options.now();
      if (finiteTime(value)) lastTime = Math.max(lastTime,value);
      return lastTime;
    }
    const hostId = 'p1', initialTime = time();
    // The authority object remains lexical/private. Every observer gets publicGame.
    const game = engine.create(input.settings || {},[Object.assign(profile(input.hostProfile,hostId),{ready:true})],{now:initialTime});
    function view(at) { return engine.publicGame(game,at); }
    function player(id) { return game.players.find(value => value.id === id); }
    function send(entry, message) {
      if (closed || entry.closed || !entry.connection.open) return false;
      try { entry.connection.send(clone(message)); return true; }
      catch (_) { disconnect(entry,'send-failed',time()); return false; }
    }
    function flush(at) {
      if (closed || !dirty) return;
      dirty = false; lastFlush = at;
      const snapshot = view(at);
      options.onState(clone(snapshot));
      for (const entry of connections) if (entry.seat) send(entry,wire('snapshot',{snapshot}));
    }
    function changed(at) {
      if (closed) return;
      dirty = true;
      if (flushTimer !== null) return;
      flushTimer = timeouts.set(() => { flushTimer = null; flush(time()); },Math.max(0,SNAPSHOT_INTERVAL-(at-lastFlush)));
    }
    function reconcileSeats(at) {
      for (const [credential,seat] of seats) {
        if (player(seat.playerId)) continue;
        seats.delete(credential); expiredCredentials.add(credential);
        if (expiredCredentials.size > 32) expiredCredentials.delete(expiredCredentials.values().next().value);
        if (seat.connection && !seat.connection.closed) reject(seat.connection,'seat-unavailable',at);
      }
    }
    function step(at) { if (engine.advance(game,at)) changed(at); reconcileSeats(at); }
    function disconnect(entry, reason, at) {
      if (entry.closed) return;
      entry.closed = true; connections.delete(entry); timeouts.clear(entry.handshakeTimer);
      unbind(entry.connection,entry.listeners);
      if (entry.seat && entry.seat.connection === entry) {
        entry.seat.connection = null;
        if (!closed && engine.setConnected(game,entry.seat.playerId,false,at)) changed(at);
        if (!closed) options.onStatus({status:'player-disconnected',playerId:entry.seat.playerId,reason});
      }
    }
    function closeEntry(entry, reason, at) {
      disconnect(entry,reason,at);
      try { entry.connection.close(); } catch (_) { /* Already closed transports are harmless. */ }
    }
    function reject(entry, reason, at) {
      send(entry,wire('rejected',{reason,hostTime:at}));
      closeEntry(entry,reason,at);
    }
    function badMessage(entry, at) { if (++entry.invalid >= 4) reject(entry,'malformed-messages',at); }
    function seatInfo(seat) {
      const value = player(seat.playerId);
      const index = game.players.findIndex(item => item.id === seat.playerId);
      return {playerId:seat.playerId,seat:index,index,spectator:!!value && value.status !== 'active'};
    }
    function offer(entry, at) {
      if (entry.seat || entry.closed) return;
      send(entry,wire('offer',{hostId,gameId:game.id,hostTime:at,reconnectGrace:RECONNECT_GRACE}));
    }
    function join(entry, message, at) {
      if (entry.seat) return;
      step(at);
      let seat, rejoined = false;
      if (message.credential != null) {
        if (!credentialValid(message.credential) || !seats.has(message.credential)) {
          return reject(entry,expiredCredentials.has(message.credential) ? 'seat-unavailable' : 'invalid-credential',at);
        }
        seat = seats.get(message.credential);
        if (seat.connection && !seat.connection.closed) return reject(entry,'seat-already-connected',at);
        if (!player(seat.playerId)) return reject(entry,'seat-unavailable',at);
        rejoined = true;
      } else {
        if (game.status !== 'lobby') return reject(entry,'match-already-started',at);
        let token;
        for (let attempt = 0; attempt < 4; attempt++) {
          let candidate;
          try { candidate = randomToken(); } catch (_) { return reject(entry,'credential-unavailable',at); }
          if (credentialValid(candidate) && !seats.has(candidate) && !expiredCredentials.has(candidate)) { token = candidate; break; }
        }
        if (!token) return reject(entry,'credential-unavailable',at);
        const playerId = `p${++nextSeat}`;
        if (!engine.addPlayer(game,profile(message.profile,playerId),at)) return reject(entry,'room-full',at);
        seat = {playerId,credential:token,connection:null};
        seats.set(token,seat);
      }
      entry.seat = seat; seat.connection = entry; entry.rejoined = rejoined;
      changed(at);
      // The credential is sent only on this seat's bound connection, never broadcast.
      send(entry,wire('joined',{seat:seatInfo(seat),credential:seat.credential,snapshot:view(at),hostTime:at}));
    }
    function confirmJoin(entry, message, at) {
      step(at);
      if (entry.closed) return;
      if (message.gameId !== game.id) return badMessage(entry,at);
      if (!player(entry.seat.playerId)) return reject(entry,'seat-unavailable',at);
      if (!entry.confirmed) {
        if (entry.rejoined) engine.setConnected(game,entry.seat.playerId,true,at);
        if (game.status === 'lobby') engine.setReady(game,entry.seat.playerId,true,at);
        entry.confirmed = true; timeouts.clear(entry.handshakeTimer); changed(at);
      }
      send(entry,wire('join-confirmed',{gameId:game.id,seat:seatInfo(entry.seat),snapshot:view(at),hostTime:at}));
      options.onStatus({status:entry.rejoined ? 'player-rejoined' : 'player-joined',playerId:entry.seat.playerId});
    }
    function acknowledge(id, action, at, entry) {
      step(at);
      const clean = actionInput(action);
      const result = entry && !entry.confirmed ? {accepted:false,reason:'join-unconfirmed'} :
        clean ? engine.act(game,id,clean,at) : {accepted:false,reason:'invalid-action'};
      const ack = {actionId:record(action) && idValid(action.actionId) ? action.actionId : null,
        accepted:result.accepted === true,hostTime:at};
      if (typeof result.reason === 'string') ack.reason = result.reason.slice(0,128);
      if (ack.accepted) { ack.event = view(at).lastEvent; changed(at); }
      if (entry) send(entry,wire('ack',ack));
      else options.onAck(clone(ack));
      return ack;
    }
    function receive(entry, message) {
      if (closed || entry.closed || !record(message) || message.protocol !== PROTOCOL) return;
      const at = time();
      if (at-entry.rateAt >= 1000) { entry.rateAt = at; entry.rateCount = 0; }
      if (++entry.rateCount > MAX_MESSAGES_PER_SECOND) return reject(entry,'rate-limit',at);
      if (Object.keys(message).length > 16 || typeof message.type !== 'string') return badMessage(entry,at);
      entry.lastSeen = at;
      if (message.type === 'request-offer') return offer(entry,at);
      if (message.type === 'join') return join(entry,message,at);
      if (!entry.seat) return badMessage(entry,at);
      if (message.type === 'join-confirm') return confirmJoin(entry,message,at);
      if (message.type === 'ping') {
        if (!idValid(message.id)) return badMessage(entry,at);
        return send(entry,wire('pong',{id:message.id,hostTime:at}));
      }
      if (message.type === 'ready') {
        if (typeof message.ready !== 'boolean') return badMessage(entry,at);
        // Readiness belongs to the completed transport handshake, never a UI toggle.
        return;
      }
      if (message.type === 'action') return acknowledge(entry.seat.playerId,message.action,at,entry);
      if (message.type === 'leave') return closeEntry(entry,'left-room',at);
      if (message.type === 'start' || message.type === 'abort') {
        return send(entry,wire('ack',{actionId:null,accepted:false,reason:'host-only',hostTime:at}));
      }
      badMessage(entry,at);
    }
    function attach(connection) {
      if (closed || !connection || typeof connection.on !== 'function' || typeof connection.send !== 'function' || typeof connection.close !== 'function') return false;
      if (Array.from(connections).some(entry => entry.connection === connection)) return false;
      const pending = Array.from(connections).filter(entry => !entry.confirmed).length;
      if (connections.size >= MAX_CONNECTIONS || pending >= MAX_PENDING) {
        try { if (connection.open) connection.send(wire('rejected',{reason:'room-busy'})); connection.close(); } catch (_) {}
        return false;
      }
      const at = time(), entry = {connection,seat:null,confirmed:false,rejoined:false,closed:false,listeners:[],lastSeen:at,invalid:0,rateAt:at,rateCount:0,handshakeTimer:null};
      connections.add(entry);
      bind(connection,'data',message => receive(entry,message),entry.listeners);
      bind(connection,'close',() => disconnect(entry,'connection-closed',time()),entry.listeners);
      bind(connection,'error',() => closeEntry(entry,'connection-error',time()),entry.listeners);
      bind(connection,'open',() => offer(entry,time()),entry.listeners);
      entry.handshakeTimer = timeouts.set(() => { if (!entry.confirmed) reject(entry,'handshake-timeout',time()); },HANDSHAKE_TIMEOUT);
      if (connection.open) offer(entry,at);
      return true;
    }
    function tick() {
      if (closed) return false;
      const at = time(); step(at);
      for (const entry of connections) if (entry.seat && at-entry.lastSeen >= LIVENESS_TIMEOUT) closeEntry(entry,'heartbeat-timeout',at);
      if (dirty && at-lastFlush >= SNAPSHOT_INTERVAL) {
        timeouts.clear(flushTimer); flushTimer = null; flush(at);
      }
      return true;
    }
    function pulse() { if (!closed) { tick(); if (!closed) timeouts.set(pulse,SNAPSHOT_INTERVAL); } }
    function close(reason) {
      if (closed) return;
      const at = time(), why = typeof reason === 'string' ? reason.slice(0,120) : 'host-left';
      engine.abort(game,why,at);
      const snapshot = view(at);
      for (const entry of connections) if (entry.seat) send(entry,wire('aborted',{reason:why,snapshot,hostTime:at}));
      closed = true; timeouts.clearAll();
      for (const entry of Array.from(connections)) closeEntry(entry,why,at);
      options.onState(clone(snapshot)); options.onStatus({status:'aborted',reason:why});
    }
    options.onState(clone(view(initialTime)));
    timeouts.set(pulse,SNAPSHOT_INTERVAL);
    return Object.freeze({hostId,playerId:hostId,attach,tick,close,abort:close,
      localReady(ready) { return !closed && ready === true; },
      start() {
        if (closed) return false;
        const at = time(), revision = game.revision, result = engine.start(game,at);
        reconcileSeats(at); if (game.revision !== revision) changed(at); return result;
      },
      submit(action) { if (closed) return {accepted:false,reason:'closed',actionId:action && action.actionId || null}; return acknowledge(hostId,action,time()); },
      getState() { return clone(view(time())); },getServerTime:time});
  }

  function createGuest(input) {
    input = input || {};
    const options = optionsOf(input), connection = input.connection;
    if (!connection || typeof connection.on !== 'function' || typeof connection.send !== 'function' || typeof connection.close !== 'function') throw new Error('A data connection is required.');
    const timeouts = timers(options), listeners = [], pings = new Map();
    const onSeat = input.onSeat || noop, onCredential = input.onCredential || noop;
    let closed = false, joined = false, confirmed = false, joinSent = false, disconnected = false, reconnectTimer = null, handshakeTimer = null;
    let seat = null, snapshot = null, sequence = 0, pingSequence = 0, lastReceived = 0, lastPing = -Infinity;
    let clockOffset = 0, clockKnown = false, lastServerTime = 0, lastLocalTime = 0;
    const prefix = secureToken().slice(0,16);
    function time() { const value = options.now(); if (finiteTime(value)) lastLocalTime = Math.max(lastLocalTime,value); return lastLocalTime; }
    function serverTime() { lastServerTime = Math.max(lastServerTime,time()+clockOffset); return lastServerTime; }
    function send(message) {
      if (closed || disconnected || !connection.open) return false;
      try { connection.send(message); return true; }
      catch (_) { lost('send-failed'); return false; }
    }
    function status(value, fields) { options.onStatus(Object.assign({status:value},fields)); }
    function finish(reason) {
      if (closed) return;
      closed = true; timeouts.clearAll(); pings.clear(); unbind(connection,listeners);
      if (snapshot && !terminal(snapshot)) {
        snapshot = Object.assign({},snapshot,{status:'aborted',winner:null,winnerIds:[],reason,
          lastEvent:{type:'abort',at:serverTime(),reason}});
        options.onState(clone(snapshot));
      }
      status('aborted',{reason});
      try { connection.close(); } catch (_) {}
    }
    function lost(reason) {
      if (closed || disconnected) return;
      disconnected = true; pings.clear();
      if (terminal(snapshot)) { closed = true; timeouts.clearAll(); unbind(connection,listeners); status('closed',{reason}); return; }
      if (!joined) { closed = true; timeouts.clearAll(); unbind(connection,listeners); status('rejected',{reason:'host-unreachable'}); return; }
      status('reconnecting',{reason,deadline:time()+RECONNECT_GRACE,grace:RECONNECT_GRACE});
      reconnectTimer = timeouts.set(() => finish('host-disconnected'),RECONNECT_GRACE);
    }
    function acceptSnapshot(value, quiet) {
      if (!record(value) || !Array.isArray(value.players) || !Array.isArray(value.boards) || value.players.length > MAX_SEATS ||
          value.players.length !== value.boards.length || !Number.isInteger(value.revision) || !finiteTime(value.serverTime)) return false;
      if (snapshot && (snapshot.id !== value.id || value.revision < snapshot.revision)) return false;
      if (seat && !value.players.some(player => player.id === seat.playerId)) return false;
      snapshot = clone(value);
      if (!clockKnown) { clockOffset = value.serverTime-time(); clockKnown = true; }
      if (seat) {
        const index = snapshot.players.findIndex(player => player.id === seat.playerId);
        const spectator = snapshot.players[index].status !== 'active';
        if (seat.index !== index || seat.spectator !== spectator) {
          seat = {playerId:seat.playerId,index,seat:index,spectator}; onSeat(clone(seat));
        }
      }
      if (!quiet) options.onState(clone(snapshot)); return true;
    }
    function ping(at) {
      if (!joined || disconnected || closed) return;
      const id = `clock-${++pingSequence}`;
      for (const [old,sent] of pings) if (at-sent > MAX_CLOCK_RTT) pings.delete(old);
      pings.set(id,at); lastPing = at;
      if (!send(wire('ping',{id}))) pings.delete(id);
    }
    function receive(message) {
      if (closed || disconnected || !record(message) || message.protocol !== PROTOCOL) return false;
      const at = time();
      if (Object.keys(message).length > 16 || typeof message.type !== 'string') return false;
      lastReceived = at;
      if (message.type === 'offer') {
        if (!joinSent && !joined) {
          joinSent = true;
          const fields = {profile:profile(input.profile,undefined)};
          delete fields.profile.id;
          if (input.credential != null) fields.credential = input.credential;
          send(wire('join',fields));
        }
        return true;
      }
      if (message.type === 'rejected') {
        closed = true; timeouts.clearAll(); pings.clear(); unbind(connection,listeners);
        status('rejected',{reason:typeof message.reason === 'string' ? message.reason : 'rejected'});
        try { connection.close(); } catch (_) {}
        return true;
      }
      if (message.type === 'joined') {
        if (joined || !record(message.seat) || !idValid(message.seat.playerId) || !credentialValid(message.credential)) return false;
        const nextSeat = {playerId:message.seat.playerId,seat:message.seat.index,index:message.seat.index,spectator:message.seat.spectator === true};
        if (!Number.isInteger(nextSeat.index) || nextSeat.index < 0 || nextSeat.index >= MAX_SEATS) return false;
        if (!record(message.snapshot) || !Array.isArray(message.snapshot.players) || !message.snapshot.players[nextSeat.index] ||
            message.snapshot.players[nextSeat.index].id !== nextSeat.playerId || !acceptSnapshot(message.snapshot,true)) return false;
        seat = nextSeat; joined = true;
        onCredential(message.credential); onSeat(clone(seat)); options.onState(clone(snapshot));
        if (!closed && !disconnected) send(wire('join-confirm',{gameId:snapshot.id}));
        return true;
      }
      if (!joined) return false;
      if (message.type === 'join-confirmed') {
        if (confirmed || message.gameId !== snapshot.id || !record(message.seat) || message.seat.playerId !== seat.playerId ||
            !acceptSnapshot(message.snapshot,true)) return false;
        confirmed = true; timeouts.clear(handshakeTimer); options.onState(clone(snapshot));
        status('connected',{playerId:seat.playerId,spectator:seat.spectator}); ping(at); return true;
      }
      if (message.type === 'snapshot') return acceptSnapshot(message.snapshot);
      if (message.type === 'ack') {
        if (message.actionId !== null && !idValid(message.actionId)) return false;
        if (typeof message.accepted !== 'boolean') return false;
        const ack = {actionId:message.actionId,accepted:message.accepted};
        if (typeof message.reason === 'string') ack.reason = message.reason.slice(0,128);
        if (finiteTime(message.hostTime)) ack.hostTime = message.hostTime;
        if (record(message.event)) ack.event = clone(message.event);
        options.onAck(ack); return true;
      }
      if (message.type === 'pong') {
        if (!pings.has(message.id) || !finiteTime(message.hostTime)) return false;
        const sent = pings.get(message.id); pings.delete(message.id);
        const rtt = at-sent;
        if (rtt < 0 || rtt > MAX_CLOCK_RTT) return false;
        clockOffset = message.hostTime-(sent+at)/2; clockKnown = true;
        status('clock',{offset:clockOffset,rtt}); return true;
      }
      if (message.type === 'aborted') {
        if (record(message.snapshot)) acceptSnapshot(message.snapshot);
        finish(typeof message.reason === 'string' ? message.reason : 'host-left'); return true;
      }
      return false;
    }
    function pulse() {
      if (closed) return;
      const at = time();
      if (joined && !disconnected && at-lastReceived >= LIVENESS_TIMEOUT) lost('heartbeat-timeout');
      if (at-lastPing >= HEARTBEAT_INTERVAL) ping(at);
      if (!closed) timeouts.set(pulse,SNAPSHOT_INTERVAL);
    }
    function requestOffer() { send(wire('request-offer',{})); }
    bind(connection,'data',receive,listeners);
    bind(connection,'open',requestOffer,listeners);
    bind(connection,'close',() => lost('connection-closed'),listeners);
    bind(connection,'error',() => lost('connection-error'),listeners);
    lastReceived = time();
    handshakeTimer = timeouts.set(() => { if (!confirmed) finish('handshake-timeout'); },HANDSHAKE_TIMEOUT);
    timeouts.set(pulse,SNAPSHOT_INTERVAL);
    if (connection.open) requestOffer();
    return Object.freeze({receive,getState() { return clone(snapshot); },getServerTime:serverTime,
      get playerId() { return seat ? seat.playerId : null; },
      ready(ready) { return confirmed && !closed && !disconnected && ready === true; },
      submit(action) {
        if (!confirmed || closed || disconnected || seat.spectator || !record(action)) return false;
        const clean = actionInput(Object.assign({},action,{actionId:action.actionId || `${prefix}-${++sequence}`}));
        if (!clean) return false;
        return send(wire('action',{action:clean})) ? clean.actionId : false;
      },
      close() {
        if (closed) return;
        closed = true; timeouts.clearAll(); pings.clear();
        timeouts.clear(reconnectTimer); unbind(connection,listeners);
        try { if (connection.open) connection.send(wire('leave',{})); } catch (_) {}
        try { connection.close(); } catch (_) {}
        status('closed');
      }});
  }

  return Object.freeze({createHost,createGuest,PROTOCOL,
    constants:Object.freeze({SNAPSHOT_INTERVAL,HANDSHAKE_TIMEOUT,RECONNECT_GRACE,HEARTBEAT_INTERVAL,LIVENESS_TIMEOUT,MAX_CLOCK_RTT,MAX_SEATS,MAX_PENDING,MAX_CONNECTIONS})});
});
