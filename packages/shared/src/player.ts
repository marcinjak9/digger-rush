import { T } from './tuning.js';
import { Tile, TILES } from './tiles.js';
import { armorMultOf, clampLevel, moveMultOf, radarCooldownTicksOf, upgradeCost } from './upgrades.js';

export type UpgradeKind = 'drill' | 'maxHp' | 'moveSpeed' | 'armor' | 'radar';
export const UPGRADE_KINDS: readonly UpgradeKind[] = ['drill', 'maxHp', 'moveSpeed', 'armor', 'radar'];

export type Levels = Record<UpgradeKind, number>;

export interface Player {
  wallet: number;
  score: number;
  highScore: number;
  hull: number;
  lvl: Levels;
  radarTicks: number; // sim ticks until the radar can be used again
}

export type BuyResult = 'ok' | 'max' | 'funds';

export function zeroLevels(): Levels {
  return { drill: 0, maxHp: 0, moveSpeed: 0, armor: 0, radar: 0 };
}

export function maxHpOf(lv: Levels): number {
  return T.hullBase + T.upgrade.hpPerLevel * clampLevel(lv.maxHp);
}

export function moveSpeedOf(lv: Levels): number {
  return T.moveSpeed * moveMultOf(lv.moveSpeed);
}

// Ore value at a depth row: floor(base * (1 + oreDepthBonus * row)), in exact integer math.
export function oreValueAt(base: number, row: number): number {
  const per = Math.round(T.oreDepthBonus * 10000);
  const r = row < 0 ? 0 : row;
  return Math.floor((base * (10000 + per * r)) / 10000);
}

export function newPlayer(highScore = 0): Player {
  const lvl = zeroLevels();
  return { wallet: 0, score: 0, highScore, hull: maxHpOf(lvl), lvl, radarTicks: 0 };
}

export { upgradeCost };

// Damage after armor; returns the damage applied.
export function applyDamage(p: Player, raw: number): number {
  const d = raw * armorMultOf(p.lvl.armor);
  p.hull -= d;
  return d;
}

// Called when a tile was mined at depth `row`. `aux` is the ore hidden inside a sand tile.
export function onDug(p: Player, tile: number, aux: number, row: number): void {
  if (tile === Tile.HEAL) {
    const max = maxHpOf(p.lvl);
    const h = p.hull + max * T.healFrac;
    p.hull = h > max ? max : h;
    return;
  }
  const base = TILES[tile].value > 0 ? TILES[tile].value : TILES[aux].value;
  if (base <= 0) return;
  const v = oreValueAt(base, row);
  p.wallet += v;
  p.score += v;
}

// Paid from the wallet only; score is never touched. 'max' only at the sanity cap (levelCap).
export function buyUpgrade(p: Player, kind: UpgradeKind): BuyResult {
  const l = p.lvl[kind];
  if (l >= T.upgrade.levelCap) return 'max';
  const cost = upgradeCost(l);
  if (p.wallet < cost) return 'funds';
  p.wallet -= cost;
  p.lvl[kind] = l + 1;
  if (kind === 'maxHp') p.hull += T.upgrade.hpPerLevel;
  return 'ok';
}

// Radar use: starts the cooldown when ready. The scan itself is scanOre().
export function tryRadar(p: Player): 'ok' | 'cooldown' {
  if (p.radarTicks > 0) return 'cooldown';
  p.radarTicks = radarCooldownTicksOf(p.lvl.radar);
  return 'ok';
}

export function stepRadarCooldown(p: Player): void {
  if (p.radarTicks > 0) p.radarTicks--;
}

export function isDead(p: Player): boolean {
  return p.hull <= 0;
}

export function die(p: Player): void {
  if (p.score > p.highScore) p.highScore = p.score;
  p.wallet = 0;
  p.score = 0;
  p.lvl = zeroLevels();
  p.radarTicks = 0;
  p.hull = maxHpOf(p.lvl);
}
