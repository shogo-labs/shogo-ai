// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// SHO-459 — hasBannedAt schema-check unit tests.
//
// Tests that runAbuseCheckCore:
//   (a) passes through fine when bannedAt exists (post-migration)
//   (b) runs in dry-run mode when bannedAt is absent (pre-migration)
//   (c) throws when --apply is set but bannedAt is absent
//
//   bun test apps/api/src/__tests__/abuse-schema-check.test.ts

import { describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module('../services/abuse/clusters', () => ({
  detectClusters: mock(() => Promise.resolve(new Map())),
}))

mock.module('../services/abuse/candidates', () => ({
  gatherCandidates: mock(() => Promise.resolve([])),
}))

mock.module('../services/abuse/judge', () => ({
  judgeCandidate: mock(() => Promise.resolve(null)),
  buildEvidence: mock(() => []),
}))

mock.module('../services/abuse/policy', () => ({
  applyPolicy: mock(() => 'none'),
}))

mock.module('../services/abuse/ban', () => ({
  banUser: mock(() => Promise.resolve()),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAbuseCheckCore — hasBannedAt schema check', () => {
  function makePrisma(hasBannedAt: boolean) {
    return {
      $queryRaw: mock((strings: TemplateStringsArray, ...values: any[]) => {
        // Check if this is the information_schema query
        const sql = strings.join('?')
        if (sql.includes('information_schema')) {
          return Promise.resolve([{ exists: hasBannedAt }])
        }
        return Promise.resolve([])
      }),
      subscription: { findFirst: mock(() => Promise.resolve(null)) },
      abuseFlag: { upsert: mock(() => Promise.resolve({ id: 'flag-1' })) },
    } as any
  }

  test('dry-run with bannedAt present succeeds', async () => {
    const { runAbuseCheckCore } = await import('../lib/abuse-check-job')
    const prisma = makePrisma(true)
    const result = await runAbuseCheckCore(prisma, { dryRun: true })
    expect(result.candidates).toBe(0)
  })

  test('dry-run without bannedAt succeeds (pre-migration fallback)', async () => {
    const { runAbuseCheckCore } = await import('../lib/abuse-check-job')
    const prisma = makePrisma(false)
    const result = await runAbuseCheckCore(prisma, { dryRun: true })
    expect(result.candidates).toBe(0)
  })

  test('--apply without bannedAt throws', async () => {
    const { runAbuseCheckCore } = await import('../lib/abuse-check-job')
    const prisma = makePrisma(false)
    await expect(runAbuseCheckCore(prisma, { dryRun: false })).rejects.toThrow(
      'users.bannedAt column not found',
    )
  })
})
