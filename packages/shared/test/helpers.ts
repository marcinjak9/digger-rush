import { T, Tile, World, newPod, type PodInput, type PodState } from '../src/index.js';

export const NONE: PodInput = { left: false, right: false, up: false, down: false };
export const DOWN: PodInput = { ...NONE, down: true };
export const LEFT: PodInput = { ...NONE, left: true };
export const RIGHT: PodInput = { ...NONE, right: true };
export const UP: PodInput = { ...NONE, up: true };

// A world whose rows 0..rows-1 are plain dirt across the whole width.
export function dirtWorld(rows = 70): World {
  const w = new World(T.SEED);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < T.WORLD_W; x++) w.set(x, y, Tile.DIRT);
  }
  w.dirty.clear();
  w.changes = [];
  return w;
}

export function carve(w: World, x0: number, y0: number, x1: number, y1: number, tile: number = Tile.EMPTY): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.set(x, y, tile);
  w.dirty.clear();
}

export function standingPod(x: number): PodState {
  const p = newPod(x, -T.podHalf);
  p.grounded = true;
  return p;
}
