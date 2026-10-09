// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Engine unit tests against an in-memory Prisma stub: access loading and
 * memoization, the listing filter shape, 401/403/404 shaping, enforcement
 * modes, and the project route permission table.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { withPrismaExports } from '../../../__tests__/helpers/prisma-mock-exports'

type MemberRow = { userId: string; workspaceId: string; projectId: string | null; role: string; isBillingAdmin?: boolean }

const state = {
  users: new Map<string, { role: string }>(),
  projects: new Map<string, { id: string; workspaceId: string; visibility: string }>(),
  members: [] as MemberRow[],
}

function matches(row: MemberRow, where: any): boolean {
  if (where.userId && row.userId !== where.userId) return false
  if (where.workspaceId !== undefined) {
    if (typeof where.workspaceId === 'string' && row.workspaceId !== where.workspaceId) return false
    if (where.workspaceId?.in && !where.workspaceId.in.includes(row.workspaceId)) return false
  }
  if ('projectId' in where && where.projectId !== undefined && row.projectId !== where.projectId) return false
  if (where.OR) return where.OR.some((w: any) => matches(row, w))
  return true
}

const memberFindMany = mock(async ({ where }: any) => state.members.filter((r) => matches(r, where)))
const prismaStub = {
  user: { findUnique: mock(async ({ where }: any) => state.users.get(where.id) ?? null) },
  project: { findUnique: mock(async ({ where }: any) => state.projects.get(where.id) ?? null) },
  member: { findMany: memberFindMany },
  platformSetting: { findUnique: mock(async () => null) },
}

mock.module('../../prisma', () => withPrismaExports({ prisma: prismaStub }))

const { loadAccess, accessibleProjects, accessibleProjectsWhere, projectScopeWhere, decide, denial, _setRbacModeForTests } =
  await import('../index')
const { projectRoutePermission, isDeclaredProjectRoute } = await import('../project-routes')

beforeEach(() => {
  state.users = new Map([
    ['owner', { role: 'user' }],
    ['member', { role: 'user' }],
    ['viewer', { role: 'user' }],
    ['guest', { role: 'user' }],
    ['sa', { role: 'super_admin' }],
  ])
  state.projects = new Map([
    ['open', { id: 'open', workspaceId: 'ws', visibility: 'workspace' }],
    ['secret', { id: 'secret', workspaceId: 'ws', visibility: 'restricted' }],
  ])
  state.members = [
    { userId: 'owner', workspaceId: 'ws', projectId: null, role: 'owner' },
    { userId: 'member', workspaceId: 'ws', projectId: null, role: 'member' },
    { userId: 'viewer', workspaceId: 'ws', projectId: null, role: 'viewer' },
    { userId: 'guest', workspaceId: 'ws', projectId: 'open', role: 'member' },
  ]
  memberFindMany.mockClear()
  _setRbacModeForTests('on')
})

const session = (userId: string) => ({ userId, via: 'session' as const })

describe('loadAccess', () => {
  test('memoizes per cache key', async () => {
    const cache = new Map()
    await loadAccess(session('member'), { projectId: 'open' }, cache)
    await loadAccess(session('member'), { projectId: 'open' }, cache)
    expect(memberFindMany).toHaveBeenCalledTimes(1)
    await loadAccess(session('member'), { projectId: 'secret' }, cache)
    expect(memberFindMany).toHaveBeenCalledTimes(2)
  })

  test('a guest row does not count as workspace membership', async () => {
    const ws = await loadAccess(session('guest'), { workspaceId: 'ws' })
    expect(ws.permissions.size).toBe(0)
    expect(ws.legacyAllowed).toBe(false)
    const p = await loadAccess(session('guest'), { projectId: 'open' })
    expect(p.isGuest).toBe(true)
    expect(p.permissions.has('project:update')).toBe(true)
  })

  test('missing project reports exists=false', async () => {
    const a = await loadAccess(session('owner'), { projectId: 'nope' })
    expect(a.exists).toBe(false)
  })

  test('runtime token principals are confined to their project', async () => {
    const rt = { userId: 'owner', via: 'runtimeToken' as const, projectId: 'open', workspaceId: 'ws' }
    const own = await loadAccess(rt, { projectId: 'open' })
    expect([...own.permissions].sort()).toEqual(['project:read', 'project:update'])
    expect((await loadAccess(rt, { projectId: 'secret' })).permissions.size).toBe(0)
  })

  test('API keys only act in their workspace', async () => {
    const key = { userId: 'owner', via: 'apiKey' as const, workspaceId: 'other' }
    expect((await loadAccess(key, { projectId: 'open' })).permissions.size).toBe(0)
  })
})

