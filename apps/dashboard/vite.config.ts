import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const endpoint = `http://127.0.0.1:${process.env.BLACKBOX_PORT || 47821}`;
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@rippley/blackbox-protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BLACKBOX_DASHBOARD_PORT || 47822),
    strictPort: true,
    proxy: {
      '/api': {
        target: endpoint,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/stream': { target: endpoint.replace('http', 'ws'), changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
