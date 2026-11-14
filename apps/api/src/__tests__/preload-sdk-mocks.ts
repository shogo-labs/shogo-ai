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

// Do NOT eagerly import a module and then spread it into its own mock: the
// eager import makes bun's mock shadow deeper paths than the one you named (it
// swallowed `packages/shared-runtime/src/*` and `packages/core/src/*` for other
// tests — SHO-291 round 6). Add the symbols a bigger import graph needs instead.
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
    // Re-exported by `packages/shared-runtime/src/stream-buffer.ts`, so anything
    // that pulls in the shared-runtime barrel names it (SHO-291).
    TURN_COMPLETE_EVENT_TYPE: 'turn_complete',
    encodeTurnCompleteFrame: (payload: any) =>
      `data: ${JSON.stringify({ type: 'turn_complete', ...payload })}\n\n`,
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
  // Re-exported by `packages/shared-runtime/src/tech-stack-registry.ts`. Kept
  // out of the shared-runtime barrel mock on purpose: `instance-sizes.test.ts`
  // imports this module directly and needs the real registry values.
  isDockerTechStack: (stack?: any) => stack === 'docker-compose',
  getMinimumInstanceSize: (stack?: any) => (stack === 'docker-compose' ? 'large' : null),
  getDeclaredPorts: (_stack?: any) => [],
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

