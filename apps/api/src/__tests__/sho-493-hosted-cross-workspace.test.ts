// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-493: a cross-workspace call into a workspace hosted on a paired desktop.
 *
 * That workspace's boards, cards and chat live in **the desktop's SQLite**, so
 * the cloud cannot answer from Postgres — it forwards the call over the host's
 * tunnel, and the desktop accepts it narrowly:
 *
 *   A  the target list says a hosted workspace is reachable from the cloud, and
 *      carries its host (a desktop's own API still reports `desktop_hosted`)
 *   B  `forwardToHost` wakes the tunnel first, and only ever answers with the
 *      desktop's own status/body — `device_offline` + `lastSeenAt` when the
 *      host really is offline, never an empty 200
 *   C  the desktop accepts the forward (both headers, a workspace it holds, a
 *      member) and refuses it otherwise, attributing the call to its person
 *   D  `agent_runs_list` / `agent_run_stop` accept the Personal ticket instead
 *      of answering `requester_required` in a turn the person started
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
// Every env var this file changes is put back in `afterAll`: the api suite runs
// many files in one process, and a leaked `SHOGO_LOCAL_MODE` silently changes
// how the next file's routes resolve.
const originalEnv = {
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
}
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'sho-493-test-secret'

const { prisma } = await import('../lib/prisma')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { authenticateRuntimeToken, createInternalAuthorizers, scopeDenied, scopeRequesterUserId } = await import(
  '../routes/internal-runtime-auth'
)
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const { listCrossWorkspaceTargets } = await import('../services/cross-workspace-targets')
const { argsHash, authenticateHostedForward, forwardToHost, mintCrossWorkspaceApproval } = await import(
  '../lib/cross-workspace'
)

const db = prisma as any

let ownerId: string
let personalWorkspaceId: string
let hostedWorkspaceId: string
let cloudWorkspaceId: string
let hostInstanceId: string
let personalToken: string
let hostedBoardName: string

/** The instance-tunnel transport, faked: the wake answer and the answer/error. */
interface TunnelBehaviour {
  online: boolean
  /** What the wake answers when it is not `online` (SHO-506). */
  wake?: 'connecting' | 'offline'
  response?: { status: number; headers?: Record<string, string>; body?: string }
  error?: Error
}
let behaviour: TunnelBehaviour
const tunnelCalls: Array<{ instanceId: string; payload: any }> = []
const wakeCalls: Array<{ instanceId: string; staleProbeMs?: number; maxWaitMs?: number }> = []

const tunnel = {
  ensureTunnelConnected: async (instanceId: string, deadlineMs: number) => {
    wakeCalls.push({ instanceId, staleProbeMs: deadlineMs })
    return behaviour.online
  },
  wakeHostTunnel: async (instanceId: string, opts: { staleProbeMs?: number; maxWaitMs?: number } = {}) => {
    wakeCalls.push({ instanceId, ...opts })
    const state = behaviour.online ? ('connected' as const) : (behaviour.wake ?? ('offline' as const))
    return {
      state,
      instanceId,
      name: 'samasra',
      lastSeenAt: new Date(),
      retryAfterSeconds: state === 'connecting' ? 15 : 0,
    }
  },
  sendTunnelRequest: async (instanceId: string, payload: any) => {
    tunnelCalls.push({ instanceId, payload })
    if (behaviour.error) throw behaviour.error
    return behaviour.response ?? { status: 200, body: JSON.stringify({ reached: true }) }
  },
  sendTunnelStreamRequest: () => ({ cancel: () => undefined }),
  generateRequestId: () => `req-${tunnelCalls.length}`,
}

/** The desktop's own internal router, authenticated the way `create-local-app` does. */
const desktopApp = new Hono()
desktopApp.route(
  '/api/internal',
  runtimeInternalRoutes({
    authenticate: async (c, projectId) =>
      (await authenticateHostedForward(c, projectId)) ?? (await authenticateRuntimeToken(c, projectId)),
  }),
)

/** The cloud's internal router: real runtime-token auth, fake tunnel. */
const cloudApp = new Hono()
cloudApp.route('/api/internal', runtimeInternalRoutes({ authenticate: authenticateRuntimeToken, _hostTunnel: tunnel }))

const authorizers = createInternalAuthorizers(async (c, projectId) =>
  (await authenticateHostedForward(c, projectId)) ?? (await authenticateRuntimeToken(c, projectId)),
)

/** Reports who the authorizer says the call is for — the attribution rule. */
const attributionApp = new Hono()
attributionApp.all('/api/internal/workspaces/:workspaceId/probe', async (c) => {
  const ok = await authorizers.authorizeWorkspaceScope(c, c.req.param('workspaceId'))
  if (!ok) return scopeDenied(c)
  return c.json({ userId: scopeRequesterUserId(c) })
})

const lowerKeys = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))

