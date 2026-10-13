import { describe, expect, it } from 'vitest';
import {
  T, Tile, World, Predictor, SandSim, createPlayer, encodePod, decodePod, newPlayer, newSimEvents, stepPlayerTick,
  inputFromMask, packInput, podHash, u32, type TileChange, clonePod,
} from '../src/index.js';

// Scripted input: holds a direction for a hashed number of ticks, mostly digging down and sideways.
function scriptMask(tick: number): number {
  const seg = Math.floor(tick / 23);
  const h = u32(7, seg, 0, 5) % 10;
  if (h < 5) return packInput({ left: false, right: false, up: false, down: true });
  if (h < 7) return packInput({ left: true, right: false, up: false, down: false });
  if (h < 9) return packInput({ left: false, right: true, up: false, down: false });
  return packInput({ left: false, right: false, up: true, down: false });
}

interface Snap { at: number; pod: number[]; ack: number; changes: TileChange[]; digs: Array<[number, number]> }

function runScenario(latencyUp: number, latencyDown: number, ticks: number, tweak?: (serverWorld: World, t: number, server: ReturnType<typeof createPlayer>) => void) {
  const serverWorld = new World(T.SEED);
  const server = createPlayer(1, newPlayer(), serverWorld);
  const out = newSimEvents();
  const clientWorld = new World(T.SEED);
  const pred = new Predictor(clientWorld, clonePod(server.pod), newPlayer().lvl);
  const uplink: Array<{ at: number; cmd: { seq: number; ticks: number; mask: number } }> = [];
  const downlink: Snap[] = [];
  let ack = 0;
  let maxErr = 0;
  let reconciles = 0;
  let digs = 0;
  let digCells: Array<[number, number]> = [];
  for (let t = 0; t < ticks + latencyUp + latencyDown + 8; t++) {
    const live = t < ticks;
    if (live) pred.applyLocal(scriptMask(t));
    if (t % 2 === 1 || !live) {
      pred.flush((seq, n, mask) => uplink.push({ at: t + latencyUp, cmd: { seq, ticks: n, mask } }));
    }
    // server: consume commands that have arrived
    while (uplink.length > 0 && uplink[0].at <= t) {
      const { cmd } = uplink.shift()!;
      for (let i = 0; i < cmd.ticks; i++) {
        out.dug.length = 0;
        stepPlayerTick(serverWorld, server, inputFromMask(cmd.mask), out);
        digs += out.dug.length;
        for (const d of out.dug) digCells.push([d.x, d.y]);
      }
      ack = cmd.seq;
    }
    if (tweak) tweak(serverWorld, t, server);
    if (t % 2 === 0) downlink.push({ at: t + latencyDown, pod: encodePod(server.pod), ack, changes: serverWorld.drainChanges(), digs: digCells });
    if (t % 2 === 0) digCells = [];
    while (downlink.length > 0 && downlink[0].at <= t) {
      const s = downlink.shift()!;
      for (const [dx, dy] of s.digs) pred.onServerDig(dx, dy); // EV_DIG
      for (const ch of s.changes) pred.applyServer(ch);
      const err = pred.reconcile(s.pod, s.ack);
      reconciles++;
      if (err > maxErr) maxErr = err;
    }
  }
  return { server, pred, serverWorld, clientWorld, maxErr, reconciles, digs };
}

describe('Predictor', () => {
  it('matches server stepping exactly (error 0) under latency, including digs', () => {
    for (const [up, down] of [[0, 0], [3, 3], [9, 14], [20, 6]]) {
      const r = runScenario(up, down, 900);
      expect(r.digs).toBeGreaterThan(3);
      expect(r.reconciles).toBeGreaterThan(100);
      expect(r.maxErr).toBe(0);
      expect(podHash(r.pred.pod)).toBe(podHash(r.server.pod));
      expect(encodePod(r.pred.pod)).toEqual(encodePod(r.server.pod));
      expect(r.pred.pendingTicks).toBe(0);
      // the predicted world carries the same edits as the server world
      for (let y = 0; y < 40; y++) for (let x = 0; x < T.WORLD_W; x++) {
        if (r.serverWorld.get(x, y) !== r.clientWorld.get(x, y)) throw new Error(`world differs at ${x},${y}`);
      }
    }
  });

  it('snaps to the server when the worlds disagree, then converges again', () => {
    // the server moves the pod (as another effect it knows about and the client does not)
    const r = runScenario(5, 5, 600, (_w, t, sv) => {
      if (t === 100) sv.pod.y -= 2;
    });
    expect(r.maxErr).toBeGreaterThan(0);
    expect(encodePod(r.pred.pod)).toEqual(encodePod(r.server.pod));
  });

  it('coalesces ticks into commands of at most 4 ticks and acks free the buffer', () => {
    const w = new World(T.SEED);
    const p = new Predictor(w, createPlayer(1, newPlayer(), w).pod, newPlayer().lvl);
    for (let i = 0; i < 10; i++) p.applyLocal(0);
    p.applyLocal(8);
    const sent: number[][] = [];
    p.flush((s, n, m) => sent.push([s, n, m]));
    expect(sent).toEqual([[1, 4, 0], [2, 4, 0], [3, 2, 0], [4, 1, 8]]);
    p.flush(() => { throw new Error('nothing new to send'); });
    expect(p.pendingTicks).toBe(11);
    p.reconcile(encodePod(p.pod), 3);
    expect(p.pendingTicks).toBe(1);
    expect(p.pendingCount).toBe(1);
  });

  it('never touches wallet or score (it has no access to them) and restores undug tiles on replay', () => {
    const w = new World(T.SEED);
    const server = new World(T.SEED);
    const pl = createPlayer(1, newPlayer(), server);
    const pred = new Predictor(w, clonePod(pl.pod), newPlayer().lvl);
    for (let i = 0; i < 80; i++) pred.applyLocal(8); // dig down
    expect(w.changes.length).toBeGreaterThan(0);
    const dugAt = w.changes[0];
    // server has acknowledged nothing: the pod is reset, the dug tile must come back and be re-dug
    pred.reconcile(encodePod(pl.pod), 0);
    expect(w.get(dugAt.x, dugAt.y)).toBe(Tile.EMPTY); // replayed
    const pod = decodePod(encodePod(pred.pod));
    expect(pod.y).toBeCloseTo(pred.pod.y, 6);
  });
});

