//! Emberfall onchain: Wardens, EMBER and sealed matches.
//!
//! - **Wardens** are NEP-171 tokens. Each holds its own purse of EMBER, its loot and its record;
//!   transferring the token moves all of it. Metadata is generated from that state on every read.
//! - **EMBER** is a NEP-141 token (0 decimals). Purses and open pots are held by this contract's own
//!   account in NEP-141 terms, so `ft_balance_of(<this contract>)` is their sum and the standard
//!   `ft_mint` / `ft_burn` / `ft_transfer` events add up to `ft_total_supply`.
//! - **Matches**: the referee commits `sha256(seed)` and takes entry fees (`create_match`), posts each
//!   chunk's per-seat seals every ~3 s (`seal`, folded into one chain head), then reveals the seed and
//!   every chunk (`open_chunks`). The contract rebuilds every salt and seal and requires the re-folded
//!   head to equal the sealed one. `settle_match` takes no claims: it reads who stood, who fell, embers
//!   carried and kills from the last opened chunk, then burns, pays and mints by the rule below.
//! - **Supply rule**: 15% of the pot burns per fallen seat (at most 75%); the rest goes to a Warden
//!   winner or burns too. Living Warden seats mint 1 EMBER per ember carried out, at most 40 per match
//!   (pro rata) and 2000 per UTC day.
//! - **Agents** (the AI rivals) are sub-accounts of this contract with only a function-call key; a
//!   per-match and per-day spending policy is enforced on every spend from their Warden.
//!
//! The match itself (movement, fights, the dark) lives in packages/rules and is replayed off-chain by
//! `pnpm verify`; this contract checks what a contract can check cheaply: the seed, every seal, the
//! chain head, and the payout rule.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PublicKey,
};

#[cfg(test)]
mod tests;

pub const STARTER: u64 = 30;
pub const BURN_PER_FALLEN: u64 = 15;
pub const BURN_MAX: u64 = 75;
pub const MATCH_MINT_CAP: u64 = 40;
pub const DAILY_MINT_CAP: u64 = 2000;
pub const GLASS_EMBERS: u32 = 8;
pub const HP: u8 = 5;
pub const ARENA_UNITS: i32 = 4000;
pub const MAX_SEATS: usize = 6;
/// 3:00 at 60 ticks per chunk
pub const MAX_CHUNKS: u32 = 60;
pub const DAY_NS: u64 = 86_400_000_000_000;
/// an unsettled match can be refunded by anyone after this long
pub const REFUND_AFTER_NS: u64 = 2 * 3_600_000_000_000;
pub const LOOT: [&str; 3] = ["Cinder Crown", "Shade Fang", "Lantern Glass"];
/// Methods an agent's function-call key may call.
pub const AGENT_METHODS: &str = "approve_fee,offer_to_dark";
pub const AGENT_GAS_ALLOWANCE: NearToken = NearToken::from_millinear(500);
const STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1250);
const MAX_NAME: usize = 20;
const RECENT: u32 = 10;
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Wardens,
    WardenIds,
    Owned,
    OwnedSet { owner_hash: Vec<u8> },
    WardenOf,
    Minted,
    Agents,
    Matches,
    Balances,
    Board,
    Recent,
}

