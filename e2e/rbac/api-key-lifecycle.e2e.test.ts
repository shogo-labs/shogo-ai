// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An API key is never stronger than its owner right now: it follows the
 * owner through a project going Restricted, a demotion, and removal.
 *
 *   bun run test:e2e:rbac
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb } from '../../apps/api/src/__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, db, _setRbacModeForTests } = await import('../../apps/api/src/__tests__/helpers/rbac-world')

const app = buildRbacApp()
const suffix = crypto.randomUUID().slice(0, 8)

let owner: string
let dev: string
let devMemberId: string
let workspaceId: string
let openProject: string
let secretProject: string
let key: string

beforeAll(async () => {
  _setRbacModeForTests('on')
  owner = (await db.user.create({ data: { name: 'owner', email: `owner-${suffix}@example.com` } })).id
  dev = (await db.user.create({ data: { name: 'dev', email: `dev-${suffix}@example.com` } })).id
  workspaceId = (await db.workspace.create({ data: { name: 'Keys', slug: `keys-${suffix}`, kind: 'team' } })).id
  await db.member.create({ data: { userId: owner, workspaceId, role: 'owner' } })
  devMemberId = (await db.member.create({ data: { userId: dev, workspaceId, role: 'member' } })).id
  openProject = (await db.project.create({ data: { name: 'Public site', workspaceId, createdBy: owner } })).id
  secretProject = (await db.project.create({ data: { name: 'Roadmap', workspaceId, createdBy: owner } })).id
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

const withKey = (method: string, path: string, body?: unknown) => call(app, { apiKey: key }, method, path, body)

describe('API key lifecycle', () => {
  test('a member creates a key and uses it on open projects', async () => {
    const created = await call(app, { user: dev }, 'POST', '/api/api-keys', { workspaceId, name: 'ci' })
    expect(created.status).toBe(200)
    key = created.body.key

    expect((await withKey('GET', `/api/projects/${secretProject}`)).status).toBe(200)
    expect((await withKey('POST', `/api/projects/${openProject}/chat`, {})).status).toBe(200)
    expect((await withKey('PATCH', `/api/projects/${openProject}`, { description: 'from ci' })).status).toBe(200)
    expect((await withKey('PUT', `/api/projects/${openProject}/auth-config`, {})).status).toBe(403)
  })

  test('the key loses a project the moment it becomes Restricted', async () => {
    expect((await call(app, { user: owner }, 'PATCH', `/api/projects/${secretProject}/visibility`, { visibility: 'restricted' })).status).toBe(200)
    expect((await withKey('GET', `/api/projects/${secretProject}`)).status).toBe(404)
    const list = await withKey('GET', `/api/projects?workspaceId=${workspaceId}`)
    expect(list.body.items.map((p: any) => p.id)).toEqual([openProject])
  })

  test('demoting the owner to viewer makes the key read-only', async () => {
    expect((await call(app, { user: owner }, 'PATCH', `/api/members/${devMemberId}`, { role: 'viewer' })).status).toBe(200)
    expect((await withKey('GET', `/api/projects/${openProject}`)).status).toBe(200)
    expect((await withKey('POST', `/api/projects/${openProject}/chat`, {})).status).toBe(403)
    expect((await withKey('PATCH', `/api/projects/${openProject}`, { description: 'nope' })).status).toBe(403)
  })

  test('removing the owner kills the key', async () => {
    expect((await call(app, { user: owner }, 'DELETE', `/api/members/${devMemberId}`)).status).toBe(200)
    expect((await withKey('GET', `/api/projects/${openProject}`)).status).toBe(403)
    const list = await withKey('GET', `/api/projects?workspaceId=${workspaceId}`)
    expect(list.status === 403 || list.body.items.length === 0).toBe(true)
  })

  test('the workspace owner still sees and can revoke the departed member key', async () => {
    const keys = await call(app, { user: owner }, 'GET', `/api/api-keys?workspaceId=${workspaceId}`)
    const devKey = keys.body.keys.find((k: any) => k.userId === dev)
    expect(devKey).toBeTruthy()
    expect((await call(app, { user: owner }, 'DELETE', `/api/api-keys/${devKey.id}`)).status).toBe(200)
  })
})
