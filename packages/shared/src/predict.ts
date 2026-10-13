import { Tile } from './tiles.js';
import type { TileChange, World } from './world.js';
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

// A tile the local pod dug ahead of the server. `tile` / `aux` are the value the SERVER has for that cell as far as we
// know: the original tile, updated whenever a server delta for the cell arrives. Reverting restores that value.
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
  // Cells the server reported dug (EV_DIG) since the last reconcile.
  private readonly confirmed = new Set<number>();
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
    this.confirmed.clear();
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

  // Applies a tile the server sent. Use this instead of writing to the world directly: when the cell is also a
  // predicted dig, the server value is remembered so a later revert restores the truth (no phantom tile).
  applyServer(ch: TileChange): void {
    for (let i = 0; i < this.digs.length; i++) {
      const d = this.digs[i];
      if (d.x === ch.x && d.y === ch.y) { d.tile = ch.tile; d.aux = ch.aux; }
    }
    this.world.applyChanges([ch]);
  }

  // The server confirmed (EV_DIG) that this cell was dug by this player's acknowledged input.
  onServerDig(x: number, y: number): void {
    this.confirmed.add(y * 65536 + x);
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
    // Digs of acknowledged commands are in the server world only if the server reported them (EV_DIG, sent in
    // the same tick as the ack); an acknowledged dig the server never made (its pod took another path) is
    // put back to the server value below. Unacknowledged digs are redone by the replay.
    let keep = 0;
    for (let i = 0; i < this.digs.length; i++) {
      const d = this.digs[i];
      if (isNewerSeq(d.seq, ackSeq)) { this.digs[keep++] = d; continue; }
      if (!this.confirmed.has(d.y * 65536 + d.x)) this.restore(d);
    }
    this.digs.length = keep;
    this.confirmed.clear();
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
    for (let i = this.digs.length - 1; i >= 0; i--) this.restore(this.digs[i]);
    this.digs.length = 0;
    this.world.dirty.clear();
  }

  private restore(d: PredictedDig): void {
    if (this.world.get(d.x, d.y) !== d.tile || this.world.getAux(d.x, d.y) !== d.aux) this.world.set(d.x, d.y, d.tile, d.aux);
  }
}
