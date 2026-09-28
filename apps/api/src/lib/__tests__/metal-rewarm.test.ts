// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let projectsByMessage: Array<{ id: string; lastMessageAt: Date }> = []
let projectSessions: Array<{ contextId: string; lastActiveAt: Date }> = []
let workspaceSessions: Array<{ id: string; workspaceId: string; lastActiveAt: Date }> = []
let projectRows: Array<{ id: string; workspaceId: string; runtimeEnabled: boolean; workingMode: string }> = []
let ineligible = new Set<string>()

mock.module('../prisma', () => ({
  prisma: {
    project: {
      findMany: async (args: any) => {
        if (args.where?.lastMessageAt) return projectsByMessage
        const ids: string[] = args.where.id.in
        return projectRows
          .filter((p) => ids.includes(p.id) && p.runtimeEnabled === args.where.runtimeEnabled && p.workingMode === args.where.workingMode)
          .map(({ id, workspaceId }) => ({ id, workspaceId }))
      },
    },
    chatSession: {
      findMany: async (args: any) => (args.where.contextId === null ? workspaceSessions : projectSessions),
    },
  },
}))
mock.module('../metal-eligibility', () => ({
  isMetalEligibleProject: (id: string) => !ineligible.has(id),
}))

const {
  MemoryRewarmStore,
  getRewarmStatus,
  listRewarmCandidatesFromDb,
  markRuntimeOpened,
  parseRewarmRequest,
  rewarmWatcherTick,
  runRewarm,
  startRewarmJob,
  REWARM_JOB_LEASE,
} = await import('../metal-rewarm')
type RewarmCandidate = import('../metal-rewarm').RewarmCandidate
type RewarmDeps = import('../metal-rewarm').RewarmDeps
type RewarmHost = import('../metal-rewarm').RewarmHost
type RuntimeHostStatus = import('../metal-warm-pool-controller').RuntimeHostStatus

const H = 60 * 60_000

function cand(id: string, kind: 'project' | 'workspace' = 'project'): RewarmCandidate {
  return kind === 'project'
    ? { key: `ws:proj:${id}`, kind, projectId: id, workspaceId: 'w1', lastActiveAt: 1 }
    : { key: `ws:${id}`, kind, workspaceId: id, sessionId: 's1', lastActiveAt: 1 }
}

interface Harness {
  deps: RewarmDeps
  store: InstanceType<typeof MemoryRewarmStore>
  statuses: Map<string, RuntimeHostStatus | null>
  afterBoot: Map<string, RuntimeHostStatus | null>
  booted: string[]
  stopped: string[]
  recycled: string[]
  hosts: RewarmHost[]
  clock: { t: number }
  maxInFlight: number
}

