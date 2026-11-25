// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-475 regression: agentMs / appMs / idleMs overflow int32 after 24.8 days.
 *
 * Runs against a real database (Postgres when CHANNELS_TEST_PG_URL is set,
 * SQLite otherwise via desktop migrations). The test must NOT mock
 * `../lib/prisma`; the whole point is that the DB column type is BigInt.
 *
 * On `origin/main` (before this fix) cases (a), (b), (c) all fail on Postgres
 * with `value … is out of range for type integer`. SQLite stores 64-bit
 * integers natively, so it may pass there even before the fix — noted in the
 * PR body.
 *
 * SHO-532 bounded what a report may BILL: the counter is still stored in full
 * (that is what these cases guard), but a first report cannot charge more than
 * the wall clock since the VM was assigned, so case (a) now asserts 61 s rather
 * than 24.8 days.
 *
 * Run individually:
 *   CHANNELS_TEST_PG_URL=postgresql://shogo:shogo@127.0.0.1:5432/shogo \
 *     bun --no-env-file test src/__tests__/vm-meter-cursor-overflow.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString('base64')

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { ingestMetalMeters } = await import('../lib/vm-metering/ingest')

const HOST = 'latitude-fra-1'

/** 2 ** 31 as a number (safe in JS, the int32 overflow boundary). */
const INT32_MAX = 2 ** 31

afterAll(() => {
  try { rmSync(dir, { recursive: true }) } catch {}
})

let seed: Awaited<ReturnType<typeof seedWorkspace>>

beforeAll(async () => {
  seed = await seedWorkspace(prisma as any)
})

beforeEach(async () => {
  // Clean up between tests so cursors from one case don't interfere with another.
  await (prisma as any).vmMeterCursor.deleteMany({ where: { hostId: HOST } })
  await (prisma as any).vmUsageHour.deleteMany({ where: { hostId: HOST } })
})

