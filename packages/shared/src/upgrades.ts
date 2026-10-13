import { T } from './tuning.js';

// Precomputed upgrade tables. Built once with iterative multiplication (no pow), so every
// engine produces the same doubles. Index = level, clamped to T.upgrade.levelCap.

const N = T.upgrade.levelCap + 1;
const cost = new Float64Array(N);
const drillPpm = new Int32Array(N); // dig time multiplier in millionths (integer math in digTicks)
const armor = new Float64Array(N);
const radarTicks = new Int32Array(N);

(function build(): void {
  let c = T.upgrade.costBase;
  let d = 1;
  let a = 1;
  let r = T.radarCooldownSeconds * T.TICK_HZ;
  const minTicks = T.radarMinCooldownSeconds * T.TICK_HZ;
  for (let l = 0; l < N; l++) {
    cost[l] = Math.floor(c + 1e-6);
    drillPpm[l] = Math.round(d * 1000000);
    armor[l] = a;
    radarTicks[l] = Math.max(minTicks, Math.ceil(r - 1e-9));
    c *= T.upgrade.costMult;
    d *= T.upgrade.drillMult;
    a *= T.upgrade.armorMult;
    r *= T.upgrade.radarCdMult;
  }
})();

export function clampLevel(level: number): number {
  const l = level | 0;
  return l < 0 ? 0 : l > T.upgrade.levelCap ? T.upgrade.levelCap : l;
}

// Price of buying the next level when at `level` (0-based).
export function upgradeCost(level: number): number {
  return cost[clampLevel(level)];
}

// Dig time multiplier in millionths, 0.9^level.
export function drillPpmOf(level: number): number {
  return drillPpm[clampLevel(level)];
}

// Damage multiplier, 0.9^level, always > 0.
export function armorMultOf(level: number): number {
  return armor[clampLevel(level)];
}

// Radar cooldown in sim ticks: base * 0.9^level, floored at the minimum.
export function radarCooldownTicksOf(level: number): number {
  return radarTicks[clampLevel(level)];
}

// Move speed multiplier: +8% per level, capped at maxMoveMult.
export function moveMultOf(level: number): number {
  const m = (100 + T.upgrade.movePct * clampLevel(level)) / 100;
  return m > T.upgrade.maxMoveMult ? T.upgrade.maxMoveMult : m;
}
