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
