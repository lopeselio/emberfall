use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const SEED: &str = "00112233445566778899aabbccddeeff";

fn ctx(who: &str, ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("emberfall.testnet".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .block_timestamp(ms * 1_000_000)
        .build());
}
fn ctx_yocto(who: &str, ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("emberfall.testnet".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(1))
        .block_timestamp(ms * 1_000_000)
        .build());
}

fn contract() -> Emberfall {
    ctx("emberfall.testnet", 1000);
    Emberfall::new("emberfall.testnet".parse().unwrap(), "ref.testnet".parse().unwrap())
}

fn op(inputs: &str, hp: u8, embers: u32, kills: u32) -> ChunkOpening {
    ChunkOpening { inputs: inputs.into(), x: 2000, z: 2000, hp, embers, kills }
}

/// Seals what `chunks` say, the way the referee does during the match.
fn seal_all(c: &mut Emberfall, id: &str, chunks: &[Vec<ChunkOpening>]) {
    ctx("ref.testnet", 2000);
    for (k, ch) in chunks.iter().enumerate() {
        let seals: Vec<String> = ch.iter().enumerate().map(|(seat, o)| seal_of(id, SEED, seat, k as u32, o)).collect();
        c.seal(id.into(), k as u32, vec![seals]);
    }
}

fn invariant(c: &Emberfall, accounts: &[&str]) {
    let free: u64 = accounts.iter().map(|a| c.ft_balance_of(a.parse().unwrap()).0 as u64).sum();
    assert_eq!(c.ft_total_supply().0 as u64, c.ft_balance_of("emberfall.testnet".parse().unwrap()).0 as u64 + free, "supply = held + balances");
    let s = c.ember_supply();
    assert_eq!(s.minted.0 - s.burned.0, s.total_supply.0, "supply = minted - burned");
}

/// alice and bob mint Wardens and approve fees; a guest takes the third seat.
fn three_seats(c: &mut Emberfall) -> (String, String) {
    ctx("alice.testnet", 1500);
    let a = c.mint_warden("Alice".into());
    c.approve_fee(a.clone(), 10);
    ctx("bob.testnet", 1500);
    let b = c.mint_warden("Bob".into());
    c.approve_fee(b.clone(), 10);
    ctx("ref.testnet", 1600);
    c.create_match(
        "m1".into(),
        sha_hex(SEED),
        vec![
            SeatIn { warden: Some(a.clone()), name: "Alice".into() },
            SeatIn { warden: Some(b.clone()), name: "Bob".into() },
            SeatIn { warden: None, name: "Guest".into() },
        ],
        5,
    );
    (a, b)
}

fn two_chunks() -> Vec<Vec<ChunkOpening>> {
    vec![
        vec![op("3:1,0,0", 5, 2, 0), op("4:0,1,0;9:0,1,1", 5, 0, 0), op("", 5, 1, 0)],
        vec![op("70:1,1,2", 4, 9, 1), op("", 0, 0, 0), op("90:0,0,1", 3, 2, 0)],
    ]
}

// the same vector is in packages/rules/test/rules.test.ts
#[test]
fn shared_hash_vector() {
    ctx("x.testnet", 1);
    let o = ChunkOpening { inputs: "3:1,0,0;7:1,-1,1;45:0,0,2".into(), x: 2350, z: 1990, hp: 4, embers: 3, kills: 1 };
    assert_eq!(salt_of(SEED, 2, 5), "b97af859f0786d2fd3f3f50262ffc6f6aa8d4e6d300ebcac0901d19d90b22e5b");
    let seal = seal_of("m-test", SEED, 2, 5, &o);
    assert_eq!(seal, "1ad3cb5b4083b2e2cc160d7ce5b985041c691f65a582491ee7f071ad8e057003");
    assert_eq!(head_zero("m-test"), "93485abfe7775d46a84579473b2f0f06c77491c613385002654b71342e63e125");
    assert_eq!(next_head(&head_zero("m-test"), 0, &[seal.clone(), seal]), "f7db9ce2133b0e9e5180990d042b73067f4e7e78af6bd2d23524bfbe7b5825ed");
}

#[test]
fn mint_warden_gives_a_starting_purse_and_live_metadata() {
    let mut c = contract();
    ctx("alice.testnet", 1500);
    let a = c.mint_warden("Alice".into());
    assert_eq!(a, "warden-0");
    assert_eq!(c.get_warden(a.clone()).unwrap().purse, STARTER);
    assert_eq!(c.ft_total_supply().0, STARTER as u128);
    assert_eq!(c.ft_balance_of("emberfall.testnet".parse().unwrap()).0, STARTER as u128);
    assert_eq!(c.warden_of("alice.testnet".parse().unwrap()), Some(a.clone()));
    let t = c.nft_token(a).unwrap();
    assert!(t.metadata.title.unwrap().starts_with("Alice"));
    assert!(t.metadata.media.unwrap().starts_with("data:image/svg+xml,"));
    assert!(t.metadata.extra.unwrap().contains("\"purse\":30"));
    assert_eq!(c.ft_metadata().symbol, "EMBER");
    invariant(&c, &["alice.testnet"]);
}

