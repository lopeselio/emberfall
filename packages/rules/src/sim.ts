import { CENTER, SIZE, TILE, blocked, lineOfSight, makeArena, tileAt, FLOOR, type Arena } from './arena.ts';
import { decide, type Brain } from './bot.ts';
import {
  CHUNK, DARK_DMG_EVERY, DARK_END, DARK_R0, DARK_R1, DARK_START, DASH_CD, DASH_MULT, DASH_TICKS, DIAG, EMBER_EVERY, EMBER_LIMIT,
  EMBER_UNTIL, EMBERS_START, GLOW_MAX, GLOW_PER_EMBER, GRACE, HP, KNOCK, MAX_SEATS, MAX_TICKS, PICKUP, RADIUS, SPEED, SWING_CD,
  SWING_RANGE, VIEW,
} from './constants.ts';
import { canonical, sha256Hex } from './hash.ts';
import { int, rngFrom, type Rng } from './rng.ts';

// The match. The server runs it at 20 ticks a second; anyone can run it again from the opened log.
// Deterministic: integer positions, the seeded generator in the state, a fixed order for everything.

export type Skill = 'easy' | 'normal' | 'hard';

export interface SeatSetup {
  name: string;
  /** an AI rival (decides from its own fogged view) */
  bot?: Skill;
  /** torch flame from the Warden's loot (0 plain, 1 crown/gold, 2 fang/red, 3 glass/white): looks only */
  flame?: number;
}
export interface Setup { seed: string; seats: SeatSetup[] }

/** What a player (or the server, for a bot) asks for this tick. Movement is held until changed. */
export interface Input { mx?: number; mz?: number; swing?: boolean; dash?: boolean; takeover?: boolean }

/** The input that actually took effect: the log and the seals are made of these. */
export interface Applied { mx: number; mz: number; swing: boolean; dash: boolean; takeover: boolean }

export interface Warden {
  name: string;
  x: number; z: number;
  /** facing, each -1..1 (8 directions) */
  fx: number; fz: number;
  /** held movement */
  mx: number; mz: number;
  hp: number; embers: number; kills: number;
  swingCd: number; swingT: number; dashCd: number; dashT: number; grace: number;
  alive: boolean;
  fellAt: number;
  bot: Skill | null;
  flame: number;
  brain: Brain;
}

export interface Ember { id: number; x: number; z: number }

export interface State {
  seed: string;
  tick: number;
  wardens: Warden[];
  embers: Ember[];
  nextEmber: number;
  rng: Rng;
  over: boolean;
  winner: number | null;
  /** derived from the seed; left out of the state hash */
  arena: Arena;
}

export type SimEvent =
  | { t: 'swing'; w: number; x: number; z: number }
  | { t: 'hit'; w: number; by: number; x: number; z: number }
  | { t: 'fall'; w: number; by: number; x: number; z: number }
  | { t: 'pick'; w: number; x: number; z: number }
  | { t: 'dash'; w: number; x: number; z: number }
  | { t: 'burn'; w: number; x: number; z: number };

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
const clampDir = (n: unknown, d: number): number => (n === -1 || n === 0 || n === 1 ? n : d);
const d2 = (ax: number, az: number, bx: number, bz: number): number => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

export function darkRadius(tick: number): number {
  if (tick < DARK_START) return DARK_R0;
  if (tick >= DARK_END) return DARK_R1;
  return DARK_R0 - Math.trunc(((DARK_R0 - DARK_R1) * (tick - DARK_START)) / (DARK_END - DARK_START));
}

export const insideDark = (x: number, z: number, tick: number): boolean => d2(x, z, CENTER, CENTER) <= darkRadius(tick) ** 2;

export function createState(setup: Setup): State {
  if (setup.seats.length < 1 || setup.seats.length > MAX_SEATS) throw new Error(`1–${MAX_SEATS} seats`);
  const arena = makeArena(setup.seed);
  const wardens: Warden[] = setup.seats.map((seat, i) => {
    const p = arena.spawns[i];
    return {
      name: seat.name, x: p.x, z: p.z, fx: sign(CENTER - p.x), fz: sign(CENTER - p.z), mx: 0, mz: 0,
      hp: HP, embers: 0, kills: 0, swingCd: 0, swingT: 0, dashCd: 0, dashT: 0, grace: 0, alive: true, fellAt: -1,
      bot: seat.bot ?? null, flame: Math.max(0, Math.min(3, seat.flame ?? 0)),
      brain: { s: rngFrom(`emberfall|bot|${setup.seed}|${i}`).s, gx: CENTER, gz: CENTER },
    };
  });
  const s: State = { seed: setup.seed, tick: 0, wardens, embers: [], nextEmber: 0, rng: rngFrom(`emberfall|sim|${setup.seed}`), over: false, winner: null, arena };
  for (let k = 0; k < EMBERS_START; k++) spawnEmber(s);
  return s;
}

