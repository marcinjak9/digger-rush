import { createServer, type Server as HttpServer } from 'node:http';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@digger/shared';
import { DigRoom } from './DigRoom.js';
import { setServerConfig, type ServerConfig } from './config.js';

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
    res.writeHead(404).end();
  });
  const server = new Server({ transport: new WebSocketTransport({ server: http }), greet: false });
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
