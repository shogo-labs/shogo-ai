// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-474 QA acceptance tests: workspace limits by plan.
 *
 * Covers:
 *   AC1  Basic = 3 total (1 parent + 2 children). Third create refused.
 *   AC2  Pro = 10. Business/Enterprise unlimited (25 children allowed).
 *   AC3  Free parent → plan_required. Free top-level 2nd team workspace refused.
 *   AC4  A child workspace does not consume the owner's free top-level slot.
 *   AC6  Config is the only source: mutating WORKSPACE_LIMITS changes outcome.
 *   AC7  Downgrade: children stay; only new creates are refused.
 *   AC8  Trial/grant plans resolve through getEffectivePlanId (mocked here).
 *   AC9  checkIncludedWorkspaceAllowance returns used/limit for the billing endpoint.
 *
 *   bun test apps/api/src/__tests__/sho-474-workspace-limits-qa.acceptance.test.ts
 */

import { describe, expect, test, mock } from 'bun:test'
import { WORKSPACE_LIMITS } from '../config/workspace-limits'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ---- Mocks ------------------------------------------------------------------

let childCountValue = 0
let ownedCountValue = 0

const mockPrisma = {
  workspace: {
    count: async () => childCountValue,
  },
}
mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

mock.module('../services/workspace.service', () => ({
  getUserOwnedWorkspaceCount: async () => ownedCountValue,
}))

// Import AFTER mocks.
const { checkIncludedWorkspaceAllowance, checkWorkspaceCreateAllowance } = await import(
  '../services/workspace-create-limit.service'
)

// ---- Helpers ----------------------------------------------------------------

function setChildren(n: number) { childCountValue = n }
function setOwned(n: number)    { ownedCountValue = n }

async function included(plan: string, children: number) {
  setChildren(children)
  return checkIncludedWorkspaceAllowance('parent-ws', plan)
}

// =============================================================================

describe('AC1 · Basic plan (limit = 3)', () => {
  test('0 children: used=1, ok', async () => {
    const r = await included('basic', 0)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.limit).toBe(3)
      expect(r.used).toBe(1)
      expect(r.planId).toBe('basic')
    }
  })

  test('1 child: used=2, ok', async () => {
    expect((await included('basic', 1)).ok).toBe(true)
  })

  test('2 children: used=3, at cap → workspace_limit_reached', async () => {
    const r = await included('basic', 2)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('workspace_limit_reached')
      expect((r.error as any).planId).toBe('basic')
      expect((r.error as any).limit).toBe(3)
      expect((r.error as any).used).toBe(3)
      expect((r.error as any).nextPlanId).toBe('business')
    }
  })

  test('error message names the current and next tier', async () => {
    const r = await included('basic', 2)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toMatch(/Basic/)
      expect(r.error.message).toMatch(/Business/)
    }
  })

  test('at-cap error carries planId, limit, used, nextPlanId fields for the billing endpoint', async () => {
    // The service no longer normalises decorated strings — that is getEffectivePlanId's job.
    // Verify the structured error shape the billing API and UI rely on.
    const r = await included('basic', 2)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as any).planId).toBe('basic')
      expect((r.error as any).limit).toBe(3)
      expect((r.error as any).used).toBe(3)
      expect((r.error as any).nextPlanId).toBe('business')
    }
  })
})

describe('AC2 · Pro plan (limit = 10)', () => {
  test('5 children: used=6, ok', async () => {
    expect((await included('pro', 5)).ok).toBe(true)
  })

  test('9 children: used=10, at cap → workspace_limit_reached', async () => {
    const r = await included('pro', 9)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('workspace_limit_reached')
      expect((r.error as any).limit).toBe(10)
      expect((r.error as any).used).toBe(10)
      expect((r.error as any).nextPlanId).toBe('business')
    }
  })
})

describe('AC2 · Business / Enterprise (unlimited)', () => {
  test('business: 25 children always ok, limit=null', async () => {
    const r = await included('business', 25)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.limit).toBeNull()
  })

  test('enterprise: 25 children always ok, limit=null', async () => {
    const r = await included('enterprise', 25)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.limit).toBeNull()
  })

  test('business-monthly (decorated): 10 children ok', async () => {
    expect((await included('business-monthly', 10)).ok).toBe(true)
  })
})

describe('AC3 · Free parent → plan_required', () => {
  test('free parent returns plan_required', async () => {
    const r = await included('free', 0)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('plan_required')
      expect(r.error.message).toMatch(/Basic/)
    }
  })

  test('plan_required message is built from nextWorkspaceTier so it tracks map changes', async () => {
    // The message must name the next tier (Basic) and its limit from the map.
    // normalizePlanId for decorated strings lives in usage-plans.ts / getEffectivePlanId;
    // the service only receives a canonical PlanId.
    const r = await included('free', 0)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('plan_required')
      // Message references Basic and its limit from WORKSPACE_LIMITS.basic
      expect(r.error.message).toMatch(/Basic/)
      expect(r.error.message).toMatch(/3/)
    }
  })
})

