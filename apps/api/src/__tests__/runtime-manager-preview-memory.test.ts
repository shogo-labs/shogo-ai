// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-606 — free host memory, not a fixed number, is what bounds the warm
 * previews.
 *
 * The cap moved to a per-tier policy number (10 on a `high` desktop), and the
 * only thing that should still stop a preview under it is the host actually
 * running out of room. This pins that second pass:

 *   - with memory fine, five previews under the cap clear nothing;
 *   - with the host low, the idle previews go one at a time, oldest first, each
 *     logged with the free/floor numbers that caused it;
 *   - the preview just opened (MRU head), the one on screen and the one with work
 *     in flight are never the victim, and the pass says so;
 *   - the guard is the same one the background pool uses
 *     (`WORKSPACE_BACKGROUND_MIN_FREE_MB`, 0 = disabled), not a second floor.
 *
 * The worker is stubbed at the two seams the LRU reads (`status()` and
 * `activityDecision()`), with the REAL `decideBusy` behind the verdict, so
 * "unknown is busy" and the startup grace behave as they do in production.
 */
import { describe, expect, mock, test } from 'bun:test'
import { RuntimeManager, projectWorkspaceRuntimeKey } from '../lib/runtime/manager'
import { decideBusy, type ActivityCounts } from '@shogo-ai/worker/runtime-activity'

type PrivateRM = RuntimeManager & {
  runtimes: Map<string, any>
  usedPorts: Set<number>
  agentManager: any
  agentManagedProjects: Set<string>
  workspacePreviewMru: string[]
  previewViewedAt: Map<string, number>
  workspacePreviewMax: number
  enforceWorkspacePreviewCap: () => Promise<void>
}

const IDLE: ActivityCounts = { turns: 0, tasks: 0, streams: 0, children: 0 }
const BUSY: ActivityCounts = { turns: 0, tasks: 1, streams: 0, children: 0 }

let work: Map<string, ActivityCounts>

function fakeProcess() {
  return {
    killed: false,
    exitCode: null as number | null,
    kill: mock(() => true),
    on: mock(() => undefined),
  }
}

/** Set env vars for the duration of `fn` (async-safe), restoring each after. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = new Map<string, string | undefined>()
  for (const key of Object.keys(vars)) prev.set(key, process.env[key])
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A `high`-tier manager (cap 10): the 128 GB desktop from the card. */
function newHighTierManager(): PrivateRM {
  const prevTier = process.env.SHOGO_HOST_TIER
  const prevMax = process.env.WORKSPACE_PREVIEW_MAX
  delete process.env.WORKSPACE_PREVIEW_MAX
  process.env.SHOGO_HOST_TIER = 'high'
  let rm: PrivateRM
  try {
    rm = new RuntimeManager({ healthCheckInterval: 50 }) as PrivateRM
  } finally {
    if (prevTier === undefined) delete process.env.SHOGO_HOST_TIER
    else process.env.SHOGO_HOST_TIER = prevTier
    if (prevMax !== undefined) process.env.WORKSPACE_PREVIEW_MAX = prevMax
  }
  work = new Map()
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
        // The runtime's own age, so a freshly spawned one really is in its
        // startup grace and a settled one is past it.
        startedAt: rm.runtimes.get(key)?.startedAt ?? startedAt,
        status: 'running',
        sample: { counts: work.get(key) ?? IDLE, at: Date.now(), ok: true },
        terminalSessions: opts?.terminalSessions,
        inflightCalls: opts?.inflightCalls,
      }),
  }
  return rm
}

let nextPort = 38600

function seedPreview(rm: PrivateRM, name: string, opts: { busy?: boolean } = {}) {
  const key = projectWorkspaceRuntimeKey(name)
  const port = nextPort++
  rm.runtimes.set(key, {
    id: key,
    port,
    agentPort: port + 1000,
    status: 'running',
    url: `http://localhost:${port}`,
    // Settled: past the startup grace, so it is a legal victim.
    startedAt: Date.now() - 10 * 60_000,
    process: null,
    agentProcess: fakeProcess(),
  })
  rm.agentManagedProjects.add(key)
  rm.usedPorts.add(port)
  if (opts.busy) work.set(key, BUSY)
  return key
}

function stubStop(rm: PrivateRM): string[] {
  const stopped: string[] = []
  ;(rm as any).stop = mock(async (key: string) => {
    stopped.push(key)
    rm.runtimes.delete(key)
  })
  return stopped
}

function captureLogs() {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  return {
    lines,
    restore: () => {
      console.log = original
    },
  }
}

/** The guard the background pool uses: 0 disables it, a huge floor forces it low. */
const MEMORY_FINE = { WORKSPACE_BACKGROUND_MIN_FREE_MB: '0' }
const MEMORY_LOW = { WORKSPACE_BACKGROUND_MIN_FREE_MB: '9999999' }

