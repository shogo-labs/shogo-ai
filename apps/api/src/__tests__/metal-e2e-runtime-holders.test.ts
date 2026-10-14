// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * GET /api/internal/e2e/runtime-holders — the staging single-runtime e2e asks
 * which runtimes on the fleet hold a project. Same secret gate as the other
 * hosted e2e routes.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('../lib/prisma', () => ({ prisma: {} }))

const { metalE2eRoutes } = await import('../routes/metal')
const { _setMetalWarmPoolController, MetalWarmPoolController } = await import('../lib/metal-warm-pool-controller')

const app = metalE2eRoutes()
const SECRET = 'e2e-secret'

const host = (hostId: string, meshIp: string) => ({
  hostId,
  meshIp,
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
})

describe('GET /runtime-holders', () => {
  const saved = process.env.SHOGO_E2E_BOOTSTRAP_SECRET
  const asked: string[] = []

  beforeEach(() => {
    process.env.SHOGO_E2E_BOOTSTRAP_SECRET = SECRET
    asked.length = 0
    const fetchImpl = (async (url: string, init: any) => {
      const u = new URL(url)
      asked.push(`${u.hostname}${u.pathname}:${JSON.parse(init.body).projectId}`)
      if (u.hostname === '10.8.0.3') return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ hostId: 'dal-1', holders: ['ws:proj:p1'] }), { status: 200 })
    }) as unknown as typeof fetch
    const controller = new MetalWarmPoolController(async () => ({}), fetchImpl)
    controller.registerHost(host('dal-1', '10.8.0.2'))
    controller.registerHost(host('dal-2', '10.8.0.3'))
    _setMetalWarmPoolController(controller)
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.SHOGO_E2E_BOOTSTRAP_SECRET
    else process.env.SHOGO_E2E_BOOTSTRAP_SECRET = saved
    _setMetalWarmPoolController(null)
  })

  it('fans out to every live host and skips one that fails', async () => {
    const res = await app.request('/runtime-holders?projectId=p1', { headers: { 'x-e2e-bootstrap-secret': SECRET } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: 'p1', holders: [{ hostId: 'dal-1', runtimeKey: 'ws:proj:p1' }] })
    expect(asked.sort()).toEqual(['10.8.0.2/members/holders:p1', '10.8.0.3/members/holders:p1'])
  })

  it('401 without the bootstrap secret', async () => {
    const res = await app.request('/runtime-holders?projectId=p1', { headers: { 'x-e2e-bootstrap-secret': 'nope' } })
    expect(res.status).toBe(401)
    expect(asked).toEqual([])
  })

  it('400 without a projectId', async () => {
    const res = await app.request('/runtime-holders', { headers: { 'x-e2e-bootstrap-secret': SECRET } })
    expect(res.status).toBe(400)
  })
})
