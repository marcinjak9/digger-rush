import { Client, type Room } from 'colyseus.js';
import {
  BUY_OK, BUY_BAD, BUY_COOLDOWN, BUY_DEAD, BUY_FUNDS, BUY_MAX, EV_BUY, EV_DEATH, EV_DIG, EV_HEAL, EV_LEN, EV_RESPAWN, UPGRADE_KINDS, MSG, OF_DEAD, OF_DRILLING, OF_FACE_DOWN, OF_FACE_RIGHT, OF_INVULN, OF_THRUSTING,
  OTHER_STRIDE, ROOM_NAME, SAND_CALM, SAND_FALL, SAND_HIT, SAND_LAND, SAND_WOBBLE, SIM_VERSION, T, Tile, TILES, World,
  Predictor, chunkCx, chunkCy, newPlayer, newPod, packInput, radarCooldownTicksOf, readStats,
  type BuyResult, type ChunksMsg, type DecodedStats, type EvMsg, type JoinedMsg, type LbMsg, type LeftMsg, type PodInput,
  type PongMsg, type SandEvent, type SandMsg, type SimDug, type SimPlayer, type SnapMsg, type TileChange, type TilesMsg,
  type UnsubMsg, type UpgradeKind, type WelcomeMsg,
} from '@digger/shared';
import type { BoardData, ConnectionStatus, FrameFx, GameSession, NetDebug, RemoteView, SandView } from '../session.js';
import { loadRoomId, loadToken, saveRoomId } from './storage.js';
import { nickColor } from './color.js';

const MAX_STEPS_PER_FRAME = 6;
const MS_PER_SERVER_TICK_DEFAULT = 1000 / T.net.serverHz;
const SAND_VISUAL_MAX_AGE = 60 * T.TICK_HZ;

function buyText(ki: number, code: number): string {
  const name = ki >= 0 && ki < UPGRADE_KINDS.length ? UPGRADE_KINDS[ki] : 'upgrade';
  switch (code) {
    case BUY_OK: return `Bought ${name}`;
    case BUY_FUNDS: return 'Not enough money';
    case BUY_MAX: return 'Already at the maximum level';
    case BUY_DEAD: return 'You are dead';
    case BUY_COOLDOWN: return 'Slow down';
    case BUY_BAD: return 'Unknown upgrade';
    default: return '';
  }
}

