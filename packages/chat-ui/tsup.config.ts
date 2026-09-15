import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.tsx', host: 'src/host.tsx' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['react', 'react-dom', 'ai'],
})
