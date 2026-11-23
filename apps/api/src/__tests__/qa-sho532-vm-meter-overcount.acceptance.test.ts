// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-532 acceptance (QA): no `VmUsageHour` row may bill more than the hour it
 * prices, and the prod shadow rows must be repairable.
 *
 * Runs against a REAL database (SQLite replayed from the desktop migrations, or
 * Postgres when CHANNELS_TEST_PG_URL is set) rather than a mocked `lib/prisma`,
 * because the parts of this fix that a mock cannot show are exactly the parts
 * that write:
 *
 *  - the multi-hour upsert now runs inside the SAME transaction as the cursor
 *    CAS, so a `P2002` on a second hour row would poison the cursor and either
 *    double-count or lose the tick;
 *  - the row cap reads the row it is about to increment;
 *  - the repair script pages over real rows and batches real updates, and must
 *    leave `billedAt` and `chargedUsd` alone.
 *
 * The prod shape under test: metal-agent restarts (every deploy) re-adopt each
 * live VM with its memory-only meter gone, so the first tick after a restart
 * used to report the VM's whole life. Prod reached 4,395,115 agent-seconds plus
 * 4,495,346 idle-seconds in one hour on fra-1.
 *
 * Run individually:
 *   bun --no-env-file test src/__tests__/qa-sho532-vm-meter-overcount.acceptance.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString('base64')

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { ingestMetalMeters } = await import('../lib/vm-metering/ingest')
const { repairOvercount } = await import('../../scripts/vm-metering/repair-overcount')

const HOST = 'latitude-fra-1'
const HOUR = 3_600_000
const DAY = 86_400_000

afterAll(() => {
  try { rmSync(dir, { recursive: true }) } catch {}
})

let seed: Awaited<ReturnType<typeof seedWorkspace>>

beforeAll(async () => {
  seed = await seedWorkspace(prisma as any)
})

beforeEach(async () => {
  await (prisma as any).vmMeterCursor.deleteMany({ where: { hostId: HOST } })
  await (prisma as any).vmUsageHour.deleteMany({ where: { hostId: HOST } })
})

/** One wire row from the metal agent, defaulting to the standard 4 vCPU VM. */
function report(over: Record<string, unknown> = {}) {
  return {
    vmId: 'vm-a',
    runtimeKey: `ws:${seed.workspaceId}`,
    assignedAt: 1_700_000_000_000,
    vcpus: 4,
    memMiB: 8192,
    cause: 'user_open',
    agentMs: 0,
    appMs: 0,
    idleMs: 0,
    ...over,
  }
}

function ingest(seq: number, now: Date, vms: unknown[]) {
  return ingestMetalMeters({ hostId: HOST, payload: { seq, vms }, now })
}

const seconds = (r: { agentSeconds: number; appSeconds: number; idleSeconds: number }) =>
  r.agentSeconds + r.appSeconds + r.idleSeconds

const usageRows = () =>
  (prisma as any).vmUsageHour.findMany({ where: { hostId: HOST }, orderBy: [{ hour: 'asc' }] }) as Promise<any[]>

const cursorOf = (vmId: string) =>
  (prisma as any).vmMeterCursor.findFirst({ where: { hostId: HOST, vmId } }) as Promise<any>

