// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/db/index.ts',
    'src/react/index.ts',
    'src/agent/index.ts',
    'src/generators/index.ts',
    'src/email/index.ts',
    'src/email/server.ts',
    'src/tools/index.ts',
    'src/memory/index.ts',
    'src/memory/server.ts',
    'src/voice/index.ts',
    'src/voice/server.ts',
    'src/voice/react/index.ts',
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
    '@elevenlabs/react',
    '@prisma/client',
    '@prisma/internals',
    '@prisma/adapter-pg',
    '@prisma/adapter-libsql',
    'nodemailer',
    '@aws-sdk/client-ses',
    'better-sqlite3',
    'bun:sqlite',
  ],
})
