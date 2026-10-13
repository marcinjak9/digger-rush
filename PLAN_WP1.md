# WP1 plan: `packages/shared` (Digger Rush sim core)

Pure TypeScript, ESM (`"type":"module"`), zero runtime deps, vitest at the root. Root `package.json`: `"workspaces":["packages/*"]`. Layout: `packages/shared/{package.json,tsconfig.json,src/*.ts,test/*.test.ts}`, `src/index.ts` re-exports everything. Imported unchanged by `server` (Node) and `client` (browser). Source of numbers: `NOTES.md` (prototype), overridden by the WP1 requirements below.

## Fixed timestep: 60 Hz (`DT = 1/60`, sim counts integer `tick`s)
Fastest motion is the post-drill glide at 20 t/s: 0.33 tiles/tick at 60 Hz, below the pod half-size of 0.36, so per-axis collision never tunnels. At 30 Hz it is 0.67 tiles/tick, which would need swept collision. 60 Hz also gives exact tick counts for the timers (wobble 24, cascade 6, min dig 12). Server simulates at 60 and sends snapshots at 20. Client prediction replays the same `stepPod` once per tick. Rendering interpolates and never steps the sim.

## Modules and exported API
- **tuning.ts**: `export const T = {...} as const`, the single home for every number. `TICK_HZ 60`, `TILE_PX 48`, `WORLD_W 96`, `CHUNK 16`, `SEED 1337`. Movement: `moveSpeed 4`, `moveAccel 28`, `moveDecel 70`, `airAccelMult 0.75`, `gridSeekMin 1.2`, `gravity 16`, `thrust 22` (W is weak, free, net +6 up), `vyMin -6`, `vyMax 11`, `podHalf 0.36`. Drilling: `drillProbe 0.1`, `glideSpeed 20`, `alignRate 25`, `maxDigSpeed 5`, `digRowScale 0.02`. Damage: `hullMax 100`, `hardLandSpeed 9`, `hardLandMult 6`, `lavaDps 25`, `sandHitDamage 18`, `armorPerLevel 0.10`. Sand: `wobbleTicks 24`, `fallStepDeciTicks 54` (0.09 s = 5.4 ticks, exact via a x10 integer accumulator), `cascadeTicks 6`. Heal: `healChance 1/400`, `healAmount 35`, `healMinRow 6`. Shop: `shopBase 50`, `shopMult 1.6`, `maxLevel 5`, `SHOP_COST = [50,80,128,204,327]` (precomputed table, no `**` at runtime), `DRILL_MULT = [1,.85,.72,.61,.52,.44]`. Generation constants come from NOTES §3 (bands, veins, ramps, salts).
- **tiles.ts**: `enum Tile {EMPTY=0..SULPHUR=14, HEAL=15}`, `TILES: readonly TileDef[]` (`hardness, value, falls, damage, tier, solid, diggable, color, fleck`) ported from NOTES §1, plus HEAL (hardness 0.4, value 0, red fleck). Helpers: `isSolid(t)`, `isDiggable(t, drillLvl)`, `digTicks(t, row, drillLvl) = max(12, ceil(hardness*(1+0.02*row)*DRILL_MULT[lvl]*60))`.
- **hash.ts**: `fmix32(h)` uses `Math.imul` and `>>>`. `u32(seed,x,y,salt)` = `fmix(seed ^ Math.imul(salt,0x9E3779B1))`, then `^ (x>>>0)` and `^ (y>>>0)`, each followed by fmix. Also `unit()` = `(u32>>>8)/2**24`, `rangeI()`, `anchor()`. Must match GDScript `grid_hash.gd` bit-for-bit, including negative coordinates.
- **worldgen.ts**: `tileAt(seed,x,y): {tile, aux}` is pure and reads no neighbour chunks. Rules: `x<0||x>=96` gives WALL; `y<0` gives EMPTY (sky). Otherwise follow NOTES §3 in order: air pocket, sand pocket with aux ore, the r-band roll (lava/rock/basalt), veins via the 3x3 anchor test, then heal (`unit(salt 7) < 1/400` on DIRT/ROCK, `y>=6`). Foundation pad is dropped. Also `generateChunk(seed,cx,cy): {tiles:Uint8Array(256), aux:Uint8Array(256)}` (row-major) and `settleSand(chunk)`, which only settles within the column of its own chunk so chunks stay independent.
- **world.ts**: `class World(seed)`. `chunks: Map<number, Chunk>` with key `cy*6+cx`, created lazily. `get(x,y)`, `getAux`, `set(x,y,tile,aux?)`. `set` records into `chunk.diff: Map<idx,tile>` (used for late-join and snapshots, because generated tiles are never sent). It also pushes `(x,y-1)` onto `dirty: Set<key>` when a tile becomes non-solid, and appends `{tick,x,y,tile}` to `changes[]`, which the server drains each snapshot. Also `drainChanges()`, `applyChanges()` (client), and `chunkDiff(cx,cy)`.
- **input.ts**: `interface InputCmd {seq:u32; ticks:u8 /*1..4 ticks covered*/; left; right; up; down: boolean}`, plus `packInput`/`unpackInput` as a 1-byte mask. The server clamps `ticks` and drops commands with stale `seq`.
- **pod.ts**: `PodState {x,y,vx,vy,grounded,drill:{dx,dy,tx,ty,ticksLeft,total}|null, mem:{tx,ty,ticksDone}|null, glide:{...}|null}`. `stepPod(pod, in, world, lvls): PodEvents` mutates `pod` and only reads `world`. It returns `{dug?:{x,y,tile,aux}, landDamage, lavaTicks}`. Rules:
  - Horizontal drill is allowed any time, including airborne.
  - Down-drill requires `grounded`.
  - There is no up or diagonal drill.
  - No drill starts while falling faster than 9.
  - A drill commits: snap flush, hold still. Vertical drilling eases x toward the column centre.
  - A direction change cancels the drill, and `mem` keeps its progress.
  - On finish, emit `dug`, glide 20 t/s into the hole, and chain if the input is still held.
  - Hard landing deals `(impactVy-9)*6` when `impactVy > 9`.
  - At the end of every tick, positions are quantized to 1/1024 tile, so snapshots (int32) round-trip exactly.
