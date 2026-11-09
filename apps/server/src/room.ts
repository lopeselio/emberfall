import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CHUNK, MAX_SEATS, MAX_TICKS, Recorder, TICK_HZ, createState, eventsFor, step, viewFor, type Input, type SimEvent, type State,
} from '@emberfall/rules';
import { AGENTS, taunt, type AgentDef } from './agents.ts';
import { explorerTx } from './config.ts';
import { ChainMatch, planSeats, type SeatPlan } from './match.ts';

// Rooms. The server runs the match at 20 ticks a second and sends each player only its own view:
// what its torch lights. Inputs come in over the socket; every 60 ticks the chunk is sealed onchain.

type Phase = 'lobby' | 'countdown' | 'playing' | 'results';

interface Member {
  ws: WebSocket | null;
  name: string;
  account: string | null;
  ready: boolean;
  bot: AgentDef | null;
  /** latest movement, plus one-shot presses waiting for the next tick */
  want: Input;
  sent: number;
}

const rooms = new Map<string, Room>();
const COUNTDOWN_MS = 3000;
const send = (ws: WebSocket | null, msg: unknown): void => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function newCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    const c = Array.from(randomBytes(4), (b) => A[b % A.length]).join('');
    if (!rooms.has(c)) return c;
  }
}

export class Room {
  readonly code = newCode();
  phase: Phase = 'lobby';
  members: Member[] = [];
  private state: State | null = null;
  private match: ChainMatch | null = null;
  private recorder: Recorder | null = null;
  private timer: NodeJS.Timeout | null = null;
  private evBuf: SimEvent[] = [];
  private results: unknown = null;
  private cleanup: NodeJS.Timeout | null = null;

  constructor() { rooms.set(this.code, this); }

  static get(c: string): Room | undefined { return rooms.get(c.toUpperCase().trim()); }
  static list(): { code: string; players: number }[] {
    return [...rooms.values()].filter((r) => r.phase === 'lobby').map((r) => ({ code: r.code, players: r.members.length }));
  }
  static count(): number { return rooms.size; }

  get hostIdx(): number { return this.members.findIndex((m) => !m.bot && m.ws); }
  seatOf(ws: WebSocket): number { return this.members.findIndex((m) => m.ws === ws); }

  join(ws: WebSocket, name: string, account: string | null): void {
    if (this.phase !== 'lobby') throw new Error('that match has already started');
    if (this.members.length >= MAX_SEATS) throw new Error('the room is full');
    if (account && this.members.some((m) => m.account === account)) throw new Error('you are already in this room');
    this.members.push({ ws, name: name || 'Warden', account, ready: false, bot: null, want: {}, sent: 0 });
    this.broadcastRoom();
  }

  addBot(by: WebSocket | null, label?: string): void {
    if (this.phase !== 'lobby' || (by && this.seatOf(by) !== this.hostIdx) || this.members.length >= MAX_SEATS) return;
    const used = new Set(this.members.map((m) => m.bot?.label));
    const a = AGENTS.find((x) => x.label === label && !used.has(x.label)) ?? AGENTS.find((x) => !used.has(x.label));
    if (!a) return;
    this.members.push({ ws: null, name: a.name, account: null, ready: true, bot: a, want: {}, sent: 0 });
    this.broadcastRoom();
  }

  kick(by: WebSocket, seat: number): void {
    if (this.phase !== 'lobby' || this.seatOf(by) !== this.hostIdx || seat === this.hostIdx) return;
    const m = this.members[seat];
    if (!m) return;
    send(m.ws, { t: 'kicked' });
    this.members.splice(seat, 1);
    this.broadcastRoom();
  }

