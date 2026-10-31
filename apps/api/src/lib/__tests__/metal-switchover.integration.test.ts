// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Rootfs switch-over, end to end against a simulated fleet.
 *
 * The fleet models what the metal-agent does with each runtime's slots: a
 * running VM (booted from some rootfs identity), a current-image snapshot and a
 * staged-image snapshot. Everything above it is the real control-plane code:
 * the watcher's switch-over tick, the heartbeat's `activateRootfs`, the
 * refresh queue and the rollout re-warm.
 *
 * What it pins down:
 *  - a region activates as soon as every host holds the staged build;
 *  - after activation every recently used runtime is warmed on the new image
 *    through the refresh queue, a few per host at a time;
 *  - a runtime running on the old image is never stopped from here: the host
 *    rotates it once idle, and it is re-warmed on the new image after that;
 *  - an always-on runtime the host rotated is booted again and left running;
 *  - the newest staged build always wins over an older one.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  MemoryRewarmStore,
  SWITCHOVER,
  activateRootfsFor,
  drainRefreshQueue,
  enqueueRefresh,
  getRefreshStatus,
  getRewarmStatus,
  getSwitchoverStatus,
  rewarmLeaseBudget,
  rewarmWatcherTick,
  runRewarm,
  switchoverTick,
  type RewarmCandidate,
  type RewarmDeps,
  type RewarmHost,
  type RewarmStatus,
} from '../metal-rewarm'
import type { RuntimeHostStatus, StopResult } from '../metal-warm-pool-controller'

const MIN = 60_000

interface FakeHost {
  hostId: string
  region: string
  /** ROOTFS_SHA: the release, same on every host. */
  rootfsSha: string
  /** Identity of the live image (per host: it includes the file's mtime). */
  base: string
  staged?: { version: string; identity: string; stagedAt: number; prewarm?: boolean }
  utilPct: number
  restarts: number
}

interface FakeRuntime {
  hostId: string
  running?: { identity: string; assignedAt: number; lastRealActivityAt?: number; activeStreams: number }
  /** Snapshot on the current slot, by the identity it was taken on. */
  current?: string
  /** Snapshot on the staged slot. */
  staged?: string
}

class FakeFleet {
  hosts = new Map<string, FakeHost>()
  runtimes = new Map<string, FakeRuntime>()
  clock = { t: 1_800_000_000_000 }
  store = new MemoryRewarmStore()
  candidates: RewarmCandidate[] = []
  boots: Array<{ key: string; rootfs: 'staged' | 'current'; hostId: string }> = []
  stops: string[] = []
  retired: string[] = []
  logs: string[] = []
  /** Holds every boot, VM already started, until released (to land events mid pre-warm). */
  gate: Promise<void> | null = null
  /** Keys whose boot always throws. */
  failing = new Set<string>()

  addHost(hostId: string, region = 'us') {
    this.hosts.set(hostId, { hostId, region, rootfsSha: 'sha-1', base: `A-${hostId}`, utilPct: 10, reportsMemory: true, vmUtilPct: 10, restarts: 0 })
  }

  host(id: string) {
    const h = this.hosts.get(id)
    if (!h) throw new Error(`no host ${id}`)
    return h
  }

  /** A suspended runtime with a current-image snapshot. */
  suspended(key: string, hostId: string) {
    this.runtimes.set(key, { hostId, current: this.host(hostId).base })
    this.addCandidate(key)
  }

  /** A runtime running on the current image, last used `idleMs` ago. */
  running(key: string, hostId: string, idleMs: number) {
    const now = this.clock.t
    this.runtimes.set(key, {
      hostId,
      running: { identity: this.host(hostId).base, assignedAt: now - idleMs - MIN, lastRealActivityAt: now - idleMs, activeStreams: 0 },
    })
    this.addCandidate(key)
  }

  addCandidate(key: string) {
    this.candidates.push(
      key.startsWith('ws:proj:')
        ? { key, kind: 'project', projectId: key.slice(8), workspaceId: 'w', lastActiveAt: 1 }
        : { key, kind: 'workspace', workspaceId: key.slice(3), sessionId: 's', lastActiveAt: 1 },
    )
  }

