# Emberfall — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Independent of Bazaar of Liars, Realm Ledger, Parkwright, Sushi Sabotage and Fogwater: its own repo, contract, rules and server. They sit together in the NEAR Arcade.
- Inspired by Nightfall (Solana/MagicBlock): no code, names, art or text from it. All art is procedural voxels; all sound is synthesised.
- packages/rules is deterministic and isomorphic (browser + Node): no Math.random, no Date, no DOM, no node: imports. Integer positions only. A replay of the log must reproduce the state hash.
- Its seal and chain-head hashes must match contracts/emberfall byte for byte (shared test vector in both test suites).
- The server sends each client only what its torch reveals (`viewFor`). Bots decide from their own `viewFor` too; never hand a bot or a client the full state.
- The LLM never moves a Warden, picks a target or decides a payout; packages/rules and the contract do. NEAR AI only voices taunts.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits. Every change after the first push goes on a branch, through a PR, and is rebase-merged.
