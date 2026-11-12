import { CENTER, type Arena } from './arena.ts';
import { dir8, steer } from './bot.ts';
import { HP, SWING_RANGE } from './constants.ts';
import { chance, int, rngFrom, type Rng } from './rng.ts';
import type { Input, View } from './sim.ts';

// The reference human: a deliberately average player, used only by the balance sims (`pnpm sim:human`),
// never by a match. It plays a human seat through the same fogged View a browser gets, so it can't see
// a bot outside its torch either. It reacts to what it saw ~250 ms ago, aims one notch off now and then,
// clicks in reach but not on the exact frame the swing is ready, gathers the nearest ember (and sticks
// with it), fights when it isn't clearly losing and runs at low health. It stays inside the light by eye.

export interface HumanMind {
  r: Rng;
  /** recent views, newest last: it acts on the one `lag` ticks old */
  seen: View[];
  lag: number;
  /** a full heart bar under the match's rules */
  maxHp: number;
  /** current ember it is walking to (kept until it vanishes) */
  ex: number; ez: number;
  gx: number; gz: number;
}

/** Knobs, all "average player": reaction ticks (20 = 1 s), % chances per tick. */
export const AVERAGE = {
  /** perceive-to-act delay in ticks, re-drawn each second (5 ≈ 250 ms) */
  lagMin: 4, lagMax: 6,
  /** % of aims a notch (45°) off */
  aimMiss: 25,
  /** % per ready tick that a click lands while a foe is in reach */
  click: 55,
  /** % per tick of a dash while closing in or running */
  dash: 4,
  /** % of ticks with hands off (looking at the minimap, adjusting grip) */
  idle: 4,
  /** how far inside the dark's edge it likes to stay */
  margin: 200,
  /** how far it will chase a Warden: with embers in sight, and without */
  near: 300, chase: 420,
  /** it runs at or below this share of a full heart bar (2 of 5) when the other Warden has more */
  runAt: 40,
};

export function humanMind(seed: string, seat: number, maxHp = HP): HumanMind {
  return { r: rngFrom(`emberfall|human|${seed}|${seat}`), seen: [], lag: 5, maxHp, ex: -1, ez: -1, gx: CENTER, gz: CENTER };
}

const RING: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const d2 = (ax: number, az: number, bx: number, bz: number): number => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

/** One tick of the reference human. `now` is this tick's view; its decisions use the lagged one. */
export function humanDecide(now: View, a: Arena, h: HumanMind, k = AVERAGE): Input {
  const r = h.r;
  h.seen.push(now);
  if (h.seen.length > 12) h.seen.shift();
  if (now.tick % 20 === 0) h.lag = int(r, k.lagMin, k.lagMax);
  const v = h.seen[Math.max(0, h.seen.length - 1 - h.lag)];
  const me = now.me;
  if (!me.alive) return {};
  if (chance(r, k.idle)) return {};
  const go = (mx: number, mz: number, extra: Input = {}): Input => {
    const [sx, sz] = steer(a, me.x, me.z, mx, mz, r);
    return { mx: sx, mz: sz, ax: 0, az: 0, ...extra };
  };

  // the light: it sees the ring, not where it will be, and it reacts late
  const safe = Math.max(250, v.darkR - k.margin);
  if (d2(me.x, me.z, CENTER, CENTER) > safe * safe) {
    const [mx, mz] = dir8(CENTER - me.x, CENTER - me.z);
    return go(mx, mz, { dash: v.darkR - Math.sqrt(d2(me.x, me.z, CENTER, CENTER)) < 0 && chance(r, k.dash * 3) });
  }

  // the nearest Warden it saw (positions are the lagged ones)
  let foe = null as View['others'][number] | null;
  for (const o of v.others) if (!foe || d2(o.x, o.z, me.x, me.z) < d2(foe.x, foe.z, me.x, me.z)) foe = o;
  if (foe) {
    const dist2 = d2(foe.x, foe.z, me.x, me.z);
    const losing = me.hp * 100 <= k.runAt * h.maxHp && foe.hp > me.hp;
    if (losing && dist2 < 500 * 500) {
      const [mx, mz] = dir8(me.x - foe.x + Math.trunc((CENTER - me.x) / 3), me.z - foe.z + Math.trunc((CENTER - me.z) / 3));
      return go(mx, mz, { dash: chance(r, k.dash * 2) });
    }
    // it goes for a Warden close by, or one further off when there's no ember in sight to take instead
    const chase = v.embers.length ? k.near : k.chase;
    if (!losing && dist2 < chase * chase) {
      let [ax, az] = dir8(foe.x - me.x, foe.z - me.z);
      if ((ax || az) && chance(r, k.aimMiss)) {
        const at = RING.findIndex(([x, z]) => x === ax && z === az);
        [ax, az] = RING[(at + (chance(r, 50) ? 1 : 7)) % 8];
      }
      const inReach = dist2 <= SWING_RANGE * SWING_RANGE;
      const swing = inReach && me.swingCd === 0 && chance(r, k.click);
      const [mx, mz] = dir8(foe.x - me.x, foe.z - me.z);
      const dash = !inReach && dist2 < 380 * 380 && chance(r, k.dash);
      return dist2 < 90 * 90 ? go(0, 0, { swing, ax, az }) : go(mx, mz, { swing, dash, ax, az });
    }
  }

  // embers: keep walking to the one it picked while it's still there, else take the nearest it sees
  const live = v.embers.filter((e) => d2(e.x, e.z, CENTER, CENTER) <= safe * safe);
  if (!live.some((e) => d2(e.x, e.z, h.ex, h.ez) < 40 * 40)) {
    let best = null as { x: number; z: number } | null;
    for (const e of live) if (!best || d2(e.x, e.z, me.x, me.z) < d2(best.x, best.z, me.x, me.z)) best = e;
    h.ex = best ? best.x : -1; h.ez = best ? best.z : -1;
  }
  if (h.ex >= 0) { const [mx, mz] = dir8(h.ex - me.x, h.ez - me.z); return go(mx, mz); }

  // nothing in sight: roam towards a spot nearer the middle
  if (d2(h.gx, h.gz, me.x, me.z) < 150 * 150 || d2(h.gx, h.gz, CENTER, CENTER) > safe * safe) {
    const reach = Math.trunc((safe * 6) / 10);
    h.gx = CENTER + int(r, -reach, reach); h.gz = CENTER + int(r, -reach, reach);
  }
  const [mx, mz] = dir8(h.gx - me.x, h.gz - me.z);
  return go(mx, mz);
}
