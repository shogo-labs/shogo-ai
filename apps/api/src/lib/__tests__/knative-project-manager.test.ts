// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test'

delete (process.env as any).KUBERNETES_SERVICE_HOST
process.env.PREVIEW_BASE_DOMAIN = 'example.com'
process.env.PREVIEW_ENVIRONMENT = 'dev'
process.env.AI_PROXY_SECRET = 'test-signing-secret'

// SDK isn't built on this branch — short-circuit transitive imports.
mock.module('@shogo/shared-runtime', () => ({
  RUNTIME_CONFIG: new Proxy({}, { get: () => () => 'stub' }),
}))

// ---------------------------------------------------------------------------
// Fake K8s client. `CustomObjectsApi` calls are recorded so tests can assert
// exactly which REST verb the manager used, and can be told to throw errors
// shaped like @kubernetes/client-node 1.x's ApiException.
// ---------------------------------------------------------------------------

type ApiCall = { method: string; args: any }
const apiCalls: ApiCall[] = []
let createErrors: any[] = []
let getErrors: any[] = []
let getResult: any = {}

/**
 * An error shaped exactly like client-node 1.x's `ApiException`: the status is
 * on `code`, `body` is the raw JSON *string*, and `message` carries neither the
 * reason nor "already exists" — the 1.x message for an unmodelled status is
 * `HTTP-Code: <n>\nMessage: Unknown API Status Code!\nBody: …`.
 */
function apiException(status: number, reason: string): any {
  const body = JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Failure',
    message: reason === 'AlreadyExists' ? 'already exists' : reason,
    reason,
    code: status,
  })
  const err: any = new Error(
    `HTTP-Code: ${status}\nMessage: Unknown API Status Code!\nBody: ${body}`,
  )
  err.code = status
  err.body = body
  err.headers = {}
  return err
}

const fakeCustomApi = {
  async createNamespacedCustomObject(args: any) {
    apiCalls.push({ method: 'create', args })
    const err = createErrors.shift()
    if (err) throw err
    return {}
  },
  async replaceNamespacedCustomObject(args: any) {
    apiCalls.push({ method: 'replace', args })
    throw new Error('replaceNamespacedCustomObject must not be called — use merge-patch')
  },
  async getNamespacedCustomObject(args: any) {
    apiCalls.push({ method: 'get', args })
    const err = getErrors.shift()
    if (err) throw err
    return getResult
  },
}

class FakeCustomObjectsApi {}
class FakeCoreV1Api {}

class FakeKubeConfig {
  loadFromDefault() {}
  loadFromOptions(_o: any) {}
  makeApiClient(cls: any) {
    if (cls === FakeCustomObjectsApi) return fakeCustomApi
    return new (class {})()
  }
  getCurrentCluster() { return { server: 'https://fake-cluster.example.com' } }
  getCurrentUser() { return { token: 'sa-token' } }
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  CustomObjectsApi: FakeCustomObjectsApi,
  CoreV1Api: FakeCoreV1Api,
  AuthenticationV1Api: class {},
  AppsV1Api: class {},
  V1Job: class {},
  KubernetesObjectApi: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}))

mock.module('fs', () => ({ existsSync: () => false, readFileSync: () => '' }))

let fetchResponses: Array<{ status?: number; ok?: boolean; body?: string }> = []
const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
const origFetch = globalThis.fetch
function installFetch() {
  ;(globalThis as any).fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    const r = fetchResponses.shift() ?? { ok: true, status: 200, body: '' }
    const status = r.status ?? 200
    const ok = r.ok ?? (status >= 200 && status < 300)
    return { ok, status, text: async () => r.body ?? '' } as any
  }) as any
}

const km = await import('../knative-project-manager')

beforeEach(() => {
  fetchResponses = []
  fetchCalls.length = 0
  apiCalls.length = 0
  createErrors = []
  getErrors = []
  getResult = {}
  installFetch()
})
afterEach(() => { ;(globalThis as any).fetch = origFetch })

