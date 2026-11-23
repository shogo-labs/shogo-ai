// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repair `VmUsageHour` rows that bill more than the hour they price (SHO-532).
 *
 * The meter used to live only in the host's memory, so the first tick after a
 * metal-agent restart charged a re-adopted VM's whole life to its current class.
 * Prod reached `92caf1cd…` fra-1 2026-11-21 21:00 = 4,395,115 agent-seconds plus
 * 4,495,346 idle-seconds in one hour, and 27% of rows exceeded 3,600 s.
 *
 * Every row whose three counters sum above 3,600 is scaled proportionally down
 * to 3,600 (the class ratios survive, because those decide what it prices at).
 * `billedAt` is left alone: shadow mode charged nothing and the bill job only
 * reads rows where `billedAt` is null, so a repaired row is never re-charged.
 * For the same reason `chargedUsd` is left alone — on an already-priced row it
 * records what was priced, and the dry run reports how far it now over-states.
 *
 * Dry run by default:
 *
 *   bun apps/api/scripts/vm-metering/repair-overcount.ts
 *   bun apps/api/scripts/vm-metering/repair-overcount.ts --apply
 *   bun apps/api/scripts/vm-metering/repair-overcount.ts --before 2026-11-23T00:00:00Z
 *
 * `vm_usage_hours` is written by one region per host, so run it against the
 * primary of each region that owns metal hosts (EU and US), or against the prod
 * database when there is one.
 */
import { prisma } from '../../src/lib/prisma'
import { computeVmCost } from '../../src/config/vm-pricing'
import { scaleToCap } from '../../src/lib/vm-metering/ingest'

/** One `VmUsageHour` row prices one wall-clock hour of machine time. */
const ROW_SECONDS = 3600
/** Rows per write transaction. */
const BATCH_SIZE = 200
/** Page size for the scan (a full table read would be ~14 MB of rows in prod). */
const PAGE_SIZE = 1000

export interface OvercountRow {
  id: string
  workspaceId: string
  projectId: string
  hour: Date
  hostId: string
  vcpus: number
  memMiB: number
  cause: string
  agentSeconds: number
  appSeconds: number
  idleSeconds: number
  chargedUsd: number | null
  billedAt: Date | null
}

export interface RowRepair {
  id: string
  agentSeconds: number
  appSeconds: number
  idleSeconds: number
  droppedSeconds: number
}

/** What one over-counted row becomes: 3,600 s, same class ratios. */
export function planRowRepair(row: OvercountRow): RowRepair {
  const before = row.agentSeconds + row.appSeconds + row.idleSeconds
  const [agentSeconds, appSeconds, idleSeconds] = scaleToCap(
    [row.agentSeconds, row.appSeconds, row.idleSeconds],
    ROW_SECONDS,
  )
  return {
    id: row.id,
    agentSeconds,
    appSeconds,
    idleSeconds,
    droppedSeconds: before - (agentSeconds + appSeconds + idleSeconds),
  }
}

/** Does this row bill more than an hour? */
export function isOvercount(row: { agentSeconds: number; appSeconds: number; idleSeconds: number }): boolean {
  return row.agentSeconds + row.appSeconds + row.idleSeconds > ROW_SECONDS
}

function usd(row: OvercountRow): number {
  return computeVmCost({
    vcpus: row.vcpus,
    memMiB: row.memMiB,
    agentSeconds: row.agentSeconds,
    appSeconds: row.appSeconds,
    idleSeconds: row.idleSeconds,
    cause: row.cause,
  }).totalUsd
}

function usdOf(row: OvercountRow, repair: RowRepair): number {
  return usd({ ...row, ...repair })
}

export interface RepairSummary {
  scanned: number
  overcount: number
  repaired: number
  beforeSeconds: number
  afterSeconds: number
  beforeUsd: number
  afterUsd: number
  /** Rows already priced (`billedAt` set): their `chargedUsd` is now an over-statement. */
  alreadyPriced: number
}

type Db = {
  vmUsageHour: {
    findMany: (args: any) => Promise<any[]>
    update: (args: any) => Promise<any>
  }
  $transaction: (ops: any[]) => Promise<any>
}

/**
 * Scan and (with `apply`) repair. `db` is injectable so the test can drive the
 * real query shape without a database.
 */
