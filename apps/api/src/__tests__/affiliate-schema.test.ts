// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Schema-shape sanity tests for the native MLM affiliate system.
 *
 * Unlike the SQLite-harness analytics tests these don't spin up a live
 * Prisma client (the desktop generator output is not available in CI
 * test envs). Instead they parse both schema files and assert the
 * invariants that the rest of the affiliate code relies on — unique
 * constraints, cross-schema parity, the seeded tier table, etc.
 *
 * If any of these break, every downstream affiliate.service.ts test
 * will start failing with confusing Prisma errors. Catching the drift
 * here surfaces a single readable failure instead.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const PG_SCHEMA = readFileSync(resolve(REPO_ROOT, 'prisma/schema.prisma'), 'utf-8')
const LOCAL_SCHEMA = readFileSync(resolve(REPO_ROOT, 'prisma/schema.local.prisma'), 'utf-8')
const PG_MIGRATION = readFileSync(
  resolve(REPO_ROOT, 'prisma/migrations/20260525000000_add_affiliate_system/migration.sql'),
  'utf-8',
)
const SQLITE_MIGRATION = readFileSync(
  resolve(REPO_ROOT, 'apps/desktop/prisma/migrations/20260525000000_add_affiliate_system/migration.sql'),
  'utf-8',
)

function modelBlock(src: string, name: string): string {
  const re = new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm')
  const m = re.exec(src)
  if (!m) throw new Error(`model ${name} not found`)
  return m[1]
}

