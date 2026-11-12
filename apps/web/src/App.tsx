import { useCallback, useEffect, useRef, useState } from 'react';
import { STYLE, api, explorerAccount, type AgentAct, type Difficulty, type BoardRow, type LineMsg, type MatchRow, type Me, type ResultsMsg, type RoomMsg, type ServerConfig, type ServerMsg, type SnapMsg, type StartMsg, type Supply } from './api.ts';
import { Match } from './Match.tsx';
import { Net, getDifficulty, getName, setDifficulty, setName, setTutorialDone, tutorialDone } from './net.ts';
import { World } from './scene.ts';
import { isMuted, setMuted, sfx, unlockAudio } from './sound.ts';
import { Tutorial } from './Tutorial.tsx';
import { call, setContract, signIn, signOut } from './wallet.ts';

// The shell: one three.js arena behind everything; title, room, match and results on top.

type Screen = 'title' | 'room' | 'match';

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [mute, setMute] = useState(isMuted());
  const [screen, setScreen] = useState<Screen>('title');
  const [room, setRoom] = useState<RoomMsg | null>(null);
  const [start, setStart] = useState<StartMsg | null>(null);
  const [results, setResults] = useState<ResultsMsg | null>(null);
  const [lines, setLines] = useState<LineMsg[]>([]);
  const [err, setErr] = useState('');
  const [tutorial, setTutorial] = useState<null | (() => void)>(null);
  const net = useRef<Net | null>(null);
  const snapSink = useRef<((s: SnapMsg) => void) | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const w = new World(host.current);
    setWorld(w);
    return () => { w.renderer.setAnimationLoop(null); w.renderer.domElement.remove(); };
  }, []);

  useEffect(() => {
    void api<ServerConfig>('/config').then((c) => { setCfg(c); setContract(c.contract); }).catch(() => undefined);
    void api<{ accountId: string } | null>('/me').then((m) => setAccount(m?.accountId ?? null)).catch(() => setAccount(null));
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') { const m = !isMuted(); setMuted(m); setMute(m); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const onMsg = useCallback((m: ServerMsg) => {
    switch (m.t) {
      case 'room':
        setRoom(m);
        if (m.phase === 'lobby') { setScreen('room'); setResults(null); setStart(null); }
        break;
      case 'start': setStart(m); setResults(null); setLines([]); setScreen('match'); break;
      case 'snap': snapSink.current?.(m); break;
      case 'line': setLines((l) => [...l, m]); break;
      case 'results': setResults(m); break;
      case 'error': setErr(m.msg); break;
      case 'kicked': setErr('The host removed you from the room.'); setScreen('title'); break;
    }
  }, []);

  const connect = useCallback((first: unknown) => {
    unlockAudio();
    setErr('');
    net.current?.close();
    const n = new Net(onMsg, () => { setErr('Lost the connection to the server.'); setScreen('title'); world?.toTitle(); });
    net.current = n;
    n.send({ t: 'hello', name: getName() || 'Warden' });
    n.send(first);
  }, [onMsg, world]);

  const leave = useCallback(() => {
    net.current?.send({ t: 'leave' });
    net.current?.close();
    net.current = null;
    setScreen('title'); setRoom(null); setStart(null); setResults(null);
    world?.toTitle();
  }, [world]);

  /** First time: the walkthrough, then the match. */
  const withTutorial = (go: () => void): void => {
    if (tutorialDone()) go();
    else setTutorial(() => () => { setTutorialDone(); go(); });
  };

  return (
    <>
      <div ref={host} className="world" />
      <header className="top">
        <a className="logo" href="/" onClick={(e) => { e.preventDefault(); if (screen !== 'match') leave(); }}>EMBERFALL</a>
        <span className="grow" />
        <button className="ghost small" onClick={() => setTutorial(() => () => setTutorialDone())} title="How to play" aria-label="How to play"><span className="wide">How to play</span><span className="narrow">?</span></button>
        <button className="ghost small sound" onClick={() => { const m = !mute; setMuted(m); setMute(m); }} title="Sound (M)">{mute ? '♪ off' : '♪ on'}</button>
        <AccountBox account={account} setAccount={setAccount} />
      </header>
      {err && <div className="banner err" onClick={() => setErr('')}>{err}</div>}
      {world && screen === 'title' && <Title cfg={cfg} account={account} play={(bots, difficulty) => withTutorial(() => connect({ t: 'quick', bots, difficulty }))} create={(difficulty) => connect({ t: 'create', difficulty })} join={(code) => withTutorial(() => connect({ t: 'join', code }))} />}
      {screen === 'room' && room && <Lobby room={room} send={(m) => net.current?.send(m)} leave={leave} />}
      {world && screen === 'match' && start && (
        <Match key={start.matchId} world={world} start={start} results={results} lines={lines} send={(m) => net.current?.send(m)}
          subscribe={(fn) => { snapSink.current = fn; }} again={() => net.current?.send({ t: 'again' })} leave={leave} account={account} />
      )}
      {tutorial && <Tutorial done={() => { const f = tutorial; setTutorial(null); f(); }} />}
    </>
  );
}

