import { T, Tile, u32, type PodState, type World } from '@digger/shared';

interface ChunkRec {
  counter: number; // attempts made in this chunk (feeds the hash, so the sequence is deterministic)
  tiles: number[]; // in-chunk indices of respawned heal tiles that may still be alive
}

// Slowly puts heal ore back into chunks that are generated, loaded and near players. One chunk per
// attempt (round robin over a small ring), so the cost never depends on the world size. The tile is
// chosen by hash(seed, chunk, counter), only DIRT/ROCK is replaced, and never within the safe radius of
// any pod, so nothing pops in view. The change goes through World.set and thus the normal tile delta path.
export class HealSpawner {
  private readonly state = new Map<number, ChunkRec>();
  private ring: number[] = [];
  private cursor = 0;
  spawned = 0;

  constructor(private readonly world: World) {}

  // Replaces the ring with the loaded chunks among `keys` (ascending, so the order is deterministic).
  rebuild(keys: Iterable<number>): void {
    const r: number[] = [];
    for (const k of keys) if (this.world.chunks.has(k)) r.push(k);
    r.sort((a, b) => a - b);
    this.ring = r;
    if (this.cursor >= r.length) this.cursor = 0;
  }

  // Heal tiles this spawner placed in a chunk and that are still there.
  aliveIn(key: number): number {
    const rec = this.state.get(key);
    return rec === undefined ? 0 : this.prune(key, rec);
  }

  private prune(key: number, rec: ChunkRec): number {
    const c = this.world.chunks.get(key);
    let n = 0;
    for (let i = 0; i < rec.tiles.length; i++) {
      if (c !== undefined && c.tiles[rec.tiles[i]] === Tile.HEAL) rec.tiles[n++] = rec.tiles[i];
    }
    rec.tiles.length = n;
    return n;
  }

  // One attempt on the next chunk of the ring. Returns true when a tile was placed.
  attempt(pods: Iterable<PodState>): boolean {
    const ring = this.ring;
    if (ring.length === 0) return false;
    const key = ring[this.cursor % ring.length];
    this.cursor = (this.cursor + 1) % ring.length;
    const chunk = this.world.chunks.get(key);
    if (chunk === undefined) return false;
    let rec = this.state.get(key);
    if (rec === undefined) {
      rec = { counter: 0, tiles: [] };
      this.state.set(key, rec);
    }
    const cfg = T.healRespawn;
    if (this.prune(key, rec) >= cfg.capPerChunk) return false;
    const counter = rec.counter++;
    const h = u32(this.world.seed, key, counter, cfg.salt);
    const idx = h & (T.CHUNK * T.CHUNK - 1);
    const t = chunk.tiles[idx];
    if (t !== Tile.DIRT && t !== Tile.ROCK) return false;
    const x = (key % T.CHUNKS_X) * T.CHUNK + (idx & (T.CHUNK - 1));
    const y = Math.floor(key / T.CHUNKS_X) * T.CHUNK + (idx >> 4);
    if (y < T.healMinRow) return false;
    const r = cfg.safeRadius;
    for (const p of pods) {
      const dx = x + 0.5 - p.x;
      const dy = y + 0.5 - p.y;
      if (dx <= r && dx >= -r && dy <= r && dy >= -r) return false;
    }
    this.world.set(x, y, Tile.HEAL, 0);
    rec.tiles.push(idx);
    this.spawned++;
    return true;
  }
}
