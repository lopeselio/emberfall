// Independent check of a finished match. Needs no keys and trusts nothing the game server says:
// it rebuilds every seal from the opened log, checks them against the chain head the contract holds,
// replays the whole match with packages/rules (re-making every bot decision from that bot's own view)
// and recomputes the settlement.
//
//   pnpm verify <matchId> [--host https://…] [--rpc https://…] [--contract emberfall.testnet]
// --host defaults to the hosted game (https://emberfall.lopeselio.online; VERIFY_HOST overrides it).
// Without --rpc it tries several public testnet RPCs in turn, retrying rate limits with backoff.
import {
  CHUNK, maxHp, foldHead, logFromOpenings, replay, sealOf, settle, sha256Hex, stateHash, type Applied, type Opening, type Settlement, type Setup,
} from '@emberfall/rules';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const id = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const HOST = opt('host', process.env.VERIFY_HOST ?? 'https://emberfall.lopeselio.online').replace(/\/+$/, '');
// public testnet RPCs (docs.near.org/api/rpc/providers); rpc.testnet.near.org is deprecated, fastnear rate-limits hard
const RPCS = args.includes('--rpc') ? [opt('rpc', '')] : ['https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs', 'https://rpc.testnet.fastnear.com'];
const CONTRACT = opt('contract', process.env.CONTRACT_ID ?? 'emberfall.testnet');
if (!id) { console.error('usage: pnpm verify <matchId> [--host URL] [--rpc URL] [--contract ID]'); process.exit(2); }

interface Bundle {
  id: string; over: boolean; seats: { name: string; kind: string; warden: string | null }[]; fee: number; seedHash: string; seed?: string;
  setup?: Setup; seals: string[][]; head: string; chunks: Opening[][]; endTick?: number; winner?: number | null; stateHash?: string;
  lines: { who: string; signature?: string; signingAddress?: string }[];
}
interface ChainMatch {
  seed_hash: string; seats: { warden: string | null }[]; fee: number; chunks: number; head: string; opened: number; open_head: string;
  seed: string | null; finals: { hp: number; embers: number; kills: number }[]; settled: boolean; winner: number | null; burned: number; prize: number; minted: number[]; capped: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => { console.error(msg); process.exit(2); };

/** a contract view call; each RPC in turn, three rounds with backoff, so one rate-limited endpoint doesn't stop a check */
async function viewCall<T>(method: string, a: object): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString('base64') } });
  const errors: string[] = [];
  for (let round = 0; round < 3; round++) {
    for (const rpc of RPCS) {
      try {
        const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
        const j = (await res.json().catch(() => ({}))) as { result?: { result?: number[]; error?: string }; error?: { message?: string; cause?: { name?: string } } };
        if (j.result?.result) return JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T;
        const why = j.result?.error ?? j.error?.cause?.name ?? j.error?.message ?? `HTTP ${res.status}`;
        // the contract itself refused (e.g. a method this deployment lacks): no other RPC will answer differently
        if (j.result?.error || j.error?.cause?.name === 'CONTRACT_EXECUTION_ERROR') throw Object.assign(new Error(`${method}: ${why}`), { final: true });
        errors.push(`${new URL(rpc).host}: ${why}`);
      } catch (e) {
        if ((e as { final?: boolean }).final) throw e;
        errors.push(`${new URL(rpc).host}: ${(e as Error).message}`);
      }
    }
    await sleep(1000 * 2 ** round);
  }
  return fail(`couldn't read ${CONTRACT}.${method} from any testnet RPC (${errors.slice(-RPCS.length).join('; ')}).\nTry again in a minute, or pass --rpc <url>.`);
}

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
};

const res = await fetch(`${HOST}/api/match/${id}`).catch((e: Error) => fail(`couldn't reach ${HOST} (${(e.cause as { code?: string } | undefined)?.code ?? e.message}); pass --host <url> for another server`));
const b = (await res.json().catch(() => fail(`${HOST} didn't answer with a match bundle (HTTP ${res.status})`))) as Bundle & { error?: string };
if (b.error) fail(`${b.error} on ${HOST}${HOST.includes('localhost') ? '' : ' (a match played on a local server is only there: pass --host http://localhost:8831)'}`);
if (!b.over || !b.seed || !b.setup) { console.error('that match is not over yet'); process.exit(2); }
const c = await viewCall<ChainMatch | null>('get_match', { match_id: id });
console.log(`match ${id} on ${CONTRACT}: ${b.seats.map((s) => s.name).join(', ')}`);
console.log(`rules v${b.setup.rules ?? 1}${(b.setup.rules ?? 1) >= 3 ? `, bots on ${b.setup.difficulty ?? 'normal'}` : ''}\n`);
check(!!c, 'the contract has this match');
if (!c) process.exit(1);

