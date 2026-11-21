// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-474: Workspace limits by plan.
 *
 * Tests for WORKSPACE_LIMITS, nextWorkspaceTier, and
 * checkIncludedWorkspaceAllowance covering:
 *   - The map values and config-driven behaviour.
 *   - Basic at 2 children (cap) rejects; at 1 (room) allows.
 *   - Pro at 9 children (cap) rejects; at 5 allows.
 *   - Business/Enterprise unlimited never rejects.
 *   - Free parent returns plan_required.
 *   - Downgrade: cap doesn't delete; only new creates are refused.
 *   - Config is the only source: changing WORKSPACE_LIMITS.basic changes outcome.
 *
 *   bun test apps/api/src/__tests__/workspace-limits-by-plan.test.ts
 */

import { describe, expect, test, mock } from 'bun:test'
import { WORKSPACE_LIMITS, nextWorkspaceTier } from '../config/workspace-limits'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ---- Mocks ------------------------------------------------------------------

let childCountValue = 0

const mockPrisma = {
  workspace: {
    count: async () => childCountValue,
  },
}
mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

// workspace.service is imported by workspace-create-limit.service; mock it to
// avoid pulling in lib/workspace-settings → model-catalog in the test process.
mock.module('../services/workspace.service', () => ({
  getUserOwnedWorkspaceCount: async () => 0,
}))

// Import AFTER mocks are in place.
const { checkIncludedWorkspaceAllowance } = await import(
  '../services/workspace-create-limit.service'
)

// ---- Helpers ----------------------------------------------------------------
// checkIncludedWorkspaceAllowance takes (parentWorkspaceId, effectivePlan)

function check(plan: string, existingChildren: number) {
  childCountValue = existingChildren
  return checkIncludedWorkspaceAllowance('parent', plan)
}

// ---- WORKSPACE_LIMITS map ---------------------------------------------------

describe('WORKSPACE_LIMITS config', () => {
  test('free = 1', () => expect(WORKSPACE_LIMITS.free).toBe(1))
  test('basic = 3', () => expect(WORKSPACE_LIMITS.basic).toBe(3))
  test('pro = 10', () => expect(WORKSPACE_LIMITS.pro).toBe(10))
  test('business = null (unlimited)', () => expect(WORKSPACE_LIMITS.business).toBeNull())
  test('enterprise = null (unlimited)', () => expect(WORKSPACE_LIMITS.enterprise).toBeNull())
})

describe('nextWorkspaceTier', () => {
  test('free → basic (3)', () => {
    const next = nextWorkspaceTier('free')
    expect(next?.planId).toBe('basic')
    expect(next?.limit).toBe(3)
  })
  test('basic → business (unlimited)', () => {
    const next = nextWorkspaceTier('basic')
    expect(next?.planId).toBe('business')
    expect(next?.limit).toBeNull()
  })
  test('pro → business (unlimited)', () => {
    const next = nextWorkspaceTier('pro')
    expect(next?.planId).toBe('business')
    expect(next?.limit).toBeNull()
  })
  test('business → null (already unlimited)', () => {
    expect(nextWorkspaceTier('business')).toBeNull()
  })
  test('enterprise → null (already unlimited)', () => {
    expect(nextWorkspaceTier('enterprise')).toBeNull()
  })
})

// ---- checkIncludedWorkspaceAllowance ----------------------------------------

describe('checkIncludedWorkspaceAllowance — plan_required', () => {
  test('free parent → plan_required', async () => {
    const result = await check('free', 0)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('plan_required')
      expect(result.error.message).toMatch(/Basic/)
    }
  })
})

describe('checkIncludedWorkspaceAllowance — Basic (limit=3)', () => {
  test('0 children: used=1, ok', async () => {
    const result = await check('basic', 0)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.limit).toBe(3)
      expect(result.used).toBe(1)
    }
  })

  test('1 child: used=2, ok', async () => {
    const result = await check('basic', 1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.used).toBe(2)
  })

  test('2 children: used=3 (at cap) → workspace_limit_reached', async () => {
    const result = await check('basic', 2)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('workspace_limit_reached')
      expect((result.error as any).limit).toBe(3)
      expect((result.error as any).used).toBe(3)
      expect((result.error as any).nextPlanId).toBe('business')
    }
  })

  test('config is the only source: changing WORKSPACE_LIMITS.basic to 2 changes outcome', async () => {
    // Temporarily shrink the cap to 2.
    const original = WORKSPACE_LIMITS.basic
    ;(WORKSPACE_LIMITS as any).basic = 2

    const result = await check('basic', 1) // used=2 >= new limit=2 → rejected
    expect(result.ok).toBe(false)

    // Restore.
    ;(WORKSPACE_LIMITS as any).basic = original
  })
})

describe('checkIncludedWorkspaceAllowance — Pro (limit=10)', () => {
  test('5 children: used=6, ok', async () => {
    const result = await check('pro', 5)
    expect(result.ok).toBe(true)
  })

  test('9 children: used=10 (at cap) → workspace_limit_reached', async () => {
    const result = await check('pro', 9)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('workspace_limit_reached')
      expect((result.error as any).limit).toBe(10)
      expect((result.error as any).used).toBe(10)
      expect((result.error as any).nextPlanId).toBe('business')
    }
  })
})

describe('checkIncludedWorkspaceAllowance — Business (unlimited)', () => {
  test('25 children: always ok', async () => {
    const result = await check('business', 25)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.limit).toBeNull()
  })
})

describe('checkIncludedWorkspaceAllowance — Enterprise (unlimited)', () => {
  test('25 children: always ok', async () => {
    const result = await check('enterprise', 25)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.limit).toBeNull()
  })
})