  /** A host builds a staged image. Rebuilding drops the previous build's staged snapshots. */
  stage(hostId: string, version: string, opts: { prewarm?: boolean } = {}) {
    const h = this.host(hostId)
    if (h.staged && h.staged.version !== version) {
      for (const rt of this.runtimes.values()) if (rt.hostId === hostId) rt.staged = undefined
    }
    h.staged = { version, identity: `${version}-${hostId}`, stagedAt: this.clock.t, prewarm: opts.prewarm }
  }

  /** One heartbeat: the control plane may answer `activateRootfs`. */
  async heartbeat(hostId: string): Promise<string | undefined> {
    const h = this.host(hostId)
    const v = await activateRootfsFor(h.region, h.staged?.version, this.store)
    if (v) this.activate(hostId, v)
    return v
  }

  /** metal-agent activateRootfs: rename staged over base, promote staged snapshots, restart. */
  activate(hostId: string, version: string) {
    const h = this.host(hostId)
    if (h.staged?.version !== version) throw new Error(`host ${hostId} refused ${version}`)
    h.base = h.staged.identity
    h.rootfsSha = version
    h.staged = undefined
    h.restarts++
    for (const rt of this.runtimes.values()) {
      if (rt.hostId !== hostId || !rt.staged) continue
      if (rt.staged === h.base) rt.current = rt.staged
      rt.staged = undefined
    }
  }

  generation(h: FakeHost, identity: string): 'current' | 'staged' | 'stale' {
    if (identity === h.base) return 'current'
    if (identity === h.staged?.identity) return 'staged'
    return 'stale'
  }

  /** What `/status` reports for a key (null: not placed on any host). */
  status(key: string): RuntimeHostStatus | null {
    const rt = this.runtimes.get(key)
    if (!rt) return null
    const h = this.host(rt.hostId)
    const now = this.clock.t
    if (rt.running) {
      return {
        hostId: h.hostId,
        region: h.region,
        state: 'assigned',
        rootfsFresh: rt.running.identity === h.base,
        assignedAt: rt.running.assignedAt,
        lastRealActivityAt: rt.running.lastRealActivityAt,
        realIdleMs: now - (rt.running.lastRealActivityAt ?? rt.running.assignedAt),
        activeStreams: rt.running.activeStreams,
        snapshotRootfsIdentity: rt.running.identity,
        stagedSnapshotIdentity: rt.staged,
      }
    }
    return {
      hostId: h.hostId,
      region: h.region,
      state: rt.current ? 'suspended' : 'none',
      rootfsFresh: rt.current ? rt.current === h.base : undefined,
      snapshotRootfsIdentity: rt.current,
      stagedSnapshotIdentity: rt.staged,
    }
  }

  /** A user opens the runtime (the normal, non-staged path). */
  userOpen(key: string): { mode: 'resumed' | 'assigned' | 'live'; identity: string } {
    const rt = this.runtimes.get(key) ?? { hostId: [...this.hosts.keys()][0]! }
    this.runtimes.set(key, rt)
    const h = this.host(rt.hostId)
    const now = this.clock.t
    if (rt.running) {
      rt.running.lastRealActivityAt = now
      return { mode: 'live', identity: rt.running.identity }
    }
    // A normal open drops the staged snapshot; a snapshot of a replaced image never resumes.
    rt.staged = undefined
    if (rt.current !== h.base) rt.current = undefined
    const mode = rt.current ? 'resumed' : 'assigned'
    const identity = rt.current ?? h.base
    rt.current = undefined
    rt.running = { identity, assignedAt: now, lastRealActivityAt: now, activeStreams: 0 }
    return { mode, identity }
  }

  /** metal-agent rotateStale: retire an idle VM on a replaced image and report it. */
  async rotate(key: string, opts: { alwaysOn?: boolean } = {}) {
    const rt = this.runtimes.get(key)
    if (!rt?.running || this.generation(this.host(rt.hostId), rt.running.identity) !== 'stale') throw new Error(`${key} is not on a replaced image`)
    rt.running = undefined
    rt.current = undefined
    this.retired.push(key)
    const reason = opts.alwaysOn ? 'stale-rootfs-always-on' : 'stale-rootfs'
    await enqueueRefresh(key, { hostId: rt.hostId, reason }, this.store, this.clock.t)
  }

