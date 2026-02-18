import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import monacoEditorPluginModule from 'vite-plugin-monaco-editor'
import path from 'path'
import { fileURLToPath } from 'url'

// Handle both ESM and CJS exports
const monacoEditorPlugin = (monacoEditorPluginModule as any).default || monacoEditorPluginModule

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

  // HMR configuration for Docker dev mode
  const hmrHost = env.VITE_HMR_HOST || undefined
  const hmrPort = env.VITE_HMR_PORT ? parseInt(env.VITE_HMR_PORT, 10) : undefined

  // Proxy targets: use Docker service names when running in Docker, localhost otherwise
  // VITE_API_PROXY_TARGET and VITE_MCP_PROXY_TARGET allow overriding for Docker networking
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || `http://localhost:${API_PORT}`
  const mcpProxyTarget = env.VITE_MCP_PROXY_TARGET || `http://localhost:3100`

  return {
    plugins: [
      react(),
      tailwindcss(),
      // Monaco Editor plugin for proper worker loading and syntax highlighting
      monacoEditorPlugin({
        languageWorkers: ['editorWorkerService', 'typescript', 'json', 'css', 'html'],
      }),
    ],
    root: __dirname, // Serve from the client directory
    envDir: monorepoRoot, // Also expose env vars to app code via import.meta.env
    server: {
      port: VITE_PORT,
      strictPort: true, // Fail if port is in use instead of auto-incrementing
      host: true, // Listen on all addresses (needed for Docker)
      // HMR config for Docker - client connects to host machine
      // When VITE_HMR_HOST is set (Docker), configure HMR to use that host
      // Otherwise, use default (works for native dev)
      hmr: !enableHMR ? false : hmrHost ? {
        host: hmrHost,
        port: hmrPort || VITE_PORT,
        protocol: 'ws',
        clientPort: hmrPort || VITE_PORT,
      } : true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          // When proxying to staging, rewrite origin header to match staging domain
          // This allows auth to work when running frontend locally against staging API
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              // If targeting staging, set origin to staging domain
              if (apiProxyTarget.includes('staging.shogo.ai')) {
                proxyReq.setHeader('origin', 'https://studio-staging.shogo.ai')
                proxyReq.setHeader('referer', 'https://studio-staging.shogo.ai/')
              }
            })
          },
        },
        '/mcp': {
          target: mcpProxyTarget,
          changeOrigin: true,
        },
        '/thumbnails': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
      // Watch config for Docker volumes (polling needed on macOS)
      watch: {
        usePolling: env.VITE_USE_POLLING === 'true' || env.CHOKIDAR_USEPOLLING === 'true',
      },
    },
    resolve: {
      alias: {
        // For runtime imports (transpiled code)
        '@shogo/state-api': path.resolve(__dirname, '../../packages/state-api/src'),
        // shadcn/ui path alias
        '@': path.resolve(__dirname, './src'),
        // For ?raw imports that reference ../../../../src/
        // The ShogoMetaDemo expects src/ to be 4 levels up from apps/web/src/components/Unit2_*/
        // We remap so that ../../../../src resolves to packages/state-api/src
      },
    },
    build: {
      // Use relative path for outDir - vite-plugin-monaco-editor has a bug
      // where it concatenates absolute paths incorrectly with path.join()
      outDir: 'dist',
      emptyOutDir: true,
    },
  }
})