function harness(over: Partial<RewarmDeps> = {}): Harness {
  const store = new MemoryRewarmStore()
  const clock = { t: 1_800_000_000_000 }
  const h: Harness = {
    store,
    statuses: new Map(),
    afterBoot: new Map(),
    booted: [],
    stopped: [],
    recycled: [],
    hosts: [{ hostId: 'h1', region: 'us', rootfsSha: 'new', utilPct: 10, overWatermark: false }],
    clock,
    maxInFlight: 0,
    deps: undefined as any,
  }
  let inFlight = 0
  h.deps = {
    listCandidates: async () => [],
    listHosts: async () => h.hosts,
    runtimeStatus: async (key) => (h.booted.includes(key) ? h.afterBoot.get(key) ?? null : h.statuses.get(key) ?? null),
    recycle: async (key) => {
      h.recycled.push(key)
      return { ok: true }
    },
    boot: async (c) => {
      inFlight++
      h.maxInFlight = Math.max(h.maxInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      h.booted.push(c.key)
      return { url: `http://vm/${c.key}` }
    },
    ready: async () => true,
    stop: async (key) => {
      h.stopped.push(key)
      return { suspended: true, busy: false, memBytes: 100 }
    },
    controllerStats: async () => ({ warmHitRate: 0.5 }),
    store,
    sleep: async (ms) => {
      clock.t += ms
      await Promise.resolve()
    },
    now: () => clock.t,
    log: () => {},
    metric: () => {},
    ...over,
  }
  return h
}

const opts = { reason: 'test', sinceHours: 48, concurrencyPerHost: 2, maxRuntimes: 100 }
const cfg = { maxHostUtilPct: 75 }

function assigned(over: Partial<RuntimeHostStatus> = {}): RuntimeHostStatus {
  return { hostId: 'h1', region: 'us', state: 'assigned', rootfsFresh: false, realIdleMs: 60 * 60_000, activeStreams: 0, ...over }
}

describe('runRewarm per-key flow', () => {
  test('boots an unplaced runtime and suspends it on the new rootfs', async () => {
    const h = harness()
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(h.booted).toEqual(['ws:proj:p1'])
    expect(h.stopped).toEqual(['ws:proj:p1'])
    expect(s.counts).toEqual({ warmed: 1 })
    expect(s.bytesMem).toBe(100)
    expect(s.state).toBe('done')
    expect(s.statsBefore).toEqual({ warmHitRate: 0.5 })
  })

  test('skips a runtime already running on the new rootfs', async () => {
    const h = harness()
    h.statuses.set('ws:proj:p1', assigned({ rootfsFresh: true }))
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ 'already-warm': 1 })
    expect(h.booted).toEqual([])
  })

  test('skips a fresh local snapshot', async () => {
    const h = harness()
    h.statuses.set('ws:proj:p1', { hostId: 'h1', region: 'us', state: 'suspended', rootfsFresh: true })
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ 'already-warm': 1 })
  })

  test('re-boots a stale local snapshot', async () => {
    const h = harness()
    h.statuses.set('ws:proj:p1', { hostId: 'h1', region: 'us', state: 'suspended', rootfsFresh: false })
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ warmed: 1 })
  })

  test('leaves a stale runtime alone while it is in use', async () => {
    const h = harness()
    h.statuses.set('ws:proj:busy', assigned({ activeStreams: 1 }))
    h.statuses.set('ws:proj:recent', assigned({ realIdleMs: 60_000 }))
    const s = await runRewarm(opts, h.deps, [cand('busy'), cand('recent')], cfg)
    expect(s.counts).toEqual({ 'in-use': 2 })
    expect(h.recycled).toEqual([])
    expect(h.booted).toEqual([])
  })

  test('recycles an idle stale runtime, then boots and suspends it', async () => {
    const h = harness()
    h.statuses.set('ws:proj:p1', assigned())
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(h.recycled).toEqual(['ws:proj:p1'])
    expect(h.booted).toEqual(['ws:proj:p1'])
    expect(s.counts).toEqual({ warmed: 1 })
  })

  test('an aborted recycle (backup failed) boots nothing', async () => {
    const h = harness({ recycle: async () => ({ ok: false, error: 'backup failed' }) })
    h.statuses.set('ws:proj:p1', assigned())
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ 'recycle-aborted': 1 })
    expect(s.recent[0].detail).toBe('backup failed')
    expect(h.booted).toEqual([])
  })

  test('an agent without rootfsFresh is never recycled', async () => {
    const h = harness()
    h.statuses.set('ws:proj:p1', assigned({ rootfsFresh: undefined }))
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ 'unknown-rootfs': 1 })
    expect(h.recycled).toEqual([])
  })

  test('skips keys placed in another region', async () => {
    const h = harness()
    h.statuses.set('ws:proj:p1', assigned({ region: 'eu' }))
    const s = await runRewarm({ ...opts, region: 'us' }, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ 'other-region': 1 })
  })

  test('leaves the runtime running when a user opened it during the warm boot', async () => {
    const h = harness({
      boot: async (c) => {
        await markRuntimeOpened(c.key, h.store, h.clock.t + 1)
        h.booted.push(c.key)
        return { url: 'http://vm' }
      },
    })
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ 'user-opened': 1 })
    expect(h.stopped).toEqual([])
  })

  test('an open from before the warm boot does not count', async () => {
    const h = harness()
    await markRuntimeOpened('ws:proj:p1', h.store, h.clock.t - 60_000)
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ warmed: 1 })
  })

  test('leaves the runtime running when the host saw real activity since boot', async () => {
    const h = harness()
    h.afterBoot.set('ws:proj:p1', assigned({ rootfsFresh: true, assignedAt: 10, lastRealActivityAt: 20 }))
    h.afterBoot.set('ws:proj:p2', assigned({ rootfsFresh: true, activeStreams: 1 }))
    h.afterBoot.set('ws:proj:p3', assigned({ rootfsFresh: true, assignedAt: 10, lastRealActivityAt: 10 }))
    const s = await runRewarm(opts, h.deps, [cand('p1'), cand('p2'), cand('p3')], cfg)
    expect(s.counts).toEqual({ 'user-opened': 2, warmed: 1 })
    expect(h.stopped).toEqual(['ws:proj:p3'])
  })

  test('a busy stop leaves it running; a failed stop is reported', async () => {
    const h = harness({
      stop: async (key) => (key === 'ws:proj:busy' ? { suspended: false, busy: true } : { suspended: false, busy: false }),
    })
    const s = await runRewarm(opts, h.deps, [cand('busy'), cand('lost')], cfg)
    expect(s.counts).toEqual({ busy: 1, 'suspend-failed': 1 })
  })

  test('retries a boot that is still coming up, then gives up at the deadline', async () => {
    let calls = 0
    const h = harness({
      boot: async () => {
        calls++
        throw new Error('assign timed out')
      },
    })
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(calls).toBeGreaterThan(10)
    expect(s.counts).toEqual({ 'boot-failed': 1 })
    expect(s.recent[0].detail).toBe('assign timed out')
  })

  test('succeeds once a slow boot answers', async () => {
    let calls = 0
    const h = harness({
      boot: async (c) => {
        if (++calls < 4) throw new Error('booting')
        h.booted.push(c.key)
        return { url: 'http://vm' }
      },
    })
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ warmed: 1 })
  })

  test('suspends anyway when the API server never becomes ready', async () => {
    const h = harness({ ready: async () => false })
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.counts).toEqual({ 'warmed-api-not-ready': 1 })
    expect(h.stopped).toEqual(['ws:proj:p1'])
  })
})

