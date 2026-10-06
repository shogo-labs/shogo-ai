// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { MetalPlacementRegistry } from '../metal-placement-registry'
import {
  WorkspaceCapacityError,
  admitWorkspaceRuntime,
  formatCapacityRefusal,
  formatSleepNotice,
} from '../workspace-compute-budget'

const WS = 'ws-1'
const GB = 1024

function mkHost(running: string[], busy: string[] = []) {
  const live = new Set(running)
  const stopped: string[] = []
  return {
    stopped,
    status: async (key: string) => ({ state: live.has(key) ? ('assigned' as const) : ('suspended' as const) }),
    stop: async (key: string) => {
      if (busy.includes(key)) return { suspended: false, busy: true }
      live.delete(key)
      stopped.push(key)
      return { suspended: true, busy: false }
    },
  }
}

async function seed(registry: MetalPlacementRegistry, runs: Array<[string, number]>) {
  let t = 1_000
  for (const [key, mem] of runs) await registry.recordWorkspaceRun(WS, key, mem, (t += 1_000))
}

const keys = async (r: MetalPlacementRegistry) => (await r.listWorkspaceRuns(WS)).map((x) => x.runtimeKey)

describe('admitWorkspaceRuntime', () => {
  it('admits without touching hosts while the budget has room', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [['ws:proj:a', 4 * GB]])
    let calls = 0
    const res = await admitWorkspaceRuntime(WS, 'ws:proj:b', 4 * GB, {
      registry,
      budgetMiB: 16 * GB,
      status: async () => (calls++, null),
      stop: async () => (calls++, { suspended: true, busy: false }),
    })
    expect(res.suspended).toEqual([])
    expect(calls).toBe(0)
  })

  it('suspends the least-recently-opened idle runtime to make room', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [['ws:proj:odin1', 16 * GB]])
    const host = mkHost(['ws:proj:odin1'])
    const res = await admitWorkspaceRuntime(WS, 'ws:proj:odin2', 16 * GB, { registry, budgetMiB: 16 * GB, ...host })
    expect(res.suspended).toEqual(['ws:proj:odin1'])
    expect(await keys(registry)).toEqual([])
  })

  it('drops entries the host already suspended instead of suspending again', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [['ws:proj:a', 16 * GB]])
    const host = mkHost([])
    const res = await admitWorkspaceRuntime(WS, 'ws:proj:b', 16 * GB, { registry, budgetMiB: 16 * GB, ...host })
    expect(res.suspended).toEqual([])
    expect(host.stopped).toEqual([])
    expect(await keys(registry)).toEqual([])
  })

  it('sheds oldest first and only as much as it needs', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [
      ['ws:proj:a', 4 * GB],
      ['ws:proj:b', 4 * GB],
      ['ws:proj:c', 4 * GB],
      ['ws:proj:d', 4 * GB],
    ])
    const host = mkHost(['ws:proj:a', 'ws:proj:b', 'ws:proj:c', 'ws:proj:d'])
    const res = await admitWorkspaceRuntime(WS, 'ws:proj:e', 8 * GB, { registry, budgetMiB: 16 * GB, ...host })
    expect(res.suspended).toEqual(['ws:proj:a', 'ws:proj:b'])
    expect(await keys(registry)).toEqual(['ws:proj:c', 'ws:proj:d'])
  })

  it('skips a busy runtime and refuses when nothing else frees enough', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [['ws:proj:odin1', 16 * GB]])
    const host = mkHost(['ws:proj:odin1'], ['ws:proj:odin1'])
    const err = await admitWorkspaceRuntime(WS, 'ws:proj:odin2', 16 * GB, {
      registry,
      budgetMiB: 16 * GB,
      ...host,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(WorkspaceCapacityError)
    expect((err as WorkspaceCapacityError).blockedBy).toEqual([{ projectId: 'odin1', memMiB: 16 * GB, busy: true }])
    expect(await keys(registry)).toEqual(['ws:proj:odin1'])
  })

  it('never sheds around a runtime that is already running', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [['ws:proj:a', 16 * GB]])
    const host = mkHost(['ws:proj:a', 'ws:proj:b'])
    const res = await admitWorkspaceRuntime(WS, 'ws:proj:b', 16 * GB, { registry, budgetMiB: 16 * GB, ...host })
    expect(res.suspended).toEqual([])
    expect(host.stopped).toEqual([])
  })

  it('admits a single runtime larger than the budget once nothing else runs', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    const host = mkHost([])
    const res = await admitWorkspaceRuntime(WS, 'ws:proj:expo', 4 * GB, { registry, budgetMiB: 2 * GB, ...host })
    expect(res.suspended).toEqual([])
  })

  it('reports how many runtimes are running after the open', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [
      ['ws:proj:a', 4 * GB],
      ['ws:proj:b', 4 * GB],
      ['ws:proj:c', 4 * GB],
    ])
    const host = mkHost(['ws:proj:a', 'ws:proj:b', 'ws:proj:c'])
    const res = await admitWorkspaceRuntime(WS, 'ws:proj:d', 8 * GB, { registry, budgetMiB: 16 * GB, ...host })
    expect(res).toEqual({ suspended: ['ws:proj:a'], runningCount: 3 })
  })

  it('gives up on a suspend that outlasts the deadline', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await seed(registry, [['ws:proj:a', 16 * GB]])
    const err = await admitWorkspaceRuntime(WS, 'ws:proj:b', 16 * GB, {
      registry,
      budgetMiB: 16 * GB,
      deadlineMs: 20,
      status: async (key) => ({ state: key === 'ws:proj:a' ? 'assigned' : 'none' }),
      stop: () => new Promise(() => {}),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(WorkspaceCapacityError)
    expect((err as WorkspaceCapacityError).blockedBy[0]).toMatchObject({ projectId: 'a', busy: false })
  })
})

