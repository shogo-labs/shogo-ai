// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Metal /assign failover against two real HTTP "hosts".
 *
 * 2026-10-17 us-ashburn-1: latitude-dal-1 answered /assign with a 500 ("FC API
 * socket never appeared") yet went on to run the runtime; the controller had
 * already failed over to latitude-dal-2, and the placement audit flagged the
 * key as a split (running on both) for half an hour.
 *
 * Each fake host is a Bun HTTP server speaking the agent's /assign + /status
 * contract. The controller talks to them over real fetch, and the test asks
 * the production duplicate detector (`findDuplicateRuntimes`) what the fleet
 * looks like afterwards.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MetalWarmPoolController } from '../lib/metal-warm-pool-controller'
import { MetalPlacementRegistry, _setMetalPlacementRegistry, getMetalPlacementRegistry } from '../lib/metal-placement-registry'
import { findDuplicateRuntimes, type RuntimeRow } from '../lib/metal-runtime-audit'

type AssignBehavior = 'ok' | 'fail-but-run' | 'fail'

class FakeHost {
  readonly running = new Set<string>()
  readonly assigns: string[] = []
  behavior: AssignBehavior = 'ok'
  private server!: ReturnType<typeof Bun.serve>

  constructor(readonly hostId: string) {}

  start() {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string }
        if (path === '/status') {
          return Response.json({ state: projectId && this.running.has(projectId) ? 'assigned' : 'none' })
        }
        if (path === '/assign' && projectId) {
          this.assigns.push(projectId)
          if (this.running.has(projectId)) {
            return Response.json({ url: `http://${this.hostId}.guest`, mode: 'assigned', reused: true })
          }
          if (this.behavior === 'fail-but-run') {
            // The boot this caller waited on failed, but the host ends up
            // running the key anyway.
            this.running.add(projectId)
            return Response.json({ error: 'FC API socket never appeared: /opt/fc-spike/run/fcvm-7.sock' }, { status: 500 })
          }
          if (this.behavior === 'fail') {
            return Response.json({ error: 'FC API socket never appeared: /opt/fc-spike/run/fcvm-7.sock' }, { status: 500 })
          }
          this.running.add(projectId)
          return Response.json({ url: `http://${this.hostId}.guest`, mode: 'assigned' })
        }
        return new Response('not found', { status: 404 })
      },
    })
  }

  stop() {
    this.server.stop(true)
  }

  get port(): number {
    return this.server.port!
  }

  rows(): RuntimeRow[] {
    return [...this.running].map((projectId) => ({ projectId, ready: true, host: this.hostId, region: 'us' }))
  }
}

const dal1 = new FakeHost('latitude-dal-1')
const dal2 = new FakeHost('latitude-dal-2')

function controller() {
  const c = new MetalWarmPoolController(async () => ({ PROJECT_ID: 'p' }), fetch)
  const reg = (h: FakeHost, assigned: number) => ({
    hostId: h.hostId,
    meshIp: '127.0.0.1',
    agentPort: h.port,
    region: 'us',
    arch: 'x64',
    capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
    // dal-1 is the least loaded, so it is tried first.
    load: { available: 1, assigned, suspended: 0 },
  })
  c.registerHost(reg(dal1, 0))
  c.registerHost(reg(dal2, 3))
  return c
}

beforeAll(() => {
  dal1.start()
  dal2.start()
})
afterAll(() => {
  dal1.stop()
  dal2.stop()
})
beforeEach(() => {
  _setMetalPlacementRegistry(new MetalPlacementRegistry(() => null))
  for (const h of [dal1, dal2]) {
    h.running.clear()
    h.assigns.length = 0
    h.behavior = 'ok'
  }
})
afterEach(() => _setMetalPlacementRegistry(null))

describe('metal /assign failover (real HTTP hosts)', () => {
  test('a host that fails /assign but runs the key keeps the placement — no second copy', async () => {
    const key = 'ws:proj:a2e58237-b28c-48e4-a412-0bcbe2a3abe3'
    dal1.behavior = 'fail-but-run'
    const c = controller()

    await expect(c.getMetalProjectUrl(key)).rejects.toThrow('metal /assign 500')
    expect(dal2.assigns).toEqual([])
    expect((await getMetalPlacementRegistry().getPlacement(key))?.hostId).toBe('latitude-dal-1')
    expect(findDuplicateRuntimes([...dal1.rows(), ...dal2.rows()])).toEqual([])

    // The caller's retry lands back on dal-1 and is handed its live VM.
    expect(await c.getMetalProjectUrl(key)).toBe('http://latitude-dal-1.guest')
    expect(dal2.assigns).toEqual([])
    expect(findDuplicateRuntimes([...dal1.rows(), ...dal2.rows()])).toEqual([])
  })

  test('a host that fails /assign and holds nothing still fails over', async () => {
    const key = 'ws:proj:refused'
    dal1.behavior = 'fail'
    const c = controller()

    expect(await c.getMetalProjectUrl(key)).toBe('http://latitude-dal-2.guest')
    expect(dal1.assigns).toEqual([key])
    expect(dal2.assigns).toEqual([key])
    expect((await getMetalPlacementRegistry().getPlacement(key))?.hostId).toBe('latitude-dal-2')
    expect(findDuplicateRuntimes([...dal1.rows(), ...dal2.rows()])).toEqual([])
  })
})
