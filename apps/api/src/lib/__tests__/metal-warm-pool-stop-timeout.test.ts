// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A /stop that outlasts METAL_STOP_TIMEOUT_MS is not a failed stop when the
 * host already reports the runtime suspended: the host answers /stop only after
 * the durable upload, which under a re-warm burst took longer than the timeout
 * and filled the logs with "stop ... failed" for stops that had succeeded.
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

/** `/stop` fails the way `AbortSignal.timeout(METAL_STOP_TIMEOUT_MS)` does, after 20ms. */
function hangingStop(state: () => string) {
  return (async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/assign') return new Response(JSON.stringify({ url: 'http://10.8.0.2:8080', mode: 'assigned' }), { status: 200 })
    if (path === '/stop') {
      await Bun.sleep(20)
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }
    if (path === '/status') {
      const s = state()
      return new Response(JSON.stringify({ exists: s !== 'none', ready: s === 'assigned', state: s }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as any
}

describe('stopProject when /stop times out', () => {
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

  const stopLines = (spy: ReturnType<typeof spyOn>) =>
    spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes('[MetalPool] stop p1'))

  it('logs a confirmed suspend, not a failure, once the host reports it suspended', async () => {
    let state = 'assigned'
    const c = new MetalWarmPoolController(fakeEnv(), hangingStop(() => state))
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')
    const stopped = c.stopProject('p1')
    state = 'suspended'
    expect(await stopped).toEqual({ suspended: true, busy: false })
    await Bun.sleep(60)
    expect(stopLines(warn)).toEqual([])
    expect(stopLines(log)).toEqual([expect.stringContaining('host reports it suspended')])
  })

  it('still warns when the host has not suspended it', async () => {
    const c = new MetalWarmPoolController(fakeEnv(), hangingStop(() => 'assigned'))
    c.registerHost(REG)
    await c.getMetalProjectUrl('p1')
    void c.stopProject('p1')
    await Bun.sleep(60)
    expect(stopLines(warn)).toEqual([expect.stringContaining('failed: The operation timed out. (host state: assigned)')])
  })
})
