import { T } from './tuning.js';
import { drillPpmOf } from './upgrades.js';

export enum Tile {
  EMPTY = 0,
  DIRT = 1,
  ROCK = 2,
  SAND = 3,
  COPPER = 4,
  GOLD = 5,
  GEM = 6,
  LAVA = 7,
  BEDROCK = 8,
  HEAL = 9,
}

export interface TileDef {
  name: string;
  digMs: number; // base dig time in milliseconds, 0 = cannot be dug
  value: number;
  falls: boolean;
  damage: number; // damage per second when overlapped
  solid: boolean;
  diggable: boolean;
  color: number; // 0xRRGGBB
  fleck: number;
}

function def(name: string, id: Tile, solid: boolean, color: number, fleck: number, falls = false): TileDef {
  const digMs = T.digMs[id];
  return {
    name, digMs, value: T.value[id], falls, damage: id === Tile.LAVA ? T.lavaDps : 0,
    solid, diggable: digMs > 0, color, fleck,
  };
}

export const TILES: readonly TileDef[] = [
  def('empty', Tile.EMPTY, false, 0x2b1f17, 0x2b1f17),
  def('dirt', Tile.DIRT, true, 0x734d2b, 0x573820),
  def('rock', Tile.ROCK, true, 0x808087, 0x5c5c66),
  def('sand', Tile.SAND, true, 0xedd987, 0xccb366, true),
  def('copper', Tile.COPPER, true, 0x734d2b, 0xde7829),
  def('gold', Tile.GOLD, true, 0x734d2b, 0xffd926),
  def('gem', Tile.GEM, true, 0x734d2b, 0x40ebf7),
  def('lava', Tile.LAVA, false, 0xff5c1a, 0xffb333),
  def('bedrock', Tile.BEDROCK, true, 0x140f0d, 0x140f0d),
  def('heal', Tile.HEAL, true, 0x734d2b, 0x3ee06a),
];

export function isSolid(t: number): boolean {
  return TILES[t].solid;
}

export function isDiggable(t: number): boolean {
  return TILES[t].diggable;
}

export function isOre(t: number): boolean {
  return TILES[t].value > 0;
}

// Dig time in whole ticks, in exact integer arithmetic:
// ms * (100 + 2*row)% * drill multiplier (millionths, 0.9^lvl) * 60 ticks/s, rounded up, never below the floor.
export function digTicks(tile: number, row: number, drillLvl: number): number {
  const ms = TILES[tile].digMs;
  const r = row < 0 ? 0 : row;
  const num = ms * (100 + T.digRowPct * r) * drillPpmOf(drillLvl) * T.TICK_HZ;
  const t = Math.ceil(num / 100000000000);
  return t < T.minDigTicks ? T.minDigTicks : t;
}