describe('SHO-475: BigInt cursor counters (real DB)', () => {
  /**
   * (a) First report above 2^31: a new cursor must be created with the
   * overflow value, and a second report 30 s later records exactly 30 s.
   */
  test('(a) first report above INT32_MAX creates a valid cursor and 30 s later bills 30 s', async () => {
    const T0 = 1_700_000_000_000
    const firstMs = INT32_MAX + 5_000
    const secondMs = firstMs + 30_000

    const r1 = await ingestMetalMeters({
      hostId: HOST,
      payload: {
        seq: 1,
        vms: [{ vmId: 'vm-a', runtimeKey: `ws:${seed.workspaceId}`, assignedAt: T0, agentMs: firstMs, appMs: 0, idleMs: 0 }],
      },
      now: new Date(T0 + 1_000),
    })
    expect(r1.metered).toBe(1)

    // Cursor must be stored with the full BigInt value.
    const cursor = await (prisma as any).vmMeterCursor.findFirst({ where: { hostId: HOST, vmId: 'vm-a' } })
    expect(cursor).not.toBeNull()
    // The cursor holds whole-second-truncated ms; firstMs / 1000 = 2147488 s exactly.
    expect(cursor.agentMs).toBe(BigInt(Math.floor(firstMs / 1000) * 1000))

    const r2 = await ingestMetalMeters({
      hostId: HOST,
      payload: {
        seq: 2,
        vms: [{ vmId: 'vm-a', runtimeKey: `ws:${seed.workspaceId}`, assignedAt: T0, agentMs: secondMs, appMs: 0, idleMs: 0 }],
      },
      now: new Date(T0 + 31_000),
    })
    expect(r2.metered).toBe(1)

    const usage = await (prisma as any).vmUsageHour.findMany({ where: { hostId: HOST } })
    const totalAgent = usage.reduce((s: number, r: any) => s + r.agentSeconds, 0)
    // The full value is stored as BigInt (asserted above), but what is BILLED is
    // bounded by the wall clock: this VM was assigned one second ago and reports
    // 24.8 days of agent time, so 1 s + the 60 s slack is all it can have used
    // (SHO-532). The second report adds its own legitimate 30 s.
    expect(totalAgent).toBe(61 + 30)
    for (const r of usage) expect(r.agentSeconds + r.appSeconds + r.idleSeconds).toBeLessThanOrEqual(3600)
  })

  /**
   * (b) Existing cursor at INT32_MAX − 1000, next report at INT32_MAX + 29000:
   * exactly 30 s must be billed, and replaying the same payload bills 0.
   */
  test('(b) cursor near INT32_MAX advances exactly 30 s and replay bills 0', async () => {
    const T0 = 1_700_000_000_000
    const cursorMs = INT32_MAX - 1_000
    const reportMs = INT32_MAX + 29_000

    // Seed a cursor at the boundary (via a valid first ingest).
    await ingestMetalMeters({
      hostId: HOST,
      payload: {
        seq: 1,
        vms: [{ vmId: 'vm-b', runtimeKey: `ws:${seed.workspaceId}`, assignedAt: T0, agentMs: cursorMs, appMs: 0, idleMs: 0 }],
      },
      now: new Date(T0 + 1_000),
    })
    // Clear usage so we can count just the next 30 s.
    await (prisma as any).vmUsageHour.deleteMany({ where: { hostId: HOST } })

    const r1 = await ingestMetalMeters({
      hostId: HOST,
      payload: {
        seq: 2,
        vms: [{ vmId: 'vm-b', runtimeKey: `ws:${seed.workspaceId}`, assignedAt: T0, agentMs: reportMs, appMs: 0, idleMs: 0 }],
      },
      now: new Date(T0 + 31_000),
    })
    expect(r1.metered).toBe(1)

    const usage1 = await (prisma as any).vmUsageHour.findMany({ where: { hostId: HOST } })
    expect(usage1.reduce((s: number, r: any) => s + r.agentSeconds, 0)).toBe(30)

    // Replay must bill 0.
    const r2 = await ingestMetalMeters({
      hostId: HOST,
      payload: {
        seq: 2,
        vms: [{ vmId: 'vm-b', runtimeKey: `ws:${seed.workspaceId}`, assignedAt: T0, agentMs: reportMs, appMs: 0, idleMs: 0 }],
      },
      now: new Date(T0 + 62_000),
    })
    expect(r2.metered).toBe(0)
    const usage2 = await (prisma as any).vmUsageHour.findMany({ where: { hostId: HOST } })
    expect(usage2.reduce((s: number, r: any) => s + r.agentSeconds, 0)).toBe(30)
  })

  /**
   * (c) Unresolved key with counter above INT32_MAX: cursor must be written,
   * no usage row created.
   */
  test('(c) unresolved key above INT32_MAX advances cursor, no usage row', async () => {
    const T0 = 1_700_000_000_000
    const bigMs = INT32_MAX + 100_000

    const r = await ingestMetalMeters({
      hostId: HOST,
      payload: {
        seq: 1,
        vms: [{ vmId: 'vm-c', runtimeKey: 'published:gone-env', assignedAt: T0, agentMs: bigMs, appMs: 0, idleMs: 0 }],
      },
      now: new Date(T0 + 1_000),
    })
    expect(r.unresolved).toBe(1)

    const cursor = await (prisma as any).vmMeterCursor.findFirst({ where: { hostId: HOST, vmId: 'vm-c' } })
    expect(cursor).not.toBeNull()
    expect(cursor.agentMs).toBe(BigInt(bigMs))

    const usage = await (prisma as any).vmUsageHour.findMany({ where: { hostId: HOST } })
    expect(usage).toHaveLength(0)
  })

  /**
   * (d) One failing VM must not abort the host: the second VM is still metered,
   * failed === 1, and ack === 0 (host must re-send).
   */
  test('(d) one injected failure does not stop other VMs, sets failed=1 and ack=0', async () => {
    const T0 = 1_700_000_000_000

    // Force a failure on vm-d1 by inserting a cursor row with an impossible
    // bigint value that our CAS will never match, then passing a CREATE that
    // collides.  The simplest way is to pass a vmId whose assignedAt wraps to
    // BigInt(0) so the UNIQUE constraint fires but we don't catch P2002 on
    // the outer path.
    //
    // Simpler: set up a cursor for vm-d1, then in a second transaction from
    // outside the ingest, delete it and immediately re-create it with a
    // different agentMs so every CAS attempt loses — causing the loop to
    // exhaust its retries and return null.  Return null is NOT an error, so
    // it doesn't trigger `failed`.
    //
    // The cleanest way to inject a true error is to call ingestMetalMeters
    // with a payload where one row has an assignedAt that is not representable
    // as BIGINT (NaN → 0 after normalise, but 0 is valid).  Actually the
    // simplest approach: monkey-patch prisma.$transaction to throw once, then
    // restore.  We avoid importing prisma with a mock, so we use the real
    // client and patch the method temporarily.
    const db = prisma as any
    const origTx = db.$transaction.bind(db)
    let txCallCount = 0
    db.$transaction = async (fn: any, ...rest: any[]) => {
      txCallCount++
      if (txCallCount === 1) {
        throw new Error('injected: db timeout')
      }
      return origTx(fn, ...rest)
    }

    try {
      const r = await ingestMetalMeters({
        hostId: HOST,
        payload: {
          seq: 5,
          vms: [
            { vmId: 'vm-d1', runtimeKey: `ws:${seed.workspaceId}`, assignedAt: T0, agentMs: 60_000, appMs: 0, idleMs: 0 },
            { vmId: 'vm-d2', runtimeKey: `ws:${seed.workspaceId}`, assignedAt: T0, agentMs: 60_000, appMs: 0, idleMs: 0 },
          ],
        },
        now: new Date(T0 + 1_000),
      })

      expect(r.failed).toBe(1)
      expect(r.metered).toBe(1)
      expect(r.ack).toBe(0)

      const usage = await db.vmUsageHour.findMany({ where: { hostId: HOST } })
      expect(usage.reduce((s: number, u: any) => s + u.agentSeconds, 0)).toBe(60)
    } finally {
      db.$transaction = origTx
    }
  })
})
