import { describe, expect, it } from 'vitest';
import {
  T, Tile, UPGRADE_KINDS, applyDamage, boostedValue, buyUpgrade, createPlayer, die, maxHpOf, newPlayer, onDug,
  simTick, SandSim, World, u32, digTicks, moveSpeedOf, type Player,
} from '../src/index.js';

describe('shop', () => {
  it('cost table equals floor(50 * 1.6^level)', () => {
    for (let l = 0; l < T.upgrade.maxLevel; l++) {
      expect(T.upgrade.cost[l]).toBe(Math.floor(T.upgrade.costBase * T.upgrade.costMult ** l));
    }
  });

  it('refuses when funds are short and at max level; deducts exactly the cost', () => {
    const p = newPlayer();
    expect(buyUpgrade(p, 'drill')).toBe('funds');
    p.wallet = 49;
    expect(buyUpgrade(p, 'drill')).toBe('funds');
    p.wallet = 1000;
    p.score = 123;
    for (let l = 0; l < 5; l++) {
      const before = p.wallet;
      expect(buyUpgrade(p, 'armor')).toBe('ok');
      expect(p.wallet).toBe(before - T.upgrade.cost[l]);
      expect(p.lvl.armor).toBe(l + 1);
    }
    p.wallet = 100000;
    expect(buyUpgrade(p, 'armor')).toBe('max');
    expect(p.wallet).toBe(100000);
    expect(p.score).toBe(123);
  });

  it('upgrade effects', () => {
    const p = newPlayer();
    p.lvl.maxHp = 5;
    expect(maxHpOf(p.lvl)).toBe(200);
    p.lvl.moveSpeed = 5;
    expect(moveSpeedOf(p.lvl)).toBeCloseTo(5.6, 10);
    p.lvl.oreValue = 3;
    expect(boostedValue(8, p.lvl)).toBe(10);
    expect(boostedValue(400, p.lvl)).toBe(520);
    p.lvl.armor = 3;
    p.hull = 200;
    applyDamage(p, 100);
    expect(p.hull).toBeCloseTo(130, 10);
    expect(digTicks(Tile.DIRT, 0, 0)).toBe(17);
    expect(digTicks(Tile.ROCK, 0, 0)).toBe(66);
    expect(digTicks(Tile.ROCK, 0, 5)).toBe(33);
    expect(digTicks(Tile.DIRT, 0, 5)).toBe(T.minDigTicks);
    expect(digTicks(Tile.DIRT, 100, 0)).toBe(Math.ceil((280 * 300 * 60) / 100000));
  });

  it('buying maxHp also raises the current hull', () => {
    const p = newPlayer();
    p.wallet = 50;
    buyUpgrade(p, 'maxHp');
    expect(p.hull).toBe(120);
  });
});

describe('mining and heal', () => {
  it('mining ore adds the boosted value to wallet and score', () => {
    const p = newPlayer();
    onDug(p, Tile.GOLD, 0);
    expect(p.wallet).toBe(120);
    expect(p.score).toBe(120);
    p.lvl.oreValue = 2;
    onDug(p, Tile.COPPER, 0);
    expect(p.wallet).toBe(120 + 9);
    onDug(p, Tile.SAND, Tile.GEM); // sand hiding a gem
    expect(p.score).toBe(120 + 9 + 480);
    onDug(p, Tile.DIRT, 0);
    expect(p.score).toBe(120 + 9 + 480);
  });

  it('heal restores 50% of max hp, capped, with no money or score', () => {
    const p = newPlayer();
    p.hull = 30;
    onDug(p, Tile.HEAL, 0);
    expect(p.hull).toBe(80);
    onDug(p, Tile.HEAL, 0);
    expect(p.hull).toBe(100);
    p.lvl.maxHp = 5;
    p.hull = 10;
    onDug(p, Tile.HEAL, 0);
    expect(p.hull).toBe(110);
    expect(p.wallet).toBe(0);
    expect(p.score).toBe(0);
  });
});

describe('death', () => {
  it('die keeps highScore and resets everything else', () => {
    const p: Player = newPlayer(50);
    p.wallet = 400;
    p.score = 900;
    p.lvl.drill = 3;
    p.lvl.maxHp = 2;
    p.hull = -3;
    die(p);
    expect(p.highScore).toBe(900);
    expect(p.wallet).toBe(0);
    expect(p.score).toBe(0);
    expect(p.hull).toBe(100);
    expect(Object.values(p.lvl)).toEqual([0, 0, 0, 0, 0]);
    p.score = 10;
    die(p);
    expect(p.highScore).toBe(900);
  });

  it('simTick kills at hull<=0 and respawns on the surface', () => {
    const w = new World(1337);
    const sand = new SandSim();
    const pl = createPlayer(3, newPlayer());
    pl.stats.score = 77;
    pl.stats.hull = 0;
    const ev = simTick(w, sand, [pl], new Map(), 1);
    expect(ev.deaths).toEqual([3]);
    expect(pl.stats.highScore).toBe(77);
    expect(pl.stats.hull).toBe(100);
    expect(pl.pod.y).toBe(-T.podHalf);
  });

  it('purchases never reduce score (seeded property test)', () => {
    for (let run = 0; run < 20; run++) {
      const p = newPlayer();
      const ores = [Tile.COPPER, Tile.GOLD, Tile.GEM, Tile.DIRT, Tile.HEAL];
      for (let i = 0; i < 400; i++) {
        const h = u32(run + 1, i, 0, 77);
        const scoreBefore = p.score;
        const walletBefore = p.wallet;
        if (h % 3 === 0) {
          const r = buyUpgrade(p, UPGRADE_KINDS[(h >>> 4) % 5]);
          expect(p.score).toBe(scoreBefore);
          if (r !== 'ok') expect(p.wallet).toBe(walletBefore);
          else expect(p.wallet).toBeLessThan(walletBefore);
        } else {
          onDug(p, ores[(h >>> 4) % 5], 0);
          expect(p.score).toBeGreaterThanOrEqual(scoreBefore);
        }
        expect(p.wallet).toBeGreaterThanOrEqual(0);
        expect(p.score).toBeGreaterThanOrEqual(p.wallet);
      }
    }
  });
});
