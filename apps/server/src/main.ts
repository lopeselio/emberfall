import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { AGENTS, accountOf, agentTick, agentWarden, recentActs } from './agents.ts';
import { BA_PATH, accountFromHeaders, authHandler } from './ba.ts';
import { view } from './chain.ts';
import { config, explorerTx, hasKey } from './config.ts';
import { attestation, nearAiEnabled } from './nearai.ts';
import { Room } from './room.ts';
import { loadMatch, recentMatches, type MatchRecord } from './store.ts';

// ---------- tiny HTTP helpers ----------

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const cleanName = (n: unknown): string => String(n ?? '').replace(/[^A-Za-z0-9 _.'-]/g, '').trim().slice(0, 20) || 'Warden';

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(config.webDist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(config.webDist))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web app not built: pnpm build'); return; }
  const immutable = file.includes(`${join(config.webDist, 'assets')}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

// small caches for chain views the title screen polls
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** What anyone may see of a match: the seed and the openings only once it's over. */
function bundle(m: MatchRecord) {
  const over = m.endTick !== undefined;
  return {
    id: m.id, contract: config.contract, createdAt: m.createdAt, over, seats: m.seats, fee: m.fee, ranked: m.ranked,
    seedHash: m.seedHash, seed: over ? m.seed : undefined, setup: over ? m.setup : undefined,
    seals: m.seals, head: m.head, chunks: over ? m.chunks : [], endTick: m.endTick, winner: m.winner, stateHash: m.stateHash,
    expected: m.expected, sealedOnchain: m.sealedOnchain, openedOnchain: m.openedOnchain, settled: m.settled, error: m.error ?? null,
    txs: m.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })),
    lines: m.lines.map((l) => ({ who: l.who, text: l.text, model: l.model, signature: l.signature, signingAddress: l.signingAddress, signedText: l.signedText })),
  };
}

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    // wallet sign-in, sessions and the gasless relay: Better Auth + better-near-auth
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev', rooms: Room.count() });
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/config') {
      return json(res, 200, {
        network: config.network, contract: config.contract, referee: config.referee, chain: config.chainEnabled,
        relayer: hasKey(config.relayer) ? config.relayer : null, nearAi: nearAiEnabled(),
        bots: await Promise.all(AGENTS.map(async (a) => ({ label: a.label, name: a.name, skill: a.skill, account: accountOf(a), warden: await agentWarden(a).catch(() => null) }))),
      });
    }
    if (p === '/api/me') {
      if (!me) return json(res, 401, { error: 'not signed in' });
      const warden = config.chainEnabled ? await view<string | null>('warden_of', { account_id: me }).catch(() => null) : null;
      const raw = warden ? await view('get_warden', { warden }).catch(() => null) : null;
      const token = warden ? await view('nft_token', { token_id: warden }).catch(() => null) : null;
      const balance = config.chainEnabled ? await view<string>('ft_balance_of', { account_id: me }).catch(() => '0') : '0';
      return json(res, 200, { accountId: me, warden, raw, token, balance });
    }
    if (p === '/api/supply') return json(res, 200, config.chainEnabled ? await cached('supply', 8000, () => view('ember_supply', {})).catch(() => null) : null);
    if (p === '/api/leaderboard') return json(res, 200, config.chainEnabled ? await cached('board', 15000, () => view('leaderboard', { limit: 15 })).catch(() => []) : []);
    if (p === '/api/agents') return json(res, 200, recentActs().map((a) => ({ ...a, url: a.tx ? explorerTx(a.tx) : undefined })));
    if (p === '/api/matches') {
      return json(res, 200, recentMatches(15).map((m) => ({ id: m.id, createdAt: m.createdAt, names: m.seats.map((s) => s.name), winner: m.winner ?? null, settled: m.settled, ranked: m.ranked, burned: m.expected?.burned ?? 0, minted: (m.expected?.mints ?? []).reduce((a, b) => a + b, 0) })));
    }
    const mm = /^\/api\/match\/([a-z0-9-]{1,40})$/.exec(p);
    if (mm) {
      const m = loadMatch(mm[1]);
      return m ? json(res, 200, bundle(m)) : json(res, 404, { error: 'no such match' });
    }
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p === '/api/rooms') return json(res, 200, Room.list());
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
}

const server = createServer((req, res) => { void route(req, res); });

// ---------- websocket: rooms ----------

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 512 }, maxPayload: 8_000 });
wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  let room: Room | null = null;
  // the session cookie rides on the upgrade request (same origin)
  let account: string | null = null;
  const ready = accountFromHeaders(req.headers).then((a) => { account = a; }).catch(() => undefined);
  let name = 'Warden';
  const reply = (m: unknown): void => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  ws.on('message', async (raw) => {
    await ready;
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
    try {
      switch (m.t) {
        case 'hello': name = cleanName(m.name); reply({ t: 'hello', account }); break;
        case 'create': room?.leave(ws); room = new Room(); room.join(ws, name, account); break;
        case 'quick': {
          // a match against the Ashen Wardens right away
          room?.leave(ws);
          room = new Room();
          room.join(ws, name, account);
          const n = Math.max(1, Math.min(5, Number(m.bots ?? 3)));
          for (let k = 0; k < n; k++) room.addBot(null);
          room.setReady(ws, true);
          break;
        }
        case 'join': { const r = Room.get(String(m.code ?? '')); if (!r) throw new Error('no room with that code'); room?.leave(ws); r.join(ws, name, account); room = r; break; }
        case 'addBot': room?.addBot(ws, typeof m.label === 'string' ? m.label : undefined); break;
        case 'kick': room?.kick(ws, Number(m.seat)); break;
        case 'ready': room?.setReady(ws, !!m.ready); break;
        case 'again': room?.again(ws); break;
        case 'in': room?.input(ws, { mx: m.mx as number, mz: m.mz as number, ax: m.ax as number, az: m.az as number, swing: !!m.swing, dash: !!m.dash }); break;
        case 'leave': room?.leave(ws); room = null; break;
      }
    } catch (e) {
      reply({ t: 'error', msg: (e as Error).message });
    }
  });
  ws.on('close', () => room?.leave(ws));
});
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25_000).unref();

server.listen(config.port, () => {
  console.log(`Emberfall on :${config.port} (contract ${config.contract}, chain ${config.chainEnabled ? 'on' : 'off'})`);
});

if (config.chainEnabled) {
  const loop = (): void => { void agentTick().catch((e) => console.warn('agent tick:', (e as Error).message)); };
  setTimeout(loop, 8000);
  setInterval(loop, 10 * 60_000).unref();
}
