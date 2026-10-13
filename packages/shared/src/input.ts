import { T } from './tuning.js';

export interface PodInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

export interface InputCmd extends PodInput {
  seq: number; // u32
  ticks: number; // 1..4 sim ticks this command covers
}

export const NO_INPUT: PodInput = { left: false, right: false, up: false, down: false };
export const MAX_CMD_TICKS = T.net.maxCmdTicks;

export function packInput(i: PodInput): number {
  return (i.left ? 1 : 0) | (i.right ? 2 : 0) | (i.up ? 4 : 0) | (i.down ? 8 : 0);
}

export function unpackInput(mask: number): PodInput {
  return { left: (mask & 1) !== 0, right: (mask & 2) !== 0, up: (mask & 4) !== 0, down: (mask & 8) !== 0 };
}

export function clampTicks(n: number): number {
  const t = Math.floor(n);
  return t < 1 ? 1 : t > MAX_CMD_TICKS ? MAX_CMD_TICKS : t;
}

// True when `seq` is newer than `last` (wrapping u32 compare); stale commands are dropped.
export function isNewerSeq(seq: number, last: number): boolean {
  return (((seq - last) | 0) > 0);
}

export const INPUT_HZ = T.TICK_HZ;

// Shared immutable inputs per mask, so hot paths never allocate.
const INPUT_TABLE: readonly PodInput[] = Array.from({ length: 16 }, (_, m) => Object.freeze(unpackInput(m)));

export function inputFromMask(mask: number): PodInput {
  return INPUT_TABLE[mask & 15];
}
