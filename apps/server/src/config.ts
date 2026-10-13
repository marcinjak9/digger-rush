import { fileURLToPath } from 'node:url';
import { T } from '@digger/shared';
import { StaticSite } from './static.js';

// Runtime knobs. Defaults come from the shared tuning; tests override them.
export interface ServerConfig {
  reconnectWindowMs: number;
  roomIdleMs: number;
  maxClients: number;
  serverHz: number;
  joinsPerWindow: number;
  joinWindowMs: number;
  maxRooms: number;
  readyTimeoutMs: number;
  trustProxy: boolean;
  /** Directory with the built client (index.html), or null to serve no static files. */
  staticDir: string | null;
  /** Required for /stats?reset=1; empty disables the reset. */
  adminToken: string;
}

function defaultStaticDir(): string | null {
  const dir = process.env.STATIC_DIR ?? fileURLToPath(new URL('../../client/dist', import.meta.url));
  return StaticSite.available(dir) ? dir : null;
}

export function defaultConfig(): ServerConfig {
  return {
    reconnectWindowMs: T.net.reconnectWindowMs,
    roomIdleMs: T.net.roomIdleMs,
    maxClients: T.net.maxClients,
    serverHz: T.net.serverHz,
    joinsPerWindow: Number(process.env.JOIN_LIMIT ?? T.net.joinsPerWindow),
    joinWindowMs: T.net.joinWindowMs,
    maxRooms: Number(process.env.MAX_ROOMS ?? T.net.maxRooms),
    readyTimeoutMs: T.net.readyTimeoutMs,
    trustProxy: process.env.TRUST_PROXY === '1',
    staticDir: defaultStaticDir(),
    adminToken: process.env.ADMIN_TOKEN ?? '',
  };
}

// Process wide (one game server per process); set by createGameServer before rooms are created.
export const serverConfig: ServerConfig = defaultConfig();

export function setServerConfig(c: Partial<ServerConfig>): void {
  Object.assign(serverConfig, defaultConfig(), c);
}
