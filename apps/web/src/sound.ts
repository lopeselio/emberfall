// Every sound is synthesised in WebAudio: nothing to download.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let drone: { stop: () => void; level: (v: number) => void } | null = null;
let muted = (() => { try { return localStorage.getItem('emberfall:muted') === '1'; } catch { return false; } })();

export const isMuted = (): boolean => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try { localStorage.setItem('emberfall:muted', m ? '1' : '0'); } catch { /* fine */ }
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.05);
}

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

function noise(c: AudioContext, dur: number): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource();
  s.buffer = buf;
  return s;
}

function env(c: AudioContext, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(master!);
  return g;
}

function tone(freq: number, type: OscillatorType, peak: number, decay: number, slideTo?: number, delay = 0): void {
  const c = ac();
  if (!c || muted) return;
  const o = c.createOscillator();
  o.type = type;
  const t = c.currentTime + delay;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + decay);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g);
  g.connect(master!);
  o.start(t);
  o.stop(t + decay + 0.05);
}

function whoosh(peak: number, from: number, to: number, dur: number): void {
  const c = ac();
  if (!c || muted) return;
  const n = noise(c, dur);
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.4;
  f.frequency.setValueAtTime(from, c.currentTime);
  f.frequency.exponentialRampToValueAtTime(to, c.currentTime + dur);
  n.connect(f);
  f.connect(env(c, peak, 0.02, dur));
  n.start();
}

export type Sfx = 'swing' | 'hit' | 'hurt' | 'pick' | 'dash' | 'fall' | 'burn' | 'beep' | 'go' | 'win' | 'lose' | 'heart' | 'click';

export function sfx(kind: Sfx, n = 0): void {
  const c = ac();
  if (!c || muted) return;
  switch (kind) {
    case 'swing': whoosh(0.35, 1800, 500, 0.16); break;
    case 'dash': whoosh(0.4, 400, 2400, 0.22); break;
    case 'hit': tone(140, 'square', 0.25, 0.12, 60); whoosh(0.3, 900, 300, 0.1); break;
    case 'hurt': tone(220, 'sawtooth', 0.22, 0.25, 70); break;
    case 'pick': tone(660 + Math.min(n, 12) * 45, 'triangle', 0.18, 0.18); tone(990 + Math.min(n, 12) * 60, 'sine', 0.1, 0.25, undefined, 0.05); break;
    case 'fall': tone(90, 'sine', 0.5, 0.9, 35); whoosh(0.35, 600, 120, 0.8); break;
    case 'burn': whoosh(0.25, 3000, 900, 0.25); tone(70, 'sine', 0.2, 0.3); break;
    case 'beep': tone(520, 'square', 0.12, 0.12); break;
    case 'go': tone(780, 'square', 0.16, 0.3); break;
    case 'win': [523, 659, 784, 1046].forEach((f, k) => tone(f, 'triangle', 0.2, 0.5, undefined, k * 0.12)); break;
    case 'lose': [392, 311, 233].forEach((f, k) => tone(f, 'triangle', 0.18, 0.6, undefined, k * 0.18)); break;
    case 'heart': tone(55, 'sine', 0.45, 0.16); tone(50, 'sine', 0.35, 0.16, undefined, 0.18); break;
    case 'click': tone(1200, 'square', 0.05, 0.04); break;
  }
}

/** A low wind-and-drone bed under the match; `level` rises as the dark closes. */
export function startDrone(): void {
  const c = ac();
  if (!c || drone) return;
  const g = c.createGain();
  g.gain.value = 0.0;
  g.connect(master!);
  const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = 55;
  const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 82.5;
  const lfo = c.createOscillator(); lfo.frequency.value = 0.13;
  const lg = c.createGain(); lg.gain.value = 3;
  lfo.connect(lg); lg.connect(o2.frequency);
  const n = noise(c, 4); n.loop = true;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
  const ng = c.createGain(); ng.gain.value = 0.35;
  n.connect(f); f.connect(ng); ng.connect(g);
  o1.connect(g); o2.connect(g);
  [o1, o2, lfo, n].forEach((s) => s.start());
  g.gain.setTargetAtTime(0.05, c.currentTime, 1.5);
  drone = {
    stop: () => { g.gain.setTargetAtTime(0, c.currentTime, 0.6); setTimeout(() => { [o1, o2, lfo, n].forEach((s) => { try { s.stop(); } catch { /* done */ } }); }, 2500); drone = null; },
    level: (v: number) => g.gain.setTargetAtTime(0.04 + v * 0.1, c.currentTime, 0.8),
  };
}
export const droneLevel = (v: number): void => drone?.level(v);
export const stopDrone = (): void => drone?.stop();
export const unlockAudio = (): void => { ac(); };
