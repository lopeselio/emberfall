import { describe, expect, it } from 'vitest';
import {
  CENTER, CHUNK, DARK_R1, FEE, GRACE, HP, MATCH_MINT_CAP, PILLAR, SIZE, TILE, VIEW, WALL, blocked, createState, darkRadius, decide,
  eventsFor, foldHead, headZero, logFromOpenings, makeArena, nextHead, replay, Recorder, saltOf, sealOf, settle, stateHash, step,
  tileAt, viewFor, winnerOf, type Input, type LogEntry, type Setup, type State,
} from '../src/index.ts';

const setup = (seed = 'test-seed', bots = 3): Setup => ({
  seed,
  seats: [{ name: 'You' }, ...Array.from({ length: bots }, (_, i) => ({ name: `Bot${i}`, bot: (['hard', 'normal', 'easy'] as const)[i % 3] }))],
});

/** A scripted human: walks in a square, swings and dashes now and then. */
const human = (tick: number): Input => ({
  mx: [1, 0, -1, 0][Math.floor(tick / 50) % 4], mz: [0, 1, 0, -1][Math.floor(tick / 50) % 4], swing: tick % 17 === 0, dash: tick % 90 === 5,
});

function play(su: Setup, inputs: (t: number) => Input = human) {
  const s = createState(su);
  const rec = new Recorder(su.seats.length);
  const log: LogEntry[] = [];
  const chunks: ReturnType<Recorder['close']>[] = [];
  while (!s.over) {
    const t = s.tick;
    const { applied } = step(s, [inputs(t)]);
    rec.add(t, applied);
    applied.forEach((a, c) => { if (a) log.push({ t, c, i: a }); });
    if (s.tick % CHUNK === 0 || s.over) chunks.push(rec.close(s));
  }
  return { s, log, chunks };
}

describe('arena', () => {
  it('is the same for the same seed, walled in, with open spawn pads', () => {
    const a = makeArena('x'), b = makeArena('x');
    expect(a.tiles).toEqual(b.tiles);
    expect(makeArena('y').tiles).not.toEqual(a.tiles);
    for (let i = 0; i < SIZE; i++) expect(tileAt(a, i, 0)).toBe(WALL);
    for (const p of a.spawns) expect(blocked(a, p.x, p.z, 30)).toBe(false);
    expect(tileAt(a, SIZE / 2, SIZE / 2)).toBe(0);
  });
});

describe('the match', () => {
  it('is deterministic: same seed and inputs, same end state', () => {
    const a = play(setup()), b = play(setup());
    expect(stateHash(a.s)).toBe(stateHash(b.s));
    expect(a.s.tick).toBe(b.s.tick);
    expect(stateHash(play(setup('other')).s)).not.toBe(stateHash(a.s));
  });

  it('ends with a winner by the rule, and the dark shrinks', () => {
    const { s } = play(setup('ends', 5));
    expect(s.over).toBe(true);
    expect(s.winner).toBe(winnerOf(s.wardens));
    expect(darkRadius(0)).toBeGreaterThan(darkRadius(1500));
    expect(darkRadius(99999)).toBe(DARK_R1);
  });

  it('replays from the log to the same state hash', () => {
    const { s, log } = play(setup('replay', 4));
    let mismatches = 0;
    const r = replay(setup('replay', 4), log, (_st, applied, logged) => {
      applied.forEach((a, i) => { if (JSON.stringify(a) !== JSON.stringify(logged[i])) mismatches++; });
    });
    expect(stateHash(r)).toBe(stateHash(s));
    expect(mismatches).toBe(0);
  });

  it('a tampered input changes the replay', () => {
    const { s, log } = play(setup('tamper', 2));
    const bad = log.map((e) => (e.c === 0 && e.t === log.find((x) => x.c === 0 && x.t > 100)!.t ? { ...e, i: { ...e.i, mx: -e.i.mx || 1 } } : e));
    expect(stateHash(replay(setup('tamper', 2), bad))).not.toBe(stateHash(s));
  });
});

