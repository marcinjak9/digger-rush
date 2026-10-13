import { createGameServer } from './gameServer.js';

const port = Number(process.env.PORT ?? 2567);
const gs = createGameServer();
await gs.listen(port);
console.log(`[digger] server listening on :${port} (health: /health)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void gs.stop().then(() => process.exit(0));
  });
}
