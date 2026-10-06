// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MetalWarmPoolController } from '../metal-warm-pool-controller'
import { MetalPlacementRegistry, _setMetalPlacementRegistry } from '../metal-placement-registry'
import { WorkspaceCapacityError } from '../workspace-compute-budget'

const REG = {
  hostId: 'ash-1',
  meshIp: '10.8.0.2',
  agentPort: 9900,
  region: 'us',
  arch: 'x64',
  capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
  load: { available: 1, assigned: 0, suspended: 0 },
}

const env = (memMiB: number) => async () => ({ PROJECT_ID: 'p', WORKSPACE_ID: 'ws-1', SHOGO_VM_MEM_MIB: String(memMiB) })

function mkFetch(opts: { running: Set<string>; busy?: Set<string> }) {
  const calls: Array<{ path: string; projectId: string }> = []
  const fetchImpl = (async (url: string, init: any) => {
    const path = new URL(url).pathname
    const { projectId } = JSON.parse(init.body || '{}')
    calls.push({ path, projectId })
    if (path === '/status') {
      return Response.json({ state: opts.running.has(projectId) ? 'assigned' : 'suspended' })
    }
    if (path === '/stop') {
      if (opts.busy?.has(projectId)) return Response.json({ busy: true })
      opts.running.delete(projectId)
      return Response.json({ suspended: true })
    }
    if (path === '/assign') {
      opts.running.add(projectId)
      return Response.json({ url: 'http://10.8.0.2:8080', mode: 'assigned' })
    }
    return Response.json({})
  }) as any
  return { calls, fetchImpl }
}

describe('MetalWarmPoolController workspace budget', () => {
  let registry: MetalPlacementRegistry
  beforeEach(() => {
    registry = new MetalPlacementRegistry(() => null)
    _setMetalPlacementRegistry(registry)
  })
  afterEach(() => {
    _setMetalPlacementRegistry(null)
  })

  const budget16 = { isEnabled: () => true, loadBudgetMiB: async () => 16384 }

  it('suspends the workspace\'s idle VM before assigning one that would not fit', async () => {
    const { calls, fetchImpl } = mkFetch({ running: new Set(['odin1']) })
    const c = new MetalWarmPoolController(env(16384), fetchImpl, Date.now, registry, undefined, budget16)
    c.registerHost(REG)
    await registry.setPlacement('odin1', 'ash-1', 'local')
    await registry.recordWorkspaceRun('ws-1', 'odin1', 16384)

    await c.getMetalProjectUrl('odin2')

    const stopIdx = calls.findIndex((x) => x.path === '/stop' && x.projectId === 'odin1')
    const assignIdx = calls.findIndex((x) => x.path === '/assign' && x.projectId === 'odin2')
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(assignIdx).toBeGreaterThan(stopIdx)
    await new Promise((r) => setTimeout(r, 0))
    expect((await registry.listWorkspaceRuns('ws-1')).map((r) => r.runtimeKey)).toEqual(['odin2'])
    expect(await registry.takeBudgetNotice('odin2')).toEqual({
      workspaceId: 'ws-1',
      suspendedProjectIds: ['odin1'],
      runningCount: 1,
      budgetMiB: 16384,
    })
  })

  it('refuses without assigning when the VM holding the budget is busy', async () => {
    const { calls, fetchImpl } = mkFetch({ running: new Set(['odin1']), busy: new Set(['odin1']) })
    const c = new MetalWarmPoolController(env(16384), fetchImpl, Date.now, registry, undefined, budget16)
    c.registerHost(REG)
    await registry.setPlacement('odin1', 'ash-1', 'local')
    await registry.recordWorkspaceRun('ws-1', 'odin1', 16384)

    await expect(c.getMetalProjectUrl('odin2')).rejects.toBeInstanceOf(WorkspaceCapacityError)
    expect(calls.some((x) => x.path === '/assign')).toBe(false)
  })

  it('does nothing with the budget off', async () => {
    const { calls, fetchImpl } = mkFetch({ running: new Set(['odin1']) })
    const c = new MetalWarmPoolController(env(16384), fetchImpl, Date.now, registry, undefined, {
      isEnabled: () => false,
    })
    c.registerHost(REG)
    await registry.recordWorkspaceRun('ws-1', 'odin1', 16384)

    await c.getMetalProjectUrl('odin2')
    expect(calls.map((x) => x.path)).toEqual(['/assign'])
  })
})
