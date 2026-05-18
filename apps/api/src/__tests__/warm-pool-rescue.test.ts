// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/lib/warm-pool-rescue.ts` — covers the full
 * `rescueStuckPromotedPods` orchestration:
 *
 *   - Lists promoted ksvc via the (mocked) `@kubernetes/client-node`
 *     `CustomObjectsApi.listNamespacedCustomObject`
 *   - Probes each pod's `/health` and classifies poolMode=true as "stuck"
 *   - Honors `dryRun` (default) — sets `action='skipped'`, no mutations
 *   - Evicts stuck pods via the lazily-imported warm-pool controller
 *   - Heals stuck pods via `POST /pool/assign` with env from
 *     `runtime/build-project-env`
 *   - Surfaces probe / action errors into entry & summary counters
 *   - Skips eviction/heal when ksvc has no projectId label
 *
 * Uses an injected logger so we never spam test output and can assert
 * specific warn / error lines fire.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ─── @opentelemetry/api mock ──────────────────────────────────────────

mock.module('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: async (_name: string, fn: any) => {
        const span = { setAttribute: () => {}, end: () => {} }
        return fn(span)
      },
    }),
  },
}))

// ─── @kubernetes/client-node mock ─────────────────────────────────────

let kubeListResult: any = { items: [] }
let kubeListThrow: Error | null = null
const kubeListSpy = mock(async (_: any) => {
  if (kubeListThrow) throw kubeListThrow
  return kubeListResult
})

class FakeKubeConfig {
  loadFromOptions = mock(() => {})
  loadFromDefault = mock(() => {})
  makeApiClient = () => ({ listNamespacedCustomObject: kubeListSpy })
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  CustomObjectsApi: class {},
}))

// ─── fs mock ──────────────────────────────────────────────────────────

let fsExistsAnswer = false
mock.module('fs', () => ({
  existsSync: () => fsExistsAnswer,
  readFileSync: () => 'fake-token-or-ca',
}))

// ─── warm-pool-controller mock (lazy-imported) ────────────────────────

const evictProjectSpy = mock(async (_pid: string, _opts: any) => {})
let evictThrow: Error | null = null
mock.module('../lib/warm-pool-controller', () => ({
  getWarmPoolController: () => ({
    evictProject: async (pid: string, opts: any) => {
      if (evictThrow) throw evictThrow
      return evictProjectSpy(pid, opts)
    },
  }),
}))

// ─── build-project-env mock (lazy-imported by 'heal' mode) ────────────

const buildProjectEnvSpy = mock(async (_pid: string, _opts: any) => ({ FOO: 'bar' }))
let buildEnvThrow: Error | null = null
mock.module('../lib/runtime/build-project-env', () => ({
  buildProjectEnv: async (pid: string, opts: any) => {
    if (buildEnvThrow) throw buildEnvThrow
    return buildProjectEnvSpy(pid, opts)
  },
}))

// Import AFTER mocks — module uses lazy `await import(...)` for the two
// above, but `@kubernetes/client-node` and `fs` are imported at runtime
// inside `listPromotedKsvc` (also lazy), so registration order is fine.
const { rescueStuckPromotedPods } = await import('../lib/warm-pool-rescue')

// ─── fetch mock ───────────────────────────────────────────────────────

type FetchCase =
  | { kind: 'json'; status: number; body: any }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'throw'; err: Error }

let healthResponses: Record<string, FetchCase> = {}
let assignResponses: Record<string, FetchCase> = {}
let fetchCalls: { url: string; init?: any }[] = []

