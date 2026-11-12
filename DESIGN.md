# Emberfall — design

## Pitch

A night battle in a ruined voxel arena. Every Warden carries a torch and sees only what it lights. Gather embers,
fight with a swing and a dash, and stay inside the shrinking circle of light: the dark closes in and eats whoever
it catches. Last Warden standing wins; if the clock runs out first, the living Warden carrying the most embers wins.

Tracks: **Games With Real Economies** (games), **NFTs That Do Something** (nfts), **Memecoins With Mechanics** (memecoins).

- Each signed-in player's hero is a **Warden**, a NEP-171 NFT that holds its own purse of EMBER, its loot and its record. Transfer the NFT and all of it goes along.
- **EMBER** is a NEP-141 token whose supply follows play: part of each match's entry pot **burns for every Warden that falls** ("lost to the dark"), and new EMBER is **minted only for embers actually carried out** by Wardens alive at the end, under onchain caps.
- The AI rivals are Wardens too, owned by their own NEAR sub-accounts with function-call keys and spending caps.
- Players never touch the chain: guests need no wallet; signed-in players' actions are gasless meta-transactions.

## Rules (packages/rules)

Deterministic and isomorphic. Integer maths only, no `Math.random`/`Date`/DOM; everything random comes from the match seed.

- 20 ticks per second, at most 3600 ticks (3:00). 1 tile = 100 units; the arena is 40×40 tiles of ruins (walls, pillars, braziers, dead trees), generated from the seed.
- **Wardens:** 8 hearts (rules v4; 5 in v1–v3). Move 18 units/tick (diagonals 13). **Swing:** hits every Warden within 1.6 tiles in front of you (half-plane of your facing) for 1 heart and knocks them back; 12-tick cooldown; 8 ticks of grace after being hit. **Dash:** 5 ticks at 3× speed, 50-tick cooldown.
- **Aim:** facing follows movement unless you aim (mouse, right stick): aim is part of the input and the log, so you can swing behind you while backing off.
- **Embers:** 20 lie in the arena at the start; one more rises every 1.5 s inside the light until 2:40. Walk over one to carry it; within 1.4 tiles they drift towards the nearest Warden. A hit knocks one ember out of you; a fallen Warden spills all of theirs.
- **Torch and fog:** you see 6.5 tiles around you, blocked by walls. Embers glow: each ember you carry makes you visible from 0.3 tiles further away (up to +3). The terrain is public (moonlight); Wardens and embers are not.
- **The dark:** a circle of radius 21 tiles holds until 1:10, then shrinks steadily to 3.5 tiles at 2:55 (rules v4; v1–v3: 0:20 to 2:20). Outside it you lose a heart every second.
- **Match length:** a match with three rivals lasts about 2.5 minutes (`pnpm sim:human`, rules v4: mean 2:23 on Easy, 2:31 on Normal, 2:26 on Hard, median 2:27–2:38); under v3, with 5 hearts and the earlier dark, it was about 1.6 minutes (1:33 / 1:46 / 1:39).
- **End:** when at most one Warden is alive, or at 3:00. Winner: the only survivor; else the living Warden with most embers (then most hearts, then lowest seat); nobody if all fell.
- **Bots** decide from their own fogged view (`viewFor`), never the full state. Their inputs are logged and sealed like a human's, and `pnpm verify` recomputes each one.

## Sealed logs (the honest fog)

There's no TEE here, so the fog is kept honest with commitments:

1. **Seed.** The server picks a secret 32-byte seed (arena, ember spawns, salts) and the contract records `sha256(seed)` at `create_match`, before the first tick.
2. **Fog.** The server runs the sim and sends each client only `viewFor(state, seat)`: what that torch reveals.
3. **Seals every 3 s.** Every 60 ticks (one *chunk*), for each seat:
   `salt = sha256("emberfall|salt|<seed>|<seat>|<chunk>")`
   `seal = sha256("emberfall|seal|<match>|<seat>|<chunk>|<salt>|<inputs>|<x>,<z>,<hp>,<embers>,<kills>")`
   where `inputs` lists that seat's inputs in the chunk (`tick:mx,mz,flags;…`) and the rest is its state at the end of the chunk.
   The referee posts the seals; the contract folds them into a chain head:
   `head₀ = sha256("emberfall|head|<match>")`, `headₖ₊₁ = sha256(headₖ|<k>|<seal₀>,<seal₁>,…)`. Only the head is stored; the seals are in the transaction log and events.
