// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bun test preload — intercepts SDK subpath exports that require a built dist/.
 *
 * @shogo-ai/sdk subpath exports use the "import" condition pointing to
 * ./dist/<subpath>/index.js which does not exist in the workspace (the SDK
 * is consumed in-repo as source, not built). The "development" condition
 * is not activated in Bun 1.3.x via bunfig.toml.
 *
 * Additionally, packages/shared-runtime has its own node_modules/@shogo-ai/sdk
 * copy (older version) whose src/ re-exports point to @shogo-ai/core/* which
 * also lacks dist/ files. This preload intercepts ALL these subpaths so
 * that Bun never attempts to resolve the unbuilt dist/.
 *
 * Configured in apps/api/bunfig.toml:
 *   [test]
 *   preload = ["./src/__tests__/preload-sdk-mocks.ts"]
 */

import { mock } from 'bun:test'

// @shogo/shared-runtime re-exports these symbols from these SDK subpaths:
//   ai-proxy:      configureAIProxy
//   chat-message:  extractUserText, findLastUserMessage
//   logger:        createLogger
//   macos-junk:    isMacOSJunkName, isMacOSJunkPath

mock.module('@shogo-ai/sdk/macos-junk', () => ({
  isMacOSJunkName: (_name: string) => false,
  isMacOSJunkPath: (_relPath: string) => false,
  isMacOSJunk: (_name: string) => false,
}))

mock.module('@shogo-ai/sdk/chat-message', () => ({
  extractUserText: (msg: any) => (typeof msg === 'string' ? msg : ''),
  findLastUserMessage: (_msgs: any[]) => null,
  serializeChatMessage: (msg: any) => msg,
  deserializeChatMessage: (msg: any) => msg,
}))

const noop = () => {}
const _logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, child: () => _logger }
mock.module('@shogo-ai/sdk/logger', () => ({
  createLogger: (_opts?: any) => _logger,
  getLogger: () => _logger,
  logger: _logger,
}))

mock.module('@shogo-ai/sdk/instrumentation', () => {
  const noopSpan = { end: noop, setAttribute: () => noopSpan, setStatus: () => noopSpan, recordException: noop }
  const noopTracer = { startSpan: () => noopSpan, startActiveSpan: (_n: any, f: any) => f(noopSpan) }
  return {
    trace: { getTracer: () => noopTracer, getActiveSpan: () => null },
    context: { with: (_ctx: any, fn: any) => fn(), active: () => ({}) },
    SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
    createTracer: (_name: string) => noopTracer,
    initInstrumentation: (_cfg?: any) => Promise.resolve(),
    shutdownInstrumentation: () => Promise.resolve(),
    traceOperation: async (_name: string, fn: () => any) => fn(),
  }
})

mock.module('@shogo-ai/sdk/ai-proxy', () => ({
  configureAIProxy: (_opts?: any) => ({}),
  createAiProxy: (_opts?: any) => ({}),
  AiProxy: class {},
}))

mock.module('@shogo-ai/sdk/ai-client', () => ({
  sendMessage: async (_opts?: any) => ({ content: '', model: '', usage: {} }),
  sendMessageJSON: async (_opts?: any) => ({ content: '', model: '', usage: {} }),
  sendMessages: async (_opts?: any) => ({ content: '', model: '', usage: {} }),
  createAiClient: (_opts?: any) => ({}),
}))

// `@shogo-ai/sdk/model-catalog` and `@shogo/model-catalog` are NOT mocked
// here: apps/api's bunfig.toml ships `conditions = ["development"]`, so
// Bun resolves both to the source `.ts` files (verified with
// `bun --no-env-file -e "import {...} from '@shogo/model-catalog'"`).
// Stubbing them out with empty MODEL_DOLLAR_COSTS / resolveModelId broke
// usage-cost.test.ts and proxy-billing-session.test.ts which legitimately
// exercise the real catalog (and chat-usage-tracker.test.ts which only
// needed a non-empty cost row to not crash inside closeSession).

mock.module('@shogo-ai/sdk/stream-buffer', () => {
  class StreamBufferWriter { write() {} close() {} }
  class StreamBufferStore {
    write(_chunk: any) {} read() { return '' } clear() {}
    get length() { return 0 }
    createWriter() { return new StreamBufferWriter() }
    getTurns() { return [] }
    getSnapshot() { return null }
  }
  return {
    StreamBufferStore,
    StreamBufferWriter,
    createBufferingTransform: () => ({}),
    TurnStatus: { Active: 'active', Complete: 'complete', Error: 'error' },
    TurnTerminal: { Normal: 'normal' },
  }
})