const ticketFor = (workspaceId: string, userId: string) =>
  signRequesterTicket({ projectId: workspaceTicketKey(workspaceId), userId })

const forwardedHeaders = () => ({
  'x-tunnel-auth-user-id': ownerId,
  'X-Cross-Workspace-Hosted-From': personalWorkspaceId,
  'X-Cross-Workspace-Requester': ownerId,
})

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const owner = await db.user.create({ data: { name: 'owner', email: `hosted-${suffix}@example.com` } })
  ownerId = owner.id

  const personal = await db.workspace.create({
    data: { name: 'Personal', slug: `personal-hosted-${suffix}`, kind: 'personal', personalOwnerId: owner.id },
  })
  personalWorkspaceId = personal.id
  const cloud = await db.workspace.create({
    data: { name: 'Samsara Game', slug: `samsara-game-${suffix}`, kind: 'team' },
  })
  cloudWorkspaceId = cloud.id
  const host = await db.instance.create({
    data: {
      workspaceId: personal.id,
      userId: owner.id,
      name: 'samasra',
      hostname: 'samasra',
      os: 'darwin',
      status: 'online',
      lastSeenAt: new Date(),
      metadata: {},
    },
  })
  hostInstanceId = host.id
  const hosted = await db.workspace.create({
    data: { name: 'Samsara', slug: `samsara-hosted-${suffix}`, kind: 'team', hostInstanceId: hostInstanceId },
  })
  hostedWorkspaceId = hosted.id

  for (const workspaceId of [personal.id, cloud.id, hosted.id]) {
    await db.member.create({ data: { userId: owner.id, workspaceId, role: 'owner', projectId: null } })
  }

  personalToken = deriveWorkspaceRuntimeToken(personal.id)

  // The row only the hosted workspace's SQLite has: a read that answers with it
  // proves the desktop answered, not Postgres.
  hostedBoardName = `Hosted Board ${suffix}`
  await db.board.create({
    data: { workspaceId: hosted.id, name: hostedBoardName, slug: `hosted-${suffix}`, keyPrefix: 'HST' },
  })
})

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  behaviour = { online: true }
  tunnelCalls.length = 0
  wakeCalls.length = 0
})

describe('A · the target list', () => {
  const withMode = async (mode: 'cloud' | 'local', fn: () => Promise<void> | void) => {
    const previous = process.env.SHOGO_LOCAL_MODE
    if (mode === 'cloud') delete process.env.SHOGO_LOCAL_MODE
    else process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      await fn()
    } finally {
      if (previous === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = previous
    }
  }

  test('from the cloud a hosted workspace is reachable, with its host', async () => {
    await withMode('cloud', async () => {
      const targets = await listCrossWorkspaceTargets(ownerId, personalWorkspaceId)
      const hosted = targets.find((t) => t.id === hostedWorkspaceId)
      expect(hosted).toBeTruthy()
      expect(hosted!.source).toBe('desktop')
      expect(hosted!.reachable).toBe(true)
      expect(hosted!.unreachableReason).toBeUndefined()
      expect(hosted!.host).toEqual({
        instanceId: hostInstanceId,
        name: 'samasra',
        online: true,
        lastSeenAt: (await db.instance.findUnique({ where: { id: hostInstanceId } })).lastSeenAt.toISOString(),
      })
    })
  })

  test('a host reporting offline is still listed reachable: the call wakes it', async () => {
    await withMode('cloud', async () => {
      const longAgo = new Date(Date.now() - 60 * 60_000)
      await db.instance.update({ where: { id: hostInstanceId }, data: { status: 'offline', lastSeenAt: longAgo } })
      try {
        const hosted = (await listCrossWorkspaceTargets(ownerId, personalWorkspaceId)).find((t) => t.id === hostedWorkspaceId)
        expect(hosted!.reachable).toBe(true)
        expect(hosted!.host!.online).toBe(false)
        expect(hosted!.host!.lastSeenAt).toBe(longAgo.toISOString())
      } finally {
        await db.instance.update({ where: { id: hostInstanceId }, data: { status: 'online', lastSeenAt: new Date() } })
      }
    })
  })

  test('from a desktop the same workspace is desktop_hosted, not reachable', async () => {
    await withMode('local', async () => {
      const hosted = (await listCrossWorkspaceTargets(ownerId, personalWorkspaceId)).find((t) => t.id === hostedWorkspaceId)
      expect(hosted!.reachable).toBe(false)
      expect(hosted!.unreachableReason).toBe('desktop_hosted')
    })
  })
})

