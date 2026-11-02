import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// In dev, /api is proxied to a local server (npm run dev:server).
const apiTarget = process.env.OVERTONE_DEV_API ?? 'http://127.0.0.1:4800';

export default defineConfig({
  resolve: {
    alias: {
      '@overtone/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@overtone/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false, // registered from src/pwa.ts
      manifest: {
        name: 'Overtone',
        short_name: 'Overtone',
        description: 'Your music, from all your sources.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#111214',
        theme_color: '#111214',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
