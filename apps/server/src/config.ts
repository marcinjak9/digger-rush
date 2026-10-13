import { T } from '@digger/shared';

// Runtime knobs. Defaults come from the shared tuning; tests override them.
export interface ServerConfig {
  reconnectWindowMs: number;
  roomIdleMs: number;
  maxClients: number;
  serverHz: number;
}

export function defaultConfig(): ServerConfig {
  return {
    reconnectWindowMs: T.net.reconnectWindowMs,
    roomIdleMs: T.net.roomIdleMs,
    maxClients: T.net.maxClients,
    serverHz: T.net.serverHz,
  };
}

// Process wide (one game server per process); set by createGameServer before rooms are created.
export const serverConfig: ServerConfig = defaultConfig();

export function setServerConfig(c: Partial<ServerConfig>): void {
  Object.assign(serverConfig, defaultConfig(), c);
}