4. **Open.** At the end the referee reveals the seed and every chunk's inputs and end state (`open_chunks`, in batches). The contract checks the seed against its hash, rebuilds each salt and seal, re-folds the chain and requires it to land on the stored head. It also refuses impossible states, including more hearts than the match's rules allow: `create_match` takes the rules version (`get_match_rules` reads it back), and an opening may show at most 8 hearts in a v4 match and 5 in any other (matches created before v4 carry no version and keep the 5-heart cap).
5. **Settle.** `settle_match` takes no claims: winner, falls, carried embers and kills are read from the last opened chunk, then the pot is burned and paid and EMBER is minted by the rule below.
6. **Verify.** `pnpm verify <matchId>` downloads the opened log, rebuilds the seals and head and compares them with the contract, replays the whole match with packages/rules, checks every chunk's end state and every bot decision, and recomputes the payouts.

`packages/rules/src/seal.ts` and `contracts/emberfall/src/lib.rs` hash the same bytes; a shared test vector pins them.

**What the chain does not prove:** the contract doesn't run the sim (the replay is off-chain, open to anyone); the server sees the full state, so the fog is a promise about what it sends, backed by the log; a human's inputs aren't signed, so the referee could drop or alter one inside the 3-second window before its seal; the seed is the server's pick (committed before play, not unbiased); guest seats are labels the server speaks for.

## EMBER (NEP-141) and its mechanic

| Event | EMBER |
|---|---|
| Mint a Warden | +30 minted into its purse (one per account) |
| Ranked match | each Warden seat pays 5 from its purse into the pot (only up to what its owner approved; bots within their caps) |
| A Warden falls | 15% of the pot burns per fallen seat (any seat, guests too), at most 75% |
| The winner | the rest of the pot goes to the winner's purse; if the winner is a guest or nobody, it burns too |
| Carry embers out | each living Warden seat mints 1 EMBER per ember carried at the end |
| Caps | at most 40 minted per match (scaled down pro rata, floor), at most 2000 per UTC day |
| Offer to the dark | anyone can burn EMBER from their own Warden's purse (`offer_to_dark`); the bots do it when they grow rich |

Decimals: 0. Purses are held by the contract account in NEP-141 terms (`ft_balance_of(emberfall.testnet)` = sum of all purses), so the standard events (`ft_mint`, `ft_burn`, `ft_transfer`) add up. `withdraw_purse` moves EMBER from your Warden to your account; `fund_purse` moves it back (to any Warden). `ember_supply` returns supply, minted, burned, today's mint and the last 10 settlements: the in-game supply panel.

## Wardens (NEP-171)

`{ owner, name, purse, loot[3], record{matches, wins, falls, kills, embers_out, best}, approved_fee }`, minted free (`mint_warden`, one per account). Metadata (title, description, an SVG card and `extra` JSON) is generated from the current state on every `nft_token` call. Loot is earned at settlement and changes your torch's flame in game:

- **Cinder Crown** for a win (gold flame), **Shade Fang** per kill (red flame), **Lantern Glass** for carrying 8+ embers out (white-blue flame).

Transferring a Warden moves its purse, loot and record; its fee approval resets so the new owner decides.

## The AI rivals

Five Ashen Wardens, each a sub-account of the contract (`moth.`, `wick.`, `gloam.`, `brannoc.`, `tallow.emberfall.testnet`) created by the contract with **only a function-call key** for `approve_fee,offer_to_dark`. `register_agent` mints their Warden and sets a policy (per-match fee cap, per-day spend cap) that the contract enforces on every spend. They pay entry fees, earn prizes and carried-out embers, and offer their surplus to the dark. Their pre-match taunts can come from a TEE-hosted model on NEAR AI Cloud (signed, kept with the match); the model never moves them.

| Bot | Persona (`skill`) | Style (rules v3+) |
|---|---|---|
| Moth | easy · gatherer | chases less far, gathers longer before fighting |
| Old Tallow | easy · gatherer | slow and stubborn |
| Wick | normal · stalker | gathers, fights when even or ahead |
| Sister Gloam | normal · stalker | stalks the glowing |
| Brannoc | hard · brawler | chases further, starts fighting earlier |

