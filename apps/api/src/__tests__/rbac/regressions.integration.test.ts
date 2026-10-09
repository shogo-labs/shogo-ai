// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pinned behaviors: the invite-links listing no longer leaks to non-members,
 * and, under the default (shadow) mode, viewer write paths that work today
 * keep working until enforcement is switched on.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db, _setRbacModeForTests } = await import('../helpers/rbac-world')
const { getRbacMode } = await import('../../lib/authz')
type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
const app = buildRbacApp()
const as = (id: string) => ({ user: id })

beforeAll(async () => {
  _setRbacModeForTests(null)
  delete process.env.RBAC_ENFORCE
  w = await seedRbacWorld()
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('invite links listing', () => {
  test('non-members and plain members cannot list a workspace or project link set', async () => {
    await call(app, as(w.users.owner), 'POST', '/api/invite-links', { workspaceId: w.workspaceA, role: 'member' })
    await call(app, as(w.users.owner), 'POST', '/api/invite-links', { projectId: w.projects.open, role: 'viewer' })
    for (const who of [w.users.outsider, w.users.ownerB, w.users.viewer, w.users.member]) {
      expect((await call(app, as(who), 'GET', `/api/invite-links?workspaceId=${w.workspaceA}`)).status).toBe(403)
      expect((await call(app, as(who), 'GET', `/api/invite-links?projectId=${w.projects.open}`)).status).toBe(403)
    }
    const owner = await call(app, as(w.users.owner), 'GET', `/api/invite-links?workspaceId=${w.workspaceA}`)
    expect(owner.body.items.every((l: any) => l.projectId === null)).toBe(true)
  })

  test('toggling or deleting a link requires managing its scope', async () => {
    const link = await call(app, as(w.users.owner), 'POST', '/api/invite-links', { workspaceId: w.workspaceA, role: 'viewer' })
    const id = link.body.data.id
    expect((await call(app, as(w.users.member), 'PATCH', `/api/invite-links/${id}`, { enabled: false })).status).toBe(403)
    expect((await call(app, as(w.users.outsider), 'DELETE', `/api/invite-links/${id}`)).status).toBe(403)
    expect((await call(app, as(w.users.admin), 'PATCH', `/api/invite-links/${id}`, { enabled: false })).status).toBe(200)
    expect((await call(app, as(w.users.admin), 'DELETE', `/api/invite-links/${id}`)).status).toBe(200)
  })

  test('errors use the { error: { code, message } } envelope', async () => {
    const missing = await call(app, as(w.users.owner), 'POST', '/api/invite-links', { role: 'member' })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toEqual({ code: 'bad_request', message: 'projectId or workspaceId required' })

    const badRole = await call(app, as(w.users.owner), 'POST', '/api/invite-links', { workspaceId: w.workspaceA, role: 'owner' })
    expect(badRole.status).toBe(400)
    expect(badRole.body.error.code).toBe('bad_request')

    const denied = await call(app, as(w.users.member), 'GET', `/api/invite-links?workspaceId=${w.workspaceA}`)
    expect(denied.body.error.code).toBe('forbidden')

    const notFound = await call(app, as(w.users.owner), 'PATCH', '/api/invite-links/nope', { enabled: false })
    expect(notFound.status).toBe(404)
    expect(notFound.body.error.code).toBe('not_found')

    const link = await call(app, as(w.users.owner), 'POST', '/api/invite-links', { workspaceId: w.workspaceA, role: 'viewer' })
    const badPatch = await call(app, as(w.users.owner), 'PATCH', `/api/invite-links/${link.body.data.id}`, { enabled: 'no' })
    expect(badPatch.status).toBe(400)
    expect(badPatch.body.error).toEqual({ code: 'bad_request', message: 'enabled (boolean) required' })
  })
})

describe('rbac request bodies are validated', () => {
  test('visibility and member bodies reject bad input with bad_request', async () => {
    const base = `/api/projects/${w.projects.open}`
    const cases: Array<[string, string, unknown, string]> = [
      ['PATCH', `${base}/visibility`, { visibility: 'secret' }, "visibility must be 'workspace' or 'restricted'"],
      ['POST', `${base}/members`, { email: 'a@example.com', role: 'god' }, 'role must be admin, member or viewer'],
      ['POST', `${base}/members`, { role: 'viewer' }, 'userId or email is required'],
      ['POST', `${base}/members`, { userId: 42 }, ''],
    ]
    for (const [method, path, body, message] of cases) {
      const res = await call(app, as(w.users.owner), method, path, body)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
      if (message) expect(res.body.error.message).toBe(message)
    }
  })
})

describe('default mode keeps viewer write paths working', () => {
  test('mode defaults to shadow', async () => {
    expect(await getRbacMode()).toBe('shadow')
  })

  const paths: Array<[string, string, string]> = [
    ['chat', 'POST', '/chat'],
    ['files', 'PUT', '/files/src/App.tsx'],
    ['git push', 'POST', '/git/git-receive-pack'],
    ['checkpoints', 'POST', '/checkpoints'],
    ['export', 'POST', '/export'],
  ]
  for (const [name, method, sub] of paths) {
    test(`viewer ${name}`, async () => {
      expect((await call(app, as(w.users.viewer), method, `/api/projects/${w.projects.open}${sub}`, {})).status).toBe(200)
    })
  }

  test('viewer project update', async () => {
    expect((await call(app, as(w.users.viewer), 'PATCH', `/api/projects/${w.projects.open}`, { description: 'v' })).status).toBe(200)
  })

  test('viewer folders', async () => {
    const res = await call(app, as(w.users.viewer), 'POST', '/api/folders', { name: 'Viewer folder', workspaceId: w.workspaceA })
    expect(res.status).toBe(201)
  })
})

describe('project existence does not leak', () => {
  test('an outsider gets the same 404 for an open project as for a missing one', async () => {
    const missing = await call(app, as(w.users.outsider), 'GET', `/api/projects/${crypto.randomUUID()}`)
    const open = await call(app, as(w.users.outsider), 'GET', `/api/projects/${w.projects.open}`)
    expect(open.status).toBe(404)
    expect(open).toEqual(missing)

    const missingSub = await call(app, as(w.users.outsider), 'POST', `/api/projects/${crypto.randomUUID()}/chat`, {})
    const openSub = await call(app, as(w.users.outsider), 'POST', `/api/projects/${w.projects.open}/chat`, {})
    expect(openSub.status).toBe(404)
    expect(openSub).toEqual(missingSub)
  })

  test('an API key from another workspace gets 404, not 403', async () => {
    expect((await call(app, { apiKey: w.keys.ownerB }, 'GET', `/api/projects/${w.projects.open}`)).status).toBe(404)
  })
})

describe('workspace grants', () => {
  test('only super admins can read or create grants through the generated routes', async () => {
    const grant = { workspaceId: w.workspaceA, freeSeats: 50, monthlyIncludedUsd: 1000 }
    for (const who of [w.users.owner, w.users.admin, w.users.member, w.users.outsider]) {
      expect((await call(app, as(who), 'POST', '/api/workspace-grants', grant)).status).toBe(403)
      expect((await call(app, as(who), 'GET', `/api/workspace-grants?workspaceId=${w.workspaceA}`)).status).toBe(403)
    }
    expect((await call(app, null, 'GET', '/api/workspace-grants')).status).toBe(401)

    const created = await call(app, as(w.users.superAdmin), 'POST', '/api/workspace-grants', grant)
    expect(created.status).toBe(201)
    expect((await call(app, as(w.users.superAdmin), 'GET', `/api/workspace-grants?workspaceId=${w.workspaceA}`)).status).toBe(200)
  })
})
