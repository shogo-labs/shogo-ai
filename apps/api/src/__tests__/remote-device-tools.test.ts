// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /api/internal/devices` and `POST /api/internal/devices/:instanceId/remote-tool`
 * — a paired computer is reachable only by the person it belongs to, from their
 * own Personal workspace, with a signed requester ticket (SHO-329).
 *
 * Real runtime-token auth, real requester tickets and the seeded sqlite world;
 * only the instance tunnel is faked, so the test sees exactly the URL and body
 * the desktop would receive.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'device-tools-secret'

// The helper flags local mode so `lib/prisma` builds a SQLite client; bind it
// first, then clear the flag so the routes below take their cloud branches
// (tunnel registry) instead of the desktop relay.
const { prisma: deviceDb } = await import('../lib/prisma')
delete process.env.SHOGO_LOCAL_MODE

let tunnelUp = true
const tunneled: Array<{ url: string; headers: Headers; body: any }> = []

mock.module('../routes/instances', () => ({
  ensureTunnelConnected: async () => tunnelUp,
}))

const { seedRbacWorld, db, _setRbacModeForTests } = await import('./helpers/rbac-world')
const deviceClient = deviceDb as any
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../routes/internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')

const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadAgentCall: () => import('../services/agent-call.service'),
})

type World = Awaited<ReturnType<typeof seedRbacWorld>>
let w: World
/** The owner's own Personal workspace: the only place device tools run from. */
let personal: string
let ownerDevice: string
let memberDevice: string
const realFetch = globalThis.fetch

function ticketFor(userId: string, workspaceId: string): string {
  return signRequesterTicket({ projectId: workspaceTicketKey(workspaceId), userId })
}

function runtimeHeaders(workspaceId: string, ticket?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-runtime-token': deriveWorkspaceRuntimeToken(workspaceId),
    ...(ticket ? { 'X-Requester-Ticket': ticket } : {}),
  }
}

