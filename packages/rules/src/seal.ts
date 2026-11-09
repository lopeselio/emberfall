import { sha256Hex } from './hash.ts';
import type { Applied, LogEntry, State } from './sim.ts';

// Sealed logs. Every chunk (60 ticks, 3 s) each seat's inputs and end-of-chunk state are hashed with a
// salt only the seed can produce; the referee posts the seals and the contract folds them into one
// chain head. At the end the seed and the chunks are opened and the contract re-folds them.
// contracts/emberfall/src/lib.rs builds exactly the same strings (shared test vector in both suites).

/** What one seat did in one chunk: its inputs and where it stood when the chunk closed. */
export interface Opening { inputs: string; x: number; z: number; hp: number; embers: number; kills: number }

export const saltOf = (seed: string, seat: number, chunk: number): string => sha256Hex(`emberfall|salt|${seed}|${seat}|${chunk}`);

export const sealPreimage = (match: string, seat: number, chunk: number, salt: string, o: Opening): string =>
  `emberfall|seal|${match}|${seat}|${chunk}|${salt}|${o.inputs}|${o.x},${o.z},${o.hp},${o.embers},${o.kills}`;

export const sealOf = (match: string, seed: string, seat: number, chunk: number, o: Opening): string =>
  sha256Hex(sealPreimage(match, seat, chunk, saltOf(seed, seat, chunk), o));

export const headZero = (match: string): string => sha256Hex(`emberfall|head|${match}`);
export const nextHead = (head: string, chunk: number, seals: string[]): string => sha256Hex(`${head}|${chunk}|${seals.join(',')}`);

/** The chain head after folding every chunk's seals in order. */
export function foldHead(match: string, chunks: string[][]): string {
  let h = headZero(match);
  chunks.forEach((seals, k) => { h = nextHead(h, k, seals); });
  return h;
}

// ---------- inputs as text ----------

const flags = (a: Applied): number => (a.swing ? 1 : 0) | (a.dash ? 2 : 0) | (a.takeover ? 4 : 0);
/** `tick:mx,mz,flags` or, with an aim, `tick:mx,mz,flags,ax,az` */
export const encodeEntry = (t: number, a: Applied): string => `${t}:${a.mx},${a.mz},${flags(a)}${a.ax || a.az ? `,${a.ax},${a.az}` : ''}`;

export function decodeInputs(text: string, seat: number): LogEntry[] {
  if (!text) return [];
  return text.split(';').map((part) => {
    const m = /^(\d+):(-?[01]),(-?[01]),([0-7])(?:,(-?[01]),(-?[01]))?$/.exec(part);
    if (!m) throw new Error(`bad log entry "${part}"`);
    const f = Number(m[4]);
    return { t: Number(m[1]), c: seat, i: { mx: Number(m[2]), mz: Number(m[3]), ax: Number(m[5] ?? 0), az: Number(m[6] ?? 0), swing: !!(f & 1), dash: !!(f & 2), takeover: !!(f & 4) } };
  });
}

/** Every seat's log, rebuilt from the opened chunks. */
export const logFromOpenings = (chunks: Opening[][]): LogEntry[] =>
  chunks.flatMap((seats) => seats.flatMap((o, seat) => decodeInputs(o.inputs, seat))).sort((a, b) => a.t - b.t || a.c - b.c);

export const stateOpening = (s: State, seat: number, inputs: string): Opening => {
  const w = s.wardens[seat];
  return { inputs, x: w.x, z: w.z, hp: w.hp, embers: w.embers, kills: w.kills };
};

/** Collects applied inputs as the match runs and closes a chunk's openings when asked. */
export class Recorder {
  private buf: string[][];
  constructor(readonly seats: number) { this.buf = Array.from({ length: seats }, () => []); }
  add(tick: number, applied: (Applied | null)[]): void {
    applied.forEach((a, i) => { if (a) this.buf[i].push(encodeEntry(tick, a)); });
  }
  close(s: State): Opening[] {
    const out = this.buf.map((entries, seat) => stateOpening(s, seat, entries.join(';')));
    this.buf = Array.from({ length: this.seats }, () => []);
    return out;
  }
}
