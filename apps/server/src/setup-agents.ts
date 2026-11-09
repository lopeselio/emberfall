// One-time setup of the Ashen Wardens on testnet. Idempotent: re-running skips what exists.
//   pnpm setup:agents
// For each: a sub-account of the contract whose ONLY key is a function-call key for the agent methods
// (created by the contract itself), a registered Warden with spending caps, and fee approval.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { FEE } from '@emberfall/rules';
import { AGENTS, DAY_CAP, MATCH_CAP, accountOf } from './agents.ts';
import { call, provider, view } from './chain.ts';
import { config } from './config.ts';

const OWNER = config.contract;
const credDir = join(homedir(), '.near-credentials', config.network);
mkdirSync(credDir, { recursive: true });

async function exists(id: string): Promise<boolean> {
  try { await provider.viewAccount({ accountId: id, finalityQuery: { finality: 'final' } } as never); return true; } catch { return false; }
}

for (const a of AGENTS) {
  const acct = accountOf(a);
  const file = join(credDir, `${acct}.json`);
  if (!(await exists(acct))) {
    if (existsSync(file)) throw new Error(`${file} exists but ${acct} doesn't; move the old key away first`);
    const kp = KeyPair.fromRandom('ed25519');
    writeFileSync(file, JSON.stringify({ account_id: acct, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    const r = await call(OWNER, 'create_agent_account', { name: a.label, public_key: kp.getPublicKey().toString() }, 100, 300_000_000_000_000_000_000_000n);
    console.log(`created ${acct} (function-call key only) ${r.tx}`);
    await new Promise((res) => setTimeout(res, 2500));
  } else console.log(`${acct} exists`);

  let warden = await view<string | null>('warden_of', { account_id: acct });
  const policy = await view<{ day_cap: number; match_cap: number } | null>('get_agent', { account_id: acct });
  if (!warden || !policy || policy.day_cap !== DAY_CAP || policy.match_cap !== MATCH_CAP) {
    const r = await call<string>(OWNER, 'register_agent', { account: acct, name: a.name, day_cap: DAY_CAP, match_cap: MATCH_CAP });
    warden = r.value;
    console.log(`registered ${a.name} as ${warden} (caps ${MATCH_CAP}/match, ${DAY_CAP}/day) ${r.tx}`);
  }
  const t = await view<{ approved_fee: number } | null>('get_warden', { warden });
  if ((t?.approved_fee ?? 0) < FEE) {
    const r = await call(acct, 'approve_fee', { warden, max_fee: MATCH_CAP });
    console.log(`${a.name} approved entry fees up to ${MATCH_CAP} ${r.tx}`);
  }
}
console.log('done');
