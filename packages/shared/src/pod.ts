import { T } from './tuning.js';
import { Tile, digTicks, isDiggable, isSolid } from './tiles.js';
import type { World } from './world.js';
import type { InputCmd, PodInput } from './input.js';
import { moveSpeedOf, type Levels } from './player.js';

export interface DrillState {
  dx: number;
  dy: number;
  tx: number;
  ty: number;
  ticksLeft: number;
  total: number;
}

export interface DrillMem {
  tx: number;
  ty: number;
  ticksDone: number;
}

export interface GlideState {
  dx: number;
  dy: number;
  left: number; // remaining distance in 1/1024 tile
}

export interface PodState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  fx: number; // facing, for rendering
  fy: number;
  drill: DrillState | null;
  mem: DrillMem | null;
  glide: GlideState | null;
}

export interface DugEvent {
  x: number;
  y: number;
  tile: number;
  aux: number;
}

export interface PodEvents {
  dug: DugEvent | null;
  landDamage: number; // raw, before armor
  lavaTicks: number; // 1 when the pod overlapped lava this tick
}

const H = T.podHalf;
const EPS = T.collideEps;
const DT = T.DT;
const Q = T.QUANT;

export function newPod(x: number, y: number): PodState {
  return { x, y, vx: 0, vy: 0, grounded: false, fx: 0, fy: 1, drill: null, mem: null, glide: null };
}

export function clonePod(p: PodState): PodState {
  return {
    ...p,
    drill: p.drill ? { ...p.drill } : null,
    mem: p.mem ? { ...p.mem } : null,
    glide: p.glide ? { ...p.glide } : null,
  };
}

export function landingDamage(impactVy: number): number {
  return impactVy > T.hardLandSpeed ? (impactVy - T.hardLandSpeed) * T.hardLandMult : 0;
}

