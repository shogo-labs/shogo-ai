// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { RuntimeManager, projectWorkspaceRuntimeKey } from '../lib/runtime/manager'

const prevFlag = process.env.SHOGO_WORKSPACE_RUNTIME

beforeEach(() => {
  process.env.SHOGO_WORKSPACE_RUNTIME = 'true'
})

afterEach(() => {
  if (prevFlag === undefined) delete process.env.SHOGO_WORKSPACE_RUNTIME
  else process.env.SHOGO_WORKSPACE_RUNTIME = prevFlag
})

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

  test('resolveRuntimeKey falls back to the bare key when no anchored runtime exists', () => {
    const rm = newManager()
    expect(rm.resolveRuntimeKey('nope')).toBe('nope')
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
