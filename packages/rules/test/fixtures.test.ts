import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHUNK, logFromOpenings, replay, stateHash, type Applied, type Opening, type Setup } from '../src/index.ts';

// Real matches played and settled on the hosted server, saved from /api/match/<id> before any later
// change to the bots. Each must replay, from its opened log alone, to the state hash the server
// recorded and through every sealed chunk state: that is what `pnpm verify` checks for a settled match.
// One is rules v1 (no `rules` field), one is rules v2.
interface Fixture { id: string; setup: Setup; chunks: Opening[][]; endTick: number; winner: number | null; stateHash: string }

const dir = join(import.meta.dirname, 'fixtures');
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture);

describe('settled matches still replay', () => {
  it('has a fixture for every frozen rules version', () => {
    const versions = new Set(fixtures.map((f) => f.setup.rules ?? 1));
    expect(versions.has(1)).toBe(true);
    expect(versions.has(2)).toBe(true);
  });

  for (const f of fixtures) {
    it(`${f.id} (rules v${f.setup.rules ?? 1}) replays to its recorded state hash`, () => {
      let k = 0, stateBad = 0, botBad = 0;
      const same = (x: Applied | null, y: Applied | null): boolean => JSON.stringify(x) === JSON.stringify(y);
      const s = replay(f.setup, logFromOpenings(f.chunks), (st, applied, logged) => {
        applied.forEach((a, i) => { if (st.wardens[i].bot && !same(a, logged[i])) botBad++; });
        if (st.tick % CHUNK === 0 || st.over) {
          (f.chunks[k] ?? []).forEach((o, seat) => {
            const w = st.wardens[seat];
            if (o.x !== w.x || o.z !== w.z || o.hp !== w.hp || o.embers !== w.embers || o.kills !== w.kills) stateBad++;
          });
          k++;
        }
      });
      expect(botBad).toBe(0);
      expect(stateBad).toBe(0);
      expect(k).toBe(f.chunks.length);
      expect(s.tick).toBe(f.endTick);
      expect(s.winner).toBe(f.winner);
      expect(stateHash(s)).toBe(f.stateHash);
    });
  }
});
