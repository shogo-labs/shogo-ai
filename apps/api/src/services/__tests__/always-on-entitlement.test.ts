// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Entitlement math for always-on published apps: allowance resolution from
// (plan, entitled seats), live-slot counting, and the canEnableAlwaysOn gate.
// Uses a focused in-memory prisma mock (the shared billing.service.test mock
// has no `project` model).

import { beforeEach, describe, expect, it, mock } from 'bun:test'

// Ensure the real (non-local) code path runs — local mode short-circuits to
// Infinity / always-allowed.
delete process.env.SHOGO_LOCAL_MODE

type Sub = { workspaceId: string; planId: string; seats: number; status: string }
type Grant = {
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  planId: string | null
  startsAt: Date
  expiresAt: Date | null
}
type Project = { workspaceId: string; publishedAlwaysOn: boolean; publishStatus: string; id: string }

let subRow: Sub | null = null
let grantRows: Grant[] = []
let projectRows: Project[] = []

const prismaApi = {
  subscription: {
    findFirst: async ({ where, select }: any) => {
      if (!subRow) return null
      if (where?.workspaceId && subRow.workspaceId !== where.workspaceId) return null
      if (where?.status?.in && !where.status.in.includes(subRow.status)) return null
      if (!select) return subRow
      const out: any = {}
      for (const k of Object.keys(select)) if (select[k]) out[k] = (subRow as any)[k]
      return out
    },
  },
  workspaceGrant: {
    findMany: async ({ where }: any) => {
      const now = where?.startsAt?.lte ?? new Date()
      return grantRows.filter((r) => {
        if (r.workspaceId !== where.workspaceId) return false
        if (+r.startsAt > +now) return false
        if (r.expiresAt && +r.expiresAt <= +now) return false
        return true
      })
    },
  },
  project: {
    count: async ({ where }: any) => {
      return projectRows.filter((p) => {
        if (p.workspaceId !== where.workspaceId) return false
        if (where.publishedAlwaysOn !== undefined && p.publishedAlwaysOn !== where.publishedAlwaysOn) return false
        if (where.publishStatus !== undefined && p.publishStatus !== where.publishStatus) return false
        if (where.id?.not !== undefined && p.id === where.id.not) return false
        return true
      }).length
    },
  },
}

mock.module('../../lib/prisma', () => ({
  prisma: prismaApi,
  SubscriptionStatus: { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))
mock.module('../../config/stripe-prices', () => ({
  getOveragePriceConfig: () => ({ priceId: 'price_overage_x' }),
}))
mock.module('../billing-alerts.service', () => ({
  notifyOverageCharged: async () => {},
  evaluateUsageAlerts: async () => {},
}))

const billing = await import('../billing.service')

const WS = 'ws_1'

function paidSub(planId: string, seats: number): Sub {
  return { workspaceId: WS, planId, seats, status: 'active' }
}
function liveAlwaysOnProjects(n: number, opts?: { id?: (i: number) => string }) {
  projectRows = Array.from({ length: n }, (_, i) => ({
    workspaceId: WS,
    publishedAlwaysOn: true,
    publishStatus: 'live',
    id: opts?.id ? opts.id(i) : `proj_${i}`,
  }))
}

beforeEach(() => {
  subRow = null
  grantRows = []
  projectRows = []
})

describe('getAlwaysOnAllowanceForWorkspace', () => {
  it('free workspace (no sub, no grant) gets 0', async () => {
    expect(await billing.getAlwaysOnAllowanceForWorkspace(WS)).toBe(0)
  })

  it('basic gets 0', async () => {
    subRow = paidSub('basic', 1)
    expect(await billing.getAlwaysOnAllowanceForWorkspace(WS)).toBe(0)
  })

  it('pro gets 1 slot per paid seat', async () => {
    subRow = paidSub('pro', 3)
    expect(await billing.getAlwaysOnAllowanceForWorkspace(WS)).toBe(3)
  })

  it('business adds granted free seats to paid seats', async () => {
    subRow = paidSub('business', 2)
    grantRows = [{ workspaceId: WS, freeSeats: 2, monthlyIncludedUsd: 0, planId: null, startsAt: new Date(0), expiresAt: null }]
    expect(await billing.getAlwaysOnAllowanceForWorkspace(WS)).toBe(4)
  })

  it('enterprise is unlimited (Infinity)', async () => {
    subRow = paidSub('enterprise', 1)
    expect(await billing.getAlwaysOnAllowanceForWorkspace(WS)).toBe(Infinity)
  })

  it('grant-only pro plan (no paid sub) gets 1 per granted seat (min 1)', async () => {
    grantRows = [{ workspaceId: WS, freeSeats: 2, monthlyIncludedUsd: 0, planId: 'pro', startsAt: new Date(0), expiresAt: null }]
    expect(await billing.getAlwaysOnAllowanceForWorkspace(WS)).toBe(2)
  })
})

describe('countAlwaysOnUsed', () => {
  it('counts only live always-on projects', async () => {
    projectRows = [
      { workspaceId: WS, publishedAlwaysOn: true, publishStatus: 'live', id: 'a' },
      { workspaceId: WS, publishedAlwaysOn: true, publishStatus: 'idle', id: 'b' }, // not live
      { workspaceId: WS, publishedAlwaysOn: false, publishStatus: 'live', id: 'c' }, // not always-on
      { workspaceId: 'other', publishedAlwaysOn: true, publishStatus: 'live', id: 'd' }, // other ws
    ]
    expect(await billing.countAlwaysOnUsed(WS)).toBe(1)
  })

  it('excludes the given project id', async () => {
    liveAlwaysOnProjects(2, { id: (i) => (i === 0 ? 'self' : 'other') })
    expect(await billing.countAlwaysOnUsed(WS)).toBe(2)
    expect(await billing.countAlwaysOnUsed(WS, 'self')).toBe(1)
  })
})

describe('canEnableAlwaysOn', () => {
  it('blocks free/basic with plan_not_allowed semantics (planAllows=false)', async () => {
    subRow = paidSub('basic', 5)
    const gate = await billing.canEnableAlwaysOn(WS, 'p1')
    expect(gate.planAllows).toBe(false)
    expect(gate.allowed).toBe(false)
    expect(gate.allowance).toBe(0)
  })

  it('allows pro with a free slot', async () => {
    subRow = paidSub('pro', 2) // allowance 2
    liveAlwaysOnProjects(1, { id: () => 'other' }) // 1 used by another project
    const gate = await billing.canEnableAlwaysOn(WS, 'p1')
    expect(gate.planAllows).toBe(true)
    expect(gate.allowed).toBe(true)
    expect(gate.allowance).toBe(2)
    expect(gate.used).toBe(1)
  })

  it('blocks pro at cap with slot_exhausted semantics (planAllows=true, allowed=false)', async () => {
    subRow = paidSub('pro', 1) // allowance 1
    liveAlwaysOnProjects(1, { id: () => 'other' }) // the 1 slot is taken by another project
    const gate = await billing.canEnableAlwaysOn(WS, 'p1')
    expect(gate.planAllows).toBe(true)
    expect(gate.allowed).toBe(false)
    expect(gate.used).toBe(1)
  })

  it('a project re-enabling its own slot is not counted against itself', async () => {
    subRow = paidSub('pro', 1) // allowance 1
    liveAlwaysOnProjects(1, { id: () => 'p1' }) // only this project holds the slot
    const gate = await billing.canEnableAlwaysOn(WS, 'p1')
    expect(gate.allowed).toBe(true)
    expect(gate.used).toBe(0)
  })
})
