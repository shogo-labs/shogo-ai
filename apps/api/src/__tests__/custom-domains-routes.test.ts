// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Custom-domain routes (SHO-304): one implementation, three entry points.
 *
 * Covers the two non-session entry points the agent and the desktop use:
 *   - `routes/internal.ts` (`/api/internal/projects/:id/domains*`) — runtime
 *     token auth; a token minted for another project must be refused.
 *   - `routes/published-sites.ts` (`/api/published-sites/:id/domains*`) — API
 *     key auth; a missing key reports `cloud_signin_required`, and an
 *     unpublished desktop project reports `not_published`.
 *
 * The domain handlers themselves are mocked so no Cloudflare call is made.
 *
 * Run: bun test apps/api/src/__tests__/custom-domains-routes.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-custom-domains'

const store = {
  priorLocalMode: process.env.SHOGO_LOCAL_MODE,
  podIdentity: null as null | { serviceAccountName: string; namespace: string },
  resolvedWorkspaceId: null as null | string,
  apiKey: null as null | { workspaceId: string; userId: string },
  hostProject: null as any,
  calls: [] as Array<{ fn: string; args: any[] }>,
}

const domainBody = {
  enabled: true,
  fallbackOrigin: 'fallback.shogo.one',
  domains: [{ id: 'd1', hostname: 'example.com', status: 'pending' }],
}

mock.module('../lib/k8s-auth', () => ({
  validatePodToken: async () => store.podIdentity,
}))

mock.module('../lib/project-runtime-token', () => ({
  resolveProjectWorkspaceId: async () => store.resolvedWorkspaceId,
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    project: { findUnique: async () => null, findFirst: async () => null },
    agentConfig: { updateMany: async () => ({ count: 0 }), findUnique: async () => null, update: async () => ({}) },
    projectCheckpoint: { findFirst: async () => null, create: async () => ({ id: 'cp' }) },
  },
}))

mock.module('../lib/api-key-request', () => ({
  resolveApiKeyForRequest: async () => store.apiKey,
}))

mock.module('../services/published-sites.service', () => ({
  getUploadedSiteState: async () => ({ published: true }),
  publishUploadedSite: async () => ({ ok: true }),
  unpublishUploadedSite: async () => ({ ok: true }),
  updateUploadedSiteSettings: async () => ({ ok: true }),
  resolveHostProject: async () => store.hostProject,
}))

mock.module('../routes/publish', () => ({
  listCustomDomains: async (projectId: string) => {
    store.calls.push({ fn: 'list', args: [projectId] })
    return { status: 200, body: domainBody }
  },
  addCustomDomain: async (projectId: string, hostname: string) => {
    store.calls.push({ fn: 'add', args: [projectId, hostname] })
    return { status: 201, body: { domains: [] } }
  },
  verifyCustomDomain: async (projectId: string, domainId: string) => {
    store.calls.push({ fn: 'verify', args: [projectId, domainId] })
    return { status: 200, body: { domains: [] } }
  },
  retriggerCustomDomain: async (projectId: string, domainId: string) => {
    store.calls.push({ fn: 'retrigger', args: [projectId, domainId] })
    return { status: 200, body: { domains: [] } }
  },
  setPrimaryCustomDomain: async (projectId: string, domainId: string) => {
    store.calls.push({ fn: 'make_primary', args: [projectId, domainId] })
    return { status: 200, body: { domains: [] } }
  },
  deleteCustomDomain: async (projectId: string, domainId: string) => {
    store.calls.push({ fn: 'remove', args: [projectId, domainId] })
    return { status: 200, body: { success: true, removedIds: ['d1'] } }
  },
}))

delete process.env.SHOGO_LOCAL_MODE
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const internalApp = (await import('../routes/internal')).default
const publishedSitesApp = (await import('../routes/published-sites')).default()

const PROJECT_ID = 'proj-domains'
const OTHER_PROJECT_ID = 'proj-someone-else'
const JSON_H = { 'content-type': 'application/json' }

beforeEach(() => {
  delete process.env.SHOGO_LOCAL_MODE
  store.podIdentity = null
  store.resolvedWorkspaceId = null
  store.apiKey = null
  store.hostProject = { ok: true, project: { id: 'host-1' } }
  store.calls = []
})

