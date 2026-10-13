import { T } from './tuning.js';
import { Tile } from './tiles.js';
import { fmix32, u32 } from './hash.js';
import { isSolid } from './tiles.js';
import type { World } from './world.js';
import { newPod, stepPod, type PodState } from './pod.js';
import { NO_INPUT, type PodInput } from './input.js';
import { applyDamage, die, isDead, onDug, stepRadarCooldown, type Player } from './player.js';
import type { SandEvent, SandSim } from './sand.js';

export interface SimPlayer {
  id: number;
  pod: PodState;
  stats: Player;
  spawnSalt: number; // changes on every death; feeds the random respawn column
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
  return { id, pod: spawnPod(world, id, spawnSalt), stats, spawnSalt };
}

// The one ordering used everywhere (server, client prediction, offline).
// Players are processed in ascending id order.
export function simTick(
  world: World,
  sand: SandSim,
  players: readonly SimPlayer[],
  inputs: ReadonlyMap<number, PodInput>,
  tick: number,
): SimEvents {
  world.tick = tick;
  const out: SimEvents = { dug: [], sand: [], deaths: [] };
  const order = players.length > 1 ? [...players].sort((a, b) => a.id - b.id) : players;
  for (const pl of order) {
    const ev = stepPod(pl.pod, inputs.get(pl.id) ?? NO_INPUT, world, pl.stats.lvl);
    if (ev.dug !== null) {
      const d = ev.dug;
      world.set(d.x, d.y, Tile.EMPTY);
      onDug(pl.stats, d.tile, d.aux, d.y);
      out.dug.push({ id: pl.id, x: d.x, y: d.y, tile: d.tile, aux: d.aux });
    }
    stepRadarCooldown(pl.stats);
    if (ev.landDamage > 0) applyDamage(pl.stats, ev.landDamage);
    if (ev.lavaTicks > 0) applyDamage(pl.stats, T.lavaDps / T.TICK_HZ);
  }
  const sandPods = order.map((pl) => ({ id: pl.id, x: pl.pod.x, y: pl.pod.y }));
  out.sand = sand.step(world, tick, sandPods);
  for (const e of out.sand) {
    if (e.kind !== 'hit') continue;
    const pl = order.find((p) => p.id === e.podId);
    if (pl !== undefined) applyDamage(pl.stats, e.damage);
  }
  for (const pl of order) {
    if (!isDead(pl.stats)) continue;
    die(pl.stats);
    pl.spawnSalt = (pl.spawnSalt + 1) | 0;
    pl.pod = spawnPod(world, pl.id, pl.spawnSalt);
    out.deaths.push(pl.id);
  }
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
