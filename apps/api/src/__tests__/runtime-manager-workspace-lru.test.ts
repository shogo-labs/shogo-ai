// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  RuntimeManager,
  projectWorkspaceRuntimeKey,
  resolveRuntimeMaxCount,
  resolveWorkspaceBackgroundMax,
  resolveWorkspacePreviewMax,
  workspaceRuntimeKey,
} from '../lib/runtime/manager'
import { countTerminalSession } from '../lib/terminal-session-pin'
import { decideBusy } from '@shogo-ai/worker/runtime-activity'

function fakeProcess() {
  const proc = {
    killed: false,
    exitCode: null as number | null,
    kill: mock((_signal?: string) => {
      proc.killed = true
      return true
    }),
    on: mock((event: string, cb: () => void) => {
      if (event === 'exit') queueMicrotask(cb)
      return proc
    }),
  }
  return proc
}

type PrivateRM = RuntimeManager & {
  runtimes: Map<string, any>
  usedPorts: Set<number>
  agentManager: any
  agentManagedProjects: Set<string>
  workspacePreviewMru: string[]
  workspaceBackgroundMru: string[]
  previewViewedAt: Map<string, number>
  resolveRuntimeKey: (projectId: string) => string
  recordWorkspaceMru: (key: string) => void
  enforceWorkspacePreviewCap: () => Promise<void>
  workspacePreviewMax: number
}

const COUNTS = { turns: 0, tasks: 0, streams: 0, children: 0 }

/** Keys the stubbed worker reports as mid-turn for the manager under test. */
const busyKeys = new Set<string>()

function markBusy(key: string) {
  busyKeys.add(key)
}

/**
 * A manager whose embedded worker is stubbed at exactly the two seams the LRU
 * uses: `status(key)` (liveness of the cached port) and `activityDecision`
 * (the cached busy verdict, SHO-143). The verdict comes from the REAL
 * `decideBusy`, so terminal pins, in-flight calls and unknown-is-busy behave as
 * they do in production.
 */
function newManager(): PrivateRM {
  const rm = new RuntimeManager({ healthCheckInterval: 50 }) as PrivateRM
  busyKeys.clear()
  const startedAt = Date.now() - 10 * 60_000
  rm.agentManager = {
    touch: mock(() => {}),
    stop: mock(async () => {}),
    // The LRU re-reads a stale sample before deciding; a stub that answers
    // instantly keeps the test on the eviction logic itself.
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
        sample: { counts: busyKeys.has(key) ? { ...COUNTS, turns: 1 } : COUNTS, at: Date.now(), ok: true },
        terminalSessions: opts?.terminalSessions,
        inflightCalls: opts?.inflightCalls,
      }),
  }
  // The warm-reuse branch refreshes the merged root on every wake, which for a
  // non-remote project shells out to `bun install` for its members. That is a
  // filesystem/install side effect no assertion here reads, and on a cold runner
  // it outlives bun's 5s per-test timeout — stub it so a test measures the LRU,
  // not an install.
  ;(rm as any).buildWorkspaceMergedRoot = mock(async (_workspacesDir: string, rootName: string) => ({
    dir: join(_workspacesDir, '.workspace-roots', rootName),
    linkedFolders: [],
    readonlyFolders: [],
    mounts: [],
  }))
  return rm
}

/**
 * A manager built as if it were running on a `low`-tier host (≤8 GB RAM /
 * ≤4 cores — the normal Windows laptop from SHO-107), where the warm-preview
 * cap is 1. `workspacePreviewMax` is read once at construction, so the env has
 * to be set around the constructor and restored afterwards.
 */
function newLowTierManager(): PrivateRM {
  const prevTier = process.env.SHOGO_HOST_TIER
  const prevMax = process.env.WORKSPACE_PREVIEW_MAX
  delete process.env.WORKSPACE_PREVIEW_MAX
  process.env.SHOGO_HOST_TIER = 'low'
  try {
    return newManager()
  } finally {
    if (prevTier === undefined) delete process.env.SHOGO_HOST_TIER
    else process.env.SHOGO_HOST_TIER = prevTier
    if (prevMax !== undefined) process.env.WORKSPACE_PREVIEW_MAX = prevMax
  }
}

