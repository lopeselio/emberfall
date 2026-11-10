import type { Difficulty, ServerMsg } from './api.ts';

// One WebSocket to the room server. Messages are queued until it opens.

export class Net {
  private ws: WebSocket;
  private queue: string[] = [];
  closed = false;
  constructor(onMsg: (m: ServerMsg) => void, onClose: () => void) {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => { for (const q of this.queue) this.ws.send(q); this.queue = []; };
    this.ws.onmessage = (e) => { try { onMsg(JSON.parse(String(e.data)) as ServerMsg); } catch { /* ignore */ } };
    this.ws.onclose = () => { if (!this.closed) onClose(); this.closed = true; };
  }
  send(m: unknown): void {
    const s = JSON.stringify(m);
    if (this.ws.readyState === 1) this.ws.send(s); else this.queue.push(s);
  }
  close(): void { this.closed = true; this.ws.close(); }
}

const NAME = 'emberfall:name';
export function getName(): string { try { return localStorage.getItem(NAME) ?? ''; } catch { return ''; } }
export function setName(n: string): void { try { localStorage.setItem(NAME, n); } catch { /* fine */ } }
const TUT = 'emberfall:walkthrough-done';
export function tutorialDone(): boolean { try { return localStorage.getItem(TUT) === '1'; } catch { return false; } }
export function setTutorialDone(): void { try { localStorage.setItem(TUT, '1'); } catch { /* fine */ } }
const DIFF = 'emberfall:difficulty';
export function getDifficulty(): Difficulty {
  try { const d = localStorage.getItem(DIFF); return d === 'easy' || d === 'hard' ? d : 'normal'; } catch { return 'normal'; }
}
export function setDifficulty(d: Difficulty): void { try { localStorage.setItem(DIFF, d); } catch { /* fine */ } }
