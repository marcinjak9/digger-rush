// Headless load test: N colyseus.js bots with the shared Predictor, random digging, shopping and radar.
//   npm run loadtest -- --bots 30 --seconds 60 --url ws://localhost:2567
// Without a reachable server at the url, an in-process one is started. Exit code 1 when the p95 server tick
// time exceeds 20 ms or any bot failed.
import { Client, type Room } from 'colyseus.js';
import {
  EV_DEATH, EV_LEN, MSG, Predictor, ROOM_NAME, SIM_VERSION, T, UPGRADE_KINDS, World, newPlayer, newPod, readStats, upgradeCost,
  type DecodedStats, type EvMsg, type SimPlayer, type SnapMsg, type TilesMsg, type ChunksMsg, type WelcomeMsg,
} from '@digger/shared';
import { createGameServer, type GameServer } from '../src/gameServer.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const BOTS = Math.max(1, Number(arg('bots', '30')));
const SECONDS = Math.max(1, Number(arg('seconds', '30')));
const URL_ = arg('url', 'ws://localhost:2567');
const P95_LIMIT_MS = 20;
const KB_LIMIT = 200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DOWN = 8, LEFT = 1, RIGHT = 2, UP = 4;

class Bot {
  room!: Room;
  readonly world = new World(T.SEED);
  readonly player: SimPlayer = { id: 0, pod: newPod(0, 0), stats: newPlayer(0), spawnSalt: 0, deadTicks: 0, invulnTicks: 0, finalScore: 0 };
  readonly predictor = new Predictor(this.world, this.player.pod, this.player.stats.lvl);
  readonly dec: DecodedStats = { deadTicks: 0, invulnTicks: 0, finalScore: 0 };
  bytesIn = 0;
  bytesOut = 0;
  msgsIn = 0;
  snaps = 0;
  errSum = 0;
  errMax = 0;
  deaths = 0;
  dropped = false;
  failed: string | null = null;
  welcomed = false;
  private mask = DOWN;
  private maskTicks = 0;
  private acc = 0;
  private flushCount = 0;
  private nextBuyAt = 0;
  private nextRadarAt = 0;
  private nextPingAt = 0;
  private errCount = 0;

  constructor(readonly index: number) {}

  async join(url: string): Promise<void> {
    const token = `loadtest-${Date.now().toString(36)}-${this.index}-${Math.random().toString(36).slice(2)}abcdefgh`;
    const client = new Client(url);
    this.room = await client.joinOrCreate(ROOM_NAME, { nickname: `Bot${this.index}`, token, simVersion: SIM_VERSION });
    const r = this.room;
    const ws = (r.connection.transport as unknown as { ws?: { send: (d: unknown) => void; addEventListener: (t: string, f: (e: { data: unknown }) => void) => void } }).ws;
    if (ws !== undefined) {
      ws.addEventListener('message', (e) => {
        this.msgsIn++;
        const d = e.data as { byteLength?: number; length?: number };
        this.bytesIn += d.byteLength ?? d.length ?? 0;
      });
      const send = ws.send.bind(ws);
      ws.send = (d: unknown): void => {
        this.bytesOut += (d as { byteLength?: number }).byteLength ?? 0;
        send(d);
      };
    }
    r.onMessage(MSG.WELCOME, (m: WelcomeMsg) => {
      this.player.id = m.id;
      readStats(m.st, this.player.stats, this.dec);
      this.predictor.reset(m.pod, 0);
      this.welcomed = true;
    });
    r.onMessage(MSG.SNAP, (m: SnapMsg) => {
      this.snaps++;
      readStats(m.s, this.player.stats, this.dec);
      if (this.dec.deadTicks > 0) this.predictor.reset(m.p, m.a);
      else {
        const e = this.predictor.reconcile(m.p, m.a);
        this.errSum += e;
        this.errCount++;
        if (e > this.errMax) this.errMax = e;
      }
    });
    r.onMessage(MSG.TILES, (m: TilesMsg) => {
      for (let i = 0; i + 3 <= m.d.length; i += 3) this.world.applyChanges([{ tick: 0, x: m.d[i], y: m.d[i + 1], tile: m.d[i + 2] & 255, aux: m.d[i + 2] >> 8 }]);
    });
    r.onMessage(MSG.CHUNKS, (m: ChunksMsg) => {
      for (const [key, flat] of m.c) {
        const bx = (key % T.CHUNKS_X) * T.CHUNK;
        const by = Math.floor(key / T.CHUNKS_X) * T.CHUNK;
        for (let i = 0; i < flat.length; i += 2) {
          const v = flat[i + 1];
          this.world.applyChanges([{ tick: 0, x: bx + (flat[i] & 15), y: by + (flat[i] >> 4), tile: v & 255, aux: v >> 8 }]);
        }
      }
    });
    r.onMessage(MSG.EV, (m: EvMsg) => {
      for (let i = 0; i < m.d.length; i += EV_LEN[m.d[i]]) if (m.d[i] === EV_DEATH) this.deaths++;
    });
    for (const t of [MSG.LB, MSG.PONG, MSG.JOINED, MSG.LEFT, MSG.UNSUB, MSG.SAND]) r.onMessage(t, () => undefined);
    r.onLeave((code) => { if (!this.dropped) { this.dropped = true; if (code !== 1000) this.failed = `left unexpectedly (${code})`; } });
    r.onError((code, msg) => { this.failed = `room error ${code} ${msg ?? ''}`; });
    r.send(MSG.READY, {});
    const start = Date.now();
    while (!this.welcomed || this.snaps === 0) {
      if (Date.now() - start > 8000) throw new Error('no welcome/snapshot');
      await sleep(10);
    }
  }

