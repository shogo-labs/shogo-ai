// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — the warm-preview cap follows the host's tier, and free memory
 * is the only thing that evicts a preview under it (SHO-606).
 *
 * The bug, from Russell's 128 GB desktop: the cap was a fixed 3, the desktop is
 * tier `high`, so every chat switch past the third evicted an idle agent
 * runtime — 547 `Workspace preview LRU: evicting` lines and 598 `fresh-spawn`s
 * in ten days, none of them memory-driven. These tests take the card's
 * acceptance criteria through the real {@link RuntimeManager} and the real
 * {@link WorkspaceKeepWarm}, stubbing only the embedded worker's two seams
 * (`status()` / `activityDecision()`) with the REAL `decideBusy` behind them:
 *
 *   - the tier table (low 1 / standard 3 / high 10, unset 3) and the
 *     `WORKSPACE_PREVIEW_MAX` override, including junk that must not disable it;
 *   - the resolver stays dependency-free, so cloud's keep-warm can import it;
 *   - the boot line Russell will read off `main.log`: `cap=10 (tier=high)`;
 *   - the desktop actually hands that tier to the API process;
 *   - a high-tier host opens a 10th preview and stops nothing; the 11th stops
 *     exactly the coldest idle one, and the log says `over cap`;
 *   - under the cap with the host low, idle previews go one at a time, oldest
 *     first, and the just-opened / on-screen / busy ones are never victims;
 *   - cloud's keep-warm keeps the same number the manager keeps alive;
 *   - the cap is still enforced at every UI open, or the memory pass never runs.
 */
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RuntimeManager,
  projectWorkspaceRuntimeKey,
  resolveRuntimeMaxCount,
  resolveWorkspaceBackgroundMax,
  resolveWorkspacePreviewMax,
} from '../lib/runtime/manager'
import {
  DEFAULT_PREVIEW_MAX,
  PREVIEW_MAX_BY_TIER,
  resolveWorkspacePreviewCap,
} from '../lib/runtime/preview-cap'
import { WorkspaceKeepWarm } from '../lib/workspace-keep-warm'
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
const MEMORY_FINE = { WORKSPACE_BACKGROUND_MIN_FREE_MB: '0' }
const MEMORY_LOW = { WORKSPACE_BACKGROUND_MIN_FREE_MB: '9999999' }

let work: Map<string, ActivityCounts>

/** Set env vars for the duration of `fn`, restoring each afterwards. */
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

/**
 * Build a manager as if it were this host. `workspacePreviewMax` is read once at
 * construction, so the env is set around the constructor only — a suite running
 * on a desktop that exports a real `SHOGO_HOST_TIER` must not leak it in.
 */
function buildManager(hostEnv: { tier?: 'low' | 'standard' | 'high'; max?: string }): PrivateRM {
  const prevTier = process.env.SHOGO_HOST_TIER
  const prevMax = process.env.WORKSPACE_PREVIEW_MAX
  if (hostEnv.tier === undefined) delete process.env.SHOGO_HOST_TIER
  else process.env.SHOGO_HOST_TIER = hostEnv.tier
  if (hostEnv.max === undefined) delete process.env.WORKSPACE_PREVIEW_MAX
  else process.env.WORKSPACE_PREVIEW_MAX = hostEnv.max
  try {
    return new RuntimeManager({ healthCheckInterval: 50 }) as PrivateRM
  } finally {
    if (prevTier === undefined) delete process.env.SHOGO_HOST_TIER
    else process.env.SHOGO_HOST_TIER = prevTier
    if (prevMax === undefined) delete process.env.WORKSPACE_PREVIEW_MAX
    else process.env.WORKSPACE_PREVIEW_MAX = prevMax
  }
}

/** A manager with the worker stubbed at the two seams the preview LRU reads. */
function newManager(hostEnv: { tier?: 'low' | 'standard' | 'high'; max?: string } = {}): PrivateRM {
  const rm = buildManager(hostEnv)
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
        startedAt: rm.runtimes.get(key)?.startedAt ?? startedAt,
        status: 'running',
        sample: { counts: work.get(key) ?? IDLE, at: Date.now(), ok: true },
        terminalSessions: opts?.terminalSessions,
        inflightCalls: opts?.inflightCalls,
      }),
  }
  return rm
}

let nextPort = 39600

/** A settled (past the startup grace) live preview runtime. */
function seedPreview(rm: PrivateRM, name: string, opts: { busy?: boolean } = {}): string {
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
    agentProcess: { killed: false, exitCode: null, kill: mock(() => true), on: mock(() => undefined) },
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
  return { lines, restore: () => void (console.log = original) }
}

