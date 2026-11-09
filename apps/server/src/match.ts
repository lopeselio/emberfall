import { randomBytes } from 'node:crypto';
import {
  CHUNK, FEE, headZero, nextHead, sealOf, settle, sha256Hex, stateHash, type Opening, type SeatSetup, type Setup, type State,
} from '@emberfall/rules';
import { AGENTS, accountOf, agentWarden, type AgentDef } from './agents.ts';
import { call, view } from './chain.ts';
import { config } from './config.ts';
import { saveMatch, type MatchRecord, type SeatRec } from './store.ts';

// One match's onchain life: create (seed hash + entry fees), seals every chunk while it runs,
// then open every chunk with the seed and settle. Chain calls never hold up play: if one fails,
// the match still finishes and its record says why.

export interface SeatPlan { name: string; kind: 'human' | 'guest' | 'bot'; account?: string; agent?: AgentDef; warden?: string | null; flame?: number }

interface WardenRow { owner_id: string; purse: number; approved_fee: number; loot: number[] }
interface AgentRow { day_cap: number; match_cap: number; day: number; spent_today: number }

/** The torch flame a Warden's loot gives it (same as the contract's flame_of). */
export const flameOf = (loot: number[] = []): number => (loot[0] > 0 ? 1 : loot[2] > 0 ? 3 : loot[1] > 0 ? 2 : 0);

const today = (): number => Math.floor(Date.now() / 86_400_000);

/**
 * Fills in each seat's Warden and decides whether the match is ranked: only when a signed-in player
 * brings a Warden and every Warden seat can pay the fee (approved by its owner, enough in its purse,
 * and for an agent, inside today's caps).
 */
export async function planSeats(plans: SeatPlan[]): Promise<{ seats: SeatPlan[]; fee: number }> {
  const out: SeatPlan[] = [];
  let canPay = true;
  let human = false;
  for (const p0 of plans) {
    const p = { ...p0, warden: null as string | null, flame: 0 };
    if (config.chainEnabled) {
      if (p.kind === 'bot' && p.agent) p.warden = await agentWarden(p.agent);
      if (p.kind === 'human' && p.account) p.warden = await view<string | null>('warden_of', { account_id: p.account }).catch(() => null);
    }
    if (p.warden) {
      const t = await view<WardenRow | null>('get_warden', { warden: p.warden }).catch(() => null);
      p.flame = flameOf(t?.loot);
      if (!t || t.approved_fee < FEE || t.purse < FEE) canPay = false;
      if (p.kind === 'bot' && p.agent) {
        const pol = await view<AgentRow | null>('get_agent', { account_id: accountOf(p.agent) }).catch(() => null);
        const spent = pol && pol.day === today() ? pol.spent_today : 0;
        if (!pol || FEE > pol.match_cap || spent + FEE > pol.day_cap) canPay = false;
      }
      if (p.kind === 'human') human = true;
    } else if (p.kind === 'human') p.kind = 'guest';
    out.push(p);
  }
  return { seats: out, fee: human && canPay ? FEE : 0 };
}