// ---------- data ----------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Record {
    pub matches: u32,
    pub wins: u32,
    pub falls: u32,
    pub kills: u32,
    pub embers_out: u64,
    pub best: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Warden {
    pub owner_id: AccountId,
    pub name: String,
    pub purse: u64,
    /// counts of LOOT[k]
    pub loot: Vec<u32>,
    pub record: Record,
    /// the most the referee may take as one match's entry fee
    pub approved_fee: u64,
    /// EMBER this Warden has offered to the dark (burned)
    pub offered: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub warden: String,
    pub day_cap: u64,
    pub match_cap: u64,
    pub day: u64,
    pub spent_today: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SeatIn {
    /// None for a guest seat: plays, but owns nothing, pays and earns nothing
    pub warden: Option<String>,
    pub name: String,
}

/// One seat's opened chunk: its inputs and its state when the chunk closed.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ChunkOpening {
    pub inputs: String,
    pub x: i32,
    pub z: i32,
    pub hp: u8,
    pub embers: u32,
    pub kills: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Final {
    pub hp: u8,
    pub embers: u32,
    pub kills: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Match {
    pub seed_hash: String,
    pub seats: Vec<SeatIn>,
    pub fee: u64,
    pub pot: u64,
    pub ranked: bool,
    pub created_ns: U64,
    /// sealed chunks so far, and the chain head over them
    pub chunks: u32,
    pub head: String,
    /// opened chunks so far, and the head re-folded from the openings
    pub opened: u32,
    pub open_head: String,
    pub seed: Option<String>,
    /// each seat's state at the end of the last opened chunk
    pub finals: Vec<Final>,
    pub settled: bool,
    pub refunded: bool,
    pub winner: Option<u8>,
    pub burned: u64,
    pub prize: u64,
    pub minted: Vec<u64>,
    pub capped: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SupplyRow {
    pub match_id: String,
    pub pot: u64,
    pub burned: u64,
    pub minted: u64,
    pub fallen: u32,
    pub at_ns: U64,
}

#[near(serializers = [json])]
pub struct Supply {
    pub total_supply: U128,
    pub minted: U128,
    pub burned: U128,
    pub held_by_wardens: U128,
    pub minted_today: U128,
    pub daily_cap: U128,
    pub match_cap: U128,
    pub matches_settled: u64,
    pub recent: Vec<SupplyRow>,
}

#[near(serializers = [json])]
pub struct BoardRow {
    pub warden: String,
    pub name: String,
    pub wins: u32,
    pub embers_out: u64,
}

#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub copies: Option<U64>,
    pub extra: Option<String>,
}

#[near(serializers = [json])]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
    pub approved_account_ids: std::collections::HashMap<AccountId, u64>,
}

#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct FtMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(event_json(standard = "emberfall"))]
pub enum Event {
    #[event_version("1.0.0")]
    MatchCreated { match_id: String, seed_hash: String, wardens: Vec<Option<String>>, fee: u64, pot: u64 },
    #[event_version("1.0.0")]
    Sealed { match_id: String, chunk: u32, seals: Vec<String>, head: String },
    #[event_version("1.0.0")]
    Opened { match_id: String, from: u32, to: u32 },
    #[event_version("1.0.0")]
    Settled { match_id: String, seed: String, winner: Option<u8>, fallen: u32, burned: u64, prize: u64, minted: Vec<u64>, capped: bool },
    #[event_version("1.0.0")]
    Refunded { match_id: String },
    #[event_version("1.0.0")]
    Offered { warden: String, amount: u64 },
    #[event_version("1.0.0")]
    AgentRegistered { account: AccountId, warden: String, day_cap: u64, match_cap: u64 },
}

fn std_event(standard: &str, version: &str, event: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": standard, "version": version, "event": event, "data": [data] })));
}
fn nep171(event: &str, data: serde_json::Value) {
    std_event("nep171", "1.2.0", event, data);
}
fn nep141(event: &str, data: serde_json::Value) {
    std_event("nep141", "1.0.0", event, data);
}

#[ext_contract(ext_nft_receiver)]
pub trait NonFungibleTokenReceiver {
    fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> PromiseOrValue<bool>;
}
#[ext_contract(ext_ft_receiver)]
pub trait FungibleTokenReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}
#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String) -> bool;
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128;
}

// ---------- the hashes packages/rules builds too ----------

pub fn sha_hex(s: &str) -> String {
    hex::encode(env::sha256_array(s.as_bytes()))
}
pub fn salt_of(seed: &str, seat: usize, chunk: u32) -> String {
    sha_hex(&format!("emberfall|salt|{seed}|{seat}|{chunk}"))
}
pub fn seal_of(match_id: &str, seed: &str, seat: usize, chunk: u32, o: &ChunkOpening) -> String {
    let salt = salt_of(seed, seat, chunk);
    sha_hex(&format!(
        "emberfall|seal|{match_id}|{seat}|{chunk}|{salt}|{}|{},{},{},{},{}",
        o.inputs, o.x, o.z, o.hp, o.embers, o.kills
    ))
}
pub fn head_zero(match_id: &str) -> String {
    sha_hex(&format!("emberfall|head|{match_id}"))
}
pub fn next_head(head: &str, chunk: u32, seals: &[String]) -> String {
    sha_hex(&format!("{head}|{chunk}|{}", seals.join(",")))
}