describe('SHO-606 AC1 — the cap comes from the host, in one dependency-free place', () => {
  test('low 1 / standard 3 / high 10, and 3 when no tier is set', () => {
    expect(PREVIEW_MAX_BY_TIER).toEqual({ low: 1, standard: 3, high: 10 })
    expect(DEFAULT_PREVIEW_MAX).toBe(3)
    expect(resolveWorkspacePreviewCap({}).max).toBe(3)
    expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: 'low' }).max).toBe(1)
    expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: 'standard' }).max).toBe(3)
    expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: 'high' }).max).toBe(10)
    // Cloud, metal and docker set no tier: unchanged.
    expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: undefined }).max).toBe(3)
  })

  test('WORKSPACE_PREVIEW_MAX wins for every tier; junk falls back instead of disabling the cap', () => {
    for (const tier of ['low', 'standard', 'high'] as const) {
      expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: tier, WORKSPACE_PREVIEW_MAX: '5' }).max).toBe(5)
      expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: tier, WORKSPACE_PREVIEW_MAX: '0' }).max).toBe(
        PREVIEW_MAX_BY_TIER[tier],
      )
      expect(
        resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: tier, WORKSPACE_PREVIEW_MAX: 'not-a-number' }).max,
      ).toBe(PREVIEW_MAX_BY_TIER[tier])
      expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: tier, WORKSPACE_PREVIEW_MAX: '-4' }).max).toBe(
        PREVIEW_MAX_BY_TIER[tier],
      )
    }
    expect(
      resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: 'ultra', WORKSPACE_PREVIEW_MAX: undefined }).max,
    ).toBe(3)
  })

  test('the resolver names where its number came from, for the boot line', () => {
    expect(resolveWorkspacePreviewCap({})).toEqual({ max: 3, source: 'default' })
    expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: 'high' })).toEqual({
      max: 10,
      source: 'tier',
      tier: 'high',
    })
    expect(resolveWorkspacePreviewCap({ SHOGO_HOST_TIER: 'high', WORKSPACE_PREVIEW_MAX: '6' })).toEqual({
      max: 6,
      source: 'env',
    })
  })

  test('preview-cap.ts imports nothing — cloud keep-warm loads it without the runtime manager', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'lib', 'runtime', 'preview-cap.ts'), 'utf8')
    expect(source).not.toMatch(/^import\s/m)
  })

  test('the manager logs cap=<n> (<source>) once, so main.log answers "why 3?"', () => {
    for (const [env, expected] of [
      [{}, '[RuntimeManager] warm-preview cap=3 (default)'],
      [{ tier: 'high' as const }, '[RuntimeManager] warm-preview cap=10 (tier=high)'],
      [{ tier: 'low' as const }, '[RuntimeManager] warm-preview cap=1 (tier=low)'],
      [{ tier: 'high' as const, max: '6' }, '[RuntimeManager] warm-preview cap=6 (env)'],
    ] as const) {
      const { lines, restore } = captureLogs()
      try {
        buildManager(env)
      } finally {
        restore()
      }
      expect(lines.filter((l) => l.includes('warm-preview cap'))).toEqual([expected])
    }
  })

  test('the desktop hands its tier to this API process', () => {
    // Without this hop the whole card is a no-op on the desktop: the resolver
    // would see no tier, keep 3, and Russell would still get the cold starts.
    const source = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'desktop', 'src', 'local-server.ts'),
      'utf8',
    )
    expect(source).toContain('resolveHostTier(')
    expect(source).toContain('SHOGO_HOST_TIER: hostTier')
  })

  test('the worker ceiling still has room for a high-tier cap', () => {
    const prevTier = process.env.SHOGO_HOST_TIER
    process.env.SHOGO_HOST_TIER = 'high'
    try {
      expect(resolveWorkspacePreviewMax()).toBe(10)
      expect(resolveRuntimeMaxCount()).toBeGreaterThanOrEqual(
        resolveWorkspacePreviewMax() + resolveWorkspaceBackgroundMax(),
      )
    } finally {
      if (prevTier === undefined) delete process.env.SHOGO_HOST_TIER
      else process.env.SHOGO_HOST_TIER = prevTier
    }
  })
})

