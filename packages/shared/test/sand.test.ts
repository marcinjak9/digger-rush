import { describe, expect, it } from 'vitest';
import { SandSim, T, Tile, type SandEvent } from '../src/index.js';
import { carve, dirtWorld } from './helpers.js';

function ticks(from: number, to: number, w: ReturnType<typeof dirtWorld>, s: SandSim, pods: Array<{ id: number; x: number; y: number }> = []): SandEvent[] {
  const out: SandEvent[] = [];
  for (let t = from; t <= to; t++) out.push(...s.step(w, t, pods));
  return out;
}

function sandColumn(): ReturnType<typeof dirtWorld> {
  const w = dirtWorld();
  carve(w, 20, 5, 20, 7, Tile.SAND);
  return w;
}

describe('sand', () => {
  it('wobbles 24 ticks, then cascades 6 ticks per block, bottom first', () => {
    const w = sandColumn();
    const s = new SandSim();
    w.set(20, 8, Tile.EMPTY);
    const ev = ticks(100, 200, w, s);
    const wob = ev.filter((e) => e.kind === 'wobble');
    const fall = ev.filter((e) => e.kind === 'fall');
    expect(wob.map((e) => e.tick)).toEqual([100, 100, 100]);
    expect(fall.map((e) => [e.y, e.tick - 100])).toEqual([
      [7, T.wobbleTicks],
      [6, T.wobbleTicks + T.cascadeTicks],
      [5, T.wobbleTicks + 2 * T.cascadeTicks],
    ]);
  });

  it('falls one cell per 5.4 ticks on average and lands keeping aux', () => {
    const w = dirtWorld();
    carve(w, 30, 5, 30, 5, Tile.SAND);
    w.set(30, 5, Tile.SAND, Tile.GOLD);
    carve(w, 30, 7, 30, 59);
    const s = new SandSim();
    w.set(30, 6, Tile.EMPTY);
    const ev = ticks(1, 1000, w, s);
    const fall = ev.find((e) => e.kind === 'fall')!;
    const land = ev.find((e) => e.kind === 'land')!;
    expect(land.y).toBe(59);
    const cells = 59 - 5;
    const avg = (land.tick - fall.tick) / cells;
    expect(avg).toBeGreaterThan(5.3);
    expect(avg).toBeLessThan(5.5);
    expect(w.get(30, 59)).toBe(Tile.SAND);
    expect(w.getAux(30, 59)).toBe(Tile.GOLD);
    expect(w.get(30, 5)).toBe(Tile.EMPTY);
  });

  it('a falling block hits a pod for 18 and is removed', () => {
    const w = dirtWorld();
    carve(w, 30, 5, 30, 5, Tile.SAND);
    carve(w, 30, 7, 30, 59);
    const s = new SandSim();
    w.set(30, 6, Tile.EMPTY);
    const pod = { id: 7, x: 30.5, y: 59 - T.podHalf };
    const ev = ticks(1, 1000, w, s, [pod]);
    const hits = ev.filter((e) => e.kind === 'hit');
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({ podId: 7, damage: T.sandHitDamage });
    expect(ev.some((e) => e.kind === 'land')).toBe(false);
    expect(s.blocks.length).toBe(0);
    expect(w.get(30, 58)).toBe(Tile.EMPTY);
  });

  it('returning support cancels the wobble', () => {
    const w = sandColumn();
    const s = new SandSim();
    w.set(20, 8, Tile.EMPTY);
    const ev1 = ticks(100, 105, w, s);
    expect(ev1.filter((e) => e.kind === 'wobble').length).toBe(3);
    w.set(20, 8, Tile.DIRT);
    const ev2 = ticks(106, 200, w, s);
    expect(ev2.filter((e) => e.kind === 'fall').length).toBe(0);
    expect(s.blocks.length).toBe(0);
    expect(w.get(20, 7)).toBe(Tile.SAND);
  });

  it('digging out from under a wobble cancels it too', () => {
    const w = sandColumn();
    const s = new SandSim();
    w.set(20, 8, Tile.EMPTY);
    ticks(100, 103, w, s);
    w.set(20, 5, Tile.EMPTY);
    w.set(20, 6, Tile.EMPTY);
    w.set(20, 7, Tile.EMPTY);
    ticks(104, 200, w, s);
    expect(s.blocks.length).toBe(0);
  });
});
