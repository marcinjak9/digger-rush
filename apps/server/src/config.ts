import { T } from '@digger/shared';

// Runtime knobs. Defaults come from the shared tuning; tests override them.
export interface ServerConfig {
  reconnectWindowMs: number;
  roomIdleMs: number;
  maxClients: number;
  serverHz: number;
  joinsPerWindow: number;
  joinWindowMs: number;
  maxRooms: number;
  trustProxy: boolean;
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
    trustProxy: process.env.TRUST_PROXY === '1',
  };
}

// Process wide (one game server per process); set by createGameServer before rooms are created.
export const serverConfig: ServerConfig = defaultConfig();

export function setServerConfig(c: Partial<ServerConfig>): void {
  Object.assign(serverConfig, defaultConfig(), c);
}
