import {
  T, Tile, World, SandSim, simTick, createPlayer, newPlayer, buyUpgrade, maxHpOf, NO_INPUT,
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
}

// Everything the renderer / UI needs from a running game. WP3 supplies a networked
// implementation (prediction + reconciliation) behind the same interface.
export interface GameSession {
  readonly world: World;
  readonly sand: SandSim;
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
  /** Advances real time; steps the fixed-rate sim zero or more times. */
  advance(dtSec: number, input: PodInput): void;
  buy(kind: UpgradeKind): BuyResult | 'dead';
}

export const RESPAWN_TICKS = 3 * T.TICK_HZ;
export const INVULN_TICKS = 3 * T.TICK_HZ;
const MAX_STEPS_PER_FRAME = 6;
const NO_PODS: SimPlayer[] = [];
const NO_INPUTS: ReadonlyMap<number, PodInput> = new Map();

export class LocalSession implements GameSession {
  readonly world = new World(T.SEED);
  readonly sand = new SandSim();
  readonly player: SimPlayer;
  readonly nickname: string;
  readonly fx: FrameFx = {
    dug: [], sand: [], changes: [], hardLandVy: 0, softLandVy: 0, damage: 0, died: false, respawned: false,
  };
  readonly prev = { x: 0, y: 0 };
  readonly latencyLabel = 'local';
  dead = false;
  finalScore = 0;
  tick = 0;
  private acc = 0;
  private deadTicks = 0;
  private invulnTicks = 0;
  private readonly inputs = new Map<number, PodInput>();
  private static readonly ID = 1;

  constructor(nickname: string) {
    this.nickname = nickname;
    this.player = createPlayer(LocalSession.ID, newPlayer(0));
    this.prev.x = this.player.pod.x;
    this.prev.y = this.player.pod.y;
  }

  get alpha(): number {
    return this.acc * T.TICK_HZ;
  }
  get respawnLeftSec(): number {
    return this.deadTicks / T.TICK_HZ;
  }
  get invulnerable(): boolean {
    return this.invulnTicks > 0;
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
    if (this.dead) {
      // The world (sand!) keeps simulating while the player is away.
      const ev = simTick(this.world, this.sand, NO_PODS, NO_INPUTS, this.tick);
      for (const e of ev.sand) fx.sand.push(e);
      if (--this.deadTicks <= 0) {
        this.dead = false;
        this.invulnTicks = INVULN_TICKS;
        this.prev.x = pod.x;
        this.prev.y = pod.y;
        fx.respawned = true;
      }
      return;
    }
    const st = pl.stats;
    const scoreBefore = st.score;
    const hullBefore = st.hull;
    const vyBefore = pod.vy;
    const invuln = this.invulnTicks > 0;
    if (invuln) {
      this.invulnTicks--;
      st.hull = 1e9; // damage can not kill while invulnerable
    }
    this.inputs.set(pl.id, input);
    const ev = simTick(this.world, this.sand, [pl], this.inputs, this.tick);
    for (const d of ev.dug) fx.dug.push(d);
    for (const e of ev.sand) fx.sand.push(e);
    if (ev.deaths.length > 0) {
      this.dead = true;
      this.deadTicks = RESPAWN_TICKS;
      this.finalScore = scoreBefore;
      this.invulnTicks = 0;
      fx.died = true;
      this.prev.x = pod.x;
      this.prev.y = pod.y;
      return;
    }
    if (invuln) {
      // Undo the damage; keep heal pickups.
      const healed = ev.dug.some((d) => d.tile === Tile.HEAL);
      const max = maxHpOf(st.lvl);
      st.hull = healed ? Math.min(max, hullBefore + max * T.healFrac) : hullBefore;
    }
    if (st.hull < hullBefore) fx.damage += hullBefore - st.hull;
    if (vyBefore > 4 && pod.vy === 0 && pod.grounded) {
      if (vyBefore > T.hardLandSpeed) fx.hardLandVy = vyBefore;
      else fx.softLandVy = vyBefore;
    }
  }

  buy(kind: UpgradeKind): BuyResult | 'dead' {
    if (this.dead) return 'dead';
    return buyUpgrade(this.player.stats, kind);
  }
}

export { NO_INPUT };