  // Advances the bot by dtMs of wall time.
  drive(dtMs: number, now: number): void {
    if (this.dropped || !this.welcomed) return;
    this.acc += dtMs;
    let n = Math.floor(this.acc / (1000 / T.TICK_HZ));
    if (n > 4) { n = 4; this.acc = 0; } else this.acc -= n * (1000 / T.TICK_HZ);
    for (let i = 0; i < n; i++) {
      if (this.dec.deadTicks > 0 || this.predictor.pendingTicks >= T.net.clientMaxPendingTicks) break;
      if (this.maskTicks-- <= 0) this.pickMask();
      this.predictor.applyLocal(this.mask);
      if (++this.flushCount % T.net.clientSendEveryTicks === 0) this.flush();
    }
    if (now >= this.nextBuyAt) {
      this.nextBuyAt = now + 500 + Math.random() * 1500;
      const s = this.player.stats;
      for (let tries = 0; tries < 3; tries++) {
        const kind = UPGRADE_KINDS[Math.floor(Math.random() * UPGRADE_KINDS.length)];
        if (s.wallet >= upgradeCost(s.lvl[kind])) { this.room.send(MSG.BUY, { kind }); break; }
      }
    }
    if (now >= this.nextRadarAt) { this.nextRadarAt = now + 8000 + Math.random() * 6000; this.room.send(MSG.RADAR, {}); }
    if (now >= this.nextPingAt) { this.nextPingAt = now + T.net.pingEveryMs; this.room.send(MSG.PING, { t: now }); }
  }

  private flush(): void {
    this.predictor.flush((seq, ticks, m) => this.room.send(MSG.IN, { seq, ticks, mask: m }));
  }

  private pickMask(): void {
    const r = Math.random();
    if (r < 0.6) { this.mask = DOWN; this.maskTicks = 30 + Math.floor(Math.random() * 90); }
    else if (r < 0.8) { this.mask = Math.random() < 0.5 ? LEFT : RIGHT; this.maskTicks = 10 + Math.floor(Math.random() * 40); }
    else if (r < 0.9) { this.mask = UP | (Math.random() < 0.5 ? LEFT : RIGHT); this.maskTicks = 10 + Math.floor(Math.random() * 30); }
    else if (r < 0.95) { this.mask = UP; this.maskTicks = 15 + Math.floor(Math.random() * 30); }
    else { this.mask = 0; this.maskTicks = 5 + Math.floor(Math.random() * 20); }
  }

  get meanErr(): number {
    return this.errCount > 0 ? this.errSum / this.errCount : 0;
  }
}

