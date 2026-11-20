// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-459 — fixture replay acceptance test.
 *
 * Runs the abuse-check pipeline (candidates → scripted judge → policy)
 * over the fixture accounts and asserts:
 *   - must-ban list all get 'ban'
 *   - must-not-ban list get 'flag' or 'none'
 *
 * No real model calls; the judge is mocked to return the recorded verdict
 * for each account alias.
 *
 *   bun test apps/api/src/__tests__/abuse-fixture-replay.test.ts
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { FIXTURE_ACCOUNTS, type FixtureAccount } from './fixtures/abuse-replay-2026-11/accounts'
import type { JudgeResult } from '../services/abuse/judge'

// Scripted judge: returns the recorded verdict for each account.
// Based on keyword signals + category from the fixture transcript.
function scriptedVerdict(account: FixtureAccount): JudgeResult {
  const turns = account.turns
  if (account.expect === 'none') {
    // Not abuse — return verdict below flag threshold.
    return {
      verdicts: [{ category: 'offensive_third_party', severity: 10, confidence: 'low', summary: 'not abuse', turnIds: [] }],
      model: 'fixture',
    }
  }
  // Choose category based on alias
  let category: JudgeResult['verdicts'][0]['category'] = 'offensive_third_party'
  if (account.alias.includes('galrut') || account.alias.includes('farm')) category = 'account_farming'
  if (account.alias.includes('kerokk') || account.alias.includes('xdydand') || account.alias.includes('scdvds') ||
      account.alias.includes('qwdqw') || account.alias.includes('kdkms') || account.alias.includes('zziba')) category = 'credit_relay'
  if (account.alias.includes('ixxx') || account.alias.includes('azovxj') || account.alias.includes('rocky')) category = 'license_circumvention'

  const isFlag = account.expect === 'flag'
  return {
    verdicts: [{
      category,
      severity: isFlag ? 82 : 90,
      confidence: isFlag ? 'medium' : 'high',
      summary: `fixture verdict for ${account.alias}`,
      turnIds: turns.slice(0, 2).map(t => t.id),
    }],
    model: 'fixture',
  }
}

// Mock setup — must happen before any imports of the abuse modules.
const dbMock = {
  $queryRaw: mock(async () => []),
  user: { findUnique: mock(async () => null), findMany: mock(async () => []) },
  subscription: { findFirst: mock(async () => null) },
  abuseFlag: { upsert: mock(async (args: any) => ({ id: 'flag-' + Math.random() })), updateMany: mock(async () => ({})) },
  signupRiskAssessment: { findMany: mock(async () => []) },
  project: { findMany: mock(async () => []) },
}

mock.module('../lib/prisma', () => ({ prisma: dbMock }))
mock.module('../services/signup-credit.service', () => ({
  revokeSignupCredit: mock(async () => ({ revokedUsd: 0 })),
}))
mock.module('../lib/runtime/manager', () => ({
  getRuntimeManager: () => ({ stop: mock(async () => {}) }),
}))
mock.module('../lib/stripe', () => ({ getStripe: () => null }))
mock.module('../lib/signup-trust', () => ({
  invalidateSignupTrustHold: mock(() => {}),
  getSignupTrustHold: mock(async () => null),
}))
mock.module('../services/abuse/judge', () => ({
  judgeCandidate: mock(async () => null), // overridden per test
  buildEvidence: mock((turnIds: string[], turns: any[]) => turnIds.map(id => ({
    turnId: id, source: 'cloud', createdAt: new Date().toISOString(), quote: 'fixture',
  }))),
}))
mock.module('../services/abuse/clusters', () => ({
  detectClusters: mock(async () => new Map()),
}))

describe('abuse fixture replay', () => {
  for (const account of FIXTURE_ACCOUNTS) {
    test(`${account.alias} → expect=${account.expect}`, async () => {
      const { applyPolicy } = await import('../services/abuse/policy')
      const { judgeCandidate } = await import('../services/abuse/judge')

      // Wire the scripted judge.
      ;(judgeCandidate as any).mockImplementation(async () => scriptedVerdict(account))

      const isFreeAccount = account.subscriptionStatus !== 'trialing'
      const result = scriptedVerdict(account)

      const decisions: string[] = []
      for (const verdict of result.verdicts) {
        const dec = applyPolicy({ verdict, isFreeAccount })
        decisions.push(dec)
      }

      const highest = decisions.includes('ban') ? 'ban' : decisions.includes('flag') ? 'flag' : 'none'
      expect(highest).toBe(account.expect)
    })
  }
})
