import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUY_BAD, BUY_COOLDOWN, BUY_DEAD, BUY_FUNDS, BUY_OK, EV_BUY, EV_DEATH, EV_HEAL, EV_RESPAWN, MSG, OF_DEAD, OF_INVULN,
  OTHER_STRIDE, T, Tile, World, isSolid, newPod, packInput, surfaceRow,
} from '@digger/shared';
import { createGameServer, type GameServer } from '../src/gameServer.js';
import type { DigRoom } from '../src/DigRoom.js';
import { HealSpawner } from '../src/healSpawner.js';
import { TestClient, makeToken, opened, sleep, waitFor } from './helpers.js';

let gs: GameServer;
let url = '';

beforeAll(async () => {
  gs = createGameServer({ reconnectWindowMs: 5000, roomIdleMs: 4000 });
  url = `ws://127.0.0.1:${await gs.listen(0)}`;
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});
afterAll(async () => {
  await gs.stop();
});

async function roomOf(c: TestClient): Promise<DigRoom> {
  const r = (await gs.rooms()).find((x) => x.roomId === c.room.roomId);
  if (r === undefined) throw new Error('room not found');
  return r;
}

function place(room: DigRoom, c: TestClient, x: number): void {
  const rec = room.players.get(c.welcome.id)!;
  rec.sim.pod = newPod(x, surfaceRow(room.world, Math.floor(x)) - T.podHalf);
  rec.sim.pod.grounded = true;
}

const evsOf = (c: TestClient, kind: number): number[][] => c.evs.filter((e) => e[0] === kind);

function chunkOf(x: number, y: number): number {
  return (y >> 4) * T.CHUNKS_X + (x >> 4);
}

describe('death and respawn through the server', () => {
  it('dies at hull<=0, stays dead 3 s, respawns invulnerable on a solid tile with a full reset; others see it', async () => {
    const a = await TestClient.join(url, 'Mortal');
    const b = await TestClient.join(url, 'Watcher');
    const room = await roomOf(a);
    place(room, a, 30.5);
    place(room, b, 32.5);
    const rec = room.players.get(a.welcome.id)!;
    rec.sim.stats.wallet = 500;
    rec.sim.stats.score = 900;
    rec.sim.stats.highScore = 900;
    rec.sim.stats.lvl.drill = 2;
    rec.sim.stats.radarTicks = 300;
    await waitFor(() => b.lastSnap !== null && b.lastSnap.o.length >= OTHER_STRIDE, 2000, 'b sees a');
    const t0 = Date.now();
    rec.sim.stats.hull = 0;
    await waitFor(() => evsOf(a, EV_DEATH).length > 0, 2000, 'death event');
    expect(evsOf(a, EV_DEATH)[0][1]).toBe(900); // final score
    await waitFor(() => a.dec.deadTicks > 0, 2000, 'dead state in snapshot');
    expect(a.player.stats.wallet).toBe(0);
    expect(a.player.stats.score).toBe(0);
    expect(a.player.stats.highScore).toBe(900);
    expect(a.player.stats.lvl.drill).toBe(0);
    expect(a.player.stats.radarTicks).toBe(0);
    expect(a.player.stats.hull).toBe(T.hullBase);
    expect(a.dec.finalScore).toBe(900);
    const flagsOf = (c: TestClient): number | undefined => {
      const o = c.lastSnap!.o;
      for (let i = 0; i + OTHER_STRIDE <= o.length; i += OTHER_STRIDE) if (o[i] === a.welcome.id) return o[i + 3];
      return undefined;
    };
    await waitFor(() => ((flagsOf(b) ?? 0) & OF_DEAD) !== 0, 2000, 'b sees a dead');
    await waitFor(() => evsOf(a, EV_RESPAWN).length > 0, 5000, 'respawn event');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2700);
    expect(rec.sim.invulnTicks).toBeGreaterThan(0);
    const p = rec.sim.pod;
    expect(isSolid(room.world.get(Math.floor(p.x), Math.floor(p.y + T.podHalf + 0.1)))).toBe(true);
    await waitFor(() => a.dec.deadTicks === 0 && a.dec.invulnTicks > 0, 2000, 'alive and invulnerable');
    place(room, b, Math.floor(rec.sim.pod.x) + 0.5); // the respawn column is random: move the watcher next to it
    await waitFor(() => ((flagsOf(b) ?? 0) & OF_INVULN) !== 0, 2000, 'b sees invulnerable pod');
    expect(a.player.stats.wallet).toBe(0);
  }, 20000);
});

