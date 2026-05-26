#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-shot Rewardful → native MLM affiliate backfill.
 *
 * Reads a Rewardful CSV export (or JSON dump) and:
 *
 *   1. For each historical Rewardful affiliate, finds the matching
 *      Shogo user by email (case-insensitive) and creates an Affiliate
 *      row keyed on the user — preserving the public referral code so
 *      old links keep working. No parent chain is established because
 *      Rewardful is a flat one-level program; backfilled affiliates
 *      become L1 root nodes.
 *
 *   2. For each historical Rewardful conversion, finds the matching
 *      Shogo user by email and inserts an AffiliateAttribution row
 *      pointing them at the L1 affiliate (idempotent on user.userId).
 *      This stamps the lifetime attribution so future Stripe webhooks
 *      pay commissions to the old referrer.
 *
 * What we deliberately DO NOT backfill:
 *
 *   - Historical commissions / payouts. Rewardful already paid these.
 *     Re-counting them would double-charge the platform.
 *   - Clicks. Click history is not needed for attribution after the
 *     attribution row exists.
 *
 * Idempotent: re-runs only update if there is no existing row.
 *
 * Usage:
 *   bun scripts/backfill-rewardful-affiliates.ts \
 *     --affiliates ./rewardful-affiliates.csv \
 *     --conversions ./rewardful-conversions.csv \
 *     [--dry-run]
 *
 * The CSVs are the standard Rewardful exports — see
 * https://help.getrewardful.com/en/articles/csv-exports for the schema.
 * Required columns:
 *   affiliates.csv:   email, token (referral code), name?, status?
 *   conversions.csv:  customer_email, affiliate_token
 */

import { parseArgs } from 'node:util'
import { readFileSync, existsSync } from 'node:fs'
import { prisma } from '../apps/api/src/lib/prisma'

interface AffiliateRow {
  email: string
  code: string
  name?: string
  status?: string
}

interface ConversionRow {
  customerEmail: string
  affiliateToken: string
}

function parseCsv(path: string): Record<string, string>[] {
  if (!existsSync(path)) throw new Error(`CSV not found: ${path}`)
  const raw = readFileSync(path, 'utf8').trim()
  const lines = raw.split(/\r?\n/)
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]!).map((h) => h.trim())
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const cells = parseCsvLine(line)
    const row: Record<string, string> = {}
    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = (cells[c] ?? '').trim()
    }
    rows.push(row)
  }
  return rows
}

/** Minimal CSV parser that handles quoted commas (Rewardful's exports). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let buf = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { buf += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else buf += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { cells.push(buf); buf = '' }
      else buf += ch
    }
  }
  cells.push(buf)
  return cells
}

function normalizeCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'rewardful'
}

async function backfillAffiliates(rows: AffiliateRow[], dryRun: boolean) {
  let created = 0
  let skippedNoUser = 0
  let alreadyEnrolled = 0
  let codeRenamed = 0

  for (const row of rows) {
    if (!row.email || !row.code) continue
    const email = row.email.trim().toLowerCase()
    const user = await prisma.user.findFirst({ where: { email } })
    if (!user) { skippedNoUser++; continue }

    const existing = await prisma.affiliate.findUnique({ where: { userId: user.id } })
    if (existing) { alreadyEnrolled++; continue }

    let code = normalizeCode(row.code)
    // If the code is already taken by a different user, suffix it.
    const codeOwner = await prisma.affiliate.findUnique({ where: { code } })
    if (codeOwner && codeOwner.userId !== user.id) {
      code = `${code}-${user.id.slice(-6)}`.slice(0, 40)
      codeRenamed++
    }

    if (dryRun) { created++; continue }

    await prisma.affiliate.create({
      data: {
        userId: user.id,
        code,
        status: (row.status ?? 'active') === 'active' ? 'active' : 'paused',
        depth: 0,
        parentAffiliateId: null,
      } as any,
    })
    created++
  }
  return { created, skippedNoUser, alreadyEnrolled, codeRenamed }
}

async function backfillConversions(rows: ConversionRow[], dryRun: boolean) {
  let attributed = 0
  let alreadyAttributed = 0
  let noUser = 0
  let noAffiliate = 0

  for (const row of rows) {
    if (!row.customerEmail || !row.affiliateToken) continue
    const email = row.customerEmail.trim().toLowerCase()
    const code = normalizeCode(row.affiliateToken)
    const user = await prisma.user.findFirst({ where: { email } })
    if (!user) { noUser++; continue }
    const aff = await prisma.affiliate.findUnique({ where: { code } })
    if (!aff) { noAffiliate++; continue }
    if (aff.userId === user.id) continue // self-referral; skip

    const existing = await prisma.affiliateAttribution.findUnique({ where: { userId: user.id } })
    if (existing) { alreadyAttributed++; continue }

    if (!dryRun) {
      try {
        await prisma.affiliateAttribution.create({
          data: {
            userId: user.id,
            affiliateId: aff.id,
            source: 'rewardful_backfill',
          } as any,
        })
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err
      }
    }
    attributed++
  }
  return { attributed, alreadyAttributed, noUser, noAffiliate }
}

async function main() {
  const { values } = parseArgs({
    options: {
      affiliates: { type: 'string' },
      conversions: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const affPath = values.affiliates
  const convPath = values.conversions
  const dryRun = Boolean(values['dry-run'])

  if (!affPath && !convPath) {
    console.error('Usage: backfill-rewardful-affiliates --affiliates <csv> [--conversions <csv>] [--dry-run]')
    process.exit(2)
  }

  console.log(`[rewardful-backfill] dryRun=${dryRun}`)

  if (affPath) {
    const rows = parseCsv(affPath).map((r) => ({
      email: r['email'] ?? '',
      code: r['token'] ?? r['code'] ?? '',
      name: r['name'],
      status: r['status'],
    })) as AffiliateRow[]
    console.log(`[rewardful-backfill] read ${rows.length} affiliate rows from ${affPath}`)
    const summary = await backfillAffiliates(rows, dryRun)
    console.log(`[rewardful-backfill] affiliates`, summary)
  }

  if (convPath) {
    const rows = parseCsv(convPath).map((r) => ({
      customerEmail: r['customer_email'] ?? r['email'] ?? '',
      affiliateToken: r['affiliate_token'] ?? r['token'] ?? '',
    })) as ConversionRow[]
    console.log(`[rewardful-backfill] read ${rows.length} conversion rows from ${convPath}`)
    const summary = await backfillConversions(rows, dryRun)
    console.log(`[rewardful-backfill] attributions`, summary)
  }

  await prisma.$disconnect?.()
}

main().catch((err) => {
  console.error('[rewardful-backfill] FAILED', err)
  process.exit(1)
})
