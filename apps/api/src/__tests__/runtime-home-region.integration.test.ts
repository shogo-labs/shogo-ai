// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration proof that a project's runtime is never started outside its
 * workspace's home region, over REAL HTTP between two Bun servers.
 *
 * Production bug: requests and background jobs that landed in the wrong region
 * resolved the runtime locally — booting a second VM with a stale tree whose
 * source backup overwrote the real one (29 projects had VMs in both regions,
 * three of them from the heartbeat scheduler alone).
 *
 *   - Request path: the real `pinProjectRoutesToHomeRegion` middleware on the
 *     "edge" server proxies files/terminal/database/diagnostics GETs (which the
 *     write router never pinned) to the "home" server via the real
 *     `proxyToPeer`, so the edge never resolves a runtime.
 *   - Background path: the real `resolveWorkspaceRuntimeUrl` + real
 *     `assertRuntimeInHomeRegion` refuse to boot on the edge.
 *
 * Only prisma is mocked (project → workspace → homeRegion).
 *
 *   bun test apps/api/src/__tests__/runtime-home-region.integration.test.ts
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const HOME_REGION = 'home-1'
const EDGE_REGION = 'edge-1'

const homeSeen: Array<{ path: string; proxied: boolean }> = []
const homeApp = new Hono()
homeApp.all('/api/projects/:projectId/*', (c) => {
  homeSeen.push({
    path: new URL(c.req.url).pathname,
    proxied: c.req.header('x-shogo-home-region-proxy') === '1',
  })
  return c.text('SERVED_BY_HOME')
})
const homeServer = Bun.serve({ port: 0, fetch: homeApp.fetch })

process.env.REGION_ID = EDGE_REGION
process.env.REGION_PEERS = JSON.stringify([
  { id: HOME_REGION, label: 'Home', url: `http://127.0.0.1:${homeServer.port}` },
])
process.env.HOST_HEADER_FOR_PEERS = 'studio.shogo.ai'
delete process.env.CHAT_REGION_PIN
delete process.env.RUNTIME_HOME_REGION_GUARD

const projects: Record<string, { workspaceId: string }> = {
  p_home: { workspaceId: 'ws_home' },
  p_local: { workspaceId: 'ws_local' },
}
const workspaces: Record<string, { homeRegion: string | null }> = {
  ws_home: { homeRegion: HOME_REGION },
  ws_local: { homeRegion: EDGE_REGION },
}
mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => projects[id] ?? null,
    },
    workspace: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => workspaces[id] ?? null,
    },
  },
}))

const { pinProjectRoutesToHomeRegion } = await import('../lib/chat-region-pin')
const { resolveWorkspaceRuntimeUrl } = await import('../lib/resolve-workspace-runtime-url')
const { RuntimeNotInHomeRegionError } = await import('../lib/runtime-home-region-guard')

// Edge: the real middleware, then handlers that stand in for routes which
// resolve (and so would boot) the project runtime.
const edgeBoots: string[] = []
const edgeApp = new Hono()
edgeApp.use(
  '/api/projects/:projectId/*',
  pinProjectRoutesToHomeRegion({ skip: (path) => path === '/api/projects/import' }),
)
edgeApp.all('/api/projects/:projectId/*', (c) => {
  edgeBoots.push(c.req.param('projectId'))
  return c.text('SERVED_BY_EDGE')
})
const edgeServer = Bun.serve({ port: 0, fetch: edgeApp.fetch })
const EDGE_URL = `http://127.0.0.1:${edgeServer.port}`

afterAll(() => {
  homeServer.stop(true)
  edgeServer.stop(true)
})

const RUNTIME_GETS = [
  '/files',
  '/files/src/App.tsx',
  '/terminal/sessions',
  '/database/status',
  '/diagnostics',
  '/runtime/status',
]

describe('project requests on a non-home region', () => {
  for (const suffix of RUNTIME_GETS) {
    test(`GET ${suffix} is served by the home region, never resolved on the edge`, async () => {
      homeSeen.length = 0
      edgeBoots.length = 0
      const res = await fetch(`${EDGE_URL}/api/projects/p_home${suffix}`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('SERVED_BY_HOME')
      expect(homeSeen).toEqual([{ path: `/api/projects/p_home${suffix}`, proxied: true }])
      expect(edgeBoots).toEqual([])
    })
  }

  test('a project homed on the edge is served locally', async () => {
    homeSeen.length = 0
    edgeBoots.length = 0
    const res = await fetch(`${EDGE_URL}/api/projects/p_local/files`)
    expect(await res.text()).toBe('SERVED_BY_EDGE')
    expect(edgeBoots).toEqual(['p_local'])
    expect(homeSeen).toEqual([])
  })

  test('skipped (reserved top-level) paths are served locally', async () => {
    homeSeen.length = 0
    const res = await fetch(`${EDGE_URL}/api/projects/import`, { method: 'POST' })
    expect(await res.text()).toBe('SERVED_BY_EDGE')
    expect(homeSeen).toEqual([])
  })
})

describe('background runtime resolution on a non-home region', () => {
  const passthroughLease = <T>(_id: string, fn: () => Promise<T>) => fn()

  test('refuses to boot a runtime for a workspace homed in a peer region', async () => {
    const booted: string[] = []
    const err = await resolveWorkspaceRuntimeUrl('ws_home', {
      attachedProjectIds: [],
      anchorProjectId: 'p_home',
      logTag: 'HeartbeatScheduler',
      _isMetalEnabled: () => true,
      _isKubernetes: () => true,
      _spawnLease: passthroughLease,
      _metalResolver: async (wsId) => {
        booted.push(wsId)
        return 'http://stray-vm'
      },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RuntimeNotInHomeRegionError)
    expect(err.homeRegion).toBe(HOME_REGION)
    expect(booted).toEqual([])
  })

  test('boots normally for a workspace homed here', async () => {
    const res = await resolveWorkspaceRuntimeUrl('ws_local', {
      attachedProjectIds: [],
      anchorProjectId: 'p_local',
      _isMetalEnabled: () => true,
      _isKubernetes: () => true,
      _spawnLease: passthroughLease,
      _metalResolver: async () => 'http://home-vm',
    })
    expect(res).toEqual({ mode: 'metal', url: 'http://home-vm' })
  })
})
