import { describe, expect, it } from 'vitest';
import {
  T, Tile, UPGRADE_KINDS, applyDamage, buyUpgrade, createPlayer, die, maxHpOf, newPlayer, onDug, oreValueAt,
  simTick, SandSim, World, u32, digTicks, moveSpeedOf, upgradeCost, tryRadar, stepRadarCooldown,
  radarCooldownTicksOf, armorMultOf, scanOre, lightRadius, spawnX, spawnPod, type Player,
} from '../src/index.js';

describe('shop', () => {
  it('cost equals floor(50 * 1.6^level), endless, finite at the cap', () => {
    let c = 50;
    for (let l = 0; l < 60; l++) {
      expect(upgradeCost(l)).toBe(Math.floor(c + 1e-6));
      c *= 1.6;
    }
    expect([0, 1, 2, 3, 4].map((l) => upgradeCost(l))).toEqual([50, 80, 128, 204, 327]);
    expect(Number.isFinite(upgradeCost(T.upgrade.levelCap))).toBe(true);
    expect(upgradeCost(100000)).toBe(upgradeCost(T.upgrade.levelCap));
    expect(upgradeCost(11)).toBeGreaterThan(upgradeCost(10));
  });

  it('there are exactly 5 upgrades and no ore value upgrade', () => {
    expect([...UPGRADE_KINDS]).toEqual(['drill', 'maxHp', 'moveSpeed', 'armor', 'radar']);
  });

  it('refuses when funds are short; deducts exactly the cost; no cap at level 5', () => {
    const p = newPlayer();
    expect(buyUpgrade(p, 'drill')).toBe('funds');
    p.wallet = 49;
    expect(buyUpgrade(p, 'drill')).toBe('funds');
    p.wallet = 1e9;
    p.score = 123;
    for (let l = 0; l < 12; l++) {
      const before = p.wallet;
      expect(buyUpgrade(p, 'armor')).toBe('ok');
      expect(p.wallet).toBe(before - upgradeCost(l));
      expect(p.lvl.armor).toBe(l + 1);
    }
    expect(p.score).toBe(123);
    p.lvl.armor = T.upgrade.levelCap;
    p.wallet = Infinity;
    expect(buyUpgrade(p, 'armor')).toBe('max');
  });

  it('upgrade effects', () => {
    const p = newPlayer();
    p.lvl.maxHp = 5;
    expect(maxHpOf(p.lvl)).toBe(200);
    p.lvl.moveSpeed = 5;
    expect(moveSpeedOf(p.lvl)).toBeCloseTo(5.6, 10);
    p.lvl.moveSpeed = 1000;
    expect(moveSpeedOf(p.lvl)).toBeCloseTo(T.moveSpeed * T.upgrade.maxMoveMult, 10);
    p.lvl.armor = 3;
    p.hull = 200;
    applyDamage(p, 100);
    expect(p.hull).toBeCloseTo(200 - 72.9, 10);
    p.lvl.armor = T.upgrade.levelCap;
    expect(armorMultOf(p.lvl.armor)).toBeGreaterThan(0);
    expect(digTicks(Tile.DIRT, 0, 0)).toBe(17);
    expect(digTicks(Tile.ROCK, 0, 0)).toBe(66);
    expect(digTicks(Tile.ROCK, 0, 5)).toBe(39); // 66 * 0.59049 = 38.97
    expect(digTicks(Tile.DIRT, 0, 5)).toBe(T.minDigTicks);
    expect(digTicks(Tile.ROCK, 0, 10000)).toBe(T.minDigTicks);
    expect(digTicks(Tile.DIRT, 100, 0)).toBe(Math.ceil((280 * 300 * 60) / 100000));
  });

  it('buying maxHp also raises the current hull', () => {
    const p = newPlayer();
    p.wallet = 50;
    buyUpgrade(p, 'maxHp');
    expect(p.hull).toBe(120);
  });
});

