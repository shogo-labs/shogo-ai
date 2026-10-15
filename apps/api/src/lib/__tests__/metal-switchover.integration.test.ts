// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Rootfs switch-over, end to end against a simulated fleet.
 *
 * The fleet models what the metal-agent does with each runtime's slots: a
 * running VM (booted from some rootfs identity), a current-image snapshot and a
 * staged-image snapshot. Everything above it is the real control-plane code:
 * the watcher's switch-over tick, the staged pre-warm job, the heartbeat's
 * `activateRootfs`, the stale-rootfs refresh queue and the rollout re-warm.
 *
 * What it pins down:
 *  - users keep being served on the current image while the staged one warms;
 *  - after activation every recently used runtime resumes on the new image;
 *  - a runtime in use during the switch is never stopped, and is re-warmed on
 *    the new image once its user leaves;
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
  rewarmWatcherTick,
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
    this.hosts.set(hostId, { hostId, region, rootfsSha: 'sha-1', base: `A-${hostId}`, utilPct: 10, restarts: 0 })
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
    h.rootfsSha = `sha-${version}`
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
    // A normal open drops the staged snapshot; the next pre-warm can redo it.
    rt.staged = undefined
    const mode = rt.current ? 'resumed' : 'assigned'
    const identity = rt.current ?? h.base
    rt.current = undefined
    rt.running = { identity, assignedAt: now, lastRealActivityAt: now, activeStreams: 0 }
    return { mode, identity }
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
            const identity = rt.current ?? h.base
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

