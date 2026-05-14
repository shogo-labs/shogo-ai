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
  onSuccess:
    'mkdir -p dist/hooks/bundled/command-logger dist/hooks/bundled/session-memory && ' +
    'cp src/hooks/bundled/command-logger/HOOK.md dist/hooks/bundled/command-logger/HOOK.md && ' +
    'cp src/hooks/bundled/session-memory/HOOK.md dist/hooks/bundled/session-memory/HOOK.md',
})
