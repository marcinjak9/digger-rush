import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'colyseus.js';
import { MSG, ROOM_NAME, SIM_VERSION, T } from '@digger/shared';
import { createGameServer, type GameServer } from '../src/gameServer.js';
import type { DigRoom } from '../src/DigRoom.js';
import { JoinLimiter, TickStats, TokenBucket, clientAddress } from '../src/limits.js';
import { TestClient, makeToken, opened, sleep, waitFor } from './helpers.js';

describe('token bucket', () => {
  it('allows a burst, then the sustained rate, and refills', () => {
    const b = new TokenBucket(10, 5, 0);
    let ok = 0;
    for (let i = 0; i < 20; i++) if (b.take(0)) ok++;
    expect(ok).toBe(5);
    expect(b.take(50)).toBe(false); // 0.5 token
    expect(b.take(100)).toBe(true); // 1 token after 100 ms
    expect(b.take(100)).toBe(false);
    let n = 0;
    for (let t = 1000; t < 3000; t += 10) if (b.take(t)) n++; // 100 msgs/s offered, 10/s allowed
    expect(n).toBeGreaterThanOrEqual(19);
    expect(n).toBeLessThanOrEqual(26);
  });
  it('lets a legit input stream (30 msgs/s) through', () => {
    const b = new TokenBucket(T.net.inRate, T.net.inBurst, 0);
    for (let i = 0; i < 300; i++) expect(b.take(i * (1000 / 30))).toBe(true);
  });
});

describe('join limiter', () => {
  it('limits per address, per window, and expires entries', () => {
    const j = new JoinLimiter(3, 1000);
    for (let i = 0; i < 3; i++) expect(j.allow('1.2.3.4', 100)).toBe(true);
    expect(j.allow('1.2.3.4', 200)).toBe(false);
    expect(j.allow('5.6.7.8', 200)).toBe(true);
    expect(j.size).toBe(2);
    expect(j.allow('1.2.3.4', 1200)).toBe(true); // window over
    expect(j.allow('x', 5000)).toBe(true); // the sweep dropped the expired entries
    expect(j.size).toBe(1);
  });
  it('never keeps raw addresses', () => {
    const j = new JoinLimiter(3, 1000);
    j.allow('203.0.113.9', 0);
    expect(JSON.stringify([...(j as unknown as { hits: Map<string, unknown> }).hits.keys()])).not.toContain('203');
  });
  it('takes the proxy appended address from the context ip', () => {
    expect(clientAddress('9.9.9.9')).toBe('9.9.9.9');
    expect(clientAddress('6.6.6.6, 9.9.9.9')).toBe('9.9.9.9');
    expect(clientAddress(['a', 'b'])).toBe('b');
    expect(clientAddress(undefined)).toBe('unknown');
  });
});

describe('tick stats', () => {
  it('computes avg, p95 and max', () => {
    const s = new TickStats();
    for (let i = 1; i <= 100; i++) s.record(i);
    const r = s.summary();
    expect(r.avgMs).toBeCloseTo(50.5, 1);
    expect(r.p95Ms).toBe(96);
    expect(r.maxMs).toBe(100);
  });
});

let gs: GameServer;
let url = '';
let http = '';

