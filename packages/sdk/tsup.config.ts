// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/db/index.ts',
    'src/react/index.ts',
    'src/generators/index.ts',
    'src/email/index.ts',
    'src/email/server.ts',
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
    '@prisma/client',
    '@prisma/internals',
    '@prisma/adapter-pg',
    '@prisma/adapter-libsql',
    'nodemailer',
    '@aws-sdk/client-ses',
  ],
})