function spawnEmber(s: State): void {
  if (s.embers.length >= EMBER_LIMIT) return;
  const r = darkRadius(s.tick) - 80;
  for (let tries = 0; tries < 24; tries++) {
    const tx = int(s.rng, 1, SIZE - 2), tz = int(s.rng, 1, SIZE - 2);
    if (tileAt(s.arena, tx, tz) !== FLOOR) continue;
    const x = tx * TILE + TILE / 2 + int(s.rng, -30, 30), z = tz * TILE + TILE / 2 + int(s.rng, -30, 30);
    if (d2(x, z, CENTER, CENTER) > r * r) continue;
    s.embers.push({ id: s.nextEmber++, x, z });
    return;
  }
}

// eight directions, scaled by 100 (diagonals ×0.7)
const OFF8: [number, number][] = [[100, 0], [70, 70], [0, 100], [-70, 70], [-100, 0], [-70, -70], [0, -100], [70, -70]];

/** Drops n embers around (x, z), onto open floor. */
function spill(s: State, x: number, z: number, n: number): void {
  for (let k = 0; k < n; k++) {
    const [ox, oz] = OFF8[(k + int(s.rng, 0, 7)) % 8];
    const r = 80 + int(s.rng, 0, 50) + 40 * Math.floor(k / 8);
    let ex = x + Math.trunc((ox * r) / 100), ez = z + Math.trunc((oz * r) / 100);
    if (blocked(s.arena, ex, ez, 10)) { ex = x; ez = z; }
    s.embers.push({ id: s.nextEmber++, x: ex, z: ez });
  }
}

function moveAxis(s: State, w: Warden, dx: number, dz: number): void {
  for (let d = dx; d !== 0; d = Math.trunc(d / 2)) if (!blocked(s.arena, w.x + d, w.z, RADIUS)) { w.x += d; break; }
  for (let d = dz; d !== 0; d = Math.trunc(d / 2)) if (!blocked(s.arena, w.x, w.z + d, RADIUS)) { w.z += d; break; }
}

function fall(s: State, i: number, by: number, ev: SimEvent[]): void {
  const w = s.wardens[i];
  w.alive = false;
  w.hp = 0;
  w.fellAt = s.tick;
  w.mx = 0; w.mz = 0; w.dashT = 0;
  if (by >= 0) s.wardens[by].kills++;
  spill(s, w.x, w.z, w.embers);
  w.embers = 0;
  ev.push({ t: 'fall', w: i, by, x: w.x, z: w.z });
}

export const aliveCount = (s: State): number => s.wardens.filter((w) => w.alive).length;

/**
 * The winner among final states: the living Warden with the most embers, then most hearts, then the
 * lowest seat; nobody if all fell. The contract applies the same rule to the opened log.
 */
export function winnerOf(finals: { hp: number; embers: number }[]): number | null {
  let best: number | null = null;
  finals.forEach((f, i) => {
    if (f.hp <= 0) return;
    if (best === null) { best = i; return; }
    const b = finals[best];
    if (f.embers > b.embers || (f.embers === b.embers && f.hp > b.hp)) best = i;
  });
  return best;
}

