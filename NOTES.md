# Prototype notes (WP0 scout)

Source: `C:\Users\marci\Projects\Endless Digger\prototype`. Read: data/tiles.json, data/gen.json, scripts/tuning.gd, grid_hash.gd, world_gen.gd, sand_sim.gd, pod.gd, player_state.gd, fx.gd, camera_rig.gd, hud.gd, tile_atlas.gd. Not read: world.gd, chunk.gd, depth_profile.json, tiles.gd (only grepped), main.gd.

## 1. Tile table

Colors are 0-1 floats in the JSON, shown here as RGB 0-255 (rounded). Hardness = base dig seconds (before depth and drill multipliers); 0 = cannot be dug. Tier is the drill tier needed.

| id | key | name | hardness (s) | value | falls | damage | tier | fuel_cost | solid | color RGB | fleck RGB (n, size) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | EMPTY | empty | 0 | 0 | no | 0 | 0 | 1.0 | no | 43,31,23 | - |
| 1 | DIRT | dirt | 0.28 | 0 | no | 0 | 0 | 1.0 | yes | 115,77,43 | 87,56,31 (5, 0.09) |
| 2 | ROCK | rock | 1.1 | 0 | no | 0 | 0 | 4.0 | yes | 128,128,135 | 92,92,102 (4, 0.20) |
| 3 | SAND | sand | 0.2 | 0 | yes | 0 | 0 | 0.6 | yes | 237,217,135 | 204,179,102 (8, 0.06) |
| 4 | COPPER | copper | 0.35 | 8 | no | 0 | 0 | 2.0 | yes | 115,77,43 | 222,120,41 (3, 0.20) |
| 5 | GOLD | gold | 0.5 | 120 | no | 0 | 0 | 6.0 | yes | 115,77,43 | 255,217,38 (2, 0.27) |
| 6 | GEM | gem | 0.8 | 400 | no | 0 | 0 | 8.0 | yes | 115,77,43 | 64,235,247 (1, 0.50, diamond) |
| 7 | LAVA | lava | 0 | 0 | no | 25 | 0 | 1.0 | no | 255,92,26 | 255,179,51 (4, 0.16) |
| 8 | WALL | wall (bedrock) | 0 | 0 | no | 0 | 0 | 1.0 | yes | 20,15,13 | none |
| 9 | FOUNDATION | foundation (bedrock) | 0 | 0 | no | 0 | 0 | 1.0 | yes | 77,87,102 | 115,128,148 (4, 0.12) |
| 10 | BASALT | basalt | 3.0 | 0 | no | 0 | 2 | 10.0 | yes | 51,51,64 | 82,84,102 (6, 0.12) |
| 11 | IRON | iron | 0.6 | 15 | no | 0 | 0 | 3.0 | yes | 115,77,43 | 191,140,128 (3, 0.22) |
| 12 | SILVER | silver | 0.65 | 40 | no | 0 | 0 | 5.0 | yes | 115,77,43 | 224,235,247 (2, 0.26) |
| 13 | OBSIDIAN | obsidian | 3.0 | 0 | no | 0 | 2 | 10.0 | yes | 26,13,46 | 140,77,217 (3, 0.16) |
| 14 | SULPHUR | sulphur | 0.4 | 0 | no | 0 | 0 | 2.0 | yes | 230,214,51 | 158,128,13 (7, 0.10) |

Notes: `shake` (ROCK 4, GEM 5, BASALT/OBSIDIAN 6, SULPHUR 2, others 0). Sulphur is a blast tile (fuse 0.8 s). Tiles.gd exposes `dig` = hardness. Atlas: 60 px tiles, 4 variants, procedurally painted (2 px darker rim, random flecks, gem drawn as a diamond).

## 2. Pod and tuning numbers (tuning.gd, pod.gd, player_state.gd, camera_rig.gd)

