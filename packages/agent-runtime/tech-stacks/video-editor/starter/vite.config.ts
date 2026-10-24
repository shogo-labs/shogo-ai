import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The canvas preview is served by the Shogo runtime from `dist/`, under a
// per-project base path (`/p/<projectId>/`). Its value arrives as
// $SHOGO_BASE_PATH on every build, so asset URLs must be relative to it.
export default defineConfig({
  base: process.env.SHOGO_BASE_PATH ?? '/',
  plugins: [react()],
  server: { host: true },
})