describe('internal (agent) custom-domain routes — runtime token auth', () => {
  test('a runtime token for another project gets 401 and never reaches the handler', async () => {
    const token = deriveRuntimeToken(OTHER_PROJECT_ID)
    const res = await internalApp.request(`/projects/${PROJECT_ID}/domains`, {
      headers: { 'x-runtime-token': token },
    })
    expect(res.status).toBe(401)
    expect(store.calls).toHaveLength(0)
  })

  test('a missing token gets 401', async () => {
    const res = await internalApp.request(`/projects/${PROJECT_ID}/domains`)
    expect(res.status).toBe(401)
    expect(store.calls).toHaveLength(0)
  })

  test('the project\'s own token lists its domains', async () => {
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await internalApp.request(`/projects/${PROJECT_ID}/domains`, {
      headers: { 'x-runtime-token': token },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.enabled).toBe(true)
    expect(body.domains[0].hostname).toBe('example.com')
    expect(store.calls).toEqual([{ fn: 'list', args: [PROJECT_ID] }])
  })

  test('POST domains passes the hostname through', async () => {
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await internalApp.request(`/projects/${PROJECT_ID}/domains`, {
      method: 'POST',
      headers: { 'x-runtime-token': token, ...JSON_H },
      body: JSON.stringify({ hostname: 'example.com' }),
    })
    expect(res.status).toBe(201)
    expect(store.calls).toEqual([{ fn: 'add', args: [PROJECT_ID, 'example.com'] }])
  })

  test('verify / retrigger / primary / delete all route to their handler', async () => {
    const token = deriveRuntimeToken(PROJECT_ID)
    const auth = { 'x-runtime-token': token }

    await internalApp.request(`/projects/${PROJECT_ID}/domains/d1/verify`, { method: 'POST', headers: auth })
    await internalApp.request(`/projects/${PROJECT_ID}/domains/d1/retrigger`, { method: 'POST', headers: auth })
    await internalApp.request(`/projects/${PROJECT_ID}/domains/d1/primary`, { method: 'PATCH', headers: auth })
    await internalApp.request(`/projects/${PROJECT_ID}/domains/d1`, { method: 'DELETE', headers: auth })

    expect(store.calls.map((c) => c.fn)).toEqual(['verify', 'retrigger', 'make_primary', 'remove'])
    for (const call of store.calls) {
      expect(call.args).toEqual([PROJECT_ID, 'd1'])
    }
  })
})

describe('cloud published-sites custom-domain routes — API key auth', () => {
  test('a missing API key gets cloud_signin_required', async () => {
    const res = await publishedSitesApp.request('/published-sites/p1/domains')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('cloud_signin_required')
    expect(store.calls).toHaveLength(0)
  })

  test('an invalid API key also gets cloud_signin_required', async () => {
    store.apiKey = null
    const res = await publishedSitesApp.request('/published-sites/p1/domains', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('cloud_signin_required')
  })

  test('an unpublished desktop project gets not_published', async () => {
    store.apiKey = { workspaceId: 'ws-1', userId: 'u1' }
    store.hostProject = { ok: false, status: 404, code: 'not_published', message: 'This project has not been published yet.' }
    const res = await publishedSitesApp.request('/published-sites/p1/domains', {
      headers: { authorization: 'Bearer good' },
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('not_published')
    expect(store.calls).toHaveLength(0)
  })

  test('a signed-in desktop project proxies to the host project\'s domains', async () => {
    store.apiKey = { workspaceId: 'ws-1', userId: 'u1' }
    const res = await publishedSitesApp.request('/published-sites/p1/domains', {
      headers: { authorization: 'Bearer good' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).domains[0].hostname).toBe('example.com')
    // Domains live on the hidden HOST project, not the desktop's own project.
    expect(store.calls).toEqual([{ fn: 'list', args: ['host-1'] }])
  })

  test('add/verify/remove on the host project', async () => {
    store.apiKey = { workspaceId: 'ws-1', userId: 'u1' }
    const headers = { authorization: 'Bearer good', ...JSON_H }

    await publishedSitesApp.request('/published-sites/p1/domains', {
      method: 'POST', headers, body: JSON.stringify({ hostname: 'example.com' }),
    })
    await publishedSitesApp.request('/published-sites/p1/domains/d1/verify', { method: 'POST', headers })
    await publishedSitesApp.request('/published-sites/p1/domains/d1', { method: 'DELETE', headers })

    expect(store.calls).toEqual([
      { fn: 'add', args: ['host-1', 'example.com'] },
      { fn: 'verify', args: ['host-1', 'd1'] },
      { fn: 'remove', args: ['host-1', 'd1'] },
    ])
  })
})
