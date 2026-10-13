import { T } from './tuning.js';
import { Tile } from './tiles.js';
import { anchorX, anchorY, rangeI, unit } from './hash.js';

const G = T.gen;

export interface TileAux {
  tile: number;
  aux: number;
}

export interface ChunkData {
  tiles: Uint8Array;
  aux: Uint8Array;
}

// Vein chance multiplier at a row: 1 until startM, steepFrac of the way to `mult` at steepM,
// linear to the full multiplier at fullM. Piecewise linear in metres.
export function rampMult(row: number, mult: number): number {
  const m = row * G.metersPerTile;
  const r = G.ramp;
  let frac: number;
  if (m <= r.startM) return 1;
  if (m <= r.steepM) frac = (r.steepFrac * (m - r.startM)) / (r.steepM - r.startM);
  else if (m < r.fullM) frac = r.steepFrac + ((1 - r.steepFrac) * (m - r.steepM)) / (r.fullM - r.steepM);
  else frac = 1;
  return 1 + (mult - 1) * frac;
}

type VeinDef = (typeof G.veins)[number];

// True when the vein anchored in coarse cell (cx, cy) of `v` covers tile (x, y).
// Pure function of (seed, vein, cell): never reads any chunk.
function veinCovers(seed: number, v: VeinDef, cx: number, cy: number, x: number, y: number): boolean {
  const salt = G.saltVeinBase + v.idx * G.saltVeinStride;
  const ay = anchorY(seed, cx, cy, salt, v.cellH);
  if (ay > y || ay < y - G.veinReach) return false;
  if (ay < v.minRow || (v.maxRow >= 0 && ay > v.maxRow)) return false;
  const ax = anchorX(seed, cx, cy, salt, v.cellW);
  if (ax < x - G.veinReach || ax > x + G.veinReach) return false;
  if (unit(seed, cx, cy, salt + 2) >= v.chance * rampMult(ay, v.mult)) return false;
  const size = rangeI(seed, cx, cy, salt + 3, G.veinSizeMin, G.veinSizeMax);
  const dxd = rangeI(seed, cx, cy, salt + 4, -1, 1);
  const side = rangeI(seed, cx, cy, salt + 5, 0, 1) === 1 ? 1 : -1;
  let px = ax;
  let py = ay;
  if (px === x && py === y) return true;
  for (let i = 0; i < size - 1; i++) {
    if (unit(seed, cx, cy, salt + 8 + i) < 0.7) {
      px += dxd;
      py += 1;
    } else {
      px += side;
    }
    if (px === x && py === y) return true;
  }
  return false;
}

function veinAt(seed: number, x: number, y: number): number {
  for (const v of G.veins) {
    const cx0 = Math.floor((x - G.veinReach) / v.cellW);
    const cx1 = Math.floor((x + G.veinReach) / v.cellW);
    const cy0 = Math.floor((y - G.veinReach) / v.cellH);
    const cy1 = Math.floor(y / v.cellH);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (veinCovers(seed, v, cx, cy, x, y)) return v.tile;
      }
    }
  }
  return 0;
}

// Pure per-tile generator: depends only on (seed, x, y).
export function tileAt(seed: number, x: number, y: number): TileAux {
  if (x < 0 || x >= T.WORLD_W) return { tile: Tile.BEDROCK, aux: 0 };
  if (y < 0) return { tile: Tile.EMPTY, aux: 0 };
  const s = G.salt;
  // Small air pockets (2x2 coarse cells)
  if (y >= G.airMinRow && unit(seed, x >> 1, y >> 1, s.air) < G.airChance) return { tile: Tile.EMPTY, aux: 0 };
  // Sand pockets with hidden ore
  if (y >= G.sandMinRow) {
    const cx = Math.floor(x / G.sandCellW);
    const cy = Math.floor(y / G.sandCellH);
    if (unit(seed, cx, cy, s.sandCell) < G.sandCellChance && unit(seed, x, y, s.sandFill) < G.sandFill) {
      let aux = 0;
      if (unit(seed, x, y, s.sandOre) < G.sandOre) {
        aux = y > G.sandOreGemRow ? Tile.GEM : y > G.sandOreGoldRow ? Tile.GOLD : Tile.COPPER;
      }
      return { tile: Tile.SAND, aux };
    }
  }
  // One roll, cumulative bands: lava, rock, else dirt
  const r = unit(seed, x, y, s.roll);
  let tile: number = Tile.DIRT;
  let acc = 0;
  if (y >= G.lavaMinRow) {
    const b = G.lavaBase + G.lavaSlope * y;
    acc += b < G.lavaMax ? b : G.lavaMax;
    if (r < acc) tile = Tile.LAVA;
  }
  if (tile === Tile.DIRT && y >= G.rockMinRow) {
    const b = G.rockBase + G.rockSlope * y;
    acc += b < G.rockMax ? b : G.rockMax;
    if (r < acc) tile = Tile.ROCK;
  }
  if (tile === Tile.DIRT || tile === Tile.ROCK) {
    const ore = veinAt(seed, x, y);
    if (ore !== 0) return { tile: ore, aux: 0 };
    if (y >= T.healMinRow && unit(seed, x, y, s.heal) < T.healP) return { tile: Tile.HEAL, aux: 0 };
  }
  return { tile, aux: 0 };
}

// Chunk (cx, cy) covers x in [16cx, 16cx+16), y in [16cy, 16cy+16), row-major.
export function generateChunk(seed: number, cx: number, cy: number): ChunkData {
  const n = T.CHUNK;
  const tiles = new Uint8Array(n * n);
  const aux = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const t = tileAt(seed, cx * n + c, cy * n + r);
      tiles[r * n + c] = t.tile;
      aux[r * n + c] = t.aux;
    }
  }
  const chunk = { tiles, aux };
  settleSand(chunk);
  return chunk;
}

// Sand generated over an air pocket drops now. Only inside the chunk's own columns,
// so chunks stay independent of their neighbours.
export function settleSand(chunk: ChunkData): void {
  const n = T.CHUNK;
  const { tiles, aux } = chunk;
  for (let x = 0; x < n; x++) {
    for (let r = n - 2; r >= 0; r--) {
      if (tiles[r * n + x] !== Tile.SAND) continue;
      let rr = r;
      while (rr + 1 < n && tiles[(rr + 1) * n + x] === Tile.EMPTY) {
        const a = rr * n + x;
        const b = (rr + 1) * n + x;
        tiles[b] = Tile.SAND;
        aux[b] = aux[a];
        tiles[a] = Tile.EMPTY;
        aux[a] = 0;
        rr++;
      }
    }
  }
}

// Pure helper for later server use: map a hashed choice to a heal respawn position
// in rows [rowLo, rowHi]. The caller checks the tile is dirt or rock before placing HEAL.
export function healRespawnPos(h: number, rowLo: number, rowHi: number): { x: number; y: number } {
  const lo = rowLo < T.healMinRow ? T.healMinRow : rowLo;
  const span = rowHi - lo + 1;
  return { x: (h >>> 0) % T.WORLD_W, y: lo + (((h >>> 8) >>> 0) % (span > 0 ? span : 1)) };
}

export function canHostHeal(tile: number, y: number): boolean {
  return y >= T.healMinRow && (tile === Tile.DIRT || tile === Tile.ROCK);
}
