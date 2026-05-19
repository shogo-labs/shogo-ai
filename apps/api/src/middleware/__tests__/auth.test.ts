// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/middleware/auth.ts — wave-1.
// Covers every branch of authMiddleware (apiKey / runtimeToken / tunnel /
// session), requireAuth (public-prefix bypass, authError, 401), requireRole,
// requireProjectAccess (tunnel skip, runtime-token scope, super-admin, 404,
// 403, happy path), apiKeyOrSession (401/503/200), and authorizeProject
// (401 / 400 / 404 / apiKey / runtimeToken / tunnel / session-membership).

import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ---------------------------------------------------------------------------
// Mocks for every collaborator imported by auth.ts.
// ---------------------------------------------------------------------------

let resolveApiKeyImpl: (key: string) => Promise<any> = async () => null
let verifyRuntimeTokenImpl: (token: string, fallback?: string) => any = () => ({ ok: false })
let getSessionImpl: (args: any) => Promise<any> = async () => null

let projectFindUniqueImpl: (args: any) => Promise<any> = async () => null
let userFindUniqueImpl: (args: any) => Promise<any> = async () => null
let memberFindFirstImpl: (args: any) => Promise<any> = async () => null

mock.module('../../routes/api-keys', () => ({
  resolveApiKey: (key: string) => resolveApiKeyImpl(key),
}))

mock.module('../../lib/runtime-token', () => ({
  verifyRuntimeToken: (token: string, fallback?: string) => verifyRuntimeTokenImpl(token, fallback),
}))

mock.module('../../auth', () => ({
  auth: {
    api: {
      getSession: (args: any) => getSessionImpl(args),
    },
  },
}))

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: { findUnique: (args: any) => projectFindUniqueImpl(args) },
    user: { findUnique: (args: any) => userFindUniqueImpl(args) },
    member: { findFirst: (args: any) => memberFindFirstImpl(args) },
  },
}))

const {
  authMiddleware,
  requireAuth,
  requireRole,
  requireProjectAccess,
  apiKeyOrSession,
  authorizeProject,
  isProjectReservedTopLevelPath,
  PROJECT_RESERVED_TOP_LEVEL_PATHS,
} = await import('../auth')

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

interface FakeJsonResponse {
  body: any
  status: number
}

function makeContext(opts: {
  headers?: Record<string, string>
  url?: string
  params?: Record<string, string>
  query?: Record<string, string>
  auth?: any
}) {
  const store: Record<string, any> = {}
  if (opts.auth !== undefined) store.auth = opts.auth
  const headers = opts.headers ?? {}
  const params = opts.params ?? {}
  const query = opts.query ?? {}
  const url = opts.url ?? 'http://localhost/api/test'

  const ctx: any = {
    get: (k: string) => store[k],
    set: (k: string, v: any) => {
      store[k] = v
    },
    req: {
      url,
      raw: { headers: new Headers(headers) },
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      param: (name: string) => params[name],
      query: (name: string) => query[name],
      path: new URL(url).pathname,
    },
    json: (body: any, status?: number): FakeJsonResponse => ({
      body,
      status: status ?? 200,
    }),
    _store: store,
  }
  return ctx
}

let nextCalled = 0
const next = async () => {
  nextCalled += 1
}

beforeEach(() => {
  nextCalled = 0
  resolveApiKeyImpl = async () => null
  verifyRuntimeTokenImpl = () => ({ ok: false })
  getSessionImpl = async () => null
  projectFindUniqueImpl = async () => null
  userFindUniqueImpl = async () => null
  memberFindFirstImpl = async () => null
})

// ---------------------------------------------------------------------------
// authMiddleware
// ---------------------------------------------------------------------------

