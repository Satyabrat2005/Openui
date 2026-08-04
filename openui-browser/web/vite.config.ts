import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The frontend dev server proxies /api to the Express backend on :8787 so the
// browser talks to one origin. Production build lands in ../public-web, which
// the Express server serves statically.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787'
    }
  },
  build: {
    outDir: '../public-web',
    emptyOutDir: true
  }
})