export function serverUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const v = env?.VITE_SERVER_URL;
  if (v !== undefined && v !== '') return v;
  const host = typeof location !== 'undefined' && location.hostname !== '' ? location.hostname : 'localhost';
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${host}:2567`;
}

interface SandVisual extends SandView {
  age: number;
}

// Interpolation samples of one other player.
class Remote {
  readonly view: RemoteView;
  private readonly n = T.net.snapBufferLen;
  private readonly ts = new Float64Array(this.n);
  private readonly xs = new Float64Array(this.n);
  private readonly ys = new Float64Array(this.n);
  private readonly flags = new Int32Array(this.n);
  private readonly hulls = new Float64Array(this.n);
  private head = 0; // next write slot
  private count = 0;
  lastSeen = 0;

  constructor(id: number, nick: string) {
    this.view = {
      id, nick, color: nickColor(nick), x: 0, y: 0, faceRight: true, faceDown: false, drilling: false,
      thrusting: false, dead: false, invuln: false, hull: 1,
    };
  }

  push(t: number, x: number, y: number, flags: number, hull: number): void {
    const i = this.head;
    this.ts[i] = t;
    this.xs[i] = x;
    this.ys[i] = y;
    this.flags[i] = flags;
    this.hulls[i] = hull;
    this.head = (i + 1) % this.n;
    if (this.count < this.n) this.count++;
  }

  // Samples are pushed in time order; the newest is at head - 1.
  sample(renderT: number): void {
    const n = this.n;
    const c = this.count;
    if (c === 0) return;
    let newer = (this.head - 1 + n) % n;
    if (renderT >= this.ts[newer] || c === 1) {
      this.apply(newer, newer, 0);
      return;
    }
    // walk back to the sample at or before renderT
    for (let k = 1; k < c; k++) {
      const older = (this.head - 1 - k + n * 2) % n;
      if (this.ts[older] <= renderT) {
        const span = this.ts[newer] - this.ts[older];
        this.apply(older, newer, span > 0 ? (renderT - this.ts[older]) / span : 1);
        return;
      }
      newer = older;
    }
    const oldest = (this.head - c + n) % n;
    this.apply(oldest, oldest, 0);
  }

  private apply(a: number, b: number, f: number): void {
    const v = this.view;
    const dx = this.xs[b] - this.xs[a];
    const dy = this.ys[b] - this.ys[a];
    const jump = dx > 6 || dx < -6 || dy > 6 || dy < -6; // respawn: do not slide across the map
    const k = jump ? 1 : f;
    v.x = this.xs[a] + dx * k;
    v.y = this.ys[a] + dy * k;
    const fl = this.flags[f >= 0.5 || jump ? b : a];
    v.faceRight = (fl & OF_FACE_RIGHT) !== 0;
    v.faceDown = (fl & OF_FACE_DOWN) !== 0;
    v.drilling = (fl & OF_DRILLING) !== 0;
    v.thrusting = (fl & OF_THRUSTING) !== 0;
    v.dead = (fl & OF_DEAD) !== 0;
    v.invuln = (fl & OF_INVULN) !== 0;
    v.hull = this.hulls[b];
  }
}

export class NetSession implements GameSession {
  readonly world = new World(T.SEED);
  readonly player: SimPlayer = {
    id: 0, pod: newPod(0, 0), stats: newPlayer(0), spawnSalt: 0, deadTicks: 0, invulnTicks: 0, finalScore: 0,
  };
  readonly fx: FrameFx = {
    dug: [], sand: [], changes: [], hardLandVy: 0, softLandVy: 0, damage: 0, died: false, respawned: false, healed: false,
  };
  readonly prev = { x: 0, y: 0 };
  readonly sandBlocks: SandVisual[] = [];
  readonly remotes: RemoteView[] = [];
  readonly net: NetDebug = { pingMs: 0, players: 1, correction: 0, pendingTicks: 0, snapsPerSec: 0 };
  readonly nickname: string;
  tick = 0;
  radarPings = 0;
  status: ConnectionStatus = 'ok';
  statusText = '';

  private readonly predictor: Predictor;
  private readonly client: Client;
  private readonly token: string;
  private room: Room | null = null;
  private acc = 0;
  private sinceFlush = 0;
  private myId = 0;
  private roomId = '';
  private dec: DecodedStats = { deadTicks: 0, invulnTicks: 0, finalScore: 0 };
  private pendDug: SimDug[] = [];
  private pendChanges: TileChange[] = [];
  private pendSand: SandEvent[] = [];
  private pendDamage = 0;
  private pendDied = false;
  private pendRespawned = false;
  private pendHealed = false;
  readonly buyFeedback = { seq: 0, text: '' };
  private readonly remoteMap = new Map<number, Remote>();
  private readonly nicks = new Map<number, string>();
  private board: BoardData = { rows: [], rank: 1, count: 1, hi: 0, sc: 0 };
  private clockOffset = Number.NaN;
  private msPerTick = MS_PER_SERVER_TICK_DEFAULT;
  private snapCount = 0;
  private snapWindowStart = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private onWelcome: ((m: WelcomeMsg) => void) | null = null;
  private closed = false;
  private lastSnapT = -1;

  constructor(nickname: string) {
    this.nickname = nickname;
    this.token = loadToken();
    this.client = new Client(serverUrl());
    this.predictor = new Predictor(this.world, this.player.pod, this.player.stats.lvl);
  }

  // Joins (or rejoins) a room and resolves after the welcome message. Rejects with a readable message.
  static async connect(nickname: string): Promise<NetSession> {
    const s = new NetSession(nickname);
    await s.join(true);
    s.pingTimer = setInterval(() => s.sendPing(), T.net.pingEveryMs);
    return s;
  }

  // ------------------------------------------------------------------ connection

  private async join(allowFallback: boolean): Promise<void> {
    const opts = { nickname: this.nickname, token: this.token, simVersion: SIM_VERSION };
    const saved = loadRoomId();
    let room: Room | null = null;
    if (saved !== '') {
      try {
        room = await this.client.joinById(saved, opts);
      } catch (e) {
        if (!allowFallback) throw e;
        room = null;
      }
    }
    if (room === null) {
      if (!allowFallback && saved === '') throw new Error('no room to rejoin');
      room = await this.client.joinOrCreate(ROOM_NAME, opts);
    }
    this.attach(room);
    const welcome = await new Promise<WelcomeMsg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The server did not answer.')), 8000);
      this.onWelcome = (m) => { clearTimeout(timer); resolve(m); };
      room.send(MSG.READY, {});
    });
    this.handleWelcome(welcome);
  }

  private attach(room: Room): void {
    this.room = room;
    room.onMessage(MSG.WELCOME, (m: WelcomeMsg) => this.onWelcome?.(m));
    room.onMessage(MSG.SNAP, (m: SnapMsg) => this.onSnap(m));
    room.onMessage(MSG.TILES, (m: TilesMsg) => this.onTiles(m));
    room.onMessage(MSG.CHUNKS, (m: ChunksMsg) => this.onChunks(m));
    room.onMessage(MSG.UNSUB, (m: UnsubMsg) => this.onUnsub(m));
    room.onMessage(MSG.SAND, (m: SandMsg) => this.onSand(m));
    room.onMessage(MSG.EV, (m: EvMsg) => this.onEv(m));
    room.onMessage(MSG.JOINED, (m: JoinedMsg) => this.onJoined(m));
    room.onMessage(MSG.LEFT, (m: LeftMsg) => this.onLeft(m));
    room.onMessage(MSG.LB, (m: LbMsg) => this.onLb(m));
    room.onMessage(MSG.PONG, (m: PongMsg) => { this.net.pingMs = Math.round(performance.now() - m.t); });
    room.onLeave((code) => {
      if (room !== this.room || this.closed) return;
      this.room = null;
      if (code === 4403) this.fail('Opened in another tab.');
      else void this.reconnect();
    });
    room.onError(() => { /* the leave handler deals with it */ });
  }

  private fail(text: string): void {
    this.status = 'lost';
    this.statusText = text;
    this.closed = true;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
  }

  private async reconnect(): Promise<void> {
    if (this.status !== 'ok') return;
    this.status = 'reconnecting';
    this.statusText = 'Reconnecting...';
    const start = performance.now();
    while (!this.closed && performance.now() - start < T.net.reconnectWindowMs) {
      try {
        await this.join(false);
        this.status = 'ok';
        this.statusText = '';
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/version|token|nickname/i.test(msg)) break;
        if (/not found|expired|locked|full/i.test(msg)) {
          // The room is gone (server restarted or the window passed): carry on as a new player.
          const before = this.roomId;
          try {
            await this.join(true);
          } catch { await new Promise((r) => setTimeout(r, T.net.reconnectRetryMs)); continue; }
          if (this.roomId !== before) {
            // A different world: what is on screen is stale. Start over from the start screen.
            this.fail('The server restarted. Reload the page to play again.');
            try { void this.room?.leave(); } catch { /* ignore */ }
            return;
          }
          this.status = 'ok';
          this.statusText = '';
          return;
        }
        await new Promise((r) => setTimeout(r, T.net.reconnectRetryMs));
      }
    }
    if (!this.closed) this.fail('Connection lost. Reload the page to play again.');
  }

  private sendPing(): void {
    if (this.status !== 'ok' || this.room === null) return;
    try { this.room.send(MSG.PING, { t: performance.now() }); } catch { /* socket closing */ }
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    try { void this.room?.leave(); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ server messages

  private handleWelcome(m: WelcomeMsg): void {
    if (m.simVersion !== SIM_VERSION) throw new Error('Your game version is out of date. Please reload the page.');
    if (m.seed !== this.world.seed) throw new Error('World seed mismatch. Please reload the page.');
    this.myId = m.id;
    this.player.id = m.id;
    this.roomId = m.roomId;
    saveRoomId(m.roomId);
    this.msPerTick = 1000 / m.serverHz;
    readStats(m.st, this.player.stats, this.dec);
    this.applyDecoded();
    this.predictor.reset(m.pod, 0);
    this.prev.x = this.player.pod.x;
    this.prev.y = this.player.pod.y;
    this.sandBlocks.length = 0;
    this.remoteMap.clear();
    this.remotes.length = 0;
    this.nicks.clear();
    this.clockOffset = Number.NaN;
    this.lastSnapT = -1;
    this.sinceFlush = 0;
  }

  private applyDecoded(): void {
    this.player.deadTicks = this.dec.deadTicks;
    this.player.invulnTicks = this.dec.invulnTicks;
    this.player.finalScore = this.dec.finalScore;
  }

  private onSnap(m: SnapMsg): void {
    const now = performance.now();
    const st = this.player.stats;
    const wasDead = this.player.deadTicks > 0;
    const hullBefore = st.hull;
    readStats(m.s, st, this.dec);
    this.applyDecoded();
    const dead = this.player.deadTicks > 0;
    if (!dead && !wasDead && st.hull < hullBefore) this.pendDamage += hullBefore - st.hull;
    if (dead || wasDead) {
      this.predictor.reset(m.p, m.a);
      this.prev.x = this.player.pod.x;
      this.prev.y = this.player.pod.y;
    } else {
      const px = this.player.pod.x;
      const py = this.player.pod.y;
      const err = this.predictor.reconcile(m.p, m.a);
      this.net.correction = err;
      if (err > 2) {
        this.prev.x = this.player.pod.x;
        this.prev.y = this.player.pod.y;
      } else {
        this.prev.x += this.player.pod.x - px;
        this.prev.y += this.player.pod.y - py;
      }
    }
    // clock estimate for interpolation: follow the fastest arrivals, drift up slowly
    const serverMs = m.t * this.msPerTick;
    const d = now - serverMs;
    if (Number.isNaN(this.clockOffset) || d < this.clockOffset) this.clockOffset = d;
    else this.clockOffset += (d - this.clockOffset) * 0.02;
    this.lastSnapT = m.t;
    const o = m.o;
    for (let i = 0; i + OTHER_STRIDE <= o.length; i += OTHER_STRIDE) {
      const id = o[i];
      let r = this.remoteMap.get(id);
      if (r === undefined) {
        r = new Remote(id, this.nicks.get(id) ?? '...');
        this.remoteMap.set(id, r);
        this.remotes.push(r.view);
      }
      r.push(serverMs, o[i + 1] / T.QUANT, o[i + 2] / T.QUANT, o[i + 3], o[i + 4] / 255);
      r.lastSeen = m.t;
    }
    this.snapCount++;
    if (now - this.snapWindowStart >= 1000) {
      this.net.snapsPerSec = (this.snapCount * 1000) / (now - this.snapWindowStart);
      this.snapCount = 0;
      this.snapWindowStart = now;
    }
  }

  private writeTile(x: number, y: number, v: number): void {
    const ch: TileChange = { tick: 0, x, y, tile: v & 255, aux: v >> 8 };
    this.world.applyChanges([ch]);
    this.pendChanges.push(ch);
  }

  private onTiles(m: TilesMsg): void {
    const d = m.d;
    for (let i = 0; i + 3 <= d.length; i += 3) this.writeTile(d[i], d[i + 1], d[i + 2]);
  }

  private onChunks(m: ChunksMsg): void {
    for (const [key, flat] of m.c) {
      const bx = chunkCx(key) * T.CHUNK;
      const by = chunkCy(key) * T.CHUNK;
      for (let i = 0; i + 2 <= flat.length; i += 2) {
        const idx = flat[i];
        this.writeTile(bx + (idx & 15), by + (idx >> 4), flat[i + 1]);
      }
    }
  }

  private onUnsub(m: UnsubMsg): void {
    // Unmodified-by-us chunks regenerate from the seed if they are ever needed again.
    for (const key of m.k) this.world.chunks.delete(key);
  }

  private findVisual(x: number, y: number, falling: boolean): SandVisual | null {
    for (const b of this.sandBlocks) if (b.falling === falling && b.x === x && b.y === y) return b;
    return null;
  }

  // Nearest falling visual in column x to row y.
  private nearestFalling(x: number, y: number): number {
    let best = -1;
    let bd = 1e9;
    for (let i = 0; i < this.sandBlocks.length; i++) {
      const b = this.sandBlocks[i];
      if (!b.falling || b.x !== x) continue;
      const d = Math.abs(b.y - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  private removeVisual(i: number): void {
    const last = this.sandBlocks.length - 1;
    this.sandBlocks[i] = this.sandBlocks[last];
    this.sandBlocks.pop();
  }

  private onSand(m: SandMsg): void {
    const d = m.d;
    for (let i = 0; i + 3 <= d.length; i += 3) {
      const kind = d[i];
      const fx = d[i + 1];
      const fy = d[i + 2];
      const x = Math.floor(fx);
      const y = Math.floor(fy);
      switch (kind) {
        case SAND_WOBBLE:
          this.pendSand.push({ kind: 'wobble', tick: 0, x, y });
          if (this.findVisual(x, y, false) === null) {
            const tile = this.world.get(x, y);
            this.sandBlocks.push({ x, y, tile: TILES[tile].falls ? tile : Tile.SAND, t: 0, falling: false, acc: 0, age: 0 });
          }
          break;
        case SAND_FALL: {
          this.pendSand.push({ kind: 'fall', tick: 0, x, y });
          const w = this.findVisual(x, y, false);
          if (w !== null) {
            w.falling = true;
            w.acc = 0;
            w.age = 0;
          } else {
            this.sandBlocks.push({ x, y, tile: Tile.SAND, t: 0, falling: true, acc: 0, age: 0 });
          }
          break;
        }
        case SAND_LAND: {
          this.pendSand.push({ kind: 'land', tick: 0, x, y });
          const k = this.nearestFalling(x, y);
          if (k >= 0) this.removeVisual(k);
          break;
        }
        case SAND_HIT: {
          this.pendSand.push({ kind: 'hit', tick: 0, x: fx, y: fy, podId: 0, damage: 0 });
          const k = this.nearestFalling(x, y);
          if (k >= 0) this.removeVisual(k);
          break;
        }
        case SAND_CALM: {
          const w = this.findVisual(x, y, false);
          if (w !== null) this.removeVisual(this.sandBlocks.indexOf(w));
          break;
        }
        default:
          break;
      }
    }
  }

  private onEv(m: EvMsg): void {
    const d = m.d;
    for (let i = 0; i < d.length;) {
      const kind = d[i];
      if (kind === EV_DIG) {
        const v = d[i + 3];
        this.pendDug.push({ id: this.myId, x: d[i + 1], y: d[i + 2], tile: v & 255, aux: v >> 8 });
      } else if (kind === EV_DEATH) {
        this.pendDied = true;
      } else if (kind === EV_RESPAWN) {
        this.pendRespawned = true;
      } else if (kind === EV_HEAL) {
        this.pendHealed = true;
      } else if (kind === EV_BUY) {
        // the server's verdict; the new wallet / level arrive in the next snapshot
        this.buyFeedback.seq++;
        this.buyFeedback.text = buyText(d[i + 1], d[i + 2]);
      }
      const len = EV_LEN[kind];
      if (len === undefined) break;
      i += len;
    }
  }

  private onJoined(m: JoinedMsg): void {
    this.nicks.set(m.id, m.nick);
    const r = this.remoteMap.get(m.id);
    if (r !== undefined) {
      r.view.nick = m.nick;
      r.view.color = nickColor(m.nick);
    }
  }

  private onLeft(m: LeftMsg): void {
    this.nicks.delete(m.id);
    const r = this.remoteMap.get(m.id);
    if (r === undefined) return;
    this.remoteMap.delete(m.id);
    const i = this.remotes.indexOf(r.view);
    if (i >= 0) this.remotes.splice(i, 1);
  }

  private onLb(m: LbMsg): void {
    this.board = {
      rows: m.top.map(([name, score, id]) => ({ name, score, me: id === this.myId })),
      hi: m.hi,
      sc: m.sc,
      rank: m.rank,
      count: m.n,
    };
    this.net.players = m.n;
  }

  // ------------------------------------------------------------------ GameSession

  get alpha(): number {
    return this.acc * T.TICK_HZ;
  }
  get dead(): boolean {
    return this.player.deadTicks > 0;
  }
  get respawnLeftSec(): number {
    return this.player.deadTicks / T.TICK_HZ;
  }
  get invulnerable(): boolean {
    return this.player.invulnTicks > 0;
  }
  get finalScore(): number {
    return this.player.finalScore;
  }
  get latencyLabel(): string {
    if (this.status === 'reconnecting') return 'reconnecting...';
    if (this.status === 'lost') return 'offline';
    return `${this.net.pingMs} ms`;
  }

  advance(dtSec: number, input: PodInput): void {
    const fx = this.fx;
    // hand the buffers filled by the message handlers to the renderer
    const dug = fx.dug;
    fx.dug = this.pendDug;
    this.pendDug = dug;
    this.pendDug.length = 0;
    const sand = fx.sand;
    fx.sand = this.pendSand;
    this.pendSand = sand;
    this.pendSand.length = 0;
    const ch = fx.changes;
    fx.changes = this.pendChanges;
    this.pendChanges = ch;
    this.pendChanges.length = 0;
    fx.damage = this.pendDamage;
    fx.died = this.pendDied;
    fx.respawned = this.pendRespawned;
    fx.healed = this.pendHealed;
    this.pendHealed = false;
    this.pendDamage = 0;
    this.pendDied = false;
    this.pendRespawned = false;
    fx.hardLandVy = 0;
    fx.softLandVy = 0;

    this.acc += dtSec > 0.25 ? 0.25 : dtSec;
    let steps = 0;
    while (this.acc >= T.DT) {
      this.acc -= T.DT;
      if (steps++ >= MAX_STEPS_PER_FRAME) {
        this.acc = 0;
        break;
      }
      this.step(input);
    }
    // predicted digs and corrections made by local stepping / reconciling are recorded by the world
    const own = this.world.drainChanges();
    for (const c of own) fx.changes.push(c);

    this.net.pendingTicks = this.predictor.pendingTicks;
    this.updateRemotes();
  }

  private step(input: PodInput): void {
    this.tick++;
    const pod = this.player.pod;
    this.prev.x = pod.x;
    this.prev.y = pod.y;
    this.stepSand();
    if (this.status !== 'ok' || this.room === null || this.player.deadTicks > 0) return;
    if (this.predictor.pendingTicks >= T.net.clientMaxPendingTicks) return; // server is behind: wait
    const vyBefore = pod.vy;
    this.predictor.applyLocal(packInput(input));
    if (vyBefore > 4 && pod.vy === 0 && pod.grounded) {
      if (vyBefore > T.hardLandSpeed) this.fx.hardLandVy = vyBefore;
      else this.fx.softLandVy = vyBefore;
    }
    if (++this.sinceFlush >= T.net.clientSendEveryTicks) this.flush();
  }

  private flush(): void {
    this.sinceFlush = 0;
    const room = this.room;
    if (room === null) return;
    this.predictor.flush((seq, ticks, mask) => {
      try { room.send(MSG.IN, { seq, ticks, mask }); } catch { /* socket closing; the leave handler reconnects */ }
    });
  }

  // Animates the sand visuals at 60 Hz: wobble time, fall position.
  private stepSand(): void {
    const w = this.world;
    for (let i = this.sandBlocks.length - 1; i >= 0; i--) {
      const b = this.sandBlocks[i] as SandVisual;
      if (++b.age > SAND_VISUAL_MAX_AGE) { this.removeVisual(i); continue; }
      if (b.falling) {
        if (w.get(b.x, b.y + 1) !== Tile.EMPTY) {
          b.acc = 0; // resting on something; the land event removes the visual
        } else {
          b.acc += T.fallTickDeci;
          if (b.acc >= T.fallStepDeci) {
            b.acc -= T.fallStepDeci;
            b.y++;
          }
        }
      } else {
        if (!TILES[w.get(b.x, b.y)].falls) { this.removeVisual(i); continue; } // dug out from under it
        b.t++;
      }
    }
  }

  private updateRemotes(): void {
    if (Number.isNaN(this.clockOffset)) return;
    const renderT = performance.now() - this.clockOffset - T.net.interpDelayMs;
    for (const r of this.remoteMap.values()) {
      if (this.lastSnapT - r.lastSeen > 2) {
        // not in the latest snapshots any more (out of range): drop it
        this.remoteMap.delete(r.view.id);
        const i = this.remotes.indexOf(r.view);
        if (i >= 0) this.remotes.splice(i, 1);
        continue;
      }
      r.sample(renderT);
    }
  }

  useRadar(): 'ok' | 'cooldown' | 'dead' {
    if (this.dead) return 'dead';
    const st = this.player.stats;
    if (st.radarTicks > 0 || this.room === null) return 'cooldown';
    st.radarTicks = radarCooldownTicksOf(st.lvl.radar);
    this.radarPings++;
    try { this.room.send(MSG.RADAR, {}); } catch { /* reconnecting */ }
    return 'ok';
  }

  // Sends the request; whether it worked is decided by the server (EV_BUY, then the snapshot). Nothing is
  // spent or changed locally.
  buy(kind: UpgradeKind): BuyResult | 'dead' {
    if (this.dead) return 'dead';
    if (this.room === null) return 'funds';
    try { this.room.send(MSG.BUY, { kind }); } catch { /* reconnecting */ }
    return 'ok';
  }

  getBoard(): BoardData {
    return this.board;
  }
}
