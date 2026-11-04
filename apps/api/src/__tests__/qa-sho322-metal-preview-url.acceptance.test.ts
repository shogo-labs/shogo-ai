// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-322 acceptance — the link a metal workspace hands a person.
 *
 * Prod incident: a user was given
 * `http://103.219.171.29:20011/p/<id>/ani-1-en-captions.mp4` — a metal box's
 * public DNAT address on an internal port, not a URL anybody can open. The
 * API resolved the project's runtime and returned that origin as the
 * user-facing link.
 *
 * This test drives the REAL internal preview route (real runtime-token auth,
 * real RBAC over the seeded sqlite world, a REAL HTTP server standing in for
 * the project's pod) with a preview domain configured, exactly like prod, and
 * checks the two halves of the contract:
 *
 *   1. the URL handed out is the project's `https://<id>.preview.<base>` origin,
 *      with no host:port of the runtime anywhere in the response; and
 *   2. the internal `/preview/start` hop still goes to the runtime URL the
 *      route resolved (the pod is the only thing that can hear it).
 *
 * The staging leg of the card (open the returned URL through the preview
 * Worker and see 2xx) cannot run in this sandbox — there is no metal host and
 * no Cloudflare route here — so it stays a manual check on the card.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'qa-sho322-preview-secret'
// A configured preview domain is what makes this a cloud/metal deployment.
// It must be set before the modules below read it at import time.
process.env.PREVIEW_BASE_DOMAIN = 'preview.test'

const { seedRbacWorld, db, _setRbacModeForTests } = await import('./helpers/rbac-world')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../routes/internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const { setProjectRuntimeUrlResolver } = await import('../services/agent-call.service')
const { getPreviewUrl } = await import('../lib/knative-project-manager')

type World = Awaited<ReturnType<typeof seedRbacWorld>>
const world: { value?: World } = {}

const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadAgentCall: () => import('../services/agent-call.service'),
})

const savedEnv: Record<string, string | undefined> = {}
let started: Array<{ path: string; token: string | null }> = []
let pod: ReturnType<typeof Bun.serve> | null = null
let podOrigin = ''

beforeAll(async () => {
  for (const key of ['SHOGO_METAL_ENABLED', 'SHOGO_LOCAL_MODE', 'SHOGO_METAL_ALL_PROJECTS', 'WORKSPACE_ANCHOR_PROJECT_ID']) {
    savedEnv[key] = process.env[key]
  }
  _setRbacModeForTests('on')
  world.value = await seedRbacWorld()

  // The project's runtime. What matters here is that it answers on a raw
  // `127.0.0.1:<port>` origin — the shape of a metal box's DNAT address.
  pod = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/preview/start') {
        started.push({ path: url.pathname, token: req.headers.get('x-runtime-token') })
        return Response.json({ ok: true, phase: 'running' })
      }
      if (url.pathname.startsWith('/p/') && url.pathname.endsWith('/')) {
        return new Response(`<!doctype html><title>app</title><body>served ${url.pathname}</body>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  podOrigin = `http://127.0.0.1:${pod.port}`
})

afterAll(async () => {
  _setRbacModeForTests(null)
  await db.$disconnect?.()
  pod?.stop(true)
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
  started = []
  setProjectRuntimeUrlResolver(async () => podOrigin)
})

async function preview(projectId: string): Promise<{ status: number; body: any }> {
  const w = world.value!
  const res = await app.request(`/workspaces/${w.workspaceA}/sessions/session-1/projects/${projectId}/preview`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-runtime-token': deriveWorkspaceRuntimeToken(w.workspaceA),
      'X-Requester-Ticket': signRequesterTicket({ projectId: workspaceTicketKey(w.workspaceA), userId: w.users.owner }),
    },
    body: JSON.stringify({ userId: w.users.owner, sessionId: 'session-1' }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('SHO-322 AC1 — a metal preview link is the project preview origin, never the box address', () => {
  test('answers the https preview origin with the project path', async () => {
    const projectId = world.value!.projects.restricted
    const res = await preview(projectId)

    expect(res.status).toBe(200)
    expect(res.body.url).toBe(`${getPreviewUrl(projectId)}/p/${projectId}/`)
    expect(res.body.url.startsWith('https://')).toBe(true)
    expect(new URL(res.body.url).host.startsWith(`${projectId}.preview.`)).toBe(true)
  })

  test('the resolved runtime origin appears nowhere in the response', async () => {
    const projectId = world.value!.projects.restricted
    const res = await preview(projectId)
    const serialized = JSON.stringify(res.body)

    expect(serialized).not.toContain(podOrigin)
    expect(serialized).not.toContain(`:${pod!.port}`)
    expect(serialized).not.toContain('127.0.0.1')
    // The old shape: a bare http origin with a DNAT port and `/p/<id>/` after it.
    expect(res.body.url).not.toMatch(/^http:\/\//)
  })

  test('only the origin changed: the path is still the app the runtime serves', async () => {
    const projectId = world.value!.projects.restricted
    const res = await preview(projectId)

    // Same `/p/<id>/` the project's own runtime answers on — so the person
    // reaches the same app, just through the preview domain instead of the box.
    const direct = await fetch(`${podOrigin}/p/${projectId}/`)
    expect(direct.status).toBe(200)
    expect(new URL(res.body.url).pathname).toBe(new URL(direct.url).pathname)
  })

  test('the internal /preview/start hop still goes to the runtime URL, once', async () => {
    await preview(world.value!.projects.restricted)

    expect(started).toHaveLength(1)
    expect(started[0].path).toBe('/preview/start')
    expect(started[0].token).toBe(deriveWorkspaceRuntimeToken(world.value!.workspaceA))
  })
})