/** Collect `console.error`: OVERCOUNT and ROW_CAP are the only signal of a clamp. */
function captureErrors() {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: any[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  return { lines, restore: () => { console.error = original } }
}

/**
 * The invariant the whole card exists for. Asserted after every scenario
 * against every row on this host, not just the rows the test looked at.
 */
async function expectNoRowOverItsHour() {
  for (const row of await usageRows()) {
    if (seconds(row) > 3600) throw new Error(`row ${row.hour.toISOString()} bills ${seconds(row)} s`)
  }
}

describe('SHO-532 acceptance: a report cannot bill more than the wall clock', () => {
  test('the prod shape bills the wall clock, drops the excess, and does not compound', async () => {
    const T0 = Date.UTC(2026, 10, 21, 21, 0, 0)
    const assignedAt = T0 - 3 * HOUR
    const errors = captureErrors()
    let out2: any
    try {
      // 21:00 — the VM has been up 3 h with 50 min of agent time in its counters.
      const out1 = await ingest(1, new Date(T0), [report({ assignedAt, agentMs: 3_000_000 })])
      expect(out1.metered).toBe(1)
      expect((await cursorOf('vm-a')).agentMs).toBe(BigInt(3_000_000))

      // 21:00:30 — the restart shape: agent back to 0, idle jumped to 30 days.
      out2 = await ingest(2, new Date(T0 + 30_000), [
        report({ assignedAt, agentMs: 0, idleMs: 30 * DAY }),
      ])
      expect(out2.clamped).toBe(1)
      // 30 s of wall clock plus the 60 s slack, and not a second more.
      expect(out2.agentSeconds + out2.appSeconds + out2.idleSeconds).toBeLessThanOrEqual(90)
      expect(errors.lines.some((l) => l.includes('OVERCOUNT'))).toBe(true)
      // The excess is DROPPED, not carried: the cursor holds what the host reported.
      expect((await cursorOf('vm-a')).idleMs).toBe(BigInt(30 * DAY))

      // 21:01:00 — the next heartbeat bills its own 30 s. If the clamp had left the
      // cursor behind, this would re-bill the lifetime; if it had carried the
      // excess, the row would already be capped.
      const out3 = await ingest(3, new Date(T0 + 60_000), [
        report({ assignedAt, agentMs: 0, idleMs: 30 * DAY + 30_000 }),
      ])
      expect(out3.clamped).toBe(0)
      expect(out3.idleSeconds).toBe(30)
    } finally {
      errors.restore()
    }
    expect(out2.clamped).toBe(1)
    await expectNoRowOverItsHour()
  })

  test('a gap across an hour edge lands in both hours, each class pro rata', async () => {
    const H9 = Date.UTC(2026, 10, 18, 9, 50, 0)
    const H10 = H9 + 20 * 60_000
    await ingest(1, new Date(H9), [report({ vmId: 'vm-split', assignedAt: H9 })])
    const out = await ingest(2, new Date(H10), [
      report({ vmId: 'vm-split', assignedAt: H9, agentMs: 600_000, appMs: 600_000 }),
    ])
    expect(out.metered).toBe(1)

    const all = await usageRows()
    const atHour = (h: number) => all.find((r) => r.hour.getTime() === Date.UTC(2026, 10, 18, h))
    // 09:50 → 10:10 is 20 minutes: 10 in each hour, 5 min of agent + 5 of app.
    expect(atHour(9)).toMatchObject({ agentSeconds: 300, appSeconds: 300 })
    expect(atHour(10)).toMatchObject({ agentSeconds: 300, appSeconds: 300 })
    await expectNoRowOverItsHour()
  })

  test('two VMs sharing one hour row never push it past 3600 s', async () => {
    const now = Date.UTC(2026, 10, 18, 10, 45, 0)
    const assignedAt = now - 2_400_000
    const errors = captureErrors()
    let second: any
    try {
      await ingest(1, new Date(now), [report({ vmId: 'vm-a', assignedAt, agentMs: 2_400_000 })])
      second = await ingest(2, new Date(now), [report({ vmId: 'vm-b', assignedAt, agentMs: 2_400_000 })])
      expect(errors.lines.some((l) => l.includes('ROW_CAP'))).toBe(true)
    } finally {
      errors.restore()
    }

    // Same workspace, hour, host, size and cause → one row, capped at the hour.
    const all = await usageRows()
    expect(all).toHaveLength(1)
    expect(seconds(all[0])).toBe(3600)
    expect(second.clamped).toBe(1)
    await expectNoRowOverItsHour()
  })
})

describe('SHO-532 acceptance: the prod shadow rows are repairable', () => {
  const BEFORE = new Date(Date.UTC(2026, 10, 23, 0, 0, 0))
  const WORST = Date.UTC(2026, 10, 21, 21, 0, 0)
  const PRICED = Date.UTC(2026, 10, 22, 3, 0, 0)
  const EXACT = Date.UTC(2026, 10, 22, 4, 0, 0)
  const OPEN_HOUR = Date.UTC(2026, 10, 23, 0, 0, 0)

  /** The prod rows: the 4.4M fra-1 hour, a dal-2 hour already priced in shadow, a full hour, and the open hour. */
  async function seedProdRows() {
    const base = {
      workspaceId: seed.workspaceId,
      projectId: '',
      hostId: HOST,
      vcpus: 4,
      memMiB: 8192,
      cause: 'user_open',
    }
    await (prisma as any).vmUsageHour.create({
      data: { ...base, hour: new Date(WORST), agentSeconds: 4_395_115, appSeconds: 0, idleSeconds: 4_495_346 },
    })
    await (prisma as any).vmUsageHour.create({
      data: {
        ...base,
        hour: new Date(PRICED),
        agentSeconds: 1_300_000,
        appSeconds: 178_330,
        idleSeconds: 0,
        billedAt: new Date(Date.UTC(2026, 10, 22, 4, 30, 0)),
        chargedUsd: 12.5,
      },
    })
    await (prisma as any).vmUsageHour.create({
      data: { ...base, hour: new Date(EXACT), agentSeconds: 3600, appSeconds: 0, idleSeconds: 0 },
    })
    await (prisma as any).vmUsageHour.create({
      data: { ...base, hour: new Date(OPEN_HOUR), agentSeconds: 5000, appSeconds: 0, idleSeconds: 0 },
    })
  }

  const rowAt = async (hour: number) => (await usageRows()).find((r) => r.hour.getTime() === hour)

  test('a dry run reports the damage and writes nothing', async () => {
    await seedProdRows()
    const dry = await repairOvercount({ db: prisma as any, before: BEFORE, log: () => {} })

    expect(dry.overcount).toBe(2) // the worst hour and the priced one
    expect(dry.repaired).toBe(0)
    expect(dry.alreadyPriced).toBe(1)
    // Open hour is after `--before`: not scanned, so not repaired.
    expect(dry.scanned).toBe(3)

    expect((await rowAt(WORST)).agentSeconds).toBe(4_395_115)
    expect((await rowAt(PRICED)).agentSeconds).toBe(1_300_000)
  })

  test('--apply brings every closed hour within its hour, keeps the ratios and never re-bills', async () => {
    await seedProdRows()
    const applied = await repairOvercount({ db: prisma as any, before: BEFORE, apply: true, log: () => {} })

    expect(applied.repaired).toBe(2)

    const worst = await rowAt(WORST)
    expect(seconds(worst)).toBe(3600)
    // The class ratios survive, because those are what the row prices at.
    const expectedAgent = Math.floor((4_395_115 * 3600) / (4_395_115 + 4_495_346))
    expect(Math.abs(worst.agentSeconds - expectedAgent)).toBeLessThanOrEqual(1)
    expect(worst.idleSeconds).toBe(3600 - worst.agentSeconds)
    // Nothing is re-billed: the shadow stamp and its price are history.
    expect(worst.billedAt).toBeNull()
    expect(worst.chargedUsd).toBeNull()

    const priced = await rowAt(PRICED)
    expect(seconds(priced)).toBe(3600)
    expect(priced.billedAt).toBeInstanceOf(Date)
    expect(priced.billedAt.getTime()).toBe(Date.UTC(2026, 10, 22, 4, 30, 0))
    expect(priced.chargedUsd).toBe(12.5)

    // A row that already fits its hour is left byte-for-byte alone.
    expect(await rowAt(EXACT)).toMatchObject({ agentSeconds: 3600, appSeconds: 0, idleSeconds: 0 })

    // The open hour is still being written, so it is not touched.
    expect((await rowAt(OPEN_HOUR)).agentSeconds).toBe(5000)

    for (const row of await usageRows()) {
      if (row.hour.getTime() < BEFORE.getTime()) expect(seconds(row)).toBeLessThanOrEqual(3600)
    }
  })
})
