# Architecture review (after WP5)

Scope: packages/shared, apps/server, apps/client at commit 32d72e4, read against DECISIONS.md.
These are the top 10 findings, most severe first. Nothing was changed in the source.
Tags: **[blocker for friends demo]** means fix before inviting people. **[later]** means it can wait.

Overall: the authority model is sound. Buys, wallet, score, dig rate and speed are decided on the server only. Handlers are hardened, and stale seqs and queue overflow are handled. The weak spots are the connection lifecycle, timing under real-world jitter, and bookkeeping for predicted digs.

---

## 1. Friends cannot reach the game, or get rate limited as a group. [blocker for friends demo]
- `apps/client/vite.config.ts:4`: the dev server has no `host`, so Vite binds to localhost only. Other machines on the LAN cannot load the page.
- `apps/client/src/net/NetSession.ts:31-37`: the server URL is always `ws(s)://<page host>:2567`. A page served over HTTPS through a tunnel (ngrok, cloudflared) or a reverse proxy tries `wss://host:2567`, which does not exist. The tester only sees "Could not reach the server".
- `apps/server/src/limits.ts:309`, `config.ts:330-333`, `gameServer.ts:48-53`, `DigRoom.ts:138`: the join limit is 10 joins per 60 s per address. Behind a tunnel or proxy without `TRUST_PROXY=1`, every friend has the same socket address (127.0.0.1). Five people reloading a couple of times then get "Too many joins from your address".
- Fix: add `server: { host: true }` (and the same for `preview`). Either proxy `/matchmake` and the websocket through Vite or the tunnel on the page origin, or document `VITE_SERVER_URL`. Document `TRUST_PROXY=1` / `JOIN_LIMIT` for tunnels, and exempt loopback from the limiter unless `TRUST_PROXY` is set.

## 2. A dead connection is never noticed, and an expired session is rejoined silently with nothing kept. [blocker for friends demo]
- `NetSession.ts:219` only uses the pong to show the ping, and nothing watches for missing snapshots. After a Wi-Fi switch or laptop sleep, the socket can be half open: the server's ws ping drops it after about 9 s (`ws-transport` defaults), and the browser may not fire `close` for minutes.
- Meanwhile the client keeps predicting until `clientMaxPendingTicks` (`NetSession.ts:594`). Then the pod freezes, no "Reconnecting..." banner appears, and the HUD keeps showing the old ping.
- When `close` finally fires after more than 60 s, the server has already removed the player (`DigRoom.ts:435-438`). `reconnect()` -> `join(false)` -> `joinById` then succeeds as a brand new player. `handleWelcome` (`NetSession.ts:285`) ignores `m.resumed`, so wallet, levels and score are reset with status `ok` and no message.
- The same misleading path happens when the room is full or locked during the 60 s window. `NetSession.ts:250-260` falls back to `joinOrCreate`, lands in another room and shows "The server restarted", while the real player record is left behind in the old room.
- Fix: add a watchdog in `advance()`. If there is no snapshot or pong for about 3 s, close the room connection and run `reconnect()`. If a reconnect returns `resumed === false`, tell the user "Your session expired, starting fresh" (or `fail()`). Treat "locked" as retryable until the window ends, not as "room gone".

## 3. Lost tick allowance becomes a permanent input backlog: latency creeps up and the game stutters. [blocker for friends demo]
- `DigRoom.ts:392-393`: allowance grows by 2 per server tick and is capped at `burstTicks` = 8 (`tuning.ts:154`, 133 ms). `consumeInputs` breaks when allowance < ticks (`DigRoom.ts:457`). Also, `poll()` throws away server time beyond 3 ticks (`DigRoom.ts:370`).
- The client produces exactly 60 ticks/s. Every input gap longer than 133 ms (Wi-Fi jitter, a GC pause, a server hitch) loses allowance for good, and the extra queued ticks never drain because the server consumes exactly what arrives.
- The backlog only grows. The server pod lags the predicted pod more and more, until `pendingTicks` reaches 30 (`NetSession.ts:594`). From then on the client keeps stalling ticks to drain it: micro-stutter, and about 500 ms of input-to-authority delay.
- Sand hits (`sand.ts:236-240`) and digs by other players are judged against that stale server pod. Players see sand hit them after they had moved away, and get more rubber-banding.
- Localhost load tests cannot show this.
- Fix: bound by wall clock instead of a leaky cap. Keep `consumedTicks <= (now - readyAt) * 60/1000 + burst` per player (reset on ready), and allow catch-up when the queue holds more than a few ticks. Speed stays bounded to real time and nothing is lost. Optionally the client can drop or merge pending ticks when acks show a server-side backlog.

