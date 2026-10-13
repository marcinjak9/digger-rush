import { Client, type Room } from 'colyseus.js';
import {
  MSG, Predictor, ROOM_NAME, SIM_VERSION, T, World, newPlayer, newPod, readStats, EV_DIG, EV_LEN,
  type ChunksMsg, type DecodedStats, type EvMsg, type JoinedMsg, type LbMsg, type PongMsg, type SnapMsg,
  type TileChange, type TilesMsg, type WelcomeMsg, type SimPlayer,
} from '@digger/shared';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs = 4000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

let tokenCounter = 0;
export function makeToken(): string {
  return `test-token-${Date.now().toString(36)}-${(tokenCounter++).toString(36)}-abcdefgh`;
}

// A headless client speaking the real protocol, with the shared Predictor (what the browser client does).
export const opened: TestClient[] = [];

export class TestClient {
  room!: Room;
  welcome!: WelcomeMsg;
  readonly world = new World(T.SEED);
  readonly player: SimPlayer = {
    id: 0, pod: newPod(0, 0), stats: newPlayer(0), spawnSalt: 0, deadTicks: 0, invulnTicks: 0, finalScore: 0,
  };
  readonly predictor: Predictor;
  readonly dec: DecodedStats = { deadTicks: 0, invulnTicks: 0, finalScore: 0 };
  lastSnap: SnapMsg | null = null;
  snaps = 0;
  maxError = 0;
  tiles: TileChange[] = [];
  chunkMsgs: ChunksMsg[] = [];
  digEvents = 0;
  lb: LbMsg | null = null;
  pongs: number[] = [];
  joined: JoinedMsg[] = [];
  private flushCount = 0;
  private closed = false;

  constructor(readonly nickname: string, readonly token: string) {
    this.predictor = new Predictor(this.world, this.player.pod, this.player.stats.lvl);
  }

  static async join(
    url: string, nickname: string, token = makeToken(), roomId?: string, ready = true,
  ): Promise<TestClient> {
    const c = new TestClient(nickname, token);
    opened.push(c);
    const client = new Client(url);
    const opts = { nickname, token, simVersion: SIM_VERSION };
    c.room = roomId !== undefined ? await client.joinById(roomId, opts) : await client.joinOrCreate(ROOM_NAME, opts);
    c.attach();
    if (ready) await c.ready();
    return c;
  }

  private attach(): void {
    const r = this.room;
    r.onMessage(MSG.WELCOME, (m: WelcomeMsg) => {
      this.welcome = m;
      this.player.id = m.id;
      readStats(m.st, this.player.stats, this.dec);
      this.predictor.reset(m.pod, 0);
    });
    r.onMessage(MSG.SNAP, (m: SnapMsg) => {
      this.lastSnap = m;
      this.snaps++;
      readStats(m.s, this.player.stats, this.dec);
      const err = this.predictor.reconcile(m.p, m.a);
      if (err > this.maxError) this.maxError = err;
    });
    r.onMessage(MSG.TILES, (m: TilesMsg) => {
      for (let i = 0; i + 3 <= m.d.length; i += 3) {
        const ch = { tick: 0, x: m.d[i], y: m.d[i + 1], tile: m.d[i + 2] & 255, aux: m.d[i + 2] >> 8 };
        this.tiles.push(ch);
        this.world.applyChanges([ch]);
      }
    });
    r.onMessage(MSG.CHUNKS, (m: ChunksMsg) => {
      this.chunkMsgs.push(m);
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
      for (let i = 0; i < m.d.length; i += EV_LEN[m.d[i]]) if (m.d[i] === EV_DIG) this.digEvents++;
    });
    r.onMessage(MSG.LB, (m: LbMsg) => { this.lb = m; });
    r.onMessage(MSG.PONG, (m: PongMsg) => { this.pongs.push(m.t); });
    r.onMessage(MSG.JOINED, (m: JoinedMsg) => { this.joined.push(m); });
    for (const t of [MSG.LEFT, MSG.UNSUB, MSG.SAND]) r.onMessage(t, () => undefined);
  }

  async ready(): Promise<void> {
    this.room.send(MSG.READY, {});
    await waitFor(() => this.welcome !== undefined && this.snaps > 0, 4000, 'welcome + first snapshot');
  }

  // Steps the predictor n ticks with a mask, sending commands every second tick (like the browser).
  step(n: number, mask: number): void {
    for (let i = 0; i < n; i++) {
      this.predictor.applyLocal(mask);
      if (++this.flushCount % 2 === 0) this.flush();
    }
  }

  flush(): void {
    this.predictor.flush((seq, ticks, m) => this.room.send(MSG.IN, { seq, ticks, mask: m }));
  }

  // Waits until the server has acknowledged everything sent.
  async settle(): Promise<void> {
    this.flush();
    await waitFor(() => this.predictor.pendingTicks === 0, 6000, 'all inputs acknowledged');
    const target = this.snaps + 2;
    await waitFor(() => this.snaps >= target, 2000, 'two more snapshots');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await Promise.race([this.room.leave(true), sleep(300)]); } catch { /* already closed */ }
  }
}
