# Emberfall

A torchlit battle arena on NEAR, in voxels. Every Warden carries a torch and **sees only what it lights**. Gather embers, fight with a swing and a dash (every Warden has 8 hearts), and stay inside the light while **the dark closes in**. A match lasts about two and a half minutes (at most 3:00). The last Warden standing wins; if the clock runs out, the living Warden carrying the most embers does.

The fog is kept honest without a TEE: the server commits a hash of the match seed onchain before the first tick, sends each player only what their torch reveals, and **seals every player's inputs and position onchain every 3 seconds**. At the end the seed and the whole log are opened, and the contract rebuilds every seal before it burns or pays a single EMBER. `pnpm verify <matchId>` replays the match from that log.

Built for NEAR HACKATHON (Nov 2026). Tracks: **Games With Real Economies**, **NFTs That Do Something**, **Memecoins With Mechanics**. Design: [DESIGN.md](DESIGN.md).

- Contract (testnet): [`emberfall.testnet`](https://testnet.nearblocks.io/address/emberfall.testnet): EMBER (NEP-141), Wardens (NEP-171), sealed matches.
- Referee: [`emberfall-ref.testnet`](https://testnet.nearblocks.io/address/emberfall-ref.testnet). Gasless relayer: [`emberfall-relay.testnet`](https://testnet.nearblocks.io/address/emberfall-relay.testnet).
- AI rivals (sub-accounts with function-call keys only): `brannoc.`, `gloam.`, `wick.`, `moth.`, `tallow.emberfall.testnet`.

## Try it (do X, see Y)

```bash
pnpm install
pnpm build            # the web app
pnpm start            # http://localhost:8831 (server + built web app)
```

With no NEAR keys, run `CHAIN=0 pnpm start`: everything plays the same, but nothing is written onchain (the results say "Offline mode").

1. **Open http://localhost:8831.** You see the EMBERFALL title over a slowly orbiting voxel ruin lit by braziers, and panels for *Your Warden*, *EMBER supply* (in existence / minted / burned / today's mint against its cap, plus the last settlements), the *Wardens' ledger*, *The Ashen Wardens* (their NEAR accounts and what they did onchain) and *Recent matches*.
2. **Pick a difficulty, then press "Fight the Ashen Wardens".** Under the button, **Easy / Normal / Hard** (default Normal; your pick is remembered on this device, and a room's host can change it in the lobby) sets how well every AI rival plays: how fast they react, how true they aim, how often they swing (a ranked match never runs below Normal). The first time, a six-step walkthrough explains the torch and the fog, the controls, embers, the dark, winning and what goes onchain (reopen it any time with **How to play**). Then a room fills with three AI rivals, a 3-2-1 countdown plays, and one rival taunts you (with a NEAR AI key the line is marked "✓ NEAR AI TEE").
3. **Play.** WASD/arrows move, **the mouse aims** (a small wedge on the ground shows where your swing lands), **click or Space** swings your torch, **right-click or Shift** dashes; a gamepad works too (left stick, right stick to aim, A swing, B dash); on a phone, drag on the left half and tap **Swing**/**Dash**. Hits freeze the frame for an instant, shake the camera and float a "-1"; embers drift towards you when you're close and pop "+1". You see a warm circle around you; outside it the ruins are dim grey-blue and **no Warden or ember is drawn there, because the server never sent it**. Walk over glowing embers to carry them (the gold bar top-left: the fuller it is, the further away rivals can see you) and watch rivals appear only as they enter your light. The minimap shows only the ground your torch has revealed. Your heart bar (top left) reads **8 / 8 ♥** and every Warden's name tag shows 8 pips; each hit takes one. The top bar counts down to **1:10**, when the violet wall of the dark starts shrinking (the minimap shows it); by 2:55 only a small circle is left. Its wall pulses when it's at your back; step outside and the screen pulses violet and you lose a heart a second (it pulses red when you're down to three hearts).
4. **The end.** The line above the results says your place, how long it lasted and which difficulty the Ashen Wardens played on (e.g. "Ashen Wardens on Normal"). The results table shows everyone's placement, who stood, who fell and when, embers and kills, and what EMBER each Warden earns. Within a few seconds the line changes to **"✓ Opened and settled onchain: the contract rebuilt every seal."**; open **N transactions** to see `create_match`, one `seal` per 3 s of play, the `open chunks` batches and `settle_match` on nearblocks. **opened log (JSON)** is the full proof bundle. **Watch the replay** re-runs the whole match in your browser from that log (through your torch, 1×/2×/4×, scrubbable) and shows "✓ the opened log rebuilds all N chunks of seals · ✓ it folds into the contract's chain head" (read straight from a public NEAR RPC).
5. **Check it yourself**, with no keys and without trusting our server:

   ```
   pnpm verify <matchId>                                  # local server
   pnpm verify <matchId> --host https://<hosted-url>      # hosted
   ```

   It prints the match's rules version (new matches are v4) and checks it against the one committed onchain at `create_match` (older matches have none stored and must be v1–v3), checks no seat ever shows more hearts than that version allows, checks the seed against the committed hash, rebuilds every seal and the chain head and compares them with the contract, replays the match tick by tick (re-making every bot decision from that bot's own fogged view), checks every 3-second state, and recomputes the burn, prize and mint. Example from a live testnet match below.
6. **Multiplayer.** **Create a room**, send the 4-letter code or the `?room=CODE` link; friends **Join** with it (up to 6, guests welcome). The host can add Ashen Wardens; everyone presses **Ready**. **Play again** keeps the room together.
7. **Sign in with NEAR** (top right; NEAR Connect: Meteor, Intear, HOT, MyNearWallet, …). The wallet signs "Sign in to <host>" (NEP-413). In *Your Warden*, **Mint my Warden** (free, gasless: a NEP-366 meta-transaction paid by `emberfall-relay.testnet`) gives you an NFT with a 30 EMBER purse; **Allow 5 EMBER entry fee** makes your matches **ranked**. Your card is the NFT's own onchain SVG, regenerated from its purse, record and loot; a Cinder Crown (a win), Shade Fang (a kill) or Lantern Glass (8+ embers carried out) changes your torch's flame colour in game.
8. **Headless:** `pnpm e2e` (server at http://localhost:8831) creates a fresh faucet account, signs in, mints and approves gaslessly, plays a ranked match over the WebSocket steered only by the fogged views it receives, waits for settlement, and transfers the Warden to a second account to show the purse goes with it.

### A live run (testnet, 9 Nov 2026)

`pnpm e2e` (the faucet was rate-limiting that day, so the test account is a funded sub-account; the taunt fell back to a stock line):

```
▶ create emberfall-e2e-mw99t1z0.testnet from the testnet faucet
  (the faucet is rate-limited: using e2e-mw99t1z0.emberfall.testnet, funded by its parent account)
  ✓ account funded

▶ sign in: Better Auth + better-near-auth (the wallet signs "Sign in to <host>")
  ✓ session cookie set; the server sees e2e-mw99t1z0.emberfall.testnet

▶ mint a Warden and approve the entry fee, gasless (NEP-366 meta-transactions through the relayer)
  ✓ mint_warden AXanveGP4ugcLaFYbbMgzsPA4gsKemYEgUc5j6FBDCHJ
  ✓ approve_fee EhRcXD4MdAtnWLrk1bUg8pT6WYjaWzgL55d14cLA8Ryy
  ✓ warden-8 holds 30 EMBER

▶ play a ranked match against three Ashen Wardens over the WebSocket
  ✓ match m-mw99tirm-1f7383: ranked=true, fee 5; seed hash 3ce05b319590b52b… committed before the first tick
  ✓ Brannoc: “Run. It helps the hunt.”
  ✓ over: Brannoc won; E2E Warden fell; Brannoc alive, 10 embers, 3 kills; Sister Gloam fell; Wick fell

▶ wait for the seals to be opened and the match settled onchain
  ✓ create_match       https://testnet.nearblocks.io/txns/DgyMKUhtdrsun1K4xaAT534BBio8RCvU6x99fvqZGMsi
  ✓ open chunks 0–9    https://testnet.nearblocks.io/txns/AYcjkV6DepsXKfXjLFyAY3JLHMoQe2Y1hTrK3Lo9djd7
  ✓ open chunks 10–19  https://testnet.nearblocks.io/txns/DajoJf2msXXBRFQVAYsNCf7uAhNXe6AfhxTaP9LWMZjk
  ✓ open chunks 20–20  https://testnet.nearblocks.io/txns/B6KxzX4wPnE1ZTSHdJHS4BPmK9z9YbtfFbGL6bXebXEu
  ✓ settle_match       https://testnet.nearblocks.io/txns/RRQxP6fWCefonQk5JUSPs9eWcLXAZBY96Yw1dmaNu85
  ✓ 21 seal transactions (one every ~3 s of play)
  ✓ contract: winner seat 1, burned 9, prize 11, minted [0, 10, 0, 0]
  ✓ EMBER supply 310 → 311 (minted 338, burned 27)
  ✓ warden-8 purse 25 EMBER; NFT reads “E2E Warden · Kindling”

▶ transfer the Warden NFT: its purse, loot and record go with it
  ✓ warden-8 now belongs to buyer.e2e-mw99t1z0.emberfall.testnet with 25 EMBER and 1 match(es) on its record

all player steps passed. Check the match yourself:
  pnpm verify m-mw99tirm-1f7383
```

`pnpm verify` on that match:

```
match m-mw99tirm-1f7383 on emberfall.testnet: E2E Warden, Brannoc, Sister Gloam, Wick

✓ the contract has this match
✓ the revealed seed matches the hash committed at create_match  3ce05b319590b52b
✓ the match was set up from that seed (arena, embers, salts)
✓ every opening rebuilds its seal (21 chunks × 4 seats)
✓ the seals fold into the contract's chain head  6218af70686eca22
✓ the contract opened every chunk and re-folded the same head
✓ every bot input is what that bot decides from its own fogged view  1796 bot inputs
✓ every logged human input replays as logged
✓ the replay passes through every sealed chunk state (21 chunks)
✓ the replay ends where the server's match ended (tick 1250)  121aa8a34e02754d
✓ the final states match what the contract opened
✓ the contract settled it
✓ winner: Brannoc
✓ pot 20 EMBER: 9 burned (3 fell), 11 to the winner
✓ minted for embers carried out: [0, 10, 0, 0]

1 AI line(s), 0 signed by the NEAR AI enclave

all checks passed
```

## How it works

```
apps/web          three.js voxel arena + React HUD (Vite); NEAR Connect wallet; guests need no wallet
apps/server       rooms (20 Hz authoritative match, fogged views over WebSocket), the chain queue,
                  the Ashen Wardens, Better Auth + gasless relayer, verify and e2e CLIs
packages/rules    arena, match, fog views, bots, seals, settlement (deterministic, integer maths, isomorphic)
contracts/emberfall  Rust near-sdk 5.29: EMBER (NEP-141), Wardens (NEP-171), seals, openings, settlement, agent policies
```

- **The match** is `packages/rules`: 20 ticks a second, integer positions (1 tile = 100 units), a 128-bit seeded generator inside the state, no `Math.random`/`Date`/DOM. The same code runs on the server, in `pnpm verify` and in the tests.
- **The fog.** `viewFor(state, seat)` is the only thing a client ever receives: its own Warden, the Wardens and embers within its torch radius (6.5 tiles, blocked by walls; carried embers make a Warden visible from further away), the ring, the clock. Events far away are dropped, except that someone fell. Bots get exactly the same `viewFor`; they never read the full state.
- **Sealed logs.** The server picks a secret seed; `create_match` records `sha256(seed)` and takes entry fees into the pot. Every 60 ticks, for each seat, `seal = sha256("emberfall|seal|match|seat|chunk|salt|inputs|x,z,hp,embers,kills")` with `salt = sha256("emberfall|salt|seed|seat|chunk")`; `seal` folds them into a chain head (`head = sha256(head|chunk|seals…)`). At the end `open_chunks` reveals the seed and every chunk; the contract rebuilds each salt and seal and requires the re-folded head to equal the sealed one. `settle_match` takes no claims at all: it reads who stood and who fell, embers and kills from the last opened chunk.
- **EMBER (NEP-141, 0 decimals).** Purses and open pots are held by the contract account in NEP-141 terms, so the standard `ft_mint`/`ft_burn`/`ft_transfer` events add up. The rule: **15% of the pot burns for every seat that falls** (at most 75%), the rest goes to a Warden winner (or burns too if a guest or nobody wins); **every living Warden mints 1 EMBER per ember it carried out**, at most 40 per match (pro rata) and 2000 per UTC day. `offer_to_dark` burns from your own purse; the bots do it when they're rich. `withdraw_purse`/`fund_purse` move EMBER between a Warden and an account.
- **Wardens (NEP-171).** Purse, loot and record are fields of the token, so `nft_transfer` moves them all (the fee approval resets for the new owner). Metadata (title, description, SVG, `extra` JSON) is generated from that state on every read.
- **The Ashen Wardens** are sub-accounts created by the contract with **only a function-call key** for `approve_fee,offer_to_dark`. `register_agent` gives each a Warden and a policy (5 EMBER per match, 100 per day) the contract enforces on every spend. A match is ranked only when every Warden seat can pay.
- **Chain invisible.** Guests never see a wallet. Signed-in players sign two gasless meta-transactions in their life (mint, approve). The referee posts about one transaction per 3 s of play (~40 per match, well under 0.05 NEAR).

### What the chain does *not* prove

- **The contract doesn't run the match.** It checks the seed, every seal, the chain head and the payout rule; whether the logged inputs really produce those states is checked by replaying (`pnpm verify`, open to anyone), not onchain.
- **The fog is a promise about what the server sends.** The server sees the full state. The sealed log lets you audit what it did, not what it knew; there is no TEE.
- **Human inputs aren't signed.** The referee relays them, so it could drop or alter one before its chunk is sealed (a 3-second window); after a seal it can't change history without breaking the head.
- **The seed is the server's pick.** It's committed before the first tick, but it isn't unbiased randomness (no VRF).
- **Guest seats are labels** the server speaks for; only signed-in players' Wardens are theirs onchain.

## Tests

```bash
pnpm --filter @emberfall/rules test   # 43: determinism, replay, tampering, combat, aim, the ember magnet, the dark, fog, bot blindness, log text, the shared seal vector, settlement, frozen v1/v2/v3 bots (one settled match per rules version replays to its hash), difficulty levels, rules v4 (8 hearts, the later dark, levels, longer matches)
pnpm contract:test                    # 22: shared hash vector, full match, forged openings, wrong seed, caps, transfers, agents, refunds, supply invariant, the heart cap per rules version
pnpm typecheck
pnpm sim 300 6                        # all-bot balance: match length, survivors, embers carried out, win rate per bot by skill (args: matches seats rules difficulty)
pnpm sim:human 800 3 4 normal         # a reference human (250 ms reaction, imperfect aim) against 3 rivals: its win rate, place, match length, how it fell (args: matches rivals rules difficulty)
```

`pnpm sim:human 800 3 <rules> <difficulty>` (800 matches per row):

| | v3: human wins | v3: mean length | v4: human wins | v4: mean length (median) |
|---|---|---|---|---|
| Easy | 59.9% | 1:33 | 58.1% | 2:23 (2:27) |
| Normal | 41.9% | 1:46 | 44.3% | 2:31 (2:38) |
| Hard | 21.5% | 1:39 | 23.4% | 2:26 (2:30) |

```
```

## Deploying

- **Contract:** `pnpm contract:build`, then `near contract deploy emberfall.testnet use-file contracts/emberfall/target/near/emberfall.wasm with-init-call new json-args '{"owner":"emberfall.testnet","referee":"emberfall-ref.testnet"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send` (later redeploys: `without-init-call`; the rules v4 upgrade on 12 Nov 2026 kept the state layout, so it needed no migration).
- **Agents:** `pnpm setup:agents` (idempotent) creates the five sub-accounts with function-call keys, registers their Wardens and policies, and approves their fees.
- **Hosting:** `scripts/deploy-azure.sh` (Azure Container Apps, resource group `emberfall`, one replica: rooms and sockets live in memory). `scripts/azure-storage.sh` mounts an Azure Files share at `/data` once, so match records survive redeploys. Keys go in as one `NEAR_KEYS` secret; nothing is in the repo.

## Lineage and disclosures

- **Inspiration.** The idea of a battle royale where fog of war is the core mechanic came from [Nightfall](https://github.com/codeswithroh/nightfall) (Solana/MagicBlock). Emberfall shares **no code, assets, names, art or text** with it; its rules, world, characters and honesty scheme (seals checked by a NEAR contract) are our own.
- **Other projects.** Independent of our other NEAR HACKATHON games (Bazaar of Liars, Realm Ledger, Parkwright, Sushi Sabotage, Fogwater): its own repo, contract, rules and server. It reuses the same stack and sign-in pattern (Better Auth + better-near-auth, a gasless relayer) and sits beside them in the NEAR Arcade.
- **AI.** NEAR AI Cloud (TEE-hosted model) only voices the rivals' taunts; each line is kept with its signature. The model never moves, targets or decides anything.
- **Libraries:** three.js, React, better-auth and better-near-auth, near-api-js, near-kit, @noble/hashes, ws, Vite, near-sdk (Rust).
- **Assets:** every model is procedural boxes in `apps/web/src/scene.ts`; every sound is synthesised in `apps/web/src/sound.ts`; fonts are Inter and Pixelify Sans (Google Fonts, OFL).

## License

MIT
