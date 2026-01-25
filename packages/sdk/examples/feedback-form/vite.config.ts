import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import react from '@vitejs/plugin-react'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'

export default defineConfig({
  server: {
    port: 3000,
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
    // Optimizations for faster builds
    target: 'esnext',    // Skip transpilation (modern browsers only)
    minify: false,       // Skip minification for preview builds
  },
})
