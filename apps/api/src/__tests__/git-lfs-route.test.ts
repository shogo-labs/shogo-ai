// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the Git LFS batch + verify API at `src/routes/git-lfs.ts`.
 *
 * We mock object storage (`../lib/s3`) and auth so the route logic is
 * exercised deterministically without OCI or a real session. Coverage:
 *
 *   - 401 (+ WWW-Authenticate) when unauthenticated
 *   - workingMode='external' → 404
 *   - download: presigned GET for existing, per-object 404 for missing
 *   - upload: presigned PUT + verify for new, no actions (dedup) for existing
 *   - invalid oid / operation → 422
 *   - verify: 200 / 404 / 422 (size mismatch)
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

// ─── @shogo/shared-runtime mock (avoid loading the whole runtime index) ──
mock.module('@shogo/shared-runtime', () => ({
  isValidLfsOid: (oid: string) => /^[0-9a-f]{64}$/.test(oid),
  lfsObjectKey: (projectId: string, oid: string) =>
    `${projectId}/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`,
}))

// ─── prisma mock ─────────────────────────────────────────────────────
const projectFindUnique = mock(async (_: any): Promise<any> => ({
  workingMode: 'cloud',
  workspaceId: 'ws_test',
}))
mock.module('../lib/prisma', () => ({
  prisma: { project: { findUnique: projectFindUnique } },
}))

// ─── auth mock ───────────────────────────────────────────────────────
mock.module('../middleware/auth', () => ({
  authorizeProject: async (c: any, projectId: string) => {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated) return { ok: false, status: 401, code: 'unauthorized', message: 'no auth' }
    return { ok: true, workspaceId: 'ws_test', projectId }
  },
}))

// ─── s3 mock (stores oid→size; controllable per test) ────────────────
const heads = new Map<string, number>()
const headLfsObject = mock(async (key: string): Promise<{ size: number } | null> => {
  const oid = key.split('/').pop()!
  return heads.has(oid) ? { size: heads.get(oid)! } : null
})
mock.module('../lib/s3', () => ({
  headLfsObject,
  getLfsPresignedReadUrl: async (key: string) => `https://oci.example/get/${key}?sig=read`,
  getLfsPresignedWriteUrl: async (key: string) => `https://oci.example/put/${key}?sig=write`,
}))

const { gitLfsRoutes } = await import('../routes/git-lfs')

const OID_A = 'a'.repeat(64)
const OID_B = 'b'.repeat(64)

function makeApp(auth?: { userId: string; isAuthenticated: boolean }) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', (auth ?? { isAuthenticated: false }) as any)
    await next()
  })
  app.route('/api', gitLfsRoutes({ workspacesDir: '/tmp/lfs-ws' }))
  return app
}

function batch(app: Hono, projectId: string, body: unknown) {
  return app.request(`/api/projects/${projectId}/git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.git-lfs+json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  heads.clear()
  projectFindUnique.mockClear()
  projectFindUnique.mockImplementation(async () => ({ workingMode: 'cloud', workspaceId: 'ws_test' }))
  headLfsObject.mockClear()
})

describe('git-lfs batch route — auth', () => {
  it('401 + WWW-Authenticate when unauthenticated', async () => {
    const res = await batch(makeApp(undefined), 'p_abc', { operation: 'download', objects: [{ oid: OID_A, size: 1 }] })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="shogo"')
  })

  it('404 for workingMode=external projects', async () => {
    projectFindUnique.mockImplementation(async () => ({ workingMode: 'external', workspaceId: 'ws_test' }))
    const res = await batch(makeApp({ userId: 'u', isAuthenticated: true }), 'p_ext', {
      operation: 'download', objects: [{ oid: OID_A, size: 1 }],
    })
    expect(res.status).toBe(404)
  })
})

describe('git-lfs batch route — download', () => {
  it('returns a presigned download action for an existing object', async () => {
    heads.set(OID_A, 123)
    const res = await batch(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', {
      operation: 'download', objects: [{ oid: OID_A, size: 123 }],
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/vnd.git-lfs+json')
    const body: any = await res.json()
    expect(body.transfer).toBe('basic')
    expect(body.objects[0].actions.download.href).toContain(`/get/p1/lfs/objects/`)
    expect(body.objects[0].actions.download.expires_in).toBeGreaterThan(0)
  })

  it('returns a per-object 404 error for a missing object', async () => {
    const res = await batch(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', {
      operation: 'download', objects: [{ oid: OID_A, size: 123 }],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.objects[0].error.code).toBe(404)
    expect(body.objects[0].actions).toBeUndefined()
  })
})

describe('git-lfs batch route — upload', () => {
  it('returns upload + verify actions for a new object', async () => {
    const res = await batch(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', {
      operation: 'upload', objects: [{ oid: OID_A, size: 10 }],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.objects[0].actions.upload.href).toContain('/put/p1/lfs/objects/')
    expect(body.objects[0].actions.verify.href).toContain('/git/info/lfs/objects/verify')
  })

  it('omits actions (dedup) when the object already exists', async () => {
    heads.set(OID_B, 10)
    const res = await batch(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', {
      operation: 'upload', objects: [{ oid: OID_B, size: 10 }],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.objects[0].actions).toBeUndefined()
    expect(body.objects[0].authenticated).toBe(true)
  })
})

describe('git-lfs batch route — validation', () => {
  it('422 for an unknown operation', async () => {
    const res = await batch(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', {
      operation: 'sideload', objects: [{ oid: OID_A, size: 1 }],
    })
    expect(res.status).toBe(422)
  })

  it('per-object 422 for a malformed oid', async () => {
    const res = await batch(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', {
      operation: 'download', objects: [{ oid: 'not-a-real-oid', size: 1 }],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.objects[0].error.code).toBe(422)
  })
})

describe('git-lfs verify route', () => {
  function verify(app: Hono, projectId: string, body: unknown) {
    return app.request(`/api/projects/${projectId}/git/info/lfs/objects/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify(body),
    })
  }

  it('200 when the object exists with the expected size', async () => {
    heads.set(OID_A, 42)
    const res = await verify(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', { oid: OID_A, size: 42 })
    expect(res.status).toBe(200)
  })

  it('404 when the object is missing', async () => {
    const res = await verify(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', { oid: OID_A, size: 42 })
    expect(res.status).toBe(404)
  })

  it('422 on size mismatch', async () => {
    heads.set(OID_A, 7)
    const res = await verify(makeApp({ userId: 'u', isAuthenticated: true }), 'p1', { oid: OID_A, size: 42 })
    expect(res.status).toBe(422)
  })
})