describe('shop validation', () => {
  it('refuses without funds, forged kinds, dead players and bursts; spends wallet only', async () => {
    const a = await TestClient.join(url, 'Shopper');
    const room = await roomOf(a);
    place(room, a, 50.5);
    const rec = room.players.get(a.welcome.id)!;
    const st = rec.sim.stats;

    a.room.send(MSG.BUY, { kind: 'drill' });
    await waitFor(() => evsOf(a, EV_BUY).length === 1, 2000, 'verdict');
    expect(evsOf(a, EV_BUY)[0].slice(1)).toEqual([0, BUY_FUNDS]);
    expect(st.lvl.drill).toBe(0);

    const before = room.stats.rejected;
    a.room.send(MSG.BUY, { kind: 'godmode' });
    a.room.send(MSG.BUY, { kind: 42 });
    a.room.send(MSG.BUY, {});
    await waitFor(() => evsOf(a, EV_BUY).filter((e) => e[2] === BUY_BAD).length === 3, 2000, 'bad verdicts');
    expect(room.stats.rejected - before).toBe(3);

    st.wallet = 500;
    st.score = 700;
    await sleep(150); // clear the per-player cooldown
    a.room.send(MSG.BUY, { kind: 'armor' });
    await waitFor(() => evsOf(a, EV_BUY).some((e) => e[2] === BUY_OK), 2000, 'ok verdict');
    expect(st.lvl.armor).toBe(1);
    expect(st.wallet).toBe(450);
    expect(st.score).toBe(700);
    await waitFor(() => a.player.stats.wallet === 450, 2000, 'wallet from server state');
    expect(a.player.stats.lvl.armor).toBe(1);

    // per-player cooldown: an immediate second purchase is refused even with money
    st.wallet = 5000;
    rec.lastBuyTick = room.serverTick + 1;
    a.room.send(MSG.BUY, { kind: 'armor' });
    await waitFor(() => evsOf(a, EV_BUY).some((e) => e[2] === BUY_COOLDOWN), 2000, 'cooldown verdict');
    expect(st.lvl.armor).toBe(1);
    expect(st.wallet).toBe(5000);

    // dead players cannot buy
    st.hull = 0;
    await waitFor(() => rec.sim.deadTicks > 0, 2000, 'dead');
    st.wallet = 5000;
    a.room.send(MSG.BUY, { kind: 'drill' });
    await waitFor(() => evsOf(a, EV_BUY).some((e) => e[2] === BUY_DEAD), 2000, 'dead verdict');
    expect(st.wallet).toBe(5000);
    expect(st.lvl.drill).toBe(0);
  }, 15000);
});

describe('leaderboard', () => {
  it('top 3 by highScore with id tie-break, own rank/high/score, disconnected players stay listed', async () => {
    const a = await TestClient.join(url, 'LbA');
    const b = await TestClient.join(url, 'LbB');
    const c = await TestClient.join(url, 'LbC');
    const d = await TestClient.join(url, 'LbD', makeToken());
    const room = await roomOf(a);
    const s = (x: TestClient) => room.players.get(x.welcome.id)!.sim.stats;
    s(a).highScore = 50;
    s(b).highScore = 200;
    s(c).highScore = 50;
    s(d).highScore = 10;
    s(d).score = 10;
    await waitFor(() => d.lb !== null && d.lb.top[0][1] === 200 && d.lb.n === 4 && d.lb.sc === 10, 3000, 'leaderboard');
    expect(d.lb!.top.map((r) => r[0])).toEqual(['LbB', 'LbA', 'LbC']); // tie 50/50 -> lower id first
    expect(d.lb!.rank).toBe(4);
    expect(d.lb!.hi).toBe(10);
    await waitFor(() => a.lb !== null && a.lb.rank === 2, 3000, 'a rank');
    s(d).score = 500;
    s(d).highScore = 500; // what onDug does while mining
    await waitFor(() => d.lb!.rank === 1, 3000, 'rank 1');
    await c.room.leave(false);
    await sleep(100);
    await waitFor(() => d.lb !== null && d.lb.n === 4, 3000, 'still four listed');
    expect(room.players.has(c.welcome.id)).toBe(true);
  }, 15000);
});