function seedAnchored(rm: PrivateRM, projectId: string, port: number) {
  const key = projectWorkspaceRuntimeKey(projectId)
  rm.runtimes.set(key, {
    id: key,
    port,
    agentPort: port + 1000,
    status: 'running',
    url: `http://localhost:${port}`,
    // Settled, not freshly spawned: a runtime inside its startup grace is never
    // an eviction victim (SHO-143).
    startedAt: Date.now() - 10 * 60_000,
    process: null,
    agentProcess: fakeProcess(),
  })
  // The embedded worker owns these runtimes in production, and with them the
  // activity verdict the LRU reads.
  rm.agentManagedProjects.add(key)
  rm.usedPorts.add(port)
  return key
}

describe('RuntimeManager — workspace ws:proj: keying', () => {
  test('stop(projectId) resolves and tears down the anchored ws:proj key', async () => {
    const rm = newManager()
    const key = seedAnchored(rm, 'p1', 37200)

    await rm.stop('p1') // bare project id — must resolve to ws:proj:p1

    expect(rm.runtimes.has(key)).toBe(false)
    expect(rm.usedPorts.has(37200)).toBe(false)
  })

  test('touch(projectId) resets the worker idle slot but does NOT record a preview', () => {
    const rm = newManager()
    const key = seedAnchored(rm, 'p1', 37201)

    rm.touch('p1')

    expect(rm.agentManager.touch).toHaveBeenCalledWith(key)
    // SHO-226: `touch` fires on every AI-proxy call and SSE chunk, so an agent
    // mid-turn used to sit at the head of the MRU forever and fill the three
    // warm-preview slots with agent runtimes. Recency comes from UI signals only.
    expect(rm.workspacePreviewMru).not.toContain(key)
  })

  test('resolveRuntimeKey always uses the anchored key', () => {
    const rm = newManager()
    expect(rm.resolveRuntimeKey('nope')).toBe('ws:proj:nope')
  })
})

describe('RuntimeManager — warm-3 preview LRU', () => {
  test('enforceWorkspacePreviewCap stops the least-recently-used beyond the cap of 3', async () => {
    const rm = newManager()
    const k1 = seedAnchored(rm, 'p1', 37210)
    const k2 = seedAnchored(rm, 'p2', 37211)
    const k3 = seedAnchored(rm, 'p3', 37212)
    const k4 = seedAnchored(rm, 'p4', 37213)
    // p1 most-recent … p4 oldest.
    rm.workspacePreviewMru = [k1, k2, k3, k4]

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([k4])
  })

  test('touch does not reorder the MRU, so the true LRU is still the victim', async () => {
    const rm = newManager()
    const k1 = seedAnchored(rm, 'p1', 37220)
    const k2 = seedAnchored(rm, 'p2', 37221)
    const k3 = seedAnchored(rm, 'p3', 37222)
    const k4 = seedAnchored(rm, 'p4', 37223)
    rm.workspacePreviewMru = [k1, k2, k3, k4]

    // An agent mid-turn proxies through `touch` continuously. It must not be
    // able to pull the tail entry forward (SHO-226).
    rm.touch('p4')
    rm.touch('p3')

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([k4])
    expect(rm.workspacePreviewMru).toEqual([k1, k2, k3, k4])
  })

  test('touch on a background key neither promotes nor records it', async () => {
    const rm = newManager()
    const bg = seedAnchored(rm, 'p1', 37224)
    rm.runtimes.get(bg)!.background = true

    rm.touch('p1')

    expect(rm.agentManager.touch).toHaveBeenCalledWith(bg)
    expect(rm.workspacePreviewMru).not.toContain(bg)
    expect(rm.runtimes.get(bg)!.background).toBe(true)
  })

  test('no eviction when at or under the cap', async () => {
    const rm = newManager()
    const k1 = seedAnchored(rm, 'p1', 37230)
    const k2 = seedAnchored(rm, 'p2', 37231)
    const k3 = seedAnchored(rm, 'p3', 37232)
    rm.workspacePreviewMru = [k1, k2, k3]

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
    })

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([])
  })
})

