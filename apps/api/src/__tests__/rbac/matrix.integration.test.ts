// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Endpoint x principal matrix through the real middleware stack and routers,
 * with enforcement on. Expected statuses are written by hand from the role
 * model (never derived from @shogo/authz) so a wrong role map fails here.
 *
 *   bun --no-env-file test src/__tests__/rbac/matrix.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db, _setRbacModeForTests, PROBE } = await import('../helpers/rbac-world')
type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
const app = buildRbacApp()

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

type Who =
  | 'owner' | 'admin' | 'billingAdmin' | 'member' | 'viewer'
  | 'outsider' | 'guestEditor' | 'guestViewer' | 'superAdmin' | 'anon'

const ALL: Who[] = [
  'owner', 'admin', 'billingAdmin', 'member', 'viewer', 'outsider', 'guestEditor', 'guestViewer', 'superAdmin', 'anon',
]

interface Row {
  name: string
  method: string
  path: (w: World) => string
  body?: unknown
  expect: Record<Who, number>
}

function as(who: Who) {
  return who === 'anon' ? null : { user: w.users[who] }
}

const rows: Row[] = [
  // ---- open project ----------------------------------------------------------
  {
    name: 'GET open project',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.open}`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 404, guestEditor: 404, guestViewer: 200, superAdmin: 200, anon: 401 },
  },
  {
    name: 'PATCH open project',
    method: 'PATCH',
    path: (w) => `/api/projects/${w.projects.open}`,
    body: { description: 'edited' },
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'chat send (project:update)',
    method: 'POST',
    path: (w) => `/api/projects/${w.projects.open}/chat`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'files write (project:update)',
    method: 'PUT',
    path: (w) => `/api/projects/${w.projects.open}/files/src/App.tsx`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'git push (project:update)',
    method: 'POST',
    path: (w) => `/api/projects/${w.projects.open}/git/git-receive-pack`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'git fetch (project:read)',
    method: 'POST',
    path: (w) => `/api/projects/${w.projects.open}/git/git-upload-pack`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 404, guestEditor: 404, guestViewer: 200, superAdmin: 200, anon: 401 },
  },
  {
    name: 'checkpoint create (project:update)',
    method: 'POST',
    path: (w) => `/api/projects/${w.projects.open}/checkpoints`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'publish (project:publish)',
    method: 'POST',
    path: (w) => `/api/projects/${w.projects.open}/publish`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'export (project:export)',
    method: 'POST',
    path: (w) => `/api/projects/${w.projects.open}/export`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'auth-config (project.settings:manage)',
    method: 'PUT',
    path: (w) => `/api/projects/${w.projects.open}/auth-config`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 403, member: 403, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'preview (project:read)',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.open}/preview/index.html`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 404, guestEditor: 404, guestViewer: 200, superAdmin: 200, anon: 401 },
  },
  {
    name: 'project permissions (project:read)',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.open}/permissions`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 404, guestEditor: 404, guestViewer: 200, superAdmin: 200, anon: 401 },
  },
  {
    name: 'project members list (project.members:manage)',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.open}/members`,
    expect: { owner: 200, admin: 200, billingAdmin: 403, member: 403, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'visibility (project.members:manage; invalid body => 400 once authorized)',
    method: 'PATCH',
    path: (w) => `/api/projects/${w.projects.open}/visibility`,
    body: { visibility: 'bogus' },
    expect: { owner: 400, admin: 400, billingAdmin: 403, member: 403, viewer: 403, outsider: 404, guestEditor: 404, guestViewer: 403, superAdmin: 400, anon: 401 },
  },

  // ---- restricted project (member is project admin, guestEditor is project editor) ----
  {
    name: 'GET restricted project',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.restricted}`,
    expect: { owner: 200, admin: 200, billingAdmin: 404, member: 200, viewer: 404, outsider: 404, guestEditor: 200, guestViewer: 404, superAdmin: 200, anon: 401 },
  },
  {
    name: 'PATCH restricted project',
    method: 'PATCH',
    path: (w) => `/api/projects/${w.projects.restricted}`,
    body: { description: 'edited' },
    expect: { owner: 200, admin: 200, billingAdmin: 404, member: 200, viewer: 404, outsider: 404, guestEditor: 200, guestViewer: 404, superAdmin: 200, anon: 401 },
  },
  {
    name: 'chat on restricted project',
    method: 'POST',
    path: (w) => `/api/projects/${w.projects.restricted}/chat`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 404, member: 200, viewer: 404, outsider: 404, guestEditor: 200, guestViewer: 404, superAdmin: 200, anon: 401 },
  },
  {
    name: 'settings on restricted project (project admin may)',
    method: 'PUT',
    path: (w) => `/api/projects/${w.projects.restricted}/auth-config`,
    body: {},
    expect: { owner: 200, admin: 200, billingAdmin: 404, member: 200, viewer: 404, outsider: 404, guestEditor: 403, guestViewer: 404, superAdmin: 200, anon: 401 },
  },
  {
    name: 'members of restricted project',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.restricted}/members`,
    expect: { owner: 200, admin: 200, billingAdmin: 404, member: 200, viewer: 404, outsider: 404, guestEditor: 403, guestViewer: 404, superAdmin: 200, anon: 401 },
  },
  {
    name: 'GET second restricted project (no project rows)',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.restricted2}`,
    expect: { owner: 200, admin: 200, billingAdmin: 404, member: 404, viewer: 404, outsider: 404, guestEditor: 404, guestViewer: 404, superAdmin: 200, anon: 401 },
  },

  // ---- cross tenant ----------------------------------------------------------
  {
    name: 'GET foreign workspace project',
    method: 'GET',
    path: (w) => `/api/projects/${w.projects.foreign}`,
    expect: { owner: 404, admin: 404, billingAdmin: 404, member: 404, viewer: 404, outsider: 200, guestEditor: 404, guestViewer: 404, superAdmin: 200, anon: 401 },
  },

  // ---- workspace -------------------------------------------------------------
  {
    name: 'GET workspace',
    method: 'GET',
    path: (w) => `/api/workspaces/${w.workspaceA}`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 403, guestEditor: 403, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'PATCH workspace (workspace:update)',
    method: 'PATCH',
    path: (w) => `/api/workspaces/${w.workspaceA}`,
    body: { description: 'edited' },
    expect: { owner: 200, admin: 200, billingAdmin: 403, member: 403, viewer: 403, outsider: 403, guestEditor: 403, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'workspace permissions',
    method: 'GET',
    path: (w) => `/api/workspaces/${w.workspaceA}/permissions`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 403, guestEditor: 403, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'list workspace members (workspace.members:read)',
    method: 'GET',
    path: (w) => `/api/members?workspaceId=${w.workspaceA}`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 403, guestEditor: 403, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'list invite links (workspace.members:manage)',
    method: 'GET',
    path: (w) => `/api/invite-links?workspaceId=${w.workspaceA}`,
    expect: { owner: 200, admin: 200, billingAdmin: 403, member: 403, viewer: 403, outsider: 403, guestEditor: 403, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'list API keys (workspace:read; filtered per caller)',
    method: 'GET',
    path: (w) => `/api/api-keys?workspaceId=${w.workspaceA}`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 403, guestEditor: 403, guestViewer: 403, superAdmin: 200, anon: 401 },
  },
  {
    name: 'list projects in workspace',
    method: 'GET',
    path: (w) => `/api/projects?workspaceId=${w.workspaceA}`,
    expect: { owner: 200, admin: 200, billingAdmin: 200, member: 200, viewer: 200, outsider: 403, guestEditor: 200, guestViewer: 200, superAdmin: 200, anon: 401 },
  },
]

describe('RBAC matrix (enforcement on)', () => {
  for (const row of rows) {
    test(row.name, async () => {
      const got: Record<string, number> = {}
      for (const who of ALL) {
        const res = await call(app, as(who), row.method, row.path(w), row.body)
        got[who] = res.status
      }
      expect(got).toEqual(row.expect)
    })
  }

  test('probe routes are reached only when authorized', async () => {
    const res = await call(app, as('member'), 'POST', `/api/projects/${w.projects.open}/chat`, {})
    expect(res.body.probe).toBe(PROBE)
  })
})

describe('list contents', () => {
  const names = async (who: Who, qs = `?workspaceId=${w.workspaceA}`) => {
    const res = await call(app, as(who), 'GET', `/api/projects${qs}`)
    return (res.body.items ?? []).map((p: any) => p.name).sort()
  }

  test('restricted projects only appear for those with access', async () => {
    expect(await names('owner')).toEqual(['Open', 'Restricted', 'Restricted Two'])
    expect(await names('admin')).toEqual(['Open', 'Restricted', 'Restricted Two'])
    expect(await names('member')).toEqual(['Open', 'Restricted'])
    expect(await names('viewer')).toEqual(['Open'])
    expect(await names('billingAdmin')).toEqual(['Open'])
    expect(await names('guestEditor')).toEqual(['Restricted'])
    expect(await names('guestViewer')).toEqual(['Open'])
    expect(await names('superAdmin')).toEqual(['Open', 'Restricted', 'Restricted Two'])
  })

  test('unscoped list is personal and never leaks other workspaces', async () => {
    expect(await names('guestEditor', '')).toEqual(['Restricted'])
    expect(await names('outsider', '')).toEqual(['Foreign'])
    expect(await names('viewer', '')).toEqual(['Open'])
  })

  test('project payloads carry myPermissions', async () => {
    const res = await call(app, as('viewer'), 'GET', `/api/projects?workspaceId=${w.workspaceA}`)
    expect(res.body.items[0].myPermissions).toEqual(['project:read'])
    const one = await call(app, as('member'), 'GET', `/api/projects/${w.projects.restricted}`)
    expect(one.body.data.myPermissions).toEqual(
      expect.arrayContaining(['project:read', 'project:update', 'project.members:manage', 'project.settings:manage']),
    )
  })

  test('API keys: members see only their own; admins see all', async () => {
    const mine = await call(app, as('member'), 'GET', `/api/api-keys?workspaceId=${w.workspaceA}`)
    expect(mine.body.keys.map((k: any) => k.userId)).toEqual([w.users.member])
    const all = await call(app, as('admin'), 'GET', `/api/api-keys?workspaceId=${w.workspaceA}`)
    expect(all.body.keys).toHaveLength(4)
  })

  test('workspace permissions payload', async () => {
    const res = await call(app, as('billingAdmin'), 'GET', `/api/workspaces/${w.workspaceA}/permissions`)
    expect(res.body.data.role).toBe('member')
    expect(res.body.data.permissions).toEqual(
      expect.arrayContaining(['workspace:read', 'workspace.billing:manage', 'project:create']),
    )
    expect(res.body.data.permissions).not.toContain('workspace.members:manage')
  })
})
