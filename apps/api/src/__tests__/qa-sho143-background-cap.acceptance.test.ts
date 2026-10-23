// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The background pool does not pay for its cap with someone's work (SHO-143).
 *
 * The bug this card fixes, from the report on a real Windows desktop: with
 * `WORKSPACE_BACKGROUND_MAX` at 2 and ~8 board agents waking on cards, that host
 * evicted a background runtime **146 times in 24h and kept one 0 times**,
 * killing merge waiters and builds each time. The preview pool, calling the same
 * `hasActiveWork()`, kept 182 — so the probe answered for previews and never for
 * background runtimes.
 *
 * These tests take the card's acceptance criteria through the desktop API's own
 * pool ({@link RuntimeManager}), stubbing only the embedded worker's two seams
 * (`status()` and `activityDecision()`), with the REAL `decideBusy` behind the
 * verdict — so "unknown is busy" and the startup grace behave as they do in
 * production and a regression in the pool cannot hide behind a stub:
 *
 *   - the default background cap is 10, and the derived global ceiling leaves
 *     room for previews + background + a workspace session;
 *   - ten background agents (plus three open previews) evict nothing;
 *   - over the cap, only idle runtimes are victims, each logged with its counts;
 *   - a busy runtime is never a victim — the pool sits over its cap and says so;
 *   - a probe that failed (the Samsara case) reads as unknown, i.e. keep;
 *   - an open preview is never a candidate for the background pool;
 *   - low host memory frees an IDLE runtime and queues the start, never killing
 *     a busy one;
 *   - a runtime whose process is gone is reaped, not "evicted".
 */
import { describe, expect, mock, test } from 'bun:test'
import {
  RuntimeManager,
  projectWorkspaceRuntimeKey,
  resolveRuntimeMaxCount,
  resolveWorkspaceBackgroundMax,
  resolveWorkspacePreviewMax,
} from '../lib/runtime/manager'
import { decideBusy, type ActivityCounts } from '@shogo-ai/worker/runtime-activity'

type PrivateRM = RuntimeManager & {
  runtimes: Map<string, any>
  usedPorts: Set<number>
  agentManager: any
  agentManagedProjects: Set<string>
  workspaceBackgroundMru: string[]
  workspacePreviewMru: string[]
  workspaceBackgroundMax: number
  workspacePreviewMax: number
  enforceWorkspaceBackgroundCap: () => Promise<void>
  admitBackgroundStart: (key: string) => Promise<void>
  evictIdleBackgroundForMemory: (exceptKey: string) => Promise<boolean>
  stop: (key: string, reason?: string) => Promise<void>
}

const IDLE: ActivityCounts = { turns: 0, tasks: 0, streams: 0, children: 0 }

/** Fake verdict inputs per runtime key: work counts, or a failed probe. */
let work: Map<string, ActivityCounts>
let probeFailed: Set<string>

function fakeProcess(exited = false) {
  return {
    killed: false,
    exitCode: exited ? 0 : null,
    kill: mock(() => true),
    on: mock(() => undefined),
  }
}

/**
 * A manager whose embedded worker is stubbed at exactly the seams the pool
 * reads: `status(key)` for liveness/age, `refreshActivity(key)` for the pre-
 * eviction re-read, and `activityDecision(key)` for the verdict. The verdict is
 * the real `decideBusy`, fed from the per-key activity below.
 */
function newManager(): { rm: PrivateRM; stopped: Array<{ key: string; reason?: string }> } {
  const rm = new RuntimeManager({ healthCheckInterval: 50 }) as PrivateRM
  work = new Map()
  probeFailed = new Set()
  const startedAt = Date.now() - 10 * 60_000
  rm.agentManager = {
    touch: mock(() => {}),
    stop: mock(async () => {}),
    refreshActivity: mock(async () => {}),
    status: (key: string) => {
      const rt = rm.runtimes.get(key)
      if (!rt) return undefined
      return {
        projectId: key,
        status: rt.status,
        agentPort: rt.agentPort,
        startedAt: rt.startedAt,
        lastUsedAt: rt.startedAt,
        restarts: 0,
      }
    },
    activityDecision: (key: string, opts?: { terminalSessions?: number; inflightCalls?: number }) =>
      decideBusy({
        now: Date.now(),
        startedAt,
        status: 'running',
        sample: probeFailed.has(key)
          ? { counts: IDLE, at: Date.now(), ok: false, failingSince: Date.now() }
          : { counts: work.get(key) ?? IDLE, at: Date.now(), ok: true },
        terminalSessions: opts?.terminalSessions,
        inflightCalls: opts?.inflightCalls,
      }),
  }
  const stopped: Array<{ key: string; reason?: string }> = []
  ;(rm as any).stop = mock(async (key: string, reason?: string) => {
    stopped.push({ key, reason })
  })
  return { rm, stopped }
}