/**
 * SHO-226. Desktop previews "sometimes didn't load": team-chat / board /
 * `project_call` wakes resolved the callee through `resolveProjectPodUrl`
 * without `background: true`, so every agent that woke up became a foreground
 * warm preview; `touch()` then kept them at the head of the MRU on every
 * AI-proxy call. The three warm-preview slots filled with agent runtimes and
 * the preview the user was looking at was the one evicted.
 */
describe('RuntimeManager — agent work never takes a warm-preview slot', () => {
  /**
   * Stand in for `doStartMergedRuntime`: publish a live record for the key so
   * `startProjectWorkspace` runs its real post-start bookkeeping (the
   * background tagging and the MRU/background-pool recording under test).
   */
  function stubSpawn(rm: PrivateRM) {
    let nextPort = 38000
    ;(rm as any).getProjectInfo = mock(async () => ({}))
    ;(rm as any).doStartMergedRuntime = mock(async (spec: any) => {
      const port = nextPort++
      const runtime = {
        id: spec.key,
        port,
        agentPort: port + 1000,
        status: 'running',
        url: `http://localhost:${port}`,
        startedAt: Date.now() - 10 * 60_000,
        process: null,
        agentProcess: fakeProcess(),
      }
      rm.runtimes.set(spec.key, runtime)
      rm.agentManagedProjects.add(spec.key)
      rm.usedPorts.add(port)
      return runtime
    })
  }

  test('4 busy agent wakes stay in the background pool and evict none of 3 open previews', async () => {
    const rm = newManager()
    stubSpawn(rm)
    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    // Three project previews opened in the UI (`/sandbox/url`).
    const previews: string[] = []
    for (const id of ['p1', 'p2', 'p3']) {
      await rm.startProjectWorkspace(id, { workspaceId: 'w1' })
      rm.markPreviewActive(id)
      previews.push(projectWorkspaceRuntimeKey(id))
    }

    // Four agents woken by a team-chat / board / project_call wake.
    const agents: string[] = []
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      await rm.startProjectWorkspace(id, { workspaceId: 'w1', background: true })
      agents.push(projectWorkspaceRuntimeKey(id))
    }
    // ...all of them mid-turn, which is what kept them at the MRU head before.
    for (const key of agents) markBusy(key)
    for (const id of ['a1', 'a2', 'a3', 'a4']) rm.touch(id)

    await rm.enforceWorkspacePreviewCap()
    await rm.enforceWorkspaceBackgroundCap()

    // Not one preview was stopped, and the agent runtimes are not previews.
    expect(stopped).toEqual([])
    // The preview MRU holds exactly the three UI opens (most-recent first), and
    // no agent runtime ever got in.
    expect([...rm.workspacePreviewMru].sort()).toEqual([...previews].sort())
    for (const key of agents) {
      expect(rm.workspacePreviewMru).not.toContain(key)
      expect(rm.workspaceBackgroundMru).toContain(key)
      expect(rm.runtimes.get(key)!.background).toBe(true)
    }
    for (const key of previews) expect(rm.runtimes.get(key)!.background).toBe(false)
  })

  test('an agent wake for a project already open as a preview leaves it foreground', async () => {
    const rm = newManager()
    stubSpawn(rm)

    await rm.startProjectWorkspace('p1', { workspaceId: 'w1' })
    rm.markPreviewActive('p1')
    const key = projectWorkspaceRuntimeKey('p1')
    expect(rm.runtimes.get(key)!.background).toBe(false)

    // The agent wakes the same project while the user has it open.
    await rm.startProjectWorkspace('p1', { workspaceId: 'w1', background: true })

    expect(rm.runtimes.get(key)!.background).toBe(false)
    expect(rm.workspacePreviewMru).toContain(key)
    expect(rm.workspaceBackgroundMru).not.toContain(key)
  })

  test('markPreviewActive promotes a background (agent) runtime into the preview set', async () => {
    const rm = newManager()
    stubSpawn(rm)

    await rm.startProjectWorkspace('a1', { workspaceId: 'w1', background: true })
    const key = projectWorkspaceRuntimeKey('a1')
    expect(rm.runtimes.get(key)!.background).toBe(true)
    expect(rm.workspaceBackgroundMru).toContain(key)

    // The user opens that project — today's behaviour, and the escape hatch
    // for "the agent was already running it".
    rm.markPreviewActive('a1')

    expect(rm.runtimes.get(key)!.background).toBe(false)
    expect(rm.workspacePreviewMru).toContain(key)
    expect(rm.workspaceBackgroundMru).not.toContain(key)
  })
})