const originalFetch = globalThis.fetch
;(globalThis as any).fetch = async (url: string, init?: any) => {
  fetchCalls.push({ url, init })
  let bucket: Record<string, FetchCase> = healthResponses
  let key = ''
  if (url.includes('/health')) {
    bucket = healthResponses
    key = url.replace('/health', '')
  } else if (url.includes('/pool/assign')) {
    bucket = assignResponses
    key = url.replace('/pool/assign', '')
  }
  const c = bucket[key]
  if (!c) {
    return new Response('default-not-found', { status: 404 })
  }
  if (c.kind === 'throw') throw c.err
  if (c.kind === 'json') {
    return new Response(JSON.stringify(c.body), {
      status: c.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(c.body, { status: c.status })
}

// ─── helpers ──────────────────────────────────────────────────────────

function ksvc(name: string, projectId: string | null) {
  return {
    metadata: {
      name,
      labels: projectId ? { 'shogo.io/project': projectId } : {},
      annotations: {},
    },
  }
}

function makeLogger() {
  return { log: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) }
}

beforeEach(() => {
  kubeListResult = { items: [] }
  kubeListThrow = null
  fsExistsAnswer = false
  healthResponses = {}
  assignResponses = {}
  fetchCalls = []
  evictThrow = null
  buildEnvThrow = null
  evictProjectSpy.mockClear()
  buildProjectEnvSpy.mockClear()
  kubeListSpy.mockClear()
})

// ──────────────────────────────────────────────────────────────────────
// rescueStuckPromotedPods
// ──────────────────────────────────────────────────────────────────────

describe('rescueStuckPromotedPods', () => {
  test('empty namespace returns zero-counter summary', async () => {
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({ logger, namespace: 'ns-empty' })
    expect(out).toEqual({
      scanned: 0,
      stuck: 0,
      evicted: 0,
      healed: 0,
      errors: 0,
      entries: [],
    })
    expect(kubeListSpy).toHaveBeenCalledTimes(1)
    const args = kubeListSpy.mock.calls[0][0]
    expect(args.namespace).toBe('ns-empty')
    expect(args.labelSelector).toContain('promoted')
  })

  test('healthy pod (poolMode=false) is scanned but not marked stuck', async () => {
    kubeListResult = { items: [ksvc('warm-pool-a', 'proj-a')] }
    healthResponses['http://warm-pool-a.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: false, projectId: 'proj-a' },
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({ logger, namespace: 'ns-x' })
    expect(out.scanned).toBe(1)
    expect(out.stuck).toBe(0)
    expect(out.entries[0].stuckInPoolMode).toBe(false)
  })

  test('stuck pod in dryRun mode → action=skipped, no eviction', async () => {
    kubeListResult = { items: [ksvc('warm-pool-b', 'proj-b')] }
    healthResponses['http://warm-pool-b.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: true },
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({ logger, namespace: 'ns-x' })
    expect(out.stuck).toBe(1)
    expect(out.evicted).toBe(0)
    expect(out.healed).toBe(0)
    expect(out.entries[0].action).toBe('skipped')
    expect(evictProjectSpy).not.toHaveBeenCalled()
  })

  test('mode=evict: stuck pod is hard-evicted', async () => {
    kubeListResult = { items: [ksvc('warm-pool-c', 'proj-c')] }
    healthResponses['http://warm-pool-c.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: true },
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'evict',
    })
    expect(out.evicted).toBe(1)
    expect(out.entries[0].action).toBe('evicted')
    expect(evictProjectSpy).toHaveBeenCalledTimes(1)
    expect(evictProjectSpy.mock.calls[0][0]).toBe('proj-c')
    expect(evictProjectSpy.mock.calls[0][1]).toEqual({ deleteService: true })
  })

  test('mode=evict without projectId: increments errors, sets actionError', async () => {
    kubeListResult = { items: [ksvc('warm-pool-d', null)] }
    healthResponses['http://warm-pool-d.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: true },
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'evict',
    })
    expect(out.evicted).toBe(0)
    expect(out.errors).toBe(1)
    expect(out.entries[0].actionError).toMatch(/projectId/)
  })

  test('mode=heal: calls /pool/assign with env, marks healed', async () => {
    kubeListResult = { items: [ksvc('warm-pool-e', 'proj-e')] }
    const base = 'http://warm-pool-e.ns-x.svc.cluster.local'
    healthResponses[base] = { kind: 'json', status: 200, body: { poolMode: true } }
    assignResponses[base] = { kind: 'text', status: 200, body: 'ok' }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'heal',
    })
    expect(out.healed).toBe(1)
    expect(out.entries[0].action).toBe('healed')
    expect(buildProjectEnvSpy).toHaveBeenCalledTimes(1)
    expect(buildProjectEnvSpy.mock.calls[0][0]).toBe('proj-e')
    const assignCall = fetchCalls.find((c) => c.url.endsWith('/pool/assign'))!
    expect(assignCall).toBeTruthy()
    expect(JSON.parse(assignCall.init.body)).toEqual({
      projectId: 'proj-e',
      env: { FOO: 'bar' },
    })
  })

  test('mode=heal: /pool/assign returning non-2xx becomes actionError', async () => {
    kubeListResult = { items: [ksvc('warm-pool-f', 'proj-f')] }
    const base = 'http://warm-pool-f.ns-x.svc.cluster.local'
    healthResponses[base] = { kind: 'json', status: 200, body: { poolMode: true } }
    assignResponses[base] = { kind: 'text', status: 500, body: 'pod blew up' }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'heal',
    })
    expect(out.healed).toBe(0)
    expect(out.errors).toBe(1)
    expect(out.entries[0].actionError).toContain('HTTP 500')
    expect(out.entries[0].actionError).toContain('pod blew up')
  })

  test('mode=heal without projectId is skipped (errors+1)', async () => {
    kubeListResult = { items: [ksvc('warm-pool-g', null)] }
    healthResponses['http://warm-pool-g.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: true },
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'heal',
    })
    expect(out.errors).toBe(1)
    expect(out.entries[0].actionError).toMatch(/projectId/)
    expect(buildProjectEnvSpy).not.toHaveBeenCalled()
  })

  test('probe failure → entry.error set, errors counter incremented, action skipped', async () => {
    kubeListResult = { items: [ksvc('warm-pool-h', 'proj-h')] }
    const base = 'http://warm-pool-h.ns-x.svc.cluster.local'
    healthResponses[base] = { kind: 'throw', err: new Error('connection refused') }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'evict',
    })
    expect(out.scanned).toBe(1)
    expect(out.stuck).toBe(0)
    expect(out.errors).toBe(1)
    expect(out.entries[0].error).toBe('connection refused')
    expect(evictProjectSpy).not.toHaveBeenCalled()
  })

  test('eviction throwing surfaces as actionError', async () => {
    kubeListResult = { items: [ksvc('warm-pool-i', 'proj-i')] }
    healthResponses['http://warm-pool-i.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: true },
    }
    evictThrow = new Error('eviction boom')
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'evict',
    })
    expect(out.errors).toBe(1)
    expect(out.entries[0].actionError).toBe('eviction boom')
    expect(logger.error).toHaveBeenCalled()
  })

  test('probe returns non-json content-type → health is null (treated as not-stuck)', async () => {
    kubeListResult = { items: [ksvc('warm-pool-j', 'proj-j')] }
    healthResponses['http://warm-pool-j.ns-x.svc.cluster.local'] = {
      kind: 'text',
      status: 200,
      body: 'OK',
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({ logger, namespace: 'ns-x' })
    expect(out.stuck).toBe(0)
    expect(out.entries[0].stuckInPoolMode).toBe(false)
  })

  test('probe non-2xx is reported as HTTP error', async () => {
    kubeListResult = { items: [ksvc('warm-pool-k', 'proj-k')] }
    healthResponses['http://warm-pool-k.ns-x.svc.cluster.local'] = {
      kind: 'text',
      status: 503,
      body: 'down',
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({ logger, namespace: 'ns-x' })
    expect(out.errors).toBe(1)
    expect(out.entries[0].error).toContain('HTTP 503')
  })

  test('falls back to PROJECT_NAMESPACE env var when namespace omitted', async () => {
    const prev = process.env.PROJECT_NAMESPACE
    process.env.PROJECT_NAMESPACE = 'env-ns'
    try {
      kubeListResult = { items: [] }
      const logger = makeLogger()
      await rescueStuckPromotedPods({ logger })
      expect(kubeListSpy.mock.calls[0][0].namespace).toBe('env-ns')
    } finally {
      if (prev === undefined) delete process.env.PROJECT_NAMESPACE
      else process.env.PROJECT_NAMESPACE = prev
    }
  })

  test('in-cluster credentials path (fs files present) uses loadFromOptions', async () => {
    fsExistsAnswer = true
    process.env.KUBERNETES_SERVICE_HOST = 'k8s'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    kubeListResult = { items: [] }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({ logger, namespace: 'ns-y' })
    expect(out.scanned).toBe(0)
  })

  test('uses annotation projectId when label is missing', async () => {
    const svc = {
      metadata: {
        name: 'warm-pool-l',
        labels: {},
        annotations: { 'shogo.io/assigned-project': 'proj-from-anno' },
      },
    }
    kubeListResult = { items: [svc] }
    healthResponses['http://warm-pool-l.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: true },
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({
      logger,
      namespace: 'ns-x',
      dryRun: false,
      mode: 'evict',
    })
    expect(out.evicted).toBe(1)
    expect(evictProjectSpy.mock.calls[0][0]).toBe('proj-from-anno')
  })

  test('items without serviceName are filtered out', async () => {
    kubeListResult = {
      items: [
        { metadata: { name: undefined, labels: {}, annotations: {} } },
        ksvc('warm-pool-m', 'proj-m'),
      ],
    }
    healthResponses['http://warm-pool-m.ns-x.svc.cluster.local'] = {
      kind: 'json',
      status: 200,
      body: { poolMode: false },
    }
    const logger = makeLogger()
    const out = await rescueStuckPromotedPods({ logger, namespace: 'ns-x' })
    expect(out.scanned).toBe(1)
  })
})

// `originalFetch` is captured above for completeness; we never restore it
// because each test file runs in its own bun process via run-tests-isolated.
void originalFetch
