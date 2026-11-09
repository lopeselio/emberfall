// Small seeded PRNG (mulberry32) with integer outputs. Its state is one uint32, so it lives inside the
// sim state and a replay draws exactly the same numbers. Nothing here touches Math.random.

export interface Rng { s: number }

/** FNV-1a 32-bit hash of a string, used to seed a generator from text. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const rngFrom = (text: string): Rng => ({ s: seedFrom(text) });

/** Next uint32. */
export function nextU32(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Integer in [lo, hi] inclusive. */
export const int = (r: Rng, lo: number, hi: number): number => lo + (nextU32(r) % (hi - lo + 1));
/** True with probability pct/100. */
export const chance = (r: Rng, pct: number): boolean => nextU32(r) % 100 < pct;