/// The winner: the living seat with the most embers, then most hearts, then the lowest seat.
pub fn winner_of(finals: &[Final]) -> Option<u8> {
    let mut best: Option<usize> = None;
    for (i, f) in finals.iter().enumerate() {
        if f.hp == 0 {
            continue;
        }
        match best {
            None => best = Some(i),
            Some(b) => {
                let w = &finals[b];
                if f.embers > w.embers || (f.embers == w.embers && f.hp > w.hp) {
                    best = Some(i);
                }
            }
        }
    }
    best.map(|i| i as u8)
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= MAX_NAME
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' || c == '\'')
}
fn valid_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn valid_inputs(s: &str) -> bool {
    s.len() <= 4000 && s.bytes().all(|b| b.is_ascii_digit() || b == b':' || b == b',' || b == b';' || b == b'-')
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Emberfall {
    owner: AccountId,
    referee: AccountId,
    wardens: LookupMap<String, Warden>,
    warden_ids: Vector<String>,
    owned: LookupMap<AccountId, IterableSet<String>>,
    /// each account's main Warden (the one it plays with)
    warden_of: LookupMap<AccountId, String>,
    /// accounts that already minted their free Warden
    minted: LookupMap<AccountId, bool>,
    next_warden: u64,
    agents: LookupMap<AccountId, Agent>,
    matches: LookupMap<String, Match>,
    /// EMBER held by accounts (outside Wardens)
    balances: LookupMap<AccountId, u64>,
    /// EMBER held by this contract: every purse plus every open pot
    held: u64,
    supply: u64,
    minted_total: u64,
    burned_total: u64,
    mint_day: u64,
    minted_today: u64,
    matches_settled: u64,
    recent: Vector<SupplyRow>,
    board: IterableMap<String, (u32, u64)>,
}

#[near]
impl Emberfall {
    #[init]
    pub fn new(owner: AccountId, referee: AccountId) -> Self {
        Self {
            owner,
            referee,
            wardens: LookupMap::new(Key::Wardens),
            warden_ids: Vector::new(Key::WardenIds),
            owned: LookupMap::new(Key::Owned),
            warden_of: LookupMap::new(Key::WardenOf),
            minted: LookupMap::new(Key::Minted),
            next_warden: 0,
            agents: LookupMap::new(Key::Agents),
            matches: LookupMap::new(Key::Matches),
            balances: LookupMap::new(Key::Balances),
            held: 0,
            supply: 0,
            minted_total: 0,
            burned_total: 0,
            mint_day: 0,
            minted_today: 0,
            matches_settled: 0,
            recent: Vector::new(Key::Recent),
            board: IterableMap::new(Key::Board),
        }
    }

    // ---------- admin ----------

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }
    fn only_referee(&self) {
        require!(env::predecessor_account_id() == self.referee, "only the referee");
    }

    pub fn set_referee(&mut self, referee: AccountId) {
        self.only_owner();
        self.referee = referee;
    }

    /// Creates `{name}.{this contract}` whose only key is a function-call key for the agent methods.
    #[payable]
    pub fn create_agent_account(&mut self, name: String, public_key: PublicKey) -> Promise {
        self.only_owner();
        require!(!name.is_empty() && !name.contains('.'), "agent name must be one label");
        let account: AccountId =
            format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("invalid agent name"));
        Promise::new(account).create_account().transfer(env::attached_deposit()).add_access_key_allowance(
            public_key,
            near_sdk::Allowance::limited(AGENT_GAS_ALLOWANCE).unwrap(),
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    /// Mints a Warden for an agent account (if it has none) and puts it under a spending policy.
    pub fn register_agent(&mut self, account: AccountId, name: String, day_cap: u64, match_cap: u64) -> String {
        self.only_owner();
        let warden = match self.warden_of.get(&account) {
            Some(w) => w.clone(),
            None => self.mint_internal(account.clone(), name),
        };
        self.agents.insert(account.clone(), Agent { warden: warden.clone(), day_cap, match_cap, day: 0, spent_today: 0 });
        Event::AgentRegistered { account, warden: warden.clone(), day_cap, match_cap }.emit();
        warden
    }

    // ---------- Wardens ----------

    /// Your free Warden, one per account, with a starting purse. Works from a function-call key.
    pub fn mint_warden(&mut self, name: String) -> String {
        let who = env::predecessor_account_id();
        require!(self.minted.get(&who).is_none(), "this account already minted its Warden");
        self.mint_internal(who, name)
    }

    pub fn rename_warden(&mut self, warden: String, name: String) {
        require!(valid_name(&name), "name: 1-20 letters, digits, spaces, - _ . '");
        self.owned_mut(&warden).name = name;
    }

    /// Lets the referee take up to `max_fee` EMBER from this Warden's purse as one match's entry fee.
    pub fn approve_fee(&mut self, warden: String, max_fee: u64) {
        self.owned_mut(&warden).approved_fee = max_fee;
    }

    /// Burns EMBER from your own Warden's purse: an offering to the dark.
    pub fn offer_to_dark(&mut self, warden: String, amount: u64) {
        require!(amount > 0, "offer something");
        self.owned_mut(&warden);
        self.spend(&warden, amount, false);
        self.wardens.get_mut(&warden).unwrap().offered += amount;
        self.burn_held(amount, &format!("{warden} offered {amount} to the dark"));
        Event::Offered { warden, amount }.emit();
    }

    /// Moves EMBER from your Warden's purse to your account (a plain NEP-141 balance).
    pub fn withdraw_purse(&mut self, warden: String, amount: u64) {
        let who = env::predecessor_account_id();
        self.owned_mut(&warden);
        self.spend(&warden, amount, false);
        self.held -= amount;
        self.credit_account(&who, amount);
        nep141("ft_transfer", json!({ "old_owner_id": env::current_account_id(), "new_owner_id": who, "amount": amount.to_string(), "memo": format!("withdrawn from {warden}") }));
    }

    /// Moves EMBER from your account into any Warden's purse.
    pub fn fund_purse(&mut self, warden: String, amount: u64) {
        let who = env::predecessor_account_id();
        require!(self.wardens.get(&warden).is_some(), "no such Warden");
        self.debit_account(&who, amount);
        self.held += amount;
        self.wardens.get_mut(&warden).unwrap().purse += amount;
        nep141("ft_transfer", json!({ "old_owner_id": who, "new_owner_id": env::current_account_id(), "amount": amount.to_string(), "memo": format!("into {warden}") }));
    }

    // ---------- matches ----------

    /// Opens a match: commits the seed's hash and takes each Warden seat's entry fee into the pot.
    pub fn create_match(&mut self, match_id: String, seed_hash: String, seats: Vec<SeatIn>, fee: u64) {
        self.only_referee();
        require!(!match_id.is_empty() && match_id.len() <= 64 && !match_id.contains('|'), "bad match id");
        require!(self.matches.get(&match_id).is_none(), "match exists");
        require!(valid_hex64(&seed_hash), "seed hash must be 64 lowercase hex");
        require!(!seats.is_empty() && seats.len() <= MAX_SEATS, "1-6 seats");
        let mut pot = 0u64;
        let mut seen: Vec<&String> = vec![];
        for s in &seats {
            let Some(w) = &s.warden else { continue };
            require!(!seen.contains(&w), "a Warden takes one seat");
            seen.push(w);
            let t = self.wardens.get(w).unwrap_or_else(|| env::panic_str("no such Warden"));
            if fee > 0 {
                require!(t.approved_fee >= fee, "entry fee above what the Warden's owner approved");
                self.spend(w, fee, true);
                pot += fee;
            }
        }
        Event::MatchCreated { match_id: match_id.clone(), seed_hash: seed_hash.clone(), wardens: seats.iter().map(|s| s.warden.clone()).collect(), fee, pot }.emit();
        let head = head_zero(&match_id);
        self.matches.insert(
            match_id,
            Match {
                seed_hash,
                seats,
                fee,
                pot,
                ranked: fee > 0,
                created_ns: U64(env::block_timestamp()),
                chunks: 0,
                head: head.clone(),
                opened: 0,
                open_head: head,
                seed: None,
                finals: vec![],
                settled: false,
                refunded: false,
                winner: None,
                burned: 0,
                prize: 0,
                minted: vec![],
                capped: false,
            },
        );
    }

    /// Posts the next chunks' seals (one per seat each) and folds them into the chain head.
    pub fn seal(&mut self, match_id: String, from_chunk: u32, chunks: Vec<Vec<String>>) {
        self.only_referee();
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(!m.settled && !m.refunded && m.opened == 0, "match closed");
        require!(from_chunk == m.chunks, "chunks must be sealed in order");
        require!(m.chunks + chunks.len() as u32 <= MAX_CHUNKS, "too many chunks");
        for seals in chunks {
            require!(seals.len() == m.seats.len(), "one seal per seat");
            require!(seals.iter().all(|s| valid_hex64(s)), "seals must be 64 lowercase hex");
            let chunk = m.chunks;
            m.head = next_head(&m.head, chunk, &seals);
            m.chunks += 1;
            Event::Sealed { match_id: match_id.clone(), chunk, seals, head: m.head.clone() }.emit();
        }
    }

    /// Reveals the seed and opens chunks in order. Every opening must rebuild its seal, and once all
    /// are open the re-folded head must equal the sealed one.
    pub fn open_chunks(&mut self, match_id: String, seed: String, from_chunk: u32, chunks: Vec<Vec<ChunkOpening>>) {
        self.only_referee();
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(!m.settled && !m.refunded, "match closed");
        require!(sha_hex(&seed) == m.seed_hash, "seed does not match its hash");
        require!(from_chunk == m.opened, "chunks must be opened in order");
        require!(m.opened + chunks.len() as u32 <= m.chunks, "more chunks than were sealed");
        let n = m.seats.len();
        for openings in chunks {
            require!(openings.len() == n, "one opening per seat");
            let chunk = m.opened;
            let mut seals = Vec::with_capacity(n);
            for (seat, o) in openings.iter().enumerate() {
                require!(valid_inputs(&o.inputs), "bad inputs");
                require!(o.hp <= HP && o.x >= 0 && o.z >= 0 && o.x <= ARENA_UNITS && o.z <= ARENA_UNITS, "impossible state");
                seals.push(seal_of(&match_id, &seed, seat, chunk, o));
            }
            m.open_head = next_head(&m.open_head, chunk, &seals);
            m.finals = openings.iter().map(|o| Final { hp: o.hp, embers: o.embers, kills: o.kills }).collect();
            m.opened += 1;
        }
        if m.opened == m.chunks {
            require!(m.open_head == m.head, "the openings don't rebuild the sealed chain head");
        }
        m.seed = Some(seed);
        Event::Opened { match_id, from: from_chunk, to: m.opened }.emit();
    }

    /// Settles a fully opened match from its final states alone. Anyone may call it.
    pub fn settle_match(&mut self, match_id: String) {
        let mut m = self.matches.get(&match_id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(!m.settled && !m.refunded, "match closed");
        require!(m.chunks > 0 && m.opened == m.chunks && m.open_head == m.head, "open every sealed chunk first");
        let n = m.seats.len();
        let finals = m.finals.clone();
        let winner = winner_of(&finals);
        let fallen = finals.iter().filter(|f| f.hp == 0).count() as u64;

        // the pot: a share burns per fallen seat; the rest to a Warden winner, or it burns too
        let mut burned = m.pot * (BURN_PER_FALLEN * fallen).min(BURN_MAX) / 100;
        let mut prize = m.pot - burned;
        let winner_warden = winner.and_then(|w| m.seats[w as usize].warden.clone());
        if winner_warden.is_none() {
            burned += prize;
            prize = 0;
        }
        if burned > 0 {
            self.burn_held(burned, &format!("{match_id}: lost to the dark"));
        }
        if let Some(w) = &winner_warden {
            self.wardens.get_mut(w).unwrap().purse += prize;
        }

        // embers carried out by living Wardens, within the caps
        let day = env::block_timestamp() / DAY_NS;
        if self.mint_day != day {
            self.mint_day = day;
            self.minted_today = 0;
        }
        let mut minted: Vec<u64> = (0..n)
            .map(|i| if m.seats[i].warden.is_some() && finals[i].hp > 0 { finals[i].embers as u64 } else { 0 })
            .collect();
        let total: u64 = minted.iter().sum();
        let cap = MATCH_MINT_CAP.min(DAILY_MINT_CAP - self.minted_today);
        let capped = total > cap;
        if capped {
            for x in minted.iter_mut() {
                *x = *x * cap / total;
            }
        }
        for i in 0..n {
            if minted[i] > 0 {
                let w = m.seats[i].warden.clone().unwrap();
                self.mint_to_purse(&w, minted[i], &format!("{match_id}: {} embers carried out", minted[i]));
                self.minted_today += minted[i];
            }
        }

        // records, loot and the board
        for i in 0..n {
            let Some(w) = m.seats[i].warden.clone() else { continue };
            let f = &finals[i];
            let won = winner == Some(i as u8) && n > 1;
            let t = self.wardens.get_mut(&w).unwrap();
            let r = &mut t.record;
            r.matches += 1;
            r.kills += f.kills;
            if f.hp == 0 {
                r.falls += 1;
            } else {
                r.embers_out += f.embers as u64;
                r.best = r.best.max(f.embers);
            }
            if won {
                r.wins += 1;
                t.loot[0] += 1;
            }
            t.loot[1] += f.kills;
            if f.hp > 0 && f.embers >= GLASS_EMBERS {
                t.loot[2] += 1;
            }
            let row = (t.record.wins, t.record.embers_out);
            self.board.insert(w, row);
        }

        let seed = m.seed.clone().unwrap_or_default();
        Event::Settled { match_id: match_id.clone(), seed, winner, fallen: fallen as u32, burned, prize, minted: minted.clone(), capped }.emit();
        let row = SupplyRow { match_id: match_id.clone(), pot: m.pot, burned, minted: minted.iter().sum(), fallen: fallen as u32, at_ns: U64(env::block_timestamp()) };
        if self.recent.len() >= RECENT {
            // keep the last RECENT rows: shift left by one
            for k in 1..self.recent.len() {
                let v = self.recent[k].clone();
                self.recent.replace(k - 1, v);
            }
            let last = self.recent.len() - 1;
            self.recent.replace(last, row);
        } else {
            self.recent.push(row);
        }
        self.matches_settled += 1;
        m.settled = true;
        m.winner = winner;
        m.burned = burned;
        m.prize = prize;
        m.minted = minted;
        m.capped = capped;
        m.pot = 0;
        self.matches.insert(match_id, m);
    }

    /// If the referee never settles, anyone can return the entry fees after two hours.
    pub fn refund_match(&mut self, match_id: String) {
        let mut m = self.matches.get(&match_id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(!m.settled && !m.refunded, "match closed");
        require!(env::block_timestamp() >= m.created_ns.0 + REFUND_AFTER_NS, "too early to refund");
        for s in &m.seats {
            if let Some(w) = &s.warden {
                if m.fee > 0 {
                    self.wardens.get_mut(w).unwrap().purse += m.fee;
                }
            }
        }
        m.pot = 0;
        m.refunded = true;
        self.matches.insert(match_id.clone(), m);
        Event::Refunded { match_id }.emit();
    }

    // ---------- views ----------

    pub fn get_match(&self, match_id: String) -> Option<Match> {
        self.matches.get(&match_id).cloned()
    }
    pub fn get_warden(&self, warden: String) -> Option<Warden> {
        self.wardens.get(&warden).cloned()
    }
    pub fn warden_of(&self, account_id: AccountId) -> Option<String> {
        self.warden_of.get(&account_id).cloned()
    }
    pub fn get_agent(&self, account_id: AccountId) -> Option<Agent> {
        self.agents.get(&account_id).cloned()
    }
    pub fn get_referee(&self) -> AccountId {
        self.referee.clone()
    }
    pub fn ember_supply(&self) -> Supply {
        let today = env::block_timestamp() / DAY_NS;
        Supply {
            total_supply: U128(self.supply as u128),
            minted: U128(self.minted_total as u128),
            burned: U128(self.burned_total as u128),
            held_by_wardens: U128(self.held as u128),
            minted_today: U128(if self.mint_day == today { self.minted_today } else { 0 } as u128),
            daily_cap: U128(DAILY_MINT_CAP as u128),
            match_cap: U128(MATCH_MINT_CAP as u128),
            matches_settled: self.matches_settled,
            recent: self.recent.iter().rev().cloned().collect(),
        }
    }
    pub fn leaderboard(&self, limit: Option<u32>) -> Vec<BoardRow> {
        let mut rows: Vec<BoardRow> = self
            .board
            .iter()
            .map(|(w, (wins, out))| BoardRow { warden: w.clone(), name: self.wardens.get(w).map(|t| t.name.clone()).unwrap_or_default(), wins: *wins, embers_out: *out })
            .collect();
        rows.sort_by(|a, b| b.wins.cmp(&a.wins).then(b.embers_out.cmp(&a.embers_out)).then(a.warden.cmp(&b.warden)));
        rows.truncate(limit.unwrap_or(20).min(100) as usize);
        rows
    }

    // ---------- NEP-141: EMBER ----------

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer_ft(&sender, &receiver_id, amount.0 as u64, memo);
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer_ft(&sender, &receiver_id, amount.0 as u64, memo);
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_ON_TRANSFER)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).ft_resolve_transfer(sender, receiver_id, amount))
            .into()
    }

    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(v) => serde_json::from_slice::<U128>(&v).map(|u| u.0.min(amount.0)).unwrap_or(amount.0),
            Err(_) => amount.0,
        } as u64;
        if unused == 0 {
            return amount;
        }
        let back = unused.min(self.balances.get(&receiver_id).copied().unwrap_or(0));
        if back > 0 {
            self.debit_account(&receiver_id, back);
            self.credit_account(&sender_id, back);
            nep141("ft_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": sender_id, "amount": back.to_string(), "memo": "refund" }));
        }
        U128(amount.0 - back as u128)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.supply as u128)
    }
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        if account_id == env::current_account_id() {
            return U128(self.held as u128);
        }
        U128(self.balances.get(&account_id).copied().unwrap_or(0) as u128)
    }
    pub fn ft_metadata(&self) -> FtMetadata {
        FtMetadata {
            spec: "ft-1.0.0".into(),
            name: "Ember".into(),
            symbol: "EMBER".into(),
            icon: Some(ember_icon()),
            reference: None,
            reference_hash: None,
            decimals: 0,
        }
    }

    // NEP-145, minimal: one fixed deposit registers an account (accounts are also registered
    // automatically when they first receive EMBER).
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit();
        if self.balances.get(&who).is_some() {
            if !deposit.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(deposit).detach();
            }
        } else {
            require!(deposit >= STORAGE_DEPOSIT, "attach at least 0.00125 NEAR");
            self.balances.insert(who, 0);
            let refund = deposit.saturating_sub(STORAGE_DEPOSIT);
            if !refund.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(refund).detach();
            }
        }
        StorageBalance { total: U128(STORAGE_DEPOSIT.as_yoctonear()), available: U128(0) }
    }
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances.get(&account_id).map(|_| StorageBalance { total: U128(STORAGE_DEPOSIT.as_yoctonear()), available: U128(0) })
    }
    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_DEPOSIT.as_yoctonear()), max: Some(U128(STORAGE_DEPOSIT.as_yoctonear())) }
    }

    // ---------- NEP-171: Wardens ----------

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.transfer_nft(&sender, &receiver_id, &token_id, memo);
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.transfer_nft(&sender, &receiver_id, &token_id, memo);
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_ON_TRANSFER)
            .nft_on_transfer(sender.clone(), sender.clone(), token_id.clone(), msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).nft_resolve_transfer(sender, receiver_id, token_id))
            .into()
    }

    #[private]
    pub fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String) -> bool {
        let return_it = match env::promise_result_checked(0, 16) {
            Ok(v) => serde_json::from_slice::<bool>(&v).unwrap_or(true),
            Err(_) => true,
        };
        if !return_it {
            return true;
        }
        if self.wardens.get(&token_id).map(|t| t.owner_id == receiver_id).unwrap_or(false) {
            self.move_nft(&receiver_id, &previous_owner_id, &token_id);
            nep171("nft_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": previous_owner_id, "token_ids": [token_id] }));
            return false;
        }
        true
    }

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        self.wardens.get(&token_id).map(|t| json_token(&token_id, t))
    }
    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Emberfall Wardens".into(),
            symbol: "WARDEN".into(),
            icon: Some(ember_icon()),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
    pub fn nft_total_supply(&self) -> U128 {
        U128(self.warden_ids.len() as u128)
    }
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let start = from_index.map(|i| i.0 as u32).unwrap_or(0);
        let lim = limit.unwrap_or(50).min(100) as u32;
        (start..self.warden_ids.len().min(start.saturating_add(lim)))
            .filter_map(|i| {
                let id = self.warden_ids.get(i)?;
                self.wardens.get(id).map(|t| json_token(id, t))
            })
            .collect()
    }
    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.owned.get(&account_id).map(|s| s.len()).unwrap_or(0) as u128)
    }
    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let Some(set) = self.owned.get(&account_id) else { return vec![] };
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        set.iter().skip(start).take(limit.unwrap_or(50).min(100) as usize).filter_map(|id| self.wardens.get(id).map(|t| json_token(id, t))).collect()
    }
}