describe('runRewarm limits', () => {
  test('caps concurrency at concurrencyPerHost x hosts', async () => {
    const h = harness()
    const s = await runRewarm({ ...opts, concurrencyPerHost: 2 }, h.deps, Array.from({ length: 10 }, (_, i) => cand(`p${i}`)), cfg)
    expect(s.concurrency).toBe(2)
    expect(h.maxInFlight).toBeLessThanOrEqual(2)
    expect(s.counts.warmed).toBe(10)
  })

  test('never exceeds 12 workers', async () => {
    const h = harness()
    h.hosts = Array.from({ length: 20 }, (_, i) => ({ hostId: `h${i}`, region: 'us', utilPct: 0, overWatermark: false }))
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(s.concurrency).toBe(12)
  })

  test('cancel stops starting new runtimes', async () => {
    const h = harness({
      boot: async (c) => {
        h.booted.push(c.key)
        if (h.booted.length === 2) await h.store.setControl('cancel')
        return { url: 'http://vm' }
      },
    })
    const s = await runRewarm({ ...opts, concurrencyPerHost: 1 }, h.deps, Array.from({ length: 6 }, (_, i) => cand(`p${i}`)), cfg)
    expect(s.state).toBe('cancelled')
    expect(h.booted.length).toBe(2)
    expect(s.counts.cancelled).toBe(4)
    expect(s.done).toBe(6)
  })

  test('waits while every host is saturated', async () => {
    const h = harness()
    h.hosts = [{ hostId: 'h1', region: 'us', utilPct: 90, overWatermark: false }]
    let waited = 0
    const baseSleep = h.deps.sleep
    h.deps.sleep = async (ms) => {
      waited += ms
      if (waited >= 30_000) h.hosts = [{ hostId: 'h1', region: 'us', utilPct: 10, overWatermark: false }]
      await baseSleep(ms)
    }
    const s = await runRewarm(opts, h.deps, [cand('p1')], cfg)
    expect(waited).toBeGreaterThanOrEqual(30_000)
    expect(s.counts).toEqual({ warmed: 1 })
  })

  test('the bytes guard stops starting boots once the budget is spent', async () => {
    const h = harness()
    const s = await runRewarm({ ...opts, concurrencyPerHost: 1, maxBytes: 150 }, h.deps, [cand('a'), cand('b'), cand('c')], cfg)
    expect(s.counts).toEqual({ warmed: 2, 'skipped-bytes': 1 })
  })

  test('workspace candidates boot with their session', async () => {
    const seen: RewarmCandidate[] = []
    const h = harness({
      boot: async (c) => {
        seen.push(c)
        h.booted.push(c.key)
        return { url: 'http://vm' }
      },
    })
    await runRewarm(opts, h.deps, [cand('w9', 'workspace')], cfg)
    expect(seen[0]).toMatchObject({ key: 'ws:w9', workspaceId: 'w9', sessionId: 's1' })
    expect(h.stopped).toEqual(['ws:w9'])
  })
})