describe('radar', () => {
  it('cooldown: 10 s base, x0.9 per level, floored at 1 s', () => {
    expect(radarCooldownTicksOf(0)).toBe(600);
    expect(radarCooldownTicksOf(1)).toBe(540);
    expect(radarCooldownTicksOf(T.upgrade.levelCap)).toBe(60);
    for (let l = 1; l < 100; l++) expect(radarCooldownTicksOf(l)).toBeLessThanOrEqual(radarCooldownTicksOf(l - 1));
  });

  it('tryRadar starts the cooldown, which ticks down in sim ticks and resets on death', () => {
    const w = new World(1337);
    const pl = createPlayer(1, newPlayer(), w);
    expect(tryRadar(pl.stats)).toBe('ok');
    expect(pl.stats.radarTicks).toBe(600);
    expect(tryRadar(pl.stats)).toBe('cooldown');
    const sand = new SandSim();
    for (let t = 1; t <= 599; t++) simTick(w, sand, [pl], new Map(), t);
    expect(pl.stats.radarTicks).toBe(1);
    expect(tryRadar(pl.stats)).toBe('cooldown');
    stepRadarCooldown(pl.stats);
    expect(tryRadar(pl.stats)).toBe('ok');
    pl.stats.lvl.radar = 3;
    pl.stats.radarTicks = 0;
    tryRadar(pl.stats);
    expect(pl.stats.radarTicks).toBe(radarCooldownTicksOf(3));
    die(pl.stats);
    expect(pl.stats.radarTicks).toBe(0);
    expect(pl.stats.lvl.radar).toBe(0);
  });

  it('scanOre finds ore, heal and sand-hidden ore within the radius, into a reused buffer', () => {
    const w = new World(1337);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) w.set(x, y, Tile.DIRT);
    w.set(10, 10, Tile.GOLD);
    w.set(14, 10, Tile.HEAL);
    w.set(10, 15, Tile.SAND, Tile.GEM);
    w.set(11, 11, Tile.SAND, 0);
    w.set(10, 25, Tile.COPPER); // out of range
    w.set(20, 20, Tile.GEM); // out of range
    const buf = new Int32Array(3 * 64);
    const n = scanOre(w, 10, 10, T.radarRadius, buf);
    const found = new Map<string, number>();
    for (let i = 0; i < n; i++) found.set(buf[i * 3] + ',' + buf[i * 3 + 1], buf[i * 3 + 2]);
    expect(found.get('10,10')).toBe(Tile.GOLD);
    expect(found.get('14,10')).toBe(Tile.HEAL);
    expect(found.get('10,15')).toBe(Tile.GEM);
    expect(found.has('11,11')).toBe(false);
    expect(found.has('10,25')).toBe(false);
    expect(found.has('20,20')).toBe(false);
    const tiny = new Int32Array(3);
    expect(scanOre(w, 10, 10, T.radarRadius, tiny)).toBe(1);
  });
});

describe('light radius', () => {
  it('14 tiles near the surface, linear to 3 tiles at row 200, never smaller', () => {
    expect(lightRadius(-5)).toBe(14);
    expect(lightRadius(8)).toBe(14);
    expect(lightRadius(200)).toBe(3);
    expect(lightRadius(5000)).toBe(3);
    expect(lightRadius(104)).toBeCloseTo(8.5, 10);
    let prev = 99;
    for (let r = 0; r < 400; r++) {
      const v = lightRadius(r);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(3);
      prev = v;
    }
  });
});

describe('respawn', () => {
  it('always rests on a solid tile, in range, and different salts give different x', () => {
    const w = new World(1337);
    const xs = new Set<number>();
    for (let salt = 0; salt < 300; salt++) {
      const x = spawnX(7, salt);
      expect(x).toBeGreaterThanOrEqual(T.spawnXMin + 0.5);
      expect(x).toBeLessThanOrEqual(T.spawnXMax + 0.5);
      xs.add(x);
      const pod = spawnPod(w, 7, salt);
      const col = Math.floor(pod.x);
      const row = Math.round(pod.y + T.podHalf);
      expect(w.get(col, row)).not.toBe(Tile.EMPTY);
      expect(w.get(col, row)).not.toBe(Tile.LAVA);
      for (let y = 0; y < row; y++) expect(w.get(col, y)).toBe(Tile.EMPTY);
      expect(pod.grounded).toBe(true);
    }
    expect(xs.size).toBeGreaterThan(60);
  });

  it('each death in simTick picks a new deterministic column', () => {
    const run = (): number[] => {
      const w = new World(1337);
      const sand = new SandSim();
      const pl = createPlayer(1, newPlayer(), w, 5);
      const out: number[] = [];
      let t = 0;
      for (let i = 0; i < 8; i++) {
        pl.stats.hull = 0;
        simTick(w, sand, [pl], new Map(), ++t);
        expect(pl.deadTicks).toBeGreaterThan(0);
        while (pl.deadTicks > 0) simTick(w, sand, [pl], new Map(), ++t);
        out.push(pl.pod.x);
      }
      return out;
    };
    const a = run();
    expect(a).toEqual(run());
    expect(new Set(a).size).toBeGreaterThan(5);
  });
});

