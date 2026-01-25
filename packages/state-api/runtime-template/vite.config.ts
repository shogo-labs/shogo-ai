import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    // Optimizations for faster builds
    target: 'esnext',    // Skip transpilation (modern browsers only)
    minify: false,       // Skip minification for preview builds
  },
})