function AccountBox({ account, setAccount }: { account: string | null; setAccount: (a: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (account) {
    return (
      <span className="acct">
        <a href={explorerAccount(account)} target="_blank" rel="noreferrer">{account.length > 22 ? `${account.slice(0, 10)}…${account.slice(-8)}` : account}</a>
        <button className="ghost small" onClick={() => { void signOut().then(() => setAccount(null)); }}>Sign out</button>
      </span>
    );
  }
  return (
    <span className="acct">
      {err && <small className="err" title={err}>sign-in failed</small>}
      <button className="small" disabled={busy} onClick={() => {
        setBusy(true); setErr('');
        signIn().then(setAccount).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
      }}>{busy ? 'Waiting for wallet…' : 'Sign in with NEAR'}</button>
    </span>
  );
}

// ---------- title ----------

function Title({ cfg, account, play, create, join }: { cfg: ServerConfig | null; account: string | null; play: (bots: number, difficulty: Difficulty) => void; create: (difficulty: Difficulty) => void; join: (code: string) => void }) {
  const [name, setNameState] = useState(getName());
  const [bots, setBots] = useState(3);
  const [difficulty, setDiff] = useState<Difficulty>(getDifficulty());
  const pick = (d: Difficulty): void => { setDiff(d); setDifficulty(d); sfx('click'); };
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '');
  const [supply, setSupply] = useState<Supply | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  // only Wardens with something on their record: a fresh Warden (or a headless test account's) with no win and nothing carried out isn't a ranking
  const ranked = board.filter((r) => r.wins > 0 || r.embers_out > 0);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [acts, setActs] = useState<AgentAct[]>([]);
  const keep = (): void => setName(name.trim().slice(0, 20));

  useEffect(() => {
    document.title = 'Emberfall';
    const load = (): void => {
      void api<Supply | null>('/supply').then(setSupply).catch(() => undefined);
      void api<BoardRow[]>('/leaderboard').then(setBoard).catch(() => undefined);
      void api<MatchRow[]>('/matches').then(setMatches).catch(() => undefined);
      void api<AgentAct[]>('/agents').then(setActs).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="title">
      <div className="sparks" aria-hidden="true">{Array.from({ length: 22 }, (_, k) => <i key={k} style={{ left: `${(k * 47) % 100}%`, animationDuration: `${7 + (k % 5) * 2}s`, animationDelay: `${(k * 0.73) % 8}s` }} />)}</div>
      <section className="hero">
        <h1>EMBERFALL</h1>
        <div className="tag">a torchlit battle arena on NEAR</div>
        <p className="lede">A night battle in ruined voxel halls, for 2 to 6 Wardens. Last one standing wins.</p>
        <ul className="pillars">
          <li><span className="glyph torch" aria-hidden="true" /><b>Your torch is all you see</b><small>and everyone else is just as blind: the server never sends what your light doesn't reach</small></li>
          <li><span className="glyph ring" aria-hidden="true" /><b>The dark closes in</b><small>gather embers, fight with swing and dash, and stay inside the shrinking light</small></li>
          <li><span className="glyph seal" aria-hidden="true" /><b>Sealed onchain every 3 s</b><small>the contract rebuilds every seal before it pays out; anyone can replay the match</small></li>
        </ul>
        <label className="name">Your name <input value={name} maxLength={20} placeholder="Warden" onChange={(e) => setNameState(e.target.value)} onBlur={keep} /></label>
        <div className="row mid">
          <button className="big" onClick={() => { keep(); sfx('click'); play(bots, difficulty); }}>Fight the Ashen Wardens</button>
          <label className="dim small">rivals <select value={bots} onChange={(e) => setBots(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </div>
        <DifficultyPicker value={difficulty} onChange={pick} />
        <div className="row mid">
          <button className="ghost" onClick={() => { keep(); create(difficulty); }}>Create a room</button>
          <input className="code" value={code} maxLength={4} placeholder="CODE" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
          <button className="ghost" disabled={code.length !== 4} onClick={() => { keep(); join(code); }}>Join</button>
        </div>
        <p className="dim small">No wallet needed to play. {account ? '' : 'Sign in with NEAR to own a Warden: an NFT that keeps your EMBER, loot and record.'}</p>
      </section>

      <div className="grid">
        <WardenPanel account={account} />
        <section className="panel">
          <h2>EMBER supply</h2>
          {!supply ? <p className="dim">{cfg && !cfg.chain ? 'Offline mode (CHAIN=0): nothing is minted or burned.' : 'Loading…'}</p> : (
            <>
              <div className="stats">
                <div><b>{supply.total_supply}</b><small>in existence</small></div>
                <div><b className="mint">+{supply.minted}</b><small>ever minted</small></div>
                <div><b className="burn">−{supply.burned}</b><small>lost to the dark</small></div>
                <div><b>{supply.minted_today}/{supply.daily_cap}</b><small>minted today (cap)</small></div>
              </div>
              <p className="dim small">Embers carried out by living Wardens are minted (≤ {supply.match_cap} a match); 15% of the entry pot burns for every Warden that falls.</p>
              {supply.recent.length > 0 && <table className="tbl"><tbody>{supply.recent.slice(0, 6).map((r) => <tr key={r.match_id}><td><a href={`/api/match/${r.match_id}`} target="_blank" rel="noreferrer">{r.match_id.slice(2, 10)}</a></td><td>pot {r.pot}</td><td className="burn">−{r.burned}</td><td className="mint">+{r.minted}</td><td>{r.fallen} fell</td></tr>)}</tbody></table>}
            </>
          )}
        </section>
        <section className="panel">
          <h2>Wardens' ledger</h2>
          {ranked.length === 0 ? <p className="dim">No settled matches yet.</p> : (
            <table className="tbl"><tbody>{ranked.slice(0, 10).map((r, i) => <tr key={r.warden}><td>{i + 1}</td><td>{r.name}{r.name === 'E2E Warden' && <small className="dim"> · test run</small>}</td><td>{r.wins} W</td><td>{r.embers_out} carried out</td></tr>)}</tbody></table>
          )}
        </section>
        <section className="panel">
          <h2>The Ashen Wardens</h2>
          <p className="dim small">AI rivals with their own NEAR accounts (function-call keys only) and Wardens. They pay entry fees within caps the contract enforces, and burn their surplus as offerings to the dark. They see only their own torchlight, and react about as fast as a person. The difficulty you pick sets how well they all play; each keeps its style.</p>
          <ul className="bots">{(cfg?.bots ?? []).map((b) => <li key={b.label}><b>{b.name}</b> <small className={b.skill}>{STYLE[b.skill] ?? b.skill}</small> <a href={explorerAccount(b.account)} target="_blank" rel="noreferrer">{b.account}</a></li>)}</ul>
          {acts.slice(0, 4).map((a) => <p key={a.at} className="small dim">{a.who} {a.what} {a.url && <a href={a.url} target="_blank" rel="noreferrer">tx</a>}</p>)}
        </section>
        <section className="panel">
          <h2>Recent matches</h2>
          {matches.length === 0 ? <p className="dim">None yet.</p> : (
            <table className="tbl"><tbody>{matches.slice(0, 8).map((m) => <tr key={m.id}><td><a href={`/api/match/${m.id}`} target="_blank" rel="noreferrer">{m.id}</a></td><td>{m.winner !== null ? `${m.names[m.winner]} won` : 'nobody survived'}</td><td>{m.settled ? '✓ settled' : '…'}</td></tr>)}</tbody></table>
          )}
          <p className="dim small">Check one yourself: <code>pnpm verify &lt;matchId&gt;</code> replays it from the opened log and compares it with the contract.</p>
        </section>
        <section className="panel">
          <h2>How the fog is kept honest</h2>
          <ol className="small">
            <li><b>Seed.</b> The server commits the hash of a secret seed onchain before the first tick.</li>
            <li><b>Fog.</b> It runs the match and sends your browser only what your torch reveals.</li>
            <li><b>Seals.</b> Every 3 s it posts a hash of each player's inputs and position, salted from the seed.</li>
            <li><b>Open.</b> At the end the seed and the whole log are revealed; the contract rebuilds every seal before it pays anyone.</li>
          </ol>
          <p className="dim small">Contract {cfg ? <a href={explorerAccount(cfg.contract)} target="_blank" rel="noreferrer">{cfg.contract}</a> : '…'} on NEAR testnet.</p>
        </section>
      </div>
      <footer className="foot">Testnet only · procedural voxels and synthesised sound · part of the <a href="https://arcade.lopeselio.online/" target="_blank" rel="noreferrer">NEAR Arcade</a></footer>
    </main>
  );
}

function WardenPanel({ account }: { account: string | null }) {
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [name, setNm] = useState(getName() || 'Warden');
  const load = useCallback(() => { if (account) void api<Me | null>('/me').then(setMe).catch(() => setMe(null)); else setMe(null); }, [account]);
  useEffect(load, [load]);
  const act = async (what: string, method: string, args: object): Promise<void> => {
    setBusy(what); setErr('');
    try { await call(method, args); await new Promise((r) => setTimeout(r, 1500)); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  if (!account) {
    return (
      <section className="panel">
        <h2>Your Warden</h2>
        <p className="dim">Guests play at once. Sign in with a NEAR wallet (top right) to mint a <b>Warden</b>: an NFT that holds its own purse of EMBER, its loot and its record. Sell or give it away and all of that goes with it.</p>
      </section>
    );
  }
  if (!me?.warden || !me.raw) {
    return (
      <section className="panel">
        <h2>Your Warden</h2>
        <p className="dim">You don't have a Warden yet. Minting is free and gasless (our relayer pays); it starts with 30 EMBER.</p>
        <div className="row"><input value={name} maxLength={20} onChange={(e) => setNm(e.target.value.replace(/[^A-Za-z0-9 _.'-]/g, ''))} /><button disabled={!!busy || !name.trim()} onClick={() => void act('mint', 'mint_warden', { name: name.trim() })}>{busy ? 'Minting…' : 'Mint my Warden'}</button></div>
        {err && <p className="err small">{err}</p>}
      </section>
    );
  }
  const r = me.raw;
  return (
    <section className="panel warden">
      <h2>Your Warden</h2>
      <div className="row top">
        {me.token?.metadata.media && <img src={me.token.metadata.media} alt={me.token.metadata.title} />}
        <div>
          <b>{me.token?.metadata.title}</b>
          <p className="small">Purse <b className="mint">{r.purse} EMBER</b> · {r.record.matches} matches · {r.record.wins} wins · {r.record.kills} kills · {r.record.embers_out} embers carried out</p>
          <p className="small dim">Loot: {r.loot[0]} Cinder Crown, {r.loot[1]} Shade Fang, {r.loot[2]} Lantern Glass (your torch burns {r.loot[0] ? 'gold' : r.loot[2] ? 'white-blue' : r.loot[1] ? 'red' : 'orange'})</p>
          {r.approved_fee < 5
            ? <><p className="small">Allow a 5 EMBER entry fee to play <b>ranked</b>: the pot goes to the winner, part of it burns for each fall.</p><button className="small" disabled={!!busy} onClick={() => void act('approve', 'approve_fee', { warden: me.warden, max_fee: 5 })}>{busy ? 'Approving…' : 'Allow 5 EMBER entry fee'}</button></>
            : <p className="small dim">Ranked: entry fees up to {r.approved_fee} EMBER approved. <button className="ghost small" disabled={!!busy} onClick={() => void act('approve', 'approve_fee', { warden: me.warden, max_fee: 0 })}>Stop</button></p>}
          {err && <p className="err small">{err}</p>}
        </div>
      </div>
    </section>
  );
}

const DIFFS: { d: Difficulty; label: string; hint: string }[] = [
  { d: 'easy', label: 'Easy', hint: 'slow to react, wild swings: learn the arena' },
  { d: 'normal', label: 'Normal', hint: 'about as quick as you: a fair four-way fight' },
  { d: 'hard', label: 'Hard', hint: 'sharp, relentless rivals' },
];

/** Easy / Normal / Hard for every Ashen Warden in the match (remembered on this device). */
function DifficultyPicker({ value, onChange }: { value: Difficulty; onChange: (d: Difficulty) => void }) {
  return (
    <div className="difficulty">
      <div className="seg" role="radiogroup" aria-label="Ashen Warden difficulty">
        {DIFFS.map((x) => <button key={x.d} role="radio" aria-checked={value === x.d} className={`small ${value === x.d ? 'on' : 'ghost'}`} onClick={() => onChange(x.d)}>{x.label}</button>)}
      </div>
      <small className="dim">{DIFFS.find((x) => x.d === value)?.hint}</small>
    </div>
  );
}

// ---------- room ----------

function Lobby({ room, send, leave }: { room: RoomMsg; send: (m: unknown) => void; leave: () => void }) {
  const me = room.seats[room.you];
  const link = `${location.origin}/?room=${room.code}`;
  const [bot, setBot] = useState('');
  return (
    <main className="lobby">
      <section className="panel">
        <h2>Room <span className="roomcode">{room.code}</span></h2>
        <p className="dim small">Send the code or the link; up to 6 Wardens. Everyone presses Ready to start. {room.phase !== 'lobby' && <b>Starting…</b>}</p>
        <div className="row"><input readOnly value={link} onFocus={(e) => e.target.select()} /><button className="ghost small" onClick={() => void navigator.clipboard?.writeText(link)}>Copy</button></div>
        <ul className="seats">
          {room.seats.map((s, i) => (
            <li key={i} className={s.ready ? 'ready' : ''}>
              <span className="dot" style={{ background: ['#3f6fb5', '#b5423f', '#3fa566', '#c49a3a', '#8a4fc4', '#3fb0aa'][i] }} />
              <b>{s.name}</b>{i === room.you && ' (you)'} <small className="dim">{s.kind === 'bot' ? `Ashen Warden · ${STYLE[s.skill ?? ''] ?? s.skill}` : s.signedIn ? 'signed in' : 'guest'}</small>
              <span className="grow" />{s.ready ? '✓ ready' : 'waiting'}
              {room.host && i !== room.you && <button className="ghost small" onClick={() => send({ t: 'kick', seat: i })}>✕</button>}
            </li>
          ))}
        </ul>
        {room.host
          ? <DifficultyPicker value={room.difficulty} onChange={(d) => { setDifficulty(d); send({ t: 'difficulty', difficulty: d }); }} />
          : <p className="small dim">Ashen Wardens play on <b>{room.difficulty}</b> (the host picks).</p>}
        {room.host && room.seats.length < 6 && (
          <div className="row">
            <select value={bot} onChange={(e) => setBot(e.target.value)}><option value="">any rival</option>{room.bots.filter((b) => !room.seats.some((s) => s.name === b.name)).map((b) => <option key={b.label} value={b.label}>{b.name} ({STYLE[b.skill] ?? b.skill})</option>)}</select>
            <button className="ghost small" onClick={() => send({ t: 'addBot', label: bot || undefined })}>Add an Ashen Warden</button>
          </div>
        )}
        <div className="row">
          <button onClick={() => send({ t: 'ready', ready: !me?.ready })}>{me?.ready ? 'Not ready' : 'Ready'}</button>
          <button className="ghost" onClick={leave}>Leave</button>
        </div>
        {room.seats.length < 2 && <p className="dim small">A match needs at least two Wardens: add an Ashen Warden or wait for a friend.</p>}
      </section>
    </main>
  );
}
