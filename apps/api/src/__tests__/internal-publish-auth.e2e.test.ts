// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E: metal-shaped publish auth against real HMAC runtime tokens.
 *
 * Production metal VMs send `x-runtime-token` with no K8s SA Bearer header
 * and `SHOGO_LOCAL_MODE` is unset. This file does NOT mock `runtime-token.ts`
 * — it mints a real `rt_v1_*` token and hits the internal publish routes.
 *
 * Run: bun test apps/api/src/__tests__/internal-publish-auth.e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token-e2e'
delete process.env.SHOGO_LOCAL_MODE

const store = {
  podIdentity: null as null | { serviceAccountName: string; namespace: string },
  prismaProjectFindUnique: null as any,
  publishResult: null as any,
  publishCalledWith: null as any,
  resolvedWorkspaceId: null as null | string,
}

mock.module('../lib/k8s-auth', () => ({
  validatePodToken: async (_t: string) => store.podIdentity,
}))

mock.module('../lib/project-runtime-token', () => ({
  resolveProjectWorkspaceId: async (_p: string) => store.resolvedWorkspaceId,
}))

mock.module('../lib/k8s-auth', () => ({
  validatePodToken: async (_t: string) => store.podIdentity,
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async () => store.prismaProjectFindUnique,
      findFirst: async () => null,
    },
    agentConfig: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      update: async () => ({}),
    },
    projectCheckpoint: {
      findFirst: async () => null,
      create: async () => ({ id: 'cp' }),
    },
  },
}))

mock.module('../routes/publish', () => ({
  publishProject: async (projectId: string, opts: any) => {
    store.publishCalledWith = { projectId, opts }
    return store.publishResult
  },
}))

const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const app = (await import('../routes/internal')).default

const PROJECT_ID = 'proj-metal-e2e'
const WORKSPACE_ID = 'ws-metal-e2e'
const JSON_H = { 'content-type': 'application/json' }

beforeEach(() => {
  delete process.env.SHOGO_LOCAL_MODE
  store.podIdentity = null
  store.prismaProjectFindUnique = {
    publishedSubdomain: null,
    publishedAt: null,
    accessLevel: 'public',
    sitePasswordHash: null,
    publishStatus: null,
  }
  store.publishResult = {
    ok: true,
    url: 'https://my-site.shogo.one',
    subdomain: 'my-site',
    publishedAt: 1700000000000,
    accessLevel: 'public',
    hasPassword: false,
  }
  store.publishCalledWith = null
  store.resolvedWorkspaceId = null
})

afterEach(() => {
  delete process.env.SHOGO_LOCAL_MODE
})

describe('internal publish auth e2e (real runtime token, production mode)', () => {
  test('GET publish: metal-shaped request (x-runtime-token only) → 200', async () => {
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      headers: { 'x-runtime-token': token },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.published).toBe(false)
  })

  test('POST publish: metal-shaped request reaches publishProject', async () => {
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      method: 'POST',
      headers: { 'x-runtime-token': token, ...JSON_H },
      body: JSON.stringify({ subdomain: 'my-site' }),
    })
    expect(res.status).toBe(200)
    expect(store.publishCalledWith).toEqual({
      projectId: PROJECT_ID,
      opts: {
        subdomain: 'my-site',
        accessLevel: undefined,
        password: undefined,
        siteTitle: undefined,
        siteDescription: undefined,
      },
    })
  })

  test('GET publish: stale SA Bearer + valid runtime token still 200 (Knative fallthrough)', async () => {
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      headers: { Authorization: 'Bearer not-a-real-sa', 'x-runtime-token': token },
    })
    expect(res.status).toBe(200)
  })

  test('GET publish: token for a different project → 401', async () => {
    const token = deriveRuntimeToken('someone-else')
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      headers: { 'x-runtime-token': token },
    })
    expect(res.status).toBe(401)
  })

  test('GET publish: garbage runtime token → 401', async () => {
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      headers: { 'x-runtime-token': 'not-a-token' },
    })
    expect(res.status).toBe(401)
  })

  test('GET publish: no credentials → 401', async () => {
    const res = await app.request(`/projects/${PROJECT_ID}/publish`)
    expect(res.status).toBe(401)
  })

  test('workspace runtime token is accepted when the project belongs to that workspace', async () => {
    store.resolvedWorkspaceId = WORKSPACE_ID
    const token = deriveWorkspaceRuntimeToken(WORKSPACE_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      headers: { 'x-runtime-token': token },
    })
    expect(res.status).toBe(200)
  })

  test('workspace runtime token for a different workspace → 401', async () => {
    store.resolvedWorkspaceId = 'ws-other'
    const token = deriveWorkspaceRuntimeToken(WORKSPACE_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      headers: { 'x-runtime-token': token },
    })
    expect(res.status).toBe(401)
  })
})
