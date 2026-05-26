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

mock.module('@shogo-ai/sdk/model-catalog', () => ({
  getModelTier: (_modelId?: string) => 'standard',
  resolveModelId: (mode?: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id?: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id?: string) => id || '',
  resolveAgentModeDefault: (mode?: string) => mode || '',
  getAgentModeOverrides: () => ({}),
}))

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

// Intercept workspace package re-export shims that Bun doesn't hoist in static-import context
mock.module('@shogo/model-catalog', () => ({
  getModelTier: (_modelId?: string) => 'standard',
  resolveModelId: (mode?: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id?: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id?: string) => id || '',
  resolveAgentModeDefault: (mode?: string) => mode || '',
  getAgentModeOverrides: () => ({}),
  getMaxOutputTokens: (_id?: string) => 4096,
  MODEL_ALIASES: {} as Record<string, any>,
}))

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
}))
