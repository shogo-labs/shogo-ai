#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Replay the daily abuse check over a date range.
 *
 * Usage:
 *   bun scripts/abuse/replay.ts --since 2026-11-12 --until 2026-11-20
 *                                                   # dry run: print table
 *   bun scripts/abuse/replay.ts --since ... --until ... --apply
 *                                                   # write bans to DB
 *   DATABASE_URL="postgresql://..." bun scripts/abuse/replay.ts ...
 */

import { PrismaClient } from '../../apps/api/src/generated/prisma-pg'
import { runAbuseCheckCore } from '../../apps/api/src/lib/abuse-check-job'

const args = process.argv.slice(2)
function arg(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

const sinceArg = arg('--since') ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
const untilArg = arg('--until') ?? new Date().toISOString().split('T')[0]
const apply = args.includes('--apply')

function daysInRange(since: string, until: string): string[] {
  const dates: string[] = []
  const cur = new Date(since + 'T00:00:00Z')
  const end = new Date(until + 'T00:00:00Z')
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0])
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return dates
}

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })

async function main() {
  const dates = daysInRange(sinceArg, untilArg)
  console.log(`\n[replay] ${apply ? 'APPLY' : 'DRY RUN'} — ${dates.length} days (${sinceArg} → ${untilArg})\n`)

  const totals = { candidates: 0, banned: 0, flagged: 0, paidFlagged: 0 }

  for (const date of dates) {
    console.log(`\n── ${date} ──`)
    const result = await runAbuseCheckCore(prisma as any, {
      runDate: date,
      dryRun: !apply,
    })
    console.log(
      `  candidates=${result.candidates} banned=${result.banned} flagged=${result.flagged} paidFlagged=${result.paidFlagged}`,
    )
    totals.candidates += result.candidates
    totals.banned += result.banned
    totals.flagged += result.flagged
    totals.paidFlagged += result.paidFlagged
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`TOTAL candidates=${totals.candidates} banned=${totals.banned} flagged=${totals.flagged} paidFlagged=${totals.paidFlagged}`)
  if (!apply) console.log('\nRe-run with --apply to write bans to the database.')
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
