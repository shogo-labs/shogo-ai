// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime-token auth middleware tests
 *
 * Covers `authMiddleware`, `authorizeProject`, `requireProjectAccess`
 * for the new `via: 'runtimeToken'` path.
 *
 * Run: bun test apps/api/src/__tests__/auth-runtime-token.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const mockPrisma = {
  project: {
    findUnique: mock((_args: any) => Promise.resolve(null as any)),
  },
  user: {
    findUnique: mock((_args: any) => Promise.resolve(null as any)),
  },
  member: {
    findFirst: mock((_args: any) => Promise.resolve(null as any)),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../auth', () => ({
  auth: {
    api: {
      getSession: mock(() => Promise.resolve(null)),
    },
  },
}))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(() => Promise.resolve(null)),
}))

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'

const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware, authorizeProject, requireProjectAccess } = await import(
  '../middleware/auth'
)

type AuthCtx = any
function makeCtx(opts: {
  headers?: Record<string, string>
  query?: Record<string, string>
  params?: Record<string, string>
  url?: string
}): { c: any; stored: { auth?: AuthCtx }; calledNext: { called: boolean } } {
  const stored: { auth?: AuthCtx } = {}
  const calledNext = { called: false }
  const headers = opts.headers ?? {}
  const query = opts.query ?? {}
  const params = opts.params ?? {}
  const url = opts.url ?? 'http://localhost/api/voice/signed-url'
  let jsonBody: any = undefined
  let jsonStatus: number | undefined = undefined
  const c: any = {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      query: (name: string) => query[name],
      param: (name: string) => params[name],
      url,
      raw: { headers: new Headers() },
    },
    set: (key: string, val: AuthCtx) => {
      if (key === 'auth') stored.auth = val
    },
    get: (key: string) => (key === 'auth' ? stored.auth : undefined),
    json: (body: any, status?: number) => {
      jsonBody = body
      jsonStatus = status
      return { body, status }
    },
    _response: () => ({ body: jsonBody, status: jsonStatus }),
  }
  return { c, stored, calledNext }
}

beforeEach(() => {
  mockPrisma.project.findUnique.mockReset()
  mockPrisma.user.findUnique.mockReset()
  mockPrisma.member.findFirst.mockReset()
})

/**
 * Helper: shape of the `project.findUnique` result expected by the
 * runtime-token branch of `authMiddleware` post the owner-resolution
 * refactor (see apps/api/src/lib/runtime-token.md §3).
 */
function projectWithOwners(opts: {
  workspaceId: string
  projectOwnerUserId?: string
  workspaceOwnerUserId?: string
}) {
  return {
    workspaceId: opts.workspaceId,
    members: opts.projectOwnerUserId
      ? [{ userId: opts.projectOwnerUserId }]
      : [],
    workspace: {
      members: opts.workspaceOwnerUserId
        ? [{ userId: opts.workspaceOwnerUserId }]
        : [],
    },
  }
}

