import { describe, expect, it } from 'vitest';
import {
  DARK_END, DARK_END_V4, DARK_R0, DARK_R1, DARK_START, DARK_START_V4, HP, HP_V4, LEVELS, LEVELS_V4, MAX_TICKS, createState, darkRadius, maxHp,
  replay, step, stateHash, viewFor, type LogEntry, type Skill,
} from '../src/index.ts';
import { humanDecide, humanMind } from '../src/human.ts';

// Rules v4: 8 hearts and a slower dark, so a match runs ~2.5 min instead of ~1.6 (`pnpm sim:human`).
const RIVALS: Skill[] = ['normal', 'easy', 'normal'];

function play(seed: string, difficulty: Skill, me: number, rules = 4) {
  let b = 0;
  const setup = { seed, rules, difficulty, seats: [0, 1, 2, 3].map((i) => (i === me ? { name: 'human' } : { name: `bot${i}`, bot: RIVALS[b++] })) };
  const s = createState(setup);
  const mind = humanMind(seed, me, maxHp(rules));
  const log: LogEntry[] = [];
  while (!s.over) {
    const t = s.tick;
    const { applied } = step(s, s.wardens.map((_, i) => (i === me ? humanDecide(viewFor(s, i), s.arena, mind) : null)));
    applied.forEach((a, c) => { if (a) log.push({ t, c, i: a }); });
  }
  return { setup, s, log };
}

describe('rules v4', () => {
  it('Wardens start with 8 hearts from v4 on; v1–v3 keep 5', () => {
    const seats = [{ name: 'a' }, { name: 'b', bot: 'easy' as Skill }];
    expect(HP_V4).toBe(8);
    expect(maxHp(4)).toBe(HP_V4);
    for (const rules of [undefined, 1, 2, 3]) expect(maxHp(rules)).toBe(HP);
    expect(createState({ seed: 'h', rules: 4, seats }).wardens.map((w) => w.hp)).toEqual([8, 8]);
    expect(createState({ seed: 'h', rules: 3, seats }).wardens.map((w) => w.hp)).toEqual([5, 5]);
    expect(createState({ seed: 'h', seats }).wardens.map((w) => w.hp)).toEqual([5, 5]);
  });

  it('the dark holds longer and closes just before the bell; v1–v3 keep their timing', () => {
    expect(DARK_START_V4).toBeGreaterThan(DARK_START);
    expect(DARK_END_V4).toBeGreaterThan(DARK_END);
    expect(DARK_END_V4).toBeLessThan(MAX_TICKS);
    expect(darkRadius(DARK_START_V4, 4)).toBe(DARK_R0);
    expect(darkRadius(DARK_END_V4, 4)).toBe(DARK_R1);
    expect(darkRadius(DARK_END, 4)).toBeGreaterThan(DARK_R1);
    for (const t of [0, DARK_START, 1500, DARK_END, 3000]) expect(darkRadius(t, 3)).toBe(darkRadius(t));
    // the views carry the version's radius
    const s = createState({ seed: 'd', rules: 4, seats: [{ name: 'a' }, { name: 'b' }] });
    s.tick = DARK_END;
    expect(viewFor(s, 0).darkR).toBe(darkRadius(DARK_END, 4));
  });

  it('keeps the difficulty ladder, and only touches the levels v4 needs', () => {
    for (const [lo, hi] of [[LEVELS_V4.easy, LEVELS_V4.normal], [LEVELS_V4.normal, LEVELS_V4.hard]]) {
      expect(hi.react).toBeLessThanOrEqual(lo.react);
      expect(hi.aimMiss).toBeLessThan(lo.aimMiss);
      expect(hi.swing).toBeGreaterThanOrEqual(lo.swing);
      expect(hi.notice).toBeGreaterThan(lo.notice);
      expect(hi.idle).toBeLessThan(lo.idle);
    }
    expect(LEVELS_V4.hard.react).toBeGreaterThanOrEqual(3);
    expect({ ...LEVELS_V4.hard, calm: LEVELS.hard.calm }).toEqual(LEVELS.hard);
  });

  it('a v4 match replays from its log to the same state hash (what pnpm verify needs), and differs from v3', () => {
    for (const d of ['easy', 'normal', 'hard'] as Skill[]) {
      const { setup, s, log } = play(`v4-replay-${d}`, d, 2);
      const r = replay(setup, log);
      expect(r.tick).toBe(s.tick);
      expect(stateHash(r)).toBe(stateHash(s));
    }
    expect(stateHash(play('v4-vs-v3', 'normal', 0).s)).not.toBe(stateHash(play('v4-vs-v3', 'normal', 0, 3).s));
  });

  it('matches run longer than in v3, and the reference human still wins most on easy and least on hard', () => {
    const n = 48;
    const run = (d: Skill, rules: number) => {
      let w = 0, ticks = 0;
      for (let m = 0; m < n; m++) { const { s } = play(`v4-test-${m}`, d, m % 4, rules); ticks += s.tick; if (s.winner === m % 4) w++; }
      return { rate: w / n, mean: ticks / n };
    };
    const [easy, normal, hard] = (['easy', 'normal', 'hard'] as Skill[]).map((d) => run(d, 4));
    expect(easy.rate).toBeGreaterThan(normal.rate);
    expect(normal.rate).toBeGreaterThan(hard.rate);
    expect(normal.mean).toBeGreaterThan(run('normal', 3).mean * 1.2);
    expect(normal.mean).toBeGreaterThan(130 * 20);
  }, 90_000);
});
