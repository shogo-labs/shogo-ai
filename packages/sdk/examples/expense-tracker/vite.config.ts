import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import react from '@vitejs/plugin-react'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'

// HMR configuration for iframe embedding:
// - In production (HTTPS): use wss:// on port 443 via proxy
// - Locally: let Vite auto-detect (ws:// on dev server port)
const isProduction = process.env.NODE_ENV === 'production' || process.env.SHOGO_RUNTIME === 'true'
const hmrConfig = isProduction ? { clientPort: 443, protocol: 'wss' as const } : undefined

export default defineConfig({
  server: {
    port: 3001,
    host: '0.0.0.0',
    cors: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
    hmr: hmrConfig,
  },
  plugins: [
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tanstackStart({
      tsr: {
        appDirectory: 'src',
      },
    }),
    nitroV2Plugin({ preset: 'bun' }),
    react(),
  ],
  build: {
    target: 'esnext',
    minify: false,
  },
})
