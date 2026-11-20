// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A node-agent that refuses to stop a VM because its current HEAD is not in the
 * durable repo (SHO-442) is NOT a stop. The project is still running, and the
 * control plane must report it that way — treating the refusal as success is how
 * a cold boot later replaces unsaved work.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
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

/** `/stop` answers like a node-agent that refused on durability. */
function refusingStop(body: Record<string, unknown>) {
  return (async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/assign') return new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'assigned' }), { status: 200 })
    if (path === '/stop') return new Response(JSON.stringify(body), { status: 200 })
    if (path === '/status') {
      return new Response(JSON.stringify({ exists: true, ready: true, state: 'assigned' }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as any
}

describe('stopProject when the node-agent refuses', () => {
  let warn: ReturnType<typeof spyOn>
  let log: ReturnType<typeof spyOn>
  beforeAll(() => {
    process.env.METAL_STOP_CONFIRM_POLL_MS = '5'
    _setMetalPlacementRegistry(new MetalPlacementRegistry(() => null))
  })
  afterAll(() => {
    _setMetalPlacementRegistry(null)
    delete process.env.METAL_STOP_CONFIRM_POLL_MS
  })
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
    log = spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    log.mockRestore()
  })

  it('reports the stop as not done, and says why', async () => {
    const c = new MetalWarmPoolController(
      fakeEnv(),
      refusingStop({
        ok: true,
        suspended: false,
        refused: true,
        reason: 'refusing to suspend p1: its current HEAD is not in the durable repo',
      }),
    )
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')

    const result = await c.stopProject('p1')

    expect(result.suspended).toBe(false)
    expect(result.refused).toBe(true)
    expect(result.reason).toContain('not in the durable repo')
    const lines = warn.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(lines.some((m: string) => m.includes('refused: refusing to suspend p1'))).toBe(true)
  })

  it('keeps an ordinary suspend unaffected', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), refusingStop({ ok: true, suspended: true, memBytes: 1024 }))
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')

    const result = await c.stopProject('p1')

    expect(result).toMatchObject({ suspended: true, busy: false, memBytes: 1024 })
    expect(result.refused).toBeUndefined()
  })
})