async function reachable(httpUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function pct(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main(): Promise<number> {
  const parsed = new URL(URL_);
  const httpUrl = `${parsed.protocol === 'wss:' ? 'https' : 'http'}://${parsed.host}`;
  let gs: GameServer | null = null;
  if (!(await reachable(httpUrl))) {
    gs = createGameServer({ joinsPerWindow: 1_000_000, maxClients: T.net.maxClients });
    const port = await gs.listen(Number(parsed.port) || 2567);
    console.log(`[loadtest] no server at ${URL_}: started an in-process one on :${port}`);
  } else {
    console.log(`[loadtest] using the server at ${URL_} (it needs JOIN_LIMIT >= ${BOTS} for this many joins from one address)`);
  }

  console.log(`[loadtest] ${BOTS} bots for ${SECONDS} s`);
  const bots: Bot[] = [];
  let joinFailures = 0;
  const pending: Promise<void>[] = [];
  for (let i = 0; i < BOTS; i++) {
    const b = new Bot(i);
    bots.push(b);
    pending.push(b.join(URL_).catch((e: unknown) => { joinFailures++; b.dropped = true; b.failed = `join failed: ${e instanceof Error ? e.message : String(e)}`; }));
    if (i % 5 === 4) await sleep(60);
  }
  await Promise.all(pending);
  console.log(`[loadtest] joined ${BOTS - joinFailures}/${BOTS}`);

  // measure from here on
  await fetch(`${httpUrl}/stats?reset=1`).catch(() => undefined);
  for (const b of bots) { b.bytesIn = 0; b.bytesOut = 0; b.msgsIn = 0; b.snaps = 0; }
  const t0 = performance.now();
  let last = t0;
  const timer = setInterval(() => {
    const t = performance.now();
    const dt = t - last;
    last = t;
    for (const b of bots) b.drive(dt, t);
  }, 8);
  await sleep(SECONDS * 1000);
  clearInterval(timer);
  const secs = (performance.now() - t0) / 1000;
  const server = (await (await fetch(`${httpUrl}/stats`)).json()) as { ticks: number; avgMs: number; p95Ms: number; maxMs: number; snapshotsSent: number; players: number };

  const live = bots.filter((b) => b.welcomed);
  const failed = bots.filter((b) => b.failed !== null);
  const sum = (f: (b: Bot) => number): number => live.reduce((a, b) => a + f(b), 0);
  const kbIn = live.map((b) => b.bytesIn / 1024 / secs);
  const kbOut = live.map((b) => b.bytesOut / 1024 / secs);
  const errMean = live.length > 0 ? sum((b) => b.meanErr) / live.length : 0;
  const errMax = live.reduce((m, b) => Math.max(m, b.errMax), 0);
  const snapRate = live.length > 0 ? sum((b) => b.snaps) / live.length / secs : 0;
  const f = (v: number, d = 2): string => v.toFixed(d);

  const rows: Array<[string, string]> = [
    ['bots joined / requested', `${live.length} / ${BOTS}`],
    ['join failures', String(joinFailures)],
    ['bot errors / unexpected drops', String(failed.length)],
    ['deaths (total)', String(sum((b) => b.deaths))],
    ['server ticks measured', String(server.ticks)],
    ['server tick avg (ms)', f(server.avgMs, 3)],
    ['server tick p95 (ms)', f(server.p95Ms, 3)],
    ['server tick max (ms)', f(server.maxMs, 3)],
    ['bytes/s in to bots, total (KB/s)', f(kbIn.reduce((a, v) => a + v, 0))],
    ['bytes/s out from bots, total (KB/s)', f(kbOut.reduce((a, v) => a + v, 0))],
    ['per client in (KB/s) avg / p95 / max', `${f(kbIn.reduce((a, v) => a + v, 0) / Math.max(1, kbIn.length))} / ${f(pct(kbIn, 0.95))} / ${f(Math.max(0, ...kbIn))}`],
    ['per client out (KB/s) avg / max', `${f(kbOut.reduce((a, v) => a + v, 0) / Math.max(1, kbOut.length))} / ${f(Math.max(0, ...kbOut))}`],
    ['snapshots/s per client', f(snapRate, 1)],
    ['messages/s in per client', f(sum((b) => b.msgsIn) / Math.max(1, live.length) / secs, 1)],
    ['prediction error mean / max (tiles)', `${f(errMean, 4)} / ${f(errMax, 3)}`],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  console.log('\n' + rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`).join('\n') + '\n');
  for (const b of failed.slice(0, 5)) console.log(`  bot ${b.index}: ${b.failed}`);

  for (const b of bots) { b.dropped = true; try { await Promise.race([b.room?.leave(true), sleep(200)]); } catch { /* closed */ } }
  if (gs !== null) await gs.stop();

  let code = 0;
  if (server.p95Ms > P95_LIMIT_MS) { console.log(`FAIL: p95 server tick ${server.p95Ms} ms > ${P95_LIMIT_MS} ms`); code = 1; }
  if (failed.length > 0 || joinFailures > 0) { console.log('FAIL: bots errored'); code = 1; }
  const worstKb = Math.max(0, ...kbIn);
  if (worstKb > KB_LIMIT) console.log(`WARN: a client received ${f(worstKb)} KB/s (> ${KB_LIMIT})`);
  if (code === 0) console.log('PASS');
  return code;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
