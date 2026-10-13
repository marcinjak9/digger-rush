import { afterEach, describe, expect, it } from 'vitest';
import { createGameServer } from '../src/gameServer.js';
import { TestClient, opened, sleep } from './helpers.js';

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});

// Separate file: stopping a game server shuts the process wide matchmaker down.
describe('join limits (own server)', () => {
  it('limits joins per address and recovers after the window', async () => {
    const g2 = createGameServer({ joinsPerWindow: 3, joinWindowMs: 800 });
    const port = await g2.listen(0);
    const u = `ws://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 3; i++) await TestClient.join(u, `Join${i}`);
      await expect(TestClient.join(u, 'JoinFour')).rejects.toBeTruthy();
      await sleep(900);
      const again = await TestClient.join(u, 'JoinFive');
      expect(again.welcome.id).toBeGreaterThan(0);
    } finally {
      await Promise.all(opened.splice(0).map((c) => c.close()));
      await g2.stop();
    }
  });

  it('refuses new rooms beyond the global cap', async () => {
    const g3 = createGameServer({ maxRooms: 1, maxClients: 1, joinsPerWindow: 100000 });
    const port = await g3.listen(0);
    const u = `ws://127.0.0.1:${port}`;
    try {
      await TestClient.join(u, 'RoomOne');
      await TestClient.join(u, 'RoomTwo'); // the cap trips when more than maxRooms rooms exist
      await expect(TestClient.join(u, 'RoomThree')).rejects.toBeTruthy();
    } finally {
      await Promise.all(opened.splice(0).map((c) => c.close()));
      await g3.stop();
    }
  });
});