describe('authMiddleware — apiKey path', () => {
  it('sets auth from a valid shogo_sk_ key and calls next', async () => {
    resolveApiKeyImpl = async () => ({ userId: 'u1', workspaceId: 'w1' })
    const c = makeContext({ headers: { authorization: 'Bearer shogo_sk_abc' } })
    await authMiddleware(c, next)
    expect(nextCalled).toBe(1)
    expect(c.get('auth')).toEqual({
      userId: 'u1',
      workspaceId: 'w1',
      isAuthenticated: true,
      via: 'apiKey',
    })
  })

  it('falls through when resolveApiKey returns null', async () => {
    resolveApiKeyImpl = async () => null
    getSessionImpl = async () => null
    const c = makeContext({ headers: { authorization: 'Bearer shogo_sk_invalid' } })
    await authMiddleware(c, next)
    expect(nextCalled).toBe(1)
    expect(c.get('auth')).toEqual({ isAuthenticated: false })
  })

  it('swallows errors from resolveApiKey and falls through', async () => {
    resolveApiKeyImpl = async () => {
      throw new Error('boom')
    }
    const c = makeContext({ headers: { authorization: 'Bearer shogo_sk_x' } })
    await authMiddleware(c, next)
    expect(nextCalled).toBe(1)
    expect(c.get('auth').isAuthenticated).toBe(false)
  })
})

describe('authMiddleware — runtime-token path', () => {
  it('authenticates via x-runtime-token with a project-scoped owner', async () => {
    verifyRuntimeTokenImpl = () => ({ ok: true, projectId: 'p1' })
    projectFindUniqueImpl = async () => ({
      workspaceId: 'w-rt',
      members: [{ userId: 'owner-1' }],
      workspace: { members: [] },
    })
    const c = makeContext({ headers: { 'x-runtime-token': 'rt_v1_xx' } })
    await authMiddleware(c, next)
    expect(nextCalled).toBe(1)
    expect(c.get('auth')).toEqual({
      userId: 'owner-1',
      workspaceId: 'w-rt',
      projectId: 'p1',
      isAuthenticated: true,
      via: 'runtimeToken',
    })
  })

  it('falls back to workspace-scoped owner when no project-scoped owner exists', async () => {
    verifyRuntimeTokenImpl = () => ({ ok: true, projectId: 'p2' })
    projectFindUniqueImpl = async () => ({
      workspaceId: 'w2',
      members: [],
      workspace: { members: [{ userId: 'ws-owner' }] },
    })
    const c = makeContext({ headers: { 'x-runtime-token': 'rt_v1_yy' } })
    await authMiddleware(c, next)
    expect(c.get('auth').userId).toBe('ws-owner')
    expect(c.get('auth').via).toBe('runtimeToken')
  })

  it('treats Authorization: Bearer <token> (non shogo_sk_) as a runtime token', async () => {
    verifyRuntimeTokenImpl = () => ({ ok: true, projectId: 'pX' })
    projectFindUniqueImpl = async () => ({
      workspaceId: 'wX',
      members: [{ userId: 'oX' }],
      workspace: { members: [] },
    })
    const c = makeContext({ headers: { authorization: 'Bearer rt_v1_aaa' } })
    await authMiddleware(c, next)
    expect(c.get('auth').via).toBe('runtimeToken')
    expect(c.get('auth').projectId).toBe('pX')
  })

  it('passes legacy fallback projectId from query string into verifyRuntimeToken', async () => {
    let captured: string | undefined
    verifyRuntimeTokenImpl = (_t, fb) => {
      captured = fb
      return { ok: false }
    }
    getSessionImpl = async () => null
    const c = makeContext({
      headers: { 'x-runtime-token': 'bare-hex' },
      query: { projectId: 'q-pid' },
    })
    await authMiddleware(c, next)
    expect(captured).toBe('q-pid')
  })

  it('passes legacy fallback projectId from route param when query missing', async () => {
    let captured: string | undefined
    verifyRuntimeTokenImpl = (_t, fb) => {
      captured = fb
      return { ok: false }
    }
    const c = makeContext({
      headers: { 'x-runtime-token': 'bare-hex' },
      params: { projectId: 'param-pid' },
    })
    await authMiddleware(c, next)
    expect(captured).toBe('param-pid')
  })

  it('falls through when verifyRuntimeToken returns ok:false', async () => {
    verifyRuntimeTokenImpl = () => ({ ok: false })
    const c = makeContext({ headers: { 'x-runtime-token': 'bad' } })
    await authMiddleware(c, next)
    expect(c.get('auth').isAuthenticated).toBe(false)
  })

  it('falls through when project is not found', async () => {
    verifyRuntimeTokenImpl = () => ({ ok: true, projectId: 'nope' })
    projectFindUniqueImpl = async () => null
    const c = makeContext({ headers: { 'x-runtime-token': 'rt_v1_a' } })
    await authMiddleware(c, next)
    expect(c.get('auth').isAuthenticated).toBe(false)
  })

  it('warns and falls through when project has no resolvable owner', async () => {
    verifyRuntimeTokenImpl = () => ({ ok: true, projectId: 'p3' })
    projectFindUniqueImpl = async () => ({
      workspaceId: 'w3',
      members: [],
      workspace: { members: [] },
    })
    const c = makeContext({ headers: { 'x-runtime-token': 'rt_v1_b' } })
    await authMiddleware(c, next)
    expect(c.get('auth').isAuthenticated).toBe(false)
  })

  it('warns and falls through when verifyRuntimeToken throws', async () => {
    verifyRuntimeTokenImpl = () => {
      throw new Error('missing signing secret')
    }
    const c = makeContext({ headers: { 'x-runtime-token': 'rt_v1_c' } })
    await authMiddleware(c, next)
    expect(c.get('auth').isAuthenticated).toBe(false)
  })

  it('warns and falls through when verifyRuntimeToken throws a non-Error', async () => {
    verifyRuntimeTokenImpl = () => {
      throw 'string error'
    }
    const c = makeContext({ headers: { 'x-runtime-token': 'rt_v1_d' } })
    await authMiddleware(c, next)
    expect(c.get('auth').isAuthenticated).toBe(false)
  })
})

