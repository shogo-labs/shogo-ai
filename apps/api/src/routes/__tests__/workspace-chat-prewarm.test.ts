// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace runtime prewarm timings: the route answers 202 straight away and
 * records `runtime.prewarm_ms` (plus a `workspace.runtime.prewarm` span) once
 * the background resolve settles.
 *
 *   bun test ./apps/api/src/routes/__tests__/workspace-chat-prewarm.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const realOtel = await import('@opentelemetry/api')
// mock.module patches the live module object, so hold the originals.
const realMetrics = { ...realOtel.metrics, getMeter: realOtel.metrics.getMeter.bind(realOtel.metrics) }
const realTrace = { ...realOtel.trace, getTracer: realOtel.trace.getTracer.bind(realOtel.trace) }
const { SpanStatusCode } = realOtel

const recorded: Array<{ ms: number; attrs: Record<string, string> }> = []
const span = {
  attrs: {} as Record<string, unknown>,
  ended: false,
  status: undefined as { code: number } | undefined,
  exceptions: [] as unknown[],
}

mock.module('@opentelemetry/api', () => ({
  ...realOtel,
  metrics: {
    ...realMetrics,
    getMeter: (name: string) => {
      const meter = realMetrics.getMeter(name)
      return new Proxy(meter, {
        get: (target, key) =>
          key === 'createHistogram'
            ? (histName: string, opts?: unknown) =>
                histName === 'runtime.prewarm_ms'
                  ? { record: (ms: number, attrs: Record<string, string>) => recorded.push({ ms, attrs }) }
                  : target.createHistogram(histName, opts as any)
            : (target as any)[key],
      })
    },
  },
  trace: {
    ...realTrace,
    getTracer: (name: string) => {
      const tracer = realTrace.getTracer(name)
      return new Proxy(tracer, {
        get: (target, key) =>
          key === 'startSpan'
            ? (spanName: string, opts?: { attributes?: Record<string, unknown> }, ctx?: any) => {
                if (spanName !== 'workspace.runtime.prewarm') return target.startSpan(spanName, opts as any, ctx)
                Object.assign(span.attrs, opts?.attributes)
                return {
                  setAttributes: (a: Record<string, unknown>) => Object.assign(span.attrs, a),
                  setStatus: (s: { code: number }) => {
                    span.status = s
                  },
                  recordException: (e: unknown) => span.exceptions.push(e),
                  end: () => {
                    span.ended = true
                  },
                }
              }
            : (target as any)[key],
      })
    },
  },
}))

const store = {
  resolveThrow: null as Error | null,
  wake: undefined as { mode: string; source?: string } | undefined,
  resolveCalls: [] as any[],
}

mock.module('../../services/workspace.service', () => ({
  getWorkspaceKind: async () => 'team',
  loadWorkspaceContext: async () => ({ hasAccess: true, kind: 'team' }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

const { reportWake } = await import('../../lib/wake-capture')

mock.module('../../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async (workspaceId: string, opts: any) => {
      store.resolveCalls.push({ workspaceId, ...opts, runtimeManager: undefined })
      await new Promise((r) => setTimeout(r, 5))
      if (store.resolveThrow) throw store.resolveThrow
      if (store.wake) reportWake(store.wake)
      return { url: 'http://pod.internal:8080', mode: 'metal' }
    },
  }
})

mock.module('../../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: () => 'token',
}))

mock.module('../../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => 'test-user',
  getProjectOwnerUserId: async () => 'test-user',
  getWorkspaceOwnerUserId: async () => 'test-user',
}))

mock.module('../../lib/prisma', () => ({
  Prisma: {},
  InstanceKind: { desktop: 'desktop', cli_worker: 'cli_worker' },
  prisma: {
    chatSession: { findUnique: async () => ({ contextId: null }) },
    projectFolder: { findMany: async () => [] },
  },
}))

const { workspaceChatRoutes, prewarmSource } = await import('../workspace-chat')

function prewarm(body: unknown) {
  const { Hono } = require('hono')
  const app = new Hono()
  app.route('/api', workspaceChatRoutes({ resolveUserId: async () => 'user-1', runtimeManager: {} as any }))
  return app.fetch(
    new Request('http://x/api/workspaces/ws-1/runtime/prewarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function settled() {
  for (let i = 0; i < 100 && !span.ended; i++) await new Promise((r) => setTimeout(r, 5))
  expect(span.ended).toBe(true)
}

beforeEach(() => {
  recorded.length = 0
  span.attrs = {}
  span.ended = false
  span.status = undefined
  span.exceptions = []
  store.resolveThrow = null
  store.wake = undefined
  store.resolveCalls = []
})

describe('POST /api/workspaces/:workspaceId/runtime/prewarm timings', () => {
  test('answers 202 before the runtime resolves, then records the warm', async () => {
    store.wake = { mode: 'assigned', source: 'pool' }
    const res = await prewarm({ source: 'onboarding' })
    expect(res.status).toBe(202)
    expect(recorded).toHaveLength(0)

    await settled()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.ms).toBeGreaterThanOrEqual(0)
    expect(recorded[0]!.attrs).toEqual({
      source: 'onboarding',
      substrate: 'metal',
      outcome: 'ok',
      'wake.mode': 'assigned',
      'wake.source': 'pool',
    })
    expect(span.attrs).toMatchObject({
      'workspace.id': 'ws-1',
      'prewarm.source': 'onboarding',
      outcome: 'ok',
    })
    expect(typeof span.attrs['prewarm.ms']).toBe('number')
    expect(store.resolveCalls[0]).toMatchObject({ workspaceId: 'ws-1', attachedProjectIds: [] })
  })

  test('records a failed warm with outcome=error and marks the span', async () => {
    store.resolveThrow = new Error('boom')
    const res = await prewarm({ source: 'home_draft' })
    expect(res.status).toBe(202)

    await settled()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.attrs).toMatchObject({
      source: 'home_draft',
      substrate: 'unknown',
      outcome: 'error',
      'wake.mode': 'none',
    })
    expect(span.status?.code).toBe(SpanStatusCode.ERROR)
    expect(span.exceptions).toHaveLength(1)
  })

  test('unrecognised sources are bucketed as unknown', async () => {
    await prewarm({ source: 'something-else' })
    await settled()
    expect(recorded[0]!.attrs.source).toBe('unknown')
  })
})

describe('prewarmSource', () => {
  test('keeps known callers and buckets everything else', () => {
    expect(prewarmSource('onboarding')).toBe('onboarding')
    expect(prewarmSource('home_draft')).toBe('home_draft')
    expect(prewarmSource('x'.repeat(100))).toBe('unknown')
    expect(prewarmSource(42)).toBe('unknown')
    expect(prewarmSource(undefined)).toBe('unknown')
  })
})
