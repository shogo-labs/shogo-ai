// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Model-based test for the metal placement invariant:
 *
 *   A project runs on ONE host. The control plane never boots a second copy
 *   next to a live one, and a host's reports never repoint routing at a VM
 *   that isn't the real one.
 *
 * Background: #1236 and #1238 each fixed one specific ordering of host events
 * (a sibling's evict clearing the placement; a duplicate's idle-suspend
 * repointing it; an owner agent restart triggering failover; no placement ->
 * nobody asking the hosts). Each shipped a single hand-picked regression test,
 * so the *next* ordering was unprotected. This test explores orderings.
 *
 * It drives the REAL `MetalWarmPoolController` (two API replicas), the REAL
 * `MetalPlacementRegistry`, and the REAL `/placement` route handler against a
 * fake fleet of hosts that behave like the node-agent (a VM survives an agent
 * restart; /assign on a host that holds the key resumes it; the agent keeps
 * booting after the caller times out). Seeded random event sequences run, and
 * after every step the invariants below are checked:
 *
 *   I1  no controller-induced duplicate: /assign never boots on a host with no
 *       VM for the key while another host holds one.
 *   I2  the placement never names a host that holds nothing while another host
 *       holds the key.
 *   I3  a host's placement report never moves a placement owned by a different
 *       host.
 *
 * Two modes. CLEAN: only the control plane can create a second copy, so all
 * three invariants must hold. HOSTILE: leftover duplicate snapshots are also
 * injected (the #1238 incident shape). Once a duplicate exists, which copy is
 * "the real one" is no longer well defined, so I1 is not asserted — I2 and I3
 * (routing is never repointed at the wrong copy by a report) still are.
 *
 * A failure prints the seed and the full event trace; replay with
 *   PLACEMENT_MODEL_SEED=<n> bun test metal-placement-invariant
 * Scale the search with PLACEMENT_MODEL_SEEDS / PLACEMENT_MODEL_STEPS.
 *
 * Known blind spot, deliberately not generated: a key with no placement and an
 * owner whose agent is unreachable is unknowable to the control plane (nothing
 * can be asked), so placement expiry only fires while every holder is
 * reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import {
  MetalPlacementRegistry,
  _setMetalPlacementRegistry,
} from '../metal-placement-registry'
import { MetalWarmPoolController } from '../metal-warm-pool-controller'
import { metalRoutes } from '../../routes/metal'

// --- deterministic PRNG -------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- fake fleet ---------------------------------------------------------------

type VmState = 'assigned' | 'suspended'

class FakeHost {
  vms = new Map<string, VmState>()
  agentUp = true
  /** Next /assign boots the VM but the caller sees a timeout (the agent keeps booting). */
  slowNext = false
  constructor(
    readonly id: string,
    readonly ip: string,
  ) {}
}

class Fleet {
  hosts: FakeHost[]
  violations: string[] = []
  /**
   * Whether the replica(s) doing the resolve have any record (the shared
   * placement or their own memory) that `hostId` holds `projectId`. Set by the World.
   */
  knowsHolder: (projectId: string, hostId: string) => Promise<boolean> = async () => true
  /**
   * `host|project` pairs that are stale duplicate snapshots (injected by
   * `dupBoot`). Booting from the durable backup next to one of these is fine
   * once the real copy is gone — it is garbage, not the project's state — so
   * only a REAL holder counts for I1. Cleared when the copy is touched.
   */
  staleDups = new Set<string>()
  /** Assert I1 (see the header). Off in the hostile mode. */
  strictI1 = true

  constructor(n: number) {
    this.hosts = Array.from({ length: n }, (_, i) => new FakeHost(`host-${i + 1}`, `10.8.0.${i + 2}`))
  }

  holders(projectId: string): FakeHost[] {
    return this.hosts.filter((h) => h.vms.has(projectId))
  }

  fetch = (async (url: string, init: any) => {
    const u = new URL(url)
    const host = this.hosts.find((h) => h.ip === u.hostname)!
    if (!host.agentUp) {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    const { projectId } = JSON.parse(init.body) as { projectId: string }
    if (u.pathname === '/status') {
      return Response.json({ state: host.vms.get(projectId) ?? 'none', hostId: host.id })
    }
    if (u.pathname === '/assign') {
      const had = host.vms.get(projectId)
      if (!had) {
        const other = this.holders(projectId).find(
          (h) => h !== host && !this.staleDups.has(`${h.id}|${projectId}`),
        )
        // An unreachable holder the control plane has no record of cannot be
        // discovered (nothing to ask, nothing remembered): not a violation.
        const discoverable = other && (other.agentUp || (await this.knowsHolder(projectId, other.id)))
        if (this.strictI1 && other && discoverable) {
          this.violations.push(
            `I1: /assign booted ${projectId} on ${host.id} while ${other.id} holds it (${other.vms.get(projectId)})`,
          )
        }
      }
      this.staleDups.delete(`${host.id}|${projectId}`)
      host.vms.set(projectId, 'assigned')
      if (host.slowNext) {
        host.slowNext = false
        throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
      }
      return Response.json({
        url: `http://${host.ip}:8080/${projectId}`,
        mode: had === 'suspended' ? 'resumed' : 'assigned',
        source: 'local',
        reused: had === 'assigned',
      })
    }
    return new Response('not found', { status: 404 })
  }) as any
}

// --- harness ------------------------------------------------------------------

const TOKEN = 'model-test-token'
const PROJECTS = ['p0', 'p1', 'p2']

const REG = (h: FakeHost) => ({
  hostId: h.id,
  meshIp: h.ip,
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
})

class World {
  fleet: Fleet
  registry = new MetalPlacementRegistry(() => null)
  replicas: MetalWarmPoolController[]
  routes = metalRoutes()
  trace: string[] = []

  constructor(
    hosts = 3,
    replicas = 2,
    readonly hostile = false,
  ) {
    this.fleet = new Fleet(hosts)
    this.fleet.strictI1 = !hostile
    _setMetalPlacementRegistry(this.registry)
    this.replicas = Array.from(
      { length: replicas },
      () =>
        new MetalWarmPoolController(
          async (id) => ({ PROJECT_ID: id }),
          this.fleet.fetch,
          Date.now,
          this.registry,
        ),
    )
    for (const r of this.replicas) for (const h of this.fleet.hosts) r.registerHost(REG(h))
    this.fleet.knowsHolder = async (projectId, hostId) =>
      (await this.placementHost(projectId)) === hostId ||
      this.acting.some((i) => (this.replicas[i] as any).projectHost.get(projectId) === hostId)
  }

  /** Replicas currently resolving a runtime (their memory is what they can use). */
  private acting: number[] = []

  /** A pod restart: the replica forgets which host it last placed each project on. */
  restartReplica(i: number): void {
    this.log(`restartReplica r${i}`)
    const r = new MetalWarmPoolController(async (id) => ({ PROJECT_ID: id }), this.fleet.fetch, Date.now, this.registry)
    for (const h of this.fleet.hosts) r.registerHost(REG(h))
    this.replicas[i] = r
  }

  /** Let fire-and-forget registry writes land, and let leases lapse between "requests". */
  async settle(): Promise<void> {
    await new Promise<void>((r) => setImmediate(r))
    ;(this.registry as any).memLease.clear()
  }

  host(id: string): FakeHost {
    return this.fleet.hosts.find((h) => h.id === id)!
  }

  async placementHost(projectId: string): Promise<string | null> {
    return (await this.registry.getPlacement(projectId))?.hostId ?? null
  }

  private log(s: string) {
    this.trace.push(s)
  }

  // --- events ---

  async open(replica: number, projectId: string, forceResolve = true): Promise<void> {
    this.log(`open r${replica} ${projectId}`)
    if (forceResolve) for (const r of this.replicas) r.invalidateUrlCache(projectId)
    this.acting = [replica]
    await this.replicas[replica].getMetalProjectUrl(projectId).catch(() => {})
    await this.settle()
  }

  async openConcurrently(projectId: string): Promise<void> {
    this.log(`open-concurrently ${projectId}`)
    for (const r of this.replicas) r.invalidateUrlCache(projectId)
    this.acting = this.replicas.map((_, i) => i)
    await Promise.all(this.replicas.map((r) => r.getMetalProjectUrl(projectId).catch(() => {})))
    await this.settle()
  }

  /** The route the node-agent reports to. Returns the placement before/after. */
  async report(hostId: string, projectId: string, event: 'suspended' | 'evicted' | 'cold') {
    const before = await this.placementHost(projectId)
    const res = await this.routes.request('/placement', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hostId, projectId, event }),
    })
    expect(res.status).toBe(200)
    const after = await this.placementHost(projectId)
    return { before, after }
  }

  async suspend(hostId: string, projectId: string): Promise<void> {
    const h = this.host(hostId)
    this.log(`suspend ${hostId} ${projectId}`)
    h.vms.set(projectId, 'suspended')
    const { before, after } = await this.report(hostId, projectId, 'suspended')
    if (before && before !== hostId && after !== before) {
      this.fleet.violations.push(
        `I3: ${hostId}'s suspend report moved ${projectId}'s placement ${before} -> ${after ?? 'none'}`,
      )
    }
    await this.settle()
  }

  async evict(hostId: string, projectId: string, event: 'evicted' | 'cold'): Promise<void> {
    this.log(`${event} ${hostId} ${projectId}`)
    this.host(hostId).vms.delete(projectId)
    this.fleet.staleDups.delete(`${hostId}|${projectId}`)
    const { before, after } = await this.report(hostId, projectId, event)
    if (before && before !== hostId && after !== before) {
      this.fleet.violations.push(
        `I3: ${hostId}'s ${event} report moved ${projectId}'s placement ${before} -> ${after ?? 'none'}`,
      )
    }
    await this.settle()
  }

  // --- invariants ---

  async checkPlacementInvariant(): Promise<void> {
    for (const p of PROJECTS) {
      const placed = await this.placementHost(p)
      if (!placed) continue
      const holders = this.fleet.holders(p)
      if (holders.length > 0 && !holders.some((h) => h.id === placed)) {
        this.fleet.violations.push(
          `I2: placement for ${p} names ${placed}, which holds nothing, while ${holders
            .map((h) => h.id)
            .join(',')} holds it`,
        )
      }
    }
  }
}

