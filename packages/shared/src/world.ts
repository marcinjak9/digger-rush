import { T } from './tuning.js';
import { Tile, isSolid } from './tiles.js';
import { generateChunk, tileAt } from './worldgen.js';

export interface TileChange {
  tick: number;
  x: number;
  y: number;
  tile: number;
  aux: number;
}

export class Chunk {
  readonly tiles: Uint8Array;
  readonly aux: Uint8Array;
  // Modified cells only: index -> tile | (aux << 8). Generated tiles are never sent.
  readonly diff = new Map<number, number>();

  constructor(tiles: Uint8Array, aux: Uint8Array) {
    this.tiles = tiles;
    this.aux = aux;
  }
}

export const DIRTY_STRIDE = 128; // x < 128

export function dirtyKey(x: number, y: number): number {
  return y * DIRTY_STRIDE + x;
}

export class World {
  readonly seed: number;
  readonly chunks = new Map<number, Chunk>();
  // Cells that may have lost support (the cell above a tile that stopped being solid).
  readonly dirty = new Set<number>();
  changes: TileChange[] = [];
  tick = 0;

  constructor(seed: number = T.SEED) {
    this.seed = seed;
  }

  chunkKey(cx: number, cy: number): number {
    return cy * T.CHUNKS_X + cx;
  }

  getChunk(cx: number, cy: number): Chunk {
    const k = this.chunkKey(cx, cy);
    let c = this.chunks.get(k);
    if (c === undefined) {
      const g = generateChunk(this.seed, cx, cy);
      c = new Chunk(g.tiles, g.aux);
      this.chunks.set(k, c);
      this.markBottomSand(c, cx, cy);
    }
    return c;
  }

  // Sand on the last row of a fresh chunk may hang over an empty cell of the chunk below.
  private markBottomSand(c: Chunk, cx: number, cy: number): void {
    const n = T.CHUNK;
    const y = cy * n + n - 1;
    for (let i = 0; i < n; i++) {
      if (c.tiles[(n - 1) * n + i] !== Tile.SAND) continue;
      const x = cx * n + i;
      if (tileAt(this.seed, x, y + 1).tile === Tile.EMPTY) this.dirty.add(dirtyKey(x, y));
    }
  }

  get(x: number, y: number): number {
    if (x < 0 || x >= T.WORLD_W) return Tile.BEDROCK;
    if (y < 0) return Tile.EMPTY;
    const c = this.getChunk(x >> 4, y >> 4);
    return c.tiles[(y & 15) * T.CHUNK + (x & 15)];
  }

  getAux(x: number, y: number): number {
    if (x < 0 || x >= T.WORLD_W || y < 0) return 0;
    const c = this.getChunk(x >> 4, y >> 4);
    return c.aux[(y & 15) * T.CHUNK + (x & 15)];
  }

  // Returns false (and does nothing) outside the playable area.
  set(x: number, y: number, tile: number, aux = 0): boolean {
    return this.write(x, y, tile, aux, true);
  }

  private write(x: number, y: number, tile: number, aux: number, record: boolean): boolean {
    if (x < 0 || x >= T.WORLD_W || y < 0) return false;
    const c = this.getChunk(x >> 4, y >> 4);
    const idx = (y & 15) * T.CHUNK + (x & 15);
    const was = c.tiles[idx];
    c.tiles[idx] = tile;
    c.aux[idx] = aux;
    c.diff.set(idx, tile | (aux << 8));
    if (isSolid(was) && !isSolid(tile) && y > 0) this.dirty.add(dirtyKey(x, y - 1));
    if (record) this.changes.push({ tick: this.tick, x, y, tile, aux });
    return true;
  }

  drainChanges(): TileChange[] {
    const out = this.changes;
    this.changes = [];
    return out;
  }

  // Client side: apply changes received from the server (not re-recorded).
  applyChanges(list: readonly TileChange[]): void {
    for (const ch of list) this.write(ch.x, ch.y, ch.tile, ch.aux, false);
  }

  // Modified cells of a chunk as [x, y, tile, aux] rows, ordered by index.
  chunkDiff(cx: number, cy: number): Array<[number, number, number, number]> {
    const c = this.chunks.get(this.chunkKey(cx, cy));
    if (c === undefined) return [];
    const out: Array<[number, number, number, number]> = [];
    const idxs = [...c.diff.keys()].sort((a, b) => a - b);
    for (const idx of idxs) {
      const v = c.diff.get(idx) as number;
      out.push([cx * T.CHUNK + (idx & 15), cy * T.CHUNK + (idx >> 4), v & 255, v >> 8]);
    }
    return out;
  }
}
