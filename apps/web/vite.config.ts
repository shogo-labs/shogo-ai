import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const monorepoRoot = path.resolve(__dirname, '../..')

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env files from monorepo root (supports multi-worktree isolation)
  // loadEnv reads .env, .env.local, .env.[mode], .env.[mode].local
  const env = loadEnv(mode, monorepoRoot, '')

  const VITE_PORT = parseInt(env.VITE_PORT || '3000', 10)
  const API_PORT = parseInt(env.API_PORT || '8002', 10)

  // HMR control: set VITE_HMR=false to disable hot module replacement
  // Useful when working with AI chat to prevent stream interruption on code changes
  const enableHMR = env.VITE_HMR !== 'false'

  return {
    plugins: [react(), tailwindcss()],
    root: __dirname, // Serve from the client directory
    envDir: monorepoRoot, // Also expose env vars to app code via import.meta.env
    server: {
      port: VITE_PORT,
      strictPort: true, // Fail if port is in use instead of auto-incrementing
      hmr: enableHMR, // Disable HMR when VITE_HMR=false
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
  }
})