type EventName =
  | 'open'
  | 'openConcurrently'
  | 'suspend'
  | 'evict'
  | 'agentDown'
  | 'agentUp'
  | 'slowAssign'
  | 'dupBoot'
  | 'expirePlacement'
  | 'restartReplica'

const WEIGHTS: Array<[EventName, number]> = [
  ['open', 30],
  ['openConcurrently', 6],
  ['suspend', 12],
  ['evict', 10],
  ['agentDown', 8],
  ['agentUp', 10],
  ['slowAssign', 5],
  ['dupBoot', 8],
  ['expirePlacement', 6],
  ['restartReplica', 4],
]

async function step(w: World, rnd: () => number): Promise<void> {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
  const weights = WEIGHTS.filter(([name]) => w.hostile || name !== 'dupBoot')
  const total = weights.reduce((s, [, n]) => s + n, 0)
  let roll = rnd() * total
  let ev: EventName = 'open'
  for (const [name, weight] of weights) {
    if ((roll -= weight) < 0) {
      ev = name
      break
    }
  }
  const p = pick(PROJECTS)
  const hosts = w.fleet.hosts
  const upHolders = (proj: string) => w.fleet.holders(proj).filter((h) => h.agentUp)

  switch (ev) {
    case 'open':
      return w.open(Math.floor(rnd() * w.replicas.length), p, rnd() < 0.9)
    case 'openConcurrently':
      // A failed winner would leave the loser polling for a placement that never
      // comes (3s of real time), so only race when nothing is expected to fail.
      if (hosts.every((h) => h.agentUp && !h.slowNext)) return w.openConcurrently(p)
      return w.open(0, p)
    case 'suspend': {
      const c = upHolders(p).filter((h) => h.vms.get(p) === 'assigned')
      if (c.length) return w.suspend(pick(c).id, p)
      return
    }
    case 'evict': {
      const c = upHolders(p)
      if (c.length) return w.evict(pick(c).id, p, rnd() < 0.5 ? 'evicted' : 'cold')
      return
    }
    case 'agentDown': {
      // The release path restarts agents; the microVMs keep running.
      const h = pick(hosts)
      h.agentUp = false
      w.trace.push(`agentDown ${h.id}`)
      return
    }
    case 'agentUp': {
      const down = hosts.filter((h) => !h.agentUp)
      if (down.length) {
        const h = pick(down)
        h.agentUp = true
        w.trace.push(`agentUp ${h.id}`)
      }
      return
    }
    case 'slowAssign': {
      const h = pick(hosts)
      h.slowNext = true
      w.trace.push(`slowNext ${h.id}`)
      return
    }
    case 'dupBoot': {
      // A leftover duplicate: a snapshot on a host the control plane doesn't route to.
      const holders = w.fleet.holders(p)
      const idle = hosts.filter((h) => !h.vms.has(p))
      if (holders.length === 1 && idle.length) {
        const h = pick(idle)
        const state: VmState = rnd() < 0.5 ? 'assigned' : 'suspended'
        h.vms.set(p, state)
        w.fleet.staleDups.add(`${h.id}|${p}`)
        w.trace.push(`dupBoot ${h.id} ${p} ${state} (original on ${holders[0].id})`)
      }
      return
    }
    case 'restartReplica':
      return w.restartReplica(Math.floor(rnd() * w.replicas.length))
    case 'expirePlacement': {
      if (w.fleet.holders(p).every((h) => h.agentUp)) {
        w.trace.push(`expirePlacement ${p}`)
        await w.registry.clearPlacement(p)
      }
      return
    }
  }
}