describe('predicted dig ghosts', () => {
  // Digs down until the predictor reports a dug tile; returns that cell.
  function digOne(pred: Predictor): { x: number; y: number; tile: number } {
    for (let i = 0; i < 400; i++) {
      const ev = pred.applyLocal(8);
      if (ev.dug !== null) return { x: ev.dug.x, y: ev.dug.y, tile: ev.dug.tile };
    }
    throw new Error('nothing dug');
  }

  it('puts back an acknowledged predicted dig the server never made (no ghost hole)', () => {
    const w = new World(T.SEED);
    const server = new World(T.SEED);
    const pl = createPlayer(1, newPlayer(), server);
    const start = encodePod(pl.pod);
    const pred = new Predictor(w, clonePod(pl.pod), newPlayer().lvl);
    const cell = digOne(pred);
    expect(w.get(cell.x, cell.y)).toBe(Tile.EMPTY);
    // the server acknowledged everything but its pod went elsewhere: no EV_DIG, no tile delta for the cell
    pred.reconcile(start, pred.nextSeq - 1);
    expect(w.get(cell.x, cell.y)).toBe(cell.tile);
    expect(server.get(cell.x, cell.y)).toBe(cell.tile);
    expect(pred.pendingTicks).toBe(0);
  });

  it('keeps an acknowledged dig the server confirmed with EV_DIG', () => {
    const w = new World(T.SEED);
    const server = new World(T.SEED);
    const pl = createPlayer(1, newPlayer(), server);
    const pred = new Predictor(w, clonePod(pl.pod), newPlayer().lvl);
    const cell = digOne(pred);
    pred.onServerDig(cell.x, cell.y);
    pred.applyServer({ tick: 0, x: cell.x, y: cell.y, tile: Tile.EMPTY, aux: 0 });
    pred.reconcile(encodePod(pl.pod), pred.nextSeq - 1);
    expect(w.get(cell.x, cell.y)).toBe(Tile.EMPTY);
  });

  it('does not restore a stale solid tile when the server emptied the cell itself (no phantom tile)', () => {
    const w = new World(T.SEED);
    const server = new World(T.SEED);
    const pl = createPlayer(1, newPlayer(), server);
    const start = encodePod(pl.pod);
    const pred = new Predictor(w, clonePod(pl.pod), newPlayer().lvl);
    const cell = digOne(pred);
    // someone else dug it / sand started falling: the server delta arrives while our dig is still unacknowledged
    pred.applyServer({ tick: 0, x: cell.x, y: cell.y, tile: Tile.EMPTY, aux: 0 });
    pred.reset(start, 0); // e.g. a respawn: pending commands are dropped, predicted digs reverted
    expect(w.get(cell.x, cell.y)).toBe(Tile.EMPTY);
  });
});

describe('net encoding', () => {
  it('round-trips a pod mid drill with mem and glide exactly', () => {
    const w = new World(T.SEED);
    const sandless = new SandSim();
    void sandless;
    const pl = createPlayer(2, newPlayer(), w);
    const out = newSimEvents();
    for (let t = 0; t < 300; t++) {
      stepPlayerTick(w, pl, inputFromMask(t % 40 < 25 ? 8 : t % 40 < 30 ? 1 : 2), out);
      const arr = encodePod(pl.pod);
      expect(arr.every((v) => Number.isInteger(v))).toBe(true);
      expect(encodePod(decodePod(arr))).toEqual(arr);
      expect(decodePod(arr)).toEqual(pl.pod);
    }
  });
});
