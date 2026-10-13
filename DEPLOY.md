# Running Digger Rush

One Node process serves the game page and the websocket on the same port (default 2567).

## Local
```
npm install
npm run build     # typechecks, then builds apps/client/dist
npm start         # prints http://localhost:2567 and your LAN addresses
```
Development with hot reload: `npm run dev` (page on :5173, game server on :2567). Offline single player: add `?local=1`.
Production builds connect to the page's own origin; the dev server connects to `ws://<host>:2567`. `VITE_SERVER_URL=wss://...` (set at build time) overrides both.

## LAN
Friends on the same Wi-Fi open one of the `http://192.168.x.x:2567` addresses printed by `npm start`. Allow Node through the Windows firewall if asked.

## Public tunnel (cloudflared / ngrok)
```
npm run build
TRUST_PROXY=1 npm start        # PowerShell: $env:TRUST_PROXY=1; npm start
cloudflared tunnel --url http://localhost:2567     # or: ngrok http 2567
```
Share the https URL. Websockets work through both tunnels (same origin, `wss://`).
`TRUST_PROXY=1` is required: otherwise every friend appears as 127.0.0.1 and the join limit applies to all of them together. With it, the client address is taken from `CF-Connecting-IP`, else the first hop of `X-Forwarded-For`. Only set it when the server is reachable through a proxy you control; on a directly exposed port it lets anyone spoof their address.

## Docker
```
docker build -t digger-rush .
docker run -p 2567:2567 digger-rush
# behind a proxy: docker run -p 2567:2567 -e TRUST_PROXY=1 digger-rush
```
The image has a healthcheck on `/health`. Any host that runs a container or Node 22 works; nothing is provider specific. State is in memory only: a restart empties all rooms.

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 2567 | HTTP + websocket port (listens on 0.0.0.0) |
| `TRUST_PROXY` | off | `1` reads the client address from `CF-Connecting-IP` / `X-Forwarded-For` (first hop) |
| `JOIN_LIMIT` | 30 | joins per minute per address |
| `MAX_ROOMS` | 20 | global room cap (30 players per room) |
| `ADMIN_TOKEN` | unset | needed for `GET /stats?reset=1` (header `x-admin-token` or `?token=`); without it the reset is refused |
| `STATIC_DIR` | `apps/client/dist` | directory of the built client |

`GET /health` and `GET /stats` (tick timing and counts only, no player data) are always available.

## Tests
`npm test` (vitest), `npm run typecheck`, `npm run loadtest -- --bots 30 --seconds 30`.
