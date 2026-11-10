import { CENTER, SIZE, TILE, FLOOR, blocked, tileAt, type Arena } from './arena.ts';
import { DARK_END, DARK_R0, DARK_R1, DARK_START, RADIUS, SWING_RANGE } from './constants.ts';
import { chance, int, type Rng } from './rng.ts';
import type { Input, Skill, View } from './sim.ts';

// The Ashen Wardens' minds. A bot sees exactly what a player in its seat would see (its own View,
// fogged by its torch) plus the public map, and keeps a tiny memory (its own generator and a goal).
// It never reads the full state, so it can't see through the dark; `pnpm verify` re-runs every decision.

export interface Brain { r: Rng; gx: number; gz: number }

/**
 * fightHp: least health to start a fight · swing/dash: % chance per chance · margin: how far inside the
 * coming dark they keep · flee: how near a stronger Warden gets before they run · idle: % of ticks spent
 * dithering · engage: how far they'll chase · even: whether they take fights at equal health · wary: how
 * many rivals in view make them back off rather than fight (0 = never).
 */
interface Temper { fightHp: number; swing: number; dash: number; margin: number; flee: number; idle: number; engage: number; even: boolean; wary: number }

// Rules v1, frozen: settled matches replay with exactly these. In v1 "easy" was the most careful
// mind (it spots danger earliest and never takes an even fight), so it outlived everyone: easy bots
// won over 4× as often as normal ones in `pnpm sim`.
const V1: Record<Skill, Temper> = {
  easy: { fightHp: 4, swing: 40, dash: 2, margin: 160, flee: 420, idle: 12, engage: 300, even: false, wary: 0 },
  normal: { fightHp: 3, swing: 70, dash: 8, margin: 260, flee: 320, idle: 3, engage: 450, even: false, wary: 0 },
  hard: { fightHp: 2, swing: 80, dash: 16, margin: 380, flee: 220, idle: 0, engage: 650, even: true, wary: 0 },
};

// Rules v2: skill is competence, not caution. Easy minds notice danger late, dither, swing less and
// cut it fine with the dark, and they're brave enough to take even fights they then lose. Normal and
// hard minds also back off when two rivals are in view, instead of walking into a third-party brawl.
const V2: Record<Skill, Temper> = {
  easy: { fightHp: 3, swing: 20, dash: 2, margin: 100, flee: 140, idle: 10, engage: 340, even: true, wary: 0 },
  normal: { fightHp: 3, swing: 70, dash: 8, margin: 260, flee: 320, idle: 3, engage: 450, even: false, wary: 2 },
  hard: { fightHp: 2, swing: 90, dash: 16, margin: 380, flee: 280, idle: 0, engage: 650, even: true, wary: 2 },
};

export const TEMPERS: Record<number, Record<Skill, Temper>> = { 1: V1, 2: V2 };

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
const d2 = (ax: number, az: number, bx: number, bz: number): number => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

// same formula as the sim's (kept here so this file doesn't import sim at runtime)
function darkAt(tick: number): number {
  if (tick < DARK_START) return DARK_R0;
  if (tick >= DARK_END) return DARK_R1;
  return DARK_R0 - Math.trunc(((DARK_R0 - DARK_R1) * (tick - DARK_START)) / (DARK_END - DARK_START));
}

/** Eight-way direction towards (dx, dz). */
export function dir8(dx: number, dz: number): [number, number] {
  const ax = Math.abs(dx), az = Math.abs(dz);
  if (ax < 12 && az < 12) return [0, 0];
  return [ax * 5 > az * 2 ? sign(dx) : 0, az * 5 > ax * 2 ? sign(dz) : 0];
}

/** Turn a wished direction into one that isn't walking into a wall. */
export function steer(a: Arena, x: number, z: number, mx: number, mz: number, r: Rng): [number, number] {
  if (!mx && !mz) return [0, 0];
  const tries: [number, number][] = [[mx, mz], [mx, 0], [0, mz], [-mz, mx], [mz, -mx]];
  if (chance(r, 50)) [tries[3], tries[4]] = [tries[4], tries[3]];
  for (const [tx, tz] of tries) {
    if (!tx && !tz) continue;
    if (!blocked(a, x + tx * 45, z + tz * 45, RADIUS)) return [tx, tz];
  }
  return [0, 0];
}

