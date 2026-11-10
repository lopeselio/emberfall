import { CENTER, SIZE, TILE, FLOOR, blocked, tileAt, type Arena } from './arena.ts';
import { DARK_END, DARK_R0, DARK_R1, DARK_START, RADIUS, SWING_RANGE } from './constants.ts';
import { chance, int, type Rng } from './rng.ts';
import type { Input, Skill, View } from './sim.ts';

// The Ashen Wardens' minds. A bot sees exactly what a player in its seat would see (its own View,
// fogged by its torch) plus the public map, and keeps a tiny memory (its own generator and a goal).
// It never reads the full state, so it can't see through the dark; `pnpm verify` re-runs every decision.

export interface Brain {
  r: Rng; gx: number; gz: number;
  /** v3 only (absent before, so v1/v2 states hash as they always did): the Warden it is watching, for how
   * many ticks, and where it saw that Warden on the last few ticks (it acts on the oldest: its reaction lag) */
  foe?: number; seen?: number; trail?: number[];
}

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
export function decide(v: View, a: Arena, skill: Skill, brain: Brain, rules = 1, difficulty: Skill = 'normal'): Input {
  if (rules >= 3) return decideV3(v, a, skill, brain, difficulty);
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

// ---------- rules v3: an explicit difficulty, and minds with human limits ----------

/**
 * One difficulty level. react: ticks before it acts on a Warden it just noticed, and how stale the
 * position it chases and aims at is (5 ≈ a person's 250 ms) · aimMiss: % of aims a notch (45°) off ·
 * swing: % per ready tick that it swings with a Warden in reach · dash: % per tick it dashes when it
 * could · notice: how far away it reacts to a Warden at all · engage: how far it chases · calm: until
 * this tick it would rather gather than start a fight · fightHp: least health to start one · even: takes
 * fights at equal health · retreat: runs when at or below this health and the other Warden has more ·
 * margin: how far inside the coming dark it keeps · idle: % of ticks spent dithering · wary: rivals in
 * view that make it back off (0 = never).
 */
export interface Level {
  react: number; aimMiss: number; swing: number; dash: number; notice: number; engage: number; calm: number;
  fightHp: number; even: boolean; retreat: number; margin: number; idle: number; wary: number;
}

export const LEVELS: Record<Skill, Level> = {
  easy: { react: 5, aimMiss: 30, swing: 35, dash: 2, notice: 420, engage: 320, calm: 2400, fightHp: 3, even: true, retreat: 1, margin: 120, idle: 8, wary: 2 },
  normal: { react: 4, aimMiss: 15, swing: 60, dash: 7, notice: 520, engage: 420, calm: 2200, fightHp: 3, even: true, retreat: 2, margin: 220, idle: 3, wary: 2 },
  hard: { react: 3, aimMiss: 5, swing: 80, dash: 14, notice: 650, engage: 560, calm: 1800, fightHp: 2, even: true, retreat: 2, margin: 320, idle: 0, wary: 2 },
};

/** A persona's style on top of the level: Moth and Old Tallow gather, Brannoc brawls. */
const STYLE: Record<Skill, { engage: number; calm: number }> = {
  easy: { engage: 80, calm: 120 },
  normal: { engage: 100, calm: 100 },
  hard: { engage: 115, calm: 70 },
};

const RING: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function decideV3(v: View, a: Arena, persona: Skill, b: Brain, difficulty: Skill): Input {
  const me = v.me;
  if (!me.alive) return {};
  const L = LEVELS[difficulty] ?? LEVELS.normal;
  const st = STYLE[persona] ?? STYLE.normal;
  const engageR = Math.trunc((L.engage * st.engage) / 100);
  const calm = Math.trunc((L.calm * st.calm) / 100);
  const r = b.r;
  const out = (mx: number, mz: number, extra: Input = {}): Input => {
    const [sx, sz] = steer(a, me.x, me.z, mx, mz, r);
    return { mx: sx, mz: sz, ax: 0, az: 0, ...extra };
  };

  // what it has noticed: the nearest Warden in its light and within notice, watched for b.seen ticks
  let foe = null as View['others'][number] | null;
  for (const o of v.others) {
    if (d2(o.x, o.z, me.x, me.z) > L.notice * L.notice) continue;
    if (!foe || d2(o.x, o.z, me.x, me.z) < d2(foe.x, foe.z, me.x, me.z)) foe = o;
  }
  if (!foe || foe.seat !== b.foe) { b.foe = foe ? foe.seat : -1; b.seen = 0; b.trail = []; }
  const trail = b.trail ?? (b.trail = []);
  if (foe) {
    b.seen = (b.seen ?? 0) + 1;
    trail.push(foe.x, foe.z);
    if (trail.length > 2 * (L.react + 1)) trail.splice(0, 2);
  }

  if (L.idle && chance(r, L.idle)) return {};

  // 1. stay ahead of the dark
  const safe = Math.max(DARK_R1 - 120, darkAt(v.tick + 120) - L.margin);
  if (d2(me.x, me.z, CENTER, CENTER) > safe * safe) {
    const [mx, mz] = dir8(CENTER - me.x, CENTER - me.z);
    return out(mx, mz, { dash: me.dashCd === 0 && chance(r, L.dash * 2) });
  }

  // 2. a Warden it has had time to react to, where it was a moment ago
  if (foe && (b.seen ?? 0) > L.react) {
    const fx = trail[0], fz = trail[1];
    const dist2 = d2(fx, fz, me.x, me.z);
    const near = v.others.filter((o) => d2(o.x, o.z, me.x, me.z) <= engageR * engageR).length;
    const crowded = L.wary > 0 && near >= L.wary;
    const losing = me.hp <= L.retreat && foe.hp > me.hp;
    const fight = !crowded && !losing && me.hp >= L.fightHp
      && (L.even ? me.hp >= foe.hp : me.hp > foe.hp || (me.hp === foe.hp && foe.embers > me.embers));
    const chase = v.tick < calm ? Math.trunc(engageR / 2) : engageR;
    if (fight && dist2 <= chase * chase) {
      let [ax, az] = dir8(fx - me.x, fz - me.z);
      if ((ax || az) && chance(r, L.aimMiss)) {
        const at = RING.findIndex(([x, z]) => x === ax && z === az);
        [ax, az] = RING[(at + (chance(r, 50) ? 1 : 7)) % 8];
      }
      const inReach = dist2 <= (SWING_RANGE - 25) ** 2;
      const swing = inReach && me.swingCd === 0 && chance(r, L.swing);
      const dash = !inReach && dist2 < 380 * 380 && dist2 > 200 * 200 && me.dashCd === 0 && chance(r, L.dash);
      const [mx, mz] = dir8(fx - me.x, fz - me.z);
      return dist2 < 80 * 80 ? out(0, 0, { swing, ax, az }) : out(mx, mz, { swing, dash, ax, az });
    }
    if (losing || (crowded && dist2 < engageR * engageR) || (!fight && dist2 < 260 * 260)) {
      const [mx, mz] = dir8(me.x - fx + Math.trunc((CENTER - me.x) / 3), me.z - fz + Math.trunc((CENTER - me.z) / 3));
      return out(mx, mz, { dash: me.dashCd === 0 && chance(r, L.dash) });
    }
  }

  // 3. the nearest ember inside the safe circle
  let best = null as { x: number; z: number } | null;
  for (const e of v.embers) {
    if (d2(e.x, e.z, CENTER, CENTER) > safe * safe) continue;
    if (!best || d2(e.x, e.z, me.x, me.z) < d2(best.x, best.z, me.x, me.z)) best = e;
  }
  if (best) { const [mx, mz] = dir8(best.x - me.x, best.z - me.z); return out(mx, mz); }

  // 4. wander to a goal inside the safe circle
  if (d2(b.gx, b.gz, me.x, me.z) < 120 * 120 || d2(b.gx, b.gz, CENTER, CENTER) > safe * safe || chance(r, 1)) {
    newGoal(a, r, Math.trunc((safe * 8) / 10), b);
  }
  const [mx, mz] = dir8(b.gx - me.x, b.gz - me.z);
  return out(mx, mz);
}