let nextPort = 37400

/** A settled (10 min old, past the startup grace) background runtime. */
function seedBackground(rm: PrivateRM, name: string, opts: { busy?: boolean } = {}) {
  const key = projectWorkspaceRuntimeKey(name)
  const port = nextPort++
  rm.runtimes.set(key, {
    id: key,
    port,
    agentPort: port + 1000,
    status: 'running',
    url: `http://localhost:${port}`,
    startedAt: Date.now() - 10 * 60_000,
    process: null,
    agentProcess: fakeProcess(),
    background: true,
  })
  rm.agentManagedProjects.add(key)
  rm.usedPorts.add(port)
  if (opts.busy) work.set(key, { turns: 0, tasks: 1, streams: 0, children: 0 })
  return key
}

/** An open preview (foreground) runtime, tracked in the preview MRU. */
function seedPreview(rm: PrivateRM, name: string) {
  const key = projectWorkspaceRuntimeKey(name)
  const port = nextPort++
  rm.runtimes.set(key, {
    id: key,
    port,
    agentPort: port + 1000,
    status: 'running',
    url: `http://localhost:${port}`,
    startedAt: Date.now() - 10 * 60_000,
    process: null,
    agentProcess: fakeProcess(),
    background: false,
  })
  rm.agentManagedProjects.add(key)
  rm.usedPorts.add(port)
  return key
}

/** Most-recent-first, the shape `workspaceBackgroundMru` keeps. */
function seedPool(rm: PrivateRM, count: number, busy: string[] = []) {
  const keys: string[] = []
  for (let i = 0; i < count; i++) {
    keys.push(seedBackground(rm, `bg${i}`, { busy: busy.includes(`bg${i}`) }))
  }
  rm.workspaceBackgroundMru = keys
  return keys
}

function captureLogs() {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  return { lines, restore: () => { console.log = original } }
}

describe('SHO-143 — the background cap is 10, and the ceiling above it leaves room', () => {
  test('defaults to 10 background runtimes and a global ceiling above preview + background', () => {
    const prev = {
      bg: process.env.WORKSPACE_BACKGROUND_MAX,
      max: process.env.RUNTIME_MAX_COUNT,
      preview: process.env.WORKSPACE_PREVIEW_MAX,
    }
    delete process.env.WORKSPACE_BACKGROUND_MAX
    delete process.env.RUNTIME_MAX_COUNT
    delete process.env.WORKSPACE_PREVIEW_MAX
    try {
      expect(resolveWorkspaceBackgroundMax()).toBe(10)
      const { rm } = newManager()
      expect(rm.workspaceBackgroundMax).toBe(10)
      // The worker's global LRU must not have to evict a kept runtime to make
      // room for another: preview + background + a workspace session, at least.
      expect(resolveRuntimeMaxCount()).toBeGreaterThanOrEqual(
        rm.workspacePreviewMax + rm.workspaceBackgroundMax + 1,
      )
      expect(resolveRuntimeMaxCount()).toBe(resolveWorkspacePreviewMax() + 10 + 3)
    } finally {
      if (prev.bg !== undefined) process.env.WORKSPACE_BACKGROUND_MAX = prev.bg
      if (prev.max !== undefined) process.env.RUNTIME_MAX_COUNT = prev.max
      if (prev.preview !== undefined) process.env.WORKSPACE_PREVIEW_MAX = prev.preview
    }
  })

  test('an explicit env override still wins on both numbers', () => {
    const prev = { bg: process.env.WORKSPACE_BACKGROUND_MAX, max: process.env.RUNTIME_MAX_COUNT }
    process.env.WORKSPACE_BACKGROUND_MAX = '4'
    process.env.RUNTIME_MAX_COUNT = '40'
    try {
      expect(resolveWorkspaceBackgroundMax()).toBe(4)
      expect(resolveRuntimeMaxCount()).toBe(40)
    } finally {
      if (prev.bg === undefined) delete process.env.WORKSPACE_BACKGROUND_MAX
      else process.env.WORKSPACE_BACKGROUND_MAX = prev.bg
      if (prev.max === undefined) delete process.env.RUNTIME_MAX_COUNT
      else process.env.RUNTIME_MAX_COUNT = prev.max
    }
  })
})

