// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The one-off repair for over-counted `VmUsageHour` rows (SHO-532).
 *
 * Prod rows reached 4,395,115 agent-seconds for one hour, so the repair has to
 * be provably safe before it touches the database: a dry run must change
 * nothing, and `--apply` must bring every row to 3,600 s while keeping the class
 * ratios (those are what the row prices at) and leaving `billedAt` alone (a
 * billed row is never re-read, so nothing can be re-charged).
 */

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { planRowRepair, repairOvercount, type OvercountRow } from '../vm-metering/repair-overcount'

const HOUR = 3_600_000

// `repairOvercount` defaults `--before` to now, and the fixture rows are dated
// 2026-11-21/22, so the clock is pinned just past them: an unpinned clock would
// make "every closed hour before now" drift into a different answer over time
// (SHO-505).
beforeAll(() => setSystemTime(new Date('2026-11-23T05:00:00Z')))
afterAll(() => setSystemTime())

function row(fields: Partial<OvercountRow> & { id: string }): OvercountRow {
  return {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    hour: new Date(Date.UTC(2026, 10, 21, 21, 0)),
    hostId: 'fra-1',
    vcpus: 2,
    memMiB: 4096,
    cause: 'user_open',
    agentSeconds: 0,
    appSeconds: 0,
    idleSeconds: 0,
    chargedUsd: null,
    billedAt: null,
    ...fields,
  }
}

/** The query surface the script uses, over an in-memory table. */
function fakeDb(rows: OvercountRow[]) {
  return {
    rows,
    vmUsageHour: {
      findMany: async (args: any) => {
        let out = rows.filter((r) => r.hour.getTime() < args.where.hour.lt.getTime())
        out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        if (args.cursor) out = out.slice(out.findIndex((r) => r.id === args.cursor.id) + (args.skip ?? 0))
        return out.slice(0, args.take).map((r) => ({ ...r }))
      },
      update: async (args: any) => {
        const found = rows.find((r) => r.id === args.where.id)
        if (!found) throw new Error(`no row ${args.where.id}`)
        Object.assign(found, args.data)
        return found
      },
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  }
}

const PROD_SHAPE = [
  // The 4.4M / 4.5M row from the card.
  row({ id: 'a', agentSeconds: 4_395_115, idleSeconds: 4_495_346 }),
  // Medico Legal: four bad hours on dal-2.
  row({ id: 'b', hour: new Date(Date.UTC(2026, 10, 22, 3, 0)), hostId: 'dal-2', agentSeconds: 1_500_000 }),
  row({ id: 'c', hour: new Date(Date.UTC(2026, 10, 22, 4, 0)), hostId: 'dal-2', agentSeconds: 1_300_000 }),
  // A healthy row, and one that is exactly a full hour.
  row({ id: 'd', agentSeconds: 1_800, idleSeconds: 900 }),
  row({ id: 'e', agentSeconds: 3_600 }),
  // Already priced in shadow: repair the counters, keep the stamp.
  row({ id: 'f', agentSeconds: 7_200, idleSeconds: 3_600, billedAt: new Date('2026-11-22T01:00:00Z'), chargedUsd: 0.5 }),
]

describe('planRowRepair', () => {
  test('scales an over-counted row to 3600 s and keeps the class ratios', () => {
    const r = row({ id: 'x', agentSeconds: 3_000, appSeconds: 1_000, idleSeconds: 6_000 })
    const plan = planRowRepair(r)
    expect(plan.agentSeconds + plan.appSeconds + plan.idleSeconds).toBe(3600)
    // 3000 : 1000 : 6000 was 30% : 10% : 60%; the bill prices agent+app, so the
    // ratio is what has to survive.
    expect(plan.agentSeconds).toBe(1080)
    expect(plan.appSeconds).toBe(360)
    expect(plan.idleSeconds).toBe(2160)
    expect(plan.droppedSeconds).toBe(6_400)
  })

  test('leaves a row that is already within its hour alone', () => {
    const plan = planRowRepair(row({ id: 'y', agentSeconds: 3_000, idleSeconds: 600 }))
    expect(plan).toMatchObject({ agentSeconds: 3_000, appSeconds: 0, idleSeconds: 600, droppedSeconds: 0 })
  })
})

describe('repairOvercount', () => {
  test('a dry run reports the damage and writes nothing', async () => {
    const db = fakeDb(PROD_SHAPE.map((r) => ({ ...r })))
    const lines: string[] = []
    const summary = await repairOvercount({ db: db as any, log: (l) => lines.push(l) })

    expect(summary.scanned).toBe(6)
    expect(summary.overcount).toBe(4)
    expect(summary.repaired).toBe(0)
    expect(db.rows.find((r) => r.id === 'a')!.agentSeconds).toBe(4_395_115)
    // Grouped by host and day for the PR report.
    expect(lines.some((l) => l.startsWith('fra-1 2026-11-21') && l.includes('2'))).toBe(true)
    expect(lines.some((l) => l.startsWith('dal-2 2026-11-22') && l.includes('2'))).toBe(true)
    expect(lines.some((l) => l.includes('would repair 4 of 6'))).toBe(true)
  })

  test('--apply brings every row within its hour, keeps ratios and billedAt', async () => {
    const db = fakeDb(PROD_SHAPE.map((r) => ({ ...r })))
    const summary = await repairOvercount({ db: db as any, apply: true, log: () => {} })

    expect(summary.repaired).toBe(4)
    expect(summary.afterSeconds).toBe(4 * 3600)
    for (const r of db.rows) {
      expect(r.agentSeconds + r.appSeconds + r.idleSeconds).toBeLessThanOrEqual(3600)
    }
    // Ratios survive: `a` was 4395115 agent : 4495346 idle — within rounding.
    const a = db.rows.find((r) => r.id === 'a')!
    expect(a.agentSeconds).toBe(1780)
    expect(a.idleSeconds).toBe(1820)
    // `b` was pure agent time and stays pure agent time.
    expect(db.rows.find((r) => r.id === 'b')).toMatchObject({ agentSeconds: 3600, appSeconds: 0, idleSeconds: 0 })
    // A priced row keeps its stamp (and its charge) — nothing is re-billed.
    const f = db.rows.find((r) => r.id === 'f')!
    expect(f.billedAt?.toISOString()).toBe('2026-11-22T01:00:00.000Z')
    expect(f.chargedUsd).toBe(0.5)
    expect(f.agentSeconds + f.idleSeconds).toBe(3600)
  })

  test('--before only repairs hours that closed before it', async () => {
    const db = fakeDb(PROD_SHAPE.map((r) => ({ ...r })))
    const summary = await repairOvercount({
      db: db as any,
      apply: true,
      before: new Date(Date.UTC(2026, 10, 22, 3, 30)),
      log: () => {},
    })

    // `a`, `b` and `f` closed before the cutoff; `c` (04:00) did not.
    expect(summary.overcount).toBe(3)
    expect(summary.repaired).toBe(3)
    expect(db.rows.find((r) => r.id === 'c')!.agentSeconds).toBe(1_300_000)
  })

  test('pages through more rows than one page holds', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      row({ id: `p${i}`, hour: new Date(Date.UTC(2026, 10, 21, 21, 0) + i * HOUR), agentSeconds: 7_200 }),
    )
    const db = fakeDb(many)
    const summary = await repairOvercount({ db: db as any, apply: true, pageSize: 2, log: () => {} })
    expect(summary.overcount).toBe(5)
    expect(summary.repaired).toBe(5)
    expect(db.rows.every((r) => r.agentSeconds === 3600)).toBe(true)
  })
})