describe('combat, embers and the dark', () => {
  const duel = (): State => {
    const s = createState({ seed: 'duel', seats: [{ name: 'A' }, { name: 'B' }] });
    s.embers = [];
    // stand them next to each other on the open plaza, A facing B
    Object.assign(s.wardens[0], { x: CENTER, z: CENTER, fx: 1, fz: 0 });
    Object.assign(s.wardens[1], { x: CENTER + 100, z: CENTER, fx: -1, fz: 0, embers: 3 });
    return s;
  };

  it('a swing in front hits for one heart and knocks an ember out', () => {
    const s = duel();
    const { events } = step(s, [{ swing: true }]);
    expect(events.some((e) => e.t === 'hit' && e.w === 1 && e.by === 0)).toBe(true);
    expect(s.wardens[1].hp).toBe(HP - 1);
    expect(s.wardens[1].embers).toBe(2);
    expect(s.wardens[1].x).toBeGreaterThan(CENTER + 100);
    expect(s.embers.length).toBe(1);
    expect(s.wardens[1].grace).toBe(GRACE - 1);
  });

  it('a swing behind you misses', () => {
    const s = duel();
    s.wardens[0].fx = -1;
    step(s, [{ swing: true }]);
    expect(s.wardens[1].hp).toBe(HP);
  });

  it('the swing waits for its cooldown, and only effective swings are logged', () => {
    const s = duel();
    const first = step(s, [{ swing: true }]);
    const second = step(s, [{ swing: true }]);
    expect(first.applied[0]?.swing).toBe(true);
    expect(second.applied[0]).toBeNull();
  });

  it('a fallen Warden spills every ember and the killer is credited', () => {
    const s = duel();
    s.wardens[1].hp = 1;
    const { events } = step(s, [{ swing: true }]);
    expect(events.some((e) => e.t === 'fall' && e.w === 1 && e.by === 0)).toBe(true);
    expect(s.wardens[1].alive).toBe(false);
    expect(s.wardens[0].kills).toBe(1);
    expect(s.embers.length).toBe(3);
    expect(s.over).toBe(true);
    expect(s.winner).toBe(0);
  });

  it('walking over an ember picks it up', () => {
    const s = duel();
    s.embers = [{ id: 99, x: CENTER + 20, z: CENTER }];
    step(s, [{}]);
    expect(s.wardens[0].embers).toBe(1);
    expect(s.embers.length).toBe(0);
  });

  it('the dark burns anyone outside it once a second', () => {
    const s = duel();
    s.tick = 2999 - 19; // late: the circle is small
    Object.assign(s.wardens[0], { x: 300, z: 300 });
    while (s.tick % 20 !== 0) step(s, [{}]);
    const { events } = step(s, [{}]);
    expect(events.some((e) => e.t === 'burn' && e.w === 0)).toBe(true);
    expect(s.wardens[0].hp).toBe(HP - 1);
  });

  it('walls stop you', () => {
    const s = createState({ seed: 'walls', seats: [{ name: 'A' }] });
    Object.assign(s.wardens[0], { x: 160, z: 2000 });
    for (let k = 0; k < 20; k++) step(s, [{ mx: -1, mz: 0 }]);
    expect(s.wardens[0].x).toBeGreaterThanOrEqual(TILE + 30);
  });
});

