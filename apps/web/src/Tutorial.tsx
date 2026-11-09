import { useState } from 'react';

// The first-match walkthrough. Shown once (remembered in localStorage); "How to play" reopens it.

const STEPS: { title: string; body: string; art: string }[] = [
  { art: '🔥', title: 'Your torch is all you see', body: 'The arena is dark. You see the ruins by moonlight, but other Wardens and embers only inside your torch’s circle, and walls block it. Everyone else is just as blind: the server sends your browser nothing your torch doesn’t reveal.' },
  { art: '⚔', title: 'Move, swing, dash', body: 'WASD or the arrow keys to move. Space (or J) swings your torch at whatever is in front of you: one heart per hit. Shift (or K) dashes. On a phone: drag on the left half to move, tap Swing and Dash on the right.' },
  { art: '◆', title: 'Carry embers, but you will glow', body: 'Walk over embers to pick them up. Every ember you carry makes you visible from further away. A hit knocks one out of you; a Warden who falls spills them all.' },
  { art: '◯', title: 'The dark closes in', body: 'At 0:20 a ring of violet dark starts shrinking towards the centre. Outside it you lose a heart every second. Keep to the light.' },
  { art: '♛', title: 'How to win', body: 'Be the last Warden standing, or the living one carrying the most embers when the clock hits 3:00. Embers carried out by a signed-in Warden become EMBER in its purse.' },
  { art: '⛓', title: 'What happens onchain', body: 'Before the first tick, the hash of a secret seed goes onchain. Every 3 seconds, a sealed hash of each player’s moves and position. At the end the seed and the log are opened, and the NEAR contract checks every seal before it burns or pays any EMBER. Anyone can replay the match with pnpm verify. Guests never touch a wallet.' },
];

export function Tutorial({ done }: { done: () => void }) {
  const [k, setK] = useState(0);
  const s = STEPS[k];
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="How to play">
      <div className="card tut">
        <div className="tut-art">{s.art}</div>
        <small className="dim">{k + 1} / {STEPS.length}</small>
        <h2>{s.title}</h2>
        <p>{s.body}</p>
        <div className="dots">{STEPS.map((_, i) => <i key={i} className={i === k ? 'on' : ''} />)}</div>
        <div className="row mid">
          {k > 0 && <button className="ghost" onClick={() => setK(k - 1)}>Back</button>}
          {k < STEPS.length - 1 ? <button onClick={() => setK(k + 1)}>Next</button> : <button onClick={done}>Light my torch</button>}
          {k < STEPS.length - 1 && <button className="ghost small" onClick={done}>Skip</button>}
        </div>
      </div>
    </div>
  );
}