describe('startRewarmJob', () => {
  test('dryRun lists candidates without starting', async () => {
    const h = harness({ listCandidates: async () => [cand('p1'), cand('p2')] })
    const r = await startRewarmJob({ reason: 't', dryRun: true }, h.deps)
    expect(r).toMatchObject({ started: false, dryRun: true, total: 2 })
    expect(r.candidates?.map((c) => c.key)).toEqual(['ws:proj:p1', 'ws:proj:p2'])
    expect(await h.store.getStatus()).toBeNull()
  })

  test('only one job runs at a time', async () => {
    const h = harness({ listCandidates: async () => [cand('p1')] })
    await h.store.acquireLease(REWARM_JOB_LEASE, 'other-replica', 60_000)
    const r = await startRewarmJob({ reason: 't' }, h.deps)
    expect(r).toMatchObject({ started: false, error: 'already-running' })
  })

  test('starts, runs in the background and releases the lease', async () => {
    const h = harness({ listCandidates: async () => [cand('p1')] })
    const r = await startRewarmJob({ reason: 't' }, h.deps)
    expect(r.started).toBe(true)
    for (let i = 0; i < 50 && (await h.store.getStatus())?.state !== 'done'; i++) await Bun.sleep(1)
    expect((await h.store.getStatus())?.counts).toEqual({ warmed: 1 })
    for (let i = 0; i < 50 && (await h.store.leaseHolder(REWARM_JOB_LEASE)); i++) await Bun.sleep(1)
    expect(await h.store.leaseHolder(REWARM_JOB_LEASE)).toBeNull()
  })

  test('a running status without a lease holder reads as interrupted', async () => {
    const store = new MemoryRewarmStore()
    await store.setStatus({
      jobId: 'j', reason: 'r', region: null, state: 'running', startedAt: 1, sinceHours: 48,
      concurrency: 2, total: 3, done: 1, counts: {}, bytesMem: 0, recent: [],
    })
    expect((await getRewarmStatus(store))?.state).toBe('interrupted')
  })
})

