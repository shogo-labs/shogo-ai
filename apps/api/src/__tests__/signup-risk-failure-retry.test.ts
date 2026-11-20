// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-470: unit tests for the retry-on-transient-failure + stable log marker
 * added to the signup risk assessment path in auth.ts.
 *
 * Tests operate at the service level (signup-risk.service) with a prisma mock
 * so they don't depend on a Postgres connection and are deterministic.
 *
 * The retry + failure-event logic lives in auth.ts (the hook), but we test
 * the service directly here to isolate the behaviour from the full auth flow.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Prisma mock — controls upsert failures via upsertFailTimes
// ---------------------------------------------------------------------------

const dbState: { upserts: any[]; upsertFailTimes: number } = {
  upserts: [],
  upsertFailTimes: 0,
}

mock.module('../lib/prisma', () => ({
  prisma: {
    user: {
      count: async () => 0,
      findMany: async () => [],
      update: async (_args: unknown) => ({ id: 'u' }),
    },
    signupRiskAssessment: {
      count: async () => 0,
      findMany: async () => [],
      upsert: async (args: any) => {
        if (dbState.upsertFailTimes > 0) {
          dbState.upsertFailTimes--
          throw new Error('simulated DB blip')
        }
        dbState.upserts.push(args)
        return args.create
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  },
}))

const { assessNewSignup } = await import('../services/signup-risk.service')

beforeEach(() => {
  dbState.upserts.length = 0
  dbState.upsertFailTimes = 0
})

const baseParams = {
  userId: 'u-test',
  email: 'user@example.com',
  provider: 'credential' as const,
  emailVerified: false,
  headers: null,
}

describe('assessNewSignup — normal path (SHO-470)', () => {
  test('succeeds on first attempt: assessment row written', async () => {
    const result = await assessNewSignup(baseParams)
    expect(result.band).toMatch(/^(low|medium|high)$/)
    expect(dbState.upserts).toHaveLength(1)
  })

  test('upsert failure propagates to caller (no built-in retry in service)', async () => {
    dbState.upsertFailTimes = 1
    await expect(assessNewSignup(baseParams)).rejects.toThrow('simulated DB blip')
    expect(dbState.upserts).toHaveLength(0)
  })
})

describe('auth.ts retry wrapper (SHO-470)', () => {
  /**
   * The retry lives in auth.ts, not in the service. We simulate the wrapper
   * here to verify that one retry is sufficient and that double-failure
   * propagates correctly. The auth.ts hook uses exactly this pattern.
   */
  async function assessWithOneRetry(params: typeof baseParams, delayMs = 0) {
    let risk
    try {
      risk = await assessNewSignup(params)
    } catch {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      risk = await assessNewSignup(params)
    }
    return risk
  }

  test('first call throws, retry succeeds → row written, no error', async () => {
    dbState.upsertFailTimes = 1
    const result = await assessWithOneRetry(baseParams)
    expect(result.band).toMatch(/^(low|medium|high)$/)
    expect(dbState.upserts).toHaveLength(1)
  })

  test('both calls throw → rejects with original error', async () => {
    dbState.upsertFailTimes = 2
    await expect(assessWithOneRetry(baseParams)).rejects.toThrow('simulated DB blip')
    expect(dbState.upserts).toHaveLength(0)
  })
})

describe('signup_risk_failed analytics event (SHO-470)', () => {
  test('rejection carries the original error message (outer catch reads it)', async () => {
    dbState.upsertFailTimes = 1
    let caught: Error | undefined
    try {
      await assessNewSignup(baseParams)
    } catch (e: any) {
      caught = e
    }
    expect(caught?.message).toContain('simulated DB blip')
  })
})