describe('getPreviewSubdomain / getPreviewUrl (dev environment)', () => {
  it('uses env-prefixed subdomain in non-production', () => {
    expect(km.getPreviewSubdomain('proj-abc')).toBe('proj-abc.preview.dev.example.com')
  })
  it('wraps with https://', () => {
    expect(km.getPreviewUrl('proj-abc')).toBe('https://proj-abc.preview.dev.example.com')
  })
})

describe('getKnativeProjectManager singleton', () => {
  it('returns the same instance across calls', () => {
    const a = km.getKnativeProjectManager()
    const b = km.getKnativeProjectManager()
    expect(a).toBe(b)
  })
})

describe('getProjectPodUrl — local fallback', () => {
  it('returns http://localhost:5200 when not in a K8s pod', async () => {
    delete (process.env as any).KUBERNETES_SERVICE_HOST
    delete (process.env as any).RUNTIME_BASE_PORT
    expect(await km.getProjectPodUrl('p1')).toBe('http://localhost:5200')
  })
  it('honors RUNTIME_BASE_PORT override', async () => {
    delete (process.env as any).KUBERNETES_SERVICE_HOST
    process.env.RUNTIME_BASE_PORT = '4444'
    expect(await km.getProjectPodUrl('p1')).toBe('http://localhost:4444')
    delete (process.env as any).RUNTIME_BASE_PORT
  })
})

describe('mergePatchKnativeService', () => {
  it('issues PATCH with merge-patch content-type and bearer auth', async () => {
    fetchResponses = [{ ok: true, status: 200 }]
    await km.mergePatchKnativeService('ns-1', 'svc-x', { spec: { foo: 'bar' } })
    const c = fetchCalls[0]
    expect(c.url).toContain('/apis/serving.knative.dev/v1/namespaces/ns-1/services/svc-x')
    expect(c.init?.method).toBe('PATCH')
    const headers = c.init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/merge-patch+json')
    expect(headers.Authorization).toBe('Bearer sa-token')
    expect(JSON.parse(String(c.init?.body))).toEqual({ spec: { foo: 'bar' } })
  })
  it('throws on non-2xx', async () => {
    fetchResponses = [{ ok: false, status: 409, body: 'conflict' }]
    await expect(km.mergePatchKnativeService('ns-1', 'svc-x', {})).rejects.toThrow(/409.*conflict/)
  })
})

describe('jsonPatchKnativeService', () => {
  it('returns true on 200', async () => {
    fetchResponses = [{ ok: true, status: 200 }]
    expect(await km.jsonPatchKnativeService('ns', 'svc', [
      { op: 'test', path: '/x', value: 'a' },
      { op: 'replace', path: '/x', value: 'b' },
    ])).toBe(true)
  })
  it('returns false on 422 (failed test op)', async () => {
    fetchResponses = [{ ok: false, status: 422, body: 'test failed' }]
    expect(await km.jsonPatchKnativeService('ns', 'svc', [])).toBe(false)
  })
  it('throws with code=404 when service is gone', async () => {
    fetchResponses = [{ ok: false, status: 404, body: 'not found' }]
    let err: any
    await km.jsonPatchKnativeService('ns', 'svc', []).catch((e) => (err = e))
    expect(err.code).toBe(404)
    expect(err.statusCode).toBe(404)
  })
  it('throws with statusCode on other non-2xx', async () => {
    fetchResponses = [{ ok: false, status: 500, body: 'kaboom' }]
    let err: any
    await km.jsonPatchKnativeService('ns', 'svc', []).catch((e) => (err = e))
    expect(err.statusCode).toBe(500)
    expect(err.code).toBeUndefined()
  })
  it('uses json-patch content type', async () => {
    fetchResponses = [{ ok: true, status: 200 }]
    await km.jsonPatchKnativeService('ns', 'svc', [{ op: 'add', path: '/x', value: 1 }])
    const headers = fetchCalls[0].init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json-patch+json')
  })
})

// ---------------------------------------------------------------------------
// K8s error classification (SHO-350). @kubernetes/client-node 1.x throws
// ApiException: status on `code`, `body` a raw JSON string.
// ---------------------------------------------------------------------------

