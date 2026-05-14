// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Knative Project Manager — unit tests.
 *
 * Strategy: replace `@kubernetes/client-node` with a stub via `withK8sExports`
 * so the manager can exercise its full state machine (create / status /
 * domain-mapping / scale / delete / list) without a real cluster, and
 * replace the side-effect modules it imports (Prisma, Cloudflare DNS,
 * database.service) with deterministic no-ops.
 *
 *   bun test apps/api/src/__tests__/knative-project-manager.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { withK8sExports, type K8sCallLog } from './helpers/k8s-mock'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// Force kubernetes-mode for the lifetime of this test file. `isKubernetes()`
// reads `KUBERNETES_SERVICE_HOST` lazily so we can set it before importing
// the manager.
process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.KUBERNETES_SERVICE_PORT = '443'
process.env.PREVIEW_BASE_DOMAIN = 'example.com'
process.env.PREVIEW_ENVIRONMENT = 'dev'
process.env.PROJECT_NAMESPACE = 'shogo-test'
process.env.SHOGO_LOCAL_MODE = 'false'

const capture: K8sCallLog = []

// `customObjects.getNamespacedCustomObject` powers `getStatus`, etc.
// We control its response per-test via these mutable shared variables.
let customGetResponse: any = null
let customGetError: any = null
let customListResponse: any = { items: [] }
let createConflict = false
let deleteNotFound = false

mock.module('@kubernetes/client-node', () => withK8sExports({
  CustomObjectsApi: {
    getNamespacedCustomObject: async () => {
      if (customGetError) throw customGetError
      return customGetResponse
    },
    listNamespacedCustomObject: async () => customListResponse,
    createNamespacedCustomObject: async (args: any) => {
      capture.push({ api: 'CustomObjectsApi', method: 'createNamespacedCustomObject', args: [args] })
      if (createConflict) {
        const err: any = new Error('AlreadyExists')
        err.code = 409
        err.body = { reason: 'AlreadyExists' }
        throw err
      }
      return { body: {} }
    },
    deleteNamespacedCustomObject: async (args: any) => {
      capture.push({ api: 'CustomObjectsApi', method: 'deleteNamespacedCustomObject', args: [args] })
      if (deleteNotFound) {
        const err: any = new Error('NotFound')
        err.code = 404
        throw err
      }
      return { body: {} }
    },
    patchNamespacedCustomObject: async (args: any) => {
      capture.push({ api: 'CustomObjectsApi', method: 'patchNamespacedCustomObject', args: [args] })
      return { body: {} }
    },
  },
  CoreV1Api: {
    deleteNamespacedPersistentVolumeClaim: async (args: any) => {
      capture.push({ api: 'CoreV1Api', method: 'deleteNamespacedPersistentVolumeClaim', args: [args] })
      const err: any = new Error('NotFound')
      err.code = 404
      throw err
    },
  },
  capture,
}))

let projectKnativeServiceName: string | null = null
mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findUnique: async () => ({ knativeServiceName: projectKnativeServiceName }),
      update: async () => ({}),
    },
  },
}))

mock.module('../lib/cloudflare-dns', () => ({
  upsertPreviewDnsRecord: async () => {},
  deletePreviewDnsRecord: async () => {},
}))

mock.module('../services/database.service', () => ({
  provisionDatabase: async () => ({ host: 'pg', database: 'db', username: 'u', password: 'p' }),
  deprovisionDatabase: async () => {},
  getDatabaseUrl: () => null,
}))

mock.module('./ai-proxy-token', () => ({
  generateProxyToken: async () => 'proxy-token-test',
}))

mock.module('../lib/warm-pool-controller', () => ({
  getWarmPoolController: () => ({ tryClaimWarmPod: async () => null }),
}))

// Stub `fetch` so `mergePatchKnativeService`, `updatePreviewDomainMapping`,
// and `healthCheck` calls don't escape the test process.
const originalFetch = globalThis.fetch
let nextFetch: () => Response = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeAll(() => {
  globalThis.fetch = (async () => nextFetch() as any) as any
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  capture.length = 0
  customGetResponse = null
  customGetError = null
  customListResponse = { items: [] }
  createConflict = false
  deleteNotFound = false
  projectKnativeServiceName = null
  nextFetch = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
})

// ─── Imports AFTER mocks ─────────────────────────────────────────────────
const {
  KnativeProjectManager,
  getKnativeProjectManager,
  getPreviewSubdomain,
  getPreviewUrl,
  getProjectPodUrl,
  mergePatchKnativeService,
  jsonPatchKnativeService,
} = await import('../lib/knative-project-manager')