/** One tick. `given[i]` is seat i's input (ignored for bots, which decide for themselves). */
export function step(s: State, given: (Input | null | undefined)[]): { events: SimEvent[]; applied: (Applied | null)[] } {
  const ev: SimEvent[] = [];
  const applied: (Applied | null)[] = s.wardens.map(() => null);
  if (s.over) return { events: ev, applied };

  // 1. every seat's wish, all decided on the same start-of-tick state (bots from their own fogged view)
  const wish: (Input & { takeover?: boolean })[] = s.wardens.map((w, i) => {
    if (!w.alive) return {};
    const g = given[i] ?? {};
    let takeover = false;
    if (!w.bot && g.takeover) { w.bot = 'normal'; takeover = true; }
    if (w.bot) return { ...decide(viewFor(s, i), s.arena, w.bot, w.brain), takeover };
    return { mx: g.mx, mz: g.mz, swing: g.swing, dash: g.dash };
  });

  // 2. apply: held movement, swing and dash (only when ready, so the log holds only what happened)
  const swung: number[] = [];
  s.wardens.forEach((w, i) => {
    if (!w.alive) return;
    const q = wish[i];
    const mx = clampDir(q.mx, w.mx), mz = clampDir(q.mz, w.mz);
    const swing = !!q.swing && w.swingCd === 0;
    const dash = !!q.dash && w.dashCd === 0;
    const takeover = !!q.takeover;
    if (mx !== w.mx || mz !== w.mz || swing || dash || takeover) applied[i] = { mx, mz, swing, dash, takeover };
    w.mx = mx; w.mz = mz;
    if (mx || mz) { w.fx = mx; w.fz = mz; }
    if (swing) { w.swingCd = SWING_CD; w.swingT = 6; swung.push(i); ev.push({ t: 'swing', w: i, x: w.x, z: w.z }); }
    if (dash) { w.dashCd = DASH_CD; w.dashT = DASH_TICKS; ev.push({ t: 'dash', w: i, x: w.x, z: w.z }); }
  });

  // 3. movement
  for (const w of s.wardens) {
    if (!w.alive || (!w.mx && !w.mz)) continue;
    const base = w.mx && w.mz ? DIAG : SPEED;
    const v = w.dashT > 0 ? base * DASH_MULT : base;
    moveAxis(s, w, w.mx * v, w.mz * v);
  }

  // 4. swings, in seat order
  for (const i of swung) {
    const a = s.wardens[i];
    if (!a.alive) continue;
    s.wardens.forEach((t, j) => {
      if (j === i || !t.alive || t.grace > 0) return;
      const dx = t.x - a.x, dz = t.z - a.z;
      if (dx * dx + dz * dz > SWING_RANGE * SWING_RANGE || a.fx * dx + a.fz * dz < 0) return;
      t.hp--;
      t.grace = GRACE;
      const k = a.fx && a.fz ? Math.trunc((KNOCK * 7) / 10) : KNOCK;
      moveAxis(s, t, a.fx * k, a.fz * k);
      ev.push({ t: 'hit', w: j, by: i, x: t.x, z: t.z });
      if (t.hp <= 0) { fall(s, j, i, ev); return; }
      if (t.embers > 0) {
        // the ember is knocked out past the victim, towards the attacker's reach
        t.embers--;
        let ex = t.x + a.fx * 90, ez = t.z + a.fz * 90;
        if (blocked(s.arena, ex, ez, 10)) { ex = t.x; ez = t.z; }
        s.embers.push({ id: s.nextEmber++, x: ex, z: ez });
      }
    });
  }

  // 5. the dark bites once a second
  if (s.tick > 0 && s.tick % DARK_DMG_EVERY === 0) {
    s.wardens.forEach((w, i) => {
      if (!w.alive || insideDark(w.x, w.z, s.tick)) return;
      w.hp--;
      ev.push({ t: 'burn', w: i, x: w.x, z: w.z });
      if (w.hp <= 0) fall(s, i, -1, ev);
    });
  }

  // 6. pick up embers
  s.wardens.forEach((w, i) => {
    if (!w.alive) return;
    const keep: Ember[] = [];
    for (const e of s.embers) {
      if (d2(e.x, e.z, w.x, w.z) <= PICKUP * PICKUP) { w.embers++; ev.push({ t: 'pick', w: i, x: e.x, z: e.z }); } else keep.push(e);
    }
    s.embers = keep;
  });

  // 7. new embers rise inside the light
  if (s.tick > 0 && s.tick < EMBER_UNTIL && s.tick % EMBER_EVERY === 0) spawnEmber(s);

  // 8. timers
  for (const w of s.wardens) {
    if (w.swingCd > 0) w.swingCd--;
    if (w.swingT > 0) w.swingT--;
    if (w.dashCd > 0) w.dashCd--;
    if (w.dashT > 0) w.dashT--;
    if (w.grace > 0) w.grace--;
  }
  s.tick++;

  if ((s.wardens.length >= 2 && aliveCount(s) <= 1) || s.tick >= MAX_TICKS) {
    s.over = true;
    s.winner = winnerOf(s.wardens);
  }
  return { events: ev, applied };
}

