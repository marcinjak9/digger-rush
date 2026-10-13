import { T } from './tuning.js';
import { newPod, type PodState } from './pod.js';
import { maxHpOf, UPGRADE_KINDS, type Player, type UpgradeKind } from './player.js';

// Wire protocol shared by server, browser client and bots. Everything travels as plain objects of
// numbers and short arrays (msgpack by Colyseus); no Colyseus schema state.

export const SIM_VERSION: number = T.SIM_VERSION;
export const ROOM_NAME = 'dig';

export const MSG = {
  // client -> server
  READY: 'ready',
  IN: 'in',
  BUY: 'buy',
  RADAR: 'radar',
  PING: 'ping',
  // server -> client
  WELCOME: 'welcome',
  SNAP: 'snap',
  JOINED: 'joined',
  LEFT: 'left',
  TILES: 'tiles',
  CHUNKS: 'chunks',
  UNSUB: 'unsub',
  SAND: 'sand',
  EV: 'ev',
  LB: 'lb',
  PONG: 'pong',
} as const;

// ---------------------------------------------------------------- payloads

export interface JoinOptions {
  nickname: string;
  token: string;
  simVersion: number;
}

export interface InMsg {
  seq: number;
  ticks: number; // 1..4
  mask: number; // packInput
}

export interface BuyMsg {
  kind: UpgradeKind;
}

export interface PingMsg {
  t: number;
}

export interface WelcomeMsg {
  id: number;
  nick: string;
  seed: number;
  simVersion: number;
  tickHz: number;
  serverHz: number;
  roomId: string;
  resumed: boolean;
  tick: number;
  pod: number[]; // encodePod
  st: number[]; // own stats, see ST
}

// Snapshot. `p` is the exact server pod after consuming command `a`; `o` holds other pods in range,
// OTHER_STRIDE numbers each.
export interface SnapMsg {
  t: number; // server tick
  a: number; // ack: last consumed input seq
  p: number[];
  s: number[];
  o: number[];
}

export interface JoinedMsg {
  id: number;
  nick: string;
}

export interface LeftMsg {
  id: number;
}

// Tile deltas: [x, y, tile | aux << 8] triples.
export interface TilesMsg {
  d: number[];
}

// Full modified-tile list of chunks that just entered the interest area: [key, [idx, tile | aux << 8, ...]].
export interface ChunksMsg {
  c: Array<[number, number[]]>;
}

export interface UnsubMsg {
  k: number[];
}

// Sand events [kind, x, y] triples (see SAND_*); hits carry the real position.
export interface SandMsg {
  d: number[];
}

// Personal events, variable length rows concatenated: [EV_x, ...args].
export interface EvMsg {
  d: number[];
}

export interface LbMsg {
  top: Array<[string, number, number]>; // nickname, highScore, player id
  rank: number; // own rank by highScore
  n: number; // players listed (connected plus those inside their reconnect window)
  hi: number; // own highScore
  sc: number; // own current score
}

export interface PongMsg {
  t: number;
}

// ---------------------------------------------------------------- ids

export const SAND_WOBBLE = 0;
export const SAND_FALL = 1;
export const SAND_LAND = 2;
export const SAND_HIT = 3;
export const SAND_CALM = 4;

export const EV_DIG = 0; // x, y, tile | aux << 8
export const EV_DEATH = 1; // final score
export const EV_RESPAWN = 2;
export const EV_BUY = 3; // upgrade kind index (-1 = unknown kind), BUY_* result
export const EV_HEAL = 4; // heal ore was mined: the server already healed the pod
export const EV_LEN: readonly number[] = [4, 2, 1, 3, 1];

// Result codes of a purchase, sent back in EV_BUY.
export const BUY_OK = 0;
export const BUY_FUNDS = 1;
export const BUY_MAX = 2;
export const BUY_DEAD = 3;
export const BUY_BAD = 4; // unknown kind
export const BUY_COOLDOWN = 5;

// Flags of an other pod.
export const OF_FACE_RIGHT = 1;
export const OF_FACE_DOWN = 2;
export const OF_DRILLING = 4;
export const OF_THRUSTING = 8;
export const OF_DEAD = 16;
export const OF_INVULN = 32;
export const OTHER_STRIDE = 5; // id, x*Q, y*Q, flags, hull 0..255

// Own stats array layout.
export const ST = {
  HULL: 0,
  MAXHP: 1,
  WALLET: 2,
  SCORE: 3,
  HIGH: 4,
  LVL: 5, // 5 levels in UPGRADE_KINDS order
  RADAR: 10,
  DEAD: 11,
  INVULN: 12,
  FINAL: 13,
  LEN: 14,
} as const;

// ---------------------------------------------------------------- pod encoding

export const POD_LEN = 22;
const Q = T.QUANT;

