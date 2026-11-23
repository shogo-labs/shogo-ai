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
  /** The staging environment row, when a test seeds one. */
  stagingRow: null as any,
  markedEnvironments: [] as string[],
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
    publishedEnvironment: {
      // `getEnvironment(projectId, 'staging')` — the internal GET reads this
      // row rather than the project when `?environment=staging` is asked for.
      findUnique: async () => store.stagingRow,
      updateMany: async () => ({ count: 0 }),
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
  // SHO-542: the internal POST shares the async runner with the session route,
  // so it validates and returns `accepted` while the pipeline runs behind it.
  startPublish: async (projectId: string, opts: any) => {
    store.publishCalledWith = { projectId, opts }
    return store.publishResult
  },
  // The GET asks these two about a stale in-flight status; a publish that is
  // not running comes back exactly as stored.
  resolveReportedPublishStatus: (row: any) => ({
    status: row?.publishStatus ?? null,
    interrupted: false,
    error: row?.publishError ?? null,
  }),
  markPublishInterrupted: async (_projectId: string) => {},
  markEnvironmentPublishInterrupted: async (environmentId: string) => {
    store.markedEnvironments.push(environmentId)
  },
  // `publishError` holds `code` or `code: detail`; the real route splits it so
  // clients can compare the code exactly.
  splitPublishError: (stored: string | null | undefined) => {
    if (!stored) return { code: null, detail: null }
    const at = stored.indexOf(': ')
    if (at === -1) return { code: stored, detail: null }
    return { code: stored.slice(0, at), detail: stored.slice(at + 2) || null }
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
    accepted: true,
    publishStatus: 'building',
    url: 'https://my-site.shogo.one',
    subdomain: 'my-site',
    environment: 'production',
  }
  store.publishCalledWith = null
  store.resolvedWorkspaceId = null
  store.stagingRow = null
  store.markedEnvironments = []
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

  test('POST publish: metal-shaped request reaches the shared publish runner', async () => {
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      method: 'POST',
      headers: { 'x-runtime-token': token, ...JSON_H },
      body: JSON.stringify({ subdomain: 'my-site' }),
    })
    // 202: the pipeline runs in the background and the tool follows the GET
    // above for the outcome (SHO-542).
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      ok: true,
      accepted: true,
      status: 'building',
      subdomain: 'my-site',
    })
    expect(store.publishCalledWith).toEqual({
      projectId: PROJECT_ID,
      opts: {
        subdomain: 'my-site',
        accessLevel: undefined,
        password: undefined,
        siteTitle: undefined,
        siteDescription: undefined,
        // SHO-308 §5: the route now always tells the substrate which
        // environment to publish, defaulting to production.
        environment: 'production',
        // §1: false unless the caller asked to accept a destructive schema
        // change, so an unconfirmed drop is refused rather than applied.
        allowDataLoss: false,
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

/**
 * A staging deploy writes only the staging environment row (SHO-308 §8), so a
 * caller following one has to read that row. Reading the project reported
 * production's `live` seconds after the accept and swallowed the staging
 * failure — the tool told the agent staging had shipped when it had not
 * (SHO-542 QA round 1).
 */
describe('internal publish state reads the environment it was asked about', () => {
  /**
   * Derived from the clock, not hard-coded: `resolveReportedPublishStatus`
   * compares `publishStatusAt` to `Date.now()`, so a fixed date means something
   * different every few days (the SHO-505 date bomb), and `check:test-clock`
   * fails the build on one. The rows seeded here are `live` and `failed`, never
   * in flight, so any settled instant behaves the same.
   */
  const SETTLED_AT = new Date(Date.now() - 3 * 24 * 60 * 60_000)

  test('?environment=staging reports the staging row, not production', async () => {
    store.prismaProjectFindUnique = {
      publishedSubdomain: 'my-app',
      publishedAt: SETTLED_AT,
      accessLevel: 'anyone',
      sitePasswordHash: null,
      publishStatus: 'live',
      publishError: null,
      publishStatusAt: SETTLED_AT,
    }
    store.stagingRow = {
      id: 'env-staging',
      projectId: PROJECT_ID,
      name: 'staging',
      subdomain: 'my-app--staging',
      publishStatus: 'failed',
      publishError: 'build_failed',
      publishStatusAt: SETTLED_AT,
    }

    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish?environment=staging`, {
      headers: { 'x-runtime-token': token },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.environment).toBe('staging')
    expect(body.publishStatus).toBe('failed')
    expect(body.publishError).toBe('build_failed')
    expect(body.published).toBe(false)
    expect(body.subdomain).toBe('my-app--staging')
  })

  test('without the query the same project still reports production', async () => {
    store.prismaProjectFindUnique = {
      publishedSubdomain: 'my-app',
      publishedAt: SETTLED_AT,
      accessLevel: 'anyone',
      sitePasswordHash: null,
      publishStatus: 'live',
      publishError: null,
      publishStatusAt: SETTLED_AT,
    }
    store.stagingRow = {
      id: 'env-staging',
      name: 'staging',
      subdomain: 'my-app--staging',
      publishStatus: 'failed',
      publishError: 'build_failed',
    }

    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish`, {
      headers: { 'x-runtime-token': token },
    })

    const body = await res.json()
    expect(body.environment).toBe('production')
    expect(body.publishStatus).toBe('live')
    expect(body.subdomain).toBe('my-app')
  })

  test('a project with no staging environment answers 404 for staging, not production', async () => {
    store.prismaProjectFindUnique = {
      publishedSubdomain: 'my-app',
      publishedAt: null,
      accessLevel: 'anyone',
      sitePasswordHash: null,
      publishStatus: 'live',
    }
    store.stagingRow = null

    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(`/projects/${PROJECT_ID}/publish?environment=staging`, {
      headers: { 'x-runtime-token': token },
    })

    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/staging/i)
  })
})
