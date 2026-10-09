// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guest isolation (regression for the guest leak): a project-only invite,
 * by link or by email, creates a project-scoped row that opens exactly that
 * project and nothing else in the workspace, and does not take a seat.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db, _setRbacModeForTests } = await import('../helpers/rbac-world')
const { countActiveWorkspaceMembers } = await import('../../services/billing.service')
type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
const app = buildRbacApp()
const as = (id: string) => ({ user: id })

beforeAll(async () => {
  // Guest isolation must hold even before enforcement is switched on.
  _setRbacModeForTests('shadow')
  w = await seedRbacWorld()
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function newUser(name = 'guest') {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@example.com`
  const user = await db.user.create({ data: { name, email } })
  return { id: user.id, email }
}

async function expectIsolatedGuest(userId: string, projectId: string) {
  expect((await call(app, as(userId), 'GET', `/api/projects/${projectId}`)).status).toBe(200)
  const others = [w.projects.open, w.projects.restricted, w.projects.restricted2].filter((p) => p !== projectId)
  for (const other of others) {
    expect([403, 404]).toContain((await call(app, as(userId), 'GET', `/api/projects/${other}`)).status)
    expect([403, 404]).toContain((await call(app, as(userId), 'POST', `/api/projects/${other}/chat`, {})).status)
  }
  expect((await call(app, as(userId), 'GET', `/api/workspaces/${w.workspaceA}`)).status).toBe(403)
  expect((await call(app, as(userId), 'GET', `/api/members?workspaceId=${w.workspaceA}`)).status).toBe(403)
  expect((await call(app, as(userId), 'GET', `/api/invite-links?workspaceId=${w.workspaceA}`)).status).toBe(403)
  expect((await call(app, as(userId), 'GET', `/api/api-keys?workspaceId=${w.workspaceA}`)).status).toBe(403)
  expect((await call(app, as(userId), 'POST', '/api/projects', { name: 'x', workspaceId: w.workspaceA })).status).toBe(403)

  const list = await call(app, as(userId), 'GET', `/api/projects?workspaceId=${w.workspaceA}`)
  expect(list.body.items.map((p: any) => p.id)).toEqual([projectId])
  const unscoped = await call(app, as(userId), 'GET', '/api/projects')
  expect(unscoped.body.items.map((p: any) => p.id)).toEqual([projectId])
  const workspaces = await call(app, as(userId), 'GET', '/api/workspaces')
  expect(workspaces.body.items.map((x: any) => x.id)).not.toContain(w.workspaceA)
}

describe('project invite link', () => {
  test('accepting creates a guest that sees only that project', async () => {
    const link = await call(app, as(w.users.owner), 'POST', '/api/invite-links', { projectId: w.projects.restricted2, role: 'member' })
    expect(link.status).toBe(200)
    expect(link.body.data.workspaceId).toBe(w.workspaceA)

    const guest = await newUser()
    const accept = await call(app, as(guest.id), 'POST', `/api/invite-links/${link.body.data.token}/accept`)
    expect(accept.status).toBe(200)
    expect(accept.body.data.projectId).toBe(w.projects.restricted2)
    expect(accept.body.data.role).toBe('member')
    expect(await db.member.count({ where: { userId: guest.id, projectId: null } })).toBe(0)

    await expectIsolatedGuest(guest.id, w.projects.restricted2)
    expect((await call(app, as(guest.id), 'PATCH', `/api/projects/${w.projects.restricted2}`, { description: 'guest' })).status).toBe(200)

    const again = await call(app, as(guest.id), 'POST', `/api/invite-links/${link.body.data.token}/accept`)
    expect(again.body.alreadyMember).toBe(true)
  })

  test('project links cannot mint owners; workspace links cannot mint owners', async () => {
    const projectLink = await call(app, as(w.users.owner), 'POST', '/api/invite-links', { projectId: w.projects.open, role: 'owner' })
    expect(projectLink.status).toBe(200)
    expect(projectLink.body.data.role).toBe('admin')
    const wsLink = await call(app, as(w.users.owner), 'POST', '/api/invite-links', { workspaceId: w.workspaceA, role: 'owner' })
    expect(wsLink.status).toBe(400)
  })

  test('editors cannot create invite links; admins cannot exceed their role', async () => {
    expect((await call(app, as(w.users.member), 'POST', '/api/invite-links', { workspaceId: w.workspaceA, role: 'viewer' })).status).toBe(403)
    expect((await call(app, as(w.users.guestEditor), 'POST', '/api/invite-links', { projectId: w.projects.restricted, role: 'viewer' })).status).toBe(403)
    expect((await call(app, as(w.users.admin), 'POST', '/api/invite-links', { workspaceId: w.workspaceA, role: 'admin' })).status).toBe(200)
  })

  test('a project admin may share their restricted project by link', async () => {
    const res = await call(app, as(w.users.member), 'POST', '/api/invite-links', { projectId: w.projects.restricted, role: 'viewer' })
    expect(res.status).toBe(200)
    const list = await call(app, as(w.users.member), 'GET', `/api/invite-links?projectId=${w.projects.restricted}`)
    expect(list.status).toBe(200)
    expect(list.body.items.map((l: any) => l.id)).toContain(res.body.data.id)
  })
})

describe('project email invitation', () => {
  test('accepting creates a guest with the invited project role', async () => {
    const guest = await newUser('emailguest')
    const invite = await call(app, as(w.users.owner), 'POST', '/api/invitations', {
      email: guest.email,
      projectId: w.projects.open,
      role: 'viewer',
    })
    expect(invite.status).toBe(201)
    expect(invite.body.data.workspaceId).toBe(w.workspaceA)

    const accepted = await call(app, as(guest.id), 'PATCH', `/api/invitations/${invite.body.data.id}`, { status: 'accepted' })
    expect(accepted.status).toBe(200)

    const join = await call(app, as(guest.id), 'POST', '/api/members', {
      userId: guest.id,
      projectId: w.projects.open,
      workspaceId: w.workspaceA,
      role: 'admin',
    })
    expect(join.status).toBe(201)
    expect(join.body.data.projectId).toBe(w.projects.open)
    expect(join.body.data.role).toBe('viewer')

    await expectIsolatedGuest(guest.id, w.projects.open)
    expect((await call(app, as(guest.id), 'PATCH', `/api/projects/${w.projects.open}`, { description: 'nope' })).status).toBe(403)
  })

  test('a stranger cannot self-join a project without an invitation', async () => {
    const stranger = await newUser('stranger')
    const res = await call(app, as(stranger.id), 'POST', '/api/members', {
      userId: stranger.id,
      projectId: w.projects.open,
      role: 'viewer',
    })
    expect(res.status).toBe(403)
  })
})

describe('seats', () => {
  test('guests are not counted as seats', async () => {
    const seats = await countActiveWorkspaceMembers(w.workspaceA)
    const wsRows = await db.member.count({ where: { workspaceId: w.workspaceA, projectId: null } })
    expect(seats).toBe(wsRows)
    expect(await db.member.count({ where: { workspaceId: w.workspaceA } })).toBeGreaterThan(wsRows)
  })
})
