// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/jobs/disk-addon-daily.ts (SHO-401).
// Covers: add-on GiB math, one charge per workspace per day, a rerun the same
// day charging nothing, an out-of-funds debit rolling the watermark back, and
// local mode doing nothing.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

let workspacesImpl: () => Promise<any[]> = async () => []
let claimImpl: () => Promise<boolean> = async () => true
let consumeImpl: (args: any) => Promise<any> = async () => ({ success: true })
let eligibilityImpl: (workspaceId: string) => Promise<any> = async () => ({ canBuyAddon: true })

const updateManyCalls: any[] = []
const consumeCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: {
      findMany: () => workspacesImpl(),
      updateMany: (args: any) => {
        updateManyCalls.push(args)
        // The claim update (data.diskAddonBilledThrough set) succeeds; the
        // rollback (data.diskAddonBilledThrough null) also succeeds.
        return Promise.resolve({ count: 1 })
      },
    },
  },
}))

mock.module('../../lib/region-period-claim', () => ({
  claimRegionPeriod: () => claimImpl(),
}))

mock.module('../../lib/region', () => ({
  homeRegionWorkspaceWhere: () => null,
}))

mock.module('../../services/billing.service', () => ({
  consumeUsage: (args: any) => {
    consumeCalls.push(args)
    return consumeImpl(args)
  },
}))

mock.module('../../services/project-disk.service', () => ({
  resolveDiskAddonEligibility: (id: string) => eligibilityImpl(id),
}))

const { runDiskAddonDaily, workspaceAddonGiB } = await import('../disk-addon-daily')

beforeEach(() => {
  workspacesImpl = async () => []
  claimImpl = async () => true
  consumeImpl = async () => ({ success: true })
  eligibilityImpl = async () => ({ canBuyAddon: true })
  updateManyCalls.length = 0
  consumeCalls.length = 0
  delete process.env.SHOGO_LOCAL_MODE
})

describe('workspaceAddonGiB', () => {
  it('sums project drives above included plus the runtime drive', () => {
    // micro includes 20 GiB. Two projects at 30 and 20, runtime at 50.
    const addon = workspaceAddonGiB({
      instanceSize: 'micro',
      canBuyAddon: true,
      projectDiskGiB: [30, 20],
      runtimeDiskGiB: 50,
    })
    expect(addon).toBe(10 + 0 + 30)
  })

  it('is zero when nothing is above included', () => {
    expect(
      workspaceAddonGiB({ instanceSize: 'medium', canBuyAddon: true, projectDiskGiB: [40], runtimeDiskGiB: null }),
    ).toBe(0)
  })
})

describe('runDiskAddonDaily', () => {
  it('charges one disk_addon event per workspace per day', async () => {
    workspacesImpl = async () => [
      {
        id: 'ws-1',
        instanceSize: 'micro',
        runtimeDiskGiB: 50,
        diskAddonBilledThrough: null,
        projects: [{ workspaceDiskGiB: 30 }],
      },
    ]
    const summary = await runDiskAddonDaily(new Date('2026-11-16T12:00:00Z'))
    expect(summary.charged).toBe(1)
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0].actionType).toBe('disk_addon')
    expect(consumeCalls[0].actionMetadata.addonGiB).toBe(40) // 10 (project) + 30 (runtime)
    // The watermark was advanced before the debit.
    expect(updateManyCalls[0].data.diskAddonBilledThrough).toBeInstanceOf(Date)
  })

  it('is a no-op when the workspace was already billed today', async () => {
    workspacesImpl = async () => [
      {
        id: 'ws-1',
        instanceSize: 'micro',
        runtimeDiskGiB: 50,
        diskAddonBilledThrough: new Date('2026-11-16T00:00:00Z'),
        projects: [],
      },
    ]
    const summary = await runDiskAddonDaily(new Date('2026-11-16T12:00:00Z'))
    expect(summary.charged).toBe(0)
    expect(summary.skipped).toBe(1)
    expect(consumeCalls).toHaveLength(0)
  })

  it('rolls the watermark back and never shrinks when the wallet is empty', async () => {
    workspacesImpl = async () => [
      {
        id: 'ws-1',
        instanceSize: 'micro',
        runtimeDiskGiB: 50,
        diskAddonBilledThrough: null,
        projects: [],
      },
    ]
    consumeImpl = async () => ({ success: false, reason: 'usage_limit_reached' })
    const summary = await runDiskAddonDaily(new Date('2026-11-16T12:00:00Z'))
    expect(summary.failed).toBe(1)
    expect(summary.charged).toBe(0)
    // Claim then rollback: the second updateMany sets the watermark back to null.
    const rollback = updateManyCalls.find((c) => c.data.diskAddonBilledThrough === null)
    expect(rollback).toBeTruthy()
  })

  it('does nothing in local mode', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    workspacesImpl = async () => [
      { id: 'ws-1', instanceSize: 'micro', runtimeDiskGiB: 50, diskAddonBilledThrough: null, projects: [] },
    ]
    const summary = await runDiskAddonDaily(new Date('2026-11-16T12:00:00Z'))
    expect(summary.charged).toBe(0)
    expect(consumeCalls).toHaveLength(0)
  })

  it('skips the whole run when another pod claimed the day', async () => {
    claimImpl = async () => false
    workspacesImpl = async () => [
      { id: 'ws-1', instanceSize: 'micro', runtimeDiskGiB: 50, diskAddonBilledThrough: null, projects: [] },
    ]
    const summary = await runDiskAddonDaily(new Date('2026-11-16T12:00:00Z'))
    expect(summary.claimed).toBe(false)
    expect(consumeCalls).toHaveLength(0)
  })
})
