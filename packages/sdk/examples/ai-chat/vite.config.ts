// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'

const apiServerPort = process.env.VITE_API_SERVER_PORT || process.env.VITE_SKILL_SERVER_PORT || '3001'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: `http://localhost:${apiServerPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
