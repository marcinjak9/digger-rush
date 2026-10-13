# Digger Rush

A browser multiplayer digging demo. Dig down through a shared, deterministic world with
up to 30 players per room. You pick a nickname and play; there are no accounts.

- Dig for ore, sell it by spending it on upgrades, and watch out for sand that collapses
  when you remove the tile beneath it.
- Death resets your run (your high score is kept on the leaderboard), then you respawn.
- Offline single player is available with `?local=1`.

## Controls

| Key | Action |
| --- | --- |
| A / D | Move sideways; while touching ground, also drill to the side |
| S | Drill down (on the ground) |
| W | Thrust up |
| Space | Radar (scans nearby ore for a few seconds) |
| B | Shop |
| F3 | Debug tuning panel (live tuning only in `?local=1` mode; read-only online) |

## Run it

Requires Node 22.

```
npm install
npm run build     # typecheck, then build the client into apps/client/dist
npm start         # serves the game and websocket on http://localhost:2567
```

Open `http://localhost:2567` (the start message also prints your LAN addresses).
Offline single player: `http://localhost:2567/?local=1`.

Development with hot reload:

```
npm run dev       # client on :5173, game server on :2567
```

## Tests and load test

```
npm test                                          # vitest
npm run typecheck
npm run loadtest -- --bots 30 --seconds 30        # 30 bots, 30 s, in-process server
```

The load test exits with code 1 if the p95 server tick exceeds 20 ms or a bot fails.
Against an external server, add `--url ws://host:port` and raise `JOIN_LIMIT`.

## Docker

The Dockerfile is in the repo root (Node 22 slim, two stages, healthcheck on `/health`).

```
docker build -t digger-rush .
docker run -p 2567:2567 digger-rush
# behind a proxy or tunnel:
docker run -p 2567:2567 -e TRUST_PROXY=1 digger-rush
```

The project docs do not confirm that the image was built or run. Verify with the commands
above before relying on it.

## Deploying with a public URL

One process serves both the page and the websocket on the same port, so the browser uses
`wss://` on the page's own origin (no extra configuration).

```
npm run build
TRUST_PROXY=1 npm start           # PowerShell: $env:TRUST_PROXY=1; npm start
cloudflared tunnel --url http://localhost:2567     # or: ngrok http 2567
```

Share the `https://` URL. Set `TRUST_PROXY=1` behind any proxy or tunnel; without it every
player appears as 127.0.0.1 and shares one join limit. Only set it when the server is
reachable through a proxy you control, because on a directly exposed port it lets anyone
spoof their address. `VITE_SERVER_URL=wss://...` at build time overrides the server URL.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 2567 | HTTP and websocket port (listens on 0.0.0.0) |
| `TRUST_PROXY` | off | `1` reads the client address from `CF-Connecting-IP` or the first `X-Forwarded-For` hop |
| `JOIN_LIMIT` | 30 | joins per minute per address |
| `MAX_ROOMS` | 20 | global room cap (30 players per room) |
| `ADMIN_TOKEN` | unset | needed for `GET /stats?reset=1` (header `x-admin-token` or `?token=`) |
| `STATIC_DIR` | `apps/client/dist` | directory of the built client |

`GET /health` and `GET /stats` (tick timing and counts only, no player data) are always
available.

## Architecture

- `packages/shared`: deterministic simulation at a fixed 60 Hz, used by both sides.
- `apps/server`: authoritative room on Colyseus 0.16, ticks at 30 Hz (two sim ticks each).
- Server sends custom messages at 30 Hz or less: tiles, sand events, pods, and own stats.
- Client predicts its own pod, replays unacknowledged inputs on each correction, and
  interpolates other pods.
- Wallet, score, dig rate, speed and buys are decided on the server only.
- Interest management: each player gets the 5x5 chunks (16x16 tiles each) around its pod.
- Other pods are sent within 30 tiles on each axis; deltas and sand events route by chunk.
- Terrain is generated from a seed on each side; only modified chunks are sent as diffs.

## Known issues

- Ore and darkness are cosmetic: the seed is public, so a modified client can compute
  every tile (REVIEW #8). Post-demo fix: stream ore only within light or radar range.
- Per-tick allocations in the hot loop (REVIEW #9). p95 is about 3 ms at 30 bots.
- No art assets: flat colors with deterministic speckles.
- A server restart empties all rooms; state is in memory only.
- Modified-chunk diffs and heal-spawner bookkeeping are never evicted on the server, so
  memory grows with digging. Fine for short demo rooms.
- No idle-player kick: a hidden tab keeps its seat.
- Loopback addresses are not exempt from the join limiter.
- F3 live tuning works only in `?local=1`; online it is read-only.
- One test occasionally flakes under heavy machine load.
