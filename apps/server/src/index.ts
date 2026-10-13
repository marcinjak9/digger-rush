import { networkInterfaces } from 'node:os';
import { createGameServer } from './gameServer.js';
import { serverConfig } from './config.js';
import { tickStats } from './limits.js';

const port = Number(process.env.PORT ?? 2567);
const gs = createGameServer();
await gs.listen(port);
console.log(`[digger] listening on 0.0.0.0:${port} (health: /health, stats: /stats)`);
if (serverConfig.staticDir !== null) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${port}`);
  }
  console.log(`[digger] game client served from ${serverConfig.staticDir}`);
  console.log('[digger] open one of:');
  for (const u of urls) console.log(`  ${u}`);
  console.log(`[digger] join limit ${serverConfig.joinsPerWindow}/min per address, trust proxy: ${serverConfig.trustProxy ? 'yes' : 'no'}`);
} else {
  console.log('[digger] no built client found (apps/client/dist). Run "npm run build" first, or use "npm run dev" for development.');
}

// Operational log: room ids, counts and tick stats only. Never nicknames, tokens or addresses.
setInterval(() => {
  void gs.rooms().then((rooms) => {
    const t = tickStats.summary();
    const list = rooms.map((r) => `${r.roomId}:${r.players.size}`).join(',');
    console.log(`[digger] rooms=${rooms.length} [${list}] tick avg=${t.avgMs}ms p95=${t.p95Ms}ms max=${t.maxMs}ms`);
    tickStats.reset();
  });
}, 60000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void gs.stop().then(() => process.exit(0));
  });
}
