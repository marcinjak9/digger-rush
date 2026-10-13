import { describe, expect, it } from 'vitest';
import {
  T, Tile, SandSim, World, clonePod, createPlayer, digTicks, landingDamage, newPlayer, newPod, packInput,
  podHash, simTick, spawnPod, spawnX, stepPod, stepPodCmd, u32, unpackInput, zeroLevels,
  type InputCmd, type PodInput, type PodState,
} from '../src/index.js';
import { DOWN, LEFT, NONE, RIGHT, UP, carve, dirtWorld, standingPod } from './helpers.js';

const L0 = zeroLevels();

// Steps the pod and applies finished digs to the world like simTick does.
function run(pod: PodState, w: World, inp: PodInput, ticks: number, lv = L0): { dugAt: number; landDamage: number } {
  let dugAt = -1;
  let landDamage = 0;
  for (let i = 1; i <= ticks; i++) {
    const ev = stepPod(pod, inp, w, lv);
    landDamage += ev.landDamage;
    if (ev.dug !== null) {
      w.set(ev.dug.x, ev.dug.y, Tile.EMPTY);
      if (dugAt < 0) dugAt = i;
    }
  }
  return { dugAt, landDamage };
}

describe('drilling', () => {
  it('dirt at row 0 finishes in exactly digTicks', () => {
    const w = dirtWorld();
    const pod = standingPod(10.5);
    const n = digTicks(Tile.DIRT, 0, 0);
    expect(n).toBe(17);
    const r = run(pod, w, DOWN, 40);
    expect(r.dugAt).toBe(n);
    expect(w.get(10, 0)).toBe(Tile.EMPTY);
  });

  it('digging gets slower with depth and the 12 tick floor holds', () => {
    const w = dirtWorld();
    const pod = standingPod(10.5);
    const lv = { ...L0, drill: 5 };
    const r = run(pod, w, DOWN, 40, lv);
    expect(r.dugAt).toBe(T.minDigTicks);
    // deeper tile: stand on row 20 floor
    const w2 = dirtWorld();
    carve(w2, 10, 0, 10, 19);
    const p2 = newPod(10.5, 20 - T.podHalf);
    p2.grounded = true;
    const r2 = run(p2, w2, DOWN, 100);
    expect(r2.dugAt).toBe(digTicks(Tile.DIRT, 20, 0));
    expect(r2.dugAt).toBe(Math.ceil(0.28 * 1.4 * 60 - 1e-9));
  });

  it('cancel then resume keeps progress', () => {
    const w = dirtWorld();
    const pod = standingPod(10.5);
    run(pod, w, DOWN, 5);
    expect(pod.drill!.ticksLeft).toBe(12);
    run(pod, w, LEFT, 1); // direction change cancels
    expect(pod.drill).toBeNull();
    expect(pod.mem).toEqual({ tx: 10, ty: 0, ticksDone: 5 });
    pod.vx = 0;
    const r = run(pod, w, DOWN, 40);
    expect(r.dugAt).toBe(12);
  });

  it('down drill is refused while airborne; horizontal drill works mid-air', () => {
    const w = dirtWorld();
    const air = newPod(10.5, -5);
    stepPod(air, DOWN, w, L0);
    expect(air.drill).toBeNull();

    carve(w, 6, 5, 10, 30);
    const pod = newPod(11 - T.podHalf - 0.05, 10);
    expect(pod.grounded).toBe(false);
    stepPod(pod, RIGHT, w, L0);
    expect(pod.drill).not.toBeNull();
    expect(pod.drill!.dx).toBe(1);
    expect(pod.grounded).toBe(false);
    expect(pod.drill!.tx).toBe(11);
  });

  it('never drills up', () => {
    const w = dirtWorld();
    carve(w, 10, 5, 10, 8);
    const pod = newPod(10.5, 8 - T.podHalf + 1);
    pod.y = 9 - T.podHalf;
    pod.grounded = true;
    for (let i = 0; i < 30; i++) {
      stepPod(pod, UP, w, L0);
      expect(pod.drill).toBeNull();
    }
    expect(w.get(10, 4)).toBe(Tile.DIRT);
  });

  it('a finished drill glides into the hole and chains while held', () => {
    const w = dirtWorld();
    const pod = standingPod(10.5);
    let digs = 0;
    for (let i = 0; i < 90; i++) {
      const ev = stepPod(pod, DOWN, w, L0);
      if (ev.dug) { w.set(ev.dug.x, ev.dug.y, Tile.EMPTY); digs++; }
    }
    expect(digs).toBeGreaterThanOrEqual(3);
    expect(pod.y).toBeGreaterThan(2);
  });

  it('horizontal drilling works on the ground', () => {
    const w = dirtWorld();
    carve(w, 0, 0, 20, 0);
    const pod = newPod(11 - T.podHalf - 0.05, 1 - T.podHalf);
    pod.grounded = true;
    carve(w, 11, 0, 11, 0, Tile.DIRT);
    const r = run(pod, w, RIGHT, 30);
    expect(r.dugAt).toBe(17);
    expect(w.get(11, 0)).toBe(Tile.EMPTY);
  });
});

