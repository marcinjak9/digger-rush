import { T } from './tuning.js';
import { Tile } from './tiles.js';
import type { World } from './world.js';

export const RADAR_STRIDE = 3; // x, y, ore tile id

// Light radius in tiles around the pod for a depth row (client rendering).
export function lightRadius(row: number): number {
  const L = T.light;
  if (row <= L.nearRow) return L.nearRadius;
  if (row >= L.farRow) return L.farRadius;
  return L.nearRadius + ((L.farRadius - L.nearRadius) * (row - L.nearRow)) / (L.farRow - L.nearRow);
}

//
// Finds every ore tile (copper, gold, gem, heal, and ore hidden in sand via aux) within `radius`
// tiles of tile (cx, cy). Writes (x, y, tileId) triples into `out` (a preallocated Int32Array) and
// returns the number of ores found. Stops when `out` is full. Row-major order, deterministic.
// /
export function scanOre(world: World, cx: number, cy: number, radius: number, out: Int32Array): number {
  const cap = (out.length / RADAR_STRIDE) | 0;
  const r2 = radius * radius;
  const r = Math.ceil(radius);
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0) continue;
    const dy = y - cy;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= T.WORLD_W) continue;
      const dx = x - cx;
      if (dx * dx + dy * dy > r2) continue;
      let t = world.get(x, y);
      if (t === Tile.SAND) t = world.getAux(x, y);
      if (t === Tile.COPPER || t === Tile.GOLD || t === Tile.GEM || t === Tile.HEAL) {
        if (n >= cap) return n;
        const o = n * RADAR_STRIDE;
        out[o] = x;
        out[o + 1] = y;
        out[o + 2] = t;
        n++;
      }
    }
  }
  return n;
}
