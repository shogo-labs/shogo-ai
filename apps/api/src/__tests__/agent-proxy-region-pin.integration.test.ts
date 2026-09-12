// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for the "Plan not found" 404 seen in production multi-region
 * deployments (see `docs/prod-e2e-findings-2026-08.md` and the `resolve-pod-url`
 * SHOGO_WORKSPACE_RUNTIME fix — this covers the OTHER split: plain per-project
 * chat, no merged-root workspace runtime involved).
 *
 * Root cause: `/api/projects/:id/agent-proxy/*` had no region affinity, while
 * `/api/projects/:id/chat*` is pinned to the project's home region via
 * `pinChatToHomeRegion`. In an active-active multi-region deployment the two
 * can land on different regions for the same project: a plan created via a
 * chat turn pinned to the home region is written to that region's
 * agent-runtime pod's local disk (`.shogo/plans/*.plan.md`); an unpinned
 * agent-proxy GET landing on a peer region resolves (or cold-spawns) a
 * DIFFERENT pod there with an empty `.shogo/plans/`, so the Plans panel's
 * `GET .../agent-proxy/agent/plans/:filename` 404s even though the plan
 * genuinely exists — just on the other pod.
 *
 * This boots two live Bun HTTP servers ("home" owns the plan file, "edge" is
 * a peer region the request lands on) and proves the fixed route — which
 * calls the same `pinChatToHomeRegion` chat already uses — forwards the
 * request to home instead of 404ing locally.
 *
 *   bun test apps/api/src/__tests__/agent-proxy-region-pin.integration.test.ts
 */

import { describe, test, expect, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'

const HOME_REGION = 'home-1'
const EDGE_REGION = 'edge-1'

const PLAN_FILENAME = 'redesign-landing-page_abc123.plan.md'
const PLAN_BODY = JSON.stringify({
  filename: PLAN_FILENAME,
  content: '---\nname: "Redesign landing page"\n---\n# Plan body',
})

// ─── The HOME region server (owns the project's agent-runtime pod / disk) ──
const homeSeen: Array<{ path: string; proxied: boolean }> = []

const homeApp = new Hono()
homeApp.get('/api/projects/:projectId/agent-proxy/agent/plans/:filename', (c) => {
  homeSeen.push({
    path: c.req.path,
    proxied: c.req.header('x-shogo-home-region-proxy') === '1',
  })
  if (c.req.param('filename') !== PLAN_FILENAME) {
    return c.json({ error: 'Plan not found' }, 404)
  }
  return c.json(JSON.parse(PLAN_BODY))
})
homeApp.get('/api/projects/:projectId/agent-proxy/agent/plans', (c) => {
  homeSeen.push({ path: c.req.path, proxied: c.req.header('x-shogo-home-region-proxy') === '1' })
  return c.json({ plans: [{ filename: PLAN_FILENAME }] })
})

const homeServer = Bun.serve({ port: 0, fetch: homeApp.fetch })
const HOME_URL = `http://127.0.0.1:${homeServer.port}`

// ─── Region + prisma config for the EDGE process (set BEFORE importing) ─────
process.env.REGION_ID = EDGE_REGION
process.env.REGION_PEERS = JSON.stringify([{ id: HOME_REGION, label: 'Home', url: HOME_URL }])
process.env.HOST_HEADER_FOR_PEERS = 'studio.shogo.ai'
delete process.env.CHAT_REGION_PIN

const projects: Record<string, { workspaceId: string } | null> = {
  proj_home: { workspaceId: 'ws_home' }, // owned by the home region (peer) → proxy
  proj_local: { workspaceId: 'ws_local' }, // owned by THIS edge region → local
}
const workspaces: Record<string, { homeRegion: string | null } | null> = {
  ws_home: { homeRegion: HOME_REGION },
  ws_local: { homeRegion: EDGE_REGION },
}
mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in projects ? projects[id] : null,
    },
    workspace: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in workspaces ? workspaces[id] : null,
    },
  },
}))

// Import the REAL helper (pulls in the REAL region + proxy config).
const { pinChatToHomeRegion } = await import('../lib/chat-region-pin')

// ─── The EDGE region server — mirrors the fixed `agent-proxy` route in
// server.ts: pin first, fall through to a local stub (simulating this
// region's own, potentially-empty, project pod) otherwise. ─────────────────
const edgeLocalHits: string[] = []
const edgeApp = new Hono()
edgeApp.all('/api/projects/:projectId/agent-proxy/*', async (c) => {
  const projectId = c.req.param('projectId')
  const pinned = await pinChatToHomeRegion(c, projectId)
  if (pinned) return pinned
  // Local serve: this region's own (empty, in this test) pod for the project.
  edgeLocalHits.push(c.req.path)
  if (c.req.path.endsWith('/agent/plans')) return c.json({ plans: [] })
  return c.json({ error: 'Plan not found' }, 404)
})

const edgeServer = Bun.serve({ port: 0, fetch: edgeApp.fetch })
const EDGE_URL = `http://127.0.0.1:${edgeServer.port}`

afterAll(() => {
  homeServer.stop(true)
  edgeServer.stop(true)
})

describe('agent-proxy region pinning — plan 404 regression (real cross-region HTTP proxy)', () => {
  test('a plan-detail GET landing on the edge region is served by the home pod instead of 404ing locally', async () => {
    homeSeen.length = 0
    edgeLocalHits.length = 0

    const res = await fetch(
      `${EDGE_URL}/api/projects/proj_home/agent-proxy/agent/plans/${PLAN_FILENAME}`,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.filename).toBe(PLAN_FILENAME)
    expect(body.content).toContain('Redesign landing page')

    // Served by home, proxied, never fell through to the edge's local (empty) pod.
    expect(homeSeen).toHaveLength(1)
    expect(homeSeen[0].proxied).toBe(true)
    expect(edgeLocalHits).toHaveLength(0)
  })

  test('a plans-list GET landing on the edge region also proxies to home (not an empty local list)', async () => {
    homeSeen.length = 0
    edgeLocalHits.length = 0

    const res = await fetch(`${EDGE_URL}/api/projects/proj_home/agent-proxy/agent/plans`)

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.plans).toEqual([{ filename: PLAN_FILENAME }])
    expect(edgeLocalHits).toHaveLength(0)
  })

  test('a same-region request is served locally (never proxied)', async () => {
    homeSeen.length = 0
    edgeLocalHits.length = 0

    const res = await fetch(
      `${EDGE_URL}/api/projects/proj_local/agent-proxy/agent/plans/${PLAN_FILENAME}`,
    )

    expect(res.status).toBe(404)
    expect(homeSeen).toHaveLength(0)
    expect(edgeLocalHits).toEqual([`/api/projects/proj_local/agent-proxy/agent/plans/${PLAN_FILENAME}`])
  })

  test('an already-proxied request (loop guard) is handled locally, never re-proxied', async () => {
    homeSeen.length = 0
    edgeLocalHits.length = 0

    const res = await fetch(
      `${EDGE_URL}/api/projects/proj_home/agent-proxy/agent/plans/${PLAN_FILENAME}`,
      { headers: { 'x-shogo-home-region-proxy': '1' } },
    )

    expect(res.status).toBe(404)
    expect(homeSeen).toHaveLength(0)
    expect(edgeLocalHits).toHaveLength(1)
  })
})
