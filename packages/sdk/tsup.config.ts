import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/react/index.ts',
    'src/generators/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'es2020',
  outDir: 'dist',
  external: [
    'react',
    'mobx',
    'mobx-react-lite',
    '@tanstack/react-start',
    '@prisma/client',
    '@prisma/internals',
  ],
})
