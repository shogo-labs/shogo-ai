// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent tools act as the person behind the turn. The runtime token only
 * proves which workspace the pod belongs to; the signed requester ticket
 * says who asked.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'rbac-agent-tools-secret'

const { seedRbacWorld, db, _setRbacModeForTests } = await import('../helpers/rbac-world')
const { runtimeInternalRoutes } = await import('../../routes/internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../../routes/internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../../lib/requester-ticket')

type World = Awaited<ReturnType<typeof seedRbacWorld>>

const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadProjectLifecycle: () => import('../../services/project-lifecycle.service'),
  loadAgentCall: () => import('../../services/agent-call.service'),
})

let w: World
let workspaceToken: string

function ticketFor(userId: string): string {
  return signRequesterTicket({ projectId: workspaceTicketKey(w.workspaceA), userId })
}

async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  ticket?: string,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      'x-runtime-token': token,
      ...(ticket ? { 'X-Requester-Ticket': ticket } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body: parsed }
}

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
  workspaceToken = deriveWorkspaceRuntimeToken(w.workspaceA)
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent tools inherit the requester', () => {
  test('list and graph hide restricted projects from a viewer and show them to a grantee', async () => {
    const viewer = ticketFor(w.users.viewer)
    const member = ticketFor(w.users.member)
    const viewerList = await call(workspaceToken, 'GET', `/workspaces/${w.workspaceA}/projects`, undefined, viewer)
    const memberList = await call(workspaceToken, 'GET', `/workspaces/${w.workspaceA}/projects`, undefined, member)
    expect(viewerList.status).toBe(200)
    expect(viewerList.body.projects.map((p: any) => p.id)).toContain(w.projects.open)
    expect(viewerList.body.projects.map((p: any) => p.id)).not.toContain(w.projects.restricted)
    expect(memberList.body.projects.map((p: any) => p.id)).toContain(w.projects.restricted)

    const viewerGraph = await call(workspaceToken, 'GET', `/workspaces/${w.workspaceA}/projects/graph`, undefined, viewer)
    const memberGraph = await call(workspaceToken, 'GET', `/workspaces/${w.workspaceA}/projects/graph`, undefined, member)
    expect(viewerGraph.body.projects.map((p: any) => p.id)).not.toContain(w.projects.restricted)
    expect(memberGraph.body.projects.map((p: any) => p.id)).toContain(w.projects.restricted)
  })

  test('a forged userId is ignored when a ticket is present', async () => {
    const res = await call(
      workspaceToken,
      'GET',
      `/workspaces/${w.workspaceA}/projects/graph?userId=${w.users.owner}`,
      undefined,
      ticketFor(w.users.viewer),
    )
    expect(res.body.projects.map((p: any) => p.id)).not.toContain(w.projects.restricted)
  })

  test('a viewer cannot create a project; a member can', async () => {
    const denied = await call(
      workspaceToken,
      'POST',
      `/workspaces/${w.workspaceA}/projects`,
      { name: 'Viewer Project', userId: w.users.owner },
      ticketFor(w.users.viewer),
    )
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('forbidden')

    const created = await call(
      workspaceToken,
      'POST',
      `/workspaces/${w.workspaceA}/projects`,
      { name: `Member Project ${crypto.randomUUID().slice(0, 6)}` },
      ticketFor(w.users.member),
    )
    expect(created.status).toBe(201)
    expect(created.body.project.id).toBeTruthy()
    const row = await db.project.findUnique({ where: { id: created.body.project.id } })
    expect(row.createdBy).toBe(w.users.member)
  })

  test('attaching, configuring, or calling an inaccessible project is denied', async () => {
    const editor = ticketFor(w.users.billingAdmin)
    const attach = await call(
      workspaceToken,
      'POST',
      `/projects/${w.projects.open}/attachments`,
      { attachedProjectId: w.projects.restricted, attachMode: 'readwrite' },
      editor,
    )
    expect(attach.status).toBe(404)

    const configure = await call(
      workspaceToken,
      'PATCH',
      `/projects/${w.projects.restricted}/config`,
      { name: 'Renamed' },
      editor,
    )
    expect(configure.status).toBe(404)

    const called = await call(
      workspaceToken,
      'POST',
      `/projects/${w.projects.restricted}/agent-call`,
      { message: 'hello', wait: false },
      editor,
    )
    expect(called.status).toBe(404)
  })

  test('history search excludes chats from projects the requester cannot read', async () => {
    await db.chatSession.create({
      data: { contextType: 'project', contextId: w.projects.restricted, inferredName: 'secretword restricted' },
    })
    await db.chatSession.create({
      data: { contextType: 'project', contextId: w.projects.open, inferredName: 'secretword open' },
    })
    await db.chatSession.create({
      data: { contextType: 'workspace', workspaceId: w.workspaceA, inferredName: 'secretword workspace' },
    })
    const res = await call(
      workspaceToken,
      'GET',
      `/workspaces/${w.workspaceA}/history/search?q=secretword`,
      undefined,
      ticketFor(w.users.viewer),
    )
    expect(res.status).toBe(200)
    const titles = res.body.results.map((r: any) => r.title)
    expect(titles).toContain('secretword open')
    expect(titles).toContain('secretword workspace')
    expect(titles.join('\n')).not.toContain('restricted')
  })

  test('enforcement on: a workspace token with no ticket is refused, even with a forged userId', async () => {
    const res = await call(workspaceToken, 'POST', `/workspaces/${w.workspaceA}/projects`, {
      name: 'Forged',
      userId: w.users.owner,
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('requester_required')
  })

  test('a heartbeat (project token, no ticket) acts as the project creator', async () => {
    const res = await call(w.runtimeToken, 'POST', `/workspaces/${w.workspaceA}/projects`, { name: 'Heartbeat Project' })
    expect(res.status).toBe(201)
    const row = await db.project.findUnique({ where: { id: res.body.project.id } })
    expect(row.createdBy).toBe(w.users.owner)
  })

  test('a schedule-style workspace ticket acts as that user, not the workspace owner', async () => {
    const res = await call(
      workspaceToken,
      'GET',
      `/workspaces/${w.workspaceA}/projects/graph`,
      undefined,
      ticketFor(w.users.viewer),
    )
    expect(res.body.projects.map((p: any) => p.id)).not.toContain(w.projects.restricted)
  })
})

describe('shadow mode', () => {
  test('a viewer write on an open project succeeds and is logged', async () => {
    _setRbacModeForTests('shadow')
    const warn = spyOn(console, 'warn')
    try {
      const res = await call(
        workspaceToken,
        'PATCH',
        `/projects/${w.projects.open}/config`,
        { description: 'shadow viewer' },
        ticketFor(w.users.viewer),
      )
      expect(res.status).toBe(200)
      expect(warn.mock.calls.some((args) => JSON.stringify(args).includes('shadow-deny'))).toBe(true)
    } finally {
      warn.mockRestore()
      _setRbacModeForTests('on')
      await db.project.update({ where: { id: w.projects.open }, data: { description: null } })
    }
  })

  test('a restricted project stays hidden even in shadow mode', async () => {
    _setRbacModeForTests('shadow')
    try {
      const res = await call(
        workspaceToken,
        'GET',
        `/projects/${w.projects.restricted}/config`,
        undefined,
        ticketFor(w.users.viewer),
      )
      expect(res.status).toBe(404)
    } finally {
      _setRbacModeForTests('on')
    }
  })
})
