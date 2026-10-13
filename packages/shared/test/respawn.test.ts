import { describe, expect, it } from 'vitest';
import {
  T, Tile, SandSim, World, createPlayer, newPlayer, newPod, newSimEvents, simTick, stepPlayerTick, stepWorldAfter,
  chunkKey, chunkCx, chunkCy, chunkRangeAround, sanitizeNickname, type PodInput,
} from '../src/index.js';
import { carve, dirtWorld } from './helpers.js';

const none = new Map<number, PodInput>();

describe('respawn state in shared', () => {
  it('dead pods are not stepped; respawn gives 3 s of invulnerability with no damage', () => {
    const w = dirtWorld();
    carve(w, 10, 5, 10, 60, Tile.LAVA);
    const sand = new SandSim();
    const pl = createPlayer(1, newPlayer(), w);
    pl.pod = newPod(10.5, 6);
    pl.stats.hull = 0;
    simTick(w, sand, [pl], none, 1);
    expect(pl.deadTicks).toBeGreaterThan(0);
    const y = pl.pod.y;
    for (let t = 2; t < T.respawnTicks; t++) simTick(w, sand, [pl], none, t);
    expect(pl.pod.y).toBe(y); // frozen where it died
    const ev = simTick(w, sand, [pl], none, T.respawnTicks);
    expect(ev.respawns).toEqual([1]);
    expect(pl.invulnTicks).toBe(T.invulnTicks);
    // put it into lava while invulnerable: no damage
    pl.pod = newPod(10.5, 6);
    const hull = pl.stats.hull;
    for (let t = 1; t <= 60; t++) simTick(w, sand, [pl], none, T.respawnTicks + t);
    expect(pl.stats.hull).toBe(hull);
    expect(pl.invulnTicks).toBe(T.invulnTicks - 60);
    // after the window ends the lava hurts again
    for (let t = 61; t <= T.invulnTicks + 60; t++) simTick(w, sand, [pl], none, T.respawnTicks + t);
    expect(pl.invulnTicks).toBe(0);
    pl.pod = newPod(10.5, 6);
    simTick(w, sand, [pl], none, 1000);
    expect(pl.stats.hull).toBeLessThan(hull);
  });

  it('stepPlayerTick + stepWorldAfter compose to simTick', () => {
    const w1 = new World(T.SEED);
    const w2 = new World(T.SEED);
    const a = createPlayer(1, newPlayer(), w1);
    const b = createPlayer(1, newPlayer(), w2);
    const sa = new SandSim();
    const sb = new SandSim();
    const inp = new Map<number, PodInput>([[1, { left: false, right: false, up: false, down: true }]]);
    for (let t = 1; t <= 200; t++) {
      simTick(w1, sa, [a], inp, t);
      const out = newSimEvents();
      stepPlayerTick(w2, b, inp.get(1)!, out);
      stepWorldAfter(w2, sb, [b], t, out);
    }
    expect(b.pod).toEqual(a.pod);
    expect(b.stats).toEqual(a.stats);
  });
});

describe('net helpers', () => {
  it('chunk keys and ranges', () => {
    expect(chunkKey(2, 3)).toBe(3 * T.CHUNKS_X + 2);
    expect(chunkCx(chunkKey(5, 9))).toBe(5);
    expect(chunkCy(chunkKey(5, 9))).toBe(9);
    const r = chunkRangeAround(50, -4, 2);
    expect(r).toEqual({ cx0: 1, cx1: 5, cy0: 0, cy1: 1 });
    const r2 = chunkRangeAround(3, 100, 2);
    expect(r2).toEqual({ cx0: 0, cx1: 2, cy0: 4, cy1: 8 });
  });
  it('shared nickname validation', () => {
    expect(sanitizeNickname('  Bo\u0007b ')).toEqual({ ok: true, name: 'Bob' });
    expect(sanitizeNickname(42).ok).toBe(false);
    expect(sanitizeNickname('h1tler').ok).toBe(false);
  });
});
