// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Membership mutations: no escalation, owner-only owner changes, the
 * last-owner invariant, project-role grants, and role changes that take
 * effect on the very next request.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, seedRbacWorld, db, _setRbacModeForTests } = await import('../helpers/rbac-world')
type World = Awaited<ReturnType<typeof seedRbacWorld>>

let w: World
const app = buildRbacApp()
const as = (id: string) => ({ user: id })

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function newUser(name = 'u') {
  return (await db.user.create({ data: { name, email: `${name}-${crypto.randomUUID().slice(0, 8)}@example.com` } })).id
}

async function wsMember(role: string) {
  const userId = await newUser(role)
  const row = await db.member.create({ data: { userId, workspaceId: w.workspaceA, role } })
  return { userId, memberId: row.id }
}

describe('workspace role grants', () => {
  test('admin cannot grant owner; owner can', async () => {
    const target = await newUser()
    const byAdmin = await call(app, as(w.users.admin), 'POST', '/api/members', { userId: target, workspaceId: w.workspaceA, role: 'owner' })
    expect(byAdmin.status).toBe(403)
    const byOwner = await call(app, as(w.users.owner), 'POST', '/api/members', { userId: target, workspaceId: w.workspaceA, role: 'owner' })
    expect(byOwner.status).toBe(201)
    expect(byOwner.body.data.role).toBe('owner')
  })

  test('admin can add admins and below; members and viewers cannot add anyone', async () => {
    const a = await newUser()
    expect((await call(app, as(w.users.admin), 'POST', '/api/members', { userId: a, workspaceId: w.workspaceA, role: 'admin' })).status).toBe(201)
    const b = await newUser()
    expect((await call(app, as(w.users.member), 'POST', '/api/members', { userId: b, workspaceId: w.workspaceA, role: 'viewer' })).status).toBe(403)
    expect((await call(app, as(w.users.viewer), 'POST', '/api/members', { userId: b, workspaceId: w.workspaceA, role: 'viewer' })).status).toBe(403)
  })

  test('admin cannot promote to owner or demote an owner', async () => {
    const target = await wsMember('member')
    expect((await call(app, as(w.users.admin), 'PATCH', `/api/members/${target.memberId}`, { role: 'owner' })).status).toBe(403)
    const coOwner = await wsMember('owner')
    expect((await call(app, as(w.users.admin), 'PATCH', `/api/members/${coOwner.memberId}`, { role: 'member' })).status).toBe(403)
    expect((await call(app, as(w.users.admin), 'DELETE', `/api/members/${coOwner.memberId}`)).status).toBe(403)
  })

  test('only owners grant billing admin', async () => {
    const target = await wsMember('member')
    expect((await call(app, as(w.users.admin), 'PATCH', `/api/members/${target.memberId}`, { isBillingAdmin: true })).status).toBe(403)
    expect((await call(app, as(w.users.owner), 'PATCH', `/api/members/${target.memberId}`, { isBillingAdmin: true })).status).toBe(200)
  })

  test('a project admin cannot grant workspace roles', async () => {
    const target = await newUser()
    const res = await call(app, as(w.users.member), 'POST', '/api/members', { userId: target, workspaceId: w.workspaceA, role: 'member' })
    expect(res.status).toBe(403)
  })

  test('only role and billing flag are mutable on a member row', async () => {
    const target = await wsMember('viewer')
    const res = await call(app, as(w.users.owner), 'PATCH', `/api/members/${target.memberId}`, {
      role: 'member',
      workspaceId: w.workspaceB,
      userId: w.users.owner,
    })
    expect(res.status).toBe(200)
    const row = await db.member.findUnique({ where: { id: target.memberId } })
    expect(row.workspaceId).toBe(w.workspaceA)
    expect(row.userId).toBe(target.userId)
    expect(row.role).toBe('member')
  })
})