describe('B · forwarding over the host tunnel', () => {
  // Forwarding is the cloud's job; the desktop refuses it (last test here).
  beforeEach(() => {
    delete process.env.SHOGO_LOCAL_MODE
  })

  const call = (path = `/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`) =>
    new Hono()
      .all('/api/internal/workspaces/:workspaceId/*', (c) =>
        forwardToHost(
          c,
          { hostInstanceId: hostInstanceId, requesterUserId: ownerId, callerWorkspaceId: personalWorkspaceId, tool: 'board_list' },
          { _tunnel: tunnel, _wakeDeadlineMs: 25 },
        ),
      )
      .request(`http://local${path}?includeArchived=true`)

  test('an online host answers with the desktop’s own status and body', async () => {
    const desktopBody = JSON.stringify({ boards: [{ id: 'desk-only', name: hostedBoardName }] })
    behaviour = { online: true, response: { status: 200, body: desktopBody, headers: { 'content-type': 'application/json' } } }

    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(desktopBody)

    // The wake is capped at the interactive window so the forward cannot run
    // past the edge's budget (SHO-538).
    expect(wakeCalls[0]).toEqual({ instanceId: hostInstanceId, staleProbeMs: 25, maxWaitMs: 20_000 })
    expect(tunnelCalls).toHaveLength(1)
    const sent = tunnelCalls[0].payload
    // The desktop's local API, same path, same query — not the agent proxy.
    expect(sent.path).toBe(`/api/internal/workspaces/${hostedWorkspaceId}/agent-boards?includeArchived=true`)
    expect(sent.method).toBe('GET')
    // Identity on the far side: the host's owner, the person it is for, and the
    // workspace it was made from.
    const sentHeaders = lowerKeys(sent.headers)
    expect(sentHeaders['x-tunnel-auth-user-id']).toBe(ownerId)
    expect(sentHeaders['x-cross-workspace-hosted-from']).toBe(personalWorkspaceId)
    expect(sentHeaders['x-cross-workspace-requester']).toBe(ownerId)
    expect(sentHeaders['x-cross-workspace-tool']).toBe('board_list')
  })

  test('a body is forwarded as text, with its content type', async () => {
    behaviour = { online: true, response: { status: 201, body: JSON.stringify({ created: true }) } }
    const probe = new Hono().all('/api/internal/workspaces/:workspaceId/*', (c) =>
      forwardToHost(
        c,
        { hostInstanceId: hostInstanceId, requesterUserId: ownerId, callerWorkspaceId: personalWorkspaceId },
        { _tunnel: tunnel, _wakeDeadlineMs: 25 },
      ),
    )
    const res = await probe.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'from the cloud' }),
    })
    expect(res.status).toBe(201)
    expect(tunnelCalls[0].payload.body).toBe(JSON.stringify({ name: 'from the cloud' }))
    expect(lowerKeys(tunnelCalls[0].payload.headers)['content-type']).toBe('application/json')
  })

  test('a host that does not wake answers device_offline with its name and last seen', async () => {
    behaviour = { online: false }
    const res = await call()
    expect(res.status).toBe(503)
    const body = (await res.json<any>()).error
    expect(body.code).toBe('device_offline')
    expect(body.message).toContain('samasra')
    expect(body.message).toContain('last seen')
    expect(body.instanceId).toBe(hostInstanceId)
    expect(typeof body.lastSeenAt).toBe('string')
    expect(tunnelCalls).toHaveLength(0)
  })

  test('a host that is up but still opening answers a retryable device_connecting', async () => {
    // The machine polled seconds ago; its tunnel just missed the wake window
    // (SHO-506). Calling that `device_offline` is what made a cloud agent tell the
    // user their Mac was off.
    behaviour = { online: false, wake: 'connecting' }
    const res = await call()
    expect(res.status).toBe(503)
    const body = (await res.json<any>()).error
    expect(body.code).toBe('device_connecting')
    expect(body.retryable).toBe(true)
    expect(body.retryAfterSeconds).toBe(15)
    expect(body.message).toContain('still opening')
    expect(body.instanceId).toBe(hostInstanceId)
    // Nothing was forwarded, and the host was told what it can do next.
    expect(tunnelCalls).toHaveLength(0)
  })

  test('a tunnel that dies mid-request saying offline is device_offline, not a 200', async () => {
    behaviour = { online: true, error: new Error('Instance is offline') }
    const res = await call()
    expect(res.status).toBe(503)
    expect((await res.json<any>()).error.code).toBe('device_offline')
  })

  test('any other tunnel failure is device_tunnel_error, never an empty 200', async () => {
    behaviour = { online: true, error: new Error('Proxy request timed out') }
    const res = await call()
    expect(res.status).toBe(502)
    const body = (await res.json<any>()).error
    expect(body.code).toBe('device_tunnel_error')
    expect(body.instanceId).toBe(hostInstanceId)
  })

  test('a desktop does not forward: it answers desktop_hosted, without touching a tunnel', async () => {
    // Not a reachable path in practice — the desktop's own API refuses first —
    // but the guard is what keeps the transport out of its bundle.
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      const res = await call()
      expect(res.status).toBe(503)
      const body = (await res.json<any>()).error
      expect(body.code).toBe('desktop_hosted')
      expect(body.message).toContain('Shogo Cloud')
      expect(wakeCalls).toHaveLength(0)
      expect(tunnelCalls).toHaveLength(0)
    } finally {
      delete process.env.SHOGO_LOCAL_MODE
    }
  })
})