describe('SHO-143 — ten background agents evict nothing', () => {
  test('a full pool of 10 evicts no runtime, and leaves the open previews alone', async () => {
    const { rm, stopped } = newManager()
    const { lines, restore } = captureLogs()
    try {
      const previews = [seedPreview(rm, 'pv1'), seedPreview(rm, 'pv2'), seedPreview(rm, 'pv3')]
      rm.workspacePreviewMru = previews
      const pool = seedPool(rm, 10)

      await rm.enforceWorkspaceBackgroundCap()

      expect(stopped).toEqual([])
      expect(lines.filter((l) => l.includes('evicting'))).toEqual([])
      for (const key of [...pool, ...previews]) {
        expect(rm.runtimes.get(key)?.status).toBe('running')
      }
    } finally {
      restore()
    }
  })

  test('an open preview is never a candidate, even with the background pool over its cap', async () => {
    const { rm, stopped } = newManager()
    const { restore } = captureLogs()
    try {
      const previews = [seedPreview(rm, 'pv1'), seedPreview(rm, 'pv2'), seedPreview(rm, 'pv3')]
      rm.workspacePreviewMru = previews
      seedPool(rm, 12)

      await rm.enforceWorkspaceBackgroundCap()

      const victims = stopped.map((s) => s.key)
      expect(victims).toHaveLength(2)
      for (const key of previews) {
        expect(victims).not.toContain(key)
        expect(rm.runtimes.get(key)?.status).toBe('running')
      }
    } finally {
      restore()
    }
  })
})

describe('SHO-143 — over the cap, only idle runtimes are victims', () => {
  test('the two coldest idle runtimes go, and every decision is logged with its counts', async () => {
    const { rm, stopped } = newManager()
    const { lines, restore } = captureLogs()
    try {
      // MRU is most-recent-first: bg11 and bg10 are the coldest.
      const pool = seedPool(rm, 12)

      await rm.enforceWorkspaceBackgroundCap()

      expect(stopped.map((s) => s.key)).toEqual([pool[11], pool[10]])
      expect(stopped.every((s) => s.reason === 'background-lru')).toBe(true)
      expect(lines).toContain(
        `[RuntimeManager] Workspace background LRU: evicting ${pool[11]}: ` +
          `idle 10m, turns=0 tasks=0 streams=0 children=0 (cap=10)`,
      )
      // Nothing was kept, so there is no "over the cap" summary.
      expect(lines.filter((l) => l.includes('going over the cap'))).toEqual([])
    } finally {
      restore()
    }
  })

  test('a busy background runtime is never the victim — the pool sits over its cap', async () => {
    const { rm, stopped } = newManager()
    const { lines, restore } = captureLogs()
    try {
      const pool = seedPool(rm, 12, ['bg11', 'bg10'])

      await rm.enforceWorkspaceBackgroundCap()

      expect(stopped).toEqual([])
      expect(lines).toContain(
        `[RuntimeManager] Workspace background LRU: keeping ${pool[11]} over cap=10: ` +
          `work (turns=0 tasks=1 streams=0 children=0)`,
      )
      expect(lines).toContain(
        '[RuntimeManager] Workspace background LRU: 12 live over cap=10, ' +
          '2 kept busy or unverifiable — going over the cap rather than killing work',
      )
      expect(rm.runtimes.get(pool[11])?.status).toBe('running')
      expect(rm.runtimes.get(pool[10])?.status).toBe('running')
    } finally {
      restore()
    }
  })

  test('a probe that failed reads as unknown, so the runtime is kept (the Samsara case)', async () => {
    const { rm, stopped } = newManager()
    const { lines, restore } = captureLogs()
    try {
      const pool = seedPool(rm, 12)
      // The 146-evictions case: the activity probe never answered for this
      // runtime. It used to count as idle; it now counts as busy.
      probeFailed.add(pool[11])

      await rm.enforceWorkspaceBackgroundCap()

      expect(stopped.map((s) => s.key)).toEqual([pool[10]])
      expect(lines).toContain(
        `[RuntimeManager] Workspace background LRU: keeping ${pool[11]} over cap=10: ` +
          `unknown (unknown activity (last sample 0s old))`,
      )
      expect(rm.runtimes.get(pool[11])?.status).toBe('running')
    } finally {
      restore()
    }
  })

  test('a runtime whose process is gone is reaped, not counted as an eviction', async () => {
    const { rm, stopped } = newManager()
    const { lines, restore } = captureLogs()
    try {
      const pool = seedPool(rm, 12)
      // Not worker-managed and no live process handle: a stale record.
      const dead = pool[11]
      rm.agentManagedProjects.delete(dead)
      rm.runtimes.get(dead).agentProcess = fakeProcess(true)

      await rm.enforceWorkspaceBackgroundCap()

      expect(stopped).toContainEqual({ key: dead, reason: 'dead' })
      expect(lines).toContain(
        `[RuntimeManager] background LRU: reaping dead ${dead} (process gone) — not an eviction`,
      )
    } finally {
      restore()
    }
  })
})

