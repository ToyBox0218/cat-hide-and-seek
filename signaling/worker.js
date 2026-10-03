const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
});

const roomCode = () => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => (value % 36).toString(36)).join('').toUpperCase();
};

export class SignalRoom {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return reply({ error: 'WebSocket required' }, 426);
    const role = new URL(request.url).searchParams.get('role');
    if (!['host', 'guest'].includes(role)) return reply({ error: 'bad role' }, 400);

    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    for (const socket of this.ctx.getWebSockets(role)) {
      try { socket.close(4001, 'replaced'); } catch {}
    }
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    const pending = await this.ctx.storage.get(role === 'guest' ? 'offer' : 'answer');
    if (pending) server.send(pending);
    await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 20000) return;
    let parsed;
    try { parsed = JSON.parse(message); } catch { return; }
    if (!['offer', 'answer'].includes(parsed.type) || typeof parsed.code !== 'string') return;

    await this.ctx.storage.put(parsed.type, message);
    await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    const role = (socket.deserializeAttachment() || {}).role;
    const target = role === 'host' ? 'guest' : 'host';
    for (const peer of this.ctx.getWebSockets(target)) {
      try { peer.send(message); } catch {}
    }
  }

  async alarm() {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1000, 'room expired'); } catch {}
    }
    await this.ctx.storage.deleteAll();
  }
}

export class Matchmaker {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return reply({ error: 'WebSocket required' }, 426);
    const key = new URL(request.url).searchParams.get('key') || '20';
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    const waiting = this.ctx.getWebSockets(key)[0];
    this.ctx.acceptWebSocket(server, [key]);
    server.serializeAttachment({ key });
    if (waiting) {
      const code = roomCode();
      waiting.send(JSON.stringify({ type: 'matched', code, role: 'host' }));
      server.send(JSON.stringify({ type: 'matched', code, role: 'guest' }));
      setTimeout(() => {
        try { waiting.close(1000, 'matched'); server.close(1000, 'matched'); } catch {}
      }, 50);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS'
    }});
    const signal = url.pathname.match(/^\/signal\/([A-Z0-9]{6})$/);
    if (signal) return env.SIGNAL.getByName(signal[1]).fetch(request);
    if (url.pathname === '/match') return env.MATCH.getByName('global').fetch(request);
    return reply({ service: 'cat-hide-and-seek-signaling', status: 'ok' });
  }
};
