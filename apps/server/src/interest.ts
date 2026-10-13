import { T, chunkKey, chunkRangeAround, type ChunkRange, type World } from '@digger/shared';

// Per player interest state. `subs` is the set of chunk keys the player receives deltas for.
export interface InterestState {
  subs: Set<number>;
  cx: number; // chunk coords the subscription was computed for (NaN = never)
  cy: number;
}

// chunk key -> subscribed players (reverse index used to route deltas without scanning anyone).
export class InterestIndex<P extends InterestState> {
  private readonly byKey = new Map<number, P[]>();

  add(key: number, p: P): void {
    let l = this.byKey.get(key);
    if (l === undefined) {
      l = [];
      this.byKey.set(key, l);
    }
    l.push(p);
  }

  remove(key: number, p: P): void {
    const l = this.byKey.get(key);
    if (l === undefined) return;
    const i = l.indexOf(p);
    if (i < 0) return;
    l[i] = l[l.length - 1];
    l.pop();
    if (l.length === 0) this.byKey.delete(key);
  }

  get(key: number): readonly P[] | undefined {
    return this.byKey.get(key);
  }

  has(key: number): boolean {
    return this.byKey.has(key);
  }

  keys(): IterableIterator<number> {
    return this.byKey.keys();
  }

  get size(): number {
    return this.byKey.size;
  }
}

const rangeScratch: ChunkRange = { cx0: 0, cx1: 0, cy0: 0, cy1: 0 };

// Recomputes the player's subscription only when the pod's chunk changed (or `force`).
// Calls `onAdd` / `onRemove` for each key that changes. Returns true when anything was recomputed.
export function updateSubscription<P extends InterestState>(
  idx: InterestIndex<P>,
  p: P,
  x: number,
  y: number,
  force: boolean,
  onAdd: (key: number) => void,
  onRemove: (key: number) => void,
): boolean {
  const cx = Math.floor(x / T.CHUNK);
  const cy = Math.floor(y / T.CHUNK);
  if (!force && cx === p.cx && cy === p.cy) return false;
  p.cx = cx;
  p.cy = cy;
  const r = chunkRangeAround(x, y, T.net.interestChunkRadius, rangeScratch);
  // removals: subscribed keys outside the new range
  for (const key of p.subs) {
    const kx = key % T.CHUNKS_X;
    const ky = (key - kx) / T.CHUNKS_X;
    if (kx < r.cx0 || kx > r.cx1 || ky < r.cy0 || ky > r.cy1) {
      p.subs.delete(key);
      idx.remove(key, p);
      onRemove(key);
    }
  }
  for (let ky = r.cy0; ky <= r.cy1; ky++) {
    for (let kx = r.cx0; kx <= r.cx1; kx++) {
      const key = chunkKey(kx, ky);
      if (p.subs.has(key)) continue;
      p.subs.add(key);
      idx.add(key, p);
      onAdd(key);
    }
  }
  return true;
}

export function dropSubscription<P extends InterestState>(idx: InterestIndex<P>, p: P): void {
  for (const key of p.subs) idx.remove(key, p);
  p.subs.clear();
  p.cx = NaN;
  p.cy = NaN;
}

// Modified cells of a chunk as flat [idx, tile | aux << 8, ...]; empty when the chunk is pristine.
export function chunkDiffFlat(world: World, key: number): number[] {
  const out: number[] = [];
  const c = world.chunks.get(key);
  if (c === undefined) return out;
  for (const [idx, v] of c.diff) out.push(idx, v);
  return out;
}

// Drops chunks that were never modified and that nobody is subscribed to. Diffs are always kept.
export function evictFarChunks<P extends InterestState>(world: World, idx: InterestIndex<P>): number {
  let n = 0;
  for (const [key, c] of world.chunks) {
    if (c.diff.size === 0 && !idx.has(key)) {
      world.chunks.delete(key);
      n++;
    }
  }
  return n;
}
