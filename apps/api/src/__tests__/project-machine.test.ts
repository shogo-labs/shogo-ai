// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Settings → Machine: per-project vCPU/RAM picker and restart.
 * Pure logic plus the restart wrapper with the recycle stubbed (no DB, no VM).
 */

import { describe, expect, it } from 'bun:test'
import { accountedVmMemMiB } from '../config/instance-sizes'
import {
  currentMachineSize,
  describeProjectMachine,
  planMachineChange,
  restartProjectMachine,
} from '../services/project-machine.service'

describe('currentMachineSize', () => {
  it('is Standard with no override', () => {
    expect(currentMachineSize(null, null)).toMatchObject({ id: 'standard', vcpus: 2, memMiB: 4096 })
  })
  it('matches a preset', () => {
    expect(currentMachineSize(8192, 4)).toMatchObject({ id: 'medium', vcpus: 4, memMiB: 8192 })
  })
  it('reports an operator-set size that is not a preset as custom', () => {
    expect(currentMachineSize(12288, 6)).toMatchObject({ id: 'custom', vcpus: 6, memMiB: 12288 })
  })
  it('fills an unset half with the standard size', () => {
    expect(currentMachineSize(8192, null)).toMatchObject({ id: 'custom', vcpus: 2, memMiB: 8192 })
  })
})

describe('planMachineChange', () => {
  it('upgrades within the workspace budget', () => {
    expect(planMachineChange('medium', 'medium')).toMatchObject({ ok: true, vmMemoryMiB: 8192, vmVcpus: 4 })
    expect(planMachineChange('xlarge', 'xlarge')).toMatchObject({ ok: true, vmMemoryMiB: 32768, vmVcpus: 8 })
  })
  it('refuses a size above the plan and names the plan that allows it', () => {
    const plan = planMachineChange('large', 'medium')
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.status).toBe(422)
      expect(plan.code).toBe('plan_ceiling')
      expect(plan.message).toContain('Large workspace plan')
    }
  })
  it('always allows downgrading to Standard, which clears the override', () => {
    expect(planMachineChange('standard', 'micro')).toMatchObject({ ok: true, vmMemoryMiB: null, vmVcpus: null })
  })
  it('rejects an unknown size', () => {
    expect(planMachineChange('huge', 'xlarge')).toMatchObject({ ok: false, status: 400 })
    expect(planMachineChange(undefined, 'xlarge')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('describeProjectMachine', () => {
  it('marks which sizes the plan allows', () => {
    const d = describeProjectMachine({ vmMemoryMiB: null, vmVcpus: null, instanceSize: 'medium', substrate: 'metal', running: true })
    expect(d.options.filter((o) => o.allowed).map((o) => o.id)).toEqual(['standard', 'medium'])
    expect(d.options.find((o) => o.id === 'large')?.requiredTier).toBe('large')
    expect(d.canChange).toBe(true)
    expect(d.canRestart).toBe(true)
  })
  it('is read-only off metal', () => {
    const d = describeProjectMachine({ vmMemoryMiB: null, vmVcpus: null, instanceSize: 'large', substrate: 'local', running: false })
    expect(d.canChange).toBe(false)
    expect(d.canRestart).toBe(false)
  })
})

describe('accountedVmMemMiB', () => {
  it('counts the picked size when bigger than the tier size', () => {
    expect(accountedVmMemMiB(4096, 8192, 'large')).toBe(8192)
  })
  it('never counts more than the workspace budget', () => {
    expect(accountedVmMemMiB(2048, 8192, 'micro')).toBe(2048)
    expect(accountedVmMemMiB(4096, 32768, 'medium')).toBe(8192)
  })
  it('keeps the tier size for no override or a smaller one', () => {
    expect(accountedVmMemMiB(4096, null, 'large')).toBe(4096)
    expect(accountedVmMemMiB(4096, 2048, 'large')).toBe(4096)
  })
})

describe('restartProjectMachine', () => {
  const actor = { id: 'u1', email: 'a@b.c' }
  const deps = (status: number, body: Record<string, unknown>, boots: string[]) => ({
    recycle: (async (req: any) => {
      expect(req.coldBoot).toBe(false)
      return { status, body }
    }) as any,
    loadDeps: async () => ({ coldBoot: async (id: string) => (boots.push(id), 'http://vm') }) as any,
  })

  it('recycles without waiting and boots in the background', async () => {
    const boots: string[] = []
    const out = await restartProjectMachine('p1', actor, deps(200, { ok: true }, boots))
    expect(out).toMatchObject({ ok: true, restarted: true })
    expect(boots).toEqual(['p1'])
  })
  it('treats a stopped project as nothing to restart', async () => {
    const boots: string[] = []
    const out = await restartProjectMachine('p1', actor, deps(404, { ok: false }, boots))
    expect(out).toMatchObject({ ok: true, restarted: false })
    expect(boots).toEqual([])
  })
  it('surfaces an aborted backup and does not boot', async () => {
    const boots: string[] = []
    const out = await restartProjectMachine('p1', actor, deps(409, { ok: false, error: 'recycle aborted' }, boots))
    expect(out).toMatchObject({ ok: false, status: 409 })
    expect(boots).toEqual([])
  })
})
