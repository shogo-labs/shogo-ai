import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: __dirname, // Serve from the client directory
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8002',
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
