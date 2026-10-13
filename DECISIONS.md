# DECISIONS
Ambiguities resolved without asking (simplest option).

1. Subagents: agent files copied from the prototype and adapted to TypeScript into .claude/agents. Spawned through the generic agent tool with the model set per policy (haiku/sonnet/opus).
2. No art assets exist in the prototype (data/ has only JSON; build/web has the Godot export). Tiles are flat colors from prototype tiles.json, with a few deterministic speckles ("flecks") like the prototype.
3. Sim runs at a fixed 60 Hz in shared; the server loop is 30 Hz and runs 2 sim ticks per server tick (keeps the 30 Hz requirement, avoids tunnelling at 20 t/s glide). Snapshots go out at 30 Hz or less.
4. Architect's plan picks overridden by the prompt: heal = 50% max HP; five upgrades as specified (not drill/armor/engine); tile set limited to the nine listed (no basalt/iron/silver/sulphur).
5. Fuel/cargo removed. Pod half-size 23/64 so flush positions sit on the 1/1024 quantisation grid. Lava and rock probability capped (0.2/0.3) so deep terrain stays diggable. Heal probability tuned empirically to ~1 per 400 tiles.
6. Buying max HP also raises current HP by 20.
7. Client (WP2, apps/client): local mode behind a `GameSession` interface (`LocalSession`); WP3 swaps in a networked one. Respawn (3 s dead) and invulnerability (3 s) live in the client session, not shared: while dead the pod is not stepped (world/sand keep running); invulnerability sets hull to a huge value for the tick so shared damage/death logic cannot kill, then restores it (heal pickups kept). A server-authoritative version will need these timers moved into shared.
8. F3 live tuning mutates the `T` object at runtime (cast away `as const`) for a dev-only list of constants the shared code reads live (gravity, thrust, moveSpeed, ...). Module-cached constants (podHalf, DT, QUANT) are not tunable. Affects local mode only.