// ---------- internals ----------

impl Emberfall {
    fn mint_internal(&mut self, owner: AccountId, name: String) -> String {
        require!(valid_name(&name), "name: 1-20 letters, digits, spaces, - _ . '");
        let id = format!("warden-{}", self.next_warden);
        self.next_warden += 1;
        self.minted.insert(owner.clone(), true);
        self.wardens.insert(
            id.clone(),
            Warden { owner_id: owner.clone(), name, purse: 0, loot: vec![0; LOOT.len()], record: Record::default(), approved_fee: 0, offered: 0 },
        );
        self.warden_ids.push(id.clone());
        self.add_owned(&owner, &id);
        if self.warden_of.get(&owner).is_none() {
            self.warden_of.insert(owner.clone(), id.clone());
        }
        nep171("nft_mint", json!({ "owner_id": owner, "token_ids": [id] }));
        self.mint_to_purse(&id, STARTER, &format!("{id}: starting purse"));
        id
    }

    fn mint_to_purse(&mut self, warden: &str, amount: u64, memo: &str) {
        self.wardens.get_mut(warden).unwrap().purse += amount;
        self.held += amount;
        self.supply += amount;
        self.minted_total += amount;
        nep141("ft_mint", json!({ "owner_id": env::current_account_id(), "amount": amount.to_string(), "memo": memo }));
    }

