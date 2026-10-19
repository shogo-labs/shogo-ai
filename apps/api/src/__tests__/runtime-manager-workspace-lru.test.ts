// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import {
  RuntimeManager,
  projectWorkspaceRuntimeKey,
  workspaceRuntimeKey,
} from '../lib/runtime/manager'

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
  resolveRuntimeKey: (projectId: string) => string
  recordWorkspaceMru: (key: string) => void
  enforceWorkspacePreviewCap: () => Promise<void>
}

function newManager(): PrivateRM {
  const rm = new RuntimeManager({ healthCheckInterval: 50 }) as PrivateRM
  // Neutralize the embedded worker manager so touch/stop don't do real work.
  rm.agentManager = { touch: mock(() => {}), stop: mock(async () => {}) }
  return rm
}

function seedAnchored(rm: PrivateRM, projectId: string, port: number) {
  const key = projectWorkspaceRuntimeKey(projectId)
  rm.runtimes.set(key, {
    id: key,
    port,
    agentPort: port + 1000,
    status: 'running',
    url: `http://localhost:${port}`,
    startedAt: Date.now(),
    process: null,
    agentProcess: fakeProcess(),
  })
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

  test('touch(projectId) touches the anchored key and records it as most-recent', () => {
    const rm = newManager()
    const key = seedAnchored(rm, 'p1', 37201)

    rm.touch('p1')

    expect(rm.agentManager.touch).toHaveBeenCalledWith(key)
    expect(rm.workspacePreviewMru[0]).toBe(key)
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

  test('touch reorders the MRU so a refreshed project survives eviction', async () => {
    const rm = newManager()
    const k1 = seedAnchored(rm, 'p1', 37220)
    const k2 = seedAnchored(rm, 'p2', 37221)
    const k3 = seedAnchored(rm, 'p3', 37222)
    const k4 = seedAnchored(rm, 'p4', 37223)
    rm.workspacePreviewMru = [k1, k2, k3, k4]

    // Touch the oldest (p4) — it becomes most-recent; p3 is now the LRU.
    rm.touch('p4')

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })

    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([k3])
    expect(rm.workspacePreviewMru[0]).toBe(k4)
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
      startedAt: Date.now(),
      process: null,
      agentProcess: fakeProcess(),
    })
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
    ;(rm as any).hasActiveWork = mock(async (key: string) => key === w4)

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