describe('SHO-143 — low host memory queues a start instead of killing work', () => {
  /** Force the free-memory guard to report "low" for real, without a stub. */
  function withLowHostMemory<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.WORKSPACE_BACKGROUND_MIN_FREE_MB
    process.env.WORKSPACE_BACKGROUND_MIN_FREE_MB = '9999999'
    return fn().finally(() => {
      if (prev === undefined) delete process.env.WORKSPACE_BACKGROUND_MIN_FREE_MB
      else process.env.WORKSPACE_BACKGROUND_MIN_FREE_MB = prev
    })
  }

  test('frees an IDLE background runtime, and never the busy one', async () => {
    const { rm, stopped } = newManager()
    const { lines, restore } = captureLogs()
    try {
      const busy = seedBackground(rm, 'busy', { busy: true })
      const idle = seedBackground(rm, 'idle')
      rm.workspaceBackgroundMru = [busy, idle]

      const freed = await withLowHostMemory(() => rm.evictIdleBackgroundForMemory('ws:proj:new'))

      expect(freed).toBe(true)
      expect(stopped).toEqual([{ key: idle, reason: 'background-memory' }])
      expect(lines).toContain(
        `[RuntimeManager] memory guard: evicting idle ${idle}: ` +
          `idle 10m, turns=0 tasks=0 streams=0 children=0`,
      )
      expect(rm.runtimes.get(busy)?.status).toBe('running')
    } finally {
      restore()
    }
  })

  test('with nothing idle, the start is queued and the busy runtime is left working', async () => {
    const { rm, stopped } = newManager()
    const { lines, restore } = captureLogs()
    const realNow = Date.now
    try {
      const busy = seedBackground(rm, 'busy', { busy: true })
      rm.workspaceBackgroundMru = [busy]

      const starting = withLowHostMemory(() => rm.admitBackgroundStart('ws:proj:new'))
      starting.catch(() => {}) // asserted below; avoid an unhandled rejection meanwhile
      // Let it take its first memory sample and arm the 30s wait, then jump the
      // clock past the deadline so the test does not sit here for 30 seconds.
      await new Promise((resolve) => setTimeout(resolve, 50))
      Date.now = () => realNow() + 120_000

      await expect(starting).rejects.toThrow(/queued/)

      expect(stopped).toEqual([])
      expect(lines.some((l) => l.includes('waiting:') && l.includes('floor'))).toBe(true)
      expect(lines.some((l) => l.includes('queued, not started: host memory low'))).toBe(true)
      expect(rm.runtimes.get(busy)?.status).toBe('running')
    } finally {
      Date.now = realNow
      restore()
    }
  })
})