describe('authMiddleware — tunnel path', () => {
  it('sets auth from x-tunnel-auth-user-id with optional headers', async () => {
    const c = makeContext({
      headers: {
        'x-tunnel-auth-user-id': 'tunnel-user',
        'x-tunnel-auth-email': 'u@e.com',
        'x-tunnel-auth-name': 'U',
      },
    })
    await authMiddleware(c, next)
    expect(c.get('auth')).toEqual({
      userId: 'tunnel-user',
      email: 'u@e.com',
      name: 'U',
      isAuthenticated: true,
      tunnelAuthenticated: true,
      via: 'tunnel',
    })
  })

  it('handles missing email/name headers gracefully', async () => {
    const c = makeContext({ headers: { 'x-tunnel-auth-user-id': 'just-id' } })
    await authMiddleware(c, next)
    expect(c.get('auth').email).toBeUndefined()
    expect(c.get('auth').name).toBeUndefined()
    expect(c.get('auth').tunnelAuthenticated).toBe(true)
  })
})

describe('authMiddleware — session path', () => {
  it('sets auth from a Better Auth session', async () => {
    getSessionImpl = async () => ({
      user: { id: 'user-s', email: 's@e.com', name: 'S' },
    })
    const c = makeContext({})
    await authMiddleware(c, next)
    expect(c.get('auth')).toEqual({
      userId: 'user-s',
      email: 's@e.com',
      name: 'S',
      isAuthenticated: true,
      via: 'session',
    })
  })

  it('handles a session user with null name', async () => {
    getSessionImpl = async () => ({
      user: { id: 'u', email: 'e@e.com', name: null },
    })
    const c = makeContext({})
    await authMiddleware(c, next)
    expect(c.get('auth').name).toBeUndefined()
  })

  it('marks not authenticated when no session is returned', async () => {
    getSessionImpl = async () => null
    const c = makeContext({})
    await authMiddleware(c, next)
    expect(c.get('auth')).toEqual({ isAuthenticated: false })
  })

  it('marks authError when getSession throws', async () => {
    getSessionImpl = async () => {
      throw new Error('db down')
    }
    const c = makeContext({})
    await authMiddleware(c, next)
    expect(c.get('auth')).toEqual({ isAuthenticated: false, authError: true })
  })
})

// ---------------------------------------------------------------------------
// requireAuth
// ---------------------------------------------------------------------------