const emailService = {
  send: async () => ({ success: true }),
  sendTemplate: async () => ({ success: true }),
}
mock.module('@shogo-ai/email/server', () => ({
  createEmail: () => emailService,
  createEmailOptional: () => emailService,
}))
mock.module('@shogo-ai/sdk/email/server', () => ({
  createEmail: () => emailService,
  createEmailOptional: () => emailService,
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
//
// A hand-maintained mirror of that export union always drifts (SHO-291: the
// agent-loop import graph needed TECH_STACK_REGISTRY, and adding it only moved
// the failure to createLogger). Do NOT spread the real barrel here instead:
// eagerly importing it makes bun's mock cover the deep
// `packages/shared-runtime/src/*` imports that several tests use deliberately as
// the escape hatch (qa-sho212 loads s3-sync "by path (a specifier the preload
// does not mock)"). The agent-loop symbols it needs are added explicitly below.
// Mirror of `packages/shared-runtime/src/social-providers.ts` (SHO-379). Kept as
// module-scope constants so the four barrel exports below cannot drift from each
// other the way they drifted from the real module.
const ZERNIO_PLATFORMS = ['instagram', 'tiktok'] as const
const zernioNormalize = (name: string) => name.toLowerCase().replace(/[-_\s]/g, '')

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
  // Keep in sync with the `docker-compose` registry entry in
  // packages/core/src/tech-stack-registry.ts (vmClass: 'docker',
  // minimumInstanceSize: 'large'). Used by apps/api/src/config/instance-sizes.ts.
  isDockerTechStack: (stack?: any) => stack === 'docker-compose',
  getMinimumInstanceSize: (stack?: any) => (stack === 'docker-compose' ? 'large' : null),
  // Keep in sync with the `docker-compose` registry entry's `ports` array.
  getDeclaredPorts: (stack?: any) =>
    stack === 'docker-compose'
      ? [
          { port: 8000, label: 'app', protocol: 'http', defaultVisibility: 'preview' },
          { port: 5432, label: 'postgres', protocol: 'tcp', defaultVisibility: 'tunnel' },
        ]
      : [],
  diagnosticsRoutes: () => ({}),
  createS3SyncForProject: (_projectId?: string, _opts?: any) => ({
    syncProjectArchive: async () => ({ ok: true }),
    downloadProjectArchive: async () => null,
    listProjectArchives: async () => [],
  }),
  isMacOSJunkName: (_name: string) => false,
  // Git LFS helpers named by `routes/git-lfs.ts` (SHO-368). Mirror the real
  // implementations in packages/shared-runtime/src/lfs.ts exactly — the route
  // builds object keys and validates oids through these.
  lfsKeyPrefix: (env: NodeJS.ProcessEnv = process.env) =>
    (env.S3_LFS_PREFIX || 'lfs/objects').replace(/^\/+|\/+$/g, ''),
  isValidLfsOid: (oid: string) => /^[0-9a-f]{64}$/.test(oid),
  lfsObjectKey: (projectId: string, oid: string, prefix: string = (process.env.S3_LFS_PREFIX || 'lfs/objects').replace(/^\/+|\/+$/g, '')) => {
    if (!/^[0-9a-f]{64}$/.test(oid)) throw new Error(`invalid lfs oid: ${oid}`)
    return `${projectId}/${prefix}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
  },
  // Symbols the `@shogo/agent-runtime/src/agent-loop` graph names on the barrel.
  // apps/api routes never needed them, so the mirror above never had them — a
  // missing name is a hard SyntaxError at module load, not a runtime no-op
  // (SHO-291). Keep this list to what an import actually names.
  TECH_STACK_REGISTRY: {},
  createLogger: (_opts?: any) => {
    const noop = () => {}
    const logger: any = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop, child: () => logger }
    return logger
  },
  isBinaryFilePath: (filePath: string) => {
    const ext = (filePath.split('.').pop() || '').toLowerCase()
    return [
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
      'pdf', 'zip', 'gz', 'tar', 'mp4', 'mov', 'webm', 'm4v', 'mp3', 'wav',
      'woff', 'woff2', 'ttf', 'otf', 'eot',
    ].includes(ext)
  },
  StreamBufferStore: class { write(_chunk: any) {} read() { return '' } clear() {} get length() { return 0 } getTurns() { return [] } },
  TURN_COMPLETE_EVENT_TYPE: 'turn_complete',
  encodeTurnCompleteFrame: (payload: any) =>
    `data: ${JSON.stringify({ type: 'turn_complete', ...payload })}\n\n`,
  wrapSseStreamWithKeepalive: (stream: any) => stream,
  traceOperation: (_name: any, fn?: any) => (typeof fn === 'function' ? fn() : undefined),
  sendMessageJSON: (_msg?: any) => {},
  createRuntimeApp: () => ({ routes: [] }),
  // publish.ts uses these for static asset response headers (added by the
  // titles/uploads/cache-headers change). Mirror the real, trivial
  // implementations in packages/shared-runtime/src/{static-asset-cache,file-types}.ts
  // exactly rather than stubbing, since publish-always-on.test.ts /
  // publish-plan-gate.test.ts exercise the route end-to-end.
  isContentHashedFilename: (fileName: string) => {
    const base = fileName.split('/').pop() || fileName
    return /[-_][A-Za-z0-9]{8,}\.[A-Za-z0-9]+$/.test(base)
  },
  staticAssetCacheControl: (fileName: string) => {
    const base = fileName.split('/').pop() || fileName
    const hashed = /[-_][A-Za-z0-9]{8,}\.[A-Za-z0-9]+$/.test(base)
    return hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
  },
  isBinaryBuffer: (bytes: Uint8Array, inspectBytes = 8192) => {
    const head = bytes.subarray(0, Math.min(bytes.length, inspectBytes))
    if (head.includes(0)) return true
    const startsWith = (...signature: number[]) =>
      signature.every((value, index) => head[index] === value)
    const ascii = (value: string) =>
      Array.from(value).every((char, index) => head[index] === char.charCodeAt(0))
    return (
      startsWith(0x50, 0x4b, 0x03, 0x04) ||
      startsWith(0x50, 0x4b, 0x05, 0x06) ||
      startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) ||
      ascii('%PDF-') ||
      startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
      startsWith(0xff, 0xd8, 0xff) ||
      startsWith(0x47, 0x49, 0x46, 0x38) ||
      startsWith(0x52, 0x49, 0x46, 0x46)
    )
  },
  // Instagram/TikTok connect through Zernio, not Composio (SHO-379).
  // `apps/api/src/routes/integrations.ts` names ZERNIO_SOCIAL_TOOLKITS and
  // isZernioSocialToolkit; the `@shogo/agent-runtime` graph names
  // normalizeToolkitName and zernioPlatformsFromQuery. All four are re-exported
  // from the barrel, so all four must exist here. Mirror the real
  // implementations in packages/shared-runtime/src/social-providers.ts.
  ZERNIO_SOCIAL_TOOLKITS: ZERNIO_PLATFORMS,
  normalizeToolkitName: zernioNormalize,
  isZernioSocialToolkit: (name: string) =>
    (ZERNIO_PLATFORMS as readonly string[]).includes(zernioNormalize(name)),
  zernioPlatformsFromQuery: (query: string) => {
    const normalized = zernioNormalize(query)
    return ZERNIO_PLATFORMS.filter((platform) => normalized.includes(platform))
  },
}))