async function runSeed(seed: number, steps: number, hostile: boolean): Promise<string[]> {
  const w = new World(3, 2, hostile)
  const rnd = mulberry32(seed)
  for (let i = 0; i < steps; i++) {
    await step(w, rnd)
    await w.settle()
    await w.checkPlacementInvariant()
    if (w.fleet.violations.length) {
      return [`seed=${seed} mode=${hostile ? 'hostile' : 'clean'} step=${i}`, ...w.fleet.violations, '--- trace ---', ...w.trace]
    }
  }
  return []
}

// --- tests --------------------------------------------------------------------

let origToken: string | undefined
const origWarn = console.warn
beforeAll(() => {
  origToken = process.env.METAL_REGISTER_TOKEN
  process.env.METAL_REGISTER_TOKEN = TOKEN
  // The controller logs every failed/kept assign; thousands of simulated events drown the output.
  console.warn = () => {}
})
afterAll(() => {
  console.warn = origWarn
  if (origToken === undefined) delete process.env.METAL_REGISTER_TOKEN
  else process.env.METAL_REGISTER_TOKEN = origToken
  _setMetalPlacementRegistry(null)
})
beforeEach(() => {
  _setMetalPlacementRegistry(null)
})

describe('metal placement invariant: named regressions through the real route + controller', () => {
  it('#1238: a duplicate idle-suspending does not repoint routing at its snapshot', async () => {
    const w = new World()
    await w.open(0, 'p0')
    const owner = w.fleet.holders('p0')[0]
    const dup = w.fleet.hosts.find((h) => h !== owner)!
    dup.vms.set('p0', 'suspended')

    await w.suspend(dup.id, 'p0')

    expect(await w.placementHost('p0')).toBe(owner.id)
    expect(w.fleet.violations).toEqual([])
  })

  it('#1236: a sibling host evicting its duplicate does not clear the owner placement', async () => {
    const w = new World()
    await w.open(0, 'p0')
    const owner = w.fleet.holders('p0')[0]
    const dup = w.fleet.hosts.find((h) => h !== owner)!
    dup.vms.set('p0', 'suspended')

    await w.evict(dup.id, 'p0', 'evicted')

    expect(await w.placementHost('p0')).toBe(owner.id)
    await w.open(1, 'p0')
    // The dup's local copy is gone; the owner keeps serving.
    expect(w.fleet.holders('p0').map((h) => h.id)).toEqual([owner.id])
    expect(await w.placementHost('p0')).toBe(owner.id)
    expect(w.fleet.violations).toEqual([])
  })

  it('#1236: an owner whose agent is restarting is not failed over to a second host', async () => {
    const w = new World()
    await w.open(0, 'p0')
    const owner = w.fleet.holders('p0')[0]
    owner.agentUp = false

    await w.open(1, 'p0')
    await w.open(0, 'p0')

    expect(w.fleet.holders('p0').map((h) => h.id)).toEqual([owner.id])
    expect(await w.placementHost('p0')).toBe(owner.id)
    expect(w.fleet.violations).toEqual([])
  })

  it('#1236: with no placement, the hosts are asked before a second VM is placed', async () => {
    const w = new World()
    await w.open(0, 'p0')
    const owner = w.fleet.holders('p0')[0]
    await w.registry.clearPlacement('p0') // expired / cleared
    // The owner is now the busiest host, so default load ordering would pick another one:
    // only asking the hosts finds the live VM.
    for (const r of w.replicas) {
      r.registerHost({ ...REG(owner), load: { available: 0, assigned: 60, suspended: 0 } })
    }
    w.restartReplica(0)
    w.restartReplica(1)
    for (const r of w.replicas) {
      r.registerHost({ ...REG(owner), load: { available: 0, assigned: 60, suspended: 0 } })
    }

    await w.open(1, 'p0')

    expect(w.fleet.holders('p0').map((h) => h.id)).toEqual([owner.id])
    expect(w.fleet.violations).toEqual([])
  })

  it('an assign that times out keeps the placement on the host that is still booting', async () => {
    const w = new World()
    w.fleet.hosts[0].slowNext = true
    await w.open(0, 'p0')
    await w.open(1, 'p0')
    expect(w.fleet.holders('p0')).toHaveLength(1)
    expect(w.fleet.violations).toEqual([])
  })
})

describe('metal placement invariant: seeded random event sequences', () => {
  const onlySeed = process.env.PLACEMENT_MODEL_SEED ? Number(process.env.PLACEMENT_MODEL_SEED) : null
  const seeds = onlySeed !== null ? 1 : Number(process.env.PLACEMENT_MODEL_SEEDS ?? 60)
  const steps = Number(process.env.PLACEMENT_MODEL_STEPS ?? 80)

  for (const hostile of [false, true]) {
    it(`${hostile ? 'hostile (injected duplicates)' : 'clean'}: holds across ${seeds} seeds x ${steps} steps`, async () => {
      for (let i = 0; i < seeds; i++) {
        const seed = onlySeed ?? 1000 + i
        const failure = await runSeed(seed, steps, hostile)
        if (failure.length) {
          throw new Error(`placement invariant violated\n${failure.join('\n')}`)
        }
      }
    }, 120_000)
  }
})