describe('rewarmWatcherTick', () => {
  function watcher(hosts: RewarmHost[]) {
    const h = harness()
    h.hosts = hosts
    const starts: any[] = []
    const start = async (input: any) => {
      starts.push(input)
      return { started: true, jobId: 'j1', total: 5 }
    }
    const config = {
      auto: true, sinceHours: 48, concurrencyPerHost: 2, maxRuntimes: 100, maxBytes: 0,
      minIntervalMs: 2 * H, settleMs: 2 * 60_000, maxHostUtilPct: 75,
    }
    const tick = () => rewarmWatcherTick(h.deps, config, start)
    /** A changed sha must hold for the settle window before a job starts. */
    const settledTick = async () => {
      const first = await tick()
      if (!first.some((r) => r.action === 'settling')) return first
      h.clock.t += config.settleMs
      return tick()
    }
    return { h, starts, tick, settledTick, config }
  }
  const host = (id: string, sha: string | undefined, region = 'us'): RewarmHost => ({
    hostId: id, region, rootfsSha: sha, utilPct: 0, overWatermark: false,
  })

  test('the first observation records the sha without warming', async () => {
    const w = watcher([host('a', 'v1'), host('b', 'v1')])
    expect(await w.tick()).toEqual([{ region: 'us', action: 'recorded', rootfsSha: 'v1' }])
    expect(w.starts).toEqual([])
    expect(await w.tick()).toEqual([{ region: 'us', action: 'unchanged', rootfsSha: 'v1' }])
  })

  test('waits until every live host in the region reports the new sha, then starts once', async () => {
    const w = watcher([host('a', 'v1'), host('b', 'v1')])
    await w.tick()
    w.h.hosts = [host('a', 'v2'), host('b', 'v1')]
    expect((await w.tick())[0].action).toBe('mixed')
    w.h.hosts = [host('a', 'v2'), host('b', undefined)]
    expect((await w.tick())[0].action).toBe('mixed')
    w.h.hosts = [host('a', 'v2'), host('b', 'v2')]
    expect((await w.settledTick())[0].action).toBe('started')
    expect(w.starts).toEqual([{ reason: 'rootfs v2 rollout in us', region: 'us' }])
    expect((await w.tick())[0].action).toBe('unchanged')
    expect(w.starts.length).toBe(1)
  })

  test('waits out the settle window after the region converges', async () => {
    const w = watcher([host('a', 'v1')])
    await w.tick()
    w.h.hosts = [host('a', 'v2')]
    expect((await w.tick())[0].action).toBe('settling')
    w.h.clock.t += w.config.settleMs - 1
    expect((await w.tick())[0].action).toBe('settling')
    w.h.clock.t += 1
    expect((await w.tick())[0].action).toBe('started')
  })

  test('regions are independent', async () => {
    const w = watcher([host('a', 'v1', 'us'), host('b', 'v1', 'eu')])
    await w.tick()
    w.h.hosts = [host('a', 'v2', 'us'), host('b', 'v1', 'eu')]
    const res = await w.settledTick()
    expect(res.find((r) => r.region === 'us')?.action).toBe('started')
    expect(res.find((r) => r.region === 'eu')?.action).toBe('unchanged')
  })

  test('a quick second rebuild waits for the minimum interval, then fires', async () => {
    const w = watcher([host('a', 'v1')])
    await w.tick()
    w.h.hosts = [host('a', 'v2')]
    await w.settledTick()
    w.h.hosts = [host('a', 'v3')]
    expect((await w.settledTick())[0].action).toBe('min-interval')
    w.h.clock.t += 2 * H
    expect((await w.tick())[0].action).toBe('started')
    expect(w.starts.length).toBe(2)
  })

  test('retries when another job holds the lease', async () => {
    const w = watcher([host('a', 'v1')])
    await w.tick()
    w.h.hosts = [host('a', 'v2')]
    expect((await w.tick())[0].action).toBe('settling')
    w.h.clock.t += w.config.settleMs
    const res = await rewarmWatcherTick(w.h.deps, w.config, async () => ({ started: false, total: 3, error: 'already-running' }))
    expect(res[0].action).toBe('busy')
    expect((await w.tick())[0].action).toBe('started')
  })
})