**Difficulty (rules v3+).** The player picks Easy, Normal or Hard (title screen or room lobby; default Normal, remembered in localStorage). It goes into `setup.difficulty`, which is replayed with the opened log, and sets how well *every* rival plays (`LEVELS` in `packages/rules/src/bot.ts`); a persona only adds its style on top. A ranked match (entry fees, the agents' purses at stake) runs at least on Normal. The levers: reaction lag (a bot acts on a Warden only after watching it for `react` ticks, and chases and aims at where it was that long ago: 5 / 4 / 3 ticks = 250 / 200 / 150 ms), aim error (30 / 15 / 5 % of aims a notch off), swing rate in reach (35 / 60 / 80 % per ready tick), dash use, how far away it notices you, how far it chases, retreat at low health, how close it cuts the dark, dithering, and a calm opening (until 2:00 / 1:50 / 1:30 it would rather gather than start a fight). Measured with `pnpm sim:human` (a reference human: ~250 ms reaction, a notch-off aim a quarter of the time, clicks that land about half the ready ticks, knows only what its torch shows) against the three quick-match rivals, 800 matches each: Easy 60% human wins, Normal 42%, Hard 22% (fair share in a 4-way is 25%). Under rules v2 the same human won 17%.

**Rules v4: longer matches.** v3 matches lasted about 1.6 minutes: fights started early and five hearts went fast. v4 (all new matches) gives every Warden 8 hearts and slows the dark (it holds until 1:10 and closes by 2:55, so the last circle still forces a finish before the 3:00 bell). Longer fights let the better fighter win more surely, which on its own pushed the reference human's Easy and Normal win rates up (to ~72% / ~56%), so `LEVELS_V4` sharpens Easy and Normal a little (Easy reacts in 4 ticks, misses 20% of aims, swings 50%; Normal misses 10%, swings 70%; Hard is unchanged) and doubles every level's calm opening to match the later dark. `pnpm sim:human 800 3 4 <difficulty>`: Easy 58% human wins (mean 2:23), Normal 44% (2:31), Hard 23% (2:26); with v3 it was 60% / 42% / 22% at 1:33 / 1:46 / 1:39. The reference human now runs at 40% of its hearts (2 of 5 as before, 3 of 8).

**Balance and rules versions.** Each match records `setup.rules`. In rules v1 (matches with no `rules` field) "easy" was the most careful mind: it spotted danger earliest and never took an even fight, so in a last-one-standing arena it outlived everyone (`pnpm sim 300 6 1`: easy 28% wins per bot, normal 6%). Rules v2 (all new matches) makes skill mean competence instead: easy minds notice danger late, dither, swing less and cut it fine with the dark, while normal and hard minds back off when two rivals are in view. `pnpm sim 400 6` gives hard 31%, normal 15%, easy 12% per bot; with 4 bots 44% / 19% / 18%. v1 is frozen (pinned state hashes in `test/balance.test.ts`), so settled v1 matches still replay and `pnpm verify` still passes on them. v2 is frozen the same way since rules v3 added the difficulty, and v3 since rules v4 (all new matches) added hearts; `test/fixtures.test.ts` replays real settled matches, one per version (v1, v2 from the hosted server; v3 and v4 from ranked `pnpm e2e` runs), to their recorded state hashes. Bot logic lives only in packages/rules: the contract checks seals, openings and settlement, never a bot decision. The one rule the contract does know is the heart cap, so v4 came with a contract upgrade (rules version stored per match under its own storage prefix; the contract's state layout is unchanged, so it was deployed without a migration).

Unnamed rivals join in a gentle order: Wick, Moth, Sister Gloam, Brannoc, Old Tallow. One rival is a fair fight; Brannoc only joins from the fourth.

## Server, rooms and sign-in

- Rooms over WebSocket (code of 4 letters, up to 6 seats, bots fill any seat). One authoritative 20 Hz loop per room; views at 10 Hz.
- Guests play at once. **Sign in with NEAR** uses Better Auth + better-near-auth (NEP-413 "Sign in to <host>", full-access key check, our host/message/origin hook). Signed-in players mint their Warden and approve fees as gasless NEP-366 meta-transactions through `emberfall-relay.testnet`.
- The referee `emberfall-ref.testnet` creates matches, posts seals, opens and settles. Match records (seed, log, openings, txs) are JSON files under `DATA_DIR/matches`; sessions in memory; one replica.

## Scene

three.js, everything procedural: an instanced voxel arena (flagstones, moss, broken walls, pillars, dead trees, cold braziers), a large moon and stars. The moon gives a dim blue light; your torch is a warm point light, and a world-space fog-of-war term darkens every terrain voxel outside your torch radius. A pool of six point lights is reused for visible torches (a fixed count, so shaders never recompile). Embers are emissive voxels with rising sparks; the dark is a wall of violet smoke voxels on the ring. Sound is synthesised in WebAudio (swing, hit, pickup, dash, heartbeat in the dark, a low drone).