- **sand.ts**: `class SandSim` with `step(world, tick, pods): SandEvents`. It pops `world.dirty` and has no world scan. An unsupported column wobbles for 24 + 6n ticks; returning support cancels it. A falling block moves 1 cell each time its x10 accumulator passes 54. On landing it writes the tile back (aux kept). A block whose AABB overlaps a pod emits `hit{podId, 18}` and is removed. It emits `wobble/fall/land/hit` events for clients. The server runs it in multiplayer; the client runs the same class only in offline mode.
- **player.ts**: `Player {wallet, score, highScore, hull, lvl:{drill,armor,engine}}`. `applyDamage(p, raw) = raw*(1-0.1*armor)`. `onDug(p, tile)` adds `value` to both wallet and score. HEAL adds `+35` hull, capped at max. `buyUpgrade(p, kind): ok|'max'|'funds'` validates level `< 5` and `wallet >= SHOP_COST[lvl]`, then deducts from wallet only. When `hull<=0`, `die(p)` sets `highScore = max(highScore, score)` and resets wallet, score, hull, and levels.
- **sim.ts**: `simTick(world, sand, players, inputs, tick)` is the one ordering used everywhere. For each player in id order: stepPod, then apply `dug` with world.set and onDug, then land/lava damage. Next comes sand.step and sand hits, then deaths and respawn at `(spawnX(id), -2)`.

## Determinism rules
1. No `Math.random`, `Date`, or `performance.now()` in `shared/src`, enforced by a lint grep test. All randomness is `hash.u32(seed, ints...)`.
2. Hash inputs are always ints (`|0` / `>>>0`). Never hash floats.
3. The sim uses only `+ - * /`, `Math.floor/ceil/round/min/max/abs/sqrt`, which are IEEE-exact in every engine. No `sin/cos/pow/exp/log` (they differ between V8, SpiderMonkey, and JSC). Use precomputed tables instead.
4. Integer ticks for all timers. Fixed iteration order (ids sorted; Maps iterated in insertion order and never keyed by float).
5. Quantize pod state each tick. Client and server must run the same `shared` build; the handshake checks a `SIM_VERSION` constant.

## Unit tests (`packages/shared/test`)
- **hash**: golden values from `grid_hash.gd` for (1337, x, y, salt), including negative x and y.
- **determinism**:
  - Two `World`s built from the same seed give identical chunks.
  - 600 ticks of a scripted input stream produce identical PodState and changes on two runs.
  - Stepping 1 tick x N matches commands with `ticks=N`.
- **chunk independence**: generating chunk (2,5) alone equals the same region of a 3x3 neighbourhood generated in any order. Side walls and sky behave as specified.
- **drill timing**: dirt at row 0 finishes in exactly `digTicks`. The 12-tick floor holds. Cancel then resume keeps progress. Down-drill is refused while airborne. Horizontal drill works mid-air. Up-drill never happens.
- **physics**: W thrust gives net upward acceleration of 6. Landing at 12 t/s deals 18. Armor 3 gives a 30% cut. Lava does 25/s over 60 ticks.
- **shop cost validation**: `SHOP_COST[l] == floor(50*1.6**l)`. Purchases are refused at max level and when funds are short. Wallet decreases by exactly the cost.
- **death reset keeps highScore**: highScore survives death, and the other fields reset.
- **purchases never reduce score**: property test over random buy sequences (seeded hash, not Math.random).
- **sand**: wobble lasts 24 ticks, the cascade offset is 6 ticks per block, fall timing averages 5.4 ticks per cell, a pod hit deals 18 and removes the block, and returning support cancels the wobble.
- **heal**: frequency over a 96x4000 region is 1/400 ±15%. Heal is capped at hullMax.
- **purity**: grep `src/` for `Math.random|Date|sin\(|cos\(|pow\(`.

## Risks
- **Float drift between prediction and server.** Rules 3 to 5 make this deterministic in practice. Any residual drift is absorbed by reconciliation: snap to the server snapshot and replay unacked inputs. Snapshots carry exact quantized ints, so replay starts bit-identical. Code version skew is the realistic cause, which is why `SIM_VERSION` exists.
- **Sand vs pod in multiplayer.** Sand is server-only. The client renders sand events and does not predict them, so a hit may show up about 100 ms after the visual overlap. Predicted pods treat falling blocks as non-solid. A landed block arrives as a tile change, so the client can be pushed out on reconcile, which causes a visible snap. Mitigation: wobble (400 ms) is longer than the round-trip time, so the warning arrives before the fall.
- **Contested tiles.** Two players can drill the same tile. The first one the server finishes wins and the other drill cancels. The client predicts `dug` but only commits ore and wallet from the server.
- **Predicted dig vs server rejection** (for example, sand moved into the cell): the client rolls back the tile from `changes`.
- **Endless depth**: the chunk map grows without bound. The server evicts unmodified chunks with no players nearby; the diff is kept.
