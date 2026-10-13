import { describe, expect, it } from 'vitest';
import { T, Tile, World, generateChunk, settleSand, tileAt, u32, unit, fmix32, healRespawnPos } from '../src/index.js';

// Independent reference of grid_hash.gd using BigInt (64-bit style arithmetic masked to 32 bits).
const M = 0xffffffffn;
function refFmix(h: bigint): bigint {
  h &= M;
  h = (h ^ (h >> 16n)) & M;
  h = (h * 0x85ebca6bn) & M;
  h = (h ^ (h >> 13n)) & M;
  h = (h * 0xc2b2ae35n) & M;
  return (h ^ (h >> 16n)) & M;
}
function refU32(seed: number, x: number, y: number, salt: number): number {
  let h = refFmix(BigInt(seed) ^ ((BigInt(salt) * 0x9e3779b1n) & M));
  h = refFmix(h ^ (BigInt(x) & M));
  return Number(refFmix(h ^ (BigInt(y) & M)));
}

// Goldens computed from the GDScript algorithm (grid_hash.gd), seed 1337: [x, y, salt, u32]
const GOLDEN: Array<[number, number, number, number]> = [
  [0, 0, 0, 638963220],
  [1, 2, 3, 2602992592],
  [5, 7, 4, 3689740011],
  [95, 1000, 2, 4202418159],
  [-1, 0, 4, 2204050415],
  [0, -1, 4, 3810671717],
  [-7, -13, 5, 1840810203],
  [-1, -1, 1005, 507704721],
  [123456, 654321, 1096, 1262709360],
];

