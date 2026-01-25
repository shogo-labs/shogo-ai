import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// HMR configuration for iframe embedding:
// - In production (HTTPS): use wss:// on port 443 via proxy
// - Locally: let Vite auto-detect (ws:// on dev server port)
const isProduction = process.env.NODE_ENV === 'production' || process.env.SHOGO_RUNTIME === 'true'
const hmrConfig = isProduction ? { clientPort: 443, protocol: 'wss' as const, path: '/' } : undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    cors: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
    hmr: hmrConfig,
  },
  build: {
    target: 'esnext',
    minify: false,
  },
})
