// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /api/internal/projects/:projectId/remote-tool — a runtime running one
 * tool against another project's own runtime. Real runtime-token auth, real
 * requester tickets and RBAC over the seeded sqlite world; only the target
 * runtime itself is faked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'rbac-remote-tool-secret'

const { seedRbacWorld, db, _setRbacModeForTests } = await import('../../__tests__/helpers/rbac-world')
const { runtimeInternalRoutes } = await import('../internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../../lib/requester-ticket')
const { setProjectRuntimeUrlResolver } = await import('../../services/agent-call.service')

type World = Awaited<ReturnType<typeof seedRbacWorld>>

const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadAgentCall: () => import('../../services/agent-call.service'),
})

let w: World
let tokenA: string
const realFetch = globalThis.fetch
let runtimeResponse: { status: number; body: unknown }
let forwarded: Array<{ url: string; token: string | null; body: any }>

function ticketFor(userId: string, workspaceId = w.workspaceA): string {
  return signRequesterTicket({ projectId: workspaceTicketKey(workspaceId), userId })
}

async function remoteTool(
  target: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/projects/${target}/remote-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
  tokenA = deriveWorkspaceRuntimeToken(w.workspaceA)
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  runtimeResponse = { status: 200, body: { ok: true, result: { content: 'file body' } } }
  forwarded = []
  setProjectRuntimeUrlResolver(async () => 'http://target-runtime:8080')
  globalThis.fetch = (async (url: string, init: any) => {
    forwarded.push({
      url: String(url),
      token: new Headers(init?.headers).get('x-runtime-token'),
      body: init?.body ? JSON.parse(init.body) : null,
    })
    return new Response(JSON.stringify(runtimeResponse.body), { status: runtimeResponse.status })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setProjectRuntimeUrlResolver(null)
})

describe('POST /projects/:projectId/remote-tool', () => {
  test('forwards a same-workspace call to the target runtime with its token and the caller id', async () => {
    const res = await remoteTool(
      w.projects.open,
      { tool: 'write_file', args: { path: 'a.txt', content: 'hi' }, callerProjectId: w.projects.restricted },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, result: { content: 'file body' } })
    expect(forwarded).toEqual([
      {
        url: 'http://target-runtime:8080/agent/remote/tool',
        token: deriveWorkspaceRuntimeToken(w.workspaceA),
        body: { tool: 'write_file', args: { path: 'a.txt', content: 'hi' }, callerProjectId: w.projects.restricted },
      },
    ])
  })

  test('403 cross_workspace when the target lives in another workspace', async () => {
    const res = await remoteTool(
      w.projects.foreign,
      { tool: 'read_file', args: { path: 'a.txt' } },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('cross_workspace')
    expect(forwarded).toEqual([])
  })

  test('a mutating tool needs project:update; a read-only tool needs only project:read', async () => {
    const viewer = { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.viewer) }
    const denied = await remoteTool(w.projects.open, { tool: 'write_file', args: { path: 'a.txt' } }, viewer)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('forbidden')
    expect(forwarded).toEqual([])

    const allowed = await remoteTool(w.projects.open, { tool: 'read_file', args: { path: 'a.txt' } }, viewer)
    expect(allowed.status).toBe(200)
    expect(forwarded).toHaveLength(1)
  })

  test('a person who cannot see the target gets the same 404 RBAC hides it with, even for read-only tools', async () => {
    const res = await remoteTool(
      w.projects.restricted,
      { tool: 'read_file', args: { path: 'a.txt' } },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.viewer) },
    )
    expect(res.status).toBe(404)
    expect(forwarded).toEqual([])
  })

  test('401 without a runtime token, or with a bad / other-workspace ticket', async () => {
    const noToken = await remoteTool(w.projects.open, { tool: 'read_file' }, { 'X-Requester-Ticket': ticketFor(w.users.member) })
    expect(noToken.status).toBe(401)

    const badToken = await remoteTool(w.projects.open, { tool: 'read_file' }, { 'x-runtime-token': 'wrt_v1_nope' })
    expect(badToken.status).toBe(401)

    const garbage = await remoteTool(
      w.projects.open,
      { tool: 'read_file' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': 'not-a-ticket' },
    )
    expect(garbage.status).toBe(401)
    expect(garbage.body.error.code).toBe('invalid_requester_ticket')

    const otherWorkspace = await remoteTool(
      w.projects.open,
      { tool: 'read_file' },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.ownerB, w.workspaceB) },
    )
    expect(otherWorkspace.status).toBe(401)
    expect(forwarded).toEqual([])
  })

  test('requires a requester when RBAC is on', async () => {
    const res = await remoteTool(w.projects.open, { tool: 'read_file' }, { 'x-runtime-token': tokenA })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('requester_required')
  })

  test('400 without a tool name', async () => {
    const res = await remoteTool(
      w.projects.open,
      { args: {} },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(400)
  })

  test('502 target_unavailable when the target runtime cannot be resolved', async () => {
    setProjectRuntimeUrlResolver(async () => {
      throw new Error('no live metal host available')
    })
    const res = await remoteTool(
      w.projects.open,
      { tool: 'read_file', args: { path: 'a.txt' } },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('target_unavailable')
    expect(forwarded).toEqual([])
  })

  test('passes the runtime status and body through (403 tool_not_remotable)', async () => {
    runtimeResponse = { status: 403, body: { ok: false, error: 'tool_not_remotable' } }
    const res = await remoteTool(
      w.projects.open,
      { tool: 'exec', args: { command: 'ls' } },
      { 'x-runtime-token': tokenA, 'X-Requester-Ticket': ticketFor(w.users.member) },
    )
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: 'tool_not_remotable' })
  })
})
