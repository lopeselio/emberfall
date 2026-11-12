import { useEffect, useRef, useState } from 'react';
import {
  CENTER, CHUNK, DASH_CD, GLOW_MAX, SIZE, SWING_CD, TICK_HZ, TILE, VIEW, createState, eventsFor, foldHead, logFromOpenings,
  sealOf, step, viewFor, type Input, type Opening, type SimEvent, type Setup, type View,
  darkTimes, maxHp,
} from '@emberfall/rules';
import type { LineMsg, ResultsMsg, SnapMsg, StartMsg } from './api.ts';
import { CLOAKS, type World } from './scene.ts';
import { droneLevel, sfx, startDrone, stopDrone } from './sound.ts';

// The match screen: input (keyboard + mouse aim, gamepad, touch), the HUD over the 3D arena,
// the results, and a replay of the finished match rebuilt in the browser from the opened log.

interface Feed { id: number; text: string; at: number; mine: boolean }
const fmt = (ticks: number): string => { const s = Math.max(0, Math.ceil(ticks / TICK_HZ)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const touchy = typeof window !== 'undefined' && (('ontouchstart' in window) || window.matchMedia?.('(pointer: coarse)').matches);
const sign = (n: number): number => (n > 0.35 ? 1 : n < -0.35 ? -1 : 0);
/** Eight-way direction of a vector. */
function dir8(x: number, z: number): [number, number] {
  if (Math.hypot(x, z) < 0.2) return [0, 0];
  const a = Math.round(Math.atan2(z, x) / (Math.PI / 4));
  return ([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as [number, number][])[(a + 8) % 8];
}

export function Match({ world, start, results, lines, send, subscribe, again, leave, account }: {
  world: World; start: StartMsg; results: ResultsMsg | null; lines: LineMsg[]; send: (m: unknown) => void;
  subscribe: (fn: (s: SnapMsg) => void) => void; again: () => void; leave: () => void; account: string | null;
}) {
  const [v, setV] = useState<View | null>(null);
  const [now, setNow] = useState(Date.now());
  const [feed, setFeed] = useState<Feed[]>([]);
  const [fellAt, setFellAt] = useState<{ place: number; by: string } | null>(null);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [replayErr, setReplayErr] = useState('');
  const mini = useRef<HTMLCanvasElement>(null);
  const seen = useRef(new Uint8Array(SIZE * SIZE));
  const names = start.seats.map((s) => s.name);
  // hearts and the dark's timing depend on the match's rules version (v4: 8 hearts, a slower dark)
  const HP = maxHp(start.rules);
  const [darkStart, darkEnd] = darkTimes(start.rules);
  // what we last told the server
  const sent = useRef({ mx: 0, mz: 0, ax: 0, az: 0 });
  const lastBeat = useRef(0);
  const aliveRef = useRef(start.seats.length);

  const push = (m: Partial<Input>): void => {
    const next = { ...sent.current, ...m };
    const changed = next.mx !== sent.current.mx || next.mz !== sent.current.mz || next.ax !== sent.current.ax || next.az !== sent.current.az;
    sent.current = { mx: next.mx ?? 0, mz: next.mz ?? 0, ax: next.ax ?? 0, az: next.az ?? 0 };
    world.setInput(sent.current.mx, sent.current.mz, !!m.dash);
    if (changed || m.swing || m.dash) send({ t: 'in', ...sent.current, swing: !!m.swing, dash: !!m.dash });
  };

  useEffect(() => {
    world.startMatch(start.tiles, start.you, names, start.seats.map((s) => s.flame), maxHp(start.rules));
    document.title = 'Emberfall · in the dark';
    startDrone();
    let feedId = 0;
    world.onEvent = (e, mine) => {
      if (e.t === 'swing' && e.w === start.you) sfx('swing');
      if (e.t === 'dash' && e.w === start.you) sfx('dash');
      if (e.t === 'hit') sfx(e.w === start.you ? 'hurt' : 'hit');
      if (e.t === 'pick' && e.w === start.you) sfx('pick', 0);
      if (e.t === 'burn' && e.w === start.you) sfx('burn');
      if (e.t === 'fall') {
        sfx('fall');
        const text = e.by === -1 ? `${names[e.w]} was taken by the dark` : `${names[e.by]} felled ${names[e.w]}`;
        setFeed((f) => [...f.slice(-4), { id: feedId++, text, at: Date.now(), mine }]);
        if (e.w === start.you) setFellAt({ place: aliveRef.current, by: e.by === -1 ? 'the dark' : names[e.by] });
      }
    };
    subscribe((s) => {
      world.update(s.v, s.ev);
      aliveRef.current = s.v.alive + (s.v.me.alive ? 0 : 1);
      setV(s.v);
      droneLevel(Math.min(1, Math.max(0, (s.v.tick - darkStart) / (darkEnd - darkStart))));
      const me = s.v.me;
      const d2 = (me.x - CENTER) ** 2 + (me.z - CENTER) ** 2;
      if (me.alive && (d2 > s.v.darkR ** 2 || me.hp <= 1) && Date.now() - lastBeat.current > 900) { lastBeat.current = Date.now(); sfx('heart'); }
      reveal(seen.current, me.x, me.z);
      drawMini(mini.current, start, s.v, seen.current);
    });
    const t = setInterval(() => setNow(Date.now()), 250);
    const left = Math.ceil((start.startsAt - Date.now()) / 1000);
    const beeps = Array.from({ length: Math.max(0, left) }, (_, k) => setTimeout(() => sfx(k === left - 1 ? 'go' : 'beep'), Math.max(0, start.startsAt - Date.now() - (left - 1 - k) * 1000 - 1000)));
    return () => { clearInterval(t); beeps.forEach(clearTimeout); world.onEvent = null; stopDrone(); subscribe(() => undefined); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.matchId]);

  useEffect(() => { if (results) sfx(results.winner === start.you ? 'win' : 'lose'); }, [results?.matchId, results === null]);

  // keyboard + mouse: WASD/arrows move, the mouse aims, click or Space swings, right-click or Shift dashes
  useEffect(() => {
    const keys = new Set<string>();
    let mouse: { x: number; y: number } | null = null;
    const move = (): { mx: number; mz: number } => ({
      mx: (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0),
      mz: (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0),
    });
    const aimNow = (): { ax: number; az: number } => {
      const me = world.mePos();
      if (!mouse || !me) return { ax: sent.current.ax, az: sent.current.az };
      const g = world.groundAt(mouse.x, mouse.y);
      if (!g) return { ax: sent.current.ax, az: sent.current.az };
      const [ax, az] = dir8(g.x - me.x, g.z - me.z);
      if (ax || az) { const l = Math.hypot(g.x - me.x, g.z - me.z) || 1; world.aim = { x: (g.x - me.x) / l, z: (g.z - me.z) / l }; }
      return { ax, az };
    };
    const typing = (e: Event): boolean => (e.target as HTMLElement)?.tagName === 'INPUT';
    const down = (e: KeyboardEvent): void => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if ([' ', 'j', 'enter'].includes(k)) { e.preventDefault(); if (!e.repeat) push({ ...aimNow(), swing: true }); return; }
      if (['shift', 'k', 'l'].includes(k)) { if (!e.repeat) push({ dash: true }); return; }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault(); keys.add(k);
        const m = move();
        if (!mouse && (m.mx || m.mz)) world.aim = { x: m.mx, z: m.mz };
        push(m);
      }
    };
    const up = (e: KeyboardEvent): void => { if (keys.delete(e.key.toLowerCase())) push(move()); };
    const blur = (): void => { keys.clear(); push({ mx: 0, mz: 0 }); };
    const mm = (e: PointerEvent): void => { if (e.pointerType !== 'mouse') return; mouse = { x: e.clientX, y: e.clientY }; push(aimNow()); };
    const md = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('button, a, input, .card, select, summary')) return;
      mouse = { x: e.clientX, y: e.clientY };
      if (e.button === 0) push({ ...aimNow(), swing: true });
      if (e.button === 2) push({ ...aimNow(), dash: true });
    };
    const ctx = (e: MouseEvent): void => e.preventDefault();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('pointermove', mm);
    window.addEventListener('pointerdown', md);
    window.addEventListener('contextmenu', ctx);
    // gamepad: left stick moves, right stick aims, A / RT swing, B / LT dash
    let raf = 0;
    const prev: boolean[] = [];
    const pad = (): void => {
      const gp = [...(navigator.getGamepads?.() ?? [])].find((g) => g);
      if (gp) {
        const mx = sign(gp.axes[0] ?? 0), mz = sign(gp.axes[1] ?? 0);
        const [ax, az] = dir8(gp.axes[2] ?? 0, gp.axes[3] ?? 0);
        const swing = !!(gp.buttons[0]?.pressed || gp.buttons[7]?.pressed), dash = !!(gp.buttons[1]?.pressed || gp.buttons[6]?.pressed);
        const m: Partial<Input> = { mx, mz };
        if (ax || az) { m.ax = ax; m.az = az; world.aim = { x: ax, z: az }; } else if (mx || mz) world.aim = { x: mx, z: mz };
        if (swing && !prev[0]) m.swing = true;
        if (dash && !prev[1]) m.dash = true;
        prev[0] = swing; prev[1] = dash;
        if (mx !== sent.current.mx || mz !== sent.current.mz || m.ax !== undefined || m.swing || m.dash) push(m);
      }
      raf = requestAnimationFrame(pad);
    };
    raf = requestAnimationFrame(pad);
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur);
      window.removeEventListener('pointermove', mm); window.removeEventListener('pointerdown', md); window.removeEventListener('contextmenu', ctx);
      cancelAnimationFrame(raf);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, world]);

  const countdown = Math.ceil((start.startsAt - now) / 1000);
  const me = v?.me;
  const left = v ? start.maxTicks - v.tick : start.maxTicks;
  const darkIn = v ? darkStart - v.tick : darkStart;
  const distC = me ? Math.hypot(me.x - CENTER, me.z - CENTER) : 0;
  const outside = !!(me && me.alive && v && distC > v.darkR);
  const near = !!(me && me.alive && v && !outside && v.darkR - distC < 250 && darkIn <= 0);
  // low: 2 of 5 hearts, 3 of 8
  const low = !!(me && me.alive && me.hp * 5 <= 2 * HP);

  if (replay) return <Replay r={replay} world={world} start={start} close={() => setReplay(null)} />;

  return (
    <div className="hud">
      <div className="hud-tl card">
        <div className="bar hp"><span style={{ width: `${((me?.hp ?? HP) / HP) * 100}%` }} /><b>{me?.hp ?? HP} / {HP} ♥</b></div>
        <div className="bar glow"><span style={{ width: `${(Math.min(me?.embers ?? 0, GLOW_MAX) / GLOW_MAX) * 100}%` }} /><b>◆ {me?.embers ?? 0} embers</b></div>
        <div className="dim small">{me?.kills ? `${me.kills} felled · ` : ''}{start.ranked ? `ranked · ${start.fee} EMBER entry` : 'unranked'}{(me?.embers ?? 0) >= 5 ? ' · you glow: seen from afar' : ''}</div>
      </div>
      <div className="hud-tc card">
        <b className="clock">{fmt(left)}</b>
        <span className={outside ? 'darkword' : near ? 'warnword' : 'dim'}>{darkIn > 0 ? `the dark closes in ${fmt(darkIn)}` : outside ? 'YOU ARE IN THE DARK' : near ? 'the dark is at your back' : 'the dark is closing'}</span>
        <span className="small"><b>{v?.alive ?? start.seats.length}</b> <span className="dim">of {start.seats.length} Wardens burn</span></span>
      </div>
      <div className="feed">
        {feed.filter((f) => now - f.at < 7000).map((f) => <p key={f.id} className={f.mine ? 'mine' : ''}>{f.text}</p>)}
        {(v?.tick ?? 0) < 400 && lines.slice(-1).map((l, i) => <p key={`l${i}`} className="line">{l.who}: “{l.text}”{l.signed && <small> ✓ NEAR AI TEE</small>}</p>)}
      </div>
      <canvas ref={mini} className="minimap" width={150} height={150} title="What your torch has revealed" />
      {!touchy && !results && <div className="keys dim small">WASD move · mouse aims · click / Space swing · right-click / Shift dash · gamepad works too</div>}
      {me && !results && <Cooldowns me={me} />}
      {touchy && !results && <Touch push={push} world={world} />}
      {countdown > 0 && <div className="center big-count" key={countdown}>{countdown}</div>}
      {outside && <div className="vignette dark" />}
      {low && !outside && <div className="vignette low" />}
      {fellAt && !results && <div className="center card fell"><h2>You fell · #{fellAt.place}</h2><p className="dim">Taken by {fellAt.by}. Your embers spill into the dark; the match goes on without you.</p><button className="ghost" onClick={leave}>Leave</button></div>}
      {results && <Results r={results} you={start.you} again={again} leave={leave} account={account} err={replayErr}
        watch={() => { setReplayErr(''); void loadReplay(results.matchId, start.you).then(setReplay).catch((e: Error) => setReplayErr(e.message)); }} />}
    </div>
  );
}

