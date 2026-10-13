import { defineConfig } from 'vite';

export default defineConfig({
  // host: true listens on all interfaces so friends on the LAN can open the dev server
  server: { host: true, fs: { allow: ['../..'] } },
  preview: { host: true },
  build: { target: 'es2022', outDir: 'dist' },
});
