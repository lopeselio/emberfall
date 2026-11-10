import { CURRENT_RULES, TICK_HZ } from './constants.ts';
import { humanDecide, humanMind } from './human.ts';
import { createState, step, viewFor, type Skill, type State } from './sim.ts';

// Can a normal person win? The reference human (human.ts) against the Ashen Wardens, many seeded matches.
//   pnpm sim:human [matches] [rivals] [rules] [easy|normal|hard]
// Rivals are the ones a quick match gets: Wick (normal), Moth (easy), Sister Gloam (normal), Brannoc (hard), Old Tallow (easy).
const argv = (globalThis as unknown as { process: { argv: string[] } }).process.argv;
const n = Number(argv[2] ?? 400);
const rivals = Math.max(1, Math.min(5, Number(argv[3] ?? 3)));
const rules = Number(argv[4] ?? CURRENT_RULES);
const difficulty = (['easy', 'normal', 'hard'].includes(argv[5]) ? argv[5] : 'normal') as Skill;
const FILL: Skill[] = ['normal', 'easy', 'normal', 'hard', 'easy'];

/** 1 = first; the winner, then the living by embers and hearts, then the fallen, latest first. */
export function placeOf(s: State, seat: number): number {
  const idx = s.wardens.map((_, i) => i).sort((a, b) => {
    const A = s.wardens[a], B = s.wardens[b];
    if (a === s.winner) return -1;
    if (b === s.winner) return 1;
    if (A.alive !== B.alive) return A.alive ? -1 : 1;
    if (A.alive) return B.embers - A.embers || B.hp - A.hp || a - b;
    return B.fellAt - A.fellAt || a - b;
  });
  return idx.indexOf(seat) + 1;
}

let wins = 0, placeSum = 0, ticks = 0, kills = 0, embers = 0;
const ends: Record<string, number> = { won: 0, 'felled by a bot': 0, 'taken by the dark': 0, 'alive, out-gathered at the bell': 0 };
const lens: number[] = [];
for (let m = 0; m < n; m++) {
  const seed = `human-${m}`;
  const seats = rivals + 1;
  const me = m % seats; // rotate the spawn
  let b = 0;
  const s = createState({ seed, rules, difficulty, seats: Array.from({ length: seats }, (_, i) => (i === me ? { name: 'human' } : { name: `bot${i}`, bot: FILL[b++] })) });
  const mind = humanMind(seed, me);
  let end = '';
  while (!s.over) {
    const given = s.wardens.map((_, i) => (i === me ? humanDecide(viewFor(s, i), s.arena, mind) : null));
    const { events } = step(s, given);
    for (const e of events) if (e.t === 'fall' && e.w === me) end = e.by >= 0 ? 'felled by a bot' : 'taken by the dark';
  }
  if (s.winner === me) end = 'won';
  else if (!end) end = 'alive, out-gathered at the bell';
  ends[end]++;
  if (s.winner === me) wins++;
  placeSum += placeOf(s, me);
  ticks += s.tick;
  lens.push(s.tick);
  kills += s.wardens[me].kills;
  embers += s.wardens[me].embers;
}
lens.sort((x, y) => x - y);
const sec = (t: number): string => `${(t / TICK_HZ).toFixed(0)} s`;
console.log(`${n} matches, reference human vs ${rivals} bot(s) [${FILL.slice(0, rivals).join(', ')}], rules v${rules}${rules >= 3 ? `, ${difficulty}` : ''}`);
console.log(`human wins ${((100 * wins) / n).toFixed(1)}% (fair share ${(100 / (rivals + 1)).toFixed(0)}%), mean place ${(placeSum / n).toFixed(2)} of ${rivals + 1}`);
console.log(`match length mean ${sec(ticks / n)}, median ${sec(lens[n >> 1])}, p90 ${sec(lens[Math.floor(n * 0.9)])}`);
console.log(`human kills/match ${(kills / n).toFixed(2)}, embers held at the end ${(embers / n).toFixed(1)}`);
console.log('how the human\'s match ended', Object.fromEntries(Object.entries(ends).map(([k, v]) => [k, `${((100 * v) / n).toFixed(1)}%`])));