// matches created since v4 carry their rules version onchain; older ones (none stored) are v1–v3
const onchainRules = await viewCall<number | null>('get_match_rules', { match_id: id }).catch(() => null);
const rules = b.setup.rules ?? 1;
check(onchainRules === null ? rules <= 3 : onchainRules === rules, `the rules version matches the one committed at create_match`, onchainRules === null ? '(none stored: a v1–v3 match)' : `v${onchainRules}`);
check(b.chunks.every((seats) => seats.every((o) => o.hp <= maxHp(rules))), `no seat ever shows more than ${maxHp(rules)} hearts`);
check(sha256Hex(b.seed) === c.seed_hash && c.seed_hash === b.seedHash, 'the revealed seed matches the hash committed at create_match', c.seed_hash.slice(0, 16));
check(b.setup.seed === b.seed, 'the match was set up from that seed (arena, embers, salts)');
const rebuilt = b.chunks.map((seats, k) => seats.map((o, seat) => sealOf(id, b.seed!, seat, k, o)));
check(JSON.stringify(rebuilt) === JSON.stringify(b.seals), `every opening rebuilds its seal (${b.chunks.length} chunks × ${b.seats.length} seats)`);
const head = foldHead(id, rebuilt);
check(head === c.head && c.chunks === b.chunks.length, `the seals fold into the contract's chain head`, head.slice(0, 16));
check(c.opened === c.chunks && c.open_head === c.head, 'the contract opened every chunk and re-folded the same head');

// replay the whole match; bots decide again from their own fogged views
let k = 0, stateBad = 0, botBad = 0, humanBad = 0;
const log = logFromOpenings(b.chunks);
const same = (x: Applied | null, y: Applied | null): boolean => JSON.stringify(x) === JSON.stringify(y);
const s = replay(b.setup, log, (st, applied, logged) => {
  applied.forEach((a, i) => { if (!same(a, logged[i])) { if (st.wardens[i].bot) botBad++; else humanBad++; } });
  if (st.tick % CHUNK === 0 || st.over) {
    (b.chunks[k] ?? []).forEach((o, seat) => {
      const w = st.wardens[seat];
      if (o.x !== w.x || o.z !== w.z || o.hp !== w.hp || o.embers !== w.embers || o.kills !== w.kills) stateBad++;
    });
    k++;
  }
});
check(botBad === 0, `every bot input is what that bot decides from its own fogged view`, `${log.filter((e) => s.wardens[e.c].bot).length} bot inputs`);
check(humanBad === 0, 'every logged human input replays as logged');
check(stateBad === 0 && k === b.chunks.length, `the replay passes through every sealed chunk state (${k} chunks)`);
check(s.tick === b.endTick && stateHash(s) === b.stateHash, `the replay ends where the server's match ended (tick ${s.tick})`, stateHash(s).slice(0, 16));
const finals = s.wardens.map((w) => ({ hp: w.hp, embers: w.embers, kills: w.kills }));
check(JSON.stringify(finals) === JSON.stringify(c.finals), 'the final states match what the contract opened');

const pot = c.fee * c.seats.filter((x) => x.warden).length;
const exp: Settlement = settle(pot, c.seats.map((x) => !!x.warden), finals);
check(c.settled, 'the contract settled it');
check(exp.winner === c.winner, `winner: ${exp.winner === null ? 'nobody' : b.seats[exp.winner].name}`);
check(exp.burned === c.burned && exp.prize === c.prize, `pot ${pot} EMBER: ${exp.burned} burned (${exp.fallen} fell), ${exp.prize} to the winner`);
const mintOk = c.capped ? c.minted.every((m, i) => m <= exp.mints[i]) : JSON.stringify(exp.mints) === JSON.stringify(c.minted);
check(mintOk, `minted for embers carried out: [${c.minted.join(', ')}]${c.capped ? ' (capped)' : ''}`);
const signed = b.lines.filter((l) => l.signature);
console.log(`\n${b.lines.length} AI line(s), ${signed.length} signed by the NEAR AI enclave${signed[0] ? ` (signer ${signed[0].signingAddress})` : ''}`);
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