function newGoal(a: Arena, r: Rng, within: number, b: Brain): void {
  for (let k = 0; k < 20; k++) {
    const tx = int(r, 1, SIZE - 2), tz = int(r, 1, SIZE - 2);
    const x = tx * TILE + TILE / 2, z = tz * TILE + TILE / 2;
    if (tileAt(a, tx, tz) === FLOOR && d2(x, z, CENTER, CENTER) <= within * within) { b.gx = x; b.gz = z; return; }
  }
  b.gx = CENTER; b.gz = CENTER;
}

/** One tick's decision for a bot. Mutates only the bot's own brain. */
export function decide(v: View, a: Arena, skill: Skill, brain: Brain, rules = 1): Input {
  const me = v.me;
  if (!me.alive) return {};
  const t = (TEMPERS[rules] ?? V1)[skill];
  const r = brain.r;
  const out = (mx: number, mz: number, extra: Input = {}): Input => {
    const [sx, sz] = steer(a, me.x, me.z, mx, mz, r);
    return { mx: sx, mz: sz, ax: 0, az: 0, ...extra };
  };

  if (t.idle && chance(r, t.idle)) return {};

  // 1. stay ahead of the dark
  const safe = Math.max(DARK_R1 - 120, darkAt(v.tick + 120) - t.margin);
  if (d2(me.x, me.z, CENTER, CENTER) > safe * safe) {
    const [mx, mz] = dir8(CENTER - me.x, CENTER - me.z);
    return out(mx, mz, { dash: me.dashCd === 0 && chance(r, t.dash * 2) });
  }

  // 2. the nearest Warden this torch reveals
  let foe = null as View['others'][number] | null;
  for (const o of v.others) if (!foe || d2(o.x, o.z, me.x, me.z) < d2(foe.x, foe.z, me.x, me.z)) foe = o;
  if (foe) {
    const dist2 = d2(foe.x, foe.z, me.x, me.z);
    // some take even fights; the others only fights they're ahead in (or ones worth the embers)
    const crowded = t.wary > 0 && v.others.filter((o) => d2(o.x, o.z, me.x, me.z) <= t.engage * t.engage).length >= t.wary;
    const fight = !crowded && me.hp >= t.fightHp && (t.even ? me.hp + 1 >= foe.hp : me.hp > foe.hp || (me.hp === foe.hp && foe.embers > me.embers));
    // early on, while the light is wide, they'd rather gather than fight
    const engage = v.tick < DARK_START ? Math.trunc(t.engage / 2) : t.engage;
    if (fight && dist2 <= engage * engage) {
      const [mx, mz] = dir8(foe.x - me.x, foe.z - me.z);
      const inReach = dist2 <= (SWING_RANGE - 25) ** 2;
      const swing = inReach && me.swingCd === 0 && chance(r, t.swing);
      const dash = !inReach && dist2 < 380 * 380 && dist2 > 200 * 200 && me.dashCd === 0 && chance(r, t.dash);
      // close in, but don't stand on top of them
      // aim at them, so a swing lands even while steering round a wall
      return dist2 < 80 * 80 ? out(mx, mz, { swing, ax: mx, az: mz }) : out(mx, mz, { swing, dash, ax: mx, az: mz });
    }
    if (dist2 < t.flee * t.flee || (crowded && dist2 < t.engage * t.engage)) {
      // run away from them, bending towards the centre so the dark doesn't get us instead
      const [mx, mz] = dir8(me.x - foe.x + Math.trunc((CENTER - me.x) / 3), me.z - foe.z + Math.trunc((CENTER - me.z) / 3));
      return out(mx, mz, { dash: me.dashCd === 0 && chance(r, t.dash) });
    }
  }

  // 3. the nearest ember inside the safe circle
  let best = null as { x: number; z: number } | null;
  for (const e of v.embers) {
    if (d2(e.x, e.z, CENTER, CENTER) > safe * safe) continue;
    if (!best || d2(e.x, e.z, me.x, me.z) < d2(best.x, best.z, me.x, me.z)) best = e;
  }
  if (best) { const [mx, mz] = dir8(best.x - me.x, best.z - me.z); return out(mx, mz); }

  // 4. wander to a goal inside the safe circle (stalkers drift towards the centre, where the light gathers)
  if (d2(brain.gx, brain.gz, me.x, me.z) < 120 * 120 || d2(brain.gx, brain.gz, CENTER, CENTER) > safe * safe || chance(r, 1)) {
    newGoal(a, r, Math.trunc((safe * (skill === 'hard' ? 7 : 9)) / 10), brain);
  }
  const [mx, mz] = dir8(brain.gx - me.x, brain.gz - me.z);
  return out(mx, mz);
}