describe('physics', () => {
  it('W thrust accelerates upward at net 6 tiles/s^2', () => {
    const w = dirtWorld();
    carve(w, 5, 5, 15, 60);
    const pod = newPod(10.5, 40);
    run(pod, w, UP, 10);
    expect(pod.vy).toBeCloseTo(-1, 1);
    const g = newPod(10.5, 10);
    run(g, w, NONE, 10);
    expect(g.vy).toBeCloseTo(16 / 6, 1);
  });

  it('hard landing damage', () => {
    expect(landingDamage(12)).toBe(18);
    expect(landingDamage(9)).toBe(0);
    expect(landingDamage(5)).toBe(0);
    const w = dirtWorld();
    const pod = newPod(10.5, -25);
    const r = run(pod, w, NONE, 300);
    expect(pod.grounded).toBe(true);
    expect(r.landDamage).toBe((T.vyMax - T.hardLandSpeed) * T.hardLandMult);
    expect(pod.y).toBe(-T.podHalf);
  });

  it('lava deals 25 per second', () => {
    const w = dirtWorld();
    carve(w, 10, 5, 10, 40, Tile.LAVA);
    const sand = new SandSim();
    const pl = createPlayer(1, newPlayer());
    pl.pod = newPod(10.5, 6);
    const none = new Map<number, PodInput>();
    for (let t = 1; t <= 60; t++) simTick(w, sand, [pl], none, t);
    expect(pl.stats.hull).toBeCloseTo(75, 6);
    pl.stats.lvl.armor = 2;
    pl.stats.hull = 100;
    for (let t = 61; t <= 120; t++) simTick(w, sand, [pl], none, t);
    expect(pl.stats.hull).toBeCloseTo(100 - 25 * 0.8, 6);
  });

  it('clamps height and keeps pod inside the side walls', () => {
    const w = dirtWorld();
    const pod = newPod(10.5, -29);
    run(pod, w, UP, 600);
    expect(pod.y).toBe(T.yMin);
    const p2 = standingPod(1.5);
    run(p2, w, LEFT, 10);
    expect(p2.x).toBeGreaterThanOrEqual(T.podHalf);
    const p3 = standingPod(94.5);
    for (let i = 0; i < 200; i++) stepPod(p3, RIGHT, w, L0);
    expect(p3.x).toBeLessThanOrEqual(T.WORLD_W - T.podHalf);
  });

  it('pod state is quantized to 1/1024', () => {
    const w = dirtWorld();
    const pod = standingPod(10.5);
    for (let i = 0; i < 100; i++) {
      stepPod(pod, i % 40 < 20 ? RIGHT : LEFT, w, L0);
      for (const v of [pod.x, pod.y, pod.vx, pod.vy]) expect(Number.isInteger(v * 1024)).toBe(true);
    }
  });

  it('spawn helper spreads players along the surface and rests on the ground', () => {
    const xs = new Set<number>();
    for (let id = 0; id < 20; id++) {
      const x = spawnX(id);
      expect(x).toBeGreaterThan(3);
      expect(x).toBeLessThan(93);
      xs.add(x);
    }
    expect(xs.size).toBeGreaterThan(10);
    const w = new World(1337);
    const pod = spawnPod(4);
    for (let i = 0; i < 30; i++) stepPod(pod, NONE, w, L0);
    expect(pod.y).toBe(-T.podHalf);
    expect(pod.grounded).toBe(true);
  });
});

function scriptedInput(t: number): PodInput {
  const h = u32(5, Math.floor(t / 20), 0, 1) % 12;
  return {
    left: h === 1 || h === 5 || h === 9,
    right: h === 2 || h === 6,
    up: h === 3 || h === 7 || h === 10,
    down: h === 0 || h === 4 || h === 8 || h === 11,
  };
}

function runScript(): { hash: number; changes: string; hull: number; wallet: number; y: number } {
  const w = new World(1337);
  const sand = new SandSim();
  const pl = createPlayer(2, newPlayer());
  for (let t = 1; t <= 600; t++) simTick(w, sand, [pl], new Map([[2, scriptedInput(t)]]), t);
  return { hash: podHash(pl.pod), changes: JSON.stringify(w.changes), hull: pl.stats.hull, wallet: pl.stats.wallet, y: pl.pod.y };
}

describe('determinism', () => {
  it('600 scripted ticks give identical state on two runs and dig something', () => {
    const a = runScript();
    const b = runScript();
    expect(a).toEqual(b);
    expect(JSON.parse(a.changes).length).toBeGreaterThan(5);
  });

  it('stepping 1 tick x N matches commands with ticks=N', () => {
    const cmds: InputCmd[] = [];
    for (let i = 0; i < 80; i++) {
      const inp = scriptedInput(i * 3);
      cmds.push({ ...inp, seq: i, ticks: 1 + (u32(3, i, 0, 1) % 4) });
    }
    const wa = new World(1337);
    const wb = new World(1337);
    const pa = standingPod(20.5);
    const pb = clonePod(pa);
    for (const c of cmds) {
      stepPodCmd(pa, c, wa, L0, (ev) => { if (ev.dug) wa.set(ev.dug.x, ev.dug.y, Tile.EMPTY); });
      for (let k = 0; k < c.ticks; k++) {
        const ev = stepPod(pb, c, wb, L0);
        if (ev.dug) wb.set(ev.dug.x, ev.dug.y, Tile.EMPTY);
      }
    }
    expect(pa).toEqual(pb);
    expect(wa.changes).toEqual(wb.changes);
    expect(wa.changes.length).toBeGreaterThan(0);
  });

  it('input pack/unpack round trips', () => {
    for (let m = 0; m < 16; m++) expect(packInput(unpackInput(m))).toBe(m);
  });
});
