// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Feature e2e for the per-user "max N open projects on metal → suspend the
 * oldest idle one" cap, driven through the REAL control-plane pieces wired
 * together (no Firecracker host, no staging):
 *
 *   MetalPlacementRegistry (shared open-set + placement)
 *     → MetalWarmPoolController.getMetalProjectUrl / .stopProject
 *       → a stateful node-agent FAKE that mirrors the real /assign + /stop
 *         contract from apps/metal-agent/src/server.ts (incl. the busy /
 *         active-message refusal)
 *     → enforceUserMetalOpenLimit (the /sandbox/url open hook)
 *
 * This exercises the exact sequence a production open takes and asserts the
 * end-to-end effects on the fleet (which VMs are assigned vs suspended), which
 * the isolated unit tests don't cover.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MetalWarmPoolController } from '../metal-warm-pool-controller'
import { MetalPlacementRegistry } from '../metal-placement-registry'
import { enforceUserMetalOpenLimit } from '../metal-user-open-limit'

const HOST = {
  hostId: 'dal-1',
  meshIp: '10.8.0.2',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 8, memMiB: 2048, vcpus: 2 },
  load: { available: 4, assigned: 0, suspended: 0 },
}

/**
 * A stateful stand-in for a metal node-agent. Its /assign and /stop handlers
 * mirror apps/metal-agent/src/server.ts: /stop is a no-op when unassigned,
 * REFUSES (busy) when the project has an active message, else suspends.
 */
function fakeNodeAgent() {
  const assigned = new Set<string>()
  const suspendedLog: string[] = []
  const busy = new Set<string>() // projects with an active agent message

  const fetchImpl = (async (url: string, init: any) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(init.body) : {}
    const pid: string = body.projectId
    switch (path) {
      case '/assign':
        assigned.add(pid)
        return new Response(JSON.stringify({ url: `http://10.8.0.2:8080/${pid}`, mode: 'assigned' }), { status: 200 })
      case '/status':
        return new Response(
          JSON.stringify({ exists: assigned.has(pid), ready: assigned.has(pid), replicas: assigned.has(pid) ? 1 : 0 }),
          { status: 200 },
        )
      case '/stop':
        if (!assigned.has(pid)) return new Response(JSON.stringify({ ok: true, alreadyStopped: true, suspended: false }), { status: 200 })
        if (busy.has(pid)) return new Response(JSON.stringify({ ok: true, busy: true, suspended: false }), { status: 200 })
        assigned.delete(pid)
        suspendedLog.push(pid)
        return new Response(JSON.stringify({ ok: true, suspended: true, memBytes: 1 }), { status: 200 })
      default:
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
  }) as unknown as typeof fetch

  return { fetchImpl, assigned, suspendedLog, busy }
}

const fakeEnv = () => async () => ({ PROJECT_ID: 'p' })

describe('metal per-user open cap (control-plane e2e)', () => {
  let agent: ReturnType<typeof fakeNodeAgent>
  let registry: MetalPlacementRegistry
  let controller: MetalWarmPoolController
  let clock: number

  const USER = 'user-1'

  // Open a project the way /sandbox/url does: resolve (assign/resume) on metal,
  // then enforce the per-user cap with the real registry + real stopProject.
  async function open(projectId: string) {
    await controller.getMetalProjectUrl(projectId)
    return enforceUserMetalOpenLimit(USER, projectId, {
      registry,
      stop: (id) => controller.stopProject(id),
      max: 3,
      now: () => (clock += 1000),
    })
  }

  beforeEach(() => {
    agent = fakeNodeAgent()
    registry = new MetalPlacementRegistry(() => null) // in-proc (no Redis)
    controller = new MetalWarmPoolController(fakeEnv(), agent.fetchImpl, Date.now, registry)
    controller.registerHost(HOST)
    // Seed at real time so recorded open-times sit inside the rolling TTL window
    // (post-hoc listUserOpen assertions use the default Date.now()).
    clock = Date.now()
  })
  afterEach(() => {
    // nothing global to reset (controller/registry are locals)
  })

  it('keeps at most 3 projects running per user, suspending the oldest on the 4th open', async () => {
    for (const p of ['p1', 'p2', 'p3']) expect(await open(p)).toEqual([])
    expect([...agent.assigned].sort()).toEqual(['p1', 'p2', 'p3'])

    // 4th open sheds the oldest (p1).
    expect(await open('p4')).toEqual(['p1'])
    expect(agent.suspendedLog).toEqual(['p1'])
    expect([...agent.assigned].sort()).toEqual(['p2', 'p3', 'p4'])
    expect((await registry.listUserOpen(USER)).map((e) => e.projectId)).toEqual(['p2', 'p3', 'p4'])
  })

  it('never suspends a project with an active message — skips it and sheds the next-oldest', async () => {
    for (const p of ['p1', 'p2', 'p3']) await open(p)
    expect(await open('p4')).toEqual(['p1']) // p1 shed
    expect([...agent.assigned].sort()).toEqual(['p2', 'p3', 'p4'])

    // p2 (now the oldest) starts generating an agent message.
    agent.busy.add('p2')
    // 5th open: oldest p2 is busy → skipped; next-oldest idle p3 is shed.
    expect(await open('p5')).toEqual(['p3'])
    expect(agent.suspendedLog).toEqual(['p1', 'p3'])
    expect([...agent.assigned].sort()).toEqual(['p2', 'p4', 'p5']) // busy p2 still running
    expect((await registry.listUserOpen(USER)).map((e) => e.projectId)).toEqual(['p2', 'p4', 'p5'])

    // The active message finishes; p2 is now the oldest AND idle.
    agent.busy.delete('p2')
    expect(await open('p6')).toEqual(['p2']) // now safe to shed
    expect(agent.suspendedLog).toEqual(['p1', 'p3', 'p2'])
    expect([...agent.assigned].sort()).toEqual(['p4', 'p5', 'p6'])
  })

  it('re-opening a project protects it from eviction (LRU by open time)', async () => {
    for (const p of ['p1', 'p2', 'p3']) await open(p)
    await open('p1') // re-open oldest → it becomes newest
    // Now the oldest is p2; opening p4 sheds p2, not p1.
    expect(await open('p4')).toEqual(['p2'])
    expect([...agent.assigned].sort()).toEqual(['p1', 'p3', 'p4'])
  })

  it('stays temporarily over-cap when every eviction candidate is busy', async () => {
    for (const p of ['p1', 'p2', 'p3']) await open(p)
    agent.busy.add('p1')
    agent.busy.add('p2')
    agent.busy.add('p3')
    // p4 opens; nothing idle to shed → all four keep running.
    expect(await open('p4')).toEqual([])
    expect(agent.suspendedLog).toEqual([])
    expect([...agent.assigned].sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect((await registry.listUserOpen(USER)).map((e) => e.projectId)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })
})