## 4. Two tabs share one identity, so the second tab kicks the first. [blocker for friends demo]
- `apps/client/src/net/storage.ts:187-197` keeps the token in `localStorage`, which every tab of the browser shares. `DigRoom.ts:152-161` reattaches the second tab to the same player and kicks the first with 4403 ("Opened in another tab", `NetSession.ts:223`).
- A first-time tester who opens two tabs to "see multiplayer" gets one player and a dead tab. The nickname typed in the second tab is ignored (`PlayerRec.nick` is readonly, `DigRoom.ts:80`, and is never updated on reattach), so the leaderboard shows the old name.
- Related: when `connect()` fails on the welcome timeout (`NetSession.ts:198-204`), the joined room is never left. That orphan session reconnects later and can kick the live tab.
- Fix: keep the token in `sessionStorage`. It survives a reload but is separate per tab, with `localStorage` only as a fallback. On reattach, adopt the new nickname. Call `room.leave()` when `connect()` rejects after `attach`.

## 5. Bookkeeping for predicted digs can leave ghost holes or phantom tiles forever. [later]
- `packages/shared/src/predict.ts:121-125`: acked predicted digs are dropped on the assumption that "they are in the server world". If the server pod took a different path (another player dug below it, sand landed, a buy changed `moveSpeed`/`drill` mid-flight) and never dug that tile, the client keeps an EMPTY cell that the server has as solid. No delta ever corrects it, because the server tile never changes.
- `predict.ts:148-152`: `revertDigs` restores the old tile whenever the cell is EMPTY, even when a server delta (`NetSession.ts:371-374`) has just made it EMPTY for real (sand started falling, someone else dug it). If the replay does not dig it again, a phantom solid tile is left.
- In both cases the predicted pod collides differently from the server pod, so it rubber-bands at that spot until the chunk is resubscribed.
- Fix: the Predictor keeps the last server-known value for every cell it predicted. `onTiles`/`onChunks` update it. Revert restores that value. On ack, any dig not confirmed by an `EV_DIG` with the same x,y (already sent, `DigRoom.ts:478`) is set back to the server value.

## 6. Connections that never send `ready`, and idle players, hold slots forever. [later]
- `DigRoom.ts:151-176`: nothing times out a client that joins but never sends `ready`. `activePlayers()` (`DigRoom.ts:359`) counts it because `client !== null`, so its invisible pod takes part in the sand simulation. It is also listed on the leaderboard (`DigRoom.ts:585`).
- With 10 joins per minute per IP, 30 clients per room and `MAX_ROOMS` 20, a few addresses can fill every room in minutes. Real players then get "server full". A player whose tab stays hidden also keeps a seat indefinitely.
- `GET /stats?reset=1` (`gameServer.ts:35-38`) can be reset by anyone (CORS `*`). This is minor.
- Fix: kick clients that are not ready after 10 s. Use `rec.ready` (not `client !== null`) for the active list and the leaderboard. Optionally kick after N minutes with no input. Gate `reset` behind an env token.