describe('listRewarmCandidatesFromDb', () => {
  beforeEach(() => {
    ineligible = new Set()
    projectRows = []
  })

  test('merges project and workspace activity, filters, and orders newest first', async () => {
    const at = (n: number) => new Date(n * 1000)
    projectsByMessage = [{ id: 'p1', lastMessageAt: at(10) }]
    projectSessions = [
      { contextId: 'p1', lastActiveAt: at(30) },
      { contextId: 'p2', lastActiveAt: at(20) },
      { contextId: 'off', lastActiveAt: at(50) },
      { contextId: 'local', lastActiveAt: at(50) },
      { contextId: 'knative', lastActiveAt: at(50) },
    ]
    workspaceSessions = [
      { id: 's-new', workspaceId: 'w1', lastActiveAt: at(25) },
      { id: 's-old', workspaceId: 'w1', lastActiveAt: at(5) },
    ]
    projectRows = [
      { id: 'p1', workspaceId: 'w1', runtimeEnabled: true, workingMode: 'managed' },
      { id: 'p2', workspaceId: 'w2', runtimeEnabled: true, workingMode: 'managed' },
      { id: 'off', workspaceId: 'w1', runtimeEnabled: false, workingMode: 'managed' },
      { id: 'local', workspaceId: 'w1', runtimeEnabled: true, workingMode: 'local' },
      { id: 'knative', workspaceId: 'w1', runtimeEnabled: true, workingMode: 'managed' },
    ]
    ineligible = new Set(['knative'])

    const out = await listRewarmCandidatesFromDb(0, 100)
    expect(out.map((c) => c.key)).toEqual(['ws:proj:p1', 'ws:w1', 'ws:proj:p2'])
    expect(out[0]).toMatchObject({ kind: 'project', projectId: 'p1', workspaceId: 'w1', lastActiveAt: 30_000 })
    expect(out[1]).toMatchObject({ kind: 'workspace', workspaceId: 'w1', sessionId: 's-new' })

    expect((await listRewarmCandidatesFromDb(0, 1)).map((c) => c.key)).toEqual(['ws:proj:p1'])
  })
})

describe('parseRewarmRequest', () => {
  const actor = { id: 'u1', email: 'ops@shogo.ai' }

  test('defaults: manual reason, all regions, env-driven limits', () => {
    const r = parseRewarmRequest({}, actor)
    expect(r).toEqual({
      ok: true,
      input: {
        reason: 'manual re-warm by ops@shogo.ai',
        region: null,
        sinceHours: undefined,
        concurrencyPerHost: undefined,
        maxRuntimes: undefined,
        maxBytes: undefined,
        dryRun: false,
        actor,
      },
    })
  })

  test('passes through valid overrides', () => {
    const r = parseRewarmRequest({ sinceHours: 24, region: 'us', dryRun: true, concurrency: 3, maxRuntimes: 50, reason: 'hotfix' }, actor)
    expect(r.ok && r.input).toMatchObject({ sinceHours: 24, region: 'us', dryRun: true, concurrencyPerHost: 3, maxRuntimes: 50, reason: 'hotfix' })
  })

  test('rejects out-of-range values', () => {
    expect(parseRewarmRequest({ sinceHours: 0 }, actor).ok).toBe(false)
    expect(parseRewarmRequest({ concurrency: 50 }, actor).ok).toBe(false)
    expect(parseRewarmRequest({ maxRuntimes: 'lots' }, actor).ok).toBe(false)
    expect(parseRewarmRequest({ region: 7 }, actor).ok).toBe(false)
  })

  test('manual jobs write admin-audit start and finish lines', async () => {
    const logs: string[] = []
    const h = harness({ listCandidates: async () => [cand('p1')], log: (m) => logs.push(m) })
    await startRewarmJob({ reason: 'r', actor }, h.deps)
    for (let i = 0; i < 50 && !logs.some((l) => l.includes('rewarm.finished') && l.startsWith('[admin-audit]')); i++) {
      await Bun.sleep(1)
    }
    const audit = logs.filter((l) => l.startsWith('[admin-audit]')).map((l) => JSON.parse(l.slice('[admin-audit] '.length)))
    expect(audit.map((a) => a.event)).toEqual(['admin.metal.rewarm.started', 'admin.metal.rewarm.finished'])
    expect(audit[0]).toMatchObject({ actorId: 'u1', actorEmail: 'ops@shogo.ai', total: 1 })
    expect(audit[1]).toMatchObject({ state: 'done', counts: { warmed: 1 } })
  })
})

describe('markRuntimeOpened', () => {
  test('throttles repeat writes for the same key', async () => {
    const store = new MemoryRewarmStore()
    await markRuntimeOpened('ws:proj:t1', store, 1_000_000)
    await markRuntimeOpened('ws:proj:t1', store, 1_005_000)
    expect(await store.get('opened:ws:proj:t1')).toBe('1000000')
    await markRuntimeOpened('ws:proj:t1', store, 1_020_000)
    expect(await store.get('opened:ws:proj:t1')).toBe('1020000')
  })
})