describe('accessibleProjectsWhere', () => {
  test('owner governs the whole workspace', async () => {
    expect(await accessibleProjectsWhere(session('owner'), 'ws')).toEqual({ AND: [{ workspaceId: 'ws' }, { workspaceId: { in: ['ws'] } }] })
  })

  test('member sees open projects only', async () => {
    expect(await accessibleProjectsWhere(session('member'))).toEqual({ workspaceId: { in: ['ws'] }, visibility: 'workspace' })
  })

  test('guest sees only their projects', async () => {
    expect(await accessibleProjectsWhere(session('guest'), 'ws')).toEqual({ AND: [{ workspaceId: 'ws' }, { id: { in: ['open'] } }] })
  })

  test('no membership yields an empty filter', async () => {
    expect(await accessibleProjectsWhere(session('nobody'), 'ws')).toEqual({ id: { in: [] } })
    expect(await accessibleProjectsWhere({})).toEqual({ id: { in: [] } })
  })

  test('super admin bypasses only for an explicit workspace', async () => {
    expect(await accessibleProjectsWhere(session('sa'), 'ws')).toEqual({ workspaceId: 'ws' })
    expect(await accessibleProjectsWhere(session('sa'))).toEqual({ id: { in: [] } })
  })

  test('tunnel and runtime token shapes', async () => {
    expect(await accessibleProjectsWhere({ via: 'tunnel', userId: 'x' }, 'ws')).toEqual({ workspaceId: 'ws' })
    expect(await accessibleProjectsWhere({ via: 'runtimeToken', userId: 'x', projectId: 'open' })).toEqual({ id: 'open' })
  })
})

describe('accessibleProjects', () => {
  test('says explicitly when nothing or everything is readable', async () => {
    expect(await accessibleProjects(session('nobody'), 'ws')).toEqual({ kind: 'none' })
    expect(await accessibleProjects({})).toEqual({ kind: 'none' })
    expect(await accessibleProjects({ via: 'tunnel', userId: 'x' })).toEqual({ kind: 'all' })
    expect(await accessibleProjects({ via: 'apiKey', userId: 'owner' })).toEqual({ kind: 'none' })
  })

  test('returns a filter otherwise', async () => {
    expect(await accessibleProjects(session('owner'), 'ws')).toEqual({
      kind: 'where',
      where: { AND: [{ workspaceId: 'ws' }, { workspaceId: { in: ['ws'] } }] },
    })
  })

  test('projectScopeWhere maps each kind to a Prisma filter', () => {
    expect(projectScopeWhere({ kind: 'none' })).toEqual({ id: { in: [] } })
    expect(projectScopeWhere({ kind: 'all' })).toEqual({})
    expect(projectScopeWhere({ kind: 'where', where: { id: 'p' } })).toEqual({ id: 'p' })
  })
})

describe('denial shaping', () => {
  test('401 without a user, 404 for restricted or missing projects, 403 otherwise', async () => {
    const anon = await loadAccess({}, { projectId: 'open' })
    expect(denial(anon, 'project:read', {}).status).toBe(401)
    expect(denial(await loadAccess(session('viewer'), { projectId: 'secret' }), 'project:read', session('viewer')).status).toBe(404)
    expect(denial(await loadAccess(session('viewer'), { projectId: 'nope' }), 'project:read', session('viewer')).status).toBe(404)
    expect(denial(await loadAccess(session('viewer'), { projectId: 'open' }), 'project:update', session('viewer')).status).toBe(403)
  })
})

describe('decide', () => {
  test('shadow allows legacy callers and logs', async () => {
    _setRbacModeForTests('shadow')
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const access = await loadAccess(session('viewer'), { projectId: 'open' })
      expect((await decide(access, 'project:update', session('viewer'), 'test')).ok).toBe(true)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('shadow still enforces guests and restricted projects', async () => {
    _setRbacModeForTests('shadow')
    const guest = await loadAccess(session('guest'), { workspaceId: 'ws' })
    expect((await decide(guest, 'workspace:read', session('guest'))).ok).toBe(false)
    const restricted = await loadAccess(session('viewer'), { projectId: 'secret' })
    expect((await decide(restricted, 'project:read', session('viewer'))).ok).toBe(false)
  })

  test('off allows legacy callers silently; on denies', async () => {
    const access = await loadAccess(session('viewer'), { projectId: 'open' })
    _setRbacModeForTests('off')
    expect((await decide(access, 'project:update', session('viewer'))).ok).toBe(true)
    _setRbacModeForTests('on')
    expect((await decide(access, 'project:update', session('viewer'))).ok).toBe(false)
  })
})

describe('project route permissions', () => {
  test.each([
    ['GET', '/files/src/a.ts', 'project:read'],
    ['POST', '/chat', 'project:update'],
    ['POST', '/preview/api/x', 'project:read'],
    ['POST', '/git/git-upload-pack', 'project:read'],
    ['POST', '/git/git-receive-pack', 'project:update'],
    ['POST', '/export', 'project:export'],
    ['POST', '/publish', 'project:publish'],
    ['DELETE', '/domains/d1', 'project:publish'],
    ['PATCH', '/visibility', 'project.members:manage'],
    ['POST', '/members', 'project.members:manage'],
    ['GET', '/members', 'project:read'],
    ['PUT', '/auth-config', 'project.settings:manage'],
    ['POST', '/something-new', 'project:update'],
  ])('%s %s -> %s', (method, path, perm) => {
    expect(projectRoutePermission(method, path)).toBe(perm as any)
  })

  test('declared routes include wildcard coverage', () => {
    expect(isDeclaredProjectRoute('POST', '/chat/stop')).toBe(true)
    expect(isDeclaredProjectRoute('PATCH', '/members/:memberId')).toBe(true)
    expect(isDeclaredProjectRoute('POST', '/brand-new')).toBe(false)
  })
})