## 7. Memory grows without bound: client buffers in hidden tabs, client chunks, server diffs. [later]
- Client: `requestAnimationFrame` stops in a background tab (`main.ts:90`), but the message handlers keep pushing into `pendChanges`/`pendSand`/`pendDug` (`NetSession.ts:368, 426-455, 473`). These are only drained in `advance()`, so they grow for as long as the tab is hidden, and the next visible frame retiles and bursts all of it at once.
- `onSand`'s `findVisual` is O(n) over `sandBlocks` (`NetSession.ts:393`). `sandBlocks` is only aged out in `advance()`, so the scan cost grows while hidden too.
- `world.get` from the renderer and radar regenerates chunks outside the subscription. Only `UNSUB` deletes chunks (`NetSession.ts:389`), so the client world map keeps growing as the player explores.
- Server: chunks with diffs are never evicted (`interest.ts:188`). The world has no depth limit, and every chunk modified by a dig or by sand keeps 512 B of tiles, a 256-entry Map and HealSpawner state (`healSpawner.ts:355`) for the life of the room. A long-running room with diggers grows by roughly MBs per player-hour.
- Fix: when `document.hidden`, drop the visual-only events (or cap the buffers to a few hundred). In `advance()` (client), evict world chunks that are outside the subscription and not visible. On the server, store diffs only for evicted modified chunks (regenerate and apply them on demand), and prune HealSpawner entries together with the chunks.

## 8. A client can compute every ore in the world, so radar and light are cosmetic. [later]
- `DigRoom.ts:230` sends `seed`, and worldgen is deterministic (`worldgen.ts:76-123`). A modified client can run `tileAt` over any area: full x-ray, no darkness.
- The radar cooldown is enforced on the server (`DigRoom.ts:342`), but the scan runs on the client against its own world (`renderer.ts:221`, `NetSession.ts:651-658`), so the cooldown is meaningless against a cheater.
- Speed, dig rate, buys and wallet are safe.
- Fix (post-demo): generate terrain on the client without ore and stream ore tiles from the server only within light or radar radius (the server answers `radar` with its own `scanOre` result). Until then, note it as a known limitation.

## 9. Avoidable allocations per tick in the hot loop. [later]
Measured p95 is 3 ms at 30 bots, so this is fine for now, but these allocate every tick:
- `sand.ts:168, 175`: a new `events` array and `[...world.dirty]` on every sand step.
- `sim.ts:404`: a `{id,x,y}` object per pod per world tick. `sim.ts:414`: a `players.find` closure for every hit.
- `pod.ts:349`: an `ev` object per player per tick. New `drill`/`mem`/`glide` objects (`pod.ts:268, 281, 308`). `decodePod` allocates them again on every reconcile on the client (`net.ts:370-372`).
- `world.ts:97`: a `TileChange` object per write.
- `DigRoom.ts:510-516`: two closures per player per tick in `syncInterest`, even when nothing changed.
- 4-5 separate msgpack `send`s per player per tick (`DigRoom.ts:550-576`).
- Fix: preallocate the sand event ring and pod scratch pool, reuse one `PodEvents` per caller, mutate the drill/glide objects in place, check the chunk before building closures, and merge TILES/SAND/EV into the SNAP payload.

## 10. The F3 tuning panel runs in network mode and desyncs prediction. [later]
- `main.ts:20` advertises F3 on the start screen. `ui.ts:104-107` mutates the shared `T` (gravity, thrust, moveSpeed...), which the client Predictor reads live, while the server keeps the defaults.
- A curious tester who clicks "+" gets constant rubber-banding and can conclude the netcode is broken. DECISIONS #8 says "local mode only", but nothing enforces it.
- Fix: in `Ui`, only build or enable `dbgtune` when the session is a `LocalSession` (pass a flag from `startGame`). Show "read-only (online)" otherwise.

---

### Checked and fine (no action)
- Buy is decided by the server only. Unknown kinds count as violations. `highScore` is monotonic.
- Seq replay: `isNewerSeq` drops stale seqs. Seqs reset on `ready`, and the client's continuing `nextSeq` is still accepted.
- Reconnect reattach: the 60 s expiry is checked every tick. A pod buried by sand is respawned. Dead timers freeze while disconnected.
- Nicknames: validated on the server and rendered via `textContent` or canvas `fillText` (no XSS). Prototype-less handler table. 1 KB frames.
- Window resize (DPR aware) and keys stuck on blur (`input.ts:136`) are handled. `dt` is clamped to 0.25 s, at most 6 steps per frame.
- Order of UNSUB vs. buffered tiles/sand: a stale delta can regenerate an unsubscribed chunk on the client. This is harmless, because the full diff is resent on resubscribe.
