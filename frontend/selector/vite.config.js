import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import svgrPlugin from 'vite-plugin-svgr';

// In dev (`vite serve`) we serve from `/` so the selector opens at
// http://localhost:5173/. In build we keep `/assets/selector/` because
// that's where the backend's static middleware serves the files from.
export default defineConfig(({ command }) => ({
  plugins: [
    react({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
    svgrPlugin(),
  ],

  build: {
    outDir: '../../www_static/assets/selector',
    emptyOutDir: true,
    assetsDir: '',
  },

  base: command === 'serve' ? '/' : '/assets/selector/',

  server: {
    host: 'localhost',
    port: 5173,
    open: true,
    proxy: {
      // Static asset bundles served by the backend (admin, oldplunger, fonts,
      // logos, emails). The negative lookahead skips `/assets/selector/*` so
      // Vite serves the live React bundle.
      '^/assets/(?!selector(/|$)).*': {
        target: 'http://localhost:1337',
        changeOrigin: true,
      },
      '/api': { target: 'http://localhost:1337', changeOrigin: true },
      '/instance': { target: 'http://localhost:1337', changeOrigin: true },
      '/gateway': { target: 'http://localhost:1337', changeOrigin: true },
      '/voice': { target: 'http://localhost:1337', changeOrigin: true },
      '/oauth2': { target: 'http://localhost:1337', changeOrigin: true },
      '/integrations': { target: 'http://localhost:1337', changeOrigin: true },
    },
  },
}));