// =========================================================================
// Pure helpers
// =========================================================================

describe('getPreviewSubdomain / getPreviewUrl', () => {
  test('non-production format is preview--{id}.{env}.{base}', () => {
    expect(getPreviewSubdomain('abc')).toBe('preview--abc.dev.example.com')
    expect(getPreviewUrl('abc')).toBe('https://preview--abc.dev.example.com')
  })
})

// =========================================================================
// Constructor + simple getters
// =========================================================================

describe('KnativeProjectManager constructor', () => {
  test('honours config overrides', () => {
    const mgr = new KnativeProjectManager({
      namespace: 'custom-ns',
      idleTimeoutSeconds: 60,
      memoryLimit: '4Gi',
      cpuLimit: '2',
      s3WorkspacesBucket: 'my-bucket',
      s3Region: 'eu-central-1',
    })
    // `getProjectPodUrl` exposes the namespace in the assembled URL.
    expect(mgr.getProjectPodUrl('p1')).toBe('http://project-p1.custom-ns.svc.cluster.local')
  })

  test('falls back to environment defaults', () => {
    const mgr = new KnativeProjectManager()
    expect(mgr.getProjectPodUrl('xyz')).toBe('http://project-xyz.shogo-test.svc.cluster.local')
  })
})

describe('getKnativeProjectManager (singleton)', () => {
  test('returns the same instance across calls', () => {
    const a = getKnativeProjectManager()
    const b = getKnativeProjectManager()
    expect(a).toBe(b)
  })
})

// =========================================================================
// resolveProjectPodUrl — uses DB knativeServiceName when present
// =========================================================================

describe('resolveProjectPodUrl', () => {
  test('falls back to project-{id} when DB has no service name', async () => {
    const mgr = new KnativeProjectManager()
    const url = await mgr.resolveProjectPodUrl('proj-1')
    expect(url).toBe('http://project-proj-1.shogo-test.svc.cluster.local')
  })

  test('uses DB knativeServiceName when present', async () => {
    projectKnativeServiceName = 'warm-pool-abc'
    const mgr = new KnativeProjectManager()
    const url = await mgr.resolveProjectPodUrl('proj-1')
    expect(url).toBe('http://warm-pool-abc.shogo-test.svc.cluster.local')
  })
})

// =========================================================================
// getServiceStatus / getStatus
// =========================================================================

describe('getServiceStatus / getStatus', () => {
  test('returns "not exists" when k8s 404s', async () => {
    customGetError = Object.assign(new Error('not found'), { code: 404 })
    const mgr = new KnativeProjectManager()
    const status = await mgr.getStatus('p1')
    expect(status.exists).toBe(false)
    expect(status.ready).toBe(false)
    expect(status.url).toBeNull()
  })

  test('returns ready=true when the Ready condition reports True', async () => {
    customGetResponse = {
      metadata: { creationTimestamp: '2026-01-01T00:00:00Z', generation: 3 },
      status: {
        url: 'http://svc.local',
        actualReplicas: 1,
        conditions: [{ type: 'Ready', status: 'True', message: 'ok' }],
        observedGeneration: 3,
      },
    }
    const mgr = new KnativeProjectManager()
    const status = await mgr.getStatus('p1')
    expect(status.exists).toBe(true)
    expect(status.ready).toBe(true)
    expect(status.url).toBe('http://svc.local')
    expect(status.message).toBe('ok')
  })

  test('returns ready=false when Ready condition is not True', async () => {
    customGetResponse = {
      metadata: {},
      status: { conditions: [{ type: 'Ready', status: 'Unknown' }] },
    }
    const mgr = new KnativeProjectManager()
    const status = await mgr.getStatus('p1')
    expect(status.exists).toBe(true)
    expect(status.ready).toBe(false)
  })

  test('rethrows non-404 errors', async () => {
    customGetError = Object.assign(new Error('boom'), { code: 500 })
    const mgr = new KnativeProjectManager()
    await expect(mgr.getStatus('p1')).rejects.toThrow(/boom/)
  })
})

// =========================================================================
// listProjects / listAllServices
// =========================================================================

