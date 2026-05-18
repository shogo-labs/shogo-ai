// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/agent-loop.ts',
    'src/pi-adapter.ts',
    'src/model-catalog/index.ts',
    'src/model-router/index.ts',
    'src/tool-orchestration.ts',
    'src/loop-detector.ts',
    'src/microcompact.ts',
    'src/prefix-fingerprint.ts',
    'src/hooks/index.ts',
    'src/hooks/bundled/command-logger/handler.ts',
    'src/hooks/bundled/session-memory/handler.ts',
    'src/ai-client.ts',
    'src/ai-proxy.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'es2020',
  outDir: 'dist',
  external: [
    '@mariozechner/pi-ai',
    '@mariozechner/pi-agent-core',
  ],
  // Copy bundled hook metadata (HOOK.md) into dist so loadAllHooks works
  // when the package is consumed from `dist/`. Source-mode consumers
  // (tsconfig paths, `development` export condition) read them from `src/`.
  //
  // Implemented via Node's fs.* (instead of `mkdir -p` / `cp`) so the build
  // works on Windows PowerShell — the Unix shim was failing with "A
  // subdirectory or file ... already exists" on incremental rebuilds, which
  // bubbled up as a `bun run build:packages` failure.
  onSuccess: async () => {
    const { mkdirSync, copyFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const pairs: Array<[string, string]> = [
      ['command-logger', 'HOOK.md'],
      ['session-memory', 'HOOK.md'],
    ]
    for (const [hook, file] of pairs) {
      const dstDir = join('dist', 'hooks', 'bundled', hook)
      mkdirSync(dstDir, { recursive: true })
      copyFileSync(join('src', 'hooks', 'bundled', hook, file), join(dstDir, file))
    }
  },
})