mock.module('@shogo-ai/sdk/tech-stack-registry', () => ({
  TechStackRegistry: class { detect() { return null } },
  TECH_STACK_REGISTRY: {},
  getTechStack: (_dir?: string) => null,
  detectTechStack: (_dir?: string) => Promise.resolve(null),
  getStackEntry: (_id?: string) => null,
  isMobileTechStack: (_stack?: any) => false,
  usesMetroBundler: (_stack?: any) => false,
  stackSeedsItself: (_stack?: any) => false,
}))

mock.module('@shogo-ai/sdk/cli/pkg', () => ({
  pkg: { version: '0.0.0', name: '@shogo-ai/sdk' },
  getPackageVersion: () => '0.0.0',
  PlatformPackageManager: class {},
  NodeMissingError: class NodeMissingError extends Error { constructor(m: string) { super(m); this.name = 'NodeMissingError'; } },
  isNodeAvailableOnUnix: () => Promise.resolve(false),
  isNodeAvailableOnWindows: () => Promise.resolve(false),
  _resetUnixNodeCache: () => {},
  kg: () => {},
  resolveBinInvocation: (cmd: string) => cmd,
}))

// Intercept workspace package re-export shims that Bun doesn't hoist in
// static-import context. Keep the symbol union in sync with `import { ... }
// from '@shogo/model-catalog'` across apps/api/src/** — Bun resolves every
// named import at module load, so a missing symbol here turns into a
// "SyntaxError: Export named 'X' not found" the moment a sibling test
// imports a route that touches it (e.g. ai-proxy.ts pulls in
// IMAGE_MODEL_CATALOG / AGENT_MODE_DEFAULTS).
// `@shogo/shared-runtime` is imported in many apps/api code paths
// (manager.ts, server.ts, project-export-import.ts, marketplace-install,
// instance-sizes, …). Most tests don't touch shared-runtime behaviour at
// all, but Bun fully resolves every named import at module load — so
// every missing symbol here turns into a "SyntaxError: Export named 'X'
// not found" the moment a sibling import pulls in a file that touches it.
// Keep this object in sync with the union of `import { ... } from
// '@shogo/shared-runtime'` across apps/api/src/**.
mock.module('@shogo/shared-runtime', () => ({
  RUNTIME_CONFIG: {
    apiPort: 4000,
    runtimePort: 5000,
    portRangeStart: 5100,
    portRangeEnd: 5200,
    image: () => 'shogo-runtime:test',
    workDir: '/app/workspace',
    extraEnv: {},
    componentLabel: 'runtime',
    containerName: 'runtime',
  },
  pkg: {
    version: '0.0.0',
    name: '@shogo/shared-runtime',
    isWindows: false,
    bunBinary: 'bun',
    // runtime/manager.ts:ensureProjectDirectory calls pkg.installAsync
    // for projects without a pre-seeded template; mirror the real
    // installer's contract of "node_modules exists after success" so
    // the writeFileSync(installSentinel) on the next line doesn't ENOENT.
    installAsync: async (dir: string, _opts?: any) => {
      const { mkdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      try { mkdirSync(join(dir, 'node_modules'), { recursive: true }) } catch {}
    },
  },
  isMobileTechStack: (stack?: any) =>
    stack === 'expo-app' || stack === 'expo-three' || stack === 'react-native',
  // Keep this in sync with `seedsOwnTemplate: true` entries in
  // packages/core/src/tech-stack-registry.ts. runtime-manager-directory.test.ts
  // relies on `python-data` returning true to exercise the empty-workspace
  // skip-install branch in `ensureProjectDirectory`.
  stackSeedsItself: (stack?: any) =>
    stack === 'expo-app' ||
    stack === 'expo-three' ||
    stack === 'react-native' ||
    stack === 'python-data' ||
    stack === 'unity-game' ||
    stack === 'none',
  diagnosticsRoutes: () => ({}),
  createS3SyncForProject: (_projectId?: string, _opts?: any) => ({
    syncProjectArchive: async () => ({ ok: true }),
    downloadProjectArchive: async () => null,
    listProjectArchives: async () => [],
  }),
  isMacOSJunkName: (_name: string) => false,
}))