function q(v: number): number {
  return Math.round(v * Q) / Q + 0;
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function moveToward(v: number, target: number, maxDelta: number): number {
  if (Math.abs(target - v) <= maxDelta) return target;
  return v + sign(target - v) * maxDelta;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ------------------------------------------------------------------ collision

function solidAt(world: World, x: number, y: number): boolean {
  return isSolid(world.get(x, y));
}

// Moves along x, stopping at the first solid column. Returns true on contact.
function moveX(pod: PodState, world: World, dx: number): boolean {
  if (dx === 0) return false;
  const top = Math.floor(pod.y - H + EPS);
  const bot = Math.floor(pod.y + H - EPS);
  if (dx > 0) {
    const prevEdge = pod.x + H;
    const c0 = Math.floor(prevEdge - EPS) + 1;
    const c1 = Math.floor(prevEdge + dx);
    pod.x += dx;
    for (let c = c0; c <= c1; c++) {
      for (let r = top; r <= bot; r++) {
        if (solidAt(world, c, r)) {
          pod.x = c - H;
          return true;
        }
      }
    }
  } else {
    const prevEdge = pod.x - H;
    const c0 = Math.floor(prevEdge + EPS) - 1;
    const c1 = Math.floor(prevEdge + dx);
    pod.x += dx;
    for (let c = c0; c >= c1; c--) {
      for (let r = top; r <= bot; r++) {
        if (solidAt(world, c, r)) {
          pod.x = c + 1 + H;
          return true;
        }
      }
    }
  }
  return false;
}

function moveY(pod: PodState, world: World, dy: number): boolean {
  if (dy === 0) return false;
  const left = Math.floor(pod.x - H + EPS);
  const right = Math.floor(pod.x + H - EPS);
  if (dy > 0) {
    const prevEdge = pod.y + H;
    const r0 = Math.floor(prevEdge - EPS) + 1;
    const r1 = Math.floor(prevEdge + dy);
    pod.y += dy;
    for (let r = r0; r <= r1; r++) {
      for (let c = left; c <= right; c++) {
        if (solidAt(world, c, r)) {
          pod.y = r - H;
          return true;
        }
      }
    }
  } else {
    const prevEdge = pod.y - H;
    const r0 = Math.floor(prevEdge + EPS) - 1;
    const r1 = Math.floor(prevEdge + dy);
    pod.y += dy;
    for (let r = r0; r >= r1; r--) {
      for (let c = left; c <= right; c++) {
        if (solidAt(world, c, r)) {
          pod.y = r + 1 + H;
          return true;
        }
      }
    }
  }
  return false;
}

function applyY(pod: PodState, world: World, ev: PodEvents): void {
  const vy = pod.vy;
  if (moveY(pod, world, vy * DT)) {
    if (vy > 0) {
      pod.grounded = true;
      ev.landDamage += landingDamage(vy);
    }
    pod.vy = 0;
  } else {
    pod.grounded = false;
  }
}

// ----------------------------------------------------------------- free flight

function gridCenterX(pod: PodState): number {
  let c = Math.floor(pod.x) + 0.5;
  if (pod.vx > 0.05) {
    if (c <= pod.x + 0.0001) c += 1;
  } else if (pod.vx < -0.05) {
    if (c >= pod.x - 0.0001) c -= 1;
  } else {
    c = Math.round(pod.x - 0.5) + 0.5;
  }
  return c;
}

function stepFree(pod: PodState, inp: PodInput, world: World, lv: Levels, ev: PodEvents): void {
  const mvx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  const speed = moveSpeedOf(lv);
  const target = mvx * speed;
  const seek = mvx === 0;
  const braking = target === 0 || Math.abs(target) < Math.abs(pod.vx) || (pod.vx !== 0 && sign(target) !== sign(pod.vx));
  const acc = braking ? T.moveDecel : T.moveAccel * (pod.grounded ? 1 : T.airAccelMult);
  let dxLimit = Infinity;
  let snapNow = false;
  if (seek) {
    const c = gridCenterX(pod);
    const d = c - pod.x;
    if (Math.abs(d) < 0.01) {
      pod.vx = 0;
      dxLimit = d;
      snapNow = true;
    } else {
      const sp = clamp(Math.sqrt(2 * T.moveDecel * Math.abs(d)), T.gridSeekMin, speed);
      pod.vx = moveToward(pod.vx, sign(d) * sp, T.moveDecel * DT);
      dxLimit = d;
    }
  } else {
    pod.vx = moveToward(pod.vx, target, acc * DT);
  }
  pod.vy += (T.gravity - (inp.up ? T.thrust : 0)) * DT;
  pod.vy = clamp(pod.vy, T.vyMin, T.vyMax);
  let stepX = pod.vx * DT;
  if (dxLimit !== Infinity && (snapNow || Math.abs(stepX) >= Math.abs(dxLimit))) {
    stepX = dxLimit;
    pod.vx = 0;
  }
  if (moveX(pod, world, stepX)) pod.vx = 0;
  applyY(pod, world, ev);
}

// -------------------------------------------------------------------- drilling

function diggableAt(world: World, x: number, y: number): boolean {
  return isDiggable(world.get(x, y));
}

function tryStartDrill(pod: PodState, dx: number, dy: number, world: World, lv: Levels): boolean {
  if (dx === 0 && dy === 0) return false;
  if (dy > 0 && !pod.grounded) return false; // down only from the ground
  if (pod.vy > T.hardLandSpeed) return false; // too fast: land instead
  const reach = H + T.drillProbe;
  let tx = 0;
  let ty = 0;
  let found = false;
  if (dx !== 0) {
    const col = Math.floor(pod.x + dx * reach);
    const rc = Math.floor(pod.y);
    const rt = Math.floor(pod.y - H + EPS);
    const rb = Math.floor(pod.y + H - EPS);
    if (diggableAt(world, col, rc)) { tx = col; ty = rc; found = true; }
    else if (diggableAt(world, col, rt)) { tx = col; ty = rt; found = true; }
    else if (diggableAt(world, col, rb)) { tx = col; ty = rb; found = true; }
  } else {
    const row = Math.floor(pod.y + dy * reach);
    const cc = Math.floor(pod.x);
    const cl = Math.floor(pod.x - H + EPS);
    const cr = Math.floor(pod.x + H - EPS);
    if (diggableAt(world, cc, row)) { tx = cc; ty = row; found = true; }
    else if (diggableAt(world, cl, row)) { tx = cl; ty = row; found = true; }
    else if (diggableAt(world, cr, row)) { tx = cr; ty = row; found = true; }
  }
  if (!found) return false;
  const total = digTicks(world.get(tx, ty), ty, lv.drill);
  let done = 0;
  if (pod.mem !== null && pod.mem.tx === tx && pod.mem.ty === ty) {
    done = pod.mem.ticksDone < total - 1 ? pod.mem.ticksDone : total - 1;
    pod.mem = null;
  }
  pod.drill = { dx, dy, tx, ty, ticksLeft: total - done, total };
  // Close the last sliver so the pod is flush with the tile face.
  if (dx > 0) pod.x = tx - H;
  else if (dx < 0) pod.x = tx + 1 + H;
  else if (dy > 0) pod.y = ty - H;
  if (dx !== 0) pod.vx = 0;
  else { pod.vx = 0; pod.vy = 0; }
  return true;
}

function cancelDrill(pod: PodState): void {
  const d = pod.drill as DrillState;
  const done = d.total - d.ticksLeft;
  if (done > 0) pod.mem = { tx: d.tx, ty: d.ty, ticksDone: done };
  pod.drill = null;
  pod.vx = 0;
  pod.vy = 0;
}

function stepDrill(pod: PodState, dx: number, dy: number, inp: PodInput, world: World, lv: Levels, ev: PodEvents): void {
  const d = pod.drill as DrillState;
  if ((dx !== 0 || dy !== 0) && (dx !== d.dx || dy !== d.dy)) {
    cancelDrill(pod);
    stepFree(pod, inp, world, lv, ev);
    return;
  }
  d.ticksLeft--;
  if (d.dx === 0) {
    // vertical drill: ease x to the column centre
    pod.grounded = true;
    moveX(pod, world, (d.tx + 0.5 - pod.x) * T.alignFactor);
    pod.vx = 0;
    pod.vy = 0;
  } else {
    pod.vx = 0;
    pod.vy = Math.min(pod.vy + T.gravity * DT, T.vyMax);
    applyY(pod, world, ev);
  }
  if (d.ticksLeft <= 0) {
    pod.drill = null;
    pod.glide = { dx: d.dx, dy: d.dy, left: Q };
    const t = world.get(d.tx, d.ty);
    if (t === Tile.EMPTY) return; // already gone (sand fell away, or another player dug it)
    ev.dug = { x: d.tx, y: d.ty, tile: t, aux: world.getAux(d.tx, d.ty) };
  }
}

// Fast slide into the hole a finished tile left, then straight into the next tile
// if the direction is still held. Any other direction cancels it.
function stepGlide(pod: PodState, dx: number, dy: number, inp: PodInput, world: World, lv: Levels, ev: PodEvents): void {
  const g = pod.glide as GlideState;
  if ((dx !== 0 || dy !== 0) && (dx !== g.dx || dy !== g.dy)) {
    pod.glide = null;
    stepFree(pod, inp, world, lv, ev);
    return;
  }
  const used = g.left < T.glideQuanta ? g.left : T.glideQuanta;
  const dist = used / Q;
  let hit: boolean;
  if (g.dx !== 0) {
    hit = moveX(pod, world, g.dx * dist);
    pod.vx = 0;
    pod.vy = Math.min(pod.vy + T.gravity * DT, T.vyMax);
    applyY(pod, world, ev);
  } else {
    pod.grounded = true;
    hit = moveY(pod, world, g.dy * dist);
    pod.vx = 0;
    pod.vy = 0;
  }
  g.left = hit ? 0 : g.left - used;
  if (g.left <= 0) {
    pod.glide = null;
    if (tryStartDrill(pod, dx, dy, world, lv)) stepDrill(pod, dx, dy, inp, world, lv, ev);
  }
}

// ------------------------------------------------------------------------ step

// Advances one 60 Hz tick. Mutates `pod`, only reads `world`; the caller applies `dug`.
export function stepPod(pod: PodState, inp: PodInput, world: World, lv: Levels): PodEvents {
  const ev: PodEvents = { dug: null, landDamage: 0, lavaTicks: 0 };
  const hx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  const hy = hx === 0 && inp.down ? 1 : 0;
  if (hx !== 0 || hy !== 0) {
    pod.fx = hx;
    pod.fy = hy;
  }
  if (pod.drill === null && pod.glide === null) tryStartDrill(pod, hx, hy, world, lv);
  if (pod.drill !== null) stepDrill(pod, hx, hy, inp, world, lv, ev);
  else if (pod.glide !== null) stepGlide(pod, hx, hy, inp, world, lv, ev);
  else stepFree(pod, inp, world, lv, ev);

  if (pod.y < T.yMin) {
    pod.y = T.yMin;
    if (pod.vy < 0) pod.vy = 0;
  }
  pod.x = q(pod.x);
  pod.y = q(pod.y);
  pod.vx = q(pod.vx);
  pod.vy = q(pod.vy);

  const l = Math.floor(pod.x - H + EPS);
  const r = Math.floor(pod.x + H - EPS);
  const t = Math.floor(pod.y - H + EPS);
  const b = Math.floor(pod.y + H - EPS);
  lava: for (let cy = t; cy <= b; cy++) {
    for (let cx = l; cx <= r; cx++) {
      if (world.get(cx, cy) === Tile.LAVA) {
        ev.lavaTicks = 1;
        break lava;
      }
    }
  }
  return ev;
}

// Runs a command's `ticks` ticks; `onTick` receives each tick's events so the caller
// can apply world changes between ticks.
export function stepPodCmd(
  pod: PodState, cmd: InputCmd, world: World, lv: Levels, onTick?: (ev: PodEvents) => void,
): void {
  for (let i = 0; i < cmd.ticks; i++) {
    const ev = stepPod(pod, cmd, world, lv);
    if (onTick !== undefined) onTick(ev);
  }
}