  /** metal-agent suspendOrRetire, plus the placement event it reports. */
  async suspend(key: string): Promise<StopResult> {
    const rt = this.runtimes.get(key)
    if (!rt?.running) return { suspended: false, busy: false }
    if (rt.running.activeStreams > 0) return { suspended: false, busy: true }
    const h = this.host(rt.hostId)
    const identity = rt.running.identity
    this.stops.push(key)
    rt.running = undefined
    switch (this.generation(h, identity)) {
      case 'staged':
        rt.staged = identity
        return { suspended: true, busy: false, staged: true, snapshotRootfsIdentity: identity, memBytes: 100 }
      case 'current':
        rt.current = identity
        return { suspended: true, busy: false, staged: false, snapshotRootfsIdentity: identity, memBytes: 100 }
      case 'stale':
        rt.current = undefined
        this.retired.push(key)
        await enqueueRefresh(key, { hostId: h.hostId, reason: 'stale-rootfs' }, this.store, this.clock.t)
        return { suspended: true, busy: false, retired: true }
    }
  }

  get deps(): RewarmDeps {
    const fleet = this
    return {
      listCandidates: async () => [...fleet.candidates],
      candidatesForKeys: async (keys) => fleet.candidates.filter((c) => keys.includes(c.key)),
      listHosts: async (): Promise<RewarmHost[]> =>
        [...fleet.hosts.values()].map((h) => ({
          hostId: h.hostId,
          region: h.region,
          rootfsSha: h.rootfsSha,
          utilPct: h.utilPct,
          reportsMemory: h.reportsMemory,
          vmUtilPct: h.vmUtilPct,
          overWatermark: false,
          stagedRootfs: h.staged
            ? {
                version: h.staged.version,
                identities: { standard: h.staged.identity },
                stagedAt: h.staged.stagedAt,
                ...(h.staged.prewarm !== undefined ? { prewarm: h.staged.prewarm } : {}),
              }
            : undefined,
        })),
      runtimeStatus: async (key) => fleet.status(key),
      recycle: async (key) => {
        const rt = fleet.runtimes.get(key)
        if (rt) {
          rt.running = undefined
          rt.current = undefined
        }
        return { ok: true }
      },
      boot: async (c, opts) => {
        if (fleet.failing.has(c.key)) throw new Error('boot failed: host error')
        const rt = fleet.runtimes.get(c.key) ?? { hostId: [...fleet.hosts.keys()][0]! }
        fleet.runtimes.set(c.key, rt)
        const h = fleet.host(rt.hostId)
        const now = fleet.clock.t
        if (opts?.rootfs === 'staged') {
          if (!h.staged) throw new Error('assign failed: 409 no_staged_rootfs')
          if (rt.staged === h.staged.identity && !rt.running) {
            throw Object.assign(new Error('prewarmed'), { code: 'prewarmed' })
          }
          // A staged open never resumes: it cold-boots on the staged image and
          // leaves the current snapshot serving.
          if (!rt.running) rt.running = { identity: h.staged.identity, assignedAt: now, activeStreams: 0 }
          fleet.boots.push({ key: c.key, rootfs: 'staged', hostId: h.hostId })
        } else {
          if (!rt.running) {
            rt.staged = undefined
            const identity = rt.current === h.base ? rt.current : h.base
            rt.current = undefined
            rt.running = { identity, assignedAt: now, activeStreams: 0 }
          }
          fleet.boots.push({ key: c.key, rootfs: 'current', hostId: h.hostId })
        }
        if (fleet.gate) await fleet.gate
        return { url: `http://${h.hostId}/${c.key}` }
      },
      ready: async () => true,
      stop: (key) => fleet.suspend(key),
      controllerStats: async () => undefined,
      store: fleet.store,
      sleep: async (ms) => {
        fleet.clock.t += ms
        await Promise.resolve()
      },
      now: () => fleet.clock.t,
      log: (m) => fleet.logs.push(m),
      metric: () => {},
    }
  }

  advance(ms: number) {
    this.clock.t += ms
  }

  /** Wait for the background job to finish. */
  async jobDone(): Promise<RewarmStatus> {
    for (let i = 0; i < 2000; i++) {
      const s = await getRewarmStatus(this.store)
      if (s && s.state !== 'running' && s.state !== 'paused' && !(await this.store.leaseHolder('job'))) return s
      await new Promise((r) => setTimeout(r, 0))
    }
    throw new Error('job did not finish')
  }
}

const CFG = {
  auto: true,
  sinceHours: 48,
  concurrencyPerHost: 2,
  maxRuntimes: 1000,
  maxBytes: 0,
  minIntervalMs: 2 * 60 * MIN,
  settleMs: 2 * MIN,
  maxHostUtilPct: 75,
}

