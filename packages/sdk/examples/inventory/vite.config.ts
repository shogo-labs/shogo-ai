import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import react from '@vitejs/plugin-react'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'

export default defineConfig({
  server: {
    port: 3004,
    host: '0.0.0.0',
    cors: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
    hmr: {
      clientPort: 443,
      protocol: 'wss',
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
