import { int, rngFrom, type Rng } from './rng.ts';

// The arena: 40×40 tiles of moonlit ruins, generated from the match seed. Positions in the sim are
// integers in units (1 tile = 100 units), so every machine computes the same thing.

export const TILE = 100;
export const SIZE = 40;
/** The centre of the arena and of the closing dark, in units. */
export const CENTER = (SIZE * TILE) / 2;

export const FLOOR = 0;
export const WALL = 1;
export const PILLAR = 2;
export const TREE = 3;
export const BRAZIER = 4;
export type Tile = typeof FLOOR | typeof WALL | typeof PILLAR | typeof TREE | typeof BRAZIER;

export interface Arena {
  /** row-major, index = tz * SIZE + tx */
  tiles: Tile[];
  /** six spawn points (units), one per seat */
  spawns: { x: number; z: number }[];
}

// a hexagon of spawn points around the centre, in tiles (no trigonometry: fixed offsets)
const SPAWN_OFFSETS: [number, number][] = [[13, 0], [-13, 0], [7, 11], [-7, -11], [-7, 11], [7, -11]];

export const tileAt = (a: Arena, tx: number, tz: number): Tile =>
  tx < 0 || tz < 0 || tx >= SIZE || tz >= SIZE ? WALL : a.tiles[tz * SIZE + tx];

/** Walls, pillars, trees and braziers stop a Warden. */
export const blocksMove = (t: Tile): boolean => t !== FLOOR;
/** Walls and pillars stop a torch's light; trees and braziers don't. */
export const blocksSight = (t: Tile): boolean => t === WALL || t === PILLAR;

export const unitToTile = (u: number): number => Math.floor(u / TILE);

export function makeArena(seed: string): Arena {
  const r = rngFrom(`emberfall|arena|${seed}`);
  const tiles: Tile[] = new Array(SIZE * SIZE).fill(FLOOR);
  const set = (x: number, z: number, t: Tile): void => { if (x >= 0 && z >= 0 && x < SIZE && z < SIZE) tiles[z * SIZE + x] = t; };
  const get = (x: number, z: number): Tile => tiles[z * SIZE + x];
  const c = SIZE / 2;

  // the outer wall
  for (let i = 0; i < SIZE; i++) { set(i, 0, WALL); set(i, SIZE - 1, WALL); set(0, i, WALL); set(SIZE - 1, i, WALL); }

  // keep the centre plaza and the spawn pads clear
  const reserved = (x: number, z: number): boolean => {
    if ((x - c) * (x - c) + (z - c) * (z - c) <= 9) return true;
    return SPAWN_OFFSETS.some(([dx, dz]) => Math.abs(x - (c + dx)) <= 2 && Math.abs(z - (c + dz)) <= 2);
  };
  const free = (x: number, z: number): boolean => x > 1 && z > 1 && x < SIZE - 2 && z < SIZE - 2 && !reserved(x, z) && get(x, z) === FLOOR;

  // broken wall runs
  for (let k = 0; k < 18; k++) {
    const x = int(r, 3, SIZE - 4), z = int(r, 3, SIZE - 4);
    const len = int(r, 2, 5);
    const horiz = int(r, 0, 1) === 0;
    for (let i = 0; i < len; i++) {
      const tx = horiz ? x + i : x, tz = horiz ? z : z + i;
      if (free(tx, tz) && int(r, 0, 9) > 0) set(tx, tz, WALL);
    }
  }
  // an L-shaped ruin in each quadrant
  for (const [qx, qz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const ox = c + qx * int(r, 6, 9), oz = c + qz * int(r, 6, 9);
    for (let i = 0; i < 4; i++) { if (free(ox + qx * i, oz)) set(ox + qx * i, oz, WALL); if (free(ox, oz + qz * i)) set(ox, oz + qz * i, WALL); }
  }
  scatter(r, 16, PILLAR, free, set);
  scatter(r, 18, TREE, free, set);
  // four braziers around the plaza, cold until the dark comes
  for (const [dx, dz] of [[4, 4], [-4, 4], [4, -4], [-4, -4]]) set(c + dx, c + dz, BRAZIER);

  const spawns = SPAWN_OFFSETS.map(([dx, dz]) => ({ x: (c + dx) * TILE + TILE / 2, z: (c + dz) * TILE + TILE / 2 }));
  return { tiles, spawns };
}

function scatter(r: Rng, n: number, t: Tile, free: (x: number, z: number) => boolean, set: (x: number, z: number, t: Tile) => void): void {
  for (let k = 0, tries = 0; k < n && tries < n * 20; tries++) {
    const x = int(r, 2, SIZE - 3), z = int(r, 2, SIZE - 3);
    if (!free(x, z)) continue;
    set(x, z, t);
    k++;
  }
}

/** Would a Warden (a square of ±radius units) at (x, z) overlap a blocking tile? */
export function blocked(a: Arena, x: number, z: number, radius: number): boolean {
  const x0 = unitToTile(x - radius), x1 = unitToTile(x + radius);
  const z0 = unitToTile(z - radius), z1 = unitToTile(z + radius);
  for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) if (blocksMove(tileAt(a, tx, tz))) return true;
  return false;
}

/** Is the straight line between two points clear of walls and pillars? Integer steps, no trigonometry. */
export function lineOfSight(a: Arena, x0: number, z0: number, x1: number, z1: number): boolean {
  const dx = x1 - x0, dz = z1 - z0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 40);
  for (let k = 1; k < steps; k++) {
    const px = x0 + Math.trunc((dx * k) / steps), pz = z0 + Math.trunc((dz * k) / steps);
    if (blocksSight(tileAt(a, unitToTile(px), unitToTile(pz)))) return false;
  }
  return true;
}