    /// Burns EMBER the contract holds (taken from a pot or a purse beforehand).
    fn burn_held(&mut self, amount: u64, memo: &str) {
        self.held -= amount;
        self.supply -= amount;
        self.burned_total += amount;
        nep141("ft_burn", json!({ "owner_id": env::current_account_id(), "amount": amount.to_string(), "memo": memo }));
    }

    fn credit_account(&mut self, who: &AccountId, amount: u64) {
        let b = self.balances.get(who).copied().unwrap_or(0);
        self.balances.insert(who.clone(), b + amount);
    }
    fn debit_account(&mut self, who: &AccountId, amount: u64) {
        let b = self.balances.get(who).copied().unwrap_or(0);
        require!(b >= amount, "not enough EMBER");
        self.balances.insert(who.clone(), b - amount);
    }

    fn transfer_ft(&mut self, sender: &AccountId, receiver: &AccountId, amount: u64, memo: Option<String>) {
        require!(amount > 0, "amount must be positive");
        require!(sender != receiver, "sender and receiver are the same");
        require!(*receiver != env::current_account_id(), "use fund_purse to put EMBER into a Warden");
        self.debit_account(sender, amount);
        self.credit_account(receiver, amount);
        let mut data = json!({ "old_owner_id": sender, "new_owner_id": receiver, "amount": amount.to_string() });
        if let Some(m) = memo {
            data["memo"] = json!(m);
        }
        nep141("ft_transfer", data);
    }

