// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Enterprise onboarding, end to end through the real routers and hooks:
 * the owner invites an admin by email, the admin shares a viewer link, the
 * viewer joins read-only, gets promoted, and can then edit. member.joined
 * events carry the right roles.
 *
 *   bun run test:e2e:rbac
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb, waitFor } from '../../apps/api/src/__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, db, _setRbacModeForTests } = await import('../../apps/api/src/__tests__/helpers/rbac-world')

const app = buildRbacApp()
const as = (id: string) => ({ user: id })
const suffix = crypto.randomUUID().slice(0, 8)

async function mkUser(name: string) {
  const email = `${name}-${suffix}@example.com`
  return { id: (await db.user.create({ data: { name, email } })).id, email }
}

let owner: { id: string; email: string }
let admin: { id: string; email: string }
let viewer: { id: string; email: string }
let workspaceId: string
let projectId: string
let viewerMemberId: string

beforeAll(async () => {
  _setRbacModeForTests('on')
  owner = await mkUser('founder')
  admin = await mkUser('ops-lead')
  viewer = await mkUser('auditor')
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('enterprise onboarding', () => {
  test('owner sets up a workspace and creates a project', async () => {
    const ws = await db.workspace.create({ data: { name: `Onboard ${suffix}`, slug: `onboard-${suffix}`, kind: 'team' } })
    workspaceId = ws.id
    await db.member.create({ data: { userId: owner.id, workspaceId, role: 'owner' } })

    const project = await call(app, as(owner.id), 'POST', '/api/projects', { name: 'Handbook', workspaceId })
    expect(project.status).toBe(201)
    projectId = project.body.data.id
  })

  test('owner invites an admin by email; the admin accepts', async () => {
    const invite = await call(app, as(owner.id), 'POST', '/api/invitations', { email: admin.email, workspaceId, role: 'admin' })
    expect(invite.status).toBe(201)

    expect((await call(app, as(admin.id), 'GET', `/api/workspaces/${workspaceId}`)).status).toBe(403)
    expect((await call(app, as(admin.id), 'PATCH', `/api/invitations/${invite.body.data.id}`, { status: 'accepted' })).status).toBe(200)
    const join = await call(app, as(admin.id), 'POST', '/api/members', { userId: admin.id, workspaceId, role: 'owner' })
    expect(join.status).toBe(201)
    expect(join.body.data.role).toBe('admin')

    const perms = await call(app, as(admin.id), 'GET', `/api/workspaces/${workspaceId}/permissions`)
    expect(perms.body.data.role).toBe('admin')
    expect(perms.body.data.permissions).toContain('workspace.members:manage')
    expect(perms.body.data.permissions).not.toContain('workspace:delete')
  })

  test('admin creates a viewer invite link; the viewer joins read-only', async () => {
    const link = await call(app, as(admin.id), 'POST', '/api/invite-links', { workspaceId, role: 'viewer' })
    expect(link.status).toBe(200)
    const accept = await call(app, as(viewer.id), 'POST', `/api/invite-links/${link.body.data.token}/accept`)
    expect(accept.status).toBe(200)
    expect(accept.body.data.role).toBe('viewer')
    viewerMemberId = accept.body.data.id

    expect((await call(app, as(viewer.id), 'GET', `/api/projects/${projectId}`)).status).toBe(200)
    expect((await call(app, as(viewer.id), 'PATCH', `/api/projects/${projectId}`, { description: 'draft' })).status).toBe(403)
    expect((await call(app, as(viewer.id), 'POST', `/api/projects/${projectId}/chat`, {})).status).toBe(403)
    expect((await call(app, as(viewer.id), 'POST', '/api/projects', { name: 'Mine', workspaceId })).status).toBe(403)
  })

  test('the viewer is promoted to editor and can now edit', async () => {
    expect((await call(app, as(admin.id), 'PATCH', `/api/members/${viewerMemberId}`, { role: 'member' })).status).toBe(200)
    expect((await call(app, as(viewer.id), 'PATCH', `/api/projects/${projectId}`, { description: 'draft' })).status).toBe(200)
    expect((await call(app, as(viewer.id), 'POST', `/api/projects/${projectId}/chat`, {})).status).toBe(200)
  })

  test('the admin cannot make anyone an owner', async () => {
    expect((await call(app, as(admin.id), 'PATCH', `/api/members/${viewerMemberId}`, { role: 'owner' })).status).toBe(403)
  })

  test('member.joined events fire with the joining roles', async () => {
    const events = await waitFor(async () => {
      const rows = await db.workspaceEvent.findMany({ where: { workspaceId, type: 'member.joined' } })
      return rows.length >= 2 ? rows : null
    })
    const byUser = new Map(
      events.map((e: any) => {
        const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload
        return [payload.member.userId, payload]
      }),
    )
    expect(byUser.get(admin.id)).toMatchObject({ member: { role: 'admin' }, source: 'invitation' })
    expect(byUser.get(viewer.id)).toMatchObject({ member: { role: 'viewer' }, source: 'invite_link' })
  })
})
