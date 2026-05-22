// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// k8s mock — list result is settable per test
let listResult: any = { items: [] }
let listImpl: (args: any) => Promise<any> = async () => listResult

class FakeKubeConfig {
  loadFromDefault() {}
  loadFromOptions(_o: any) {}
  makeApiClient(_cls: any) {
    return {
      listNamespacedCustomObject: (args: any) => listImpl(args),
    }
  }
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  CustomObjectsApi: class {},
}))

let existsImpls: Record<string, boolean> = {}
let readFileImpls: Record<string, string> = {}
mock.module('fs', () => ({
  existsSync: (p: string) => existsImpls[p] === true,
  readFileSync: (p: string) => readFileImpls[p] ?? '',
}))

// otel tracer minimal stub
const otelSpan = {
  setAttribute: () => otelSpan,
  end: () => {},
}
mock.module('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: async (_name: string, fn: (s: any) => any) => fn(otelSpan),
    }),
  },
}))

const evictCalls: any[] = []
let evictImpl: (projectId: string, opts: any) => Promise<void> = async () => {}
mock.module('../../lib/warm-pool-controller', () => ({
  getWarmPoolController: () => ({
    evictProject: async (projectId: string, opts: any) => {
      evictCalls.push({ projectId, opts })
      return evictImpl(projectId, opts)
    },
  }),
}))

const buildEnvCalls: any[] = []
let buildEnvImpl: (projectId: string, opts: any) => Promise<any> = async () => ({ FOO: 'bar' })
mock.module('../../lib/runtime/build-project-env', () => ({
  buildProjectEnv: async (projectId: string, opts: any) => {
    buildEnvCalls.push({ projectId, opts })
    return buildEnvImpl(projectId, opts)
  },
}))

// fetch responses queue
type FResp = { status?: number; jsonBody?: any; contentType?: string; textBody?: string }
let fetchResponses: FResp[] = []
const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
const origFetch = globalThis.fetch
beforeEach(() => {
  listResult = { items: [] }
  listImpl = async () => listResult
  existsImpls = {}
  readFileImpls = {}
  evictCalls.length = 0
  evictImpl = async () => {}
  buildEnvCalls.length = 0
  buildEnvImpl = async () => ({ FOO: 'bar' })
  fetchResponses = []
  fetchCalls.length = 0
  ;(globalThis as any).fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    const r = fetchResponses.shift() ?? { status: 200, jsonBody: {} }
    const status = r.status ?? 200
    const ok = status >= 200 && status < 300
    const ct = r.contentType ?? 'application/json'
    return {
      ok,
      status,
      headers: new Headers({ 'content-type': ct }),
      json: async () => r.jsonBody ?? {},
      text: async () => r.textBody ?? JSON.stringify(r.jsonBody ?? {}),
    }
  }) as any
})
afterEach(() => {
  ;(globalThis as any).fetch = origFetch
})

const { rescueStuckPromotedPods } = await import('../warm-pool-rescue')

function ksvcItem(name: string, projectId?: string, useAnnotation = false) {
  const meta: any = { name }
  if (projectId) {
    if (useAnnotation) meta.annotations = { 'shogo.io/assigned-project': projectId }
    else meta.labels = { 'shogo.io/project': projectId }
  }
  return { metadata: meta }
}

const quietLog = { log: () => {}, warn: () => {}, error: () => {} }

describe('rescueStuckPromotedPods — scan-only paths', () => {
  it('returns empty summary when no promoted ksvc exist', async () => {
    const s = await rescueStuckPromotedPods({ logger: quietLog })
    expect(s.scanned).toBe(0)
    expect(s.stuck).toBe(0)
    expect(s.entries).toEqual([])
  })

  it('reads namespace from PROJECT_NAMESPACE env when not provided', async () => {
    process.env.PROJECT_NAMESPACE = 'custom-ns'
    listImpl = async (args: any) => {
      expect(args.namespace).toBe('custom-ns')
      return { items: [] }
    }
    await rescueStuckPromotedPods({ logger: quietLog })
    delete process.env.PROJECT_NAMESPACE
  })

  it('defaults namespace to shogo-workspaces', async () => {
    delete process.env.PROJECT_NAMESPACE
    listImpl = async (args: any) => {
      expect(args.namespace).toBe('shogo-workspaces')
      return { items: [] }
    }
    await rescueStuckPromotedPods({ logger: quietLog })
  })

  it('skips pods that are healthy and not in pool mode', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-A')] }
    fetchResponses = [{ jsonBody: { poolMode: false } }]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: true })
    expect(s.scanned).toBe(1)
    expect(s.stuck).toBe(0)
    expect(s.entries[0].stuckInPoolMode).toBe(false)
    expect(s.entries[0].action).toBeUndefined()
  })

  it('records probe error and continues without action', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-A')] }
    fetchResponses = [{ status: 500, jsonBody: {}, textBody: 'down' }]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: true })
    expect(s.errors).toBe(1)
    expect(s.entries[0].error).toBeDefined()
    expect(s.entries[0].error).toMatch(/500/)
  })

  it('marks stuck pods but skips action in dry-run', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-A')] }
    fetchResponses = [{ jsonBody: { poolMode: true, projectId: '__POOL__' } }]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: true })
    expect(s.stuck).toBe(1)
    expect(s.entries[0].action).toBe('skipped')
    expect(evictCalls).toHaveLength(0)
  })

  it('uses in-cluster kubeconfig when SA files exist', async () => {
    existsImpls = {
      '/var/run/secrets/kubernetes.io/serviceaccount/token': true,
      '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': true,
    }
    readFileImpls = {
      '/var/run/secrets/kubernetes.io/serviceaccount/token': 'tok',
      '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': 'ca',
    }
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    listResult = { items: [] }
    await rescueStuckPromotedPods({ logger: quietLog })
    delete process.env.KUBERNETES_SERVICE_HOST
    delete process.env.KUBERNETES_SERVICE_PORT
  })

  it('handles probe returning non-JSON content-type as null health', async () => {
    listResult = { items: [ksvcItem('w', 'p')] }
    fetchResponses = [{ contentType: 'text/plain', textBody: 'ok' }]
    const s = await rescueStuckPromotedPods({ logger: quietLog })
    expect(s.stuck).toBe(0)
    expect(s.entries[0].health).toBeNull()
  })

  it('reads projectId from annotation when label missing', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-annot', true)] }
    fetchResponses = [{ jsonBody: { poolMode: false } }]
    const s = await rescueStuckPromotedPods({ logger: quietLog })
    expect(s.entries[0].projectId).toBe('proj-annot')
  })

  it('filters out ksvc items missing metadata.name', async () => {
    listResult = { items: [{ metadata: {} }, ksvcItem('w', 'p')] }
    fetchResponses = [{ jsonBody: { poolMode: false } }]
    const s = await rescueStuckPromotedPods({ logger: quietLog })
    expect(s.scanned).toBe(1)
  })
})