**Movement**
- move_speed 4.0 tiles/s; move_accel 28; move_decel 70 (braking); air_accel_mult 0.75
- grid_move true; grid_seek_min 1.2 tiles/s (glide to tile centre when stick released)
- gravity 16; thrust_accel 26; vy_min -6 (max climb); vy_max 11 (max fall)
- pod_half 0.36 tiles; hard_land_speed 9.0 (no drilling out of a faster fall); hard_land_mult 6.0 (not referenced in the files read)

**Drilling**
- dig_time(t, row) = dig_time[t] * (1 + 0.02 * row) * drill_mult; minimum 1 / max_dig_speed (5.0) seconds
- drill_probe 0.1 tiles; drill_glide_speed 20 tiles/s; align_rate 25 /s (vertical drill eases x to column centre)
- Fuel per finished tile = fuel_cost * fuel_per_cost_unit (0.5) * eff_mult, where eff_mult = (1 - 0.12)^level

**Fuel / hull / cargo**
- fuel_base_max 100; hull_base_max 100; cargo_base_cap 10
- Drain per s when active = (fuel_base 0.4 + fuel_horiz 0.9 * horiz + fuel_up 2.2 * up) * fuel_scale 0.7; idle = 0.15 * 0.7
- low_fuel_frac 0.25; return_climb_speed 6.0; return_warn_margin 1.25
- Refinery: 0.25 fuel per value unit burned. Upgrades: base cost 40, mult 1.5, max level 5

**Sand / hazards**
- sand_wobble 0.4 s; sand_fall_step 0.09 s per cell; sand_cascade 0.1 s; sand_hit_damage 18
- sulphur_fuse 0.8 s; blast_chain_cap 3; blast_hull_damage 30
- flask_price 25; flask_max 5; flask_cooldown 0.6; flask_convert_max 3

**Camera** (camera_rig.gd: static helpers, testable)
- cam_follow_y 8 /s; cam_follow_x 7 /s; cam_pod_frac 0.3333 (pod sits 1/3 down; look-ahead)
- cam_dead_x 1.0 tile horizontal dead zone (only when world_cols > 9); exit_arrow_near 6.0 tiles
- View 9 x 16 tiles; METERS_PER_TILE 5.0

**Light / ore sense**: light_start_m 40; light_full_dark_m 1200; light_radius 7 -> 2.5 tiles; light_soft 1.5; light_dark_alpha 0.92; ore_sense_radius 5.

**Controls**: stick_radius 46 px; stick_deadzone 0.28; axis_hysteresis 1.4; point_deadzone 18 px.

## 3. Generation (world_gen.gd, grid_hash.gd, data/gen.json)

**Hash**: murmur3 fmix32 chain, no floats. `h = fmix(seed ^ (salt * 0x9E3779B1)); h = fmix(h ^ x); h = fmix(h ^ y)`. `unit` = (u32 >> 8) / 2^24 in [0,1). `anchor` uses salts salt*2 and salt*2+1 for offsets within a cell. World seed 1337.

**Tile order per (x,y)**, first match wins:
1. y < 1: EMPTY. Foundation: rows 1..3 with |x - centre| <= 1.
2. Air pocket: y >= 4 and hash(x>>1, y>>1, salt 5) < 0.05 -> EMPTY.
3. Sand pocket: y >= 3, coarse cell (3 wide x 4 tall) hash < 0.2 AND per-tile hash(salt 2) < 0.85 -> SAND. Sand ore inside (per-tile hash salt 3 < 0.16) is stored as aux: GEM if y > 14, GOLD if y > 8, else COPPER.
4. Single roll r = hash(x, y, salt 4), cumulative bands:
   - LAVA: y >= 12, band 0.025 + 0.0005 * y
   - ROCK: y >= 2, band 0.07 + 0.001 * y (only if still DIRT)
   - BASALT layer: y >= 60, band min(0.10 + 0.0006 * y, 0.45)
   - else DIRT
5. Veins overwrite host tiles only (DIRT, ROCK, BASALT). Hosts in gen.json.
6. Sand that generated over an air pocket is settled (falls) at generation time.

