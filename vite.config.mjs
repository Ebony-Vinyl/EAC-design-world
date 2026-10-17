import { defineConfig } from 'vite';

const apiTarget = process.env.EAC_API_URL || 'http://127.0.0.1:4173';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        headers: { origin: new URL(apiTarget).origin },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