describe('rescueStuckPromotedPods — evict mode', () => {
  it('hard-evicts a stuck pod with deleteService:true', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-A')] }
    fetchResponses = [{ jsonBody: { poolMode: true } }]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: false, mode: 'evict' })
    expect(s.evicted).toBe(1)
    expect(s.entries[0].action).toBe('evicted')
    expect(evictCalls).toEqual([{ projectId: 'proj-A', opts: { deleteService: true } }])
  })

  it('cannot evict without a projectId — reports error', async () => {
    listResult = { items: [ksvcItem('warm-1')] }
    fetchResponses = [{ jsonBody: { poolMode: true } }]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: false, mode: 'evict' })
    expect(s.evicted).toBe(0)
    expect(s.errors).toBe(1)
    expect(s.entries[0].actionError).toMatch(/projectId/)
  })

  it('records actionError when evictProject throws', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-A')] }
    fetchResponses = [{ jsonBody: { poolMode: true } }]
    evictImpl = async () => { throw new Error('boom') }
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: false, mode: 'evict' })
    expect(s.errors).toBe(1)
    expect(s.entries[0].actionError).toContain('boom')
  })
})

describe('rescueStuckPromotedPods — heal mode', () => {
  it('heals via /pool/assign on success', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-A')] }
    fetchResponses = [
      { jsonBody: { poolMode: true } },
      { jsonBody: { ok: true } },
    ]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: false, mode: 'heal' })
    expect(s.healed).toBe(1)
    expect(s.entries[0].action).toBe('healed')
    expect(buildEnvCalls).toEqual([{ projectId: 'proj-A', opts: { logPrefix: 'WarmPoolRescue' } }])
    const assignCall = fetchCalls.find((c) => c.url.includes('/pool/assign'))!
    expect(assignCall.init?.method).toBe('POST')
    const body = JSON.parse(String(assignCall.init?.body))
    expect(body.projectId).toBe('proj-A')
    expect(body.env).toEqual({ FOO: 'bar' })
  })

  it('reports HTTP failure body from /pool/assign', async () => {
    listResult = { items: [ksvcItem('warm-1', 'proj-A')] }
    fetchResponses = [
      { jsonBody: { poolMode: true } },
      { status: 500, textBody: 'bad gateway long body that gets sliced and sliced and sliced' },
    ]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: false, mode: 'heal' })
    expect(s.healed).toBe(0)
    expect(s.errors).toBe(1)
    expect(s.entries[0].actionError).toMatch(/HTTP 500/)
  })

  it('refuses to heal without a projectId', async () => {
    listResult = { items: [ksvcItem('warm-1')] }
    fetchResponses = [{ jsonBody: { poolMode: true } }]
    const s = await rescueStuckPromotedPods({ logger: quietLog, dryRun: false, mode: 'heal' })
    expect(s.healed).toBe(0)
    expect(s.errors).toBe(1)
    expect(s.entries[0].actionError).toMatch(/projectId/)
  })

  it('passes assignTimeoutMs to the abort signal (smoke)', async () => {
    listResult = { items: [ksvcItem('w', 'p')] }
    fetchResponses = [
      { jsonBody: { poolMode: true } },
      { jsonBody: {} },
    ]
    await rescueStuckPromotedPods({
      logger: quietLog,
      dryRun: false,
      mode: 'heal',
      assignTimeoutMs: 100,
      healthTimeoutMs: 100,
    })
    expect(fetchCalls.some((c) => c.url.endsWith('/pool/assign'))).toBe(true)
  })
})