describe('requireAuth', () => {
  it('calls next when authenticated', async () => {
    const c = makeContext({ auth: { isAuthenticated: true, userId: 'u' } })
    const res = await requireAuth(c, next)
    expect(res).toBeUndefined()
    expect(nextCalled).toBe(1)
  })

  it('bypasses 401 for every PUBLIC_PREFIX path', async () => {
    const prefixes = [
      '/api/auth/sign-in',
      '/api/health',
      '/api/version',
      '/api/config',
      '/api/webhooks/stripe',
      '/api/integrations/connect',
      '/api/invite-links/abc',
      '/api/internal/something',
      '/api/local/projects',
      '/api/ai/proxy',
      '/api/tools/list',
      '/api/api-keys/validate',
      '/api/cli/login/start',
    ]
    for (const p of prefixes) {
      const c = makeContext({ url: `http://localhost${p}`, auth: { isAuthenticated: false } })
      const before = nextCalled
      await requireAuth(c, next)
      expect(nextCalled).toBe(before + 1)
    }
  })

  it('returns 503 when authError is set on a non-public path', async () => {
    const c = makeContext({
      url: 'http://localhost/api/projects',
      auth: { isAuthenticated: false, authError: true },
    })
    const res = (await requireAuth(c, next)) as FakeJsonResponse
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('service_unavailable')
  })

  it('returns 401 on a non-public path with no auth set at all', async () => {
    const c = makeContext({ url: 'http://localhost/api/projects' })
    const res = (await requireAuth(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
  })

  it('returns 401 when authenticated flag is true but userId missing', async () => {
    const c = makeContext({
      url: 'http://localhost/api/projects',
      auth: { isAuthenticated: true },
    })
    const res = (await requireAuth(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

describe('requireRole', () => {
  it('returns 401 when not authenticated', async () => {
    const mw = requireRole('admin')
    const c = makeContext({ auth: { isAuthenticated: false } })
    const res = (await mw(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
    expect(nextCalled).toBe(0)
  })

  it('calls next when authenticated (single role)', async () => {
    const mw = requireRole('admin')
    const c = makeContext({ auth: { isAuthenticated: true, userId: 'u' } })
    await mw(c, next)
    expect(nextCalled).toBe(1)
  })

  it('calls next when authenticated (array of roles)', async () => {
    const mw = requireRole(['admin', 'owner'])
    const c = makeContext({ auth: { isAuthenticated: true, userId: 'u' } })
    await mw(c, next)
    expect(nextCalled).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// requireProjectAccess
// ---------------------------------------------------------------------------

describe('requireProjectAccess', () => {
  it('returns 401 with no userId', async () => {
    const c = makeContext({ auth: { isAuthenticated: false } })
    const res = (await requireProjectAccess(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
  })

  it('skips DB checks for tunnel-authenticated callers', async () => {
    const c = makeContext({
      auth: { userId: 'u', tunnelAuthenticated: true },
      params: { projectId: 'p' },
    })
    await requireProjectAccess(c, next)
    expect(nextCalled).toBe(1)
  })

  it('returns 400 when projectId param is missing', async () => {
    const c = makeContext({ auth: { userId: 'u' } })
    const res = (await requireProjectAccess(c, next)) as FakeJsonResponse
    expect(res.status).toBe(400)
  })

  it('allows runtime-token callers when scope matches', async () => {
    const c = makeContext({
      auth: { userId: 'u', via: 'runtimeToken', projectId: 'p1' },
      params: { projectId: 'p1' },
    })
    await requireProjectAccess(c, next)
    expect(nextCalled).toBe(1)
  })

  it('rejects runtime-token callers when scope mismatches (403)', async () => {
    const c = makeContext({
      auth: { userId: 'u', via: 'runtimeToken', projectId: 'p1' },
      params: { projectId: 'p2' },
    })
    const res = (await requireProjectAccess(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('scope mismatch')
  })

  it('lets super_admin users bypass membership checks', async () => {
    userFindUniqueImpl = async () => ({ role: 'super_admin' })
    const c = makeContext({ auth: { userId: 'u' }, params: { projectId: 'p' } })
    await requireProjectAccess(c, next)
    expect(nextCalled).toBe(1)
  })

  it('returns 404 when project does not exist', async () => {
    userFindUniqueImpl = async () => ({ role: 'user' })
    projectFindUniqueImpl = async () => null
    const c = makeContext({ auth: { userId: 'u' }, params: { projectId: 'p' } })
    const res = (await requireProjectAccess(c, next)) as FakeJsonResponse
    expect(res.status).toBe(404)
  })

  it('returns 403 when user is not a workspace member', async () => {
    userFindUniqueImpl = async () => ({ role: 'user' })
    projectFindUniqueImpl = async () => ({ workspaceId: 'w' })
    memberFindFirstImpl = async () => null
    const c = makeContext({ auth: { userId: 'u' }, params: { projectId: 'p' } })
    const res = (await requireProjectAccess(c, next)) as FakeJsonResponse
    expect(res.status).toBe(403)
  })

  it('calls next when user is a workspace member', async () => {
    userFindUniqueImpl = async () => ({ role: 'user' })
    projectFindUniqueImpl = async () => ({ workspaceId: 'w' })
    memberFindFirstImpl = async () => ({ id: 'm' })
    const c = makeContext({ auth: { userId: 'u' }, params: { projectId: 'p' } })
    await requireProjectAccess(c, next)
    expect(nextCalled).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// apiKeyOrSession
// ---------------------------------------------------------------------------

describe('apiKeyOrSession', () => {
  it('returns 503 when authError is set', async () => {
    const c = makeContext({ auth: { isAuthenticated: false, authError: true } })
    const res = (await apiKeyOrSession(c, next)) as FakeJsonResponse
    expect(res.status).toBe(503)
  })

  it('returns 401 when not authenticated', async () => {
    const c = makeContext({ auth: { isAuthenticated: false } })
    const res = (await apiKeyOrSession(c, next)) as FakeJsonResponse
    expect(res.status).toBe(401)
  })

  it('calls next when authenticated', async () => {
    const c = makeContext({ auth: { isAuthenticated: true, userId: 'u' } })
    const res = await apiKeyOrSession(c, next)
    expect(res).toBeUndefined()
    expect(nextCalled).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// authorizeProject
// ---------------------------------------------------------------------------

describe('authorizeProject', () => {
  it('returns 401 when not authenticated', async () => {
    const c = makeContext({ auth: { isAuthenticated: false } })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })

  it('returns 400 when projectId is empty', async () => {
    const c = makeContext({ auth: { isAuthenticated: true, userId: 'u' } })
    const r = await authorizeProject(c, '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it('returns 400 when projectId is not a string', async () => {
    const c = makeContext({ auth: { isAuthenticated: true, userId: 'u' } })
    const r = await authorizeProject(c, 123 as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it('returns 404 when project missing', async () => {
    projectFindUniqueImpl = async () => null
    const c = makeContext({ auth: { isAuthenticated: true, userId: 'u' } })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(404)
  })

  it('apiKey: ok when workspace matches', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w' })
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', via: 'apiKey', workspaceId: 'w' },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.workspaceId).toBe('w')
  })

  it('apiKey: 403 when workspaceId is missing on auth', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w' })
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', via: 'apiKey' },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it('apiKey: 403 when workspaceId mismatches', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w-other' })
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', via: 'apiKey', workspaceId: 'w-mine' },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it('runtimeToken: ok when scope matches', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w' })
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', via: 'runtimeToken', projectId: 'p' },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(true)
  })

  it('runtimeToken: 403 when scope mismatches', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w' })
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', via: 'runtimeToken', projectId: 'other' },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it('tunnel: ok without further DB checks', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w' })
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', tunnelAuthenticated: true },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(true)
  })

  it('session: ok when caller is a workspace member', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w' })
    memberFindFirstImpl = async () => ({ id: 'm' })
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', via: 'session' },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(true)
  })

  it('session: 403 when caller is not a workspace member', async () => {
    projectFindUniqueImpl = async () => ({ id: 'p', workspaceId: 'w' })
    memberFindFirstImpl = async () => null
    const c = makeContext({
      auth: { isAuthenticated: true, userId: 'u', via: 'session' },
    })
    const r = await authorizeProject(c, 'p')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// PROJECT_RESERVED_TOP_LEVEL_PATHS
// ---------------------------------------------------------------------------

describe('PROJECT_RESERVED_TOP_LEVEL_PATHS', () => {
  it('contains the import path', () => {
    expect(PROJECT_RESERVED_TOP_LEVEL_PATHS.has('/api/projects/import')).toBe(true)
  })

  it('isProjectReservedTopLevelPath matches set membership', () => {
    expect(isProjectReservedTopLevelPath('/api/projects/import')).toBe(true)
    expect(isProjectReservedTopLevelPath('/api/projects/abc')).toBe(false)
    expect(isProjectReservedTopLevelPath('/api/something/else')).toBe(false)
  })
})