describe('isK8sAlreadyExists', () => {
  it('matches ApiException.code with a JSON string body', () => {
    expect(km.isK8sAlreadyExists(apiException(409, 'AlreadyExists'))).toBe(true)
  })
  it('matches an object body reason', () => {
    expect(km.isK8sAlreadyExists({ body: { reason: 'AlreadyExists', code: 409 } })).toBe(true)
  })
  it('matches a JSON string body reason even without code', () => {
    expect(km.isK8sAlreadyExists({
      body: JSON.stringify({ kind: 'Status', reason: 'AlreadyExists' }),
    })).toBe(true)
  })
  it('matches err.statusCode and err.response.statusCode', () => {
    expect(km.isK8sAlreadyExists({ statusCode: 409 })).toBe(true)
    expect(km.isK8sAlreadyExists({ response: { statusCode: 409 } })).toBe(true)
  })
  it('is false for a 500 and for a garbage string body', () => {
    expect(km.isK8sAlreadyExists(apiException(500, 'InternalError'))).toBe(false)
    expect(km.isK8sAlreadyExists({ code: 500, body: '<html>502 Bad Gateway</html>' })).toBe(false)
    expect(km.isK8sAlreadyExists(undefined)).toBe(false)
  })
})

describe('isK8sNotFound', () => {
  it('matches ApiException.code with a JSON string body', () => {
    expect(km.isK8sNotFound(apiException(404, 'NotFound'))).toBe(true)
  })
  it('matches an object body code / reason', () => {
    expect(km.isK8sNotFound({ body: { code: 404 } })).toBe(true)
    expect(km.isK8sNotFound({ body: { reason: 'NotFound' } })).toBe(true)
  })
  it('matches err.statusCode and err.response.statusCode', () => {
    expect(km.isK8sNotFound({ statusCode: 404 })).toBe(true)
    expect(km.isK8sNotFound({ response: { statusCode: 404 } })).toBe(true)
  })
  it('is false for other statuses and garbage bodies', () => {
    expect(km.isK8sNotFound(apiException(409, 'AlreadyExists'))).toBe(false)
    expect(km.isK8sNotFound({ body: 'not json at all' })).toBe(false)
    expect(km.isK8sNotFound(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Republish (SHO-350): a second publish must merge-patch the existing ksvc,
// never PUT it without a resourceVersion.
// ---------------------------------------------------------------------------

const NS = process.env.PROJECT_NAMESPACE || 'shogo-workspaces'

function publishedPatches() {
  return fetchCalls.filter((c) => c.init?.method === 'PATCH')
}

describe('createPublishedServerService — republish', () => {
  it('merge-patches the existing ksvc on 409 instead of throwing', async () => {
    createErrors = [apiException(409, 'AlreadyExists')]
    const m = km.getKnativeProjectManager()

    await expect(
      m.createPublishedServerService('p-srv', 'srv', { minScale: 0, maxScale: 1 }),
    ).resolves.toBe(`http://published-p-srv.${NS}.svc.cluster.local`)

    const patches = publishedPatches()
    expect(patches).toHaveLength(1)
    expect(patches[0].url).toContain(`/apis/serving.knative.dev/v1/namespaces/${NS}/services/published-p-srv`)
    expect((patches[0].init?.headers as Record<string, string>)['Content-Type'])
      .toBe('application/merge-patch+json')

    const body = JSON.parse(String(patches[0].init?.body))
    const container = body.spec.template.spec.containers[0]
    expect(typeof container.image).toBe('string')
    expect(container.env.some((e: any) => e.name === 'PROJECT_ID' && e.value === 'p-srv')).toBe(true)
    expect(container.env.some((e: any) => e.name === 'SHOGO_PUBLISHED_MODE' && e.value === 'true')).toBe(true)
    const annotations = body.spec.template.metadata.annotations
    expect(annotations['shogo.io/deploy-timestamp']).toBeTruthy()
    // Every scale annotation a republish can change is written explicitly —
    // merge-patch keeps map keys that are absent.
    expect(annotations['autoscaling.knative.dev/min-scale']).toBe('0')
    expect(annotations['autoscaling.knative.dev/max-scale']).toBe('1')
    expect(body.metadata.labels['shogo.io/component']).toBe('published-server')

    // The broken fallback PUT is gone.
    expect(apiCalls.some((c) => c.method === 'replace')).toBe(false)
  })

  it('requests a new revision on the second publish (fresh deploy-timestamp)', async () => {
    const m = km.getKnativeProjectManager()
    const base = Date.now()

    setSystemTime(new Date(base))
    await m.createPublishedServerService('p-twice', 'twice')
    const created = apiCalls.find((c) => c.method === 'create')!
    const first = created.args.body.spec.template.metadata.annotations['shogo.io/deploy-timestamp']

    setSystemTime(new Date(base + 5_000))
    createErrors = [apiException(409, 'AlreadyExists')]
    await m.createPublishedServerService('p-twice', 'twice')

    const patches = publishedPatches()
    expect(patches).toHaveLength(1)
    const second = JSON.parse(String(patches[0].init?.body))
      .spec.template.metadata.annotations['shogo.io/deploy-timestamp']
    expect(second).not.toBe(first)
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
    setSystemTime()
  })

  it('rethrows a non-409 ApiException and patches nothing', async () => {
    createErrors = [apiException(500, 'InternalError')]
    const m = km.getKnativeProjectManager()

    await expect(m.createPublishedServerService('p-500', 'oops')).rejects.toThrow(/HTTP-Code: 500/)
    expect(publishedPatches()).toHaveLength(0)
    expect(apiCalls.filter((c) => c.method === 'create')).toHaveLength(1)
  })

  it('rethrows when the merge-patch itself fails', async () => {
    createErrors = [apiException(409, 'AlreadyExists')]
    fetchResponses = [{ ok: false, status: 422, body: 'invalid patch' }]
    const m = km.getKnativeProjectManager()

    await expect(m.createPublishedServerService('p-422', 'bad')).rejects.toThrow(/422.*invalid patch/)
  })
})

describe('createPublishedService (static nginx) — republish', () => {
  it('merge-patches the existing ksvc on 409 instead of throwing', async () => {
    createErrors = [apiException(409, 'AlreadyExists')]
    const m = km.getKnativeProjectManager()

    await expect(
      m.createPublishedService('p-static', 'static', { minScale: 0, maxScale: 10 }),
    ).resolves.toBe(`http://published-p-static.${NS}.svc.cluster.local`)

    const patches = publishedPatches()
    expect(patches).toHaveLength(1)
    expect(patches[0].url).toContain(`/services/published-p-static`)
    expect((patches[0].init?.headers as Record<string, string>)['Content-Type'])
      .toBe('application/merge-patch+json')

    const body = JSON.parse(String(patches[0].init?.body))
    expect(body.spec.template.spec.containers[0].image).toBe('nginx:alpine')
    expect(body.spec.template.spec.initContainers[0].name).toBe('s3-sync')
    const annotations = body.spec.template.metadata.annotations
    expect(annotations['shogo.io/deploy-timestamp']).toBeTruthy()
    expect(annotations['autoscaling.knative.dev/max-scale']).toBe('10')
    expect(apiCalls.some((c) => c.method === 'replace')).toBe(false)
  })

  it('rethrows a non-409 ApiException untouched', async () => {
    createErrors = [apiException(500, 'InternalError')]
    const m = km.getKnativeProjectManager()
    await expect(m.createPublishedService('p-static-500', 'x')).rejects.toThrow(/HTTP-Code: 500/)
    expect(publishedPatches()).toHaveLength(0)
  })
})

describe('patchProjectResources — missing service', () => {
  it('returns quietly when the GET throws a 404 ApiException', async () => {
    getErrors = [apiException(404, 'NotFound')]
    const m = km.getKnativeProjectManager()
    await expect(m.patchProjectResources('p-gone', { minScale: 1 })).resolves.toBeUndefined()
    expect(apiCalls.filter((c) => c.method === 'get')).toHaveLength(1)
    expect(apiCalls.some((c) => c.method === 'replace')).toBe(false)
  })
})