#[test]
#[should_panic(expected = "already minted")]
fn one_free_warden_per_account() {
    let mut c = contract();
    ctx("alice.testnet", 1500);
    c.mint_warden("Alice".into());
    c.mint_warden("Alice2".into());
}

#[test]
fn a_full_match_seals_opens_and_settles_by_the_rule() {
    let mut c = contract();
    let (a, b) = three_seats(&mut c);
    assert_eq!(c.get_match("m1".into()).unwrap().pot, 10);
    assert_eq!(c.get_warden(a.clone()).unwrap().purse, STARTER - 5);
    let chunks = two_chunks();
    seal_all(&mut c, "m1", &chunks);
    ctx("ref.testnet", 3000);
    c.open_chunks("m1".into(), SEED.into(), 0, vec![chunks[0].clone()]);
    c.open_chunks("m1".into(), SEED.into(), 1, vec![chunks[1].clone()]);
    // anyone can settle once everything is open
    ctx("stranger.testnet", 3100);
    c.settle_match("m1".into());
    let m = c.get_match("m1".into()).unwrap();
    assert!(m.settled);
    // alice: alive with 9 embers wins; bob fell (one of three seats): 15% of 10 burns
    assert_eq!(m.winner, Some(0));
    assert_eq!(m.burned, 1);
    assert_eq!(m.prize, 9);
    // alice carried 9 out (minted); the guest carried 2 but owns no Warden
    assert_eq!(m.minted, vec![9, 0, 0]);
    let wa = c.get_warden(a.clone()).unwrap();
    assert_eq!(wa.purse, STARTER - 5 + 9 + 9);
    assert_eq!(wa.record, Record { matches: 1, wins: 1, falls: 0, kills: 1, embers_out: 9, best: 9 });
    assert_eq!(wa.loot, vec![1, 1, 1]);
    let wb = c.get_warden(b).unwrap();
    assert_eq!(wb.purse, STARTER - 5);
    assert_eq!(wb.record.falls, 1);
    let s = c.ember_supply();
    assert_eq!(s.burned.0, 1);
    assert_eq!(s.minted.0, (2 * STARTER + 9) as u128);
    assert_eq!(s.recent[0].match_id, "m1");
    assert_eq!(c.leaderboard(None)[0].warden, a);
    assert!(c.nft_token(a).unwrap().metadata.extra.unwrap().contains("\"flame\":1"));
    invariant(&c, &["alice.testnet", "bob.testnet"]);
}

#[test]
#[should_panic(expected = "rebuild the sealed chain head")]
fn a_forged_opening_is_refused() {
    let mut c = contract();
    three_seats(&mut c);
    let chunks = two_chunks();
    seal_all(&mut c, "m1", &chunks);
    let mut forged = chunks.clone();
    forged[1][1].hp = 2; // bob "survived"
    ctx("ref.testnet", 3000);
    c.open_chunks("m1".into(), SEED.into(), 0, forged);
}

#[test]
#[should_panic(expected = "seed does not match")]
fn the_wrong_seed_is_refused() {
    let mut c = contract();
    three_seats(&mut c);
    let chunks = two_chunks();
    seal_all(&mut c, "m1", &chunks);
    ctx("ref.testnet", 3000);
    c.open_chunks("m1".into(), "ffffffffffffffffffffffffffffffff".into(), 0, chunks);
}

#[test]
#[should_panic(expected = "open every sealed chunk")]
fn settling_needs_every_chunk_open() {
    let mut c = contract();
    three_seats(&mut c);
    let chunks = two_chunks();
    seal_all(&mut c, "m1", &chunks);
    ctx("ref.testnet", 3000);
    c.open_chunks("m1".into(), SEED.into(), 0, vec![chunks[0].clone()]);
    c.settle_match("m1".into());
}

#[test]
#[should_panic(expected = "only the referee")]
fn only_the_referee_seals() {
    let mut c = contract();
    three_seats(&mut c);
    ctx("alice.testnet", 2000);
    c.seal("m1".into(), 0, vec![vec!["0".repeat(64); 3]]);
}

#[test]
#[should_panic(expected = "above what the Warden's owner approved")]
fn fees_need_approval() {
    let mut c = contract();
    ctx("alice.testnet", 1500);
    let a = c.mint_warden("Alice".into());
    ctx("ref.testnet", 1600);
    c.create_match("m2".into(), sha_hex(SEED), vec![SeatIn { warden: Some(a), name: "Alice".into() }], 5);
}

#[test]
fn a_guest_winner_or_no_survivor_burns_the_pot() {
    let mut c = contract();
    three_seats(&mut c);
    let chunks = vec![vec![op("", 0, 0, 0), op("", 0, 0, 0), op("", 2, 4, 2)]];
    seal_all(&mut c, "m1", &chunks);
    ctx("ref.testnet", 3000);
    c.open_chunks("m1".into(), SEED.into(), 0, chunks);
    c.settle_match("m1".into());
    let m = c.get_match("m1".into()).unwrap();
    assert_eq!((m.winner, m.burned, m.prize), (Some(2), 10, 0));
    assert_eq!(c.ember_supply().burned.0, 10);
    invariant(&c, &["alice.testnet", "bob.testnet"]);
}

