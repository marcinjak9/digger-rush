import {
  T, Tile, World, SandSim, simTick, createPlayer, newPlayer, buyUpgrade, tryRadar, NO_INPUT,
  type PodInput, type SimPlayer, type SimDug, type SandEvent, type TileChange, type UpgradeKind, type BuyResult,
} from '@digger/shared';

export interface FrameFx {
  dug: SimDug[];
  sand: SandEvent[];
  changes: TileChange[];
  hardLandVy: number; // > 0 when a hard landing happened this frame
  softLandVy: number; // > 0 on an ordinary landing
  damage: number; // hull lost this frame (after armor)
  died: boolean;
  respawned: boolean;
  healed: boolean; // heal ore was mined (server confirmed in net mode)
}

// What the renderer needs to draw one sand block (a SandSim block, or a client side animation).
export interface SandView {
  x: number;
  y: number;
  tile: number;
  t: number; // wobble ticks elapsed
  falling: boolean;
  acc: number; // tenths of a tick toward the next cell while falling
}

// Another player's pod, interpolated for drawing.
export interface RemoteView {
  id: number;
  nick: string;
  color: string;
  x: number;
  y: number;
  faceRight: boolean;
  faceDown: boolean;
  drilling: boolean;
  thrusting: boolean;
  dead: boolean;
  invuln: boolean;
  hull: number; // 0..1
}

export interface BoardData {
  rows: Array<{ name: string; score: number; me: boolean }>;
  rank: number;
  count: number;
  hi: number; // own highScore
  sc: number; // own current score
}

export interface NetDebug {
  pingMs: number;
  players: number;
  correction: number; // last reconcile error in tiles
  pendingTicks: number;
  snapsPerSec: number;
}

export type ConnectionStatus = 'local' | 'ok' | 'reconnecting' | 'lost';

// Everything the renderer / UI needs from a running game. LocalSession runs the sim in the browser;
// NetSession (net/) predicts against a server and reconciles.
export interface GameSession {
  readonly world: World;
  readonly sandBlocks: readonly SandView[];
  readonly remotes: readonly RemoteView[];
  readonly player: SimPlayer;
  readonly nickname: string;
  readonly fx: FrameFx;
  readonly prev: { x: number; y: number };
  readonly alpha: number; // 0..1 interpolation between prev and current pod position
  readonly dead: boolean;
  readonly respawnLeftSec: number;
  readonly invulnerable: boolean;
  readonly finalScore: number;
  readonly tick: number;
  readonly latencyLabel: string;
  readonly status: ConnectionStatus;
  readonly statusText: string;
  readonly net: NetDebug | null;
  /** Advances real time; steps the fixed-rate sim zero or more times. */
  advance(dtSec: number, input: PodInput): void;
  /** Number of radar pulses fired so far; the renderer reacts when it changes. */
  readonly radarPings: number;
  buy(kind: UpgradeKind): BuyResult | 'dead';
  useRadar(): 'ok' | 'cooldown' | 'dead';
  getBoard(): BoardData;
  /** Latest purchase verdict; `seq` changes whenever a new one arrives. */
  readonly buyFeedback: { seq: number; text: string };
}

const MAX_STEPS_PER_FRAME = 6;

export class LocalSession implements GameSession {
  readonly world = new World(T.SEED);
  readonly sand = new SandSim();
  readonly player: SimPlayer;
  readonly nickname: string;
  readonly fx: FrameFx = {
    dug: [], sand: [], changes: [], hardLandVy: 0, softLandVy: 0, damage: 0, died: false, respawned: false, healed: false,
  };
  readonly prev = { x: 0, y: 0 };
  readonly latencyLabel = 'local';
  readonly remotes: readonly RemoteView[] = [];
  readonly status: ConnectionStatus = 'local';
  readonly statusText = '';
  readonly net = null;
  readonly buyFeedback = { seq: 0, text: '' };
  tick = 0;
  radarPings = 0;
  private acc = 0;
  private readonly inputs = new Map<number, PodInput>();
  private static readonly ID = 1;

  constructor(nickname: string, spawnSalt = (Date.now() & 0x3fffffff)) {
    this.nickname = nickname;
    this.player = createPlayer(LocalSession.ID, newPlayer(0), this.world, spawnSalt);
    this.prev.x = this.player.pod.x;
    this.prev.y = this.player.pod.y;
  }

  get sandBlocks(): readonly SandView[] {
    return this.sand.blocks;
  }
  get dead(): boolean {
    return this.player.deadTicks > 0;
  }
  get finalScore(): number {
    return this.player.finalScore;
  }
  get alpha(): number {
    return this.acc * T.TICK_HZ;
  }
  get respawnLeftSec(): number {
    return this.player.deadTicks / T.TICK_HZ;
  }
  get invulnerable(): boolean {
    return this.player.invulnTicks > 0;
  }

  advance(dtSec: number, input: PodInput): void {
    const fx = this.fx;
    fx.dug.length = 0;
    fx.sand.length = 0;
    fx.hardLandVy = 0;
    fx.softLandVy = 0;
    fx.damage = 0;
    fx.died = false;
    fx.respawned = false;
    fx.healed = false;
    this.acc += dtSec > 0.25 ? 0.25 : dtSec;
    let steps = 0;
    while (this.acc >= T.DT) {
      this.acc -= T.DT;
      if (steps++ >= MAX_STEPS_PER_FRAME) {
        this.acc = 0; // drop the backlog instead of spiralling
        break;
      }
      this.step(input);
    }
    fx.changes = this.world.drainChanges();
  }

  private step(input: PodInput): void {
    const fx = this.fx;
    const pl = this.player;
    const pod = pl.pod;
    this.tick++;
    this.prev.x = pod.x;
    this.prev.y = pod.y;
    const wasDead = pl.deadTicks > 0;
    const hullBefore = pl.stats.hull;
    const vyBefore = pod.vy;
    this.inputs.set(pl.id, input);
    const ev = simTick(this.world, this.sand, [pl], this.inputs, this.tick);
    for (const d of ev.dug) {
      fx.dug.push(d);
      if (d.tile === Tile.HEAL) fx.healed = true;
    }
    for (const e of ev.sand) fx.sand.push(e);
    if (ev.respawns.length > 0) {
      fx.respawned = true;
      this.prev.x = pod.x;
      this.prev.y = pod.y;
    }
    if (ev.deaths.length > 0) {
      fx.died = true;
      return;
    }
    if (wasDead) return;
    if (pl.stats.hull < hullBefore) fx.damage += hullBefore - pl.stats.hull;
    if (vyBefore > 4 && pod.vy === 0 && pod.grounded) {
      if (vyBefore > T.hardLandSpeed) fx.hardLandVy = vyBefore;
      else fx.softLandVy = vyBefore;
    }
  }

  useRadar(): 'ok' | 'cooldown' | 'dead' {
    if (this.dead) return 'dead';
    const r = tryRadar(this.player.stats);
    if (r === 'ok') this.radarPings++;
    return r;
  }

  buy(kind: UpgradeKind): BuyResult | 'dead' {
    if (this.dead) return 'dead';
    const r = buyUpgrade(this.player.stats, kind);
    this.buyFeedback.seq++;
    this.buyFeedback.text = r === 'ok' ? `Bought ${kind}` : r === 'funds' ? 'Not enough money' : 'Already at the maximum level';
    return r;
  }

  getBoard(): BoardData {
    const st = this.player.stats;
    return { rows: [{ name: this.nickname, score: Math.max(st.score, st.highScore), me: true }], rank: 1, count: 1, hi: st.highScore, sc: st.score };
  }
}

export { NO_INPUT };