describe('authMiddleware — runtime-token path', () => {
  test('valid x-runtime-token + projectId query → sets via: runtimeToken with real owner userId', async () => {
    const projectId = 'proj_abc'
    const ownerId = 'user_owner_abc'
    const token = deriveRuntimeToken(projectId)
    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve(
        projectWithOwners({ workspaceId: 'ws_1', projectOwnerUserId: ownerId }),
      ),
    )

    const { c, stored, calledNext } = makeCtx({
      headers: { 'x-runtime-token': token },
      query: { projectId },
    })
    await authMiddleware(c, async () => {
      calledNext.called = true
    })

    expect(calledNext.called).toBe(true)
    expect(stored.auth?.isAuthenticated).toBe(true)
    expect(stored.auth?.via).toBe('runtimeToken')
    expect(stored.auth?.projectId).toBe(projectId)
    expect(stored.auth?.workspaceId).toBe('ws_1')
    // Post the owner-resolution change, userId is a real user row, not
    // a synthetic `runtime:<projectId>` string.
    expect(stored.auth?.userId).toBe(ownerId)
  })

  test('valid token via Authorization: Bearer header also works', async () => {
    const projectId = 'proj_bearer'
    const ownerId = 'user_owner_bearer'
    const token = deriveRuntimeToken(projectId)
    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve(
        projectWithOwners({ workspaceId: 'ws_2', projectOwnerUserId: ownerId }),
      ),
    )

    const { c, stored } = makeCtx({
      headers: { authorization: `Bearer ${token}` },
      query: { projectId },
    })
    await authMiddleware(c, async () => {})

    expect(stored.auth?.via).toBe('runtimeToken')
    expect(stored.auth?.projectId).toBe(projectId)
    expect(stored.auth?.userId).toBe(ownerId)
  })

  test('Bearer shogo_sk_ is NOT treated as runtime-token', async () => {
    const { c, stored } = makeCtx({
      headers: { authorization: 'Bearer shogo_sk_bogus' },
      query: { projectId: 'any' },
    })
    await authMiddleware(c, async () => {})
    // apiKey path is tried first + returns null → falls through. runtime-token
    // path must NOT try to validate a shogo_sk_* value as a runtime token.
    expect(stored.auth?.via).not.toBe('runtimeToken')
  })

  test('wrong token → does not set runtimeToken auth, falls through', async () => {
    const projectId = 'proj_wrong'
    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve(
        projectWithOwners({
          workspaceId: 'ws_3',
          projectOwnerUserId: 'user_owner_3',
        }),
      ),
    )

    const { c, stored } = makeCtx({
      headers: { 'x-runtime-token': 'deadbeef'.repeat(8) },
      query: { projectId },
    })
    await authMiddleware(c, async () => {})

    expect(stored.auth?.isAuthenticated).toBe(false)
    expect(stored.auth?.via).toBeUndefined()
  })

  test('token present but no projectId → falls through (no runtime auth)', async () => {
    const token = deriveRuntimeToken('some-project')
    const { c, stored } = makeCtx({
      headers: { 'x-runtime-token': token },
      // no projectId query or param
    })
    await authMiddleware(c, async () => {})
    expect(stored.auth?.via).toBeUndefined()
    expect(stored.auth?.isAuthenticated).toBe(false)
  })

  test('valid token but project row missing → falls through', async () => {
    const projectId = 'proj_missing'
    const token = deriveRuntimeToken(projectId)
    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve(null),
    )

    const { c, stored } = makeCtx({
      headers: { 'x-runtime-token': token },
      query: { projectId },
    })
    await authMiddleware(c, async () => {})
    expect(stored.auth?.via).toBeUndefined()
  })

  test('token for project X presented with query projectId=Y → does not authenticate', async () => {
    const x = 'proj_x'
    const y = 'proj_y'
    // tokens differ; attempt validates against Y (the request-scoped id)
    // and fails equality check.
    const token = deriveRuntimeToken(x)

    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve(
        projectWithOwners({
          workspaceId: 'ws_y',
          projectOwnerUserId: 'user_owner_y',
        }),
      ),
    )

    const { c, stored } = makeCtx({
      headers: { 'x-runtime-token': token },
      query: { projectId: y },
    })
    await authMiddleware(c, async () => {})
    expect(stored.auth?.via).toBeUndefined()
  })

  test('falls through to session path when no runtime token present', async () => {
    const { c, stored } = makeCtx({})
    await authMiddleware(c, async () => {})
    // No session either (mocked to null) → isAuthenticated: false
    expect(stored.auth?.isAuthenticated).toBe(false)
  })
})

describe('authorizeProject — runtimeToken branch', () => {
  test('matching projectId → ok', async () => {
    const projectId = 'proj_ok'
    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve({ id: projectId, workspaceId: 'ws_ok' }),
    )

    const { c, stored } = makeCtx({})
    stored.auth = {
      isAuthenticated: true,
      userId: 'user_owner_ok',
      workspaceId: 'ws_ok',
      projectId,
      via: 'runtimeToken',
    }
    const result = await authorizeProject(c, projectId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.projectId).toBe(projectId)
      expect(result.workspaceId).toBe('ws_ok')
    }
  })

  test('mismatched projectId → 403 forbidden with scope mismatch code', async () => {
    const tokenProject = 'proj_a'
    const requestedProject = 'proj_b'
    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve({ id: requestedProject, workspaceId: 'ws_b' }),
    )

    const { c, stored } = makeCtx({})
    stored.auth = {
      isAuthenticated: true,
      userId: 'user_owner_a',
      workspaceId: 'ws_a',
      projectId: tokenProject,
      via: 'runtimeToken',
    }
    const result = await authorizeProject(c, requestedProject)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.code).toBe('forbidden')
      expect(result.message.toLowerCase()).toContain('runtime token')
    }
  })

  test('runtime-token caller does NOT hit prisma.user.findUnique', async () => {
    const projectId = 'proj_no_user_lookup'
    mockPrisma.project.findUnique.mockImplementation(() =>
      Promise.resolve({ id: projectId, workspaceId: 'ws_1' }),
    )

    const { c, stored } = makeCtx({})
    stored.auth = {
      isAuthenticated: true,
      userId: 'user_owner_no_lookup',
      workspaceId: 'ws_1',
      projectId,
      via: 'runtimeToken',
    }
    await authorizeProject(c, projectId)

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.member.findFirst).not.toHaveBeenCalled()
  })
})

describe('requireProjectAccess — runtimeToken branch', () => {
  test('matching projectId → calls next()', async () => {
    const projectId = 'proj_access_ok'
    let nextCalled = false
    const { c, stored } = makeCtx({ params: { projectId } })
    stored.auth = {
      isAuthenticated: true,
      userId: 'user_owner_access_ok',
      workspaceId: 'ws_1',
      projectId,
      via: 'runtimeToken',
    }
    await requireProjectAccess(c, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
  })

  test('mismatched projectId → 403, no next()', async () => {
    let nextCalled = false
    const { c, stored } = makeCtx({ params: { projectId: 'proj_wrong' } })
    stored.auth = {
      isAuthenticated: true,
      userId: 'user_owner_right',
      workspaceId: 'ws_1',
      projectId: 'proj_right',
      via: 'runtimeToken',
    }
    await requireProjectAccess(c, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(false)
    const resp = (c as any)._response()
    expect(resp.status).toBe(403)
  })
})
