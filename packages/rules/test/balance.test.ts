import { describe, expect, it } from 'vitest';
import { CURRENT_RULES, createState, step, stateHash, type Skill } from '../src/index.ts';

// Bot tuning is versioned by Setup.rules. v1 must never change: settled matches replay with it, and
// `pnpm verify` re-runs every bot decision. These hashes were recorded before v2 existed.
const MIX: Skill[] = ['hard', 'normal', 'normal', 'easy', 'easy', 'normal'];
const run = (seed: string, rules?: number, seats: Skill[] = MIX) => {
  const s = createState({ seed, seats: seats.map((b, i) => ({ name: `${b}${i}`, bot: b })), ...(rules ? { rules } : {}) });
  while (!s.over) step(s, []);
  return s;
};

describe('rules versions', () => {
  it('v1 (no rules field) replays exactly as it did before the rebalance', () => {
    const pins: Record<string, string> = {
      'v1-pin-a': '96f3cd50e3d385467e0ea952b7dfe39b3f187129eb0b4b7208b8a286dfb1f9e8',
      'v1-pin-b': '3cdb599adb55c8990e3def9524b2ddcfcf4c8af549ac731295cf42d0d054c5f6',
      'v1-pin-c': '05f491622ebcf3aee9ce4554950fa7e181b1311bdd671fc65baa80987e6182d4',
    };
    for (const [seed, hash] of Object.entries(pins)) expect(stateHash(run(seed))).toBe(hash);
    // an explicit rules: 1 is the same game
    expect(stateHash(run('v1-pin-a', 1))).toBe(pins['v1-pin-a']);
  });

  it('v2 replays exactly as it did when v2 shipped (settled v2 matches exist)', () => {
    const pins: Record<string, string> = {
      'v2-pin-a': '2576a21bcbf1b6912cb4b7a83603657bea5cbdc36bed21293a7fe395779ba33f',
      'v2-pin-b': '66f479200bf544afbe2e11146d82d7766205dc26b81685f6fc5fba00314eef1b',
      'v2-pin-c': 'd8903e22692cb95ff37b4edb2cbe79ce5cca26db2afcce256508346c6499cd95',
    };
    for (const [seed, hash] of Object.entries(pins)) expect(stateHash(run(seed, 2))).toBe(hash);
  });

  it('new matches use v4; v2 is a different game from v1', () => {
    expect(CURRENT_RULES).toBe(4);
    const s = run('v1-pin-a', 2);
    expect(s.rules).toBe(2);
    expect(stateHash(s)).not.toBe('96f3cd50e3d385467e0ea952b7dfe39b3f187129eb0b4b7208b8a286dfb1f9e8');
  });

  it('in v2 skill wins: per bot, hard beats normal beats easy in a full arena', () => {
    const wins: Record<Skill, number> = { easy: 0, normal: 0, hard: 0 };
    const n = 120;
    for (let m = 0; m < n; m++) {
      const s = run(`balance-test-${m}`, 2);
      if (s.winner !== null) wins[MIX[s.winner]]++;
    }
    const perBot = (k: Skill) => wins[k] / MIX.filter((x) => x === k).length;
    expect(perBot('hard')).toBeGreaterThan(perBot('normal'));
    expect(perBot('normal')).toBeGreaterThan(perBot('easy'));
  });
});
