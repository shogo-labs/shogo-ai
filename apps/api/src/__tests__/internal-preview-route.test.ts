// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * POST /api/internal/workspaces/:ws/sessions/:session/projects/:id/preview
 *
 * SHO-125 §4c — the internal twin of the user-auth `preview-url` route. A
 * workspace runtime on metal has no route to another project's app (mounting
 * was removed), so `preview_project` asks this endpoint, which resolves that
 * project's own runtime, starts its build and returns `<podUrl>/p/<id>/`.
 *
 * Real runtime-token auth and real RBAC over the seeded sqlite world; only the
 * target runtime's HTTP surface is faked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'internal-preview-route-secret'

const { seedRbacWorld, db, _setRbacModeForTests } = await import('./helpers/rbac-world')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../routes/internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { deriveRuntimeToken } = await import('../lib/runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const { setProjectRuntimeUrlResolver } = await import('../services/agent-call.service')

type World = Awaited<ReturnType<typeof seedRbacWorld>>
const world: { value?: World } = {}

const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadAgentCall: () => import('../services/agent-call.service'),
})

let tokenA = ''
const realFetch = globalThis.fetch
let forwarded: Array<{ url: string; token: string | null; body: any }> = []
let runtimeResponse: { status: number; body: unknown } = { status: 200, body: { ok: true, phase: 'running' } }

const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const key of ['SHOGO_METAL_ENABLED', 'SHOGO_LOCAL_MODE', 'SHOGO_METAL_ALL_PROJECTS', 'WORKSPACE_ANCHOR_PROJECT_ID']) {
    savedEnv[key] = process.env[key]
  }
  _setRbacModeForTests('on')
  world.value = await seedRbacWorld()
  tokenA = deriveWorkspaceRuntimeToken(world.value.workspaceA)
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(() => {
  process.env.SHOGO_METAL_ENABLED = 'true'
  delete process.env.SHOGO_LOCAL_MODE
  delete process.env.SHOGO_METAL_ALL_PROJECTS
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
  runtimeResponse = { status: 200, body: { ok: true, phase: 'running' } }
  forwarded = []
  setProjectRuntimeUrlResolver(async () => 'http://target-pod:4000')
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

function ticketFor(userId: string): string {
  return signRequesterTicket({ projectId: workspaceTicketKey(world.value!.workspaceA), userId })
}

async function preview(
  projectId: string,
  opts: { token?: string | null; userId?: string; ticket?: string | null } = {},
): Promise<{ status: number; headers: Headers; body: any }> {
  const w = world.value!
  const ticket = opts.ticket === null ? null : opts.ticket ?? ticketFor(opts.userId ?? w.users.owner)
  const res = await app.request(
    `/workspaces/${w.workspaceA}/sessions/session-1/projects/${projectId}/preview`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token === null ? {} : { 'x-runtime-token': opts.token ?? tokenA }),
        ...(ticket ? { 'X-Requester-Ticket': ticket } : {}),
      },
      body: JSON.stringify({ userId: opts.userId ?? w.users.owner, sessionId: 'session-1' }),
    },
  )
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) }
}

describe('POST /workspaces/:ws/sessions/:session/projects/:id/preview', () => {
  test('401 without a runtime token', async () => {
    const res = await preview(world.value!.projects.restricted, { token: null })
    expect(res.status).toBe(401)
    expect(forwarded).toEqual([])
  })

  test('resolves the project runtime, starts its build there, and returns its /p/<id>/ url', async () => {
    const res = await preview(world.value!.projects.restricted)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      projectId: world.value!.projects.restricted,
      sessionId: 'session-1',
      mode: 'metal',
      url: `http://target-pod:4000/p/${world.value!.projects.restricted}/`,
      status: 'ready',
    })
    // Kicked the target's own /preview/start with the workspace token the API
    // derives for that hop.
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].url).toBe('http://target-pod:4000/preview/start')
    expect(forwarded[0].token).toBe(deriveWorkspaceRuntimeToken(world.value!.workspaceA))
    // The project token is NOT what a remote hop presents.
    expect(forwarded[0].token).not.toBe(deriveRuntimeToken(world.value!.projects.restricted))
  })

  test('answers `building` (not an error) while the target is still compiling', async () => {
    runtimeResponse = { status: 504, body: { error: { code: 'agent_call_timeout', message: 'still building' } } }
    const res = await preview(world.value!.projects.restricted)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('building')
    expect(res.body.url).toContain('/p/')
  })

  test('403 requester_required when the caller names no signed person', async () => {
    // A workspace runtime with no ticket cannot act as a claimed `userId`
    // while RBAC is enforced: the preview URL belongs to someone's project.
    const res = await preview(world.value!.projects.restricted, { ticket: null })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('requester_required')
    expect(forwarded).toEqual([])
  })

  test('404 project_not_attached for a project outside the workspace', async () => {
    const res = await preview(world.value!.projects.foreign)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('project_not_attached')
    expect(forwarded).toEqual([])
  })

  test('404 project_not_attached for an id that does not exist', async () => {
    const res = await preview('00000000-0000-4000-8000-000000000000')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('project_not_attached')
  })

  test('502 target_unavailable when the project runtime cannot be resolved', async () => {
    setProjectRuntimeUrlResolver(async () => {
      throw new Error('no live metal host available')
    })
    const res = await preview(world.value!.projects.restricted)
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('target_unavailable')
    expect(forwarded).toEqual([])
  })

  test('503 target_not_ready with Retry-After when the target is not listening yet', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }) as unknown as typeof fetch
    const res = await preview(world.value!.projects.restricted)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('target_not_ready')
    expect(res.headers.get('Retry-After')).toBe('2')
  })

  test('409 use_local_runtime for the anchor project, whose app this runtime serves itself', async () => {
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = world.value!.projects.restricted
    const res = await preview(world.value!.projects.restricted)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('use_local_runtime')
    expect(forwarded).toEqual([])
  })

  test('409 use_local_runtime when the substrate is not metal', async () => {
    delete process.env.SHOGO_METAL_ENABLED
    const res = await preview(world.value!.projects.restricted)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('use_local_runtime')
    expect(forwarded).toEqual([])
  })
})
