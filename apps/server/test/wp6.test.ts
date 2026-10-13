import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T, packInput } from '@digger/shared';
import { createGameServer, type GameServer } from '../src/gameServer.js';
import type { DigRoom } from '../src/DigRoom.js';
import { trustedAddress } from '../src/limits.js';
import { TestClient, opened, sleep, waitFor } from './helpers.js';

const RIGHT = packInput({ left: false, right: true, up: false, down: false });

const dir = mkdtempSync(join(tmpdir(), 'digger-static-'));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Digger</title><div id="game"></div>');
writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("hello");\n'.repeat(100));

let gs: GameServer;
let url = '';
let http = '';

beforeAll(async () => {
  gs = createGameServer({
    reconnectWindowMs: 5000, roomIdleMs: 4000, joinsPerWindow: 100000, readyTimeoutMs: 700, staticDir: dir, adminToken: 'sekrit',
  });
  const port = await gs.listen(0);
  url = `ws://127.0.0.1:${port}`;
  http = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});
afterAll(async () => {
  await gs.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function roomOf(c: TestClient): Promise<DigRoom> {
  const r = (await gs.rooms()).find((x) => x.roomId === c.room.roomId);
  if (r === undefined) throw new Error('room not found');
  return r;
}

describe('input backlog', () => {
  it('recovers from a 500 ms input stall: queued depth is back to <= 4 ticks within 1 s', async () => {
    const a = await TestClient.join(url, 'Staller');
    const room = await roomOf(a);
    const rec = room.players.get(a.welcome.id)!;
    const queued = (): number => {
      let n = 0;
      for (let i = 0; i < rec.qLen; i++) n += rec.qTicks[(rec.qHead + i) % T.net.inputQueueMax];
      return n;
    };
    // steady play at 60 ticks/s (2 ticks every ~33 ms) so the budget has been accruing for a while
    const play = async (ms: number): Promise<number> => {
      let worst = 0;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        a.step(2, RIGHT);
        await sleep(33);
        worst = Math.max(worst, queued());
      }
      return worst;
    };
    await play(1500);
    // the network stalls for 500 ms: the client keeps producing 30 ticks, nothing arrives
    for (let i = 0; i < 30; i++) a.predictor.applyLocal(RIGHT);
    await sleep(500);
    a.flush(); // delivered in one burst
    const t0 = performance.now();
    await waitFor(() => queued() <= 4, 1000, 'queue to drain');
    expect(performance.now() - t0).toBeLessThan(1000);
    // and it stays small while play continues
    const worst = await play(600);
    expect(worst).toBeLessThanOrEqual(6);
    expect(room.stats.skipped).toBe(0);
    await a.settle();
    expect(a.predictor.pendingTicks).toBe(0);
  }, 15000);
});

describe('connections that never send ready', () => {
  it('are dropped after the timeout and are not on the leaderboard meanwhile', async () => {
    const b = await TestClient.join(url, 'Honest');
    await TestClient.join(url, 'Ghosty', undefined, b.room.roomId, false);
    const room = await roomOf(b);
    expect(room.players.size).toBeGreaterThanOrEqual(2);
    await waitFor(() => b.lb !== null && b.lb.n === 1, 3000, 'leaderboard without the unready player');
    expect(b.lb!.top.map((r) => r[0])).not.toContain('Ghosty');
    await waitFor(() => room.players.size === 1, 4000, 'unready player dropped');
    expect(room.stats.notReady).toBeGreaterThanOrEqual(1);
  }, 15000);
});

describe('http: static client, health, stats', () => {
  it('serves index.html, hashed assets with long cache, and falls back to index.html for client routes', async () => {
    const idx = await fetch(`${http}/`);
    expect(idx.status).toBe(200);
    expect(idx.headers.get('content-type')).toContain('text/html');
    expect(idx.headers.get('cache-control')).toBe('no-cache');
    expect(await idx.text()).toContain('id="game"');
    const spa = await fetch(`${http}/some/route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('id="game"');
    const js = await fetch(`${http}/assets/app-abc123.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('content-encoding')).toBe('gzip');
    expect((await js.text()).length).toBe('console.log("hello");\n'.length * 100);
    expect((await fetch(`${http}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${http}/..%2f..%2fpackage.json`)).status).not.toBe(200);
    const health = await fetch(`${http}/health`);
    expect((await health.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('keeps the websocket and matchmaking working on the same port', async () => {
    const a = await TestClient.join(url, 'SamePort');
    expect(a.welcome.id).toBeGreaterThan(0);
  });

  it('only resets /stats with the admin token', async () => {
    expect((await fetch(`${http}/stats?reset=1`)).status).toBe(403);
    expect((await fetch(`${http}/stats?reset=1&token=wrong`)).status).toBe(403);
    expect((await fetch(`${http}/stats?reset=1`, { headers: { 'x-admin-token': 'sekrit' } })).status).toBe(200);
    expect((await fetch(`${http}/stats`)).status).toBe(200);
  });
});

describe('trusted proxy address', () => {
  it('uses CF-Connecting-IP, then the first X-Forwarded-For hop, then X-Real-IP, then the socket', () => {
    expect(trustedAddress({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }, '127.0.0.1')).toBe('1.1.1.1');
    expect(trustedAddress({ 'x-forwarded-for': '2.2.2.2, 10.0.0.1' }, '127.0.0.1')).toBe('2.2.2.2');
    expect(trustedAddress({ 'x-real-ip': '3.3.3.3' }, '127.0.0.1')).toBe('3.3.3.3');
    expect(trustedAddress({}, '127.0.0.1')).toBe('127.0.0.1');
  });
});
