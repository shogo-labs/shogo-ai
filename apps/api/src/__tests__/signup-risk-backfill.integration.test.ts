// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for runSignupRiskBackfill (SHO-470).
 *
 * Verifies that the bounded, idempotent sweep:
 *   1. Finds users created within the 7-day window that have no assessment
 *      row and scores them (bare userId lookup — no User relation).
 *   2. Skips users that already have an assessment row (idempotent).
 *   3. Skips users older than the window.
 *   4. Respects the batchSize cap.
 *
 * Needs Postgres: CHANNELS_TEST_PG_URL=postgres://user:pass@localhost:5432/postgres
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const pgUrl = process.env.CHANNELS_TEST_PG_URL

let prisma: any
let runSignupRiskBackfill: typeof import('../services/signup-risk.service').runSignupRiskBackfill
let SIGNUP_RISK_BACKFILL_WINDOW_DAYS: number

if (pgUrl) {
  const dbName = `shogo_risk_backfill_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const setup = resolve(import.meta.dir, 'helpers/pg-test-db.ts')
  const run = (action: 'create' | 'drop') =>
    spawnSync(process.execPath, [setup, action, pgUrl, dbName], { encoding: 'utf-8' })
  const created = run('create')
  if (created.status !== 0) throw new Error(`pg setup failed: ${created.stderr || created.stdout}`)
  afterAll(async () => {
    await prisma?.$disconnect()
    run('drop')
  })
  const url = new URL(pgUrl)
  url.pathname = `/${dbName}`
  delete process.env.SHOGO_LOCAL_MODE
  process.env.SHOGO_APP_DATABASE_URL = url.toString()
  process.env.DATABASE_URL = url.toString()
  process.env.SHOGO_DATA_DIR = mkdtempSync(join(tmpdir(), 'shogo-risk-backfill-'))

  prisma = (await import('../lib/prisma')).prisma
  ;({ runSignupRiskBackfill, SIGNUP_RISK_BACKFILL_WINDOW_DAYS } = await import(
    '../services/signup-risk.service'
  ))

  // Shared now used to ensure users fall within the window.
  const now = new Date()
  const withinWindow = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
  const outsideWindow = new Date(now.getTime() - (SIGNUP_RISK_BACKFILL_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000)

  const makeUser = (email: string, createdAt: Date) =>
    prisma.user.create({
      data: { email, emailCanonical: email, name: email.split('@')[0], createdAt },
    })

  // Create test users.
  const unscored = await makeUser('unscored@example.com', withinWindow)
  const alreadyScored = await makeUser('scored@example.com', withinWindow)
  const tooOld = await makeUser('tooold@example.com', outsideWindow)

  // Pre-score alreadyScored.
  await prisma.signupRiskAssessment.create({
    data: {
      userId: alreadyScored.id,
      score: 10,
      band: 'low',
      signals: [],
      decision: 'allow',
      emailCanonical: 'scored@example.com',
    },
  })

  describe.skipIf(!pgUrl)('runSignupRiskBackfill — integration (postgres)', () => {
    test('scores users with no assessment row in the window', async () => {
      const count = await runSignupRiskBackfill({ now })
      // unscored should be scored; alreadyScored and tooOld should be skipped.
      expect(count).toBe(1)
      const assessment = await prisma.signupRiskAssessment.findUnique({
        where: { userId: unscored.id },
      })
      expect(assessment).not.toBeNull()
      expect(assessment.band).toMatch(/^(low|medium|high)$/)
    })

    test('idempotent — running again scores 0 more', async () => {
      const count = await runSignupRiskBackfill({ now })
      expect(count).toBe(0)
    })

    test('already-scored user is skipped (uses bare userId lookup, not User relation)', async () => {
      // alreadyScored had a row before the sweep; it must still have only one.
      const rows = await prisma.signupRiskAssessment.findMany({
        where: { userId: alreadyScored.id },
      })
      expect(rows).toHaveLength(1)
    })

    test('user older than window is not scored', async () => {
      const row = await prisma.signupRiskAssessment.findUnique({
        where: { userId: tooOld.id },
      })
      expect(row).toBeNull()
    })

    test('batchSize cap is respected', async () => {
      // Create 5 extra unscored users, then run with batchSize=2.
      const extras = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          makeUser(`extra${i}@example.com`, new Date(now.getTime() - i * 1000)),
        ),
      )
      const count = await runSignupRiskBackfill({ now, batchSize: 2 })
      // At most 2 can be scored in one run.
      expect(count).toBeLessThanOrEqual(2)
      // Clean up.
      for (const u of extras) {
        await prisma.signupRiskAssessment.deleteMany({ where: { userId: u.id } })
        await prisma.user.delete({ where: { id: u.id } })
      }
    })
  })
}

// Guard: when pgUrl is absent the whole describe block is skipped — ensure
// this file never fails without Postgres being configured.
if (!pgUrl) {
  describe('runSignupRiskBackfill — integration (postgres)', () => {
    test.skip('skipped: set CHANNELS_TEST_PG_URL to run', () => {})
  })
}
