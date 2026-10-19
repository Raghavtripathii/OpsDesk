import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Forward /api to the Express server so the browser sees one origin (no CORS setup needed)
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});