describe('Affiliate schema (PG)', () => {
  test('declares all 6 affiliate models', () => {
    for (const name of [
      'Affiliate',
      'AffiliateClick',
      'AffiliateAttribution',
      'AffiliateCommission',
      'AffiliatePayout',
      'AffiliateCommissionTier',
    ]) {
      expect(PG_SCHEMA).toMatch(new RegExp(`model\\s+${name}\\s*\\{`))
    }
  })

  test('declares the three new enums', () => {
    expect(PG_SCHEMA).toMatch(/enum AffiliateStatus \{[\s\S]*?active[\s\S]*?suspended[\s\S]*?banned/)
    expect(PG_SCHEMA).toMatch(/enum CommissionStatus \{[\s\S]*?pending[\s\S]*?approved[\s\S]*?paid[\s\S]*?refunded[\s\S]*?clawed_back[\s\S]*?void/)
    expect(PG_SCHEMA).toMatch(/enum PayoutBatchStatus \{[\s\S]*?pending[\s\S]*?sent[\s\S]*?paid[\s\S]*?failed/)
  })

  test('Affiliate has unique userId, unique code, and a self-relation', () => {
    const block = modelBlock(PG_SCHEMA, 'Affiliate')
    expect(block).toMatch(/userId\s+String\s+@unique/)
    expect(block).toMatch(/code\s+String\s+@unique/)
    expect(block).toMatch(/parentAffiliateId\s+String\?/)
    expect(block).toMatch(/parent\s+Affiliate\?\s+@relation\("AffiliateUpline"/)
    expect(block).toMatch(/children\s+Affiliate\[\]\s+@relation\("AffiliateUpline"\)/)
    expect(block).toMatch(/depth\s+Int\s+@default\(1\)/)
  })

  test('Affiliate has the optional per-affiliate commissionRateBps override', () => {
    const block = modelBlock(PG_SCHEMA, 'Affiliate')
    expect(block).toMatch(/commissionRateBps\s+Int\?/)
  })

  test('AffiliateCommission has the (invoice, affiliate, level) idempotency key', () => {
    const block = modelBlock(PG_SCHEMA, 'AffiliateCommission')
    expect(block).toMatch(/@@unique\(\[stripeInvoiceId,\s*affiliateId,\s*level\]\)/)
    expect(block).toMatch(/@@index\(\[affiliateId,\s*status\]\)/)
    expect(block).toMatch(/@@index\(\[eligibleAt,\s*status\]\)/)
  })

  test('AffiliateClick has the visitor and affiliate time-series indexes', () => {
    const block = modelBlock(PG_SCHEMA, 'AffiliateClick')
    expect(block).toMatch(/@@index\(\[visitorId,\s*createdAt\]\)/)
    expect(block).toMatch(/@@index\(\[affiliateId,\s*createdAt\]\)/)
    expect(block).toMatch(/@@index\(\[expiresAt\]\)/)
  })

  test('AffiliateAttribution locks userId one-to-one', () => {
    const block = modelBlock(PG_SCHEMA, 'AffiliateAttribution')
    expect(block).toMatch(/userId\s+String\s+@unique/)
  })

  test('AffiliateCommissionTier has unique level', () => {
    const block = modelBlock(PG_SCHEMA, 'AffiliateCommissionTier')
    expect(block).toMatch(/level\s+Int\s+@unique/)
    expect(block).toMatch(/rateBps\s+Int/)
    expect(block).toMatch(/durationDays\s+Int\?/)
  })

  test('User has back-relations to Affiliate and AffiliateAttribution', () => {
    const block = modelBlock(PG_SCHEMA, 'User')
    expect(block).toMatch(/affiliate\s+Affiliate\?/)
    expect(block).toMatch(/affiliateAttribution\s+AffiliateAttribution\?/)
  })
})

describe('Affiliate schema (local SQLite mirror)', () => {
  test('mirrors all 6 models', () => {
    for (const name of [
      'Affiliate',
      'AffiliateClick',
      'AffiliateAttribution',
      'AffiliateCommission',
      'AffiliatePayout',
      'AffiliateCommissionTier',
    ]) {
      expect(LOCAL_SCHEMA).toMatch(new RegExp(`model\\s+${name}\\s*\\{`))
    }
  })

  test('uses String for enums (SQLite has no native enum)', () => {
    const affiliate = modelBlock(LOCAL_SCHEMA, 'Affiliate')
    expect(affiliate).toMatch(/status\s+String\s+@default\("active"\)/)
    expect(affiliate).toMatch(/payoutStatus\s+String\s+@default\("not_setup"\)/)

    const commission = modelBlock(LOCAL_SCHEMA, 'AffiliateCommission')
    expect(commission).toMatch(/status\s+String\s+@default\("pending"\)/)

    const payout = modelBlock(LOCAL_SCHEMA, 'AffiliatePayout')
    expect(payout).toMatch(/status\s+String\s+@default\("pending"\)/)
  })

  test('keeps the same idempotency unique constraint', () => {
    const block = modelBlock(LOCAL_SCHEMA, 'AffiliateCommission')
    expect(block).toMatch(/@@unique\(\[stripeInvoiceId,\s*affiliateId,\s*level\]\)/)
  })

  test('User has the same affiliate back-relations as PG', () => {
    const block = modelBlock(LOCAL_SCHEMA, 'User')
    expect(block).toMatch(/affiliate\s+Affiliate\?/)
    expect(block).toMatch(/affiliateAttribution\s+AffiliateAttribution\?/)
  })

  test('mirrors the per-affiliate commissionRateBps override column', () => {
    const block = modelBlock(LOCAL_SCHEMA, 'Affiliate')
    expect(block).toMatch(/commissionRateBps\s+Int\?/)
  })
})

describe('Affiliate migrations', () => {
  test('PG migration creates all 6 tables', () => {
    for (const t of [
      'affiliates',
      'affiliate_clicks',
      'affiliate_attributions',
      'affiliate_commissions',
      'affiliate_payouts',
      'affiliate_commission_tiers',
    ]) {
      expect(PG_MIGRATION).toMatch(new RegExp(`CREATE TABLE "${t}"`))
    }
  })

  test('PG migration creates the three new enum types', () => {
    expect(PG_MIGRATION).toMatch(/CREATE TYPE "AffiliateStatus"/)
    expect(PG_MIGRATION).toMatch(/CREATE TYPE "CommissionStatus"/)
    expect(PG_MIGRATION).toMatch(/CREATE TYPE "PayoutBatchStatus"/)
  })

  test('PG migration enforces the (invoice, affiliate, level) idempotency unique index', () => {
    expect(PG_MIGRATION).toMatch(
      /CREATE UNIQUE INDEX "affiliate_commissions_stripeInvoiceId_affiliateId_level_key"/,
    )
  })

  test('PG migration seeds default L1/L2/L3 tiers', () => {
    expect(PG_MIGRATION).toMatch(/INSERT INTO "affiliate_commission_tiers"/)
    expect(PG_MIGRATION).toMatch(/'aff_tier_l1', 1, 2000, 365/)
    expect(PG_MIGRATION).toMatch(/'aff_tier_l2', 2, 500/)
    expect(PG_MIGRATION).toMatch(/'aff_tier_l3', 3, 200/)
  })

  test('SQLite migration mirrors PG tables and seeds the same tier rows', () => {
    for (const t of [
      'affiliates',
      'affiliate_clicks',
      'affiliate_attributions',
      'affiliate_commissions',
      'affiliate_payouts',
      'affiliate_commission_tiers',
    ]) {
      expect(SQLITE_MIGRATION).toMatch(new RegExp(`CREATE TABLE "${t}"`))
    }
    expect(SQLITE_MIGRATION).toMatch(
      /CREATE UNIQUE INDEX "affiliate_commissions_stripeInvoiceId_affiliateId_level_key"/,
    )
    expect(SQLITE_MIGRATION).toMatch(/INSERT OR IGNORE INTO "affiliate_commission_tiers"/)
    expect(SQLITE_MIGRATION).toMatch(/'aff_tier_l1', 1, 2000/)
    expect(SQLITE_MIGRATION).toMatch(/'aff_tier_l3', 3, 200/)
  })

  test('per-affiliate rate migrations add the commissionRateBps column on both tracks', () => {
    const pg = readFileSync(
      resolve(REPO_ROOT, 'prisma/migrations/20260602203002_affiliate_per_affiliate_rate/migration.sql'),
      'utf-8',
    )
    const sqlite = readFileSync(
      resolve(REPO_ROOT, 'apps/desktop/prisma/migrations/20260602203002_affiliate_per_affiliate_rate/migration.sql'),
      'utf-8',
    )
    const addColumn = /ALTER TABLE "affiliates" ADD COLUMN "commissionRateBps" INTEGER;/
    expect(pg).toMatch(addColumn)
    expect(sqlite).toMatch(addColumn)
  })

  test('SQLite migration uses TEXT for the would-be enum columns', () => {
    // status / payoutStatus columns on affiliates, commissions, payouts.
    expect(SQLITE_MIGRATION).toMatch(/"status" TEXT NOT NULL DEFAULT 'active'/)
    expect(SQLITE_MIGRATION).toMatch(/"payoutStatus" TEXT NOT NULL DEFAULT 'not_setup'/)
    expect(SQLITE_MIGRATION).toMatch(/"status" TEXT NOT NULL DEFAULT 'pending'/)
  })
})

describe('Environment variable contract', () => {
  test('.env.example documents all affiliate env vars', () => {
    const env = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf-8')
    expect(env).toMatch(/SHOGO_AFFILIATES_NATIVE=false/)
    expect(env).toMatch(/SHOGO_AFFILIATE_MAX_DEPTH=3/)
    expect(env).toMatch(/SHOGO_AFFILIATE_REFUND_HOLD_DAYS=30/)
    expect(env).toMatch(/SHOGO_AFFILIATE_MIN_PAYOUT_CENTS=5000/)
    expect(env).toMatch(/SHOGO_AFFILIATE_COOKIE_DAYS=60/)
    expect(env).toMatch(/SHOGO_INTERNAL_SECRET=/)
  })

  test('.env.local.template documents the same set', () => {
    const env = readFileSync(resolve(REPO_ROOT, '.env.local.template'), 'utf-8')
    expect(env).toMatch(/SHOGO_AFFILIATES_NATIVE=false/)
    expect(env).toMatch(/SHOGO_AFFILIATE_MAX_DEPTH=3/)
    expect(env).toMatch(/SHOGO_INTERNAL_SECRET=/)
  })
})