describe('C · the desktop accepts the forward', () => {
  beforeEach(() => {
    process.env.SHOGO_LOCAL_MODE = 'true'
  })

  test('a read answers from the desktop’s own SQLite, attributed to its person', async () => {
    const res = await desktopApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`, {
      headers: forwardedHeaders(),
    })
    expect(res.status).toBe(200)
    const body = await res.json<any>()
    expect((body.boards ?? []).map((b: any) => b.name)).toContain(hostedBoardName)

    const who = await attributionApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/probe`, {
      headers: forwardedHeaders(),
    })
    expect(who.status).toBe(200)
    expect(await who.json()).toEqual({ userId: ownerId })
  })

  test('without the tunnel user header it is refused', async () => {
    const res = await desktopApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`, {
      headers: { 'X-Cross-Workspace-Hosted-From': personalWorkspaceId, 'X-Cross-Workspace-Requester': ownerId },
    })
    expect(res.status).toBe(401)
  })

  test('without the hosted-from header it is refused', async () => {
    const res = await desktopApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`, {
      headers: { 'x-tunnel-auth-user-id': ownerId },
    })
    expect(res.status).toBe(401)
  })

  test('the pair of headers is not accepted on any other internal path', async () => {
    const fake = (path: string) => ({
      req: { path, method: 'GET', header: (name: string) => (forwardedHeaders() as any)[name] },
    })
    for (const path of [
      '/api/internal/devices/inst-1/remote-tool',
      `/api/internal/projects/proj-1/agent-call`,
      '/api/internal/workspaces',
    ]) {
      expect(await authenticateHostedForward(fake(path))).toBeNull()
    }
    expect(await authenticateHostedForward(fake(`/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`))).toEqual({
      kind: 'workspace',
      workspaceId: hostedWorkspaceId,
    })
  })

  test('a workspace this desktop does not hold is refused', async () => {
    const res = await desktopApp.request('http://local/api/internal/workspaces/not-a-workspace-here/agent-boards', {
      headers: forwardedHeaders(),
    })
    expect(res.status).toBe(401)
  })

  test('a requester who is not a member is refused', async () => {
    const stranger = await db.user.create({ data: { name: 'stranger', email: `stranger-${crypto.randomUUID().slice(0, 8)}@example.com` } })
    const res = await desktopApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`, {
      headers: { ...forwardedHeaders(), 'X-Cross-Workspace-Requester': stranger.id },
    })
    expect(res.status).toBe(401)
  })

  test('a cloud-mode API refuses the same headers', async () => {
    delete process.env.SHOGO_LOCAL_MODE
    try {
      expect(await authenticateHostedForward({ req: {
        path: `/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`,
        method: 'GET',
        header: (name: string) => (forwardedHeaders() as any)[name],
      } })).toBeNull()
      const res = await cloudApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`, {
        headers: forwardedHeaders(),
      })
      expect(res.status).toBe(401)
    } finally {
      process.env.SHOGO_LOCAL_MODE = 'true'
    }
  })
})

