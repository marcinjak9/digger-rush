import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME, T } from '@digger/shared';
import { DigRoom } from './DigRoom.js';
import { joinLimiter, tickStats } from './limits.js';
import { serverConfig, setServerConfig, type ServerConfig } from './config.js';

export interface GameServer {
  readonly server: Server;
  readonly http: HttpServer;
  /** Starts listening; resolves with the actual port (0 picks an ephemeral one). */
  listen(port: number): Promise<number>;
  stop(): Promise<void>;
  rooms(): Promise<DigRoom[]>;
}

export function createGameServer(config: Partial<ServerConfig> = {}): GameServer {
  setServerConfig(config);
  joinLimiter.configure(serverConfig.joinsPerWindow, serverConfig.joinWindowMs);
  const http = createServer((req, res) => {
    // CORS for the plain HTTP routes (matchmaking adds its own headers).
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/health' || req.url?.startsWith('/health?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: matchMaker.stats.local.roomCount, players: matchMaker.stats.local.ccu }));
      return;
    }
    if (req.url === '/stats' || req.url?.startsWith('/stats?')) {
      // Aggregate counters only: no nicknames, tokens or addresses.
      const body = { ...tickStats.summary(), rooms: matchMaker.stats.local.roomCount, players: matchMaker.stats.local.ccu, joinTable: joinLimiter.size };
      if (req.url.includes('reset=1')) tickStats.reset();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });
  const transport = new WebSocketTransport({ server: http, maxPayload: T.net.maxPayloadBytes });
  // Forwarded-for headers are client controlled: unless TRUST_PROXY=1, replace them with the socket address
  // before Colyseus reads them into the auth context.
  (transport as unknown as { wss: WebSocketServer }).wss.prependListener('connection', (_raw: unknown, req: IncomingMessage) => {
    if (!serverConfig.trustProxy) {
      delete req.headers['x-forwarded-for'];
      req.headers['x-real-ip'] = req.socket.remoteAddress ?? 'unknown';
    }
  });
  const server = new Server({ transport, greet: false });
  server.define(ROOM_NAME, DigRoom);
  return {
    server,
    http,
    async listen(port: number): Promise<number> {
      await server.listen(port, '0.0.0.0');
      const addr = http.address();
      return typeof addr === 'object' && addr !== null ? addr.port : port;
    },
    async stop(): Promise<void> {
      await server.gracefullyShutdown(false).catch(() => undefined);
    },
    async rooms(): Promise<DigRoom[]> {
      const list = await matchMaker.query({ name: ROOM_NAME });
      const out: DigRoom[] = [];
      for (const l of list) {
        const r = matchMaker.getLocalRoomById(l.roomId);
        if (r instanceof DigRoom) out.push(r);
      }
      return out;
    },
  };
}
