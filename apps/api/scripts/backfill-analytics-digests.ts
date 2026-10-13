// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regenerate missing daily AI Insights digests (`analytics_digests`).
 *
 * Each date is generated as the scheduled run would have produced it at
 * `ANALYTICS_DIGEST_HOUR` UTC (default 08:00) on that day — see the `asOf`
 * option on `generateDigest`. Dates that already have a row for this region
 * are skipped. Each generated date makes real model calls.
 *
 * Run from an API pod in the main region (`REGION_ID=us-ashburn-1`):
 *
 *   bun scripts/backfill-analytics-digests.ts --from 2026-09-30 --to 2026-10-12
 *   ... --apply   # generate and write the digests
 */
import { parseArgs } from 'node:util'
import { prisma } from '../src/lib/prisma'
import { generateDigest } from '../src/lib/analytics-digest-collector'

const DIGEST_HOUR = parseInt(process.env.ANALYTICS_DIGEST_HOUR || '8', 10)
const DAY_MS = 24 * 60 * 60 * 1000

export function backfillDates(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error('--from and --to must be YYYY-MM-DD dates')
  }
  if (start > end) throw new Error('--from must be on or before --to')
  const dates: string[] = []
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    dates.push(new Date(t).toISOString().slice(0, 10))
  }
  return dates
}

export function digestRunTime(date: string): Date {
  const runAt = new Date(`${date}T00:00:00.000Z`)
  runAt.setUTCHours(DIGEST_HOUR, 0, 0, 0)
  return runAt
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  })
  if (!values.from || !values.to) {
    throw new Error('Usage: bun scripts/backfill-analytics-digests.ts --from YYYY-MM-DD --to YYYY-MM-DD [--apply]')
  }

  const region = process.env.REGION_ID || 'unknown'
  const dates = backfillDates(values.from, values.to)
  const existing = await prisma.analyticsDigest.findMany({
    where: {
      period: '24h',
      region,
      date: { gte: new Date(`${dates[0]}T00:00:00.000Z`), lte: new Date(`${dates[dates.length - 1]}T00:00:00.000Z`) },
    },
    select: { date: true },
  })
  const have = new Set(existing.map((d) => d.date.toISOString().slice(0, 10)))
  const missing = dates.filter((d) => !have.has(d) && digestRunTime(d) <= new Date())

  console.log(`[backfill-digests] region=${region} requested=${dates.length} existing=${have.size} to-generate=${missing.length}`)
  console.log(`[backfill-digests] dates: ${missing.join(', ') || '(none)'}`)
  if (!values.apply) {
    console.log('[backfill-digests] dry run — re-run with --apply to generate these digests.')
    return
  }

  for (const date of missing) {
    const digest = await generateDigest(prisma, { asOf: digestRunTime(date) })
    console.log(`[backfill-digests] ${date} saved ${digest.id}`)
  }
}

if (import.meta.main) {
  main()
    .catch((err) => {
      console.error('[backfill-digests] failed:', err?.message ?? err)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
