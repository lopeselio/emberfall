import { describe, expect, it } from 'vitest';
import { LEVELS, createState, replay, step, stateHash, viewFor, type LogEntry, type Skill } from '../src/index.ts';
import { humanDecide, humanMind } from '../src/human.ts';

// Rules v3: one difficulty for every AI rival in a match, chosen by the player.
const D: Skill[] = ['easy', 'normal', 'hard'];
const RIVALS: Skill[] = ['normal', 'easy', 'normal']; // a quick match's three: Wick, Moth, Sister Gloam

/** The reference human in one seat (rotating) against three bots; returns the state and the applied log. */
function play(seed: string, difficulty: Skill | undefined, me: number) {
  let b = 0;
  const setup = { seed, rules: 3, ...(difficulty ? { difficulty } : {}), seats: [0, 1, 2, 3].map((i) => (i === me ? { name: 'human' } : { name: `bot${i}`, bot: RIVALS[b++] })) };
  const s = createState(setup);
  const mind = humanMind(seed, me);
  const log: LogEntry[] = [];
  while (!s.over) {
    const t = s.tick;
    const { applied } = step(s, s.wardens.map((_, i) => (i === me ? humanDecide(viewFor(s, i), s.arena, mind) : null)));
    applied.forEach((a, c) => { if (a) log.push({ t, c, i: a }); });
  }
  return { setup, s, log };
}

describe('difficulty (rules v3)', () => {
  it('each step up reacts faster, aims truer, swings more and notices from further away', () => {
    for (const [lo, hi] of [[LEVELS.easy, LEVELS.normal], [LEVELS.normal, LEVELS.hard]]) {
      expect(hi.react).toBeLessThan(lo.react);
      expect(hi.aimMiss).toBeLessThan(lo.aimMiss);
      expect(hi.swing).toBeGreaterThan(lo.swing);
      expect(hi.dash).toBeGreaterThan(lo.dash);
      expect(hi.notice).toBeGreaterThan(lo.notice);
      expect(hi.engage).toBeGreaterThan(lo.engage);
      expect(hi.margin).toBeGreaterThan(lo.margin);
      expect(hi.idle).toBeLessThan(lo.idle);
    }
    // even the hard mind reacts no faster than a quick person (3 ticks = 150 ms)
    expect(LEVELS.hard.react).toBeGreaterThanOrEqual(3);
  });

  it('is part of the state from v3 on (missing or unknown = normal), and absent before', () => {
    const seats = [{ name: 'a' }, { name: 'b', bot: 'easy' as Skill }];
    expect(createState({ seed: 'd', rules: 3, seats }).difficulty).toBe('normal');
    expect(createState({ seed: 'd', rules: 3, difficulty: 'hard', seats }).difficulty).toBe('hard');
    expect(createState({ seed: 'd', rules: 3, difficulty: 'silly' as Skill, seats }).difficulty).toBe('normal');
    expect('difficulty' in createState({ seed: 'd', rules: 2, difficulty: 'hard', seats })).toBe(false);
    expect('foe' in createState({ seed: 'd', rules: 2, seats }).wardens[1].brain).toBe(false);
  });

  it('a v3 match replays from its log to the same state hash at every difficulty (what pnpm verify needs)', () => {
    for (const d of D) {
      const { setup, s, log } = play(`replay-${d}`, d, 1);
      const r = replay(setup, log);
      expect(r.tick).toBe(s.tick);
      expect(stateHash(r)).toBe(stateHash(s));
    }
    const hashes = D.map((d) => stateHash(play('same-seed', d, 0).s));
    expect(new Set(hashes).size).toBe(3);
  });

  it('the reference human wins most on easy and least on hard', () => {
    const n = 60;
    const rate = (d: Skill): number => {
      let w = 0;
      for (let m = 0; m < n; m++) { const { s } = play(`diff-test-${m}`, d, m % 4); if (s.winner === m % 4) w++; }
      return w / n;
    };
    const [easy, normal, hard] = D.map(rate);
    expect(easy).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(hard);
    expect(easy).toBeGreaterThan(0.4);
    expect(hard).toBeLessThan(0.35);
  }, 60_000);
});