let fleet: FakeFleet

beforeEach(() => {
  fleet = new FakeFleet()
  fleet.addHost('h1')
  fleet.addHost('h2')
})

async function actions(): Promise<string[]> {
  return (await switchoverTick(fleet.deps)).map((r) => r.action)
}

/** Drain the refresh queue until it is empty, as the watcher would tick by tick. */
async function drainAll() {
  for (let i = 0; i < 50; i++) {
    const res = await drainRefreshQueue(fleet.deps, CFG)
    await Promise.all(res.running)
    if ((await getRefreshStatus(fleet.store)).queued === 0) return
    fleet.advance(MIN)
  }
  throw new Error('refresh queue did not drain')
}

async function switchTo(version: string) {
  fleet.stage('h1', version)
  fleet.stage('h2', version)
  expect(await actions()).toEqual(['activated'])
  expect(await fleet.heartbeat('h1')).toBe(version)
  expect(await fleet.heartbeat('h2')).toBe(version)
}

describe('rootfs switch-over (simulated fleet)', () => {
  test('activates once every host has the build, then warms every recent runtime on the new code', async () => {
    fleet.suspended('ws:proj:p1', 'h1')
    fleet.suspended('ws:proj:p2', 'h2')
    fleet.suspended('ws:w1', 'h2')
    fleet.addCandidate('ws:proj:p3') // never placed: boots wherever it lands
    fleet.running('ws:proj:busy', 'h1', 1 * MIN) // a user is on it
    fleet.running('ws:proj:idle', 'h2', 60 * MIN)
    await rewarmWatcherTick(fleet.deps, CFG) // records sha-1

    // One host staged: nothing happens until the region agrees.
    fleet.stage('h1', 'v2')
    expect(await actions()).toEqual(['staged-mixed'])
    expect(await fleet.heartbeat('h1')).toBeUndefined()

    fleet.stage('h2', 'v2')
    const [act] = await switchoverTick(fleet.deps, CFG)
    expect(act).toMatchObject({ action: 'activated', detail: 'staged on every host', queued: 6 })
    expect(fleet.boots).toHaveLength(0)
    // Mid-switch the hosts still report the old sha: no rollout sweep either way.
    expect((await rewarmWatcherTick(fleet.deps, CFG)).map((r) => r.action)).toEqual(['unchanged'])
    expect(await fleet.heartbeat('h1')).toBe('v2')
    expect(await fleet.heartbeat('h2')).toBe('v2')
    expect(await actions()).toEqual(['none'])

    // Nothing is booted while a host still has the build staged, nor before the delay.
    expect((await drainRefreshQueue(fleet.deps, CFG)).started).toEqual([])
    fleet.advance(SWITCHOVER.refreshDelayMs)
    await drainAll()
    expect((await getRefreshStatus(fleet.store)).counts).toEqual({ warmed: 4, 'left-running': 2 })
    expect(fleet.boots.every((b) => b.rootfs === 'current')).toBe(true)

    for (const key of ['ws:proj:p1', 'ws:proj:p2', 'ws:w1', 'ws:proj:p3']) {
      const st = fleet.status(key)!
      expect(st).toMatchObject({ state: 'suspended', rootfsFresh: true })
      expect(fleet.userOpen(key)).toEqual({ mode: 'resumed', identity: fleet.host(st.hostId).base })
    }
    // Running VMs were never stopped from the control plane.
    expect(fleet.stops).not.toContain('ws:proj:busy')
    expect(fleet.stops).not.toContain('ws:proj:idle')
    expect(fleet.status('ws:proj:idle')).toMatchObject({ state: 'assigned', rootfsFresh: false })

    // The host rotates the idle one: it comes back on the new image.
    await fleet.rotate('ws:proj:idle')
    fleet.advance(SWITCHOVER.refreshDelayMs)
    await drainAll()
    expect(fleet.status('ws:proj:idle')).toMatchObject({ state: 'suspended', rootfsFresh: true, snapshotRootfsIdentity: 'v2-h2' })

    // Once the hosts report v2 the rollout sweep has nothing to start.
    fleet.advance(CFG.settleMs)
    expect((await rewarmWatcherTick(fleet.deps, CFG)).map((r) => r.action)).toEqual(['unchanged'])
  })

  test('a runtime in use during the switch is retired on suspend and refreshed on the new image', async () => {
    fleet.running('ws:proj:busy', 'h1', 1 * MIN)
    await switchTo('v2')
    fleet.advance(SWITCHOVER.refreshDelayMs)
    await drainAll()

    // Its user leaves: a snapshot of the old image would resume old code, so
    // the host retires it instead and queues a refresh.
    const r = await fleet.suspend('ws:proj:busy')
    expect(r).toMatchObject({ retired: true })
    expect(fleet.status('ws:proj:busy')).toMatchObject({ state: 'none' })
    expect((await getRefreshStatus(fleet.store)).queued).toBe(1)

    // Not before the delay (gives its user a chance to come straight back).
    expect((await drainRefreshQueue(fleet.deps, CFG)).started).toEqual([])
    fleet.advance(SWITCHOVER.refreshDelayMs)
    const drained = await drainRefreshQueue(fleet.deps, CFG)
    expect(drained.started).toEqual(['ws:proj:busy'])
    await Promise.all(drained.running)

    expect(fleet.status('ws:proj:busy')).toMatchObject({ state: 'suspended', rootfsFresh: true, snapshotRootfsIdentity: 'v2-h1' })
    expect(fleet.boots.at(-1)).toEqual({ key: 'ws:proj:busy', rootfs: 'current', hostId: 'h1' })
    const stats = await getRefreshStatus(fleet.store)
    expect(stats.queued).toBe(0)
    expect(stats.counts).toEqual({ 'left-running': 1, warmed: 1 })
  })

  test('an always-on runtime the host rotates is booted again at once and left running', async () => {
    fleet.running('ws:proj:ao', 'h1', 30 * MIN)
    await switchTo('v2')
    await fleet.rotate('ws:proj:ao', { alwaysOn: true })

    const res = await drainRefreshQueue(fleet.deps, CFG)
    expect(res.started).toEqual(['ws:proj:ao'])
    await Promise.all(res.running)
    expect(fleet.status('ws:proj:ao')).toMatchObject({ state: 'assigned', rootfsFresh: true, snapshotRootfsIdentity: 'v2-h1' })
    expect(fleet.stops).not.toContain('ws:proj:ao')
    expect((await getRefreshStatus(fleet.store)).counts).toEqual({ 'kept-running': 1 })
  })

  test('the newest staged build is the one activated', async () => {
    fleet.stage('h1', 'v2')
    expect(await actions()).toEqual(['staged-mixed'])
    fleet.advance(MIN)
    fleet.stage('h1', 'v3')
    fleet.stage('h2', 'v3')
    expect(await actions()).toEqual(['activated'])
    // A host still on v2 is never told to activate.
    expect(await activateRootfsFor('us', 'v2', fleet.store)).toBeUndefined()
    expect(await fleet.heartbeat('h1')).toBe('v3')
    expect(await fleet.heartbeat('h2')).toBe('v3')
  })

  test('a region that never converges is activated after the staging wait', async () => {
    fleet.stage('h1', 'v2')
    expect(await actions()).toEqual(['staged-mixed'])
    fleet.advance(SWITCHOVER.stagingWaitMs - 1)
    expect(await actions()).toEqual(['staged-mixed'])
    fleet.advance(1)
    const [r] = await switchoverTick(fleet.deps, CFG)
    expect(r).toMatchObject({ action: 'activated', detail: 'staging wait over (never staged: h2)' })
    expect(await fleet.heartbeat('h1')).toBe('v2')
    // h2 has nothing staged, so nothing to activate.
    expect(await fleet.heartbeat('h2')).toBeUndefined()
    const sw = (await getSwitchoverStatus(fleet.store, ['us'])) as any
    expect(sw.us.activated).toBe('v2')
  })

  test("a staged pre-warm left by an older API is cancelled at activation", async () => {
    await fleet.store.set('prewarm:us', JSON.stringify({ version: 'v2', jobId: 'old-job', startedAt: fleet.clock.t }))
    await fleet.store.setStatus({ jobId: 'old-job', state: 'running' } as RewarmStatus)
    await fleet.store.acquireLease('job', 'old-api', 60 * MIN)
    await switchTo('v2')
    expect(await fleet.store.getControl()).toBe('cancel')
    expect(await fleet.store.get('prewarm:us')).toBeNull()
  })

  test('regions switch independently', async () => {
    fleet.addHost('e1', 'eu')
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    const res = await switchoverTick(fleet.deps, CFG)
    expect(res).toEqual([
      { region: 'us', action: 'activated', stagedVersion: 'v2', detail: 'staged on every host', queued: 0 },
      { region: 'eu', action: 'none' },
    ])
    expect(await activateRootfsFor('eu', 'v2', fleet.store)).toBeUndefined()
    expect(await activateRootfsFor('us', 'v2', fleet.store)).toBe('v2')
  })
})

