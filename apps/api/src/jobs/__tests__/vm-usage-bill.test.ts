// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace compute pricing + hourly bill (SHO-424).
 *
 * The number here is the invoice. Russell's rates are $0.10/vCPU-hour and
 * $0.005/GiB-hour, charged only for the seconds a VM was doing something a
 * person or their agent asked for — the idle-suspend tail is metered so the
 * dashboard can show it, and costs nothing.
 *
 * What these pin:
 *  - the arithmetic (a 2 vCPU / 4 GiB VM is exactly $0.22 per active hour),
 *  - idle seconds costing nothing while still being reported as metered,
 *  - the never-billed causes (`published` would double-charge against
 *    published_hosting; `rewarm`/`prewarm` are the platform's own work),
 *  - one bucket per workspace-hour, and per-project attribution inside it,
 *  - shadow as the default mode, so shipping this cannot charge anyone.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('../../lib/prisma', () => ({
  prisma: {
    vmUsageHour: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    platformSetting: { updateMany: async () => ({ count: 0 }) },
  },
}))
mock.module('../../lib/global-job-lock', () => ({
  withGlobalJobLock: async (_n: string, fn: any) => ({ acquired: true, result: await fn() }),
}))

const { VM_PRICING, computeVmCost, isBillableCause, vmBillingMode, roundUsd } = await import('../../config/vm-pricing')
const { groupByWorkspaceHour, priceWorkspaceHour } = await import('../vm-usage-bill')

const HOUR = new Date(Date.UTC(2026, 10, 18, 10, 0, 0))

function row(fields: Partial<{
  id: string
  workspaceId: string
  projectId: string
  hour: Date
  vcpus: number
  memMiB: number
  cause: string
  agentSeconds: number
  appSeconds: number
  idleSeconds: number
}> = {}) {
  return {
    id: fields.id ?? 'r1',
    workspaceId: fields.workspaceId ?? 'ws-1',
    projectId: fields.projectId ?? '',
    hour: fields.hour ?? HOUR,
    vcpus: fields.vcpus ?? 2,
    memMiB: fields.memMiB ?? 4096,
    cause: fields.cause ?? 'user_open',
    agentSeconds: fields.agentSeconds ?? 0,
    appSeconds: fields.appSeconds ?? 0,
    idleSeconds: fields.idleSeconds ?? 0,
  }
}

describe('compute pricing', () => {
  it('prices the standard 2 vCPU / 4 GiB VM at $0.22 per active hour', () => {
    const cost = computeVmCost({ vcpus: 2, memMiB: 4096, agentSeconds: 0, appSeconds: 3600, idleSeconds: 0, cause: 'user_open' })
    expect(cost.vcpuUsd).toBeCloseTo(0.2, 10)
    expect(cost.memoryUsd).toBeCloseTo(0.02, 10)
    expect(cost.totalUsd).toBeCloseTo(0.22, 10)
    expect(cost.billedSeconds).toBe(3600)
  })

  it('scales with the size the host actually booted', () => {
    const cost = computeVmCost({ vcpus: 4, memMiB: 8192, agentSeconds: 1800, appSeconds: 0, idleSeconds: 0, cause: 'user_open' })
    // Half an hour of a machine twice the size = the same money.
    expect(cost.vcpuHours).toBeCloseTo(2, 10)
    expect(cost.gibHours).toBeCloseTo(4, 10)
    expect(cost.totalUsd).toBeCloseTo(0.22, 10)
  })

  it('charges nothing for the idle tail but still counts it as metered', () => {
    const cost = computeVmCost({ vcpus: 2, memMiB: 4096, agentSeconds: 0, appSeconds: 0, idleSeconds: 3600, cause: 'user_open' })
    expect(cost.totalUsd).toBe(0)
    expect(cost.billedSeconds).toBe(0)
    expect(cost.freeSeconds).toBe(3600)
    expect(cost.freeCause).toBe(false)
  })

  it('bills only the active seconds of a mixed hour', () => {
    const cost = computeVmCost({ vcpus: 2, memMiB: 4096, agentSeconds: 600, appSeconds: 600, idleSeconds: 2400, cause: 'user_open' })
    expect(cost.billedSeconds).toBe(1200)
    expect(cost.freeSeconds).toBe(2400)
    expect(cost.totalUsd).toBeCloseTo(0.22 / 3, 10)
  })

  it('never bills a cause the platform already paid for', () => {
    for (const cause of VM_PRICING.neverBilledCauses) {
      const cost = computeVmCost({ vcpus: 8, memMiB: 16384, agentSeconds: 3600, appSeconds: 3600, idleSeconds: 0, cause })
      expect(cost.totalUsd).toBe(0)
      expect(cost.freeCause).toBe(true)
      expect(isBillableCause(cause)).toBe(false)
    }
    expect(isBillableCause('user_open')).toBe(true)
    expect(isBillableCause('agent_wake')).toBe(true)
  })

  it('does not charge a zero-second row', () => {
    expect(computeVmCost({ vcpus: 2, memMiB: 4096, agentSeconds: 0, appSeconds: 0, idleSeconds: 0, cause: 'user_open' }).totalUsd).toBe(0)
  })

  it('rounds to the 6dp precision usage events record', () => {
    expect(roundUsd(0.1234567891)).toBe(0.123457)
    expect(roundUsd(0)).toBe(0)
  })

  it('defaults to shadow mode', () => {
    expect(vmBillingMode({} as NodeJS.ProcessEnv)).toBe('shadow')
    expect(vmBillingMode({ VM_BILLING_MODE: 'enforce' } as NodeJS.ProcessEnv)).toBe('enforce')
    expect(vmBillingMode({ VM_BILLING_MODE: 'nonsense' } as NodeJS.ProcessEnv)).toBe('shadow')
  })
})

describe('groupByWorkspaceHour', () => {
  it('buckets every row of one workspace-hour together', () => {
    const groups = groupByWorkspaceHour([
      row({ id: 'a', projectId: 'proj-1', appSeconds: 600 }),
      row({ id: 'b', projectId: 'proj-2', agentSeconds: 600 }),
      row({ id: 'c', projectId: '', agentSeconds: 60 }),
    ])
    expect(groups.size).toBe(1)
    expect([...groups.values()][0].map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('separates hours and workspaces', () => {
    const groups = groupByWorkspaceHour([
      row({ id: 'a' }),
      row({ id: 'b', hour: new Date(HOUR.getTime() + 3_600_000) }),
      row({ id: 'c', workspaceId: 'ws-2' }),
    ])
    expect(groups.size).toBe(3)
  })
})

describe('priceWorkspaceHour', () => {
  it('sums a workspace-hour into one charge with per-project attribution', () => {
    const priced = priceWorkspaceHour([
      row({ id: 'a', projectId: 'proj-1', appSeconds: 1800 }),
      row({ id: 'b', projectId: 'proj-2', agentSeconds: 1800 }),
    ])

    // Two half-hours of the standard size = one standard hour.
    expect(priced.chargedUsd).toBeCloseTo(0.22, 6)
    expect(priced.agentSeconds).toBe(1800)
    expect(priced.appSeconds).toBe(1800)
    expect(Object.keys(priced.byProject).sort()).toEqual(['proj-1', 'proj-2'])
    expect(priced.byProject['proj-1'].chargedUsd).toBeCloseTo(0.11, 6)
    expect(priced.byProject['proj-2'].chargedUsd).toBeCloseTo(0.11, 6)
  })

  it('reports the idle tail as not billed rather than folding it into the charge', () => {
    const priced = priceWorkspaceHour([row({ appSeconds: 1800, idleSeconds: 1800 })])
    expect(priced.chargedUsd).toBeCloseTo(0.11, 6)
    // What the full hour would have cost minus what it did: the platform ate it.
    expect(priced.byState.idleNotBilledUsd).toBeCloseTo(0.11, 6)
    expect(priced.freeUsd).toBeCloseTo(0.11, 6)
    expect(priced.idleSeconds).toBe(1800)
  })

  it('charges nothing for a workspace-hour that was entirely idle', () => {
    const priced = priceWorkspaceHour([row({ idleSeconds: 3600 })])
    expect(priced.chargedUsd).toBe(0)
    expect(priced.freeUsd).toBeCloseTo(0.22, 6)
  })

  it('charges nothing for a platform-caused row', () => {
    const priced = priceWorkspaceHour([
      row({ cause: 'prewarm', appSeconds: 3600 }),
      row({ id: 'r2', cause: 'published', appSeconds: 3600 }),
      row({ id: 'r3', cause: 'rewarm', appSeconds: 3600 }),
    ])
    expect(priced.chargedUsd).toBe(0)
  })

  it('keeps the workspace-level bucket distinct from project buckets', () => {
    const priced = priceWorkspaceHour([
      row({ id: 'a', projectId: '', appSeconds: 3600 }),
      row({ id: 'b', projectId: 'proj-1', appSeconds: 3600 }),
    ])
    expect(priced.byProject['']).toBeDefined()
    expect(priced.byProject['proj-1']).toBeDefined()
    expect(priced.chargedUsd).toBeCloseTo(0.44, 6)
  })
})