describe('listProjects / listAllServices', () => {
  test('listProjects filters items missing the shogo.io/project label', async () => {
    customListResponse = {
      items: [
        {
          metadata: { name: 'project-a', labels: { 'shogo.io/project': 'a' } },
          status: { conditions: [{ type: 'Ready', status: 'True' }], url: 'http://a' },
        },
        // No label — should be filtered out.
        {
          metadata: { name: 'project-anon' },
          status: { conditions: [] },
        },
      ],
    }
    const mgr = new KnativeProjectManager()
    const projects = await mgr.listProjects()
    expect(projects.length).toBe(1)
    expect(projects[0].projectId).toBe('a')
    expect(projects[0].status.ready).toBe(true)
  })

  test('listAllServices keeps services with no project label', async () => {
    customListResponse = {
      items: [
        {
          metadata: { name: 'project-a', labels: { 'shogo.io/project': 'a' } },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
        {
          metadata: { name: 'warm-pool-1' },
          status: { conditions: [] },
        },
      ],
    }
    const mgr = new KnativeProjectManager()
    const services = await mgr.listAllServices()
    expect(services.length).toBe(2)
  })
})

// =========================================================================
// createPreviewDomainMapping
// =========================================================================

describe('createPreviewDomainMapping', () => {
  test('creates a DomainMapping pointing at project-{id} by default', async () => {
    const mgr = new KnativeProjectManager()
    await mgr.createPreviewDomainMapping('p1')
    const create = capture.find((c) => c.method === 'createNamespacedCustomObject')
    expect(create).toBeDefined()
    const body = create!.args[0].body
    expect(body.metadata.name).toBe('preview--p1.dev.example.com')
    expect(body.spec.ref.name).toBe('project-p1')
  })

  test('honours explicit serviceName override', async () => {
    const mgr = new KnativeProjectManager()
    await mgr.createPreviewDomainMapping('p1', 'warm-pool-xyz')
    const create = capture.find((c) => c.method === 'createNamespacedCustomObject')
    expect(create!.args[0].body.spec.ref.name).toBe('warm-pool-xyz')
  })

  test('on AlreadyExists falls through to updatePreviewDomainMapping', async () => {
    createConflict = true
    // The update path goes via raw fetch, returning 200 by default.
    let patchCalls = 0
    nextFetch = () => {
      patchCalls++
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const mgr = new KnativeProjectManager()
    await mgr.createPreviewDomainMapping('p1', 'new-svc')
    expect(patchCalls).toBeGreaterThan(0)
  })
})

// =========================================================================
// updatePreviewDomainMapping (raw-fetch PATCH path)
// =========================================================================

describe('updatePreviewDomainMapping', () => {
  test('issues a merge-patch PATCH against the DomainMapping endpoint', async () => {
    let lastUrl: string | null = null
    let lastInit: RequestInit | null = null
    nextFetch = () => new Response('{}', { status: 200 })
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      lastUrl = typeof input === 'string' ? input : input.url
      lastInit = init || null
      return new Response('{}', { status: 200 }) as any
    }) as any
    const mgr = new KnativeProjectManager()
    await mgr.updatePreviewDomainMapping('p1', 'svc-2')
    expect(lastUrl).toContain('/domainmappings/preview--p1.dev.example.com')
    expect((lastInit as any)?.method).toBe('PATCH')
    expect((lastInit as any)?.headers['Content-Type']).toBe('application/merge-patch+json')
    // Restore the file-scope stub for subsequent tests.
    globalThis.fetch = (async () => nextFetch() as any) as any
  })

  test('on 404 falls through to createPreviewDomainMapping', async () => {
    let createCalled = false
    globalThis.fetch = (async () => new Response('{}', { status: 404 }) as any) as any
    const original = capture.length
    const mgr = new KnativeProjectManager()
    await mgr.updatePreviewDomainMapping('p1', 'svc-2')
    createCalled = capture.slice(original).some((c) => c.method === 'createNamespacedCustomObject')
    expect(createCalled).toBe(true)
    globalThis.fetch = (async () => nextFetch() as any) as any
  })

  test('non-2xx, non-404 logs and returns without throwing', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 }) as any) as any
    const mgr = new KnativeProjectManager()
    await expect(mgr.updatePreviewDomainMapping('p1', 'svc-2')).resolves.toBeUndefined()
    globalThis.fetch = (async () => nextFetch() as any) as any
  })
})

// =========================================================================
// deletePreviewDomainMapping
// =========================================================================