function Cooldowns({ me }: { me: View['me'] }) {
  return (
    <div className="cds">
      <div className={me.swingCd ? 'cd' : 'cd ready'}><span style={{ height: `${(me.swingCd / SWING_CD) * 100}%` }} />Swing</div>
      <div className={me.dashCd ? 'cd' : 'cd ready'}><span style={{ height: `${(me.dashCd / DASH_CD) * 100}%` }} />Dash</div>
    </div>
  );
}

function Touch({ push, world }: { push: (m: Partial<Input>) => void; world: World }) {
  const base = useRef<{ x: number; y: number; id: number } | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  return (
    <>
      <div className="stick-zone"
        onPointerDown={(e) => { base.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; (e.target as HTMLElement).setPointerCapture(e.pointerId); setKnob({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 }); }}
        onPointerMove={(e) => {
          const b = base.current;
          if (!b || b.id !== e.pointerId) return;
          const dx = e.clientX - b.x, dy = e.clientY - b.y;
          const len = Math.hypot(dx, dy);
          const k = Math.min(1, len / 50);
          setKnob({ x: b.x, y: b.y, dx: (dx / (len || 1)) * 50 * k, dy: (dy / (len || 1)) * 50 * k });
          const [mx, mz] = len < 14 ? [0, 0] : dir8(dx, dy);
          if (mx || mz) world.aim = { x: mx, z: mz };
          push({ mx, mz });
        }}
        onPointerUp={() => { base.current = null; setKnob(null); push({ mx: 0, mz: 0 }); }}
        onPointerCancel={() => { base.current = null; setKnob(null); push({ mx: 0, mz: 0 }); }}
      >
        {knob && <div className="stick" style={{ left: knob.x - 50, top: knob.y - 50 }}><i style={{ transform: `translate(${knob.dx}px, ${knob.dy}px)` }} /></div>}
      </div>
      <div className="tbtns">
        <button className="tbtn dash" onPointerDown={(e) => { e.preventDefault(); navigator.vibrate?.(15); push({ dash: true }); }}>Dash</button>
        <button className="tbtn swing" onPointerDown={(e) => { e.preventDefault(); navigator.vibrate?.(25); push({ swing: true }); }}>Swing</button>
      </div>
    </>
  );
}