/**
 * SHO-226, second half: MRU position is a poor proxy for "on screen" (an agent
 * mid-turn used to own the head), so the UI pings `preview/active` and that pin
 * is what protects the preview being viewed.
 */
describe('RuntimeManager — the preview on screen is pinned', () => {
  test('a pinged preview is never the LRU victim, even at the tail', async () => {
    const rm = newManager()
    const viewed = seedAnchored(rm, 'p1', 38100)
    const other2 = seedAnchored(rm, 'p2', 38101)
    const other3 = seedAnchored(rm, 'p3', 38102)
    const other4 = seedAnchored(rm, 'p4', 38103)

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    rm.markPreviewActive('p1')
    // Three later UI opens push the viewed preview back to the tail of the MRU —
    // exactly the position the cap would evict.
    rm.workspacePreviewMru = [other2, other3, other4, viewed]

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([])
    expect(rm.runtimes.has(viewed)).toBe(true)
  })

  test('markPreviewActive resets the worker idle slot (no idle-eviction for a viewed preview)', () => {
    const rm = newManager()
    const key = seedAnchored(rm, 'p1', 38110)

    rm.markPreviewActive('p1')

    expect(rm.agentManager.touch).toHaveBeenCalledWith(key)
  })

  test('once the view TTL lapses with no ping, the preview is evictable again', async () => {
    const prevTtl = process.env.PREVIEW_VIEW_TTL_MS
    // A manager built with a 1ms view window: the pin has already lapsed by
    // the time the cap runs.
    process.env.PREVIEW_VIEW_TTL_MS = '1'
    let rm: PrivateRM
    try {
      rm = newManager()
    } finally {
      if (prevTtl === undefined) delete process.env.PREVIEW_VIEW_TTL_MS
      else process.env.PREVIEW_VIEW_TTL_MS = prevTtl
    }
    const newest = seedAnchored(rm, 'p1', 38120)
    const other2 = seedAnchored(rm, 'p2', 38121)
    const other3 = seedAnchored(rm, 'p3', 38122)
    const lapsed = seedAnchored(rm, 'p4', 38123)

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    rm.markPreviewActive('p4')
    rm.workspacePreviewMru = [newest, other2, other3, lapsed]
    await new Promise((resolve) => setTimeout(resolve, 10))

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([lapsed])
  })

  test('stopping a runtime forgets its view pin', async () => {
    const rm = newManager()
    const key = seedAnchored(rm, 'p1', 38130)
    rm.markPreviewActive('p1')
    expect((rm as any).previewViewedAt.has(key)).toBe(true)

    await rm.stop(key, 'test')

    expect((rm as any).previewViewedAt.has(key)).toBe(false)
  })
})

/**
 * Moving agent runtimes into the background pool is only safe if the worker's
 * global ceiling can hold preview + background at once — otherwise the global
 * LRU starts taking open previews (SHO-143).
 */
