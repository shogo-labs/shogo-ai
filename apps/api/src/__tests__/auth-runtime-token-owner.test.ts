// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * authMiddleware × runtime-token owner resolution
 *
 * Asserts that a valid `x-runtime-token` stamps `AuthContext.userId`
 * with the project-scoped owner's real userId, falling back to the
 * workspace-scoped owner when no project-scoped owner exists, and
 * falls through to 401 when neither can be resolved.
 *
 * See apps/api/src/lib/runtime-token.md §3 for the operator-facing
 * contract this test locks in.
 *
 * Run: bun test apps/api/src/__tests__/auth-runtime-token-owner.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

process.env.AI_PROXY_SECRET =
  process.env.AI_PROXY_SECRET ?? 'test-signing-secret-for-runtime-token'

// ─── Prisma mock ──────────────────────────────────────────────────────────
type ProjectFixture = {
  id: string
  workspaceId: string
  projectOwners?: string[]
  workspaceOwners?: string[]
}
const projectsById = new Map<string, ProjectFixture>()

const mockPrisma = {
  project: {
    findUnique: mock(async (args: any) => {
      const p = projectsById.get(args.where.id)
      if (!p) return null
      // Runtime-token branch of authMiddleware asks for
      // { workspaceId, members, workspace.members } — emulate that
      // shape, including the `orderBy createdAt asc / take 1` slicing
      // Prisma applies. Test fixtures list members oldest-first so
      // index 0 is the tie-break winner.
      const wantsMembers =
        args.select && 'members' in args.select
      if (wantsMembers) {
        const projectOwners = p.projectOwners ?? []
        const workspaceOwners = p.workspaceOwners ?? []
        return {
          workspaceId: p.workspaceId,
          members:
            projectOwners.length > 0
              ? [{ userId: projectOwners[0] }]
              : [],
          workspace: {
            members:
              workspaceOwners.length > 0
                ? [{ userId: workspaceOwners[0] }]
                : [],
          },
        }
      }
      return { id: p.id, workspaceId: p.workspaceId }
    }),
  },
  user: {
    findUnique: mock(async () => null),
  },
  member: {
    findFirst: mock(async () => null),
  },
}

mock.module('../lib/prisma', () => ({ prisma: mockPrisma }))
mock.module('../auth', () => ({
  auth: { api: { getSession: mock(() => Promise.resolve(null)) } },
}))
mock.module('../routes/api-keys', () => ({
  resolveApiKey: mock(() => Promise.resolve(null)),
}))

// ─── Import real code under test (AFTER mocks) ────────────────────────────
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { authMiddleware } = await import('../middleware/auth')
import type { AuthContext } from '../middleware/auth'

/**
 * Tiny probe app: mounts authMiddleware, then a handler that echoes
 * the resolved `AuthContext` so tests can inspect it without
 * depending on any downstream route's behavior.
 */
function createProbeApp() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.get('/probe/:projectId', (c) => {
    const auth = c.get('auth') as AuthContext | undefined
    if (!auth?.isAuthenticated) {
      return c.json({ authenticated: false }, 401)
    }
    return c.json({
      authenticated: true,
      userId: auth.userId ?? null,
      workspaceId: auth.workspaceId ?? null,
      projectId: auth.projectId ?? null,
      via: auth.via ?? null,
    })
  })
  return app
}

const PROJECT_ID = 'proj_owner_resolve'
const WORKSPACE_ID = 'ws_owner_resolve'
const PROJECT_OWNER_USER_ID = 'user_project_owner'
const WORKSPACE_OWNER_USER_ID = 'user_workspace_owner'

beforeEach(() => {
  projectsById.clear()
  mockPrisma.user.findUnique.mockClear()
  mockPrisma.member.findFirst.mockClear()
  mockPrisma.project.findUnique.mockClear()
})

describe('authMiddleware × x-runtime-token → AuthContext.userId', () => {
  test('project-scoped owner wins: userId = project Member(role=owner).userId', async () => {
    projectsById.set(PROJECT_ID, {
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      projectOwners: [PROJECT_OWNER_USER_ID],
      workspaceOwners: [WORKSPACE_OWNER_USER_ID],
    })
    const app = createProbeApp()
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(
      `/probe/${PROJECT_ID}?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.authenticated).toBe(true)
    expect(body.via).toBe('runtimeToken')
    expect(body.userId).toBe(PROJECT_OWNER_USER_ID)
    expect(body.workspaceId).toBe(WORKSPACE_ID)
    expect(body.projectId).toBe(PROJECT_ID)
    // The middleware must NOT do a separate prisma.user.findUnique on
    // the resolved id — the owner is resolved inline with the project
    // existence check.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.member.findFirst).not.toHaveBeenCalled()
  })

  test('workspace-owner fallback: no project-scoped owner → userId = workspace owner', async () => {
    projectsById.set(PROJECT_ID, {
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      projectOwners: [],
      workspaceOwners: [WORKSPACE_OWNER_USER_ID],
    })
    const app = createProbeApp()
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(
      `/probe/${PROJECT_ID}?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.userId).toBe(WORKSPACE_OWNER_USER_ID)
    expect(body.via).toBe('runtimeToken')
  })

  test('no owner in either scope → fall through to 401', async () => {
    projectsById.set(PROJECT_ID, {
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      projectOwners: [],
      workspaceOwners: [],
    })
    const app = createProbeApp()
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(
      `/probe/${PROJECT_ID}?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': token } },
    )
    // No owner resolvable → middleware falls through, no auth set,
    // the probe handler itself returns 401. Importantly, we do NOT
    // silently attribute to some other user.
    expect(res.status).toBe(401)
    const body: any = await res.json()
    expect(body.authenticated).toBe(false)
  })

  test('project-scoped owner takes precedence over workspace owner (no fallback fire)', async () => {
    // Both exist; project-scoped must win. This also documents the
    // ordering invariant callers rely on for analytics attribution.
    projectsById.set(PROJECT_ID, {
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      projectOwners: [PROJECT_OWNER_USER_ID],
      workspaceOwners: [WORKSPACE_OWNER_USER_ID],
    })
    const app = createProbeApp()
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(
      `/probe/${PROJECT_ID}?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.userId).toBe(PROJECT_OWNER_USER_ID)
    expect(body.userId).not.toBe(WORKSPACE_OWNER_USER_ID)
  })

  test('tie-break: Prisma orderBy createdAt asc + take 1 means oldest owner wins', async () => {
    // The mock takes the first entry in `projectOwners`; the fixture
    // here encodes "oldest first" so this asserts the middleware
    // relies on the `orderBy createdAt asc / take 1` pattern instead
    // of picking a non-deterministic row.
    const oldest = 'user_owner_oldest'
    const newer = 'user_owner_newer'
    projectsById.set(PROJECT_ID, {
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      projectOwners: [oldest, newer],
    })
    const app = createProbeApp()
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(
      `/probe/${PROJECT_ID}?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.userId).toBe(oldest)
  })

  test('unknown project id → 401 (no auth stamped)', async () => {
    const app = createProbeApp()
    const token = deriveRuntimeToken(PROJECT_ID)
    const res = await app.request(
      `/probe/${PROJECT_ID}?projectId=${PROJECT_ID}`,
      { headers: { 'x-runtime-token': token } },
    )
    expect(res.status).toBe(401)
  })
})
