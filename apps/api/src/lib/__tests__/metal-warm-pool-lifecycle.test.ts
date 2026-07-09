// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * MetalWarmPoolController lifecycle parity — the control-plane side of the new
 * node-agent /status, /stop, /destroy routes (metal analogs of Knative
 * getStatus / scale-to-zero / deleteProject). Verifies the controller resolves
 * the project's placement to the right host and issues the right calls.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MetalWarmPoolController } from '../metal-warm-pool-controller'
import { MetalPlacementRegistry, _setMetalPlacementRegistry } from '../metal-placement-registry'

const REG = {
  hostId: 'dal-1',
  meshIp: '10.8.0.2',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
}

const fakeEnv = () => async () => ({ PROJECT_ID: 'p' })

/** Records every node-agent call and answers per-path. */
function recordingFetch() {
  const calls: Array<{ path: string; body: any }> = []
  const impl = (async (url: string, init: any) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ path, body })
    if (path === '/assign') return new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'assigned' }), { status: 200 })
    if (path === '/status')
      return new Response(JSON.stringify({ exists: true, ready: true, replicas: 1, url: 'http://10.8.0.2:8080' }), { status: 200 })
    if (path === '/vms')
      return new Response(
        JSON.stringify({ assigned: [{ projectId: 'p1', url: 'http://10.8.0.2:8080' }], suspended: [{ projectId: 'p2' }] }),
        { status: 200 },
      )
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as any
  return { impl, calls }
}

describe('MetalWarmPoolController lifecycle', () => {
  beforeEach(() => {
    _setMetalPlacementRegistry(new MetalPlacementRegistry(() => null))
  })
  afterEach(() => {
    _setMetalPlacementRegistry(null)
  })

  it('getProjectStatus queries the placed host and maps the response', async () => {
    const { impl, calls } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1') // establishes stickiness/placement

    const status = await c.getProjectStatus('p1')
    expect(status).toEqual({ exists: true, ready: true, replicas: 1, url: 'http://10.8.0.2:8080' })
    expect(calls.some((x) => x.path === '/status' && x.body.projectId === 'p1')).toBe(true)
  })

  it('getProjectStatus reports absent for an unplaced project', async () => {
    const { impl } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    const status = await c.getProjectStatus('never-opened')
    expect(status).toEqual({ exists: false, ready: false, replicas: 0 })
  })

  it('stopProject POSTs /stop to the placed host', async () => {
    const { impl, calls } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')

    await c.stopProject('p1')
    expect(calls.some((x) => x.path === '/stop' && x.body.projectId === 'p1')).toBe(true)
  })

  it('stopProject is a no-op when the project is not placed', async () => {
    const { impl, calls } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    const res = await c.stopProject('never-opened')
    expect(calls.some((x) => x.path === '/stop')).toBe(false)
    expect(res).toEqual({ suspended: false, busy: false })
  })

  it('stopProject reports suspended:true when the agent confirms it', async () => {
    const impl = (async (url: string) => {
      const path = new URL(url).pathname
      if (path === '/assign') return new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'assigned' }), { status: 200 })
      if (path === '/stop') return new Response(JSON.stringify({ ok: true, suspended: true, memBytes: 123 }), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')
    expect(await c.stopProject('p1')).toEqual({ suspended: true, busy: false })
  })

  it('stopProject reports busy (not suspended) when the agent refuses an active-message project', async () => {
    const impl = (async (url: string) => {
      const path = new URL(url).pathname
      if (path === '/assign') return new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'assigned' }), { status: 200 })
      if (path === '/stop') return new Response(JSON.stringify({ ok: true, busy: true, suspended: false }), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')
    expect(await c.stopProject('p1')).toEqual({ suspended: false, busy: true })
  })

  it('resizeProject POSTs /resize with alwaysOn=true for a paid (minScale≥1) tier', async () => {
    const { impl, calls } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')

    await c.resizeProject('p1', { minScale: 1 })
    const resize = calls.find((x) => x.path === '/resize' && x.body.projectId === 'p1')
    expect(resize).toBeDefined()
    expect(resize!.body.alwaysOn).toBe(true)
  })

  it('resizeProject sends alwaysOn=false for a free (minScale 0) tier', async () => {
    const { impl, calls } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')

    await c.resizeProject('p1', { minScale: 0 })
    const resize = calls.find((x) => x.path === '/resize' && x.body.projectId === 'p1')
    expect(resize!.body.alwaysOn).toBe(false)
  })

  it('resizeProject is a no-op when the project is not placed', async () => {
    const { impl, calls } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    await c.resizeProject('never-opened', { minScale: 1 })
    expect(calls.some((x) => x.path === '/resize')).toBe(false)
  })

  it('destroyProject fans out /destroy to every live host and clears stickiness', async () => {
    const { impl, calls } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)
    c.registerHost({ ...REG, hostId: 'dal-2', meshIp: '10.8.0.3' })
    await c.getMetalProjectUrl('p1')

    await c.destroyProject('p1')
    const destroyCalls = calls.filter((x) => x.path === '/destroy' && x.body.projectId === 'p1')
    expect(destroyCalls.length).toBe(2) // both hosts
    // Stickiness cleared → status for a now-unplaced project reports absent.
    const status = await c.getProjectStatus('p1')
    expect(status.exists).toBe(false)
  })

  it('destroyProject still reaches a transiently-stale owner (delete racing a missed heartbeat)', async () => {
    // Regression for a staging leak: the owning box missed a heartbeat right as
    // its project was deleted, so it fell out of the live TTL window and the
    // teardown fanned out to zero hosts — the snapshot leaked. The owner must
    // still be targeted from its last-known placement.
    const { impl, calls } = recordingFetch()
    let clock = 1_000_000
    const c = new MetalWarmPoolController(fakeEnv(), impl, () => clock)
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1') // places p1 on dal-1

    clock += 120_000 // > HOST_TTL_MS (90s): dal-1 is now outside the live window

    await c.destroyProject('p1')
    const destroyCalls = calls.filter((x) => x.path === '/destroy' && x.body.projectId === 'p1')
    expect(destroyCalls.length).toBe(1) // reached the stale owner, not zero hosts
  })

  it('listProjects aggregates assigned + suspended across hosts', async () => {
    const { impl } = recordingFetch()
    const c = new MetalWarmPoolController(fakeEnv(), impl)
    c.registerHost(REG)

    const all = await c.listProjects()
    const byId = Object.fromEntries(all.map((p) => [p.projectId, p]))
    expect(byId.p1).toMatchObject({ ready: true, host: 'dal-1', region: 'us' })
    expect(byId.p2).toMatchObject({ ready: false, host: 'dal-1' })
  })
})
