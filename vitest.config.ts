import { defineConfig } from 'vitest/config';

// threads: the forks pool chokes on the websocket traffic of the in-process server tests (IPC serialisation).
export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'], pool: 'threads', testTimeout: 15000 },
});