describe('rootfs switch-over (simulated fleet)', () => {
  test('pre-warms on the staged image, activates, and every recent runtime resumes on the new code', async () => {
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
    expect(fleet.boots).toHaveLength(0)

    fleet.stage('h2', 'v2')
    expect(await actions()).toEqual(['prewarm-started'])
    const job = await fleet.jobDone()
    expect(job.target).toBe('staged')
    expect(job.counts).toEqual({ warmed: 5, 'in-use': 1 })
    expect(fleet.boots.every((b) => b.rootfs === 'staged')).toBe(true)

    // Users are still served from the current image while it warms.
    expect(fleet.status('ws:proj:p1')).toMatchObject({ state: 'suspended', rootfsFresh: true, stagedSnapshotIdentity: 'v2-h1' })
    expect(fleet.status('ws:proj:idle')).toMatchObject({ state: 'suspended', rootfsFresh: true, stagedSnapshotIdentity: 'v2-h2' })
    expect(fleet.status('ws:proj:busy')).toMatchObject({ state: 'assigned', rootfsFresh: true })
    // No host is told to switch until the pre-warm is done.
    expect(await fleet.heartbeat('h1')).toBeUndefined()

    expect(await actions()).toEqual(['activated'])
    expect(await fleet.heartbeat('h1')).toBe('v2')
    expect(await fleet.heartbeat('h2')).toBe('v2')
    expect(await actions()).toEqual(['none'])

    // Every pre-warmed runtime now resumes, from a snapshot taken on the new image.
    for (const key of ['ws:proj:p1', 'ws:proj:p2', 'ws:w1', 'ws:proj:p3', 'ws:proj:idle']) {
      const st = fleet.status(key)!
      expect(st).toMatchObject({ state: 'suspended', rootfsFresh: true })
      expect(st.snapshotRootfsIdentity).toBe(fleet.host(st.hostId).base)
      expect(fleet.userOpen(key)).toEqual({ mode: 'resumed', identity: fleet.host(st.hostId).base })
    }

    // The runtime in use was never stopped: activation doesn't touch running VMs.
    expect(fleet.stops).not.toContain('ws:proj:busy')
    expect(fleet.status('ws:proj:busy')).toMatchObject({ state: 'assigned', rootfsFresh: false })
  })

  test('a runtime in use during the switch is retired on suspend and refreshed on the new image', async () => {
    fleet.running('ws:proj:busy', 'h1', 1 * MIN)
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    expect(await actions()).toEqual(['prewarm-started'])
    expect((await fleet.jobDone()).counts).toEqual({ 'in-use': 1 })
    expect(await actions()).toEqual(['activated'])
    await fleet.heartbeat('h1')
    await fleet.heartbeat('h2')

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
    expect(stats.counts).toEqual({ warmed: 1 })
  })

  test('the rollout re-warm after activation finds everything already warm', async () => {
    fleet.suspended('ws:proj:p1', 'h1')
    fleet.suspended('ws:proj:p2', 'h2')
    await rewarmWatcherTick(fleet.deps, CFG)
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    await actions()
    await fleet.jobDone()
    await actions()
    await fleet.heartbeat('h1')
    await fleet.heartbeat('h2')
    const bootsAfterSwitch = fleet.boots.length

    // The new sha settles, then the coverage sweep runs.
    expect((await rewarmWatcherTick(fleet.deps, CFG)).map((r) => r.action)).toEqual(['settling'])
    fleet.advance(CFG.settleMs)
    expect((await rewarmWatcherTick(fleet.deps, CFG)).map((r) => r.action)).toEqual(['started'])
    const sweep = await fleet.jobDone()
    expect(sweep.target).toBeUndefined()
    expect(sweep.counts).toEqual({ 'already-warm': 2 })
    expect(fleet.boots.length).toBe(bootsAfterSwitch)
  })

  test('a newer staged build mid pre-warm cancels it and the newest build is the one activated', async () => {
    fleet.suspended('ws:proj:p1', 'h1')
    fleet.suspended('ws:proj:p2', 'h2')
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    let release!: () => void
    fleet.gate = new Promise<void>((r) => (release = r))
    expect(await actions()).toEqual(['prewarm-started'])
    while (fleet.boots.length < 2) await new Promise((r) => setTimeout(r, 0))

    // v3 lands on both hosts while v2's boots are in flight.
    fleet.stage('h1', 'v3')
    fleet.stage('h2', 'v3')
    expect(await actions()).toEqual(['prewarm-superseded'])
    fleet.gate = null
    release()
    // Both VMs were already up on v2: the job sees the newer build and leaves
    // them alone rather than parking them in a dropped slot.
    const old = await fleet.jobDone()
    expect(old.counts).toEqual({ superseded: 2 })
    expect(await fleet.store.getControl()).toBe('cancel')
    // Their idle suspend (the host reaper) retires them: v2 is gone.
    expect(await fleet.suspend('ws:proj:p1')).toMatchObject({ retired: true })
    expect(await fleet.suspend('ws:proj:p2')).toMatchObject({ retired: true })

    expect(await actions()).toEqual(['prewarm-started'])
    const job = await fleet.jobDone()
    expect(job.counts).toEqual({ warmed: 2 })
    expect(await actions()).toEqual(['activated'])

    // A host still on v2 is never told to activate.
    expect(await activateRootfsFor('us', 'v2', fleet.store)).toBeUndefined()
    expect(await fleet.heartbeat('h1')).toBe('v3')
    expect(await fleet.heartbeat('h2')).toBe('v3')
    expect(fleet.status('ws:proj:p1')).toMatchObject({ state: 'suspended', rootfsFresh: true, snapshotRootfsIdentity: 'v3-h1' })
    expect(fleet.status('ws:proj:p2')).toMatchObject({ state: 'suspended', rootfsFresh: true, snapshotRootfsIdentity: 'v3-h2' })
  })

  test('a user opening a runtime mid pre-warm keeps it, and is never stopped', async () => {
    fleet.suspended('ws:proj:opened-mid-prewarm', 'h1')
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    let release!: () => void
    fleet.gate = new Promise<void>((r) => (release = r))
    await actions()
    await new Promise((r) => setTimeout(r, 0))
    // Opened through the normal path while the staged boot is pending. (Its own
    // key: markRuntimeOpened throttles per key, process-wide.)
    const { markRuntimeOpened } = await import('../metal-rewarm')
    await markRuntimeOpened('ws:proj:opened-mid-prewarm', fleet.store, fleet.clock.t + 1)
    fleet.gate = null
    release()
    const job = await fleet.jobDone()
    expect(job.counts).toEqual({ 'user-opened': 1 })
    expect(fleet.status('ws:proj:opened-mid-prewarm')).toMatchObject({ state: 'assigned' })
    expect(fleet.stops).toEqual([])
  })

  test('a pre-warm cut off by an API deploy is resumed, not activated half-done', async () => {
    fleet.suspended('ws:proj:p1', 'h1')
    fleet.suspended('ws:proj:p2', 'h2')
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    expect(await actions()).toEqual(['prewarm-started'])
    const first = await fleet.jobDone()
    expect(first.counts).toEqual({ warmed: 2 })
    // The replica running it died: its status still says running, but nobody holds the lease.
    await fleet.store.setStatus({ ...first, state: 'running', finishedAt: undefined })
    const boots = fleet.boots.length
    fleet.advance(MIN)

    expect(await actions()).toEqual(['prewarm-resumed'])
    expect(await fleet.heartbeat('h1')).toBeUndefined()
    const resumed = await fleet.jobDone()
    expect(resumed.jobId).not.toBe(first.jobId)
    expect(resumed.counts).toEqual({ 'already-warm': 2 })
    expect(fleet.boots.length).toBe(boots)

    expect(await actions()).toEqual(['activated'])
    expect(await fleet.heartbeat('h1')).toBe('v2')
  })

  test('a pre-warm interrupted past the timeout activates', async () => {
    fleet.suspended('ws:proj:p1', 'h1')
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    await actions()
    const first = await fleet.jobDone()
    await fleet.store.setStatus({ ...first, state: 'running', finishedAt: undefined })
    fleet.advance(SWITCHOVER.prewarmTimeoutMs)
    expect(await actions()).toEqual(['activated'])
  })

  test('a host that cannot pre-warm activates its region straight away', async () => {
    fleet.suspended('ws:proj:p1', 'h1')
    fleet.stage('h1', 'v2', { prewarm: false })
    fleet.stage('h2', 'v2')
    expect(await actions()).toEqual(['activated'])
    expect(fleet.boots).toHaveLength(0)
    expect(await fleet.heartbeat('h1')).toBe('v2')
  })

  test('a region that never converges is activated at the pre-warm timeout', async () => {
    fleet.stage('h1', 'v2')
    expect(await actions()).toEqual(['staged-mixed'])
    fleet.advance(SWITCHOVER.prewarmTimeoutMs - 1)
    expect(await actions()).toEqual(['staged-mixed'])
    fleet.advance(1)
    expect(await actions()).toEqual(['activated'])
    expect(await fleet.heartbeat('h1')).toBe('v2')
    // h2 has nothing staged, so nothing to activate.
    expect(await fleet.heartbeat('h2')).toBeUndefined()
    const sw = (await getSwitchoverStatus(fleet.store, ['us'])) as any
    expect(sw.us.activated).toBe('v2')
  })

  test('regions switch independently', async () => {
    fleet.addHost('e1', 'eu')
    fleet.stage('h1', 'v2')
    fleet.stage('h2', 'v2')
    const res = await switchoverTick(fleet.deps)
    expect(res).toEqual([
      { region: 'us', action: 'prewarm-started', stagedVersion: 'v2', detail: expect.any(String) },
      { region: 'eu', action: 'none' },
    ])
    await fleet.jobDone()
    await actions()
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

  test('one refresh per host at a time', async () => {
    await retire('ws:proj:a', 'h1')
    await retire('ws:proj:b', 'h1')
    await retire('ws:proj:c', 'h2')
    const first = await drainRefreshQueue(fleet.deps, CFG)
    expect(first.started.sort()).toEqual(['ws:proj:a', 'ws:proj:c'])
    await Promise.all(first.running)
    const second = await drainRefreshQueue(fleet.deps, CFG)
    expect(second.started).toEqual(['ws:proj:b'])
    await Promise.all(second.running)
    expect((await getRefreshStatus(fleet.store)).queued).toBe(0)
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
