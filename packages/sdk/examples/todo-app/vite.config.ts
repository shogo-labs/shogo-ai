import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import react from '@vitejs/plugin-react'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    cors: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
    hmr: {
      // Let the client connect to the same host it loaded from (the proxy)
      // The proxy will forward WebSocket connections to the Vite dev server
      clientPort: 443,  // Use the HTTPS port since preview is served over HTTPS
      protocol: 'wss',  // Use secure WebSocket since we're on HTTPS
    },
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
