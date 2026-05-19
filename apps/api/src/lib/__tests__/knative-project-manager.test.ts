// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

delete (process.env as any).KUBERNETES_SERVICE_HOST
process.env.PREVIEW_BASE_DOMAIN = 'example.com'
process.env.PREVIEW_ENVIRONMENT = 'dev'

// SDK isn't built on this branch — short-circuit transitive imports.
mock.module('@shogo/shared-runtime', () => ({
  RUNTIME_CONFIG: new Proxy({}, { get: () => () => 'stub' }),
}))

class FakeKubeConfig {
  loadFromDefault() {}
  loadFromOptions(_o: any) {}
  makeApiClient(_cls: any) { return new (class {})() }
  getCurrentCluster() { return { server: 'https://fake-cluster.example.com' } }
  getCurrentUser() { return { token: 'sa-token' } }
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  CustomObjectsApi: class {},
  CoreV1Api: class {},
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
  installFetch()
})
afterEach(() => { ;(globalThis as any).fetch = origFetch })

describe('getPreviewSubdomain / getPreviewUrl (dev environment)', () => {
  it('uses env-prefixed subdomain in non-production', () => {
    expect(km.getPreviewSubdomain('proj-abc')).toBe('preview--proj-abc.dev.example.com')
  })
  it('wraps with https://', () => {
    expect(km.getPreviewUrl('proj-abc')).toBe('https://preview--proj-abc.dev.example.com')
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