describe('budget messages', () => {
  const large = { size: 'large' as const, label: 'Large' }

  it('says what was put to sleep, how many are running, and to upgrade', () => {
    const m = formatSleepNotice({ runningCount: 1, budgetMiB: 16 * GB }, [{ id: 'a', name: 'Odin A' }], large)
    expect(m.message).toBe(
      'Opening this project put 1 other project to sleep (Odin A). Your Large workspace has 16 GB for ' +
        'running projects, and 1 project is running now. Upgrade your instance size to keep more projects running at once.',
    )
    expect(m).toMatchObject({ runningCount: 1, budgetGb: 16, canUpgrade: true, instanceSize: 'large' })
  })

  it('pluralizes and drops the upgrade pitch on the top tier', () => {
    const m = formatSleepNotice(
      { runningCount: 2, budgetMiB: 32 * GB },
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      { size: 'xlarge', label: 'XLarge' },
    )
    expect(m.message).toContain('put 2 other projects to sleep (A, B)')
    expect(m.message).toContain('2 projects are running now')
    expect(m.message).not.toContain('Upgrade')
    expect(m.canUpgrade).toBe(false)
  })

  it('explains a refusal with the busy projects and an upgrade path', () => {
    const m = formatCapacityRefusal(
      { budgetMiB: 16 * GB, blockedBy: [{ projectId: 'a', memMiB: 16 * GB, busy: true }] },
      [{ id: 'a', name: 'Odin A' }],
      large,
    )
    expect(m.message).toBe(
      'Your Large workspace has 16 GB for running projects, and all of it is in use by 1 busy project (Odin A). ' +
        'Wait for it to finish or stop it, or upgrade your instance size to run more projects at once.',
    )
  })
})

describe('budget notices in the placement registry', () => {
  it('are read once', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await registry.setBudgetNotice('ws:proj:b', { suspendedProjectIds: ['a'] })
    expect(await registry.takeBudgetNotice('ws:proj:b')).toEqual({ suspendedProjectIds: ['a'] })
    expect(await registry.takeBudgetNotice('ws:proj:b')).toBeNull()
  })

  it('expire', async () => {
    const registry = new MetalPlacementRegistry(() => null)
    await registry.setBudgetNotice('ws:proj:b', { x: 1 }, 1_000)
    expect(await registry.takeBudgetNotice('ws:proj:b', 1_000 + 301_000)).toBeNull()
  })
})