describe('hash', () => {
  it('matches the golden values, including negative coordinates', () => {
    for (const [x, y, salt, want] of GOLDEN) expect(u32(1337, x, y, salt)).toBe(want);
  });
  it('matches the BigInt reference on a sweep incl. negatives', () => {
    for (let i = -40; i < 40; i++) {
      for (let j = -40; j < 40; j += 7) {
        expect(u32(1337, i, j, 4)).toBe(refU32(1337, i, j, 4));
        expect(u32(99, i * 977, j * 31, 1034)).toBe(refU32(99, i * 977, j * 31, 1034));
      }
    }
  });
  it('unit is in [0,1) and fmix32 is an unsigned 32-bit value', () => {
    for (let i = 0; i < 1000; i++) {
      const u = unit(1337, i, -i, 2);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(fmix32(i)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('world generation', () => {
  it('same seed gives identical chunks', () => {
    const a = new World(1337);
    const b = new World(1337);
    for (let cy = 0; cy < 8; cy++) {
      for (let cx = 0; cx < 6; cx++) {
        expect(a.getChunk(cx, cy).tiles).toEqual(b.getChunk(cx, cy).tiles);
        expect(a.getChunk(cx, cy).aux).toEqual(b.getChunk(cx, cy).aux);
      }
    }
  });

  it('a different seed gives a different world', () => {
    const a = generateChunk(1, 2, 5);
    const b = generateChunk(2, 2, 5);
    expect(a.tiles).not.toEqual(b.tiles);
  });

  it('chunk (2,5) alone equals the same region from a scrambled 3x3 neighbourhood', () => {
    const alone = generateChunk(1337, 2, 5);
    const order = [[3, 6], [1, 4], [2, 6], [2, 5], [1, 6], [3, 4], [2, 4], [1, 5], [3, 5]];
    let from: ReturnType<typeof generateChunk> | null = null;
    for (const [cx, cy] of order) {
      const c = generateChunk(1337, cx, cy);
      if (cx === 2 && cy === 5) from = c;
    }
    expect(from!.tiles).toEqual(alone.tiles);
    expect(from!.aux).toEqual(alone.aux);
    // and equals the pure per-tile generator plus an in-chunk sand settle
    const n = T.CHUNK;
    const tiles = new Uint8Array(n * n);
    const aux = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const t = tileAt(1337, 2 * n + c, 5 * n + r);
        tiles[r * n + c] = t.tile;
        aux[r * n + c] = t.aux;
      }
    }
    settleSand({ tiles, aux });
    expect(tiles).toEqual(alone.tiles);
  });

  it('side walls are bedrock and the sky is air', () => {
    const w = new World(1337);
    expect(w.get(-1, 5)).toBe(Tile.BEDROCK);
    expect(w.get(96, 5)).toBe(Tile.BEDROCK);
    expect(w.get(-1, -3)).toBe(Tile.BEDROCK);
    expect(w.get(10, -1)).toBe(Tile.EMPTY);
    expect(w.get(10, -500)).toBe(Tile.EMPTY);
    expect(w.get(10, 0)).toBe(Tile.DIRT);
    expect(w.set(10, -1, Tile.DIRT)).toBe(false);
    expect(w.set(-1, 3, Tile.EMPTY)).toBe(false);
  });

  it('respects depth gates', () => {
    let copperAbove2 = 0;
    let gemAbove50 = 0;
    let goldAbove25 = 0;
    let rockAbove2 = 0;
    let lavaAbove12 = 0;
    let healAbove6 = 0;
    let copper = 0, gold = 0, gem = 0, rock = 0, lava = 0, sand = 0, air = 0;
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < T.WORLD_W; x++) {
        const t = tileAt(1337, x, y).tile;
        if (t === Tile.COPPER) { copper++; if (y < 2) copperAbove2++; }
        if (t === Tile.GOLD) { gold++; if (y < 25) goldAbove25++; }
        if (t === Tile.GEM) { gem++; if (y < 50) gemAbove50++; }
        if (t === Tile.ROCK) { rock++; if (y < 2) rockAbove2++; }
        if (t === Tile.LAVA) { lava++; if (y < 12) lavaAbove12++; }
        if (t === Tile.HEAL && y < 6) healAbove6++;
        if (t === Tile.SAND) sand++;
        if (t === Tile.EMPTY) air++;
      }
    }
    expect(copperAbove2 + gemAbove50 + goldAbove25 + rockAbove2 + lavaAbove12 + healAbove6).toBe(0);
    for (const n of [copper, gold, gem, rock, lava, sand, air]) expect(n).toBeGreaterThan(50);
  });

  it('heal frequency is about 1 in 400 tiles and only replaces dirt or rock from row 6', () => {
    let heal = 0;
    let total = 0;
    for (let y = 0; y < 2000; y++) {
      for (let x = 0; x < T.WORLD_W; x++) {
        total++;
        if (tileAt(1337, x, y).tile === Tile.HEAL) heal++;
      }
    }
    const expected = total / T.healTargetDen;
    expect(heal).toBeGreaterThan(expected * 0.85);
    expect(heal).toBeLessThan(expected * 1.15);
  });

  it('heal respawn helper is pure and in range', () => {
    const a = healRespawnPos(u32(1, 2, 3, 4), 10, 200);
    const b = healRespawnPos(u32(1, 2, 3, 4), 10, 200);
    expect(a).toEqual(b);
    for (let i = 0; i < 200; i++) {
      const p = healRespawnPos(u32(7, i, 0, 9), 3, 50);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(T.WORLD_W);
      expect(p.y).toBeGreaterThanOrEqual(T.healMinRow);
      expect(p.y).toBeLessThanOrEqual(50);
    }
  });

  it('world records changes and diffs, and marks the cell above as dirty', () => {
    const w = new World(1337);
    w.tick = 7;
    expect(w.get(10, 1)).toBe(Tile.DIRT);
    w.set(10, 1, Tile.EMPTY);
    expect(w.dirty.has(0 * 128 + 10)).toBe(true);
    const ch = w.drainChanges();
    expect(ch).toEqual([{ tick: 7, x: 10, y: 1, tile: Tile.EMPTY, aux: 0 }]);
    expect(w.changes.length).toBe(0);
    expect(w.chunkDiff(0, 0)).toEqual([[10, 1, Tile.EMPTY, 0]]);
    const w2 = new World(1337);
    w2.applyChanges(ch);
    expect(w2.get(10, 1)).toBe(Tile.EMPTY);
    expect(w2.changes.length).toBe(0);
  });
});
