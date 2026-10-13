import { Tile } from './tiles.js';
import type { World } from './world.js';
import { decodePod } from './net.js';
import { stepPod, type PodEvents, type PodState } from './pod.js';
import { inputFromMask, isNewerSeq, MAX_CMD_TICKS } from './input.js';
import type { Levels } from './player.js';

export interface PendingCmd {
  seq: number;
  ticks: number;
  mask: number;
  sent: boolean;
}

interface PredictedDig {
  seq: number;
  x: number;
  y: number;
  tile: number;
  aux: number;
}

const CAP = 128; // pending command ring size

// Client side prediction without any framework: holds the local pod, the commands the server has not
// acknowledged yet, steps the shared pod physics one tick at a time and, on every snapshot, rewinds to
// the exact server pod and replays what is still unacknowledged. Tiles the pod digs are removed from
// the world immediately (and restored before a replay), but wallet and score are never touched.
export class Predictor {
  pod: PodState;
  readonly world: World;
  readonly lvl: Levels;
  nextSeq = 1;
  ackSeq = 0;
  // Distance the pod moved in the last reconcile, in tiles.
  lastError = 0;
  private readonly ring: PendingCmd[] = [];
  private head = 0;
  private len = 0;
  private readonly digs: PredictedDig[] = [];
  private pendingTicks_ = 0;

  constructor(world: World, pod: PodState, lvl: Levels) {
    this.world = world;
    this.pod = pod;
    this.lvl = lvl;
    for (let i = 0; i < CAP; i++) this.ring.push({ seq: 0, ticks: 0, mask: 0, sent: false });
  }

  // Ticks stepped locally that the server has not acknowledged.
  get pendingTicks(): number {
    return this.pendingTicks_;
  }

  get pendingCount(): number {
    return this.len;
  }

  // Resets prediction to a server state (welcome, respawn). Pending commands are dropped.
  reset(serverPod: ArrayLike<number>, ackSeq: number): void {
    this.revertDigs();
    this.len = 0;
    this.head = 0;
    this.pendingTicks_ = 0;
    this.ackSeq = ackSeq;
    if (isNewerSeq(ackSeq, this.nextSeq - 1)) this.nextSeq = (ackSeq + 1) >>> 0;
    decodePod(serverPod, this.pod);
  }

  // Steps one local 60 Hz tick with the given packed input and records it in the command buffer.
  applyLocal(mask: number): PodEvents {
    mask &= 15;
    let cmd: PendingCmd | null = null;
    if (this.len > 0) {
      const last = this.ring[(this.head + this.len - 1) % CAP];
      if (!last.sent && last.mask === mask && last.ticks < MAX_CMD_TICKS) cmd = last;
    }
    if (cmd === null) {
      if (this.len === CAP) {
        // Should not happen (callers throttle on pendingTicks); drop the oldest.
        this.pendingTicks_ -= this.ring[this.head].ticks;
        this.head = (this.head + 1) % CAP;
        this.len--;
      }
      cmd = this.ring[(this.head + this.len) % CAP];
      this.len++;
      cmd.seq = this.nextSeq;
      this.nextSeq = (this.nextSeq + 1) >>> 0;
      cmd.ticks = 0;
      cmd.mask = mask;
      cmd.sent = false;
    }
    cmd.ticks++;
    this.pendingTicks_++;
    return this.stepTick(mask, cmd.seq);
  }

  // Calls `send` for every command that has not been sent yet (oldest first) and marks them sent.
  flush(send: (seq: number, ticks: number, mask: number) => void): void {
    for (let i = 0; i < this.len; i++) {
      const c = this.ring[(this.head + i) % CAP];
      if (c.sent) continue;
      c.sent = true;
      send(c.seq, c.ticks, c.mask);
    }
  }

  // Rewinds to the exact server pod (encodePod output), drops acknowledged commands and replays the
  // rest. Returns the correction error: how far the pod moved, in tiles.
  reconcile(serverPod: ArrayLike<number>, ackSeq: number): number {
    const bx = this.pod.x;
    const by = this.pod.y;
    this.ackSeq = ackSeq;
    while (this.len > 0) {
      const c = this.ring[this.head];
      if (isNewerSeq(c.seq, ackSeq)) break;
      this.pendingTicks_ -= c.ticks;
      this.head = (this.head + 1) % CAP;
      this.len--;
    }
    // Digs of acknowledged commands are in the server world; the others are redone by the replay.
    let keep = 0;
    for (let i = 0; i < this.digs.length; i++) if (isNewerSeq(this.digs[i].seq, ackSeq)) this.digs[keep++] = this.digs[i];
    this.digs.length = keep;
    this.revertDigs();
    decodePod(serverPod, this.pod);
    for (let i = 0; i < this.len; i++) {
      const c = this.ring[(this.head + i) % CAP];
      for (let k = 0; k < c.ticks; k++) this.stepTick(c.mask, c.seq);
    }
    const dx = this.pod.x - bx;
    const dy = this.pod.y - by;
    this.lastError = Math.sqrt(dx * dx + dy * dy);
    return this.lastError;
  }

  private stepTick(mask: number, seq: number): PodEvents {
    const ev = stepPod(this.pod, inputFromMask(mask), this.world, this.lvl);
    const d = ev.dug;
    if (d !== null) {
      this.digs.push({ seq, x: d.x, y: d.y, tile: d.tile, aux: d.aux });
      this.world.set(d.x, d.y, Tile.EMPTY);
      this.world.dirty.clear(); // sand is the server's business
    }
    return ev;
  }

  private revertDigs(): void {
    for (let i = this.digs.length - 1; i >= 0; i--) {
      const d = this.digs[i];
      if (this.world.get(d.x, d.y) === Tile.EMPTY) this.world.set(d.x, d.y, d.tile, d.aux);
    }
    this.digs.length = 0;
    this.world.dirty.clear();
  }
}