/** Marks the tiles your torch has lit as explored (the minimap shows only those). */
function reveal(seen: Uint8Array, x: number, z: number): void {
  const r = Math.ceil(VIEW / TILE);
  const cx = Math.floor(x / TILE), cz = Math.floor(z / TILE);
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dz * dz > r * r) continue;
    const tx = cx + dx, tz = cz + dz;
    if (tx >= 0 && tz >= 0 && tx < SIZE && tz < SIZE) seen[tz * SIZE + tx] = 1;
  }
}

function drawMini(cv: HTMLCanvasElement | null, start: StartMsg, v: View, seen: Uint8Array | null): void {
  if (!cv) return;
  const x = cv.getContext('2d')!;
  const S = cv.width / SIZE;
  x.fillStyle = '#05040a'; x.fillRect(0, 0, cv.width, cv.height);
  start.tiles.forEach((t, i) => {
    if (seen && !seen[i]) return;
    x.fillStyle = t === 0 ? '#1d1a28' : t === 1 ? '#5b5866' : t === 2 ? '#77737f' : t === 3 ? '#3b2a1f' : '#a0502a';
    x.fillRect((i % SIZE) * S, Math.floor(i / SIZE) * S, S + 0.5, S + 0.5);
  });
  const u = (n: number): number => (n / TILE) * S;
  x.save();
  x.beginPath(); x.rect(0, 0, cv.width, cv.height); x.arc(u(CENTER), u(CENTER), u(v.darkR), 0, Math.PI * 2, true);
  x.fillStyle = 'rgba(60,14,100,.55)'; x.fill('evenodd');
  x.restore();
  x.strokeStyle = '#b05cff'; x.lineWidth = 1.5; x.beginPath(); x.arc(u(CENTER), u(CENTER), u(v.darkR), 0, Math.PI * 2); x.stroke();
  x.strokeStyle = 'rgba(255,170,80,.5)'; x.beginPath(); x.arc(u(v.me.x), u(v.me.z), u(VIEW), 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#ffb347';
  for (const e of v.embers) x.fillRect(u(e.x) - 1, u(e.z) - 1, 2.5, 2.5);
  for (const o of v.others) { x.fillStyle = hex(CLOAKS[o.seat % 6]); x.fillRect(u(o.x) - 2.5, u(o.z) - 2.5, 5, 5); }
  x.fillStyle = '#fff'; x.fillRect(u(v.me.x) - 3, u(v.me.z) - 3, 6, 6);
}

/** Placement: the winner, then the other survivors (by the winner rule), then the fallen, latest first. */
function placements(r: ResultsMsg): number[] {
  const idx = r.seats.map((_, i) => i);
  idx.sort((a, b) => {
    const A = r.seats[a], B = r.seats[b];
    if (a === r.winner) return -1;
    if (b === r.winner) return 1;
    if (A.alive !== B.alive) return A.alive ? -1 : 1;
    if (A.alive) return B.embers - A.embers || B.hp - A.hp || a - b;
    return B.fellAt - A.fellAt || a - b;
  });
  const place = new Array<number>(r.seats.length);
  idx.forEach((i, k) => { place[i] = k + 1; });
  return place;
}

/** What the chain is doing after the bell: the last seals, then the openings in batches, then settlement (a minute or two). */
function settling(r: ResultsMsg): string {
  const p = r.progress;
  if (!p || !p.chunks) return 'Opening the sealed log and settling onchain…';
  if (p.sealed < p.chunks) return `Posting the last seals onchain (${p.sealed}/${p.chunks} chunks sealed)…`;
  if (p.opened < p.chunks) return `Opening the sealed log onchain: ${p.opened}/${p.chunks} chunks opened and checked by the contract…`;
  return `All ${p.chunks} chunks opened; settling the match…`;
}

function Results({ r, you, again, leave, account, watch, err }: { r: ResultsMsg; you: number; again: () => void; leave: () => void; account: string | null; watch: () => void; err: string }) {
  const won = r.winner === you;
  const e = r.expected;
  const pot = r.fee * r.seats.filter((s) => s.warden).length;
  const place = placements(r);
  const order = r.seats.map((_, i) => i).sort((a, b) => place[a] - place[b]);
  return (
    <div className="center card results">
      <small className="dim">You placed #{place[you]} of {r.seats.length} · {fmt(r.endTick)} played{r.bots && r.difficulty ? ` · Ashen Wardens on ${r.difficulty[0].toUpperCase()}${r.difficulty.slice(1)}` : ''}</small>
      <h2 className={won ? 'win' : 'lose'}>{won ? 'The last light is yours' : r.winner === null ? 'The dark took everyone' : `${r.seats[r.winner].name} carried the light`}</h2>
      <table className="tbl"><tbody>
        {order.map((i) => {
          const s = r.seats[i];
          return (
            <tr key={i} className={i === you ? 'me' : ''}>
              <td>#{place[i]}</td>
              <td><span className="dot" style={{ background: hex(CLOAKS[i % 6]) }} /> {s.name}</td>
              <td>{s.alive ? `alive · ${s.hp}♥` : `fell at ${fmt(s.fellAt)}`}</td>
              <td>◆ {s.embers}</td><td>{s.kills} felled</td>
              <td className="mint">{e.mints[i] ? `+${e.mints[i]} EMBER` : ''}{i === e.winner && e.prize ? ` +${e.prize} prize` : ''}</td>
            </tr>
          );
        })}
      </tbody></table>
      <p className="small">{r.ranked ? <>Pot {pot} EMBER: <b className="burn">{e.burned} burned</b> ({e.fallen} fell), <b className="mint">{e.prize}</b> to the winner. </> : 'Unranked match. '}
        Embers carried out by living Wardens become EMBER{account ? '' : ' (sign in to own a Warden that earns them)'}.</p>
      <p className="small">{!r.chain ? <span className="dim">Offline mode (CHAIN=0): nothing was written onchain.</span> : r.settled ? <b className="mint">✓ Opened and settled onchain: the contract rebuilt every seal.</b> : r.error ? <span className="err">Chain: {r.error}</span> : <span className="dim">{settling(r)}</span>}</p>
      {r.txs.length > 0 && <details><summary className="small">{r.txs.length} transactions</summary><ul className="txs">{r.txs.map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}</ul></details>}
      <p className="small dim">Proof: <a href={`/api/match/${r.matchId}`} target="_blank" rel="noreferrer">opened log (JSON)</a> · from a terminal: <code>pnpm verify {r.matchId}</code></p>
      {err && <p className="err small">{err}</p>}
      <div className="row mid"><button onClick={again}>Play again</button><button className="ghost" onClick={watch}>Watch the replay</button><button className="ghost" onClick={leave}>Back to the title</button></div>
    </div>
  );
}

// ---------- replay: the finished match, rebuilt in this browser from the opened log ----------

interface ReplayState {
  frames: { v: View; ev: SimEvent[] }[];
  /** seals rebuilt here, compared with the ones posted during the match */
  sealsOk: boolean;
  head: string;
  chainHead: string | null;
  chunks: number;
}

async function loadReplay(id: string, seat: number): Promise<ReplayState> {
  const b = (await (await fetch(`/api/match/${id}`)).json()) as { seed?: string; setup?: Setup; chunks: Opening[][]; seals: string[][]; contract: string };
  if (!b.seed || !b.setup) throw new Error('the log opens once the match is over');
  const rebuilt = b.chunks.map((seats, k) => seats.map((o, s) => sealOf(id, b.seed!, s, k, o)));
  const sealsOk = JSON.stringify(rebuilt) === JSON.stringify(b.seals);
  const head = foldHead(id, rebuilt);
  let chainHead: string | null = null;
  try {
    const res = await fetch('https://rpc.testnet.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: b.contract, method_name: 'get_match', args_base64: btoa(JSON.stringify({ match_id: id })) } }),
    });
    const j = (await res.json()) as { result?: { result: number[] } };
    if (j.result) chainHead = (JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as { head: string } | null)?.head ?? null;
  } catch { /* offline or blocked: the local check still stands */ }
  const log = logFromOpenings(b.chunks);
  const byTick = new Map<number, typeof log>();
  for (const e of log) byTick.set(e.t, [...(byTick.get(e.t) ?? []), e]);
  const s = createState(b.setup);
  const frames: ReplayState['frames'] = [];
  while (!s.over) {
    const given: (Input | null)[] = s.wardens.map(() => null);
    for (const e of byTick.get(s.tick) ?? []) given[e.c] = e.i;
    const { events } = step(s, given);
    frames.push({ v: viewFor(s, seat), ev: eventsFor(s, seat, events) });
  }
  return { frames, sealsOk, head, chainHead, chunks: Math.ceil(s.tick / CHUNK) };
}

