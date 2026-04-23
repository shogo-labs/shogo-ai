import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Alias `@shogo-ai/sdk/voice/react` to the SDK source so any tweak to
// `OrganicSphere.tsx` or `sphereConfig.ts` shows up instantly via HMR.
// The source subtree has no heavy deps (just `react`, `three`, and its
// own shader strings), so Vite/esbuild transpile it natively.
const sdkVoiceReactSrc = path.resolve(
  __dirname,
  '../../src/voice/react/index.ts',
)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shogo-ai/sdk/voice/react': sdkVoiceReactSrc,
    },
  },
  server: {
    fs: {
      // Let Vite serve files from the SDK source tree above the playground root.
      allow: [path.resolve(__dirname, '../../')],
    },
  },
})