    fn add_owned(&mut self, owner: &AccountId, id: &str) {
        if self.owned.get(owner).is_none() {
            self.owned.insert(owner.clone(), IterableSet::new(Key::OwnedSet { owner_hash: env::sha256(owner.as_bytes()) }));
        }
        self.owned.get_mut(owner).unwrap().insert(id.to_string());
    }

    fn transfer_nft(&mut self, sender: &AccountId, receiver: &AccountId, token_id: &str, memo: Option<String>) {
        let t = self.wardens.get(token_id).unwrap_or_else(|| env::panic_str("no such token"));
        require!(&t.owner_id == sender, "only the owner can transfer");
        require!(sender != receiver, "already yours");
        // an agent's registered Warden stays with the agent: its policy is bound to it
        if let Some(a) = self.agents.get(sender) {
            require!(a.warden != token_id, "an agent's own Warden can't be transferred");
        }
        self.move_nft(sender, receiver, token_id);
        let mut data = json!({ "old_owner_id": sender, "new_owner_id": receiver, "token_ids": [token_id] });
        if let Some(m) = memo {
            data["memo"] = json!(m);
        }
        nep171("nft_transfer", data);
    }

    /// The purse, loot and record are fields of the token, so they move with it.
    fn move_nft(&mut self, from: &AccountId, to: &AccountId, token_id: &str) {
        let t = self.wardens.get_mut(token_id).unwrap();
        t.owner_id = to.clone();
        t.approved_fee = 0; // the new owner decides what the referee may take
        if let Some(set) = self.owned.get_mut(from) {
            set.remove(token_id);
        }
        self.add_owned(to, token_id);
        if self.warden_of.get(from).map(|w| w == token_id).unwrap_or(false) {
            self.warden_of.remove(from);
            let other = self.owned.get(from).and_then(|s| s.iter().next().cloned());
            if let Some(o) = other {
                self.warden_of.insert(from.clone(), o);
            }
        }
        if self.warden_of.get(to).is_none() {
            self.warden_of.insert(to.clone(), token_id.to_string());
        }
    }

