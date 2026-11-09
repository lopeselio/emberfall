import { useEffect, useRef, useState } from 'react';
import { CENTER, DARK_START, DASH_CD, HP, SIZE, SWING_CD, TICK_HZ, TILE, VIEW, type View } from '@emberfall/rules';
import type { LineMsg, ResultsMsg, SnapMsg, StartMsg } from './api.ts';
import { CLOAKS, type World } from './scene.ts';
import { droneLevel, sfx, startDrone, stopDrone } from './sound.ts';

// The match screen: input (keyboard and touch), the HUD over the 3D arena, and the results.

interface Feed { id: number; text: string; at: number }
const fmt = (ticks: number): string => { const s = Math.max(0, Math.ceil(ticks / TICK_HZ)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const touchy = typeof window !== 'undefined' && (('ontouchstart' in window) || window.matchMedia?.('(pointer: coarse)').matches);

export function Match({ world, start, results, lines, send, subscribe, again, leave, account }: {
  world: World; start: StartMsg; results: ResultsMsg | null; lines: LineMsg[]; send: (m: unknown) => void;
  subscribe: (fn: (s: SnapMsg) => void) => void; again: () => void; leave: () => void; account: string | null;
}) {
  const [v, setV] = useState<View | null>(null);
  const [now, setNow] = useState(Date.now());
  const [feed, setFeed] = useState<Feed[]>([]);
  const mini = useRef<HTMLCanvasElement>(null);
  const names = start.seats.map((s) => s.name);
  const move = useRef({ mx: 0, mz: 0 });
  const lastBeat = useRef(0);

  useEffect(() => {
    world.startMatch(start.tiles, start.you, names, start.seats.map((s) => s.flame));
    document.title = 'Emberfall · in the dark';
    startDrone();
    let feedId = 0;
    world.onEvent = (e, mine) => {
      if (e.t === 'swing' && e.w === start.you) sfx('swing');
      if (e.t === 'dash' && e.w === start.you) sfx('dash');
      if (e.t === 'hit') sfx(e.w === start.you ? 'hurt' : mine ? 'hit' : 'hit');
      if (e.t === 'pick' && e.w === start.you) sfx('pick', 0);
      if (e.t === 'burn' && e.w === start.you) sfx('burn');
      if (e.t === 'fall') {
        sfx('fall');
        const text = e.by === -1 ? `${names[e.w]} was taken by the dark` : `${names[e.by]} felled ${names[e.w]}`;
        setFeed((f) => [...f.slice(-4), { id: feedId++, text, at: Date.now() }]);
      }
    };
    subscribe((s) => {
      world.update(s.v, s.ev);
      setV(s.v);
      droneLevel(Math.min(1, Math.max(0, (s.v.tick - DARK_START) / 2400)));
      const me = s.v.me;
      const d2 = (me.x - CENTER) ** 2 + (me.z - CENTER) ** 2;
      if (me.alive && (d2 > s.v.darkR ** 2 || me.hp <= 1) && Date.now() - lastBeat.current > 900) { lastBeat.current = Date.now(); sfx('heart'); }
      drawMini(mini.current, start, s.v);
    });
    const t = setInterval(() => setNow(Date.now()), 250);
    // countdown beeps
    const left = Math.ceil((start.startsAt - Date.now()) / 1000);
    const beeps = Array.from({ length: Math.max(0, left) }, (_, k) => setTimeout(() => sfx(k === left - 1 ? 'go' : 'beep'), Math.max(0, start.startsAt - Date.now() - (left - 1 - k) * 1000 - 1000)));
    return () => { clearInterval(t); beeps.forEach(clearTimeout); world.onEvent = null; stopDrone(); subscribe(() => undefined); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.matchId]);

  useEffect(() => { if (results) sfx(results.winner === start.you ? 'win' : 'lose'); }, [results?.matchId, results === null]);

  // keyboard
  useEffect(() => {
    const keys = new Set<string>();
    const push = (extra: { swing?: boolean; dash?: boolean } = {}): void => {
      const mx = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
      const mz = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
      if (mx !== move.current.mx || mz !== move.current.mz || extra.swing || extra.dash) {
        move.current = { mx, mz };
        send({ t: 'in', mx, mz, ...extra });
      }
    };
    const down = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if ([' ', 'j', 'enter'].includes(k)) { e.preventDefault(); if (!e.repeat) push({ swing: true }); return; }
      if (['shift', 'k', 'l'].includes(k)) { if (!e.repeat) push({ dash: true }); return; }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { e.preventDefault(); keys.add(k); push(); }
    };
    const up = (e: KeyboardEvent): void => { const k = e.key.toLowerCase(); if (keys.delete(k)) push(); };
    const blur = (): void => { keys.clear(); push(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [send]);

  const countdown = Math.ceil((start.startsAt - now) / 1000);
  const me = v?.me;
  const left = v ? start.maxTicks - v.tick : start.maxTicks;
  const darkIn = v ? DARK_START - v.tick : DARK_START;
  const outside = !!(me && me.alive && v && (me.x - CENTER) ** 2 + (me.z - CENTER) ** 2 > v.darkR ** 2);

  return (
    <div className="hud">
      <div className="hud-tl card">
        <div className="hearts">{Array.from({ length: HP }, (_, k) => <i key={k} className={me && k < me.hp ? 'on' : ''} />)}</div>
        <div className="embers">◆ <b>{me?.embers ?? 0}</b> <small>embers</small>{me?.kills ? <> · <b>{me.kills}</b> <small>felled</small></> : null}</div>
        <div className="dim small">{start.ranked ? `Ranked · ${start.fee} EMBER entry` : 'Unranked'} · {start.seats[start.you]?.warden ?? 'guest'}</div>
      </div>
      <div className="hud-tc card">
        <b className="clock">{fmt(left)}</b>
        <span className={darkIn > 0 ? 'dim' : 'darkword'}>{darkIn > 0 ? `the dark closes in ${fmt(darkIn)}` : outside ? 'YOU ARE IN THE DARK' : 'the dark is closing'}</span>
        <span className="dim small">{v?.alive ?? start.seats.length} Wardens burn</span>
      </div>
      <div className="feed">{feed.filter((f) => now - f.at < 7000).map((f) => <p key={f.id}>{f.text}</p>)}{lines.slice(-1).map((l, i) => <p key={`l${i}`} className="line">{l.who}: “{l.text}”{l.signed && <small> ✓ NEAR AI TEE</small>}</p>)}</div>
      <canvas ref={mini} className="minimap" width={150} height={150} />
      {!touchy && <div className="keys dim small">WASD move · Space swing · Shift dash · M sound</div>}
      {me && <Cooldowns me={me} />}
      {touchy && !results && <Touch send={send} move={move} />}
      {countdown > 0 && <div className="center big-count">{countdown}</div>}
      {outside && <div className="vignette" />}
      {me && !me.alive && !results && <div className="center card fell"><h2>You fell</h2><p className="dim">Your embers spill into the dark. The match goes on without you.</p><button className="ghost" onClick={leave}>Leave</button></div>}
      {results && <Results r={results} you={start.you} again={again} leave={leave} account={account} />}
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

function Touch({ send, move }: { send: (m: unknown) => void; move: React.MutableRefObject<{ mx: number; mz: number }> }) {
  const base = useRef<{ x: number; y: number; id: number } | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const set = (mx: number, mz: number): void => { if (mx !== move.current.mx || mz !== move.current.mz) { move.current = { mx, mz }; send({ t: 'in', mx, mz }); } };
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
          if (len < 14) { set(0, 0); return; }
          const a = Math.atan2(dy, dx);
          const oct = Math.round(a / (Math.PI / 4));
          const dirs: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
          const [mx, mz] = dirs[(oct + 8) % 8];
          set(mx, mz);
        }}
        onPointerUp={() => { base.current = null; setKnob(null); set(0, 0); }}
        onPointerCancel={() => { base.current = null; setKnob(null); set(0, 0); }}
      >
        {knob && <div className="stick" style={{ left: knob.x - 50, top: knob.y - 50 }}><i style={{ transform: `translate(${knob.dx}px, ${knob.dy}px)` }} /></div>}
      </div>
      <div className="tbtns">
        <button className="tbtn dash" onPointerDown={(e) => { e.preventDefault(); send({ t: 'in', ...move.current, dash: true }); }}>Dash</button>
        <button className="tbtn swing" onPointerDown={(e) => { e.preventDefault(); send({ t: 'in', ...move.current, swing: true }); }}>Swing</button>
      </div>
    </>
  );
}

let miniBg: { key: string; img: HTMLCanvasElement } | null = null;
function drawMini(cv: HTMLCanvasElement | null, start: StartMsg, v: View): void {
  if (!cv) return;
  const x = cv.getContext('2d')!;
  const S = cv.width / SIZE;
  if (!miniBg || miniBg.key !== start.matchId) {
    const img = document.createElement('canvas');
    img.width = img.height = cv.width;
    const g = img.getContext('2d')!;
    g.fillStyle = '#16141f'; g.fillRect(0, 0, img.width, img.height);
    start.tiles.forEach((t, i) => { if (t) { g.fillStyle = t === 1 ? '#5b5866' : t === 2 ? '#77737f' : t === 3 ? '#3b2a1f' : '#a0502a'; g.fillRect((i % SIZE) * S, Math.floor(i / SIZE) * S, S, S); } });
    miniBg = { key: start.matchId, img };
  }
  x.drawImage(miniBg.img, 0, 0);
  const u = (n: number): number => (n / TILE) * S;
  // the dark outside the ring
  x.save();
  x.beginPath(); x.rect(0, 0, cv.width, cv.height); x.arc(u(CENTER), u(CENTER), u(v.darkR), 0, Math.PI * 2, true);
  x.fillStyle = 'rgba(40,10,70,.7)'; x.fill('evenodd');
  x.restore();
  x.strokeStyle = '#a24bff'; x.lineWidth = 1.5; x.beginPath(); x.arc(u(CENTER), u(CENTER), u(v.darkR), 0, Math.PI * 2); x.stroke();
  // your torchlight (all you know)
  x.fillStyle = 'rgba(255,160,64,.12)'; x.beginPath(); x.arc(u(v.me.x), u(v.me.z), u(VIEW), 0, Math.PI * 2); x.fill();
  x.fillStyle = '#ffb347';
  for (const e of v.embers) x.fillRect(u(e.x) - 1, u(e.z) - 1, 2, 2);
  for (const o of v.others) { x.fillStyle = hex(CLOAKS[o.seat % 6]); x.fillRect(u(o.x) - 2.5, u(o.z) - 2.5, 5, 5); }
  x.fillStyle = '#fff'; x.fillRect(u(v.me.x) - 3, u(v.me.z) - 3, 6, 6);
}

function Results({ r, you, again, leave, account }: { r: ResultsMsg; you: number; again: () => void; leave: () => void; account: string | null }) {
  const won = r.winner === you;
  const e = r.expected;
  const pot = r.fee * r.seats.filter((s) => s.warden).length;
  return (
    <div className="center card results">
      <h2 className={won ? 'win' : 'lose'}>{won ? 'The last light is yours' : r.winner === null ? 'The dark took everyone' : `${r.seats[r.winner].name} carried the light`}</h2>
      <table className="tbl"><tbody>
        {r.seats.map((s, i) => (
          <tr key={i} className={i === you ? 'me' : ''}>
            <td><span className="dot" style={{ background: hex(CLOAKS[i % 6]) }} /> {s.name}</td>
            <td>{s.alive ? `alive · ${s.hp}♥` : `fell at ${fmt(s.fellAt)}`}</td>
            <td>◆ {s.embers}</td><td>{s.kills} felled</td>
            <td className="mint">{e.mints[i] ? `+${e.mints[i]} EMBER` : ''}{i === e.winner && e.prize ? ` +${e.prize} prize` : ''}</td>
          </tr>
        ))}
      </tbody></table>
      <p className="small">{r.ranked ? <>Pot {pot} EMBER: <b className="burn">{e.burned} burned</b> ({e.fallen} fell), <b className="mint">{e.prize}</b> to the winner. </> : 'Unranked match. '}
        Embers carried out by living Wardens become EMBER{account ? '' : ' (sign in to own a Warden that earns them)'}.</p>
      <p className="small">{r.settled ? <b className="mint">✓ Opened and settled onchain: the contract rebuilt every seal.</b> : r.error ? <span className="err">Chain: {r.error}</span> : <span className="dim">Opening the sealed log and settling onchain…</span>}</p>
      {r.txs.length > 0 && <details><summary className="small">{r.txs.length} transactions</summary><ul className="txs">{r.txs.map((t) => <li key={t.hash}><a href={t.url} target="_blank" rel="noreferrer">{t.what}</a></li>)}</ul></details>}
      <p className="small dim">Proof: <a href={`/api/match/${r.matchId}`} target="_blank" rel="noreferrer">opened log (JSON)</a> · replay it: <code>pnpm verify {r.matchId}</code></p>
      <div className="row mid"><button onClick={again}>Play again</button><button className="ghost" onClick={leave}>Back to the title</button></div>
    </div>
  );
}