describe('mining and heal', () => {
  it('ore value scales 1% per tile of depth, for wallet and score', () => {
    expect(oreValueAt(120, 0)).toBe(120);
    expect(oreValueAt(120, 50)).toBe(180);
    expect(oreValueAt(8, 7)).toBe(8); // floor(8.56)
    expect(oreValueAt(400, 7)).toBe(428);
    const p = newPlayer();
    onDug(p, Tile.GOLD, 0, 0);
    expect(p.wallet).toBe(120);
    expect(p.score).toBe(120);
    onDug(p, Tile.COPPER, 0, 100);
    expect(p.wallet).toBe(120 + 16);
    onDug(p, Tile.SAND, Tile.GEM, 50); // sand hiding a gem
    expect(p.score).toBe(120 + 16 + 600);
    onDug(p, Tile.DIRT, 0, 50);
    expect(p.score).toBe(120 + 16 + 600);
  });

  it('heal restores 50% of max hp, capped, with no money or score', () => {
    const p = newPlayer();
    p.hull = 30;
    onDug(p, Tile.HEAL, 0, 80);
    expect(p.hull).toBe(80);
    onDug(p, Tile.HEAL, 0, 80);
    expect(p.hull).toBe(100);
    p.lvl.maxHp = 5;
    p.hull = 10;
    onDug(p, Tile.HEAL, 0, 80);
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
    const pl = createPlayer(3, newPlayer(), w);
    pl.stats.score = 77;
    pl.stats.hull = 0;
    const ev = simTick(w, sand, [pl], new Map(), 1);
    expect(ev.deaths).toEqual([3]);
    expect(pl.stats.highScore).toBe(77);
    expect(pl.finalScore).toBe(77);
    expect(pl.stats.hull).toBe(100);
    expect(pl.deadTicks).toBe(T.respawnTicks - 1); // the death tick already counted down once
    for (let t = 2; t < T.respawnTicks; t++) simTick(w, sand, [pl], new Map(), t);
    expect(pl.deadTicks).toBe(1);
    const ev2 = simTick(w, sand, [pl], new Map(), T.respawnTicks);
    expect(ev2.respawns).toEqual([3]);
    expect(pl.invulnTicks).toBe(T.invulnTicks);
    expect(Number.isInteger(pl.pod.y + T.podHalf)).toBe(true);
    expect(w.get(Math.floor(pl.pod.x), pl.pod.y + T.podHalf)).not.toBe(Tile.EMPTY);
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
          onDug(p, ores[(h >>> 4) % 5], 0, h % 90);
          expect(p.score).toBeGreaterThanOrEqual(scoreBefore);
        }
        expect(p.wallet).toBeGreaterThanOrEqual(0);
        expect(p.score).toBeGreaterThanOrEqual(p.wallet);
      }
    }
  });
});

describe('live high score', () => {
  it('highScore follows the score as it rises, never decreases, and survives death', () => {
    const p = newPlayer(10);
    onDug(p, Tile.COPPER, 0, 0); // +8
    expect(p.score).toBe(8);
    expect(p.highScore).toBe(10);
    onDug(p, Tile.GOLD, 0, 0); // +120
    expect(p.highScore).toBe(128);
    const before = p.highScore;
    buyUpgrade(p, 'drill'); // spends wallet only
    expect(p.score).toBe(128);
    expect(p.highScore).toBe(before);
    die(p);
    expect(p.score).toBe(0);
    expect(p.highScore).toBe(128);
    onDug(p, Tile.COPPER, 0, 0);
    expect(p.highScore).toBe(128); // 8 < 128
  });
});