#[test]
fn minting_is_capped_per_match_pro_rata() {
    let mut c = contract();
    three_seats(&mut c);
    let chunks = vec![vec![op("", 5, 60, 0), op("", 5, 20, 0), op("", 5, 30, 0)]];
    seal_all(&mut c, "m1", &chunks);
    ctx("ref.testnet", 3000);
    c.open_chunks("m1".into(), SEED.into(), 0, chunks);
    c.settle_match("m1".into());
    let m = c.get_match("m1".into()).unwrap();
    assert!(m.capped);
    assert_eq!(m.minted, vec![30, 10, 0]);
    assert_eq!(m.burned, 0);
}

#[test]
fn transferring_a_warden_moves_its_purse_loot_and_record() {
    let mut c = contract();
    let (a, _) = three_seats(&mut c);
    let chunks = two_chunks();
    seal_all(&mut c, "m1", &chunks);
    ctx("ref.testnet", 3000);
    c.open_chunks("m1".into(), SEED.into(), 0, chunks);
    c.settle_match("m1".into());
    let before = c.get_warden(a.clone()).unwrap();
    ctx_yocto("alice.testnet", 4000);
    c.nft_transfer("carol.testnet".parse().unwrap(), a.clone(), None, None);
    let after = c.get_warden(a.clone()).unwrap();
    assert_eq!(after.owner_id.as_str(), "carol.testnet");
    assert_eq!((after.purse, after.loot.clone(), after.record.clone()), (before.purse, before.loot, before.record));
    assert_eq!(after.approved_fee, 0);
    assert_eq!(c.warden_of("carol.testnet".parse().unwrap()), Some(a.clone()));
    assert_eq!(c.warden_of("alice.testnet".parse().unwrap()), None);
    // and only carol can spend it now
    ctx("carol.testnet", 4100);
    c.withdraw_purse(a, 3);
    assert_eq!(c.ft_balance_of("carol.testnet".parse().unwrap()).0, 3);
    invariant(&c, &["alice.testnet", "bob.testnet", "carol.testnet"]);
}

#[test]
fn ember_moves_between_purses_and_accounts() {
    let mut c = contract();
    ctx("alice.testnet", 1500);
    let a = c.mint_warden("Alice".into());
    c.withdraw_purse(a.clone(), 20);
    ctx_yocto("alice.testnet", 1600);
    c.ft_transfer("bob.testnet".parse().unwrap(), U128(5), None);
    ctx("bob.testnet", 1700);
    c.fund_purse(a.clone(), 5);
    assert_eq!(c.get_warden(a.clone()).unwrap().purse, 15);
    assert_eq!(c.ft_balance_of("alice.testnet".parse().unwrap()).0, 15);
    assert_eq!(c.ft_balance_of("bob.testnet".parse().unwrap()).0, 0);
    assert!(c.storage_balance_of("bob.testnet".parse().unwrap()).is_some());
    ctx("alice.testnet", 1800);
    c.offer_to_dark(a.clone(), 4);
    assert_eq!(c.get_warden(a).unwrap().offered, 4);
    assert_eq!(c.ember_supply().burned.0, 4);
    invariant(&c, &["alice.testnet", "bob.testnet"]);
}

#[test]
fn agents_spend_within_their_policy() {
    let mut c = contract();
    ctx("emberfall.testnet", 1500);
    let w = c.register_agent("moth.emberfall.testnet".parse().unwrap(), "Moth".into(), 6, 5);
    ctx("moth.emberfall.testnet", 1600);
    c.approve_fee(w.clone(), 5);
    c.offer_to_dark(w.clone(), 1);
    ctx("ref.testnet", 1700);
    c.create_match("m3".into(), sha_hex(SEED), vec![SeatIn { warden: Some(w.clone()), name: "Moth".into() }], 5);
    assert_eq!(c.get_agent("moth.emberfall.testnet".parse().unwrap()).unwrap().spent_today, 6);
    // a second match today would go over the daily cap
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_match("m4".into(), sha_hex(SEED), vec![SeatIn { warden: Some(w.clone()), name: "Moth".into() }], 5);
    }));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "agent's own Warden")]
fn an_agent_cannot_sell_its_warden() {
    let mut c = contract();
    ctx("emberfall.testnet", 1500);
    let w = c.register_agent("moth.emberfall.testnet".parse().unwrap(), "Moth".into(), 50, 5);
    ctx_yocto("moth.emberfall.testnet", 1600);
    c.nft_transfer("x.testnet".parse().unwrap(), w, None, None);
}

#[test]
fn an_abandoned_match_is_refunded_after_two_hours() {
    let mut c = contract();
    let (a, _) = three_seats(&mut c);
    ctx("stranger.testnet", 1600 + 2 * 3_600_000 + 1);
    c.refund_match("m1".into());
    assert_eq!(c.get_warden(a).unwrap().purse, STARTER);
    assert!(c.get_match("m1".into()).unwrap().refunded);
    invariant(&c, &["alice.testnet", "bob.testnet"]);
}