describe('RuntimeManager — the worker ceiling holds both pools', () => {
  test('resolveRuntimeMaxCount leaves room for preview + background + headroom', () => {
    const prevTier = process.env.SHOGO_HOST_TIER
    const prevPreview = process.env.WORKSPACE_PREVIEW_MAX
    const prevBackground = process.env.WORKSPACE_BACKGROUND_MAX
    const prevMax = process.env.RUNTIME_MAX_COUNT
    delete process.env.SHOGO_HOST_TIER
    delete process.env.WORKSPACE_PREVIEW_MAX
    delete process.env.WORKSPACE_BACKGROUND_MAX
    delete process.env.RUNTIME_MAX_COUNT
    try {
      const preview = resolveWorkspacePreviewMax()
      const background = resolveWorkspaceBackgroundMax()
      expect(background).toBe(10)
      // 4 busy agents + 3 previews is 7 live runtimes; the ceiling must be
      // above that so the worker's global LRU never targets a preview.
      expect(resolveRuntimeMaxCount()).toBeGreaterThanOrEqual(preview + background)
      expect(resolveRuntimeMaxCount()).toBeGreaterThanOrEqual(7)
    } finally {
      if (prevTier !== undefined) process.env.SHOGO_HOST_TIER = prevTier
      if (prevPreview !== undefined) process.env.WORKSPACE_PREVIEW_MAX = prevPreview
      if (prevBackground !== undefined) process.env.WORKSPACE_BACKGROUND_MAX = prevBackground
      if (prevMax !== undefined) process.env.RUNTIME_MAX_COUNT = prevMax
    }
  })
})

/**
 * SHO-43: a workspace-session runtime (`ws:<id>`, one per open workspace) is a
 * foreground open exactly like a project preview, so it shares the same MRU and
 * cap. Before this, only `ws:proj:` keys were recorded, so opening five
 * workspaces piled up five runtime processes with nothing bounding them.
 */
describe('RuntimeManager — workspace-session runtimes share the warm cap', () => {
  function seedWorkspaceRuntime(rm: PrivateRM, workspaceId: string, port: number) {
    const key = workspaceRuntimeKey(workspaceId)
    rm.runtimes.set(key, {
      id: key,
      port,
      agentPort: port + 1000,
      status: 'running',
      url: `http://localhost:${port}`,
      startedAt: Date.now() - 10 * 60_000,
      process: null,
      agentProcess: fakeProcess(),
    })
    rm.agentManagedProjects.add(key)
    rm.usedPorts.add(port)
    return key
  }

  test('recordWorkspaceMru records a ws:<id> key, not just ws:proj:', () => {
    const rm = newManager()
    const key = seedWorkspaceRuntime(rm, 'w1', 37300)

    rm.recordWorkspaceMru(key)

    expect(rm.workspacePreviewMru[0]).toBe(key)
  })

  test('a background runtime is never recorded, whatever its key shape', () => {
    const rm = newManager()
    const key = seedWorkspaceRuntime(rm, 'w2', 37301)
    rm.runtimes.get(key)!.background = true

    rm.recordWorkspaceMru(key)

    expect(rm.workspacePreviewMru).not.toContain(key)
  })

  test('the cap evicts the oldest workspace-session runtime alongside previews', async () => {
    const rm = newManager()
    const preview = seedAnchored(rm, 'p1', 37310)
    const w1 = seedWorkspaceRuntime(rm, 'w1', 37311)
    const w2 = seedWorkspaceRuntime(rm, 'w2', 37312)
    const w3 = seedWorkspaceRuntime(rm, 'w3', 37313) // oldest
    rm.workspacePreviewMru = [w2, preview, w1, w3]

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([w3])
  })

  test('a workspace mid-turn is kept even when it is the least recently used', async () => {
    const rm = newManager()
    const w1 = seedWorkspaceRuntime(rm, 'w1', 37320)
    const w2 = seedWorkspaceRuntime(rm, 'w2', 37321)
    const w3 = seedWorkspaceRuntime(rm, 'w3', 37322)
    const w4 = seedWorkspaceRuntime(rm, 'w4', 37323) // oldest, but busy
    rm.workspacePreviewMru = [w1, w2, w3, w4]
    markBusy(w4)

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    await rm.enforceWorkspacePreviewCap()

    // Nothing else is over the cap once the busy runtime is exempted.
    expect(stopped).toEqual([])
    expect(rm.runtimes.has(w4)).toBe(true)
  })

  test('workspaceActivity reports running + in-flight, and false once stopped', async () => {
    const rm = newManager()
    const key = seedWorkspaceRuntime(rm, 'w5', 37330)
    ;(rm as any).hasActiveWork = mock(async () => true)

    expect(await rm.workspaceActivity('w5')).toEqual({ running: true, inFlight: true })

    rm.runtimes.delete(key)
    expect(await rm.workspaceActivity('w5')).toEqual({ running: false, inFlight: false })
  })
})

