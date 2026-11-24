// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Settings → Machine: per-project vCPU/RAM picker and restart.
 * Pure logic plus the restart wrapper with the recycle stubbed (no DB, no VM).
 */

import { describe, expect, it } from 'bun:test'
import { accountedVmMemMiB } from '../config/instance-sizes'
import { vmHourlyUsd } from '../config/vm-pricing'
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
  it('accepts every preset, whatever the workspace tier', () => {
    expect(planMachineChange('medium')).toMatchObject({ ok: true, vmMemoryMiB: 8192, vmVcpus: 4 })
    expect(planMachineChange('xlarge')).toMatchObject({ ok: true, vmMemoryMiB: 32768, vmVcpus: 8 })
  })
  it('accepts a size above the workspace tier — the machine is billed per hour, not by plan', () => {
    // SHO-578 §E: a `micro` workspace may pick XLarge; `accountedVmMemMiB` keeps
    // the workspace budget safe, and the meter charges the real size.
    expect(planMachineChange('xlarge')).toMatchObject({ ok: true, vmMemoryMiB: 32768, vmVcpus: 8 })
    expect(planMachineChange('large')).toMatchObject({ ok: true, vmMemoryMiB: 16384, vmVcpus: 4 })
  })
  it('always allows downgrading to Standard, which clears the override', () => {
    expect(planMachineChange('standard')).toMatchObject({ ok: true, vmMemoryMiB: null, vmVcpus: null })
  })
  it('rejects an unknown size', () => {
    expect(planMachineChange('huge')).toMatchObject({ ok: false, status: 400 })
    expect(planMachineChange(undefined)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('describeProjectMachine', () => {
  it('offers every size on a micro workspace, each with its hourly price', () => {
    const d = describeProjectMachine({ vmMemoryMiB: null, vmVcpus: null, instanceSize: 'micro', substrate: 'metal', running: true })
    expect(d.options.map((o) => o.id)).toEqual(['standard', 'medium', 'large', 'xlarge'])
    expect(d.options.map((o) => o.hourlyUsd)).toEqual([0.188, 0.376, 0.472, 0.944])
    expect(d.canChange).toBe(true)
    expect(d.canRestart).toBe(true)
  })
  it('is read-only off metal', () => {
    const d = describeProjectMachine({ vmMemoryMiB: null, vmVcpus: null, instanceSize: 'large', substrate: 'local', running: false })
    expect(d.canChange).toBe(false)
    expect(d.canRestart).toBe(false)
  })
})

describe('vmHourlyUsd', () => {
  it('prices a machine from VM_PRICING (vCPU-h + GiB-h)', () => {
    expect(vmHourlyUsd(2, 4096)).toBe(0.188)
    expect(vmHourlyUsd(8, 32768)).toBe(0.944)
    expect(vmHourlyUsd(0, 0)).toBe(0)
  })
})

describe('accountedVmMemMiB', () => {
  it('counts the picked size when bigger than the tier size', () => {
    expect(accountedVmMemMiB(4096, 8192, 'large')).toBe(8192)
  })
  it('never counts more than the workspace budget', () => {
    expect(accountedVmMemMiB(2048, 8192, 'micro')).toBe(2048)
    expect(accountedVmMemMiB(2048, 32768, 'micro')).toBe(2048)
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