  setReady(ws: WebSocket, ready: boolean): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'lobby') return;
    this.members[i].ready = ready;
    this.broadcastRoom();
    if (this.members.length >= 2 && this.members.every((m) => m.ready)) void this.start();
  }

  /** After a match: everyone back to the lobby, same seats. */
  again(ws: WebSocket): void {
    if (this.phase !== 'results' || this.seatOf(ws) < 0) return;
    if (this.cleanup) clearTimeout(this.cleanup);
    this.phase = 'lobby';
    this.members = this.members.filter((m) => m.bot || m.ws);
    for (const m of this.members) { m.ready = !!m.bot; m.want = {}; }
    this.state = null; this.match = null; this.results = null;
    this.broadcastRoom();
  }

  leave(ws: WebSocket): void {
    const i = this.seatOf(ws);
    if (i < 0) return;
    const m = this.members[i];
    if (this.phase === 'lobby') this.members.splice(i, 1);
    else {
      m.ws = null;
      // mid-match: an Ashen mind takes the torch so the match stays fair for everyone else
      if (this.phase === 'playing' && this.state?.wardens[i].alive) m.want = { ...m.want, takeover: true };
    }
    if (!this.members.some((x) => x.ws)) {
      // nobody left to watch: finish quietly if playing (bots carry on), else close
      if (this.phase !== 'playing' && this.phase !== 'countdown') { this.stop(); rooms.delete(this.code); }
      return;
    }
    this.broadcastRoom();
  }

  input(ws: WebSocket, inp: Input): void {
    const i = this.seatOf(ws);
    if (i < 0 || this.phase !== 'playing') return;
    const m = this.members[i];
    if (++m.sent > 10) return;
    const w = m.want;
    if (inp.mx === -1 || inp.mx === 0 || inp.mx === 1) w.mx = inp.mx;
    if (inp.mz === -1 || inp.mz === 0 || inp.mz === 1) w.mz = inp.mz;
    if (inp.swing) w.swing = true;
    if (inp.dash) w.dash = true;
  }

  private broadcastRoom(): void {
    const seats = this.members.map((m) => ({ name: m.name, kind: m.bot ? 'bot' : 'human', ready: m.ready, signedIn: !!m.account, here: !!m.ws || !!m.bot, skill: m.bot?.skill ?? null }));
    this.members.forEach((m, i) => send(m.ws, { t: 'room', code: this.code, phase: this.phase, seats, you: i, host: i === this.hostIdx, bots: AGENTS.map((a) => ({ label: a.label, name: a.name, skill: a.skill })) }));
  }

  private async start(): Promise<void> {
    if (this.phase !== 'lobby') return;
    this.phase = 'countdown';
    this.broadcastRoom();
    const plans: SeatPlan[] = this.members.map((m) => (m.bot ? { name: m.name, kind: 'bot', agent: m.bot } : { name: m.name, kind: m.account ? 'human' : 'guest', account: m.account ?? undefined }));
    let planned: Awaited<ReturnType<typeof planSeats>>;
    try { planned = await planSeats(plans); } catch { planned = { seats: plans.map((p) => ({ ...p, warden: null, flame: 0 })), fee: 0 }; }
    const match = new ChainMatch(planned.seats, planned.fee);
    this.match = match;
    this.state = createState(match.setup);
    this.recorder = new Recorder(this.members.length);
    const startsAt = Date.now() + COUNTDOWN_MS;
    const seats = planned.seats.map((s) => ({ name: s.name, kind: s.kind, warden: s.warden ?? null, flame: s.flame ?? 0 }));
    this.members.forEach((m, i) => send(m.ws, {
      t: 'start', you: i, matchId: match.id, startsAt, seats, ranked: planned.fee > 0, fee: planned.fee, seedHash: match.rec.seedHash,
      // the terrain is public (moonlit); only Wardens and embers hide in the dark
      tiles: this.state!.arena.tiles, maxTicks: MAX_TICKS,
    }));
    const bots = this.members.filter((m) => m.bot).map((m) => m.bot!);
    if (bots.length) {
      const b = bots[match.rec.seedHash.charCodeAt(0) % bots.length];
      void taunt(b, this.members.filter((m) => m.bot !== b).map((m) => m.name), match.rec.seedHash.charCodeAt(1)).then((line) => {
        match.rec.lines.push(line);
        this.members.forEach((m) => send(m.ws, { t: 'line', who: line.who, text: line.text, signed: !!line.signature }));
      });
    }
    setTimeout(() => this.play(), COUNTDOWN_MS);
  }

  private play(): void {
    if (!this.state || !this.match) return;
    this.phase = 'playing';
    this.broadcastRoom();
    let next = Date.now();
    const tick = (): void => {
      const s = this.state!;
      const inputs = this.members.map((m) => {
        const w = m.want;
        m.want = { mx: w.mx, mz: w.mz };
        m.sent = 0;
        return w;
      });
      const t = s.tick;
      const { events, applied } = step(s, inputs);
      this.recorder!.add(t, applied);
      this.evBuf.push(...events);
      if (s.tick % CHUNK === 0 || s.over) this.match!.addChunk(this.recorder!.close(s));
      if (s.tick % 2 === 0 || s.over) this.snapshot();
      if (s.over) { this.stop(); this.finish(); return; }
      next += 1000 / TICK_HZ;
      this.timer = setTimeout(tick, Math.max(0, next - Date.now()));
    };
    tick();
  }

  private snapshot(): void {
    const s = this.state!;
    const ev = this.evBuf;
    this.evBuf = [];
    this.members.forEach((m, i) => { if (m.ws) send(m.ws, { t: 'snap', v: viewFor(s, i), ev: eventsFor(s, i, ev) }); });
  }

  private finish(): void {
    if (!this.state || !this.match) return;
    this.phase = 'results';
    const s = this.state;
    const match = this.match;
    const { settled } = match.finish(s);
    const msg = (): unknown => ({
      t: 'results', matchId: match.id, winner: s.winner, endTick: s.tick, ranked: match.rec.ranked, fee: match.rec.fee,
      seats: s.wardens.map((w, i) => ({ name: w.name, alive: w.alive, hp: w.hp, embers: w.embers, kills: w.kills, fellAt: w.fellAt, warden: match.rec.seats[i].warden, kind: match.rec.seats[i].kind })),
      expected: match.rec.expected, settled: match.rec.settled, error: match.rec.error ?? null,
      txs: match.rec.txs.map((x) => ({ ...x, url: explorerTx(x.hash) })),
    });
    this.results = msg();
    this.broadcastRoom();
    this.members.forEach((m) => send(m.ws, this.results));
    void settled.then(() => {
      this.results = msg();
      if (this.match === match) this.members.forEach((m) => send(m.ws, this.results));
    });
    this.cleanup = setTimeout(() => { if (this.phase === 'results') rooms.delete(this.code); }, 15 * 60_000);
    if (!this.members.some((m) => m.ws)) rooms.delete(this.code);
  }

  private stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