export class ChainMatch {
  readonly id = `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  /** secret until the match is over; only its hash goes onchain at create */
  private readonly seed = randomBytes(16).toString('hex');
  readonly setup: Setup;
  readonly rec: MatchRecord;
  private created: Promise<boolean>;
  private pending: string[][] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly seats: SeatPlan[], readonly fee: number) {
    this.setup = { seed: this.seed, seats: seats.map((s): SeatSetup => ({ name: s.name, ...(s.kind === 'bot' ? { bot: s.agent?.skill ?? 'normal' } : {}), flame: s.flame ?? 0 })) };
    const rows: SeatRec[] = seats.map((s) => ({ name: s.name, kind: s.kind, account: s.account, warden: s.warden ?? null, bot: s.agent?.label }));
    this.rec = {
      id: this.id, createdAt: Date.now(), setup: { ...this.setup, seed: '' }, seats: rows, seedHash: sha256Hex(this.seed), fee, ranked: fee > 0,
      chunks: [], seals: [], head: headZero(this.id), sealedOnchain: 0, openedOnchain: 0, settled: false, txs: [], lines: [],
    };
    saveMatch(this.rec);
    this.created = this.create();
  }

  private async create(): Promise<boolean> {
    if (!config.chainEnabled) return false;
    try {
      const r = await call(config.referee, 'create_match', {
        match_id: this.id, seed_hash: this.rec.seedHash, fee: this.fee,
        seats: this.seats.map((s) => ({ warden: s.warden ?? null, name: s.name })),
      }, 60);
      this.rec.txs.push({ what: 'create_match', hash: r.tx });
      saveMatch(this.rec);
      return true;
    } catch (e) {
      this.rec.error = `create_match: ${(e as Error).message.slice(0, 300)}`;
      saveMatch(this.rec);
      return false;
    }
  }

  /** A chunk just closed: seal every seat's opening and queue the seals for the chain. */
  addChunk(openings: Opening[]): void {
    const k = this.rec.chunks.length;
    const seals = openings.map((o, seat) => sealOf(this.id, this.seed, seat, k, o));
    this.rec.chunks.push(openings);
    this.rec.seals.push(seals);
    this.rec.head = nextHead(this.rec.head, k, seals);
    this.pending.push(seals);
    void this.flush();
  }

  /** Posts every pending chunk's seals in one transaction (runs one at a time). */
  flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.pending.length || !(await this.created)) return;
      const batch = this.pending.splice(0, this.pending.length);
      const from = this.rec.sealedOnchain;
      try {
        const r = await call(config.referee, 'seal', { match_id: this.id, from_chunk: from, chunks: batch }, 30 + batch.length * 5);
        this.rec.sealedOnchain += batch.length;
        this.rec.txs.push({ what: `seal chunk${batch.length > 1 ? `s ${from}–${from + batch.length - 1}` : ` ${from}`}`, hash: r.tx });
      } catch (e) {
        this.pending.unshift(...batch);
        this.rec.error = `seal: ${(e as Error).message.slice(0, 200)}`;
      }
      saveMatch(this.rec);
    });
    return this.queue;
  }

  /** The match is over: reveal the seed, open every chunk onchain, settle. Results come back at once. */
  finish(s: State): { settled: Promise<void> } {
    const finals = s.wardens.map((w) => ({ hp: w.hp, embers: w.embers, kills: w.kills }));
    this.rec.seed = this.seed;
    this.rec.setup = this.setup;
    this.rec.endTick = s.tick;
    this.rec.winner = s.winner;
    this.rec.stateHash = stateHash(s);
    this.rec.expected = settle(this.rec.fee * this.seats.filter((x) => x.warden).length, this.seats.map((x) => !!x.warden), finals);
    saveMatch(this.rec);
    const settled = (async () => {
      await this.flush();
      if (!(await this.created)) return;
      for (let tries = 0; this.pending.length && tries < 3; tries++) await this.flush();
      try {
        const BATCH = 10;
        for (let from = this.rec.openedOnchain; from < this.rec.chunks.length; from = this.rec.openedOnchain) {
          const chunks = this.rec.chunks.slice(from, from + BATCH);
          const r = await call(config.referee, 'open_chunks', { match_id: this.id, seed: this.seed, from_chunk: from, chunks }, 150);
          this.rec.openedOnchain += chunks.length;
          this.rec.txs.push({ what: `open chunks ${from}–${from + chunks.length - 1}`, hash: r.tx });
          saveMatch(this.rec);
        }
        const r = await call(config.referee, 'settle_match', { match_id: this.id }, 100);
        this.rec.txs.push({ what: 'settle_match', hash: r.tx });
        this.rec.settled = true;
        delete this.rec.error;
      } catch (e) {
        this.rec.error = `settle: ${(e as Error).message.slice(0, 300)}`;
      }
      saveMatch(this.rec);
    })();
    return { settled };
  }
}

export const CHUNK_TICKS = CHUNK;
export { AGENTS };