describe('last-owner invariant', () => {
  test('the only owner cannot leave or demote themselves', async () => {
    const ws = await db.workspace.create({ data: { name: 'Solo', slug: `solo-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' } })
    const owner = await newUser('solo')
    const row = await db.member.create({ data: { userId: owner, workspaceId: ws.id, role: 'owner' } })
    expect((await call(app, as(owner), 'PATCH', `/api/members/${row.id}`, { role: 'admin' })).status).toBe(400)
    expect((await call(app, as(owner), 'DELETE', `/api/members/${row.id}`)).status).toBe(400)

    const second = await newUser('second')
    await db.member.create({ data: { userId: second, workspaceId: ws.id, role: 'owner' } })
    expect((await call(app, as(owner), 'PATCH', `/api/members/${row.id}`, { role: 'admin' })).status).toBe(200)
  })
})

describe('project roles', () => {
  test('project admin adds, changes and removes project members without escalation', async () => {
    const pid = w.projects.restricted
    const guest = await newUser('contractor')
    const add = await call(app, as(w.users.member), 'POST', `/api/projects/${pid}/members`, { userId: guest, role: 'viewer' })
    expect(add.status).toBe(201)
    expect(add.body.data.workspaceId).toBe(w.workspaceA)
    expect((await call(app, as(guest), 'GET', `/api/projects/${pid}`)).status).toBe(200)

    const dup = await call(app, as(w.users.member), 'POST', `/api/projects/${pid}/members`, { userId: guest, role: 'viewer' })
    expect(dup.status).toBe(409)

    const promote = await call(app, as(w.users.member), 'PATCH', `/api/projects/${pid}/members/${add.body.data.id}`, { role: 'member' })
    expect(promote.status).toBe(200)
    expect((await call(app, as(guest), 'PATCH', `/api/projects/${pid}`, { description: 'guest edit' })).status).toBe(200)

    const remove = await call(app, as(w.users.member), 'DELETE', `/api/projects/${pid}/members/${add.body.data.id}`)
    expect(remove.status).toBe(200)
    expect((await call(app, as(guest), 'GET', `/api/projects/${pid}`)).status).toBe(404)
  })

  test('project editors cannot manage project members', async () => {
    const target = await newUser()
    const res = await call(app, as(w.users.guestEditor), 'POST', `/api/projects/${w.projects.restricted}/members`, { userId: target, role: 'viewer' })
    expect(res.status).toBe(403)
  })

  test('project member ids from another project are not addressable', async () => {
    const row = await db.member.findFirst({ where: { userId: w.users.guestViewer, projectId: w.projects.open } })
    const res = await call(app, as(w.users.member), 'DELETE', `/api/projects/${w.projects.restricted}/members/${row.id}`)
    expect(res.status).toBe(404)
  })

  test('legacy project role "owner" is normalized to admin', async () => {
    const target = await newUser()
    const res = await call(app, as(w.users.owner), 'POST', `/api/projects/${w.projects.open}/members`, { userId: target, role: 'owner' })
    expect(res.status).toBe(201)
    expect(res.body.data.role).toBe('admin')
  })

  test('unknown email creates a pending project invitation', async () => {
    const email = `new-${crypto.randomUUID().slice(0, 8)}@example.com`
    const res = await call(app, as(w.users.owner), 'POST', `/api/projects/${w.projects.open}/members`, { email, role: 'member' })
    expect(res.status).toBe(201)
    expect(res.body.data.invitation.projectId).toBe(w.projects.open)
    expect(res.body.data.invitation.workspaceId).toBe(w.workspaceA)
    const again = await call(app, as(w.users.owner), 'POST', `/api/projects/${w.projects.open}/members`, { email, role: 'member' })
    expect(again.status).toBe(409)
  })
})

describe('changes apply on the next request', () => {
  test('demotion and removal are effective immediately', async () => {
    const m = await wsMember('member')
    expect((await call(app, as(m.userId), 'PATCH', `/api/projects/${w.projects.open}`, { description: 'm' })).status).toBe(200)

    expect((await call(app, as(w.users.owner), 'PATCH', `/api/members/${m.memberId}`, { role: 'viewer' })).status).toBe(200)
    expect((await call(app, as(m.userId), 'PATCH', `/api/projects/${w.projects.open}`, { description: 'm2' })).status).toBe(403)
    expect((await call(app, as(m.userId), 'GET', `/api/projects/${w.projects.open}`)).status).toBe(200)

    expect((await call(app, as(w.users.owner), 'DELETE', `/api/members/${m.memberId}`)).status).toBe(200)
    expect((await call(app, as(m.userId), 'GET', `/api/projects/${w.projects.open}`)).status).toBe(403)
  })

  test('removing a workspace member also removes their project roles in that workspace', async () => {
    const m = await wsMember('member')
    await db.member.create({ data: { userId: m.userId, projectId: w.projects.restricted2, workspaceId: w.workspaceA, role: 'admin' } })
    expect((await call(app, as(w.users.owner), 'DELETE', `/api/members/${m.memberId}`)).status).toBe(200)
    expect(await db.member.count({ where: { userId: m.userId, workspaceId: w.workspaceA } })).toBe(0)
  })
})
