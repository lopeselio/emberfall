import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Opening, Settlement, Setup } from '@emberfall/rules';
import { config } from './config.ts';
import type { SignedLine } from './nearai.ts';

// Match records: one JSON file each under DATA_DIR/matches (an Azure Files share when hosted, so proof
// bundles survive restarts and redeploys), plus a small key-value file for the agents' memory.

export interface SeatRec { name: string; kind: 'human' | 'guest' | 'bot'; account?: string; warden: string | null; bot?: string }

export interface MatchRecord {
  id: string;
  createdAt: number;
  setup: Setup;
  seats: SeatRec[];
  seedHash: string;
  /** revealed only once the match is over */
  seed?: string;
  fee: number;
  ranked: boolean;
  /** every closed chunk's openings (secret until the end) and seals (public as they're posted) */
  chunks: Opening[][];
  seals: string[][];
  head: string;
  endTick?: number;
  winner?: number | null;
  stateHash?: string;
  /** what packages/rules says the settlement should be */
  expected?: Settlement;
  sealedOnchain: number;
  openedOnchain: number;
  settled: boolean;
  txs: { what: string; hash: string }[];
  lines: SignedLine[];
  error?: string;
}

const dir = join(config.dataDir, 'matches');
mkdirSync(dir, { recursive: true });
const mem = new Map<string, MatchRecord>();

export const validId = (id: string): boolean => /^[a-z0-9-]{1,40}$/.test(id);

export function saveMatch(m: MatchRecord): void {
  mem.set(m.id, m);
  const file = join(dir, `${m.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(m));
  renameSync(`${file}.tmp`, file);
}

export function loadMatch(id: string): MatchRecord | null {
  if (!validId(id)) return null;
  const hit = mem.get(id);
  if (hit) return hit;
  try {
    const m = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as MatchRecord;
    mem.set(id, m);
    return m;
  } catch { return null; }
}

/** The most recent finished matches, newest first. */
export function recentMatches(n: number): MatchRecord[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
    .map((f) => loadMatch(f.slice(0, -5))).filter((m): m is MatchRecord => !!m && m.endTick !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
}

// ---------- key-value ----------

const kvFile = join(config.dataDir, 'kv.json');
let kv: Record<string, unknown> = (() => { try { return JSON.parse(readFileSync(kvFile, 'utf8')) as Record<string, unknown>; } catch { return {}; } })();
export const kvGet = <T>(k: string, d: T): T => (k in kv ? (kv[k] as T) : d);
export function kvSet(k: string, v: unknown): void {
  kv = { ...kv, [k]: v };
  writeFileSync(`${kvFile}.tmp`, JSON.stringify(kv));
  renameSync(`${kvFile}.tmp`, kvFile);
}