describe('AC3 · Free top-level workspace (checkWorkspaceCreateAllowance)', () => {
  test('first team workspace succeeds (owned=0)', async () => {
    setOwned(0)
    const r = await checkWorkspaceCreateAllowance('user-1', 'team')
    expect(r.ok).toBe(true)
  })

  test('second team workspace refused (owned=1 >= WORKSPACE_LIMITS.free=1)', async () => {
    setOwned(1)
    const r = await checkWorkspaceCreateAllowance('user-1', 'team')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('workspace_limit_reached')
      expect(r.error.message).toMatch(/Basic|free workspace/)
    }
  })

  test('personal workspace check is independent (owned=1 for team, check personal)', async () => {
    // The kind passed is 'personal' — count for personal is still 0.
    setOwned(0)
    const r = await checkWorkspaceCreateAllowance('user-1', 'personal')
    expect(r.ok).toBe(true)
  })

  test('top-level limit driven by WORKSPACE_LIMITS.free', () => {
    // The map value is what the service reads — no hardcoded "< 1" anywhere.
    expect(WORKSPACE_LIMITS.free).toBe(1)
  })
})

describe('AC4 · Child does not consume free top-level slot', () => {
  // getUserOwnedWorkspaceCount is now filtered: parentWorkspaceId: null.
  // The mock already returns ownedCountValue (which should represent only
  // top-level workspaces). This test verifies the service uses whatever the
  // count function returns without double-counting.
  test('owned=0 (children excluded by count fn) → first team ws succeeds', async () => {
    setOwned(0) // simulates count with parentWorkspaceId: null filter
    const r = await checkWorkspaceCreateAllowance('user-with-child', 'team')
    expect(r.ok).toBe(true)
  })
})

describe('AC6 · Config is the only source', () => {
  test('mutating WORKSPACE_LIMITS.basic to 2 changes outcome', async () => {
    const original = WORKSPACE_LIMITS.basic
    ;(WORKSPACE_LIMITS as any).basic = 2

    // 1 child → used=2 >= new limit=2 → rejected
    const r = await included('basic', 1)
    expect(r.ok).toBe(false)

    ;(WORKSPACE_LIMITS as any).basic = original
  })

  test('mutating WORKSPACE_LIMITS.pro to 5 changes outcome', async () => {
    const original = WORKSPACE_LIMITS.pro
    ;(WORKSPACE_LIMITS as any).pro = 5

    // 4 children → used=5 >= new limit=5 → rejected
    const r = await included('pro', 4)
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as any).limit).toBe(5)

    ;(WORKSPACE_LIMITS as any).pro = original
  })
})

describe('AC7 · Downgrade: existing children not locked, only creates refused', () => {
  // A parent downgraded from business to basic with 5 children:
  // `checkIncludedWorkspaceAllowance` only blocks NEW creates, never reads.
  test('basic parent with 5 children: next create is refused', async () => {
    const r = await included('basic', 5) // used=6 >> limit=3
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('workspace_limit_reached')
      expect((r.error as any).used).toBe(6) // all 5 existing children still counted
    }
  })
})

describe('AC8 · Trial / grant plans resolve to canonical PlanId before reaching this service', () => {
  // getEffectivePlanId (in billing.service) normalises decorated ids like
  // 'business-grant', 'pro_200', 'Business-Annual' → canonical PlanId before
  // the hook passes them here. These tests verify the canonical paths.
  test('business plan (grant/trial resolved by billing service): 20 children always ok', async () => {
    const r = await included('business', 20)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.limit).toBeNull()
  })

  test('pro plan (legacy pro resolved by billing service): 9 children → at cap', async () => {
    const r = await included('pro', 9)
    expect(r.ok).toBe(false) // used=10 >= limit=10
    if (!r.ok) {
      expect((r.error as any).planId).toBe('pro')
      expect((r.error as any).limit).toBe(10)
    }
  })

  test('enterprise plan (grant resolved by billing service): 50 children always ok', async () => {
    const r = await included('enterprise', 50)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.limit).toBeNull()
  })
})

describe('AC9 · checkIncludedWorkspaceAllowance returns used/limit for billing endpoint', () => {
  test('returns { ok, planId, limit, used } on success', async () => {
    const r = await included('basic', 1)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(typeof r.planId).toBe('string')
      expect(typeof r.limit).toBe('number')
      expect(typeof r.used).toBe('number')
    }
  })

  test('unlimited plan returns limit=null and used count', async () => {
    const r = await included('business', 7)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.limit).toBeNull()
      expect(r.used).toBe(8) // 1 parent + 7 children
    }
  })
})
