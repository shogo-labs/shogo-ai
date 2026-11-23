// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * collectSignupRiskFeatures' banned-linked-account count, run against the real
 * cloud schema. SignupRiskAssessment has no relation to User, so a relation
 * filter there throws PrismaClientValidationError on every request carrying an
 * IP or device id. That 500'd GET /api/billing/workspace-plan (trial
 * eligibility) for every workspace without a Subscription row, so grant-backed
 * workspaces showed every model but the economy one as locked.
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
let collectSignupRiskFeatures: typeof import('../services/signup-risk.service').collectSignupRiskFeatures

if (pgUrl) {
  const dbName = `shogo_signup_risk_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
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
  process.env.SHOGO_DATA_DIR = mkdtempSync(join(tmpdir(), 'shogo-signup-risk-'))

  prisma = (await import('../lib/prisma')).prisma
  collectSignupRiskFeatures = (await import('../services/signup-risk.service')).collectSignupRiskFeatures

  const banned = await prisma.user.create({
    data: { email: 'banned@example.com', emailCanonical: 'banned@example.com', name: 'Banned', bannedAt: new Date() },
  })
  const clean = await prisma.user.create({
    data: { email: 'clean@example.com', emailCanonical: 'clean@example.com', name: 'Clean' },
  })
  const assess = (userId: string, ipPrefix: string, deviceId: string, emailCanonical: string) =>
    prisma.signupRiskAssessment.create({
      data: { userId, score: 0, band: 'low', signals: [], decision: 'allow', ipPrefix, deviceId, emailCanonical },
    })
  await assess(banned.id, '203.0.113.9', 'device-banned', 'banned@example.com')
  await assess(clean.id, '198.51.100.7', 'device-clean', 'clean@example.com')
}

const features = (ipPrefix: string | null, deviceId: string | null, email = 'new@example.com') =>
  collectSignupRiskFeatures({
    userId: crypto.randomUUID(),
    email,
    provider: 'credential',
    emailVerified: true,
    request: { ip: ipPrefix, ipPrefix, country: null, deviceId, e2eAllowlisted: false },
  })

describe.skipIf(!pgUrl)('collectSignupRiskFeatures — banned linked accounts (postgres)', () => {
  test('a request carrying an IP and a device id does not throw', async () => {
    expect((await features('198.51.100.7', 'device-other')).bannedLinkedAccounts).toBe(0)
  })

  test('shares an IP prefix with a banned account → counted', async () => {
    expect((await features('203.0.113.9', null)).bannedLinkedAccounts).toBe(1)
  })

  test('shares a device id with a banned account → counted', async () => {
    expect((await features(null, 'device-banned')).bannedLinkedAccounts).toBe(1)
  })

  test('shares only the canonical email with a banned account → counted', async () => {
    expect((await features(null, null, 'banned@example.com')).bannedLinkedAccounts).toBe(1)
  })

  test('linked only to a clean account → not counted', async () => {
    expect((await features('198.51.100.7', 'device-clean')).bannedLinkedAccounts).toBe(0)
  })
})