/**
 * SHO-107. On a `low`-tier Windows host the desktop boot prewarm looked at the
 * newest workspace and spawned `ws:<workspaceId>` for it while the same
 * workspace's anchored runtime `ws:proj:<anchor>` was still starting — two
 * merged roots, two agent-runtime processes, one folder. The preview LRU
 * (cap=1 there) then evicted the anchored one, killing the PTY the user was
 * typing into ("1011 Connection ended").
 */
describe('RuntimeManager — one folder, one runtime', () => {
  test('a workspace-level start joins the anchor start already in flight', async () => {
    const rm = newManager()
    ;(rm as any).getProjectInfo = mock(async () => ({}))

    const anchorKey = projectWorkspaceRuntimeKey('p1')
    const anchorRuntime = {
      id: anchorKey,
      port: 37400,
      agentPort: 38400,
      status: 'running',
      url: 'http://localhost:37400',
      startedAt: Date.now(),
      process: null,
      agentProcess: fakeProcess(),
    }
    let releaseAnchor!: (runtime: any) => void
    const spawn = mock(
      async (_spec: any) =>
        new Promise((resolve) => {
          releaseAnchor = (runtime) => resolve(runtime)
        }),
    )
    ;(rm as any).doStartMergedRuntime = spawn

    // The anchored start is kicked off first and is still in flight (it has
    // not resolved) when the workspace-level resolve arrives — exactly the
    // ordering in the failing Windows run's API log.
    const anchorStart = rm.startProjectWorkspace('p1', { workspaceId: 'w1' })
    const workspaceStart = rm.startWorkspace('w1', { attachedProjectIds: [] })

    // Give the workspace resolve time to discover the in-flight anchor.
    await new Promise((resolve) => setTimeout(resolve, 80))
    releaseAnchor(anchorRuntime)

    const [anchorResult, workspaceResult] = await Promise.all([anchorStart, workspaceStart])

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(anchorResult.id).toBe(anchorKey)
    expect(workspaceResult.id).toBe(anchorKey)
    expect(rm.runtimes.has(workspaceRuntimeKey('w1'))).toBe(false)
  })

  test('a live anchored runtime is reused instead of spawning ws:<id>', async () => {
    const rm = newManager()
    const anchorKey = seedAnchored(rm, 'p2', 37410)
    ;(rm as any).runtimeOwners.set(anchorKey, { workspaceId: 'w2', anchorProjectId: 'p2' })
    const spawn = mock(async () => {
      throw new Error('must not spawn a second merged root')
    })
    ;(rm as any).doStartMergedRuntime = spawn

    const result = await rm.startWorkspace('w2', { attachedProjectIds: [] })

    expect(spawn).not.toHaveBeenCalled()
    expect(result.id).toBe(anchorKey)
    expect(rm.workspacePreviewMru[0]).toBe(anchorKey)
  })

  test('a workspace that mounts its own members still gets its ws:<id> runtime', async () => {
    const rm = newManager()
    const anchorKey = seedAnchored(rm, 'p3', 37420)
    ;(rm as any).runtimeOwners.set(anchorKey, { workspaceId: 'w3', anchorProjectId: 'p3' })
    ;(rm as any).getProjectInfo = mock(async () => ({}))
    const spawn = mock(async (spec: any) => ({
      id: spec.key,
      port: 37430,
      agentPort: 38430,
      status: 'running',
      url: 'http://localhost:37430',
      startedAt: Date.now(),
      process: null,
      agentProcess: fakeProcess(),
    }))
    ;(rm as any).doStartMergedRuntime = spawn

    const result = await rm.startWorkspace('w3', { attachedProjectIds: ['p9'] })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(result.id).toBe(workspaceRuntimeKey('w3'))
  })
})

