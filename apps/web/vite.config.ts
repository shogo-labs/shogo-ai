import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Port configuration from environment (supports multi-worktree isolation)
const VITE_PORT = parseInt(process.env.VITE_PORT || '3000', 10)
const API_PORT = parseInt(process.env.API_PORT || '8002', 10)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: __dirname, // Serve from the client directory
  server: {
    port: VITE_PORT,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      // For runtime imports (transpiled code)
      '@shogo/state-api': path.resolve(__dirname, '../../packages/state-api/src'),
      // shadcn/ui path alias
      '@': path.resolve(__dirname, './src'),
      // For ?raw imports that reference ../../../../src/
      // The WavesmithMetaDemo expects src/ to be 4 levels up from apps/web/src/components/Unit2_*/
      // We remap so that ../../../../src resolves to packages/state-api/src
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