describe('SHO-606 AC2 — a big host stops churning between the ~8 agent chats', () => {
  test('a 10th open under a high-tier cap stops nothing; an 11th stops only the coldest idle', async () => {
    const rm = newManager({ tier: 'high' })
    expect(rm.workspacePreviewMax).toBe(10)
    const previews: string[] = []
    for (let i = 0; i < 10; i++) previews.push(seedPreview(rm, `p${i}`))
    rm.workspacePreviewMru = previews
    const stopped = stubStop(rm)
    const { lines, restore } = captureLogs()
    let eleventh: string
    try {
      await withEnv(MEMORY_FINE, () => rm.enforceWorkspacePreviewCap())
      expect(stopped).toEqual([])
      expect(lines.filter((l) => l.includes('evicting'))).toEqual([])

      eleventh = seedPreview(rm, 'p11')
      rm.workspacePreviewMru = [eleventh, ...previews]
      await withEnv(MEMORY_FINE, () => rm.enforceWorkspacePreviewCap())
    } finally {
      restore()
    }

    expect(stopped).toEqual([previews[9]])
    const evictions = lines.filter((l) => l.includes('evicting'))
    expect(evictions).toHaveLength(1)
    expect(evictions[0]).toContain('over cap')
    expect(evictions[0]).toContain('(cap=10)')
    expect(rm.runtimes.get(eleventh)?.status).toBe('running')
  })
})

describe('SHO-606 AC3 — under the cap, free memory is the bound', () => {
  test('memory low: idle previews go oldest-first; head, on-screen and busy stay', async () => {
    const rm = newManager({ tier: 'high' })
    const head = seedPreview(rm, 'head')
    const onScreen = seedPreview(rm, 'onscreen')
    const busy = seedPreview(rm, 'busy', { busy: true })
    const idleNewer = seedPreview(rm, 'idle-newer')
    const idleOldest = seedPreview(rm, 'idle-oldest')
    rm.workspacePreviewMru = [head, onScreen, busy, idleNewer, idleOldest]
    rm.previewViewedAt.set(onScreen, Date.now())
    const stopped = stubStop(rm)
    const { lines, restore } = captureLogs()
    try {
      await withEnv(MEMORY_LOW, () => rm.enforceWorkspacePreviewCap())
    } finally {
      restore()
    }

    expect(stopped).toEqual([idleOldest, idleNewer])
    const evictions = lines.filter((l) => l.includes('evicting'))
    expect(evictions).toHaveLength(2)
    for (const line of evictions) {
      expect(line).toContain('host memory low')
      expect(line).not.toContain('over cap')
    }
    expect(rm.runtimes.has(head)).toBe(true)
    expect(rm.runtimes.has(onScreen)).toBe(true)
    expect(rm.runtimes.has(busy)).toBe(true)
    expect(lines.some((l) => l.includes('keeping 3 previews'))).toBe(true)
  })

  test('memory fine: the same five previews stop nothing, even under the cap', async () => {
    const rm = newManager({ tier: 'high' })
    const keys = ['a', 'b', 'c', 'd', 'e'].map((n) => seedPreview(rm, n))
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
  })

  test('the cap is still enforced at every UI open — otherwise the memory pass never runs', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'lib', 'runtime', 'manager.ts'), 'utf8')
    const callSites = source.match(/this\.enforceWorkspacePreviewCap\(\)/g) ?? []
    expect(callSites.length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('evictPreviewsForHostMemory(cap)')
  })
})

describe('SHO-606 AC4 — cloud keep-warm keeps the same number the manager keeps alive', () => {
  /** Record five opens and report how many of them the controller keeps. */
  function kept(opts: { max?: number } = {}): number {
    const kw = new WorkspaceKeepWarm({ ...opts, now: () => 0 })
    for (const k of ['a', 'b', 'c', 'd', 'e']) kw.recordOpened(k, `http://${k}`)
    return kw.topN().length
  }

  test('WORKSPACE_PREVIEW_MAX=4 keeps 4 even on a high-tier host', async () => {
    await withEnv({ WORKSPACE_PREVIEW_MAX: '4', SHOGO_HOST_TIER: 'high' }, () => {
      expect(kept()).toBe(4)
    })
  })

  test('no env and no tier keeps 3 — k8s is unchanged', async () => {
    await withEnv({ WORKSPACE_PREVIEW_MAX: undefined, SHOGO_HOST_TIER: undefined }, () => {
      expect(kept()).toBe(3)
    })
  })

  test('it follows the tier the same way the manager does', async () => {
    await withEnv({ WORKSPACE_PREVIEW_MAX: undefined, SHOGO_HOST_TIER: 'low' }, () => {
      expect(kept()).toBe(1)
    })
  })

  test('an explicit max still wins for tests and callers', async () => {
    await withEnv({ WORKSPACE_PREVIEW_MAX: '4' }, () => {
      expect(kept({ max: 2 })).toBe(2)
    })
  })
})
