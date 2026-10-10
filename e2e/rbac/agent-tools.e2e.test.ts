// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace chat turn issues a signed requester ticket, the runtime
 * receives it, and the internal project routes authorize that person.
 *
 *   bun run test:e2e:rbac
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb } from '../../apps/api/src/__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'rbac-agent-tools-e2e'
delete process.env.KUBERNETES_SERVICE_HOST

const { seedRbacWorld, db, _setRbacModeForTests } = await import('../../apps/api/src/__tests__/helpers/rbac-world')
const { workspaceChatRoutes } = await import('../../apps/api/src/routes/workspace-chat')
const { runtimeInternalRoutes } = await import('../../apps/api/src/routes/internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../../apps/api/src/routes/internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../../apps/api/src/lib/workspace-runtime-token')
const { verifyRequesterTicketInWorkspace, workspaceTicketKey } = await import('../../apps/api/src/lib/requester-ticket')

type World = Awaited<ReturnType<typeof seedRbacWorld>>

const internal = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadProjectLifecycle: () => import('../../apps/api/src/services/project-lifecycle.service'),
  loadAgentCall: () => import('../../apps/api/src/services/agent-call.service'),
})

let world: World
let server: ReturnType<typeof Bun.serve>
const received: { ticket?: string | null; userId?: string | null; runtimeToken?: string | null } = {}

function chatApp() {
  return workspaceChatRoutes({
    alwaysEnabled: true,
    runtimeManager: {
      startWorkspace: async () => ({
        url: `http://127.0.0.1:${server.port}`,
        port: server.port,
        agentPort: server.port,
        status: 'running',
        projectId: world.workspaceA,
      }),
    } as any,
    resolveUserId: async (c) => c.req.header('x-test-user'),
  })
}

async function turn(userId: string, sessionId: string, claimedUserId?: string) {
  received.ticket = undefined
  const res = await chatApp().request(`http://internal/workspaces/${world.workspaceA}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-user': userId,
      'x-chat-session-id': sessionId,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'list the projects' }] }],
      chatSessionId: sessionId,
      ...(claimedUserId ? { userId: claimedUserId } : {}),
    }),
  })
  await res.text()
  return res.status
}

async function internalCall(method: string, path: string, ticket: string, body?: unknown) {
  const res = await internal.request(path, {
    method,
    headers: {
      'x-runtime-token': deriveWorkspaceRuntimeToken(world.workspaceA),
      'X-Requester-Ticket': ticket,
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
  world = await seedRbacWorld()
  server = Bun.serve({
    port: 0,
    fetch(req) {
      received.ticket = req.headers.get('X-Requester-Ticket')
      received.userId = req.headers.get('X-User-Id')
      received.runtimeToken = req.headers.get('x-runtime-token')
      return new Response('data: {"type":"data-turn-complete","data":{"status":"completed"}}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
})

afterAll(async () => {
  server?.stop(true)
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent tools inherit the person who started the turn', () => {
  test('workspace chat issues a workspace ticket for the signed-in user, not a claimed userId', async () => {
    const session = await db.chatSession.create({
      data: { inferredName: 'viewer turn', contextType: 'workspace', workspaceId: world.workspaceA },
    })
    const status = await turn(world.users.viewer, session.id, world.users.owner)
    expect(status).toBe(200)
    expect(received.userId).toBe(world.users.viewer)
    expect(received.runtimeToken).toBe(deriveWorkspaceRuntimeToken(world.workspaceA))
    const ticket = await verifyRequesterTicketInWorkspace(received.ticket, world.workspaceA)
    expect(ticket?.userId).toBe(world.users.viewer)
    expect(ticket?.projectId).toBe(workspaceTicketKey(world.workspaceA))
    expect(ticket?.origin).toMatchObject({ kind: 'chat', chatSessionId: session.id })
  })

  test('the runtime uses that ticket, so a viewer cannot see or create a restricted project', async () => {
    const ticket = received.ticket!
    const list = await internalCall('GET', `/workspaces/${world.workspaceA}/projects`, ticket)
    expect(list.status).toBe(200)
    const ids = list.body.projects.map((p: { id: string }) => p.id)
    expect(ids).toContain(world.projects.open)
    expect(ids).not.toContain(world.projects.restricted)

    const graph = await internalCall('GET', `/workspaces/${world.workspaceA}/projects/graph`, ticket)
    expect(graph.body.projects.map((p: { id: string }) => p.id)).not.toContain(world.projects.restricted)

    const forged = await internalCall(
      'GET',
      `/workspaces/${world.workspaceA}/projects?userId=${world.users.owner}`,
      ticket,
    )
    expect(forged.body.projects.map((p: { id: string }) => p.id)).not.toContain(world.projects.restricted)

    const created = await internalCall('POST', `/workspaces/${world.workspaceA}/projects`, ticket, {
      name: 'Viewer should not create this',
      userId: world.users.owner,
    })
    expect(created.status).toBe(403)
    expect(created.body.error.code).toBe('forbidden')
  })

  test('a schedule turn is issued as its owner and can see the restricted project', async () => {
    const session = await db.chatSession.create({
      data: { inferredName: 'schedule turn', contextType: 'workspace', workspaceId: world.workspaceA },
    })
    expect(await turn(world.users.owner, session.id)).toBe(200)
    const ticket = await verifyRequesterTicketInWorkspace(received.ticket, world.workspaceA)
    expect(ticket?.userId).toBe(world.users.owner)
    const list = await internalCall('GET', `/workspaces/${world.workspaceA}/projects`, received.ticket!)
    expect(list.body.projects.map((p: { id: string }) => p.id)).toContain(world.projects.restricted)
  })

  test('history searched with the viewer ticket omits the restricted project chat', async () => {
    const viewerSession = await db.chatSession.findFirst({
      where: { workspaceId: world.workspaceA, inferredName: 'viewer turn' },
    })
    await db.chatSession.create({
      data: { contextType: 'project', contextId: world.projects.restricted, inferredName: 'secretword restricted' },
    })
    await db.chatSession.create({
      data: { contextType: 'project', contextId: world.projects.open, inferredName: 'secretword open' },
    })
    const viewerTurn = await chatApp().request(`http://internal/workspaces/${world.workspaceA}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': world.users.viewer,
        'x-chat-session-id': viewerSession.id,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'again' }] }],
        chatSessionId: viewerSession.id,
      }),
    })
    await viewerTurn.text()
    const search = await internalCall(
      'GET',
      `/workspaces/${world.workspaceA}/history/search?q=secretword`,
      received.ticket!,
    )
    const titles = search.body.results.map((r: { title: string }) => r.title)
    expect(titles).toContain('secretword open')
    expect(titles.join('\n')).not.toContain('restricted')
  })
})
