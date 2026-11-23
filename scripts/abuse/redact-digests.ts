#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off: redact secrets already stored in analytics_digests.aiInsights.
 *
 * SHO-459: digests saved before this release may contain plaintext user keys
 * in their securityFlags strings. This script redacts them in-place.
 *
 * Usage:
 *   bun scripts/abuse/redact-digests.ts                 # dry run (print counts only)
 *   bun scripts/abuse/redact-digests.ts --apply         # write to database
 *   DATABASE_URL="postgresql://..." bun scripts/abuse/redact-digests.ts --apply
 */

import { PrismaClient } from '../../apps/api/src/generated/prisma-pg'
import { redactSecrets } from '../../apps/api/src/lib/redact-secrets'

const apply = process.argv.includes('--apply')

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
})

async function main() {
  console.log(`[redact-digests] mode=${apply ? 'APPLY' : 'DRY RUN'}`)

  const digests = await (prisma as any).analyticsDigest.findMany({
    where: { aiInsights: { not: null } },
    select: { id: true, aiInsights: true, date: true },
    orderBy: { date: 'desc' },
  })

  console.log(`[redact-digests] Found ${digests.length} digests with aiInsights`)

  let changed = 0
  for (const d of digests) {
    const original = JSON.stringify(d.aiInsights)
    const redacted = redactSecrets(original)
    if (redacted === original) continue

    changed++
    console.log(`  ${d.date.toISOString().split('T')[0]} (${d.id.slice(0, 8)}…) — secrets found`)
    if (apply) {
      await (prisma as any).analyticsDigest.update({
        where: { id: d.id },
        data: { aiInsights: JSON.parse(redacted) },
      })
    }
  }

  console.log(
    apply
      ? `[redact-digests] Updated ${changed}/${digests.length} digests.`
      : `[redact-digests] Would update ${changed}/${digests.length} digests. Pass --apply to write.`,
  )
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
