import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // VITE_API_URL is just '/api' in both dev and prod now (see .env) - in prod nginx's own
    // /api/ location strips the prefix and forwards to the CRM server; this proxy does the same
    // thing for `vite dev`, so the same relative URL works unchanged in both places instead of
    // needing a separate .env.production override.
    proxy: {
      '/api': {
        target: 'http://localhost:5601',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Splits the big third-party libraries into their own chunks instead of one huge bundle -
        // these change far less often than app code, so browsers can cache them across deploys,
        // and it clears Vite's 500kB single-chunk warning. This project's Vite build runs on the
        // rolldown bundler (Vite 8), which only accepts the function form of manualChunks, not
        // the object-map form classic Rollup also supports.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|react-router-dom)[\\/]/.test(id)) return 'react';
          if (id.includes('@mantine')) return 'mantine';
          if (id.includes('@tanstack')) return 'tanstack';
          return 'vendor';
        },
      },
    },
  },
})