**Veins** (anchor per coarse cell, `vein_tiles` is a pure function of (seed, vein index, cell)):

| tile | min_row | max_row | cell (w x h) | chance | ramp |
|---|---|---|---|---|---|
| COPPER | 2 | none | 6 x 6 | 0.55 | common x2.5 |
| IRON | 12 | 110 | 8 x 8 | 0.50 | common x2.5 |
| SILVER | 30 | 220 | 10 x 10 | 0.40 | valuable x3.0 |
| GOLD | 25 | none | 12 x 12 | 0.35 | valuable x3.0 |
| GEM | 50 | none | 14 x 14 | 0.25 | valuable x3.0 |
| SULPHUR | 15 | none | 9 x 9 | 0.40 | none |

- Vein size 2..6 tiles (defaults). Walk: 70% step down (x shifts by -1/0/+1), 30% sideways.
- Depth ramp (metres = row * 5): multiplier 1 until 200 m; steep to 1 + (mult-1)*0.1 at 300 m; linear to full mult at 800 m. Applies to chance per vein kind.
- VEIN_REACH 5 tiles; SALT_VEIN_BASE 1000, stride 32.

**Sand-ore depth gates**: GEM below row 14, GOLD rows 9-14, COPPER rows 3-8 (inside sand pockets only).

## 4. Drilling behaviour (pod.gd)

- Start: on ground, not moving up, falling slower than 9. The held direction must point at a diggable tile within h + 0.1 tiles. Checks centre, then top/bottom (or left/right) face tile.
- Commit: the pod snaps flush to the face and holds still. Direction change before finish cancels the drill and keeps the damage (`damaged` map keyed by tile, resumed on next start).
- Vertical drills ease x to column centre. Horizontal drills keep gravity and floor contact.
- Finish: tile removed, fuel charged, ore to cargo (via signal), then a glide into the hole at 20 tiles/s. If the thumb is still held that way, chain straight into the next tile.
- Twin-Bore upgrade also removes one perpendicular side tile (most valuable qualifying side wins).
- Diagonal and upward drilling are not allowed. Sand falling away mid-drill just ends the drill.

## 5. Sand sim (sand_sim.gd)

- Dirty-queue driven: `World.set_tile` pushes the cell above any tile that stopped being solid. No world scan.
- Unsupported sand column above the hole wobbles: delay = 0.4 s + n * 0.1 s (higher blocks later). Wobble amplitude grows 1.5 to 4.5 px with sin shake. Dust emitted.
- Support returning cancels a wobble. Digging out from under cancels it too.
- Falling: one cell per 0.09 s. Lands by writing the tile back (keeps aux ore) and emits `landed`.
- Touching the pod: `hit_pod(18)` and the block is removed.
- Pooled Block objects; `blocks` is a flat array with swap-remove.

## 6. Art

**None.** No png/svg/jpg/webp assets exist outside build/ and .godot/. Glob over the prototype found only build/web/index.png, index.icon.png and index.apple-touch-icon.png (web export icons, not game art). Tiles and atlas are generated in code (tile_atlas.gd). Everything else is code-drawn (Fx particles, pod polygon, HUD bars).

## 7. What to reuse

- data/tiles.json and data/gen.json as the source of truth. Port the schema as-is.
- grid_hash.gd: exact hash, so generation can be reproduced.
- world_gen.gd: the order of tile rules and vein walk, including the ramp curve.
- Tuning as one place for numbers, with the debug TUNABLES list.
- pod.gd movement and drill state machine (commit, cancel with damage memory, glide chain). These are the feel-critical parts.
- sand_sim.gd dirty-queue approach and its wobble/fall timing.
- camera_rig.gd static helpers (look_y, dead_zone_x, clamp_x, exit_arrow). They are pure and easy to port.
- tile_atlas.gd procedural painting, as a placeholder until art exists.
- Fx pool (fixed arrays, no per-frame alloc).