    /// The caller must own `warden`; returns it for editing.
    fn owned_mut(&mut self, warden: &str) -> &mut Warden {
        let who = env::predecessor_account_id();
        let t = self.wardens.get_mut(warden).unwrap_or_else(|| env::panic_str("no such Warden"));
        require!(t.owner_id == who, "you don't own that Warden");
        t
    }

    /// Takes EMBER from a purse (it stays held by the contract), enforcing an agent's policy.
    fn spend(&mut self, warden: &str, amount: u64, entry_fee: bool) {
        let owner = self.wardens.get(warden).map(|t| t.owner_id.clone()).unwrap_or_else(|| env::panic_str("no such Warden"));
        if let Some(a) = self.agents.get_mut(&owner) {
            if a.warden == warden {
                let day = env::block_timestamp() / DAY_NS;
                if a.day != day {
                    a.day = day;
                    a.spent_today = 0;
                }
                if entry_fee {
                    require!(amount <= a.match_cap, "agent policy: entry fee over the per-match cap");
                }
                require!(a.spent_today + amount <= a.day_cap, "agent policy: over the daily spending cap");
                a.spent_today += amount;
            }
        }
        let t = self.wardens.get_mut(warden).unwrap();
        require!(t.purse >= amount, "not enough EMBER in the purse");
        t.purse -= amount;
    }
}

fn title_of(r: &Record) -> &'static str {
    match r.wins {
        0 => "Kindling",
        1..=2 => "Torchbearer",
        3..=9 => "Flamewarden",
        _ => "Ashlord",
    }
}

