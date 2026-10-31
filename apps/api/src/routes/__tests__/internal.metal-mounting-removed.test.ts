// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * On metal a project is online only in its own runtime, so the live member
 * mount routes record (or remove) the durable attachment and report
 * `mounted: false`. They used to answer 410 `mounting_removed`, which made
 * `project_attach` fail on every call (SHO-258 §3a).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'rbac-metal-mounting-secret'

const { seedRbacWorld, db, _setRbacModeForTests } = await import('../../__tests__/helpers/rbac-world')
const { runtimeInternalRoutes } = await import('../internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../../lib/requester-ticket')

type World = Awaited<ReturnType<typeof seedRbacWorld>>

const mountCalls: unknown[] = []
const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  metalWorkspaceMember: async (...args) => {
    mountCalls.push(args)
    return { ok: true }
  },
})

let w: World
let headers: Record<string, string>
let sessionId: string
const saved = { metal: process.env.SHOGO_METAL_ENABLED, local: process.env.SHOGO_LOCAL_MODE }

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
  headers = {
    'content-type': 'application/json',
    'x-runtime-token': deriveWorkspaceRuntimeToken(w.workspaceA),
    'X-Requester-Ticket': signRequesterTicket({ projectId: workspaceTicketKey(w.workspaceA), userId: w.users.member }),
  }
  const session = await db.chatSession.create({
    data: { contextType: 'workspace', workspaceId: w.workspaceA, createdByUserId: w.users.member, inferredName: 'ws chat' },
  })
  sessionId = session.id
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.SHOGO_METAL_ENABLED = 'true'
  delete process.env.SHOGO_LOCAL_MODE
  mountCalls.length = 0
})

afterEach(() => {
  if (saved.metal === undefined) delete process.env.SHOGO_METAL_ENABLED
  else process.env.SHOGO_METAL_ENABLED = saved.metal
  if (saved.local === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = saved.local
})

describe('metal: live member mounts report mounted:false instead of failing', () => {
  test('session member POST records the attachment and answers 200 without mounting', async () => {
    const res = await app.request(`/workspaces/${w.workspaceA}/sessions/${sessionId}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: w.projects.open }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mounted).toBe(false)
    expect(body.note).toContain('connect_project')
    expect(body.attached.projectId).toBe(w.projects.open)
    expect(await db.chatSessionProject.findMany({ where: { sessionId } })).toHaveLength(1)
    expect(mountCalls).toEqual([])
  })

  test('session member DELETE removes the attachment and answers 200 without unmounting', async () => {
    const res = await app.request(`/workspaces/${w.workspaceA}/sessions/${sessionId}/members/${w.projects.open}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mounted).toBe(false)
    expect(body.removed).toBe(true)
    expect(await db.chatSessionProject.findMany({ where: { sessionId } })).toHaveLength(0)
    expect(mountCalls).toEqual([])
  })

  test('project attachment POST records the durable edge and answers 201 without mounting', async () => {
    const res = await app.request(`/projects/${w.projects.restricted}/attachments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ attachedProjectId: w.projects.open }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mounted).toBe(false)
    expect(body.attachment.attachedProjectId).toBe(w.projects.open)
    const edges = await db.projectAttachment.findMany({ where: { projectId: w.projects.restricted } })
    expect(edges.map((e: { attachedProjectId: string }) => e.attachedProjectId)).toEqual([w.projects.open])
    expect(mountCalls).toEqual([])
  })
})
