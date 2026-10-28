// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-125 acceptance — AC6: `preview_project` hands out a URL that answers 2xx.
 *
 * The dev's route spec fakes the target runtime's HTTP surface with a stubbed
 * global `fetch`, which cannot show that the URL the tool returns is fetchable.
 * This one stands up a REAL HTTP server as the project's pod — the only thing a
 * sandbox can substitute for a live metal host — drives the real internal route
 * (real runtime-token auth, real RBAC, sqlite world) and then fetches the URL
 * the route returned, exactly as `curl` would.
 *
 * What it proves: the URL is `<pod>/p/<id>/`, that pod serves it 2xx, and the
 * pod's own `/preview/start` was kicked on the same origin with the workspace
 * token. What it cannot prove (no metal host here): that a real guest's
 * `/preview/start` finishes building inside 75s.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'qa-sho125-preview-secret'

const { seedRbacWorld, db, _setRbacModeForTests } = await import('./helpers/rbac-world')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../routes/internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
const { signRequesterTicket, workspaceTicketKey } = await import('../lib/requester-ticket')
const { setProjectRuntimeUrlResolver } = await import('../services/agent-call.service')

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

  // The project's pod: an ordinary HTTP server that serves the app under
  // /p/<id>/ and accepts the build kick.
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

afterEach(() => {
  setProjectRuntimeUrlResolver(null)
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

describe('SHO-125 AC6 — the preview URL a metal workspace gets is a working URL', () => {
  test('returns <pod>/p/<id>/ and that URL answers 200 when fetched', async () => {
    const projectId = world.value!.projects.restricted
    const res = await preview(projectId)

    expect(res.status).toBe(200)
    expect(res.body.url).toBe(`${podOrigin}/p/${projectId}/`)

    // The AC as written: `curl <url>` answers 2xx. This is a real HTTP request
    // to a real server, not a stubbed fetch.
    const page = await fetch(res.body.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain(`served /p/${projectId}/`)
  })

  test('the build was kicked on that same pod, once, with the workspace token', async () => {
    const projectId = world.value!.projects.restricted
    await preview(projectId)

    expect(started).toHaveLength(1)
    expect(started[0].path).toBe('/preview/start')
    // A project pod now holds this token too (build-project-env.ts), so the
    // byte-compare fast path matches instead of an API round-trip per call.
    expect(started[0].token).toBe(deriveWorkspaceRuntimeToken(world.value!.workspaceA))
  })

  test('a project outside the workspace gets 404 project_not_attached, never the 410 mount message', async () => {
    const res = await preview(world.value!.projects.foreign)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('project_not_attached')
    expect(JSON.stringify(res.body)).not.toContain('mounting_removed')
    expect(started).toHaveLength(0)
  })
})