// Quantised ints exactly as the sim holds them (positions are multiples of 1/1024), so decoding
// reproduces the server pod bit for bit.
export function encodePod(p: PodState, out: number[] = new Array<number>(POD_LEN)): number[] {
  out[0] = Math.round(p.x * Q);
  out[1] = Math.round(p.y * Q);
  out[2] = Math.round(p.vx * Q);
  out[3] = Math.round(p.vy * Q);
  out[4] = p.grounded ? 1 : 0;
  out[5] = p.fx;
  out[6] = p.fy;
  const d = p.drill;
  out[7] = d !== null ? 1 : 0;
  out[8] = d !== null ? d.dx : 0;
  out[9] = d !== null ? d.dy : 0;
  out[10] = d !== null ? d.tx : 0;
  out[11] = d !== null ? d.ty : 0;
  out[12] = d !== null ? d.ticksLeft : 0;
  out[13] = d !== null ? d.total : 0;
  const m = p.mem;
  out[14] = m !== null ? 1 : 0;
  out[15] = m !== null ? m.tx : 0;
  out[16] = m !== null ? m.ty : 0;
  out[17] = m !== null ? m.ticksDone : 0;
  const g = p.glide;
  out[18] = g !== null ? 1 : 0;
  out[19] = g !== null ? g.dx : 0;
  out[20] = g !== null ? g.dy : 0;
  out[21] = g !== null ? g.left : 0;
  return out;
}

export function decodePod(a: ArrayLike<number>, into: PodState = newPod(0, 0)): PodState {
  into.x = a[0] / Q;
  into.y = a[1] / Q;
  into.vx = a[2] / Q;
  into.vy = a[3] / Q;
  into.grounded = a[4] === 1;
  into.fx = a[5];
  into.fy = a[6];
  into.drill = a[7] === 1 ? { dx: a[8], dy: a[9], tx: a[10], ty: a[11], ticksLeft: a[12], total: a[13] } : null;
  into.mem = a[14] === 1 ? { tx: a[15], ty: a[16], ticksDone: a[17] } : null;
  into.glide = a[18] === 1 ? { dx: a[19], dy: a[20], left: a[21] } : null;
  return into;
}

export function quantize(v: number): number {
  return Math.round(v * Q);
}

export function dequantize(v: number): number {
  return v / Q;
}

// ---------------------------------------------------------------- stats encoding

export function writeStats(
  p: Player, deadTicks: number, invulnTicks: number, finalScore: number, out: number[] = new Array<number>(ST.LEN),
): number[] {
  out[ST.HULL] = Math.round(p.hull * 100) / 100;
  out[ST.MAXHP] = maxHpOf(p.lvl);
  out[ST.WALLET] = p.wallet;
  out[ST.SCORE] = p.score;
  out[ST.HIGH] = p.highScore;
  for (let i = 0; i < UPGRADE_KINDS.length; i++) out[ST.LVL + i] = p.lvl[UPGRADE_KINDS[i]];
  out[ST.RADAR] = p.radarTicks;
  out[ST.DEAD] = deadTicks;
  out[ST.INVULN] = invulnTicks;
  out[ST.FINAL] = finalScore;
  return out;
}

export interface DecodedStats {
  deadTicks: number;
  invulnTicks: number;
  finalScore: number;
}

// Fills `p` in place (so objects held by the UI and the predictor stay valid).
export function readStats(a: ArrayLike<number>, p: Player, into: DecodedStats): void {
  p.hull = a[ST.HULL];
  p.wallet = a[ST.WALLET];
  p.score = a[ST.SCORE];
  p.highScore = a[ST.HIGH];
  for (let i = 0; i < UPGRADE_KINDS.length; i++) p.lvl[UPGRADE_KINDS[i]] = a[ST.LVL + i];
  p.radarTicks = a[ST.RADAR];
  into.deadTicks = a[ST.DEAD];
  into.invulnTicks = a[ST.INVULN];
  into.finalScore = a[ST.FINAL];
}

// ---------------------------------------------------------------- interest management

export function chunkKey(cx: number, cy: number): number {
  return cy * T.CHUNKS_X + cx;
}

export function chunkKeyOfTile(x: number, y: number): number {
  return (y >> 4) * T.CHUNKS_X + (x >> 4);
}

export function chunkCx(key: number): number {
  return key % T.CHUNKS_X;
}

export function chunkCy(key: number): number {
  return (key - (key % T.CHUNKS_X)) / T.CHUNKS_X;
}

export interface ChunkRange {
  cx0: number;
  cx1: number;
  cy0: number;
  cy1: number;
}

// Chunk coordinate of a position (negative above the surface).
export function chunkCoord(v: number): number {
  return Math.floor(v / T.CHUNK);
}

// Chunks within `radius` of the chunk containing (x, y), clamped to the playable world.
export function chunkRangeAround(
  x: number, y: number, radius: number, out: ChunkRange = { cx0: 0, cx1: 0, cy0: 0, cy1: 0 },
): ChunkRange {
  const cx = chunkCoord(x);
  const cy = chunkCoord(y);
  out.cx0 = Math.max(0, cx - radius);
  out.cx1 = Math.min(T.CHUNKS_X - 1, cx + radius);
  out.cy0 = Math.max(0, cy - radius);
  out.cy1 = Math.max(0, cy + radius);
  return out;
}

export function inChunkRange(r: ChunkRange, key: number): boolean {
  const cx = chunkCx(key);
  const cy = chunkCy(key);
  return cx >= r.cx0 && cx <= r.cx1 && cy >= r.cy0 && cy <= r.cy1;
}

export function inPodInterest(ax: number, ay: number, bx: number, by: number): boolean {
  const r = T.net.podInterestTiles;
  const dx = ax - bx;
  const dy = ay - by;
  return dx <= r && dx >= -r && dy <= r && dy >= -r;
}
