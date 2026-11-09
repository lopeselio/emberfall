import { BURN_MAX, BURN_PER_FALLEN, MATCH_MINT_CAP } from './constants.ts';
import { winnerOf } from './sim.ts';

// How a settled match moves EMBER. The contract (settle_match) runs the same rule on the final
// states it opened; `pnpm verify` runs this one and compares.

export interface Final { hp: number; embers: number; kills: number }
export interface Settlement { winner: number | null; fallen: number; burned: number; prize: number; mints: number[]; capped: boolean }

/**
 * @param pot      entry fees collected at create_match
 * @param tokens   which seats are Wardens (guests own nothing and are paid nothing)
 * @param finals   each seat's state when the match ended
 * @param mintRoom what's left of today's mint cap
 */
export function settle(pot: number, tokens: boolean[], finals: Final[], mintRoom = Number.MAX_SAFE_INTEGER): Settlement {
  const winner = winnerOf(finals);
  const fallen = finals.filter((f) => f.hp <= 0).length;
  let burned = Math.floor((pot * Math.min(BURN_MAX, BURN_PER_FALLEN * fallen)) / 100);
  let prize = pot - burned;
  if (winner === null || !tokens[winner]) { burned += prize; prize = 0; }
  // embers carried out by living Wardens become EMBER, within the per-match and daily caps
  const mints = finals.map((f, i) => (tokens[i] && f.hp > 0 ? f.embers : 0));
  const total = mints.reduce((a, b) => a + b, 0);
  const cap = Math.min(MATCH_MINT_CAP, mintRoom);
  const capped = total > cap;
  if (capped) for (let i = 0; i < mints.length; i++) mints[i] = Math.floor((mints[i] * cap) / total);
  return { winner, fallen, burned, prize, mints, capped };
}