/**
 * SHO-107 part 2. A runtime hosting an open terminal is never the LRU victim,
 * whatever the cap is.
 */
describe('RuntimeManager — an open terminal pins its runtime', () => {
  test('cap=1: the runtime with a live terminal session is not evicted', async () => {
    const rm = newLowTierManager()
    expect(rm.workspacePreviewMax).toBe(1)
    const newest = seedAnchored(rm, 'p1', 37440)
    const oldest = seedAnchored(rm, 'p2', 37441)
    rm.workspacePreviewMru = [newest, oldest]
    // The user has a shell open in the least-recently-used runtime.
    rm.noteTerminalSession('p2', 1)

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([])
    expect(rm.runtimes.has(oldest)).toBe(true)
  })

  test('once the terminal closes the runtime is evictable again', async () => {
    const rm = newLowTierManager()
    const newest = seedAnchored(rm, 'p3', 37450)
    const oldest = seedAnchored(rm, 'p4', 37451)
    rm.workspacePreviewMru = [newest, oldest]
    rm.noteTerminalSession('p4', 1)
    rm.noteTerminalSession('p4', -1)

    expect(rm.terminalSessionCount('p4')).toBe(0)

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([oldest])
  })

  test('a closing socket never drives the count negative', () => {
    const rm = newManager()
    rm.noteTerminalSession('p5', -1)
    expect(rm.terminalSessionCount('p5')).toBe(0)
  })
})

/**
 * SHO-107 QA round 1. The pin has to be wired in the composer the desktop
 * actually loads: `local-server.ts` (picked by `entry.ts` when
 * `SHOGO_LOCAL_MODE === 'true'`), not only `server.ts`.
 */
describe('terminal session pin — wired in every composer', () => {
  test('the shared helper counts ±1 against the project of the socket', () => {
    const manager = { noteTerminalSession: mock(() => {}) }
    countTerminalSession(manager, { projectId: 'p1' }, 1)
    countTerminalSession(manager, { projectId: 'p1' }, -1)
    expect(manager.noteTerminalSession.mock.calls).toEqual([
      ['p1', 1],
      ['p1', -1],
    ])
  })

  test('a socket without a project id, or a manager without the hook, is a no-op', () => {
    const manager = { noteTerminalSession: mock(() => {}) }
    countTerminalSession(manager, {}, 1)
    countTerminalSession(manager, null, 1)
    countTerminalSession(null, { projectId: 'p1' }, 1)
    countTerminalSession({}, { projectId: 'p2' }, 1)
    expect(manager.noteTerminalSession).not.toHaveBeenCalled()
  })

  test('a throwing manager never breaks the socket', () => {
    const manager = {
      noteTerminalSession: mock(() => {
        throw new Error('boom')
      }),
    }
    const warn = mock(() => {})
    const prevWarn = console.warn
    console.warn = warn as any
    try {
      expect(() => countTerminalSession(manager, { projectId: 'p1' }, 1)).not.toThrow()
    } finally {
      console.warn = prevWarn
    }
    expect(warn).toHaveBeenCalled()
  })

  test('both composers count terminal sockets around their PTY bridge', () => {
    // The Windows smoke run was desktop/local mode, where `server.ts` is never
    // evaluated — a pin wired only there leaves the failing surface unguarded.
    for (const composer of ['server.ts', 'local-server.ts']) {
      const source = readFileSync(join(import.meta.dir, '..', composer), 'utf8')
      expect(source).toContain("from './lib/terminal-session-pin'")
      expect(source).toContain(', ws.data, 1)')
      expect(source).toContain(', ws.data, -1)')
    }
  })
})

/**
 * SHO-107 QA round 1, minors.
 */