describe('the fog', () => {
  it('a view holds only what the torch reveals; carried embers glow further', () => {
    const s = createState({ seed: 'fog', seats: [{ name: 'A' }, { name: 'B' }] });
    s.arena.tiles = s.arena.tiles.map((t, i) => (t === PILLAR || (t === WALL && i > SIZE && i < SIZE * (SIZE - 1) && i % SIZE && (i + 1) % SIZE) ? 0 : t));
    Object.assign(s.wardens[0], { x: CENTER, z: CENTER });
    Object.assign(s.wardens[1], { x: CENTER + VIEW + 100, z: CENTER, embers: 0 });
    s.embers = [{ id: 1, x: CENTER + 200, z: CENTER }, { id: 2, x: CENTER - VIEW - 50, z: CENTER }];
    let v = viewFor(s, 0);
    expect(v.others).toHaveLength(0);
    expect(v.embers.map((e) => e.id)).toEqual([1]);
    s.wardens[1].embers = 5; // +150: now visible
    v = viewFor(s, 0);
    expect(v.others.map((o) => o.seat)).toEqual([1]);
    // and B, whose torch doesn't reach A, still can't see A
    expect(viewFor(s, 1).others).toHaveLength(0);
  });

  it('walls block the light', () => {
    const s = createState({ seed: 'fog2', seats: [{ name: 'A' }, { name: 'B' }] });
    Object.assign(s.wardens[0], { x: CENTER - 200, z: CENTER });
    Object.assign(s.wardens[1], { x: CENTER + 200, z: CENTER });
    s.arena.tiles[(CENTER / TILE) * SIZE + CENTER / TILE] = WALL;
    expect(viewFor(s, 0).others).toHaveLength(0);
  });

  it('events far away are hidden, except that someone fell', () => {
    const s = createState({ seed: 'fog3', seats: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
    Object.assign(s.wardens[0], { x: 500, z: 500 });
    const ev = eventsFor(s, 0, [{ t: 'swing', w: 1, x: 3000, z: 3000 }, { t: 'fall', w: 2, by: 1, x: 3000, z: 3000 }]);
    expect(ev).toEqual([{ t: 'fall', w: 2, by: 1, x: -1, z: -1 }]);
  });

  it('a bot decides from its view alone: hidden Wardens change nothing', () => {
    const s = createState({ seed: 'botfog', seats: [{ name: 'Bot', bot: 'hard' }, { name: 'Far' }] });
    Object.assign(s.wardens[0], { x: CENTER, z: CENTER });
    const brain = s.wardens[0].brain;
    const copy = () => ({ r: { ...brain.r }, gx: brain.gx, gz: brain.gz });
    const a = decide(viewFor(s, 0), s.arena, 'hard', copy());
    Object.assign(s.wardens[1], { x: 500, z: 3500, hp: 1, embers: 0 }); // far away, invisible
    const b = decide(viewFor(s, 0), s.arena, 'hard', copy());
    expect(b).toEqual(a);
  });
});

describe('seals', () => {
  // the same vector is in contracts/emberfall/src/tests.rs
  it('matches the shared test vector', () => {
    const seed = '00112233445566778899aabbccddeeff';
    const o = { inputs: '3:1,0,0;7:1,-1,1;45:0,0,2', x: 2350, z: 1990, hp: 4, embers: 3, kills: 1 };
    expect(saltOf(seed, 2, 5)).toBe('b97af859f0786d2fd3f3f50262ffc6f6aa8d4e6d300ebcac0901d19d90b22e5b');
    const seal = sealOf('m-test', seed, 2, 5, o);
    expect(seal).toBe('1ad3cb5b4083b2e2cc160d7ce5b985041c691f65a582491ee7f071ad8e057003');
    expect(headZero('m-test')).toBe('93485abfe7775d46a84579473b2f0f06c77491c613385002654b71342e63e125');
    expect(nextHead(headZero('m-test'), 0, [seal, seal])).toBe('f7db9ce2133b0e9e5180990d042b73067f4e7e78af6bd2d23524bfbe7b5825ed');
  });

  it('the opened chunks are the whole log: replaying them reaches the end state and every chunk state', () => {
    const su = setup('chunks', 3);
    const { s, chunks } = play(su);
    expect(chunks.length).toBe(Math.ceil(s.tick / CHUNK));
    const log = logFromOpenings(chunks);
    let k = 0, bad = 0;
    const r = replay(su, log, (st) => {
      if (st.tick % CHUNK === 0 || st.over) {
        chunks[k].forEach((o, seat) => { const w = st.wardens[seat]; if (o.x !== w.x || o.z !== w.z || o.hp !== w.hp || o.embers !== w.embers) bad++; });
        k++;
      }
    });
    expect(bad).toBe(0);
    expect(stateHash(r)).toBe(stateHash(s));
    const seals = chunks.map((c, chunk) => c.map((o, seat) => sealOf('m1', su.seed, seat, chunk, o)));
    const head = foldHead('m1', seals);
    // change one recorded position and the head moves
    const forged = chunks.map((c) => c.map((o) => ({ ...o })));
    forged[1][0].x += 1;
    expect(foldHead('m1', forged.map((c, chunk) => c.map((o, seat) => sealOf('m1', su.seed, seat, chunk, o))))).not.toBe(head);
  });
});

describe('EMBER settlement', () => {
  const f = (hp: number, embers: number, kills = 0) => ({ hp, embers, kills });

  it('the winner is the living Warden with most embers, then hearts, then lowest seat', () => {
    expect(winnerOf([f(0, 9), f(2, 3), f(5, 3)])).toBe(2);
    expect(winnerOf([f(3, 3), f(3, 3)])).toBe(0);
    expect(winnerOf([f(0, 1), f(0, 1)])).toBeNull();
  });

  it('burns 15% of the pot per fallen seat and pays the rest to a Warden winner', () => {
    const r = settle(4 * FEE, [true, true, true, true], [f(3, 5), f(0, 0), f(0, 2), f(2, 1)]);
    expect(r).toMatchObject({ winner: 0, fallen: 2, burned: 6, prize: 14, mints: [5, 0, 0, 1], capped: false });
  });

  it('burns the whole pot when a guest wins or nobody survives', () => {
    expect(settle(10, [false, true], [f(3, 5), f(0, 1)])).toMatchObject({ winner: 0, burned: 10, prize: 0, mints: [0, 0] });
    expect(settle(10, [true, true], [f(0, 5), f(0, 1)])).toMatchObject({ winner: null, burned: 10, prize: 0 });
  });

  it('caps what one match mints, pro rata', () => {
    const r = settle(0, [true, true], [f(3, 60), f(3, 20)]);
    expect(r.capped).toBe(true);
    expect(r.mints).toEqual([Math.floor((60 * MATCH_MINT_CAP) / 80), Math.floor((20 * MATCH_MINT_CAP) / 80)]);
    expect(settle(0, [true], [f(3, 10)], 4).mints).toEqual([4]);
  });
});
