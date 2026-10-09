// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Non-session principals: API keys (capped by their owner's current access,
 * bound to one workspace), runtime tokens (own project only, no admin
 * actions), tunnel callers (unchanged), and super admins (bypass, logged).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db, _setRbacModeForTests } = await import('../helpers/rbac-world')
const { generateApiKey } = await import('../../lib/api-keys-mint')
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

async function keyFor(userId: string, workspaceId: string) {
  const { fullKey, keyHash, keyPrefix } = await generateApiKey()
  const row = await db.apiKey.create({ data: { name: 'k', keyHash, keyPrefix, workspaceId, userId, kind: 'user' } })
  return { key: fullKey, id: row.id }
}

describe('API keys', () => {
  test('a key follows its owner role on every request', async () => {
    const user = await db.user.create({ data: { name: 'keyed', email: `keyed-${crypto.randomUUID().slice(0, 8)}@example.com` } })
    const row = await db.member.create({ data: { userId: user.id, workspaceId: w.workspaceA, role: 'member' } })
    const { key } = await keyFor(user.id, w.workspaceA)
    const patch = () => call(app, { apiKey: key }, 'PATCH', `/api/projects/${w.projects.open}`, { description: 'via key' })

    expect((await patch()).status).toBe(200)
    expect((await call(app, { apiKey: key }, 'POST', `/api/projects/${w.projects.open}/chat`, {})).status).toBe(200)

    await db.member.update({ where: { id: row.id }, data: { role: 'viewer' } })
    expect((await patch()).status).toBe(403)
    expect((await call(app, { apiKey: key }, 'GET', `/api/projects/${w.projects.open}`)).status).toBe(200)

    await db.member.delete({ where: { id: row.id } })
    expect((await call(app, { apiKey: key }, 'GET', `/api/projects/${w.projects.open}`)).status).toBe(404)
  })

  test('a key loses access when its project becomes restricted', async () => {
    const p = await db.project.create({ data: { name: 'Keyed project', workspaceId: w.workspaceA, createdBy: w.users.owner } })
    expect((await call(app, { apiKey: w.keys.member }, 'GET', `/api/projects/${p.id}`)).status).toBe(200)
    await db.project.update({ where: { id: p.id }, data: { visibility: 'restricted' } })
    expect((await call(app, { apiKey: w.keys.member }, 'GET', `/api/projects/${p.id}`)).status).toBe(404)
  })

  test('a workspace-B key is rejected in workspace A even though the user could be a member', async () => {
    expect((await call(app, { apiKey: w.keys.ownerB }, 'GET', `/api/projects/${w.projects.open}`)).status).toBe(404)
    expect((await call(app, { apiKey: w.keys.ownerB }, 'POST', `/api/projects/${w.projects.open}/chat`, {})).status).toBe(404)
    expect((await call(app, { apiKey: w.keys.ownerB }, 'GET', `/api/projects/${w.projects.foreign}`)).status).toBe(200)
    const list = await call(app, { apiKey: w.keys.ownerB }, 'GET', '/api/projects')
    expect(list.body.items.map((p: any) => p.id)).toEqual([w.projects.foreign])
  })

  test('members revoke only their own keys; admins may revoke anyone', async () => {
    const adminKey = await keyFor(w.users.admin, w.workspaceA)
    const memberKey = await keyFor(w.users.member, w.workspaceA)
    expect((await call(app, { user: w.users.member }, 'DELETE', `/api/api-keys/${adminKey.id}`)).status).toBe(403)
    expect((await call(app, { user: w.users.member }, 'DELETE', `/api/api-keys/${memberKey.id}`)).status).toBe(200)
    const another = await keyFor(w.users.viewer, w.workspaceA)
    expect((await call(app, { user: w.users.admin }, 'DELETE', `/api/api-keys/${another.id}`)).status).toBe(200)
  })

  test('guests cannot mint keys for the workspace', async () => {
    const res = await call(app, { user: w.users.guestEditor }, 'POST', '/api/api-keys', { workspaceId: w.workspaceA })
    expect(res.status).toBe(403)
  })
})

describe('runtime token', () => {
  test('works on its own project only', async () => {
    const rt = { runtimeToken: w.runtimeToken }
    expect((await call(app, rt, 'GET', `/api/projects/${w.projects.open}`)).status).toBe(200)
    expect((await call(app, rt, 'POST', `/api/projects/${w.projects.open}/chat`, {})).status).toBe(200)
    expect((await call(app, rt, 'POST', `/api/projects/${w.projects.restricted}/chat`, {})).status).toBe(403)
    expect([403, 404]).toContain((await call(app, rt, 'GET', `/api/projects/${w.projects.restricted}`)).status)
  })

  test('cannot manage members, visibility, or settings', async () => {
    const rt = { runtimeToken: w.runtimeToken }
    expect((await call(app, rt, 'GET', `/api/projects/${w.projects.open}/members`)).status).toBe(403)
    expect((await call(app, rt, 'PATCH', `/api/projects/${w.projects.open}/visibility`, { visibility: 'restricted' })).status).toBe(403)
    expect((await call(app, rt, 'PUT', `/api/projects/${w.projects.open}/auth-config`, {})).status).toBe(403)
    expect((await call(app, rt, 'POST', `/api/projects/${w.projects.open}/publish`, {})).status).toBe(403)
    expect((await call(app, rt, 'PATCH', `/api/workspaces/${w.workspaceA}`, { description: 'rt' })).status).toBe(403)
  })
})

describe('tunnel and super admin', () => {
  test('tunnel callers are unchanged (cloud proxy already authorized them)', async () => {
    const tunnel = { tunnelUser: 'cloud-user' }
    expect((await call(app, tunnel, 'GET', `/api/projects/${w.projects.restricted2}`)).status).toBe(200)
    expect((await call(app, tunnel, 'POST', `/api/projects/${w.projects.restricted2}/chat`, {})).status).toBe(200)
  })

  test('super admin bypasses checks and is logged', async () => {
    const info = spyOn(console, 'info')
    try {
      const res = await call(app, { user: w.users.superAdmin }, 'PATCH', `/api/projects/${w.projects.restricted2}`, { description: 'sa' })
      expect(res.status).toBe(200)
      expect(info.mock.calls.some((args) => String(args[0]).includes('super_admin access without membership'))).toBe(true)
    } finally {
      info.mockRestore()
    }
  })
})
