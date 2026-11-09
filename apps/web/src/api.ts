import type { Settlement, SimEvent, Tile, View } from '@emberfall/rules';

// Server API (same origin). The wallet session is Better Auth's HttpOnly cookie.

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const res = await fetch(`/api${path}`, body === undefined ? { headers, credentials: 'same-origin' } : { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export interface BotInfo { label: string; name: string; skill: string; account: string; warden: string | null }
export interface ServerConfig { network: string; contract: string; referee: string; chain: boolean; relayer: string | null; nearAi: boolean; bots: BotInfo[] }
export interface WardenRaw { owner_id: string; name: string; purse: number; loot: number[]; record: { matches: number; wins: number; falls: number; kills: number; embers_out: number; best: number }; approved_fee: number; offered: number }
export interface Me { accountId: string; warden: string | null; raw: WardenRaw | null; token: { metadata: { title: string; media: string; description: string } } | null; balance: string }
export interface SupplyRow { match_id: string; pot: number; burned: number; minted: number; fallen: number }
export interface Supply { total_supply: string; minted: string; burned: string; held_by_wardens: string; minted_today: string; daily_cap: string; match_cap: string; matches_settled: number; recent: SupplyRow[] }
export interface BoardRow { warden: string; name: string; wins: number; embers_out: number }
export interface MatchRow { id: string; createdAt: number; names: string[]; winner: number | null; settled: boolean; ranked: boolean; burned: number; minted: number }
export interface AgentAct { at: number; who: string; what: string; url?: string }

export interface RoomSeat { name: string; kind: 'bot' | 'human'; ready: boolean; signedIn: boolean; here: boolean; skill: string | null }
export interface RoomMsg { t: 'room'; code: string; phase: string; seats: RoomSeat[]; you: number; host: boolean; bots: { label: string; name: string; skill: string }[] }
export interface StartMsg { t: 'start'; you: number; matchId: string; startsAt: number; seats: { name: string; kind: string; warden: string | null; flame: number }[]; ranked: boolean; fee: number; seedHash: string; tiles: Tile[]; maxTicks: number }
export interface SnapMsg { t: 'snap'; v: View; ev: SimEvent[] }
export interface ResultSeat { name: string; alive: boolean; hp: number; embers: number; kills: number; fellAt: number; warden: string | null; kind: string }
export interface ResultsMsg { t: 'results'; matchId: string; winner: number | null; endTick: number; ranked: boolean; fee: number; seats: ResultSeat[]; expected: Settlement; chain: boolean; settled: boolean; error: string | null; txs: { what: string; hash: string; url: string }[] }
export interface LineMsg { t: 'line'; who: string; text: string; signed: boolean }
export type ServerMsg = RoomMsg | StartMsg | SnapMsg | ResultsMsg | LineMsg | { t: 'error'; msg: string } | { t: 'kicked' } | { t: 'hello'; account: string | null };

export const explorerAccount = (a: string): string => `https://testnet.nearblocks.io/address/${a}`;