// ---------- the fog ----------

/** How far away seat j can be seen: the torch radius plus its ember glow. */
const seenFrom = (w: Warden): number => VIEW + Math.min(w.embers, GLOW_MAX) * GLOW_PER_EMBER;

/** Can seat i's torch reveal a point (with an extra reach for glowing things)? */
export function canSee(s: State, i: number, x: number, z: number, reach = VIEW): boolean {
  const me = s.wardens[i];
  if (d2(me.x, me.z, x, z) > reach * reach) return false;
  return lineOfSight(s.arena, me.x, me.z, x, z);
}

export interface WardenView {
  seat: number; name: string; x: number; z: number; fx: number; fz: number;
  hp: number; embers: number; alive: boolean; swingT: number; dashT: number; grace: number; flame: number;
}
export interface View {
  tick: number;
  you: number;
  me: WardenView & { swingCd: number; dashCd: number; kills: number };
  /** other Wardens your torch reveals */
  others: WardenView[];
  embers: Ember[];
  darkR: number;
  alive: number;
  over: boolean;
  winner: number | null;
}

const wv = (w: Warden, seat: number): WardenView => ({
  seat, name: w.name, x: w.x, z: w.z, fx: w.fx, fz: w.fz, hp: w.hp, embers: w.embers, alive: w.alive,
  swingT: w.swingT, dashT: w.dashT, grace: w.grace, flame: w.flame,
});

/** Everything seat i is allowed to know right now. This is all a client (or a bot) ever gets. */
export function viewFor(s: State, i: number): View {
  const me = s.wardens[i];
  const others: WardenView[] = [];
  s.wardens.forEach((w, j) => { if (j !== i && w.alive && canSee(s, i, w.x, w.z, seenFrom(w))) others.push(wv(w, j)); });
  return {
    tick: s.tick, you: i,
    me: { ...wv(me, i), swingCd: me.swingCd, dashCd: me.dashCd, kills: me.kills },
    others,
    embers: s.embers.filter((e) => canSee(s, i, e.x, e.z)),
    darkR: darkRadius(s.tick), alive: aliveCount(s), over: s.over, winner: s.winner,
  };
}

/** Events seat i may hear about: its own, ones its torch reveals, and every fall (without where). */
export function eventsFor(s: State, i: number, ev: SimEvent[]): SimEvent[] {
  const out: SimEvent[] = [];
  for (const e of ev) {
    if (e.w === i || ('by' in e && e.by === i) || canSee(s, i, e.x, e.z, VIEW + 100)) out.push(e);
    else if (e.t === 'fall') out.push({ ...e, x: -1, z: -1 });
  }
  return out;
}

// ---------- hashing and replay ----------

export const stateHash = (s: State): string => sha256Hex(canonical({ ...s, arena: undefined }));

export interface LogEntry { t: number; c: number; i: Applied }

const asInput = (a: Applied): Input => ({ mx: a.mx, mz: a.mz, swing: a.swing, dash: a.dash, takeover: a.takeover });

/**
 * Runs a match again from its log. Human seats get their logged inputs; bots decide again from
 * their own views. `onTick` sees each tick's applied inputs, so a verifier can compare them with the log.
 */
export function replay(setup: Setup, log: LogEntry[], onTick?: (s: State, applied: (Applied | null)[], logged: (Applied | null)[]) => void): State {
  const s = createState(setup);
  const byTick = new Map<number, LogEntry[]>();
  for (const e of log) byTick.set(e.t, [...(byTick.get(e.t) ?? []), e]);
  while (!s.over) {
    const logged: (Applied | null)[] = s.wardens.map(() => null);
    for (const e of byTick.get(s.tick) ?? []) if (e.c >= 0 && e.c < logged.length) logged[e.c] = e.i;
    const { applied } = step(s, logged.map((a) => (a ? asInput(a) : null)));
    onTick?.(s, applied, logged);
  }
  return s;
}

export const chunkOf = (tick: number): number => Math.floor(tick / CHUNK);
export const chunkCount = (endTick: number): number => Math.ceil(endTick / CHUNK);
