import { CURRENT_RULES, MAX_TICKS, TICK_HZ } from './constants.ts';
import { createState, step, type Skill } from './sim.ts';

// Balance check: many all-bot matches. `pnpm sim [matches] [seats] [rules]`
const argv = (globalThis as unknown as { process: { argv: string[] } }).process.argv;
const n = Number(argv[2] ?? 100);
const seats = Math.max(2, Math.min(6, Number(argv[3] ?? 6)));
const rules = Number(argv[4] ?? CURRENT_RULES);
const skills: Skill[] = ['hard', 'normal', 'normal', 'easy', 'easy', 'normal'];
const wins: Record<string, number> = {};
let ticks = 0, survivors = 0, carried = 0, nobody = 0, darkFalls = 0;
for (let m = 0; m < n; m++) {
  const s = createState({ seed: `balance-${m}`, seats: Array.from({ length: seats }, (_, i) => ({ name: `${skills[i]}#${i}`, bot: skills[i] })), rules });
  while (!s.over) {
    const { events } = step(s, []);
    darkFalls += events.filter((e) => e.t === 'fall' && e.by === -1).length;
  }
  ticks += s.tick;
  survivors += s.wardens.filter((w) => w.alive).length;
  carried += s.wardens.reduce((a, w) => a + (w.alive ? w.embers : 0), 0);
  if (s.winner === null) nobody++;
  else wins[skills[s.winner]] = (wins[skills[s.winner]] ?? 0) + 1;
}
console.log(`${n} matches, ${seats} bots, rules v${rules}`);
console.log(`mean length ${(ticks / n / TICK_HZ).toFixed(1)} s (max ${MAX_TICKS / TICK_HZ}), survivors ${(survivors / n).toFixed(2)}, embers carried out ${(carried / n).toFixed(1)}`);
console.log(`falls to the dark per match ${(darkFalls / n).toFixed(2)}, no winner ${nobody}`);
console.log('wins by skill', wins);
const count: Record<string, number> = {};
for (let i = 0; i < seats; i++) count[skills[i]] = (count[skills[i]] ?? 0) + 1;
console.log('win rate per bot', Object.fromEntries(Object.keys(count).map((k) => [k, `${((100 * (wins[k] ?? 0)) / n / count[k]).toFixed(1)}%`])));
