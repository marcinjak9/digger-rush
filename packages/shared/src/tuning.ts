// Single home for every number used by the simulation.
// Time is in integer 60 Hz ticks, space in tiles.

export const T = {
  SIM_VERSION: 1,
  TICK_HZ: 60,
  DT: 1 / 60,
  TILE_PX: 48,
  WORLD_W: 96,
  CHUNK: 16,
  CHUNKS_X: 6,
  SEED: 1337,
  QUANT: 1024, // positions and velocities are rounded to 1/1024 every tick

  // Movement (tiles, seconds)
  moveSpeed: 4,
  moveAccel: 28,
  moveDecel: 70,
  airAccelMult: 0.75,
  gridSeekMin: 1.2,
  gravity: 16,
  thrust: 22, // net acceleration while W held: 16 - 22 = -6 (up), free, no fuel
  vyMin: -6,
  vyMax: 11,
  podHalf: 0.359375, // 23/64: exactly representable on the 1/1024 grid
  collideEps: 0.001,
  yMin: -30, // pod can not climb above this row

  // Drilling
  drillProbe: 0.1,
  glideSpeed: 20,
  glideQuanta: 342, // ceil(20 * 1024 / 60): glide distance per tick in 1/1024 tile
  alignFactor: 0.34075936979955623, // per-tick easing of x to the column centre (25/s at 60 Hz)
  minDigTicks: 12,
  digRowPct: 2, // +2% dig time per row of depth

  // Damage
  hullBase: 100,
  hardLandSpeed: 9,
  hardLandMult: 6,
  lavaDps: 25,
  sandHitDamage: 18,

  // Sand (ticks)
  wobbleTicks: 24,
  cascadeTicks: 6,
  fallStepDeci: 54, // one cell per 5.4 ticks, accumulated in tenths of a tick
  fallTickDeci: 10,
  sandBoxInset: 0.04,

  // Heal
  healFrac: 0.5, // of max hp
  healMinRow: 6,
  healP: 1 / 245, // per eligible (dirt/rock) tile, tuned so that about 1 in 400 tiles is heal
  healTargetDen: 400,

  // Per-tile tables, indexed by Tile id (EMPTY, DIRT, ROCK, SAND, COPPER, GOLD, GEM, LAVA, BEDROCK, HEAL)
  digMs: [0, 280, 1100, 200, 350, 500, 800, 0, 0, 400],
  value: [0, 0, 0, 0, 8, 120, 400, 0, 0, 0],

  // Upgrades: endless. Level L (0-based = current level) costs floor(costBase * costMult^L),
  // computed iteratively (no pow). Levels are clamped to levelCap (200) for table lookups and
  // purchases: 50 * 1.6^200 is about 5e41, still a finite double, and no one gets near it.
  upgrade: {
    levelCap: 200,
    costBase: 50,
    costMult: 1.6,
    drillMult: 0.9, // dig time multiplier per level (0.9^level), still floored by minDigTicks
    hpPerLevel: 20,
    movePct: 8, // +8% of base speed per level
    maxMoveMult: 2.5, // hard cap on the move speed multiplier so physics stays safe
    armorMult: 0.9, // damage multiplier per level (0.9^level, never reaches 0)
    radarCdMult: 0.9, // radar cooldown multiplier per level
  },

  // Ore value scales with depth: floor(base * (1 + oreDepthBonus * row)). 1% per tile.
  oreDepthBonus: 0.01,

  // Radar (Space)
  radarRadius: 12, // tiles
  radarShowSeconds: 4,
  radarRingSeconds: 0.6, // expanding ring animation (client only)
  radarCooldownSeconds: 10, // base, times upgrade.radarCdMult^level
  radarMinCooldownSeconds: 1,

  // Light (client rendering only). Radius in tiles around the pod, by depth row.
  light: {
    nearRow: 8, // radius is nearRadius at or above this row
    nearRadius: 14,
    farRow: 200, // and farRadius at or below this row, linear in between
    farRadius: 3,
    darkAlpha: 0.96,
    edge: 1.5, // soft edge width in tiles
  },

  // Generation (from the prototype)
  gen: {
    airMinRow: 4,
    airChance: 0.05,
    sandMinRow: 3,
    sandCellW: 3,
    sandCellH: 4,
    sandCellChance: 0.2,
    sandFill: 0.85,
    sandOre: 0.16,
    sandOreGoldRow: 8, // aux ore: GOLD below this row, COPPER above
    sandOreGemRow: 14, // GEM below this row
    lavaMinRow: 12,
    lavaBase: 0.025,
    lavaSlope: 0.0005,
    lavaMax: 0.2, // cap added so deep rows stay playable
    rockMinRow: 2,
    rockBase: 0.07,
    rockSlope: 0.001,
    rockMax: 0.3,
    veinReach: 5,
    saltVeinBase: 1000,
    saltVeinStride: 32,
    veinSizeMin: 2,
    veinSizeMax: 6,
    metersPerTile: 5,
    ramp: { startM: 200, steepM: 300, fullM: 800, steepFrac: 0.1 },
    // idx is the prototype vein index (kept so salts match); mult is the depth-ramp full multiplier
    veins: [
      { tile: 4, idx: 0, minRow: 2, maxRow: -1, cellW: 6, cellH: 6, chance: 0.55, mult: 2.5 }, // COPPER
      { tile: 5, idx: 3, minRow: 25, maxRow: -1, cellW: 12, cellH: 12, chance: 0.35, mult: 3.0 }, // GOLD
      { tile: 6, idx: 4, minRow: 50, maxRow: -1, cellW: 14, cellH: 14, chance: 0.25, mult: 3.0 }, // GEM
    ],
    salt: { sandCell: 1, sandFill: 2, sandOre: 3, roll: 4, air: 5, heal: 7 },
  },

  spawnXMin: 1, // random respawn column range (inclusive tile columns)
  spawnXMax: 94,
  spawnScanRows: 40, // rows scanned from the top for the first solid tile
  spawnSalt: 90,

  // Heal ore respawn (server only): a few heal tiles come back over time inside loaded chunks near players.
  healRespawn: {
    capPerChunk: 3, // respawned heal tiles alive in one chunk at once
    attemptEveryTicks: 15, // server ticks between two attempts (one chunk per attempt, round robin)
    ringRebuildTicks: 150, // server ticks between rebuilds of the active chunk ring
    safeRadius: 28, // never within this many tiles (each axis) of any pod: outside light and viewport
    salt: 8,
  },

  respawnTicks: 180, // 3 s dead before the pod comes back
  invulnTicks: 180, // 3 s without damage after respawning

  // Networking (server authoritative, shared by server, client and bots)
  net: {
    serverHz: 30, // server loop rate
    simTicksPerServerTick: 2, // 60 Hz sim ticks each server tick grants per player
    snapEveryTicks: 1, // a snapshot every N server ticks
    burstTicks: 15, // steady-state burst of a player's tick allowance (allowance accrues from wall-clock time)
    catchupBankTicks: 45, // extra banked allowance so a stall of up to ~1 s is made up instead of lost
    maxBacklogTicks: 36, // queued ticks above this (an honest client never has more than clientMaxPendingTicks=30) are skipped...
    keepBacklogTicks: 8, // ...down to this many, so latency recovers
    readyTimeoutMs: 5000, // a connection that never sends ready is dropped
    inputQueueMax: 40, // queued commands per player; overflow is dropped
    maxCmdTicks: 4, // ticks a single command may cover
    clientSendEveryTicks: 2, // client flushes input about every N local ticks
    clientMaxPendingTicks: 30, // client stops predicting when this many ticks are unacked
    maxClients: 30, // per room
    interestChunkRadius: 2, // chunks around the pod's chunk that a player is subscribed to
    podInterestTiles: 30, // other pods within this many tiles (each axis) are sent
    interpDelayMs: 100, // remote pods are drawn this far in the past
    snapBufferLen: 8,
    reconnectWindowMs: 60000,
    reconnectRetryMs: 1500,
    roomIdleMs: 600000, // an empty room is disposed after this long
    evictEveryTicks: 300, // far unmodified chunk eviction cadence (server ticks)
    leaderboardEveryTicks: 30,
    pingEveryMs: 2000,
    buyCooldownTicks: 3, // server ticks between two purchases of one player (~100 ms)
    maxViolations: 200, // invalid or rate limited messages before a client is dropped
    // Token buckets per connection and message type: sustained msgs/s and burst size.
    inRate: 40,
    inBurst: 60,
    buyRate: 5,
    buyBurst: 10,
    radarRate: 2,
    radarBurst: 4,
    pingRate: 2,
    pingBurst: 6,
    readyBurst: 2,
    maxPayloadBytes: 1024, // websocket frames above this close the connection
    joinsPerWindow: 30, // per address
    joinWindowMs: 60000,
    maxRooms: 20, // global safeguard
  },
} as const;