describe('stale-rootfs refresh queue', () => {
  async function retire(key: string, hostId = 'h1') {
    fleet.addCandidate(key)
    await enqueueRefresh(key, { hostId, reason: 'stale-rootfs' }, fleet.store, fleet.clock.t)
    fleet.advance(SWITCHOVER.refreshDelayMs)
  }

  test(`at most ${SWITCHOVER.refreshPerHost} refreshes per host at a time`, async () => {
    const onH1 = Array.from({ length: SWITCHOVER.refreshPerHost + 1 }, (_, i) => `ws:proj:a${i}`)
    for (const k of onH1) await retire(k, 'h1')
    await retire('ws:proj:c', 'h2')
    const first = await drainRefreshQueue(fleet.deps, CFG)
    expect(first.started.sort()).toEqual([...onH1.slice(0, SWITCHOVER.refreshPerHost), 'ws:proj:c'].sort())
    await Promise.all(first.running)
    const second = await drainRefreshQueue(fleet.deps, CFG)
    expect(second.started).toEqual([onH1.at(-1)!])
    await Promise.all(second.running)
    expect((await getRefreshStatus(fleet.store)).queued).toBe(0)
  })

  test("never holds more spawn leases than the replica's lock pool can spare", async () => {
    // Production US on 2026-10-17: 2 hosts x refreshPerHost(4) = 8 warms on
    // the watcher's replica, each holding a spawn lease, against a 4-slot
    // lock pool — user opens on that replica could not get a lease.
    const budget = rewarmLeaseBudget(4)
    expect(budget).toBe(2)
    for (let i = 0; i < SWITCHOVER.refreshPerHost; i++) {
      await retire(`ws:proj:a${i}`, 'h1')
      await retire(`ws:proj:b${i}`, 'h2')
    }

    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let inFlight = 0
    let maxInFlight = 0
    const base = fleet.deps
    const deps: RewarmDeps = {
      ...base,
      boot: async (c, opts) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gate
        try {
          return await base.boot(c, opts)
        } finally {
          inFlight--
        }
      },
    }
    const capped = { ...CFG, leaseBudget: budget }

    const first = await drainRefreshQueue(deps, capped)
    expect(first.started).toHaveLength(budget)
    // The watcher ticks again while those boots are still in flight.
    fleet.advance(MIN)
    expect((await drainRefreshQueue(deps, capped)).started).toEqual([])

    release()
    await Promise.all(first.running)
    const rest: Promise<void>[] = []
    for (let i = 0; i < 10 && (await getRefreshStatus(fleet.store)).queued > 0; i++) {
      const res = await drainRefreshQueue(deps, capped)
      expect(res.started.length).toBeLessThanOrEqual(budget)
      await Promise.all(res.running)
      fleet.advance(MIN)
    }
    expect((await getRefreshStatus(fleet.store)).queued).toBe(0)
    expect(maxInFlight).toBeLessThanOrEqual(budget)
  })

  test('the rollout job is capped by the same lease budget', async () => {
    expect(rewarmLeaseBudget(8)).toBe(5)
    expect(rewarmLeaseBudget(1)).toBe(1)
    for (let i = 0; i < 12; i++) fleet.addCandidate(`ws:proj:j${i}`)
    let inFlight = 0
    let maxInFlight = 0
    const base = fleet.deps
    const deps: RewarmDeps = {
      ...base,
      boot: async (c, opts) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        try {
          return await base.boot(c, opts)
        } finally {
          inFlight--
        }
      },
    }
    const status = await runRewarm(
      { reason: 'test', sinceHours: 48, concurrencyPerHost: 4, maxRuntimes: 100 },
      deps,
      await base.listCandidates(0, 100),
      { ...CFG, leaseBudget: rewarmLeaseBudget(4) },
    )
    expect(status.concurrency).toBe(2)
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  test('waits while a job holds the lease, and on a host with a staged build pending', async () => {
    await retire('ws:proj:a', 'h1')
    await fleet.store.acquireLease('job', 'someone', 60_000)
    expect((await drainRefreshQueue(fleet.deps, CFG)).paused).toBe(true)
    await fleet.store.releaseLease('job', 'someone')

    fleet.stage('h1', 'v2')
    const res = await drainRefreshQueue(fleet.deps, CFG)
    expect(res.deferred).toEqual(['ws:proj:a'])
    expect(res.started).toEqual([])
    expect((await getRefreshStatus(fleet.store)).queued).toBe(1)
  })

  test('skips a host over its utilization limit', async () => {
    await retire('ws:proj:a', 'h1')
    fleet.host('h1').utilPct = 90
    expect((await drainRefreshQueue(fleet.deps, CFG)).started).toEqual([])
    fleet.host('h1').utilPct = 10
    expect((await drainRefreshQueue(fleet.deps, CFG)).started).toEqual(['ws:proj:a'])
  })

  test('a host that reports no memory is judged by its VM count, not the RAM ceiling', async () => {
    await retire('ws:proj:a', 'h1')
    const h = fleet.host('h1')
    h.reportsMemory = false
    // Past the 75% RAM ceiling but well under the 95% count ceiling: the busiest
    // host in the fleet looks like this, and barring it here is the QA round 1
    // regression (dal-1: 157 assigned VMs on ~400 GB of free RAM).
    h.utilPct = 80
    h.vmUtilPct = 80
    expect((await drainRefreshQueue(fleet.deps, CFG)).started).toEqual(['ws:proj:a'])
    await retire('ws:proj:a', 'h1')
    h.vmUtilPct = 96
    expect((await drainRefreshQueue(fleet.deps, CFG)).started).toEqual([])
  })

  test('a failing refresh is retried once, later, then dropped', async () => {
    fleet.failing.add('ws:proj:a')
    await retire('ws:proj:a', 'h1')
    const first = await drainRefreshQueue(fleet.deps, CFG)
    await Promise.all(first.running)
    expect((await getRefreshStatus(fleet.store)).queued).toBe(1)
    expect((await drainRefreshQueue(fleet.deps, CFG)).started).toEqual([])

    fleet.advance(SWITCHOVER.refreshRetryMs)
    const second = await drainRefreshQueue(fleet.deps, CFG)
    expect(second.started).toEqual(['ws:proj:a'])
    await Promise.all(second.running)
    const stats = await getRefreshStatus(fleet.store)
    expect(stats.queued).toBe(0)
    expect(stats.counts).toEqual({ 'boot-failed': 2 })
  })

  test('drops keys that no longer resolve and items past their expiry', async () => {
    await enqueueRefresh('ws:proj:gone', { hostId: 'h1' }, fleet.store, fleet.clock.t)
    fleet.advance(SWITCHOVER.refreshDelayMs)
    const res = await drainRefreshQueue(fleet.deps, CFG)
    await Promise.all(res.running)
    expect((await getRefreshStatus(fleet.store)).counts).toEqual({ dropped: 1 })

    await enqueueRefresh('ws:proj:old', { hostId: 'h2' }, fleet.store, fleet.clock.t)
    fleet.advance(SWITCHOVER.refreshExpiryMs + 1)
    expect((await drainRefreshQueue(fleet.deps, CFG)).expired).toEqual(['ws:proj:old'])
  })

  test('a user who came back first leaves nothing to do', async () => {
    fleet.running('ws:proj:a', 'h1', 0)
    await enqueueRefresh('ws:proj:a', { hostId: 'h1' }, fleet.store, fleet.clock.t)
    fleet.advance(SWITCHOVER.refreshDelayMs)
    const res = await drainRefreshQueue(fleet.deps, CFG)
    await Promise.all(res.running)
    expect(fleet.stops).toEqual([])
    expect((await getRefreshStatus(fleet.store)).counts).toEqual({ 'already-warm': 1 })
  })
})

describe('warm-up utilization', () => {
  test('uses host RAM when the host reports it, else the VM count', async () => {
    const { warmUtilPct } = await import('../metal-rewarm')
    expect(warmUtilPct({ utilPct: 119, load: { mem: { totalMiB: 1000, availableMiB: 600 } } })).toBe(40)
    expect(warmUtilPct({ utilPct: 119 })).toBe(119)
  })
})