describe('RuntimeManager — start claims and session counts do not leak', () => {
  test('a start that throws before spawning releases its anchored claim', async () => {
    const rm = newManager()
    ;(rm as any).getProjectInfo = mock(async (id: string) =>
      id === 'remote1' ? { remoteHostId: 'host-1' } : {},
    )
    const anchorKey = projectWorkspaceRuntimeKey('p1')
    const spawn = mock(async () => {
      throw new Error('must not spawn')
    })
    ;(rm as any).doStartMergedRuntime = spawn

    await expect(
      rm.startProjectWorkspace('p1', { workspaceId: 'w1', attachedProjectIds: ['remote1'] }),
    ).rejects.toThrow(/Remote-SSH projects cannot be attached/)
    expect(spawn).not.toHaveBeenCalled()
    // Without this release, every later workspace-level resolve waits out
    // ANCHORED_REUSE_WAIT_MS for a start that is never coming.
    expect((rm as any).runtimeOwners.has(anchorKey)).toBe(false)
    expect((rm as any).hasAnchoredRuntime('w1')).toBe(false)
  })

  test('stopping a runtime clears its terminal session count', async () => {
    const rm = newManager()
    const key = seedAnchored(rm, 'p1', 37460)
    rm.noteTerminalSession('p1', 1)
    expect(rm.terminalSessionCount('p1')).toBe(1)

    await rm.stop(key, 'test')

    expect(rm.terminalSessionCount('p1')).toBe(0)
  })
})

/**
 * SHO-107 part 3. Boot must never warm more than the manager will keep: the
 * prewarm used to read `WORKSPACE_PREVIEW_MAX || '3'` while the manager kept 1
 * on a `low`-tier host, so an eviction right after boot was guaranteed. This
 * block covers the docker/self-host composer's `[StartupPrewarm]`; the desktop
 * boot warm is `[local-projects] prewarm` (one project, which then dedupes).
 */
describe('RuntimeManager — one cap, one place', () => {
  test('a low-tier host resolves to 1, and the manager uses that number', () => {
    const prevTier = process.env.SHOGO_HOST_TIER
    const prevMax = process.env.WORKSPACE_PREVIEW_MAX
    delete process.env.WORKSPACE_PREVIEW_MAX
    process.env.SHOGO_HOST_TIER = 'low'
    try {
      expect(resolveWorkspacePreviewMax()).toBe(1)
      expect(newLowTierManager().workspacePreviewMax).toBe(1)
    } finally {
      if (prevTier === undefined) delete process.env.SHOGO_HOST_TIER
      else process.env.SHOGO_HOST_TIER = prevTier
      if (prevMax !== undefined) process.env.WORKSPACE_PREVIEW_MAX = prevMax
    }
  })

  test('a normal host keeps 3, and WORKSPACE_PREVIEW_MAX wins', () => {
    const prevTier = process.env.SHOGO_HOST_TIER
    const prevMax = process.env.WORKSPACE_PREVIEW_MAX
    delete process.env.SHOGO_HOST_TIER
    delete process.env.WORKSPACE_PREVIEW_MAX
    try {
      expect(resolveWorkspacePreviewMax()).toBe(3)
      process.env.WORKSPACE_PREVIEW_MAX = '2'
      expect(resolveWorkspacePreviewMax()).toBe(2)
      process.env.WORKSPACE_PREVIEW_MAX = 'not-a-number'
      expect(resolveWorkspacePreviewMax()).toBe(3)
    } finally {
      if (prevTier !== undefined) process.env.SHOGO_HOST_TIER = prevTier
      if (prevMax === undefined) delete process.env.WORKSPACE_PREVIEW_MAX
      else process.env.WORKSPACE_PREVIEW_MAX = prevMax
    }
  })

  test('the desktop startup prewarm takes its take from the shared cap', () => {
    // server.ts is a 10k-line module that starts timers on import, so its boot
    // prewarm cannot be executed here. Pin the wiring instead: the prewarm must
    // ask the manager for the cap, never resolve WORKSPACE_PREVIEW_MAX itself.
    const source = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
    expect(source).toContain('resolveWorkspacePreviewMax()')
    expect(source).not.toContain('parseInt(process.env.WORKSPACE_PREVIEW_MAX')
  })
})