describe('SHO-606 — a 10-preview cap means no churn on a big host', () => {
  test('nine warm previews plus a tenth open stop nothing; the eleventh evicts the oldest', async () => {
    const rm = newHighTierManager()
    const previews: string[] = []
    for (let i = 0; i < 10; i++) previews.push(seedPreview(rm, `p${i}`))
    rm.workspacePreviewMru = previews
    const stopped = stubStop(rm)
    const { lines, restore } = captureLogs()
    try {
      // The 10th chat opened: at the cap, so nothing gives way.
      await withEnv(MEMORY_FINE, () => rm.enforceWorkspacePreviewCap())
      expect(stopped).toEqual([])
      expect(lines.filter((l) => l.includes('evicting'))).toEqual([])

      // An 11th: exactly the coldest idle one goes, and says why.
      const eleventh = seedPreview(rm, 'p11')
      rm.workspacePreviewMru = [eleventh, ...previews]
      await withEnv(MEMORY_FINE, () => rm.enforceWorkspacePreviewCap())

      expect(stopped).toEqual([previews[9]])
      const evictions = lines.filter((l) => l.includes('evicting'))
      expect(evictions).toHaveLength(1)
      expect(evictions[0]).toContain(previews[9])
      expect(evictions[0]).toContain('over cap')
      expect(evictions[0]).toContain('(cap=10)')
      expect(rm.runtimes.get(eleventh)?.status).toBe('running')
    } finally {
      restore()
    }
  })
})

describe('SHO-606 — five previews under a 10-preview cap', () => {
  test('with memory fine, nothing is stopped and nothing is logged as evicted', async () => {
    const rm = newHighTierManager()
    expect(rm.workspacePreviewMax).toBe(10)
    const keys = [
      seedPreview(rm, 'p1'),
      seedPreview(rm, 'p2'),
      seedPreview(rm, 'p3'),
      seedPreview(rm, 'p4'),
      seedPreview(rm, 'p5'),
    ]
    rm.workspacePreviewMru = keys
    const stopped = stubStop(rm)
    const { lines, restore } = captureLogs()
    try {
      await withEnv(MEMORY_FINE, () => rm.enforceWorkspacePreviewCap())
    } finally {
      restore()
    }

    expect(stopped).toEqual([])
    expect(lines.filter((l) => l.includes('evicting'))).toEqual([])
    for (const key of keys) expect(rm.runtimes.get(key)?.status).toBe('running')
  })

  test('with the host low, the idle previews go oldest-first and the rest stay', async () => {
    const rm = newHighTierManager()
    const head = seedPreview(rm, 'head')
    const onScreen = seedPreview(rm, 'onscreen')
    const busy = seedPreview(rm, 'busy', { busy: true })
    const idleNewer = seedPreview(rm, 'idle-newer')
    const idleOldest = seedPreview(rm, 'idle-oldest')
    // Most-recent-first, the shape `workspacePreviewMru` keeps.
    rm.workspacePreviewMru = [head, onScreen, busy, idleNewer, idleOldest]
    // The user is looking at one of them (the SHO-226 pin) without it being the
    // one just opened.
    rm.previewViewedAt.set(onScreen, Date.now())
    const stopped = stubStop(rm)
    const { lines, restore } = captureLogs()
    try {
      await withEnv(MEMORY_LOW, () => rm.enforceWorkspacePreviewCap())
    } finally {
      restore()
    }

    // Oldest first, one at a time — and only the idle ones.
    expect(stopped).toEqual([idleOldest, idleNewer])
    const evictions = lines.filter((l) => l.includes('evicting'))
    expect(evictions).toHaveLength(2)
    expect(evictions[0]).toContain(idleOldest)
    expect(evictions[1]).toContain(idleNewer)
    for (const line of evictions) {
      expect(line).toContain('host memory low')
      expect(line).toContain('floor')
      // Not the over-cap wording: these went for memory, not for the cap.
      expect(line).not.toContain('over cap')
    }

    // The preview just opened, the one on screen and the one working are kept.
    expect(rm.runtimes.has(head)).toBe(true)
    expect(rm.runtimes.has(onScreen)).toBe(true)
    expect(rm.runtimes.has(busy)).toBe(true)
    // Still low with nothing else to give: say so, with the count kept.
    expect(
      lines.some((l) => l.includes('keeping 3 previews') && l.includes('busy, on screen or just opened')),
    ).toBe(true)
  })

  test('a preview inside its startup grace is not sacrificed for memory', async () => {
    const rm = newHighTierManager()
    const head = seedPreview(rm, 'head')
    const fresh = seedPreview(rm, 'fresh')
    // Just spawned: `decideBusy` keeps it through the grace window.
    rm.runtimes.get(fresh)!.startedAt = Date.now()
    rm.workspacePreviewMru = [head, fresh]
    const stopped = stubStop(rm)
    const { restore } = captureLogs()
    try {
      await withEnv(MEMORY_LOW, () => rm.enforceWorkspacePreviewCap())
    } finally {
      restore()
    }

    expect(stopped).toEqual([])
    expect(rm.runtimes.has(fresh)).toBe(true)
  })
})