export async function repairOvercount(opts: {
  db?: Db
  apply?: boolean
  before?: Date
  pageSize?: number
  log?: (line: string) => void
}): Promise<RepairSummary> {
  const db = (opts.db ?? (prisma as unknown as Db)) as Db
  const apply = opts.apply === true
  const before = opts.before ?? new Date()
  const pageSize = opts.pageSize ?? PAGE_SIZE
  const log = opts.log ?? ((line: string) => console.log(line))

  const summary: RepairSummary = {
    scanned: 0,
    overcount: 0,
    repaired: 0,
    beforeSeconds: 0,
    afterSeconds: 0,
    beforeUsd: 0,
    afterUsd: 0,
    alreadyPriced: 0,
  }

  const byGroup = new Map<string, { rows: number; before: number; after: number; usdBefore: number; usdAfter: number }>()
  let pending: RowRepair[] = []

  const flush = async () => {
    if (pending.length === 0) return
    await db.$transaction(
      pending.map((r) =>
        db.vmUsageHour.update({
          where: { id: r.id },
          data: { agentSeconds: r.agentSeconds, appSeconds: r.appSeconds, idleSeconds: r.idleSeconds },
        }),
      ),
    )
    summary.repaired += pending.length
    pending = []
  }

  let cursor: string | undefined
  for (;;) {
    const page = (await db.vmUsageHour.findMany({
      where: { hour: { lt: before } },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        hour: true,
        hostId: true,
        vcpus: true,
        memMiB: true,
        cause: true,
        agentSeconds: true,
        appSeconds: true,
        idleSeconds: true,
        chargedUsd: true,
        billedAt: true,
      },
    })) as OvercountRow[]
    if (page.length === 0) break
    cursor = page[page.length - 1].id

    for (const row of page) {
      summary.scanned++
      if (!isOvercount(row)) continue
      const repair = planRowRepair(row)
      const group = `${row.hostId} ${row.hour.toISOString().slice(0, 10)}`
      const g = byGroup.get(group) ?? { rows: 0, before: 0, after: 0, usdBefore: 0, usdAfter: 0 }
      g.rows++
      g.before += row.agentSeconds + row.appSeconds + row.idleSeconds
      g.after += repair.agentSeconds + repair.appSeconds + repair.idleSeconds
      g.usdBefore += usd(row)
      g.usdAfter += usdOf(row, repair)
      byGroup.set(group, g)

      summary.overcount++
      summary.beforeSeconds += row.agentSeconds + row.appSeconds + row.idleSeconds
      summary.afterSeconds += repair.agentSeconds + repair.appSeconds + repair.idleSeconds
      summary.beforeUsd += usd(row)
      summary.afterUsd += usdOf(row, repair)
      if (row.billedAt) summary.alreadyPriced++
      if (apply) {
        pending.push(repair)
        if (pending.length >= BATCH_SIZE) await flush()
      }
    }
  }
  if (apply) await flush()

  log('')
  log(`host / UTC day                          rows      before s      after s   usd before   usd after`)
  for (const [group, g] of [...byGroup.entries()].sort()) {
    log(
      `${group.padEnd(34)} ${String(g.rows).padStart(6)} ${String(g.before).padStart(13)} ${String(g.after).padStart(13)} ` +
        `${g.usdBefore.toFixed(4).padStart(12)} ${g.usdAfter.toFixed(4).padStart(12)}`,
    )
  }
  log('')
  log(
    `${apply ? 'repaired' : 'would repair'} ${summary.overcount} of ${summary.scanned} row(s) scored before ${before.toISOString()}: ` +
      `${summary.beforeSeconds} s → ${summary.afterSeconds} s, $${summary.beforeUsd.toFixed(4)} → $${summary.afterUsd.toFixed(4)} shadow`,
  )
  if (summary.alreadyPriced > 0) {
    log(
      `${summary.alreadyPriced} of them are already priced (shadow stamped billedAt + chargedUsd); ` +
        `their chargedUsd keeps the old, over-stated number — the bill job never re-reads a billed row, ` +
        `so nothing is re-charged, but the dashboard estimate for those hours stays high.`,
    )
  }
  if (!apply && summary.overcount > 0) log('dry run — re-run with --apply to write the repaired counters')
  return summary
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const raw = argValue('--before')
  const before = raw ? new Date(raw) : new Date()
  if (Number.isNaN(before.getTime())) throw new Error(`--before must be an ISO timestamp, got ${raw}`)
  await repairOvercount({ apply: process.argv.includes('--apply'), before })
  await prisma.$disconnect()
}