describe('heal ore respawn', () => {
  function loadedWorld(): World {
    const w = new World(T.SEED);
    for (let cy = 1; cy <= 3; cy++) for (let cx = 0; cx < T.CHUNKS_X; cx++) w.getChunk(cx, cy);
    return w;
  }
  const keys = (): number[] => {
    const k: number[] = [];
    for (let cy = 1; cy <= 3; cy++) for (let cx = 0; cx < T.CHUNKS_X; cx++) k.push(cy * T.CHUNKS_X + cx);
    return k;
  };

  it('is capped per chunk and only places heal on dirt/rock', () => {
    const w = loadedWorld();
    const h = new HealSpawner(w);
    h.rebuild(keys());
    for (let i = 0; i < 20000; i++) h.attempt([]);
    for (const k of keys()) expect(h.aliveIn(k)).toBeLessThanOrEqual(T.healRespawn.capPerChunk);
    expect(h.spawned).toBeGreaterThan(0);
    const per = new Map<number, number>();
    for (const ch of w.drainChanges()) {
      expect(ch.tile).toBe(Tile.HEAL);
      per.set(chunkOf(ch.x, ch.y), (per.get(chunkOf(ch.x, ch.y)) ?? 0) + 1);
    }
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(T.healRespawn.capPerChunk);
  });

  it('never places inside the safe radius of a pod', () => {
    const w = loadedWorld();
    const h = new HealSpawner(w);
    h.rebuild(keys());
    const pods = [newPod(48, 30)];
    for (let i = 0; i < 20000; i++) h.attempt(pods);
    expect(h.spawned).toBeGreaterThan(0);
    for (const ch of w.drainChanges()) {
      const inside = Math.abs(ch.x + 0.5 - 48) <= T.healRespawn.safeRadius && Math.abs(ch.y + 0.5 - 30) <= T.healRespawn.safeRadius;
      expect(inside).toBe(false);
    }
  });

  it('is deterministic for a seed and call sequence, and refills after mining', () => {
    const run = (): string => {
      const w = loadedWorld();
      const h = new HealSpawner(w);
      h.rebuild(keys());
      for (let i = 0; i < 300; i++) h.attempt([]);
      return w.drainChanges().map((c) => `${c.x},${c.y}`).join(';');
    };
    const a = run();
    expect(a.length).toBeGreaterThan(0);
    expect(run()).toBe(a);

    const w = loadedWorld();
    const h = new HealSpawner(w);
    h.rebuild(keys());
    for (let i = 0; i < 2000; i++) h.attempt([]);
    const key = keys()[0];
    expect(h.aliveIn(key)).toBe(T.healRespawn.capPerChunk);
    const ch = w.drainChanges().find((c) => chunkOf(c.x, c.y) === key)!;
    w.set(ch.x, ch.y, Tile.EMPTY);
    expect(h.aliveIn(key)).toBe(T.healRespawn.capPerChunk - 1);
    for (let i = 0; i < 2000; i++) h.attempt([]);
    expect(h.aliveIn(key)).toBe(T.healRespawn.capPerChunk);
  });

  it('reaches subscribers through the normal tile delta path', async () => {
    const a = await TestClient.join(url, 'HealWatch');
    const room = await roomOf(a);
    place(room, a, 10.5);
    await waitFor(() => room.players.get(a.welcome.id)!.subs.size > 0, 2000, 'subscription');
    room.heal.rebuild([...room.players.get(a.welcome.id)!.subs]);
    let placed = false;
    for (let i = 0; i < 20000 && !placed; i++) placed = room.heal.attempt([]);
    expect(placed).toBe(true);
    await waitFor(() => a.tiles.some((t) => t.tile === Tile.HEAL), 2000, 'heal tile delta');
  });

  it('mining heal ore on the server heals 50% max hp with no money or score, and emits a heal event', async () => {
    const a = await TestClient.join(url, 'Healer');
    const room = await roomOf(a);
    place(room, a, 60.5);
    const rec = room.players.get(a.welcome.id)!;
    const x = 60;
    const y = surfaceRow(room.world, x);
    room.world.set(x, y, Tile.HEAL);
    rec.sim.stats.hull = 30;
    await waitFor(() => a.tiles.some((t) => t.x === x && t.y === y && t.tile === Tile.HEAL), 2000, 'tile known');
    const down = packInput({ left: false, right: false, up: false, down: true });
    for (let i = 0; i < 150 && evsOf(a, EV_HEAL).length === 0; i++) {
      a.step(2, down);
      await sleep(20);
    }
    await waitFor(() => evsOf(a, EV_HEAL).length > 0, 4000, 'heal event');
    expect(rec.sim.stats.hull).toBe(80);
    expect(rec.sim.stats.wallet).toBe(0);
    expect(rec.sim.stats.score).toBe(0);
  }, 15000);
});