function Replay({ r, world, start, close }: { r: ReplayState; world: World; start: StartMsg; close: () => void }) {
  const [k, setK] = useState(0);
  const [speed, setSpeed] = useState(2);
  useEffect(() => {
    world.startMatch(start.tiles, start.you, start.seats.map((s) => s.name), start.seats.map((s) => s.flame), maxHp(start.rules));
    world.setInput(0, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (k >= r.frames.length) return;
    const t = setTimeout(() => {
      // a few ticks per timer at higher speeds; events are kept, views are the latest
      const n = Math.max(1, Math.round(speed / 2));
      const ev: SimEvent[] = [];
      for (let j = 0; j < n && k + j < r.frames.length; j++) ev.push(...r.frames[k + j].ev);
      const last = Math.min(r.frames.length - 1, k + n - 1);
      world.update(r.frames[last].v, ev);
      setK(last + 1);
    }, (1000 / TICK_HZ / speed) * Math.max(1, Math.round(speed / 2)));
    return () => clearTimeout(t);
  }, [k, speed, r, world]);
  const f = r.frames[Math.min(k, r.frames.length - 1)];
  return (
    <div className="hud">
      <div className="hud-tc card">
        <b className="clock">REPLAY {fmt(f.v.tick)}</b>
        <span className="small dim">through your torch, rebuilt in this browser from the opened log</span>
      </div>
      <div className="replay-bar card small">
        <p>{r.sealsOk ? '✓' : '✗'} the opened log rebuilds all {r.chunks} chunks of seals
          {r.chainHead === null ? ' (couldn’t reach the chain from here)' : r.chainHead === r.head ? ' · ✓ it folds into the contract’s chain head' : ' · ✗ the contract’s chain head differs'}</p>
        <input type="range" min={0} max={r.frames.length - 1} value={Math.min(k, r.frames.length - 1)} onChange={(e) => setK(Number(e.target.value))} />
        <div className="row mid">
          {[1, 2, 4].map((x) => <button key={x} className={speed === x ? 'small' : 'ghost small'} onClick={() => setSpeed(x)}>{x}×</button>)}
          <button className="ghost small" onClick={() => setK(0)}>Restart</button>
          <button className="small" onClick={close}>Back to results</button>
        </div>
      </div>
    </div>
  );
}
