import { T } from './tuning.js';
import { Tile, TILES } from './tiles.js';

export type UpgradeKind = 'drill' | 'maxHp' | 'moveSpeed' | 'oreValue' | 'armor';
export const UPGRADE_KINDS: readonly UpgradeKind[] = ['drill', 'maxHp', 'moveSpeed', 'oreValue', 'armor'];

export type Levels = Record<UpgradeKind, number>;

export interface Player {
  wallet: number;
  score: number;
  highScore: number;
  hull: number;
  lvl: Levels;
}

export type BuyResult = 'ok' | 'max' | 'funds';

export function zeroLevels(): Levels {
  return { drill: 0, maxHp: 0, moveSpeed: 0, oreValue: 0, armor: 0 };
}

export function maxHpOf(lv: Levels): number {
  return T.hullBase + T.upgrade.hpPerLevel * lv.maxHp;
}

export function moveSpeedOf(lv: Levels): number {
  return (T.moveSpeed * (100 + T.upgrade.movePct * lv.moveSpeed)) / 100;
}

// Ore value after the oreValue upgrade, floored.
export function boostedValue(base: number, lv: Levels): number {
  return Math.floor((base * (100 + T.upgrade.orePct * lv.oreValue)) / 100);
}

export function newPlayer(highScore = 0): Player {
  const lvl = zeroLevels();
  return { wallet: 0, score: 0, highScore, hull: maxHpOf(lvl), lvl };
}

export function upgradeCost(level: number): number {
  return T.upgrade.cost[level];
}

// Damage after armor; returns the damage applied.
export function applyDamage(p: Player, raw: number): number {
  const d = (raw * (100 - T.upgrade.armorPct * p.lvl.armor)) / 100;
  p.hull -= d;
  return d;
}

// Called when a tile was mined. `aux` is the ore hidden inside a sand tile.
export function onDug(p: Player, tile: number, aux: number): void {
  if (tile === Tile.HEAL) {
    const max = maxHpOf(p.lvl);
    const h = p.hull + max * T.healFrac;
    p.hull = h > max ? max : h;
    return;
  }
  const base = TILES[tile].value > 0 ? TILES[tile].value : TILES[aux].value;
  if (base <= 0) return;
  const v = boostedValue(base, p.lvl);
  p.wallet += v;
  p.score += v;
}

// Paid from the wallet only; score is never touched.
export function buyUpgrade(p: Player, kind: UpgradeKind): BuyResult {
  const l = p.lvl[kind];
  if (l >= T.upgrade.maxLevel) return 'max';
  const cost = T.upgrade.cost[l];
  if (p.wallet < cost) return 'funds';
  p.wallet -= cost;
  p.lvl[kind] = l + 1;
  if (kind === 'maxHp') p.hull += T.upgrade.hpPerLevel;
  return 'ok';
}

export function isDead(p: Player): boolean {
  return p.hull <= 0;
}

export function die(p: Player): void {
  if (p.score > p.highScore) p.highScore = p.score;
  p.wallet = 0;
  p.score = 0;
  p.lvl = zeroLevels();
  p.hull = maxHpOf(p.lvl);
}