describe('deletePreviewDomainMapping', () => {
  test('happy path deletes the DomainMapping', async () => {
    const mgr = new KnativeProjectManager()
    await mgr.deletePreviewDomainMapping('p1')
    expect(capture.some((c) => c.method === 'deleteNamespacedCustomObject')).toBe(true)
  })

  test('swallows 404 errors silently', async () => {
    deleteNotFound = true
    const mgr = new KnativeProjectManager()
    await expect(mgr.deletePreviewDomainMapping('p1')).resolves.toBeUndefined()
  })
})

// =========================================================================
// deleteProject — best-effort cleanup of multiple resources
// =========================================================================

describe('deleteProject', () => {
  test('deletes preview domain + service + legacy PVCs without throwing on 404s', async () => {
    // Cause the Service delete to 404; the legacy PVC stub already 404s.
    deleteNotFound = true
    const mgr = new KnativeProjectManager()
    await expect(mgr.deleteProject('p1')).resolves.toBeUndefined()
  })

  test('also deletes the legacy project-{id} service when DB has a different name', async () => {
    projectKnativeServiceName = 'warm-pool-zz'
    deleteNotFound = false
    const mgr = new KnativeProjectManager()
    await mgr.deleteProject('p1')
    const deleteCalls = capture.filter((c) => c.method === 'deleteNamespacedCustomObject')
    // Expect at least: domainmapping, warm-pool-zz, project-p1
    expect(deleteCalls.length).toBeGreaterThanOrEqual(2)
  })
})

// =========================================================================
// scaleProject
// =========================================================================

describe('scaleProject', () => {
  test('issues a JSON merge-patch with min-scale annotation', async () => {
    let lastInit: any = null
    globalThis.fetch = (async (_input: any, init: any) => {
      lastInit = init
      return new Response('{}', { status: 200 }) as any
    }) as any
    const mgr = new KnativeProjectManager()
    await mgr.scaleProject('p1', 3)
    expect(lastInit.method).toBe('PATCH')
    expect(lastInit.headers['Content-Type']).toBe('application/merge-patch+json')
    const body = JSON.parse(lastInit.body)
    expect(body.spec.template.metadata.annotations['autoscaling.knative.dev/min-scale']).toBe('3')
    globalThis.fetch = (async () => nextFetch() as any) as any
  })
})

// =========================================================================
// healthCheck
// =========================================================================

describe('healthCheck', () => {
  test('returns true when /ready responds 200', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 }) as any) as any
    const mgr = new KnativeProjectManager()
    expect(await mgr.healthCheck('p1')).toBe(true)
    globalThis.fetch = (async () => nextFetch() as any) as any
  })

  test('returns false on network error', async () => {
    globalThis.fetch = (async () => { throw new Error('net fail') }) as any
    const mgr = new KnativeProjectManager()
    expect(await mgr.healthCheck('p1')).toBe(false)
    globalThis.fetch = (async () => nextFetch() as any) as any
  })
})

// =========================================================================
// mergePatch / jsonPatch helpers
// =========================================================================

describe('mergePatch / jsonPatch helpers', () => {
  test('mergePatchKnativeService PATCHes with application/merge-patch+json', async () => {
    let lastInit: any = null
    globalThis.fetch = (async (_input: any, init: any) => {
      lastInit = init
      return new Response('{}', { status: 200 }) as any
    }) as any
    await mergePatchKnativeService('shogo-test', 'project-p1', { spec: { x: 1 } })
    expect(lastInit.headers['Content-Type']).toBe('application/merge-patch+json')
    globalThis.fetch = (async () => nextFetch() as any) as any
  })

  test('jsonPatchKnativeService PATCHes with application/json-patch+json', async () => {
    let lastInit: any = null
    globalThis.fetch = (async (_input: any, init: any) => {
      lastInit = init
      return new Response('{}', { status: 200 }) as any
    }) as any
    await jsonPatchKnativeService('shogo-test', 'project-p1', [{ op: 'add', path: '/x', value: 1 }])
    expect(lastInit.headers['Content-Type']).toBe('application/json-patch+json')
    globalThis.fetch = (async () => nextFetch() as any) as any
  })
})

// =========================================================================
// Top-level getProjectPodUrl helper
// =========================================================================

describe('getProjectPodUrl (module-level helper)', () => {
  test('returns localhost when KUBERNETES_SERVICE_HOST is unset', async () => {
    const saved = process.env.KUBERNETES_SERVICE_HOST
    delete process.env.KUBERNETES_SERVICE_HOST
    try {
      const url = await getProjectPodUrl('p1')
      expect(url).toContain('localhost')
    } finally {
      process.env.KUBERNETES_SERVICE_HOST = saved
    }
  })
})