describe('D · agent_runs_list / agent_run_stop take the Personal ticket', () => {
  beforeEach(() => {
    delete process.env.SHOGO_LOCAL_MODE
  })

  test('a Personal agent lists runs in another cloud workspace', async () => {
    const res = await cloudApp.request(`http://local/api/internal/workspaces/${cloudWorkspaceId}/agent-channels/running-agents`, {
      headers: { 'x-runtime-token': personalToken, 'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId) },
    })
    expect(res.status).toBe(200)
    const body = await res.json<any>()
    expect(Array.isArray(body.runs)).toBe(true)
  })

  test('stopping there gets past the requester check', async () => {
    // A stop is a write, so it carries the approval its person gave — spent
    // here, in the cloud, before the route runs.
    const hash = argsHash({})
    const minted = await mintCrossWorkspaceApproval({
      callerWorkspaceId: personalWorkspaceId,
      targetWorkspaceId: cloudWorkspaceId,
      tool: 'agent_run_stop',
      argsHash: hash,
      requesterUserId: ownerId,
    })
    const res = await cloudApp.request(`http://local/api/internal/workspaces/${cloudWorkspaceId}/agent-channels/running-agents/stop`, {
      method: 'POST',
      headers: {
        'x-runtime-token': personalToken,
        'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId),
        'X-Cross-Workspace-Approval': minted.id,
        'X-Cross-Workspace-Tool': 'agent_run_stop',
        'X-Cross-Workspace-Args-Hash': hash,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    // Past the person check: the refusal is about the missing target, not the ticket.
    expect(res.status).toBe(400)
    expect((await res.json<any>()).error.code).toBe('invalid_input')
  })

  test('with no ticket it is still refused, naming the requester', async () => {
    // In its own workspace that is the route's own `requester_required`.
    const own = await cloudApp.request(`http://local/api/internal/workspaces/${cloudWorkspaceId}/agent-channels/running-agents`, {
      headers: { 'x-runtime-token': deriveWorkspaceRuntimeToken(cloudWorkspaceId) },
    })
    expect(own.status).toBe(403)
    expect((await own.json<any>()).error.code).toBe('requester_required')

    // Across a workspace boundary it is the authorizer's — a ticket it can read.
    const cross = await cloudApp.request(`http://local/api/internal/workspaces/${cloudWorkspaceId}/agent-channels/running-agents`, {
      headers: { 'x-runtime-token': personalToken },
    })
    expect(cross.status).toBe(403)
    expect((await cross.json<any>()).error.code).toBe('requester_ticket_required')
  })

  test('a project token is still workspace_agent_only', async () => {
    const project = await db.project.create({
      data: { name: `p-${crypto.randomUUID().slice(0, 8)}`, workspaceId: cloudWorkspaceId },
    })
    const res = await cloudApp.request(`http://local/api/internal/workspaces/${cloudWorkspaceId}/agent-channels/running-agents`, {
      headers: { 'x-runtime-token': deriveRuntimeToken(project.id) },
    })
    expect(res.status).toBe(403)
    expect((await res.json<any>()).error.code).toBe('workspace_agent_only')
  })

  test('a desktop’s own API will not answer for a hosted workspace', async () => {
    // Its SQLite does not hold that workspace's boards: only the cloud can
    // forward, so it says so instead of answering from the wrong database.
    process.env.SHOGO_LOCAL_MODE = 'true'
    const res = await desktopApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-boards`, {
      headers: { 'x-runtime-token': personalToken, 'X-Requester-Ticket': ticketFor(personalWorkspaceId, ownerId) },
    })
    expect(res.status).toBe(503)
    const body = (await res.json<any>()).error
    expect(body.code).toBe('desktop_hosted')
    expect(body.message).toContain('Shogo Cloud')
  })

  test('the desktop answers a forwarded runs call without a Personal ticket', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    const res = await desktopApp.request(`http://local/api/internal/workspaces/${hostedWorkspaceId}/agent-channels/running-agents`, {
      headers: forwardedHeaders(),
    })
    expect(res.status).toBe(200)
    expect(Array.isArray((await res.json<any>()).runs)).toBe(true)
  })
})