/// The torch flame the game shows: crown gold, glass white-blue, fang red, else plain.
pub fn flame_of(loot: &[u32]) -> u8 {
    if loot[0] > 0 {
        1
    } else if loot[2] > 0 {
        3
    } else if loot[1] > 0 {
        2
    } else {
        0
    }
}

fn json_token(id: &str, t: &Warden) -> JsonToken {
    let r = &t.record;
    let title = title_of(r);
    let flame = flame_of(&t.loot);
    let extra = json!({
        "purse": t.purse, "record": r, "flame": flame, "offered": t.offered,
        "loot": LOOT.iter().zip(t.loot.iter()).map(|(n, c)| (n.to_string(), json!(c))).collect::<serde_json::Map<_, _>>(),
    });
    JsonToken {
        token_id: id.to_string(),
        owner_id: t.owner_id.clone(),
        metadata: TokenMetadata {
            title: Some(format!("{} · {title}", t.name)),
            description: Some(format!(
                "An Emberfall Warden. Purse {} EMBER. {} matches, {} wins, {} embers carried out of the dark. Its purse, loot and record go with it.",
                t.purse, r.matches, r.wins, r.embers_out
            )),
            media: Some(warden_svg(&t.name, title, t.purse, r, &t.loot, flame)),
            copies: Some(U64(1)),
            extra: Some(extra.to_string()),
        },
        approved_account_ids: Default::default(),
    }
}

// SVGs are percent-encoded data URIs from fixed templates; names are restricted by valid_name.
fn data_uri(svg: String) -> String {
    let mut out = String::from("data:image/svg+xml,");
    for b in svg.bytes() {
        match b {
            b'<' => out.push_str("%3C"),
            b'>' => out.push_str("%3E"),
            b'#' => out.push_str("%23"),
            b'"' => out.push('\''),
            b'%' => out.push_str("%25"),
            _ => out.push(b as char),
        }
    }
    out
}

fn warden_svg(name: &str, title: &str, purse: u64, r: &Record, loot: &[u32], flame: u8) -> String {
    let (f1, f2) = match flame {
        1 => ("#ffd34d", "#fff2b0"),
        2 => ("#ff3b2f", "#ff9a6a"),
        3 => ("#9fd8ff", "#f2fbff"),
        _ => ("#ff7a1a", "#ffd08a"),
    };
    data_uri(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 400\" shape-rendering=\"crispEdges\"><rect width=\"320\" height=\"400\" fill=\"#0b0a14\"/>\
<circle cx=\"160\" cy=\"120\" r=\"90\" fill=\"{f1}\" opacity=\"0.12\"/><rect x=\"112\" y=\"150\" width=\"56\" height=\"70\" fill=\"#3a2f4a\"/>\
<rect x=\"120\" y=\"112\" width=\"40\" height=\"40\" fill=\"#d9b48f\"/><rect x=\"112\" y=\"104\" width=\"56\" height=\"16\" fill=\"#2a2236\"/>\
<rect x=\"130\" y=\"128\" width=\"6\" height=\"6\" fill=\"#0b0a14\"/><rect x=\"146\" y=\"128\" width=\"6\" height=\"6\" fill=\"#0b0a14\"/>\
<rect x=\"184\" y=\"96\" width=\"8\" height=\"96\" fill=\"#6b4426\"/><rect x=\"176\" y=\"72\" width=\"24\" height=\"26\" fill=\"{f1}\"/><rect x=\"182\" y=\"60\" width=\"12\" height=\"14\" fill=\"{f2}\"/>\
<text x=\"160\" y=\"262\" font-family=\"monospace\" font-size=\"22\" fill=\"#f4ead8\" text-anchor=\"middle\">{name}</text>\
<text x=\"160\" y=\"288\" font-family=\"monospace\" font-size=\"14\" fill=\"{f1}\" text-anchor=\"middle\">{title} - {purse} EMBER</text>\
<text x=\"160\" y=\"318\" font-family=\"monospace\" font-size=\"12\" fill=\"#b8aecb\" text-anchor=\"middle\">{} matches - {} wins - {} kills - {} falls</text>\
<text x=\"160\" y=\"340\" font-family=\"monospace\" font-size=\"12\" fill=\"#b8aecb\" text-anchor=\"middle\">{} embers carried out - best {}</text>\
<text x=\"160\" y=\"366\" font-family=\"monospace\" font-size=\"12\" fill=\"#b8aecb\" text-anchor=\"middle\">crowns {} - fangs {} - glass {}</text></svg>",
        r.matches, r.wins, r.kills, r.falls, r.embers_out, r.best, loot[0], loot[1], loot[2]
    ))
}

fn ember_icon() -> String {
    data_uri(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\" shape-rendering=\"crispEdges\"><rect width=\"16\" height=\"16\" fill=\"#0b0a14\"/><rect x=\"6\" y=\"3\" width=\"4\" height=\"3\" fill=\"#ffd08a\"/><rect x=\"5\" y=\"6\" width=\"6\" height=\"5\" fill=\"#ff7a1a\"/><rect x=\"6\" y=\"11\" width=\"4\" height=\"2\" fill=\"#b3361a\"/></svg>"
            .to_string(),
    )
}
