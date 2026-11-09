import type { Skill } from '@emberfall/rules';
import { call, view } from './chain.ts';
import { config, hasKey } from './config.ts';
import { voice, type SignedLine } from './nearai.ts';
import { kvGet, kvSet } from './store.ts';

// The Ashen Wardens: five AI rivals. Each is a sub-account of the contract whose only key is a
// function-call key for `approve_fee,offer_to_dark`; its Warden pays entry fees from its own purse
// under a per-match and per-day cap the contract enforces, and earns prizes and carried-out embers.
// Between matches they make offerings to the dark when they grow rich (a burn, onchain).

export interface AgentDef { label: string; name: string; skill: Skill; persona: string }

export const AGENTS: AgentDef[] = [
  { label: 'brannoc', name: 'Brannoc', skill: 'hard', persona: 'Brannoc, a scarred, laughing brawler who loves the dark because it hides his approach' },
  { label: 'gloam', name: 'Sister Gloam', skill: 'normal', persona: 'Sister Gloam, a soft-spoken hooded stalker who hunts whoever glows brightest' },
  { label: 'wick', name: 'Wick', skill: 'normal', persona: 'Wick, a wiry, fast-talking scavenger who counts every ember twice' },
  { label: 'moth', name: 'Moth', skill: 'easy', persona: 'Moth, a timid young torchbearer who is drawn to embers and afraid of everyone' },
  { label: 'tallow', name: 'Old Tallow', skill: 'easy', persona: 'Old Tallow, a slow, stubborn candle-maker who has outlived many brighter Wardens' },
];

export const accountOf = (a: AgentDef): string => `${a.label}.${config.contract}`;
export const DAY_CAP = 100;
export const MATCH_CAP = 5;

const wardens = new Map<string, string>();
/** The agent's Warden token id, if it's set up onchain and its key is here. */
export async function agentWarden(a: AgentDef): Promise<string | null> {
  const acct = accountOf(a);
  if (wardens.has(acct)) return wardens.get(acct)!;
  if (!config.chainEnabled || !hasKey(acct)) return null;
  const id = await view<string | null>('warden_of', { account_id: acct }).catch(() => null);
  if (id) wardens.set(acct, id);
  return id ?? null;
}

// ---------- what the agents did (for the UI) ----------

export interface AgentAct { at: number; who: string; what: string; tx?: string }
const acts: AgentAct[] = kvGet<AgentAct[]>('acts', []);
export function logAct(who: string, what: string, tx?: string): void {
  acts.unshift({ at: Date.now(), who, what, tx });
  acts.length = Math.min(acts.length, 40);
  kvSet('acts', acts);
}
export const recentActs = (): AgentAct[] => acts;

interface WardenRow { purse: number; approved_fee: number }

/** One pass of every agent: keep fees approved, and offer surplus EMBER to the dark. */
export async function agentTick(): Promise<void> {
  if (!config.chainEnabled) return;
  for (const a of AGENTS) {
    const w = await agentWarden(a);
    if (!w) continue;
    try {
      const t = await view<WardenRow | null>('get_warden', { warden: w });
      if (!t) continue;
      if (t.approved_fee < MATCH_CAP) {
        const r = await call(accountOf(a), 'approve_fee', { warden: w, max_fee: MATCH_CAP });
        logAct(a.name, `approved entry fees up to ${MATCH_CAP} EMBER`, r.tx);
      }
      // a rich Warden gives a tenth of what it holds above 100 to the dark
      if (t.purse > 120) {
        const amount = Math.floor((t.purse - 100) / 10);
        const r = await call(accountOf(a), 'offer_to_dark', { warden: w, amount });
        logAct(a.name, `offered ${amount} EMBER to the dark (burned)`, r.tx);
      }
    } catch (e) {
      logAct(a.name, `couldn't act: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

const TAUNTS: Record<string, string[]> = {
  brannoc: ['I can hear your torch crackle from here.', 'Run. It helps the hunt.'],
  gloam: ['The brightest flame goes out first.', 'Hush. Keep your light close.'],
  wick: ['Every ember you drop is mine.', 'Light’s cheap. Embers aren’t.'],
  moth: ['P-please don’t swing at me.', 'Oh! Embers!'],
  tallow: ['I was lighting torches before you were born.', 'Slow burns last longest.'],
};

/** A pre-match taunt, voiced by a TEE-hosted model when NEAR AI is configured (the model never plays). */
export function taunt(a: AgentDef, rivals: string[], pick: number): Promise<SignedLine> {
  const pool = TAUNTS[a.label] ?? ['The dark is coming.'];
  return voice(
    a.name,
    `You are ${a.persona}, about to fight in a night arena where every Warden sees only what their torch lights and the dark closes in. Say one short taunt (under 14 words). No hashtags, no emojis. Never assume anyone's gender.`,
    `Your rivals tonight: ${rivals.join(', ')}.`,
    pool[pick % pool.length],
  );
}
