import { T } from './tuning.js';
import { Tile, TILES } from './tiles.js';
import { DIRTY_STRIDE, type World } from './world.js';

export interface SandPod {
  id: number;
  x: number;
  y: number;
}

export type SandEvent =
  | { kind: 'wobble'; tick: number; x: number; y: number }
  | { kind: 'fall'; tick: number; x: number; y: number }
  | { kind: 'land'; tick: number; x: number; y: number }
  | { kind: 'calm'; tick: number; x: number; y: number } // a wobble was cancelled (support returned or tile removed)
  | { kind: 'hit'; tick: number; x: number; y: number; podId: number; damage: number };

export interface SandBlock {
  x: number;
  y: number; // cell currently occupied (while falling: the cell the block is leaving from)
  tile: number;
  aux: number;
  t: number; // wobble ticks elapsed
  delay: number; // wobble ticks before it lets go
  falling: boolean;
  acc: number; // tenths of a tick spent travelling toward the next cell
  atBoundary: boolean; // needs a support check before moving on
}

function wobbleKey(x: number, y: number): number {
  return y * DIRTY_STRIDE + x;
}

export class SandSim {
  blocks: SandBlock[] = [];
  private wobbling = new Map<number, SandBlock>();

  isWobbling(x: number, y: number): boolean {
    return this.wobbling.has(wobbleKey(x, y));
  }

  // One 60 Hz tick. Driven by world.dirty, no world scan.
  step(world: World, tick: number, pods: readonly SandPod[]): SandEvent[] {
    const events: SandEvent[] = [];
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      const done = b.falling ? this.updateFalling(world, b, tick, pods, events) : this.updateWobble(world, b, tick, events);
      if (done) this.release(i);
    }
    if (world.dirty.size > 0) {
      const keys = [...world.dirty];
      world.dirty.clear();
      for (const k of keys) this.checkDirty(world, k, tick, events);
    }
    return events;
  }

  private checkDirty(world: World, k: number, tick: number, events: SandEvent[]): void {
    const x = k % DIRTY_STRIDE;
    const y = (k - x) / DIRTY_STRIDE;
    if (!TILES[world.get(x, y)].falls || this.wobbling.has(k)) return;
    if (world.get(x, y + 1) !== Tile.EMPTY) return;
    let n = 0;
    let yy = y;
    for (;;) {
      const tt = world.get(x, yy);
      const kk = wobbleKey(x, yy);
      if (!TILES[tt].falls || this.wobbling.has(kk)) break;
      const b: SandBlock = {
        x, y: yy, tile: tt, aux: 0, t: 0, delay: T.wobbleTicks + n * T.cascadeTicks,
        falling: false, acc: 0, atBoundary: true,
      };
      this.blocks.push(b);
      this.wobbling.set(kk, b);
      events.push({ kind: 'wobble', tick, x, y: yy });
      n++;
      yy--;
      if (yy < 0) break;
    }
  }

  private updateWobble(world: World, b: SandBlock, tick: number, events: SandEvent[]): boolean {
    if (!TILES[world.get(b.x, b.y)].falls) { events.push({ kind: 'calm', tick, x: b.x, y: b.y }); return true; } // dug out from under the wobble
    const below = world.get(b.x, b.y + 1);
    if (below !== Tile.EMPTY && !(TILES[below].falls && this.wobbling.has(wobbleKey(b.x, b.y + 1)))) { events.push({ kind: 'calm', tick, x: b.x, y: b.y }); return true; } // support is back
    b.t++;
    if (b.t >= b.delay) {
      b.aux = world.getAux(b.x, b.y);
      world.set(b.x, b.y, Tile.EMPTY);
      this.wobbling.delete(wobbleKey(b.x, b.y));
      b.falling = true;
      b.acc = 0;
      b.atBoundary = true;
      events.push({ kind: 'fall', tick, x: b.x, y: b.y });
    }
    return false;
  }

  private updateFalling(world: World, b: SandBlock, tick: number, pods: readonly SandPod[], events: SandEvent[]): boolean {
    if (b.atBoundary) {
      if (world.get(b.x, b.y + 1) !== Tile.EMPTY) return this.land(world, b, tick, pods, events);
      b.atBoundary = false;
    }
    b.acc += T.fallTickDeci;
    if (b.acc >= T.fallStepDeci) {
      b.y++;
      b.acc -= T.fallStepDeci;
      b.atBoundary = true;
      if (world.get(b.x, b.y + 1) !== Tile.EMPTY) return this.land(world, b, tick, pods, events);
      b.atBoundary = false;
    }
    const hit = this.overlappingPod(b, pods);
    if (hit !== null) {
      events.push({ kind: 'hit', tick, x: b.x + 0.5, y: b.y + b.acc / T.fallStepDeci, podId: hit.id, damage: T.sandHitDamage });
      return true;
    }
    return false;
  }

  private land(world: World, b: SandBlock, tick: number, pods: readonly SandPod[], events: SandEvent[]): boolean {
    const hit = this.overlappingPod(b, pods);
    if (hit !== null) {
      events.push({ kind: 'hit', tick, x: b.x + 0.5, y: b.y + 0.5, podId: hit.id, damage: T.sandHitDamage });
      return true;
    }
    world.set(b.x, b.y, b.tile, b.aux);
    events.push({ kind: 'land', tick, x: b.x, y: b.y });
    return true;
  }

  private overlappingPod(b: SandBlock, pods: readonly SandPod[]): SandPod | null {
    const inset = T.sandBoxInset;
    const bx0 = b.x + inset;
    const bx1 = b.x + 1 - inset;
    const by0 = b.y + b.acc / T.fallStepDeci + inset;
    const by1 = by0 + 1 - 2 * inset;
    const h = T.podHalf;
    for (const p of pods) {
      if (bx0 < p.x + h && bx1 > p.x - h && by0 < p.y + h && by1 > p.y - h) return p;
    }
    return null;
  }

  private release(i: number): void {
    const b = this.blocks[i];
    if (!b.falling) this.wobbling.delete(wobbleKey(b.x, b.y));
    const last = this.blocks.length - 1;
    this.blocks[i] = this.blocks[last];
    this.blocks.pop();
  }
}