async function listDevices(
  workspaceId: string,
  ticket?: string,
): Promise<{ status: number; body: any }> {
  const res = await app.request('/devices', { headers: runtimeHeaders(workspaceId, ticket) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function remoteTool(
  workspaceId: string,
  instanceId: string,
  body: Record<string, unknown>,
  ticket?: string,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/devices/${instanceId}/remote-tool`, {
    method: 'POST',
    headers: runtimeHeaders(workspaceId, ticket),
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeAll(async () => {
  _setRbacModeForTests('on')
  w = await seedRbacWorld()
  const suffix = crypto.randomUUID().slice(0, 8)
  const personalRow = await db.workspace.create({
    data: { name: 'Personal', slug: `personal-${suffix}`, kind: 'personal' },
  })
  personal = personalRow.id
  await db.member.create({ data: { userId: w.users.owner, workspaceId: personal, role: 'owner' } })

  ownerDevice = (
    await db.instance.create({
      data: {
        workspaceId: personal,
        userId: w.users.owner,
        name: "Russell's MacBook",
        hostname: 'macbook',
        os: 'darwin',
        status: 'online',
        lastSeenAt: new Date(),
        metadata: { homeDir: '/Users/russell' },
      },
    })
  ).id
  memberDevice = (
    await db.instance.create({
      data: {
        workspaceId: w.workspaceA,
        userId: w.users.member,
        name: "Sam's ThinkPad",
        hostname: 'thinkpad',
        os: 'linux',
        status: 'online',
        lastSeenAt: new Date(),
        metadata: { homeDir: '/home/sam' },
      },
    })
  ).id
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await deviceClient.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  tunnelUp = true
  tunneled.length = 0
  globalThis.fetch = (async (url: string, init: any) => {
    tunneled.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'ran' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

// ---------------------------------------------------------------------------
// GET /devices
// ---------------------------------------------------------------------------

describe('GET /devices', () => {
  test('lists only the requester’s own devices, and never their folders', async () => {
    const owner = await listDevices(personal, ticketFor(w.users.owner, personal))
    expect(owner.status).toBe(200)
    expect(owner.body.devices).toHaveLength(1)
    expect(owner.body.devices[0].id).toBe(ownerDevice)
    expect(owner.body.devices[0].name).toBe("Russell's MacBook")
    expect(owner.body.devices[0]).not.toHaveProperty('homeDir')
    expect(JSON.stringify(owner.body)).not.toContain('/Users/russell')

    const member = await listDevices(w.workspaceA, ticketFor(w.users.member, w.workspaceA))
    expect(member.status).toBe(200)
    expect(member.body.devices.map((d: any) => d.id)).toEqual([memberDevice])
    expect(member.body.devices[0]).not.toHaveProperty('homeDir')
  })

  test('refuses a ticket from another workspace, and lists nothing without a person', async () => {
    const outsider = await listDevices(personal, ticketFor(w.users.member, w.workspaceA))
    expect(outsider.status).toBe(401)
    expect(outsider.body.error.code).toBe('invalid_requester_ticket')

    const anonymous = await listDevices(w.workspaceA)
    expect(anonymous.status).toBe(200)
    expect(anonymous.body.devices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// POST /devices/:instanceId/remote-tool
// ---------------------------------------------------------------------------

describe('POST /devices/:instanceId/remote-tool', () => {
  test('401 requester_required with no ticket — a turn with nobody behind it cannot reach a computer', async () => {
    const res = await remoteTool(personal, ownerDevice, { tool: 'exec', args: { command: 'ls' } })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('requester_required')
    expect(tunneled).toEqual([])
  })

  test("403 device_not_yours when the ticket is for someone else's computer", async () => {
    const res = await remoteTool(
      w.workspaceA,
      ownerDevice,
      { tool: 'read_file', args: { path: 'notes.md' } },
      ticketFor(w.users.member, w.workspaceA),
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('device_not_yours')
    expect(tunneled).toEqual([])
  })

  test('403 device_tools_personal_only from a team workspace, even for your own computer', async () => {
    const res = await remoteTool(
      w.workspaceA,
      ownerDevice,
      { tool: 'read_file', args: { path: 'notes.md' } },
      ticketFor(w.users.owner, w.workspaceA),
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('device_tools_personal_only')
    expect(tunneled).toEqual([])
  })

  test('the owner’s ticket in their Personal workspace reaches their own computer over the tunnel', async () => {
    const res = await remoteTool(
      personal,
      ownerDevice,
      { tool: 'read_file', args: { path: 'notes.md' } },
      ticketFor(w.users.owner, personal),
    )
    expect(res.status).toBe(200)
    expect(tunneled).toHaveLength(1)
    const call = tunneled[0]!
    expect(call.url).toContain(`/api/internal/host-tunnel/`)
    expect(call.url).toContain(encodeURIComponent(ownerDevice))
    expect(call.url).toContain(`/api/workspaces/${personal}/agent-proxy/agent/remote/tool`)
    expect(call.body).toEqual({ tool: 'read_file', args: { path: 'notes.md' } })
    expect(call.headers.get('x-shogo-remote-device')).toBe('1')
    expect(call.headers.get('x-shogo-remote-requester')).toBe(w.users.owner)
  })

  test('answers device_offline with the last-seen time instead of hanging', async () => {
    tunnelUp = false
    const res = await remoteTool(
      personal,
      ownerDevice,
      { tool: 'read_file', args: { path: 'notes.md' } },
      ticketFor(w.users.owner, personal),
    )
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('device_offline')
    expect(res.body.error.lastSeenAt).toBeTruthy()
    expect(tunneled).toEqual([])
  })

  test('404 for an unknown device, 400 for a call with no tool', async () => {
    const missing = await remoteTool(
      personal,
      'inst_does_not_exist',
      { tool: 'read_file', args: { path: 'notes.md' } },
      ticketFor(w.users.owner, personal),
    )
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('device_not_found')

    const noTool = await remoteTool(personal, ownerDevice, { args: {} }, ticketFor(w.users.owner, personal))
    expect(noTool.status).toBe(400)
    expect(tunneled).toEqual([])
  })
})