beforeAll(async () => {
  gs = createGameServer({ reconnectWindowMs: 700, roomIdleMs: 400, joinsPerWindow: 100000 });
  const port = await gs.listen(0);
  url = `ws://127.0.0.1:${port}`;
  http = `http://127.0.0.1:${port}`;
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

describe('message limits', () => {
  it('kicks an input flooder, and the flood buys no extra sim ticks', async () => {
    const a = await TestClient.join(url, 'Flooder');
    const room = await roomOf(a);
    const before = room.stats.inputTicks;
    const t0 = Date.now();
    let closed = false;
    a.room.onLeave(() => { closed = true; });
    for (let i = 1; i <= 2000; i++) a.room.send(MSG.IN, { seq: i, ticks: 4, mask: 8 });
    await waitFor(() => closed, 4000, 'kick');
    expect(room.stats.rateLimited).toBeGreaterThan(100);
    expect(room.stats.kicked).toBeGreaterThanOrEqual(1);
    const elapsed = (Date.now() - t0) / 1000;
    expect(room.stats.inputTicks - before).toBeLessThanOrEqual(elapsed * 60 + T.net.burstTicks + T.net.catchupBankTicks + 4);
  });

  it('drops bursts of buy, radar and ping beyond their buckets', async () => {
    const a = await TestClient.join(url, 'Spammer');
    const room = await roomOf(a);
    const base = room.stats.rateLimited;
    for (let i = 0; i < 12; i++) a.room.send(MSG.PING, { t: i });
    await sleep(150);
    expect(a.pongs.length).toBeLessThanOrEqual(T.net.pingBurst + 1);
    expect(a.pongs.length).toBeGreaterThanOrEqual(T.net.pingBurst);
    for (let i = 0; i < 20; i++) a.room.send(MSG.RADAR, {});
    for (let i = 0; i < 30; i++) a.room.send(MSG.BUY, { kind: 'drill' });
    await sleep(150);
    expect(room.stats.rateLimited - base).toBeGreaterThanOrEqual(6 + 16 + 20 - 3);
    const verdicts = a.evs.filter((e) => e[0] === 3).length;
    expect(verdicts).toBeLessThanOrEqual(T.net.buyBurst + 2);
  });

  it('survives fuzzed payloads on every message type and keeps serving others', async () => {
    const a = await TestClient.join(url, 'Fuzzer');
    const b = await TestClient.join(url, 'Bystander');
    const room = await roomOf(a);
    const weird: unknown[] = [
      undefined, null, 0, -1, NaN, Infinity, 1e308, 'x', '', [], [1, 2, 3], {}, { seq: 'a' }, { seq: 1, ticks: 'x', mask: 0 },
      { seq: -5, ticks: 1, mask: 99 }, { seq: 1.5, ticks: 1, mask: 1 }, { seq: 2 ** 40, ticks: 1, mask: 1 },
      { seq: 1, ticks: NaN, mask: 1 }, { seq: 1, ticks: 1e9, mask: 1 }, { kind: {} }, { kind: ['drill'] }, { kind: '__proto__' },
      { t: 'x' }, { t: {} }, { seq: 1, ticks: 1, mask: 1, extra: 'y'.repeat(500) },
      'a'.repeat(900), new Array(100).fill(7),
    ];
    const types = [MSG.IN, MSG.BUY, MSG.RADAR, MSG.PING, MSG.READY, 'nope', 'constructor', '__proto__'];
    let sent = 0;
    for (const t of types) {
      for (const w of weird) {
        try { a.room.send(t, w); } catch { /* client side encode failure */ }
        if (++sent % 4 === 0) await sleep(30); // stay near the buckets: this tests validation
      }
    }
    // raw garbage frames
    for (let i = 0; i < 20; i++) {
      const buf = new Uint8Array(1 + (i * 7) % 60);
      for (let k = 0; k < buf.length; k++) buf[k] = (i * 31 + k * 17 + (k >> 2) * 5) & 255;
      try { a.room.connection.send(buf); } catch { /* closed */ }
      await sleep(20);
    }
    await sleep(200);
    expect(room.stats.rejected).toBeGreaterThan(10);
    // the room and the other player are unharmed
    const n = b.snaps;
    await waitFor(() => b.snaps > n + 3, 2000, 'bystander snapshots');
    b.room.send(MSG.PING, { t: 77 });
    await waitFor(() => b.pongs.includes(77), 2000, 'pong');
    const rec = room.players.get(a.welcome.id);
    if (rec !== undefined) {
      expect(Number.isFinite(rec.sim.pod.x)).toBe(true);
      expect(Number.isFinite(rec.sim.pod.y)).toBe(true);
      expect(rec.qLen).toBeLessThanOrEqual(T.net.inputQueueMax);
    }
  });

  it('caps the input queue and clamps oversized commands', async () => {
    const a = await TestClient.join(url, 'Queue');
    const room = await roomOf(a);
    const rec = room.players.get(a.welcome.id)!;
    const base = room.stats.clamped + room.stats.overflow;
    for (let i = 1; i <= 50; i++) a.room.send(MSG.IN, { seq: i, ticks: 200, mask: 8 });
    await sleep(100);
    expect(rec.qLen).toBeLessThanOrEqual(T.net.inputQueueMax);
    expect(room.stats.clamped + room.stats.overflow).toBeGreaterThan(base);
  });

  it('closes on oversized websocket frames without crashing the server', async () => {
    const a = await TestClient.join(url, 'Big');
    let closed = false;
    a.room.onLeave(() => { closed = true; });
    try { a.room.connection.send(new Uint8Array(T.net.maxPayloadBytes * 4)); } catch { /* ignore */ }
    await waitFor(() => closed, 3000, 'close on oversized frame');
    const b = await TestClient.join(url, 'After');
    expect(b.welcome.id).toBeGreaterThan(0);
  });
});

describe('join limits', () => {
  it('rejects bad nicknames of every shape', async () => {
    const client = new Client(url);
    const bad: unknown[] = [undefined, null, 5, '', ' ', 'a', 'x'.repeat(17), 'x'.repeat(5000), '\u0000\u0001a‮', {}, ['ab']];
    for (const nickname of bad) {
      await expect(client.joinOrCreate(ROOM_NAME, { nickname, token: makeToken(), simVersion: SIM_VERSION })).rejects.toBeTruthy();
    }
    await expect(client.joinOrCreate(ROOM_NAME, null as never)).rejects.toBeTruthy();
  });

  it('exposes aggregate stats without personal data', async () => {
    const a = await TestClient.join(url, 'Statsy');
    await waitFor(() => a.snaps > 5, 2000, 'snaps');
    const body = await (await fetch(`${http}/stats`)).text();
    const j = JSON.parse(body);
    expect(j.ticks).toBeGreaterThan(0);
    expect(j.p95Ms).toBeGreaterThanOrEqual(0);
    expect(body).not.toContain('Statsy');
    expect(body).not.toContain('127.0.0.1');
  });
});
