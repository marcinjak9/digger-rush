import { T } from './tuning.js';
import { Tile, isSolid } from './tiles.js';
import { fmix32, u32 } from './hash.js';
import type { World } from './world.js';
import { newPod, stepPod, type PodState } from './pod.js';
import { NO_INPUT, type PodInput } from './input.js';
import { applyDamage, die, isDead, onDug, stepRadarCooldown, type Player } from './player.js';
import type { SandEvent, SandPod, SandSim } from './sand.js';

export interface SimPlayer {
  id: number;
  pod: PodState;
  stats: Player;
  spawnSalt: number; // changes on every death; feeds the random respawn column
  deadTicks: number; // > 0 while dead: the pod is not stepped and is ignored by sand
  invulnTicks: number; // > 0 after respawning: no damage
  finalScore: number; // score at the moment of the last death
}

export interface SimDug {
  id: number;
  x: number;
  y: number;
  tile: number;
  aux: number;
}

export interface SimEvents {
  dug: SimDug[];
  sand: SandEvent[];
  deaths: number[];
  respawns: number[];
}

export function newSimEvents(): SimEvents {
  return { dug: [], sand: [], deaths: [], respawns: [] };
}

export function clearSimEvents(out: SimEvents): void {
  out.dug.length = 0;
  out.sand.length = 0;
  out.deaths.length = 0;
  out.respawns.length = 0;
}

// Random respawn column (tile centre), deterministic from (seed, player id, spawn salt).
export function spawnX(id: number, salt = 0, seed: number = T.SEED): number {
  const span = T.spawnXMax - T.spawnXMin + 1;
  return T.spawnXMin + (u32(seed, id | 0, salt | 0, T.spawnSalt) % span) + 0.5;
}

// Row of the first solid tile scanning down from the top of the column (0 when none is found).
export function surfaceRow(world: World, col: number): number {
  for (let y = 0; y < T.spawnScanRows; y++) if (isSolid(world.get(col, y))) return y;
  return 0;
}

// Pod resting on the first solid tile of a hashed column.
export function spawnPod(world: World, id: number, salt = 0): PodState {
  const x = spawnX(id, salt, world.seed);
  const p = newPod(x, surfaceRow(world, Math.floor(x)) - T.podHalf);
  p.grounded = true;
  return p;
}

export function createPlayer(id: number, stats: Player, world: World, spawnSalt = 0): SimPlayer {
  return { id, pod: spawnPod(world, id, spawnSalt), stats, spawnSalt, deadTicks: 0, invulnTicks: 0, finalScore: 0 };
}

export function isAlive(pl: SimPlayer): boolean {
  return pl.deadTicks <= 0;
}

// Kills the player when hull <= 0: banks the high score, resets the run, starts the respawn timer.
function resolveDeath(pl: SimPlayer, out: SimEvents): void {
  if (pl.deadTicks > 0 || !isDead(pl.stats)) return;
  pl.finalScore = pl.stats.score;
  die(pl.stats);
  pl.spawnSalt = (pl.spawnSalt + 1) | 0;
  pl.deadTicks = T.respawnTicks;
  pl.invulnTicks = 0;
  out.deaths.push(pl.id);
}

// One 60 Hz tick of one player's pod: movement, drilling (the dug tile is removed from the world and
// paid out), landing and lava damage. No sand. Dead players are not stepped.
export function stepPlayerTick(world: World, pl: SimPlayer, input: PodInput, out: SimEvents): void {
  if (pl.deadTicks > 0) return;
  const ev = stepPod(pl.pod, input, world, pl.stats.lvl);
  if (ev.dug !== null) {
    const d = ev.dug;
    world.set(d.x, d.y, Tile.EMPTY);
    onDug(pl.stats, d.tile, d.aux, d.y);
    out.dug.push({ id: pl.id, x: d.x, y: d.y, tile: d.tile, aux: d.aux });
  }
  stepRadarCooldown(pl.stats);
  if (pl.invulnTicks <= 0) {
    if (ev.landDamage > 0) applyDamage(pl.stats, ev.landDamage);
    if (ev.lavaTicks > 0) applyDamage(pl.stats, T.lavaDps / T.TICK_HZ);
  }
  resolveDeath(pl, out);
}

const sandPodScratch: SandPod[] = [];

// The world half of a tick: respawn/invulnerability timers, the sand step, sand hits and deaths.
// `players` are the ones that exist in the world (the server leaves out disconnected players, which
// are frozen). Dead players are ignored by sand; invulnerable ones are hit-tested (so the block is
// consumed) but take no damage.
export function stepWorldAfter(
  world: World, sand: SandSim, players: readonly SimPlayer[], tick: number, out: SimEvents,
): void {
  world.tick = tick;
  for (const pl of players) {
    if (pl.deadTicks > 0) {
      if (--pl.deadTicks === 0) {
        pl.pod = spawnPod(world, pl.id, pl.spawnSalt);
        pl.invulnTicks = T.invulnTicks;
        out.respawns.push(pl.id);
      }
    } else if (pl.invulnTicks > 0) {
      pl.invulnTicks--;
    }
  }
  const pods = sandPodScratch;
  pods.length = 0;
  for (const pl of players) {
    if (pl.deadTicks > 0) continue;
    pods.push({ id: pl.id, x: pl.pod.x, y: pl.pod.y });
  }
  const first = out.sand.length;
  const evs = sand.step(world, tick, pods);
  for (const e of evs) {
    out.sand.push(e);
  }
  for (let i = first; i < out.sand.length; i++) {
    const e = out.sand[i];
    if (e.kind !== 'hit') continue;
    const pl = players.find((p) => p.id === e.podId);
    if (pl !== undefined && pl.invulnTicks <= 0 && pl.deadTicks <= 0) applyDamage(pl.stats, e.damage);
  }
  for (const pl of players) resolveDeath(pl, out);
}

// The one ordering used offline: all pods step (ascending id), then the world.
export function simTick(
  world: World,
  sand: SandSim,
  players: readonly SimPlayer[],
  inputs: ReadonlyMap<number, PodInput>,
  tick: number,
): SimEvents {
  const out = newSimEvents();
  const order = players.length > 1 ? [...players].sort((a, b) => a.id - b.id) : players;
  for (const pl of order) stepPlayerTick(world, pl, inputs.get(pl.id) ?? NO_INPUT, out);
  stepWorldAfter(world, sand, order, tick, out);
  return out;
}

// Order-independent state fingerprint, handy for determinism checks and desync detection.
export function podHash(p: PodState): number {
  let h = 0x811c9dc5;
  const vals = [p.x * T.QUANT, p.y * T.QUANT, p.vx * T.QUANT, p.vy * T.QUANT, p.grounded ? 1 : 0,
    p.drill ? p.drill.ticksLeft + 1 : 0, p.glide ? p.glide.left + 1 : 0];
  for (const v of vals) h = fmix32((h ^ (v | 0)) >>> 0);
  return h;
}
