// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A project goes Restricted, gets a project admin and an outside contractor,
 * loses the contractor, and goes back to open, with access checked through
 * the real routers at every step.
 *
 *   bun run test:e2e:rbac
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb } from '../../apps/api/src/__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const { buildRbacApp, call, db, _setRbacModeForTests } = await import('../../apps/api/src/__tests__/helpers/rbac-world')

const app = buildRbacApp()
const as = (id: string) => ({ user: id })
const suffix = crypto.randomUUID().slice(0, 8)

const users: Record<'owner' | 'admin' | 'lead' | 'member' | 'contractor', string> = {} as any
let workspaceId: string
let projectId: string
let contractorRowId: string

async function canRead(userId: string) {
  return (await call(app, as(userId), 'GET', `/api/projects/${projectId}`)).status
}

async function listed(userId: string) {
  const res = await call(app, as(userId), 'GET', `/api/projects?workspaceId=${workspaceId}`)
  return res.status === 200 && res.body.items.some((p: any) => p.id === projectId)
}

beforeAll(async () => {
  _setRbacModeForTests('on')
  for (const name of Object.keys({ owner: 1, admin: 1, lead: 1, member: 1, contractor: 1 }) as Array<keyof typeof users>) {
    users[name] = (await db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })).id
  }
  const ws = await db.workspace.create({ data: { name: 'Lifecycle', slug: `lifecycle-${suffix}`, kind: 'team' } })
  workspaceId = ws.id
  await db.member.create({ data: { userId: users.owner, workspaceId, role: 'owner' } })
  await db.member.create({ data: { userId: users.admin, workspaceId, role: 'admin' } })
  await db.member.create({ data: { userId: users.lead, workspaceId, role: 'member' } })
  await db.member.create({ data: { userId: users.member, workspaceId, role: 'member' } })
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('restricted project lifecycle', () => {
  test('owner creates a project that everyone in the workspace can see', async () => {
    const res = await call(app, as(users.owner), 'POST', '/api/projects', { name: 'Acquisition Plan', workspaceId })
    expect(res.status).toBe(201)
    projectId = res.body.data.id
    for (const u of [users.admin, users.lead, users.member]) expect(await listed(u)).toBe(true)
  })

  test('owner makes the lead a project admin and restricts the project', async () => {
    const add = await call(app, as(users.owner), 'POST', `/api/projects/${projectId}/members`, { userId: users.lead, role: 'admin' })
    expect(add.status).toBe(201)
    const restrict = await call(app, as(users.owner), 'PATCH', `/api/projects/${projectId}/visibility`, { visibility: 'restricted' })
    expect(restrict.status).toBe(200)

    expect(await canRead(users.owner)).toBe(200)
    expect(await canRead(users.admin)).toBe(200)
    expect(await canRead(users.lead)).toBe(200)
    expect(await canRead(users.member)).toBe(404)
    expect(await listed(users.member)).toBe(false)
    expect(await listed(users.lead)).toBe(true)
  })

  test('the project admin brings in an outside contractor who can work only there', async () => {
    const add = await call(app, as(users.lead), 'POST', `/api/projects/${projectId}/members`, { userId: users.contractor, role: 'member' })
    expect(add.status).toBe(201)
    contractorRowId = add.body.data.id

    expect(await canRead(users.contractor)).toBe(200)
    expect((await call(app, as(users.contractor), 'POST', `/api/projects/${projectId}/chat`, {})).status).toBe(200)
    expect((await call(app, as(users.contractor), 'GET', `/api/projects/${projectId}/members`)).status).toBe(403)
    expect((await call(app, as(users.contractor), 'GET', `/api/workspaces/${workspaceId}`)).status).toBe(403)
    expect((await call(app, as(users.contractor), 'GET', `/api/members?workspaceId=${workspaceId}`)).status).toBe(403)

    const other = await call(app, as(users.owner), 'POST', '/api/projects', { name: 'Payroll', workspaceId })
    expect([403, 404]).toContain((await call(app, as(users.contractor), 'GET', `/api/projects/${other.body.data.id}`)).status)
    const list = await call(app, as(users.contractor), 'GET', `/api/projects?workspaceId=${workspaceId}`)
    expect(list.body.items.map((p: any) => p.id)).toEqual([projectId])

    const access = await call(app, as(users.owner), 'GET', `/api/projects/${projectId}/members`)
    const contractor = access.body.data.members.find((m: any) => m.userId === users.contractor)
    expect(contractor).toMatchObject({ role: 'member', isGuest: true })
    const member = access.body.data.workspaceMembers.find((m: any) => m.userId === users.member)
    expect(member.effectiveRole).toBeNull()
  })

  test('removing the contractor revokes access immediately', async () => {
    expect((await call(app, as(users.lead), 'DELETE', `/api/projects/${projectId}/members/${contractorRowId}`)).status).toBe(200)
    expect(await canRead(users.contractor)).toBe(404)
  })

  test('opening the project again restores workspace access', async () => {
    expect((await call(app, as(users.lead), 'PATCH', `/api/projects/${projectId}/visibility`, { visibility: 'workspace' })).status).toBe(200)
    expect(await canRead(users.member)).toBe(200)
    expect(await listed(users.member)).toBe(true)
    expect((await call(app, as(users.member), 'PATCH', `/api/projects/${projectId}`, { description: 'back' })).status).toBe(200)
  })
})
