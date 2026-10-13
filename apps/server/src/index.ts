import { createGameServer } from './gameServer.js';
import { tickStats } from './limits.js';

const port = Number(process.env.PORT ?? 2567);
const gs = createGameServer();
await gs.listen(port);
console.log(`[digger] server listening on :${port} (health: /health, stats: /stats)`);

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
