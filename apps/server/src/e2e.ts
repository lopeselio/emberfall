// End-to-end run against the live testnet contract and a running server, as a signed-in player.
// Creates fresh faucet-funded test accounts each run (no real wallet involved).
//   pnpm e2e [baseUrl]            (default http://localhost:8831)
// Steps: sign in through Better Auth + better-near-auth (NEP-413) -> mint a Warden and approve the
// entry fee as gasless NEP-366 meta-transactions through the relayer -> play a ranked match against
// three Ashen Wardens over the WebSocket (the player is steered by the same bot mind, fed only the
// fogged view the server sends) -> wait for the seals, the openings and the settlement -> read the
// Warden NFT and the EMBER supply -> transfer the Warden to a second account: its purse goes along.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { Near } from 'near-kit';
import { sha256 } from '@noble/hashes/sha2.js';
import WebSocket from 'ws';
import { CENTER, decide, rngFrom, type Arena, type Brain, type Tile, type View } from '@emberfall/rules';

const URL_ = process.argv[2] ?? process.env.E2E_URL ?? 'http://localhost:8831';
const CONTRACT = process.env.CONTRACT_ID ?? 'emberfall.testnet';
/** E2E_RPC overrides the testnet RPC (a public endpoint can rate-limit one IP) */
const RPC = process.env.E2E_RPC ?? 'https://rpc.testnet.fastnear.com';
const stamp = Date.now().toString(36);
const step = (s: string): void => console.log(`\n▶ ${s}`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const credFile = (a: string): string => join(homedir(), '.near-credentials', 'testnet', `${a}.json`);
function faucetAccount(id: string): KeyPairString {
  execFileSync('near', ['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { stdio: 'ignore' });
  return JSON.parse(readFileSync(credFile(id), 'utf8')).private_key as KeyPairString;
}
/**
 * When the faucet is rate-limited: a sub-account of a testnet account we hold, funded with 0.3 NEAR.
 * Default: the contract's owner account, which the running server doesn't sign with (so no nonce clash).
 */
async function fundedSubAccount(label: string): Promise<{ id: string; key: KeyPairString }> {
  const funder = process.env.E2E_FUNDER ?? CONTRACT;
  const fk = JSON.parse(readFileSync(credFile(funder), 'utf8')).private_key as KeyPairString;
  const kp = KeyPair.fromRandom('ed25519');
  const sub = `${label}.${funder}`;
  const f = new Account(funder, new JsonRpcProvider({ url: RPC }), KeyPairSigner.fromSecretKey(fk));
  await f.signAndSendTransaction({ receiverId: sub, actions: [actions.createAccount(), actions.transfer(300_000_000_000_000_000_000_000n), actions.addFullAccessKey(kp.getPublicKey())], waitUntil: 'EXECUTED_OPTIMISTIC' });
  writeFileSync(credFile(sub), JSON.stringify({ account_id: sub, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  return { id: sub, key: kp.toString() as KeyPairString };
}

/** sha256 of the NEP-413 payload a wallet signs (what better-near-auth verifies). */
function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const str = (t: string): Uint8Array => { const e = new TextEncoder().encode(t); return Buffer.concat([u32(e.length), e]); };
  return sha256(Buffer.concat([u32(2 ** 31 + 413), str(message), nonce, str(recipient), new Uint8Array([0])]));
}

let id = `emberfall-e2e-${stamp}.testnet`;
step(`create ${id} from the testnet faucet`);
let key: KeyPairString;
try { key = faucetAccount(id); } catch {
  ({ id, key } = await fundedSubAccount(`e2e-${stamp}`));
  console.log(`  (the faucet is rate-limited: using ${id}, funded by its parent account)`);
}
const provider = new JsonRpcProvider({ url: RPC });
const me = new Account(id, provider, KeyPairSigner.fromSecretKey(key));
await sleep(3000);
ok('account funded');

const view = async <T>(method: string, args: object): Promise<T> => (await provider.callFunction({ contractId: CONTRACT, method, args: args as Record<string, unknown>, blockQuery: { finality: 'optimistic' } })) as T;
let cookie = '';
const origin = new URL(URL_).origin;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL_}/api${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const j = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path}: ${j.error ?? j.message ?? res.status}`);
  return j;
}

// a wallet stand-in: near-kit with the test account's key builds the signed delegate action
const kit = new Near({ network: 'testnet', privateKey: key as `ed25519:${string}`, defaultSignerId: id });
async function relay(method: string, args: object): Promise<string> {
  const { payload } = await kit.transaction(id).functionCall(CONTRACT, method, args, { gas: '50 Tgas', attachedDeposit: '0 yocto' }).delegate();
  const r = await api<{ txHash: string }>('/ba/near/relay', { payload });
  for (let k = 0; k < 30; k++) {
    const st = await api<{ status: string }>(`/ba/near/relay-status/${r.txHash}`);
    if (st.status === 'completed') return r.txHash;
    if (st.status === 'failed') throw new Error(`${method} relay failed (${r.txHash})`);
    await sleep(1500);
  }
  return r.txHash;
}

step('sign in: Better Auth + better-near-auth (the wallet signs "Sign in to <host>")');
const host = new URL(URL_).host;
const { nonce } = await api<{ nonce: string }>('/ba/near/nonce', { accountId: id, networkId: 'testnet' });
const kp = KeyPair.fromString(key);
const message = `Sign in to ${host}`;
const sig = kp.sign(nep413Hash(message, Buffer.from(nonce, 'hex'), host));
await api('/ba/near/verify', { signedMessage: { accountId: id, publicKey: kp.getPublicKey().toString(), signature: Buffer.from(sig.signature).toString('base64') }, message, recipient: host, nonce, accountId: id });
ok(`session cookie set; the server sees ${(await api<{ accountId: string }>('/me')).accountId}`);

step('mint a Warden and approve the entry fee, gasless (NEP-366 meta-transactions through the relayer)');
ok(`mint_warden ${await relay('mint_warden', { name: 'E2E Warden' })}`);
let profile = await api<{ warden: string; raw: { purse: number } }>('/me');
const warden = profile.warden;
ok(`approve_fee ${await relay('approve_fee', { warden, max_fee: 5 })}`);
profile = await api('/me');
ok(`${warden} holds ${profile.raw.purse} EMBER`);
const supplyBefore = await view<{ total_supply: string; burned: string; minted: string }>('ember_supply', {});

step('play a ranked match against three Ashen Wardens over the WebSocket');
const ws = new WebSocket(`${URL_.replace(/^http/, 'ws')}/ws`, { headers: { cookie, origin } });
await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
const send = (m: unknown): void => ws.send(JSON.stringify(m));
let arena: Arena | null = null;
let matchId = '';
const brain: Brain = { r: rngFrom(`e2e|${stamp}`), gx: CENTER, gz: CENTER };
let last = '';
const results = await new Promise<{ winner: number | null; seats: { name: string; alive: boolean; embers: number; kills: number }[]; ranked: boolean; fee: number }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the match took too long')), 5 * 60_000);
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    if (m.t === 'error') { clearTimeout(timer); reject(new Error(String(m.msg))); }
    if (m.t === 'start') {
      matchId = String(m.matchId);
      arena = { tiles: m.tiles as Tile[], spawns: [] };
      ok(`match ${matchId}: ranked=${m.ranked}, fee ${m.fee}; seed hash ${String(m.seedHash).slice(0, 16)}… committed before the first tick`);
    }
    if (m.t === 'line') ok(`${m.who}: “${m.text}”${m.signed ? ' (signed by NEAR AI TEE)' : ''}`);
    if (m.t === 'snap' && arena) {
      // steer with the bot mind, from exactly the view the server sent (fogged)
      const v = m.v as View;
      if (!v.me.alive) return;
      const d = decide(v, arena, 'normal', brain);
      const key = `${d.mx},${d.mz},${d.ax},${d.az},${d.swing ? 1 : 0},${d.dash ? 1 : 0}`;
      if (key !== last || d.swing || d.dash) { send({ t: 'in', mx: d.mx ?? 0, mz: d.mz ?? 0, ax: d.ax ?? 0, az: d.az ?? 0, swing: !!d.swing, dash: !!d.dash }); last = key; }
    }
    if (m.t === 'results') { clearTimeout(timer); resolve(m as never); }
  });
  send({ t: 'hello', name: 'E2E Warden' });
  send({ t: 'quick', bots: 3 });
});
ws.close();
const w = results.winner;
ok(`over: ${w === null ? 'nobody survived' : `${results.seats[w].name} won`}; ${results.seats.map((x) => `${x.name} ${x.alive ? `alive, ${x.embers} embers` : 'fell'}${x.kills ? `, ${x.kills} kills` : ''}`).join('; ')}`);

step('wait for the seals to be opened and the match settled onchain');
let b: { settled: boolean; error: string | null; txs: { what: string; url: string }[] } = { settled: false, error: null, txs: [] };
for (let k = 0; k < 90 && !b.settled; k++) { await sleep(3000); b = await api(`/match/${matchId}`); if (b.error && /settle/.test(b.error)) break; }
if (!b.settled) throw new Error(`not settled: ${b.error}`);
const seals = b.txs.filter((t) => t.what.startsWith('seal')).length;
for (const t of b.txs.filter((x) => !x.what.startsWith('seal'))) ok(`${t.what.padEnd(18)} ${t.url}`);
ok(`${seals} seal transactions (one every ~3 s of play)`);
const cm = await view<{ winner: number | null; burned: number; prize: number; minted: number[] }>('get_match', { match_id: matchId });
ok(`contract: winner seat ${cm.winner}, burned ${cm.burned}, prize ${cm.prize}, minted [${cm.minted.join(', ')}]`);
const supply = await view<{ total_supply: string; burned: string; minted: string }>('ember_supply', {});
ok(`EMBER supply ${supplyBefore.total_supply} → ${supply.total_supply} (minted ${supply.minted}, burned ${supply.burned})`);
profile = await api('/me');
const tok = await view<{ metadata: { title: string; description: string } }>('nft_token', { token_id: warden });
ok(`${warden} purse ${profile.raw.purse} EMBER; NFT reads “${tok.metadata.title}”`);

step('transfer the Warden NFT: its purse, loot and record go with it');
// a second account, made by the first (a sub-account, so no second faucet request is needed)
const id2 = `buyer.${id}`;
await me.signAndSendTransaction({
  receiverId: id2,
  actions: [actions.createAccount(), actions.transfer(50_000_000_000_000_000_000_000n), actions.addFullAccessKey(KeyPair.fromRandom('ed25519').getPublicKey())],
  waitUntil: 'EXECUTED_OPTIMISTIC',
});
await sleep(1500);
const out = (await me.signAndSendTransaction({ receiverId: CONTRACT, actions: [actions.functionCall('nft_transfer', { receiver_id: id2, token_id: warden }, teraToGas(50), 1n)], waitUntil: 'EXECUTED_OPTIMISTIC', throwOnFailure: false })) as unknown as { status: { Failure?: unknown } };
if (out.status.Failure) throw new Error(`nft_transfer: ${JSON.stringify(out.status.Failure).slice(0, 200)}`);
const moved = await view<{ owner_id: string; purse: number; record: { matches: number } }>('get_warden', { warden });
ok(`${warden} now belongs to ${moved.owner_id} with ${moved.purse} EMBER and ${moved.record.matches} match(es) on its record`);
console.log(`\nall player steps passed. Check the match yourself:\n  pnpm verify ${matchId}${URL_ === 'http://localhost:8831' ? '' : ` --host ${URL_}`}`);
process.exit(0);
