// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Restricted projects: hidden from list surfaces, 404 on direct access, and
 * toggling visibility keeps the actor and creator in while removing the rest
 * of the workspace (and restores them when toggled back).
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

async function freshProject(createdBy: string, name = `P-${crypto.randomUUID().slice(0, 6)}`) {
  return db.project.create({ data: { name, workspaceId: w.workspaceA, createdBy } })
}

async function listNames(userId: string) {
  const res = await call(app, as(userId), 'GET', `/api/projects?workspaceId=${w.workspaceA}`)
  return (res.body.items ?? []).map((p: any) => p.name)
}

describe('visibility toggle', () => {
  test('owner restricts a member-created project: creator keeps access as project admin, others lose it', async () => {
    const p = await freshProject(w.users.member)
    expect((await call(app, as(w.users.viewer), 'GET', `/api/projects/${p.id}`)).status).toBe(200)

    const res = await call(app, as(w.users.owner), 'PATCH', `/api/projects/${p.id}/visibility`, { visibility: 'restricted' })
    expect(res.status).toBe(200)
    expect(res.body.data.visibility).toBe('restricted')

    const creatorRow = await db.member.findFirst({ where: { userId: w.users.member, projectId: p.id } })
    expect(creatorRow?.role).toBe('admin')
    // Owners already govern every project and get no redundant row.
    expect(await db.member.findFirst({ where: { userId: w.users.owner, projectId: p.id } })).toBeNull()

    expect((await call(app, as(w.users.member), 'GET', `/api/projects/${p.id}`)).status).toBe(200)
    expect((await call(app, as(w.users.viewer), 'GET', `/api/projects/${p.id}`)).status).toBe(404)
    expect((await call(app, as(w.users.billingAdmin), 'PATCH', `/api/projects/${p.id}`, { description: 'x' })).status).toBe(404)
    expect(await listNames(w.users.viewer)).not.toContain(p.name)
    expect(await listNames(w.users.member)).toContain(p.name)
    expect(await listNames(w.users.admin)).toContain(p.name)

    const back = await call(app, as(w.users.owner), 'PATCH', `/api/projects/${p.id}/visibility`, { visibility: 'workspace' })
    expect(back.status).toBe(200)
    expect((await call(app, as(w.users.viewer), 'GET', `/api/projects/${p.id}`)).status).toBe(200)
    expect(await listNames(w.users.viewer)).toContain(p.name)
  })

  test('the generic PATCH /api/projects/:id rejects visibility changes', async () => {
    const p = await freshProject(w.users.billingAdmin)
    const res = await call(app, as(w.users.admin), 'PATCH', `/api/projects/${p.id}`, { visibility: 'restricted' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('use_visibility_endpoint')
    expect((await db.project.findUnique({ where: { id: p.id } })).visibility).toBe('workspace')
    // Callers without access still get the 404, not the 400.
    expect((await call(app, as(w.users.outsider), 'PATCH', `/api/projects/${p.id}`, { visibility: 'restricted' })).status).toBe(404)
  })

  test('editors cannot change visibility', async () => {
    const p = await freshProject(w.users.owner)
    expect((await call(app, as(w.users.member), 'PATCH', `/api/projects/${p.id}/visibility`, { visibility: 'restricted' })).status).toBe(403)
    const stored = await db.project.findUnique({ where: { id: p.id } })
    expect(stored.visibility).toBe('workspace')
  })

  test('a failed admin grant leaves the visibility unchanged', async () => {
    const { setProjectVisibility } = await import('../../lib/authz/project-access')
    const p = await freshProject(w.users.member)
    const failing = {
      $transaction: (fn: (tx: any) => Promise<unknown>) =>
        db.$transaction((tx: any) =>
          fn({
            project: tx.project,
            member: {
              findFirst: tx.member.findFirst.bind(tx.member),
              update: tx.member.update.bind(tx.member),
              create: async () => { throw new Error('grant failed') },
            },
          }),
        ),
    }
    await expect(setProjectVisibility(failing, p.id, 'restricted', w.users.member)).rejects.toThrow('grant failed')
    expect((await db.project.findUnique({ where: { id: p.id } })).visibility).toBe('workspace')
    expect(await db.member.findFirst({ where: { userId: w.users.member, projectId: p.id } })).toBeNull()
  })

  test('project creation as restricted adds a non-admin creator as project admin', async () => {
    const res = await call(app, as(w.users.member), 'POST', '/api/projects', {
      name: `Secret-${crypto.randomUUID().slice(0, 6)}`,
      workspaceId: w.workspaceA,
      visibility: 'restricted',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.visibility).toBe('restricted')
    const id = res.body.data.id
    expect((await db.member.findFirst({ where: { userId: w.users.member, projectId: id } }))?.role).toBe('admin')
    expect((await call(app, as(w.users.viewer), 'GET', `/api/projects/${id}`)).status).toBe(404)
    expect((await call(app, as(w.users.member), 'GET', `/api/projects/${id}`)).status).toBe(200)
  })

  test('viewers cannot create projects', async () => {
    const res = await call(app, as(w.users.viewer), 'POST', '/api/projects', { name: 'Nope', workspaceId: w.workspaceA })
    expect(res.status).toBe(403)
  })
})

describe('list surfaces hide restricted projects', () => {
  test('starred list drops a project once it becomes inaccessible', async () => {
    const p = await freshProject(w.users.owner)
    await db.starredProject.create({ data: { userId: w.users.viewer, projectId: p.id, workspaceId: w.workspaceA } })
    const before = await call(app, as(w.users.viewer), 'GET', '/api/starred-projects')
    expect(before.status).toBe(200)
    expect(before.body.items.map((s: any) => s.projectId)).toContain(p.id)

    await db.project.update({ where: { id: p.id }, data: { visibility: 'restricted' } })
    const after = await call(app, as(w.users.viewer), 'GET', '/api/starred-projects')
    expect(after.body.items.map((s: any) => s.projectId)).not.toContain(p.id)
  })

  test('cannot star a project you cannot read', async () => {
    const res = await call(app, as(w.users.viewer), 'POST', '/api/starred-projects', {
      userId: w.users.viewer,
      projectId: w.projects.restricted2,
      workspaceId: w.workspaceA,
    })
    expect([403, 404]).toContain(res.status)
  })

  test('chat sessions of a restricted project are not listed or readable for outsiders to it', async () => {
    const session = await db.chatSession.create({
      data: { contextType: 'project', contextId: w.projects.restricted2, inferredName: 'secret chat' },
    })
    const scoped = await call(app, as(w.users.viewer), 'GET', `/api/chat-sessions?projectId=${w.projects.restricted2}`)
    expect([403, 404]).toContain(scoped.status)
    const unscoped = await call(app, as(w.users.viewer), 'GET', '/api/chat-sessions')
    expect(unscoped.body.items.map((s: any) => s.id)).not.toContain(session.id)
    const one = await call(app, as(w.users.viewer), 'GET', `/api/chat-sessions/${session.id}`)
    expect([403, 404]).toContain(one.status)
    const owner = await call(app, as(w.users.owner), 'GET', `/api/chat-sessions/${session.id}`)
    expect(owner.status).toBe(200)
  })
})
