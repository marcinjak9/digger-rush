import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'colyseus.js';
import { MSG, ROOM_NAME, SIM_VERSION, T, Tile, encodePod, newPod, packInput, surfaceRow } from '@digger/shared';
import { createGameServer, type GameServer } from '../src/gameServer.js';
import type { DigRoom } from '../src/DigRoom.js';
import { TestClient, makeToken, opened, sleep, waitFor } from './helpers.js';

const DOWN = packInput({ left: false, right: false, up: false, down: true });
const RIGHT = packInput({ left: false, right: true, up: false, down: false });

let gs: GameServer;
let url = '';

beforeAll(async () => {
  gs = createGameServer({ reconnectWindowMs: 700, roomIdleMs: 400 });
  const port = await gs.listen(0);
  url = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  // a failing test must not leave players behind for the next one
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

// Server side teleport of a player's pod onto the surface column x (tests only).
function place(room: DigRoom, c: TestClient, x: number, y?: number): void {
  const rec = room.players.get(c.welcome.id)!;
  const row = surfaceRow(room.world, Math.floor(x));
  rec.sim.pod = newPod(x, y ?? row - T.podHalf);
  rec.sim.pod.grounded = y === undefined;
}

describe('server', () => {
  it('welcomes a player, streams snapshots and answers ping', async () => {
    const a = await TestClient.join(url, 'Alice');
    expect(a.welcome.simVersion).toBe(SIM_VERSION);
    expect(a.welcome.seed).toBe(T.SEED);
    expect(a.welcome.resumed).toBe(false);
    expect(a.welcome.roomId).toBe(a.room.roomId);
    const t = Date.now();
    a.room.send(MSG.PING, { t });
    await waitFor(() => a.pongs.length > 0, 2000, 'pong');
    expect(a.pongs[0]).toBe(t);
    await waitFor(() => a.snaps >= 5, 2000, 'snapshots');
    expect(a.lastSnap!.p.length).toBe(22);
    await a.close();
  });

  it('rejects bad nicknames, tokens and old clients', async () => {
    const client = new Client(url);
    const ok = { nickname: 'Valid', token: makeToken(), simVersion: SIM_VERSION };
    await expect(client.joinOrCreate(ROOM_NAME, { ...ok, nickname: 'x' })).rejects.toThrow();
    await expect(client.joinOrCreate(ROOM_NAME, { ...ok, nickname: 'h1tler' })).rejects.toThrow();
    await expect(client.joinOrCreate(ROOM_NAME, { ...ok, token: 'short' })).rejects.toThrow();
    await expect(client.joinOrCreate(ROOM_NAME, { ...ok, simVersion: SIM_VERSION + 1 })).rejects.toThrow(/version/i);
  });

  it('predicted digging matches the server (no correction), and tile deltas reach subscribers only', async () => {
    const a = await TestClient.join(url, 'Digger');
    const b = await TestClient.join(url, 'Watcher');
    const c = await TestClient.join(url, 'Faraway');
    const room = await roomOf(a);
    place(room, a, 10.5);
    place(room, b, 12.5);
    place(room, c, 80.5, 150); // deep in another chunk column: not subscribed to the top-left chunks
    await waitFor(() => c.snaps > 3 && b.snaps > 3, 2000);
    await sleep(150);
    a.predictor.reconcile(a.lastSnap!.p, a.lastSnap!.a);
    a.maxError = 0;
    b.joined.length = 0;
    c.joined.length = 0;
    b.tiles.length = 0;
    c.tiles.length = 0;
    const digsBefore = a.digEvents;
    a.step(60, DOWN);
    await a.settle();
    expect(a.maxError).toBe(0);
    expect(a.digEvents).toBeGreaterThan(digsBefore);
    expect(encodePod(a.predictor.pod)).toEqual(a.lastSnap!.p);
    const dug = b.tiles.find((t) => t.tile === Tile.EMPTY);
    expect(dug).toBeDefined();
    expect(b.world.get(dug!.x, dug!.y)).toBe(Tile.EMPTY);
    expect(c.tiles.length).toBe(0);
    expect(c.world.get(dug!.x, dug!.y)).not.toBe(Tile.EMPTY);
    // B sees A in range, with the nickname; C (far away) does not.
    expect(b.lastSnap!.o.length).toBe(5);
    expect(c.lastSnap!.o.length).toBe(0);
    expect(c.joined.length).toBe(0);
    expect(b.lastSnap!.o.length % 5).toBe(0);
    await Promise.all([a.close(), b.close(), c.close()]);
  });

  it('a newly subscribed chunk delivers the modified tiles', async () => {
    const a = await TestClient.join(url, 'Early');
    const room = await roomOf(a);
    place(room, a, 30.5);
    await waitFor(() => a.snaps > 2, 2000);
    await sleep(100);
    a.step(40, DOWN);
    await a.settle();
    const hole = room.world.chunkDiff(1, 0).find((r) => r[2] === Tile.EMPTY);
    expect(hole).toBeDefined();
    const late = await TestClient.join(url, 'Late');
    place(await roomOf(late), late, 30.5);
    await waitFor(() => late.world.get(hole![0], hole![1]) === Tile.EMPTY, 3000, 'chunk diff for the late joiner');
    await Promise.all([a.close(), late.close()]);
  });

  it('opens a second room for the 31st player', async () => {
    const clients: TestClient[] = [];
    for (let i = 0; i < 30; i++) clients.push(await TestClient.join(url, `Bot${i}`, makeToken(), undefined, false));
    const first = clients[0].room.roomId;
    expect(new Set(clients.map((c) => c.room.roomId)).size).toBe(1);
    const extra = await TestClient.join(url, 'Thirty-first', makeToken(), undefined, false);
    expect(extra.room.roomId).not.toBe(first);
    await Promise.all([...clients, extra].map((c) => c.close()));
  }, 20000);

  it('keeps the player through a reconnect inside the window, and drops it afterwards', async () => {
    const token = makeToken();
    const a = await TestClient.join(url, 'Phoenix', token);
    const other = await TestClient.join(url, 'Bystander');
    const room = await roomOf(a);
    const rec = room.players.get(a.welcome.id)!;
    rec.sim.stats.wallet = 777;
    rec.sim.stats.score = 123;
    place(room, a, 40.5);
    await waitFor(() => a.snaps > 3);
    const roomId = a.room.roomId;
    const id = a.welcome.id;
    const podBefore = encodePod(rec.sim.pod);
    await a.room.leave(false); // abnormal close, not a consented leave
    await waitFor(() => room.players.get(id)?.client === null, 2000, 'server notices the drop');
    expect(room.players.has(id)).toBe(true);
    // frozen: not stepped
    await sleep(100);
    expect(encodePod(rec.sim.pod)).toEqual(podBefore);
    // back within the window
    const back = await TestClient.join(url, 'Phoenix', token, roomId);
    expect(back.welcome.resumed).toBe(true);
    expect(back.welcome.id).toBe(id);
    expect(back.player.stats.wallet).toBe(777);
    expect(back.player.stats.score).toBe(123);
    expect(back.welcome.pod).toEqual(podBefore);
    // the leaderboard keeps listing a disconnected player
    await back.room.leave(false);
    await waitFor(() => other.lb !== null && other.lb.n === 2, 3000, 'leaderboard with the disconnected player');
    // window expires
    await waitFor(() => !room.players.has(id), 3000, 'player expiry');
    const fresh = await TestClient.join(url, 'Phoenix', token, roomId);
    expect(fresh.welcome.resumed).toBe(false);
    expect(fresh.welcome.id).not.toBe(id);
    expect(fresh.player.stats.wallet).toBe(0);
    await Promise.all([other.close(), fresh.close()]);
  });

  it('rejects replayed seqs, clamps huge ticks, bounds consumption to real time, ignores junk', async () => {
    const a = await TestClient.join(url, 'Cheater');
    const room = await roomOf(a);
    place(room, a, 20.5);
    await waitFor(() => a.snaps > 2);
    const stats = room.stats;
    const staleBefore = stats.staleSeq;
    const clampedBefore = stats.clamped;
    const rejectedBefore = stats.rejected;
    const ticksBefore = stats.inputTicks;

    a.room.send(MSG.IN, { seq: 1, ticks: 1000, mask: RIGHT }); // clamped to 4
    a.room.send(MSG.IN, { seq: 1, ticks: 2, mask: RIGHT }); // replay
    a.room.send(MSG.IN, { seq: 0, ticks: 2, mask: RIGHT }); // older
    a.room.send(MSG.IN, { seq: 'x', ticks: 2, mask: 99 }); // junk
    a.room.send(MSG.IN, { seq: 2, ticks: Infinity, mask: 1 }); // not a finite number
    a.room.send(MSG.IN, null);
    a.room.send('bogus', { hello: 1 });
    a.room.send(MSG.BUY, { kind: 'nuke' });
    await waitFor(() => stats.inputTicks > ticksBefore, 2000);
    await sleep(100);
    expect(stats.clamped).toBe(clampedBefore + 1);
    expect(stats.staleSeq).toBe(staleBefore + 2);
    expect(stats.rejected).toBeGreaterThanOrEqual(rejectedBefore + 4);
    expect(stats.inputTicks - ticksBefore).toBe(4);

    // flood: 38 commands x 4 ticks at once; only about real time worth is consumed
    const t0 = Date.now();
    const c0 = stats.inputTicks;
    for (let i = 0; i < 38; i++) a.room.send(MSG.IN, { seq: 10 + i, ticks: 4, mask: RIGHT });
    await sleep(250);
    const elapsedSec = (Date.now() - t0) / 1000;
    const consumed = stats.inputTicks - c0;
    // real time at 60 ticks/s plus the burst allowance (and one server tick of slack)
    expect(consumed).toBeLessThanOrEqual(T.net.burstTicks + elapsedSec * T.TICK_HZ + T.net.simTicksPerServerTick * 2);
    expect(consumed).toBeLessThan(38 * 4);
    await a.close();
  });

  it('disposes a room that stays empty', async () => {
    // all earlier tests closed their clients; wait out roomIdleMs
    const a = await TestClient.join(url, 'Lonely');
    const roomId = a.room.roomId;
    await a.close();
    const start = Date.now();
    for (;;) {
      if (!(await gs.rooms()).some((r) => r.roomId === roomId)) break;
      if (Date.now() - start > 5000) throw new Error('room was not disposed');
      await sleep(50);
    }
  }, 10000);
});
