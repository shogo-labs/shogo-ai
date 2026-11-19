// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-424, workspace compute is metered and billed.
 *
 * The card's own suites pin the arithmetic (`config/vm-pricing`), the ingest
 * delta maths against a fake prisma, and the host-side counters. What they do
 * not do is run the path a real host's heartbeat takes: the register payload
 * into `VmUsageHour` rows, the hourly job over those rows, `consumeUsage`, and
 * the two read routes over a real database. That is what this file does, on the
 * desktop SQLite migration track (Postgres when `CHANNELS_TEST_PG_URL` is set),
 * so the migrations themselves are exercised too.
 *
 *   bun --no-env-file test apps/api/src/__tests__/qa-sho424-vm-compute-billing.acceptance.test.ts
 *
 * Pins, in the card's own numbering:
 *  - AC2: a replayed heartbeat adds nothing; a counter reset is not billed twice.
 *  - AC3: `runVmUsageBill` charges `computeVmCost` once per workspace-hour in
 *    enforce, fills `chargedUsd` without charging in shadow, never bills
 *    rewarm/prewarm/published, never bills idle seconds, and a refused charge
 *    leaves the rows for the next run instead of stamping them.
 *  - AC4: `GET /api/workspaces/:id/compute-usage` gives owners/admins the split,
 *    members the total only, and 403s a non-member; `GET /api/admin/compute` is
 *    super-admin only.
 *  - AC5: the instance-size checkout answers 410 and no client still sells it.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupChannelsTestDb, seedWorkspace, type SeededWorkspace } from './helpers/channels-test-db'

let currentUserId = ''
setupChannelsTestDb()

// Only the auth middleware is mocked: authz, membership rows, the routes, the
// ingest and the job are the real code.
mock.module('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { userId: currentUserId, isAuthenticated: true })
    await next()
  },
  requireAuth: async (_c: any, next: any) => next(),
}))

// The wallet is the collaborator, not the subject: record the debit and let the
// test decide whether it succeeds. Everything the job does around it is real.
const consumeCalls: any[] = []
let consumeResult: (args: any) => any = () => ({ success: true })
mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeCalls.push(args)
    return consumeResult(args)
  },
}))

const { prisma } = await import('../lib/prisma')
// The job skips in local mode (no wallet to draw from) — this suite is the cloud
// path. `lib/prisma` is already built as SQLite by the helper above.
delete process.env.SHOGO_LOCAL_MODE
process.env.KUBERNETES_SERVICE_HOST = 'qa-test'
process.env.VM_BILLING = 'true'

const { computeUsageRoutes } = await import('../routes/compute-usage')
const { adminRoutes } = await import('../routes/admin')
const { runVmUsageBill } = await import('../jobs/vm-usage-bill')
const { ingestMetalMeters } = await import('../lib/vm-metering/ingest')
const { computeVmCost, roundUsd } = await import('../config/vm-pricing')
const { adminComputeSummary } = await import('../routes/compute-usage')

const db = prisma as any

const HOST = 'metal-us-qa'
/**
 * A fixed hour inside the current billing month (today is 2026-11-18).
 * Every ingest and every bill run takes the next slot: the job claims ONE run
 * per region-hour, so two scenarios sharing an hour would silently skip the
 * second (which is the behaviour we want in production, and the reason this is
 * a counter rather than a constant).
 */
let slot = 9
const nextHour = () => new Date(Date.UTC(2026, 10, 18, ++slot, 0, 0))

let seeded: SeededWorkspace
let superAdmin = ''

beforeAll(async () => {
  seeded = await seedWorkspace(db)
  const suffix = crypto.randomUUID().slice(0, 8)
  const su = await db.user.create({
    data: { name: 'super', email: `super-${suffix}@example.com`, role: 'super_admin' },
  })
  superAdmin = su.id
}, 120_000)

beforeEach(() => {
  consumeCalls.length = 0
  consumeResult = () => ({ success: true })
  process.env.VM_BILLING_MODE = 'shadow'
})

/** One heartbeat carrying a single VM's cumulative counters. */
function heartbeat(fields: {
  seq?: number
  vmId: string
  runtimeKey: string
  assignedAt: number
  agentMs?: number
  appMs?: number
  idleMs?: number
  vcpus?: number
  memMiB?: number
  cause?: string
}) {
  return {
    seq: fields.seq ?? 1,
    vms: [
      {
        vmId: fields.vmId,
        runtimeKey: fields.runtimeKey,
        assignedAt: fields.assignedAt,
        vcpus: fields.vcpus ?? 2,
        memMiB: fields.memMiB ?? 4096,
        vmClass: 'standard',
        cause: fields.cause ?? 'user_open',
        alwaysOn: false,
        agentMs: fields.agentMs ?? 0,
        appMs: fields.appMs ?? 0,
        idleMs: fields.idleMs ?? 0,
      },
    ],
  }
}

const ASSIGNED_AT = Date.UTC(2026, 10, 18, 10, 0, 0)

async function rowsFor(workspaceId: string) {
  return db.vmUsageHour.findMany({ where: { workspaceId }, orderBy: { hour: 'asc' } })
}

async function usageEvents(workspaceId: string) {
  return db.usageEvent.findMany({ where: { workspaceId, actionType: 'vm_compute' } })
}

// ─── AC2 + AC3: heartbeat → rows → one charge ─────────────────────────

describe('a heartbeat becomes rows, and the rows become one charge', () => {
  test('ingest writes the hour, a replay adds nothing, and the biller prices it once', async () => {
    const at = nextHour()
    const billAt = nextHour()
    const before = await rowsFor(seeded.workspaceId).then((r) => r.length)
    const payload = heartbeat({
      vmId: 'vm-e2e-1',
      runtimeKey: seeded.projectId,
      assignedAt: ASSIGNED_AT,
      agentMs: 1_800_000,
      idleMs: 1_800_000,
    })

    await ingestMetalMeters({ hostId: HOST, payload: payload as any, now: at })
    const first = (await rowsFor(seeded.workspaceId)).slice(before)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      hostId: HOST,
      vcpus: 2,
      memMiB: 4096,
      cause: 'user_open',
      agentSeconds: 1800,
      appSeconds: 0,
      idleSeconds: 1800,
    })

    // The same heartbeat again, and again after a lost tick: still one row with
    // the same seconds.
    await ingestMetalMeters({ hostId: HOST, payload: payload as any, now: at })
    const replayed = (await rowsFor(seeded.workspaceId)).slice(before)
    expect(replayed).toHaveLength(1)
    expect(replayed[0].agentSeconds).toBe(1800)

    // Shadow: the hour is priced and stamped, and nothing is charged.
    const shadow = await runVmUsageBill(billAt)
    expect(shadow.mode).toBe('shadow')
    expect(shadow.totalUsd).toBeCloseTo(0.11, 6) // half an hour of 2 vCPU / 4 GiB
    expect(consumeCalls).toHaveLength(0)
    expect(await usageEvents(seeded.workspaceId)).toHaveLength(0)

    const stamped = (await rowsFor(seeded.workspaceId)).slice(before)
    expect(stamped[0].chargedUsd).toBeCloseTo(0.11, 6)
    expect(stamped[0].billedAt).not.toBeNull()

    // A rerun for a later hour has nothing left to do.
    const again = await runVmUsageBill(nextHour())
    expect(again.rowsBilled).toBe(0)
    expect(again.totalUsd).toBe(0)
  })

  test('idle seconds are metered and never billed', async () => {
    const at = nextHour()
    const billAt = nextHour()
    const vmId = `vm-idle-only-${crypto.randomUUID().slice(0, 6)}`
    const payload = heartbeat({
      vmId,
      runtimeKey: seeded.projectId,
      assignedAt: ASSIGNED_AT,
      idleMs: 3_600_000,
    })
    await ingestMetalMeters({ hostId: HOST, payload: payload as any, now: at })

    const summary = await runVmUsageBill(billAt)
    expect(summary.totalUsd).toBe(0)
    expect(summary.freeUsd).toBeCloseTo(0.22, 6)

    const rows = (await rowsFor(seeded.workspaceId)).filter((r: any) => r.hostId === HOST && r.idleSeconds === 3600)
    expect(rows[0].idleSeconds).toBe(3600)
    expect(rows[0].chargedUsd).toBe(0)
    expect(rows[0].billedAt).not.toBeNull() // priced, so it can never be retro-charged
  })

  test('a counter reset does not re-bill the whole counter on every tick after it', async () => {
    const resetWorkspace = await db.workspace.create({
      data: { name: 'Reset Co', slug: `reset-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
    })
    const at = nextHour()
    const vmId = 'vm-restart'
    const base = { vmId, assignedAt: ASSIGNED_AT, runtimeKey: `ws:${resetWorkspace.id}`, agentMs: 0 }

    await ingestMetalMeters({
      hostId: HOST,
      payload: heartbeat({ ...base, agentMs: 60_000 }) as any,
      now: at,
    })
    // The agent process restarted: its in-memory counters began again at zero,
    // so it reports 5 s of work since coming back.
    await ingestMetalMeters({
      hostId: HOST,
      payload: heartbeat({ ...base, seq: 2, agentMs: 5_000 }) as any,
      now: at,
    })
    // 30 s later the counter has moved on by 30 s.
    await ingestMetalMeters({
      hostId: HOST,
      payload: heartbeat({ ...base, seq: 3, agentMs: 35_000 }) as any,
      now: at,
    })

    // Settle these rows first, so a failure below cannot leak into the next
    // scenario's totals.
    await runVmUsageBill(nextHour())
    const rows = await rowsFor(resetWorkspace.id)
    const total = rows.reduce((sum: number, r: any) => sum + r.agentSeconds, 0)
    // 60 s before the restart + 5 s + 30 s.
    expect(total).toBe(95)
  })
})

describe('enforce charges once per workspace-hour', () => {
  test('one consumeUsage for the hour, with the priced amount and the attribution', async () => {
    process.env.VM_BILLING_MODE = 'enforce'
    const at = nextHour()
    const billAt = nextHour()
    const ws = await db.workspace.create({
      data: { name: 'Enforce Co', slug: `enforce-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
    })
    await ingestMetalMeters({
      hostId: HOST,
      payload: heartbeat({
        vmId: 'vm-enforce',
        runtimeKey: `ws:${ws.id}`,
        assignedAt: ASSIGNED_AT,
        appMs: 3_600_000,
      }) as any,
      now: at,
    })

    const summary = await runVmUsageBill(billAt)
    expect(summary.mode).toBe('enforce')
    expect(summary.totalUsd).toBeCloseTo(0.22, 6)
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({ workspaceId: ws.id, actionType: 'vm_compute', billedUsd: 0.22 })
    expect(consumeCalls[0].actionMetadata).toMatchObject({ agentSeconds: 0, appSeconds: 3600, idleSeconds: 0 })

    // A rerun for a later hour charges nothing more: the rows are stamped.
    const rerun = await runVmUsageBill(nextHour())
    expect(rerun.totalUsd).toBe(0)
    expect(consumeCalls).toHaveLength(1)
  })

  test('a refused charge leaves the hour unbilled for the next run instead of stamping it', async () => {
    process.env.VM_BILLING_MODE = 'enforce'
    const at = nextHour()
    const billAt = nextHour()
    const ws = await db.workspace.create({
      data: { name: 'Broke Co', slug: `broke-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
    })
    await ingestMetalMeters({
      hostId: HOST,
      payload: heartbeat({
        vmId: 'vm-refused',
        runtimeKey: `ws:${ws.id}`,
        assignedAt: ASSIGNED_AT,
        agentMs: 3_600_000,
      }) as any,
      now: at,
    })

    consumeResult = () => ({ success: false, error: 'insufficient funds', reason: 'insufficient_funds' })
    const blocked = await runVmUsageBill(billAt)
    expect(blocked.totalUsd).toBe(0)
    const unbilled = await rowsFor(ws.id)
    expect(unbilled[0].billedAt).toBeNull()
    expect(unbilled[0].chargedUsd).toBeNull()

    // The next hour retries and succeeds.
    consumeResult = () => ({ success: true })
    const retried = await runVmUsageBill(nextHour())
    expect(retried.totalUsd).toBeCloseTo(0.22, 6)
    expect(consumeCalls).toHaveLength(2)
  })

  test('platform-caused VMs are metered but never billed', async () => {
    process.env.VM_BILLING_MODE = 'enforce'
    const at = nextHour()
    const billAt = nextHour()
    const ws = await db.workspace.create({
      data: { name: 'Overhead Co', slug: `overhead-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
    })
    for (const [i, cause] of ['prewarm', 'rewarm', 'published'].entries()) {
      await ingestMetalMeters({
        hostId: HOST,
        payload: heartbeat({
          vmId: `vm-${cause}`,
          runtimeKey: `ws:${ws.id}`,
          assignedAt: ASSIGNED_AT + i,
          agentMs: 3_600_000,
          cause,
        }) as any,
        now: at,
      })
    }

    const summary = await runVmUsageBill(billAt)
    expect(summary.totalUsd).toBe(0)
    expect(consumeCalls).toHaveLength(0)
    const rows = await rowsFor(ws.id)
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.agentSeconds).toBe(3600)
      expect(row.chargedUsd).toBe(0)
      expect(row.billedAt).not.toBeNull()
    }
  })

  test('the number the job charges is the number the estimate shows', async () => {
    // One row priced by both paths: `computeVmCost` (the job) and the route's
    // `priceWorkspaceHour` (the UI). They must not be able to disagree.
    const cost = computeVmCost({ vcpus: 4, memMiB: 8192, agentSeconds: 900, appSeconds: 900, idleSeconds: 1800, cause: 'user_open' })
    expect(roundUsd(cost.totalUsd)).toBeCloseTo(0.22, 6)
    expect(cost.billedSeconds).toBe(1800)
    expect(cost.freeSeconds).toBe(1800)
  })
})

// ─── AC4: the workspace read ──────────────────────────────────────────

function requestAs(userId: string, path: string) {
  currentUserId = userId
  const app = computeUsageRoutes()
  return app.fetch(new Request(`http://test${path}`))
}

describe('GET /workspaces/:id/compute-usage', () => {
  test('an owner sees the split, a member sees the total only, a stranger is refused', async () => {
    // Rows come from the seeded workspace's own ingest above (agent + idle in
    // the current month, 2 vCPU / 4 GiB).
    const owner = await requestAs(seeded.owner, `/workspaces/${seeded.workspaceId}/compute-usage`)
    expect(owner.status).toBe(200)
    const ownerBody: any = await owner.json()
    expect(ownerBody.mode).toBe('shadow')
    expect(ownerBody.totals.totalVmHours).toBeGreaterThan(0)
    expect(ownerBody.totals.estimatedUsd).toBeGreaterThan(0)
    expect(Array.isArray(ownerBody.byProject)).toBe(true)
    expect(Array.isArray(ownerBody.bySize)).toBe(true)
    expect(Array.isArray(ownerBody.byState)).toBe(true)
    expect(Array.isArray(ownerBody.daily)).toBe(true)
    // The idle half of the hour is reported as metered and not billed.
    const idle = ownerBody.byState.find((s: any) => s.state === 'idle')
    expect(idle.billed).toBe(false)
    expect(idle.vmHours).toBeGreaterThan(0)
    // The split names the project the VM belonged to.
    expect(ownerBody.byProject.map((p: any) => p.name)).toContain('Billing Bot')

    const member = await requestAs(seeded.member, `/workspaces/${seeded.workspaceId}/compute-usage`)
    expect(member.status).toBe(200)
    const memberBody: any = await member.json()
    expect(memberBody.totals.estimatedUsd).toBe(ownerBody.totals.estimatedUsd)
    expect(memberBody.byProject).toBeUndefined()
    expect(memberBody.bySize).toBeUndefined()
    expect(memberBody.byState).toBeUndefined()
    expect(memberBody.runningNow).toBeUndefined()

    const stranger = await requestAs(seeded.outsider, `/workspaces/${seeded.workspaceId}/compute-usage`)
    expect(stranger.status).toBe(403)

    const missing = await requestAs(seeded.owner, '/workspaces/ws_does_not_exist/compute-usage')
    expect([403, 404]).toContain(missing.status)
  })

  test('the total is the price of the rows, not an average of them', async () => {
    const res = await requestAs(seeded.owner, `/workspaces/${seeded.workspaceId}/compute-usage`)
    const body: any = await res.json()
    const rows = (await rowsFor(seeded.workspaceId)).filter((r: any) => r.hour >= new Date(Date.UTC(2026, 10, 1)))
    const expected = rows.reduce(
      (sum: number, r: any) =>
        sum +
        computeVmCost({
          vcpus: r.vcpus,
          memMiB: r.memMiB,
          agentSeconds: r.agentSeconds,
          appSeconds: r.appSeconds,
          idleSeconds: r.idleSeconds,
          cause: r.cause,
        }).totalUsd,
      0,
    )
    expect(body.totals.estimatedUsd).toBeCloseTo(roundUsd(expected), 6)
  })
})

// ─── AC4: the fleet read ──────────────────────────────────────────────

describe('GET /api/admin/compute', () => {
  test('is super-admin only, and answers the fleet numbers', async () => {
    const asUser = async (userId: string) => {
      currentUserId = userId
      const app = adminRoutes()
      return app.fetch(new Request('http://test/compute'))
    }

    expect((await asUser(seeded.owner)).status).toBe(403)
    const su = await asUser(superAdmin)
    expect(su.status).toBe(200)
    const body: any = await su.json()
    // `{ ok, data }` — the admin app's fetchAdminJson unwraps `.data`.
    expect(body.ok).toBe(true)
    expect(body.data.mode).toBe('shadow')
    expect(body.data.totals.vmHours).toBeGreaterThan(0)
    expect(body.data.totals.stampedUsd).toBeGreaterThan(0)
    expect(Array.isArray(body.data.byCause)).toBe(true)
    expect(body.data.byCause.map((c: any) => c.cause)).toContain('user_open')
    expect(Array.isArray(body.data.topWorkspaces)).toBe(true)
    // `adminComputeSummary` builds `reconciliation: reconcile()` without
    // awaiting it, so the promise serialises to `{}` and the panel's own
    // "this is the point of the panel" line never reaches the client.
    expect(Object.keys(body.data.reconciliation ?? {})).toEqual([
      'hostsReportingUsage',
      'hostsMissingMeter',
    ])
    expect(body.data.reconciliation.hostsReportingUsage).toBeGreaterThan(0)
    // Host cost is the fleet size × the monthly host price, both present so the
    // margin line means something.
    expect(typeof body.data.fleet.hostCostUsd).toBe('number')
  })

  test('the fleet summary counts the idle tail as overhead, not revenue', async () => {
    const summary = await adminComputeSummary()
    expect(summary.totals.idleVmHours).toBeGreaterThan(0)
    expect(summary.totals.platformOverheadUsd).toBeGreaterThan(0)
    expect(summary.totals.billableUsd).toBeGreaterThan(0)
  })
})

// ─── AC5: the size purchase is gone ───────────────────────────────────

describe('the flat instance-size purchase is retired', () => {
  const apiRoot = join(import.meta.dir, '..')

  test('the checkout route answers 410 with a reason a cached client can read', () => {
    const source = readFileSync(join(apiRoot, 'server.ts'), 'utf8')
    const start = source.indexOf("app.post('/api/billing/instance-checkout'")
    expect(start).toBeGreaterThan(0)
    const handler = source.slice(start, start + 1200)
    expect(handler).toContain('410')
    expect(handler).toContain('instance_sizes_retired')
    // The Stripe checkout it used to create must be gone, not merely bypassed.
    expect(handler).not.toContain('stripe.checkout.sessions.create')
  })

  test('no client still offers a size to buy', () => {
    const mobile = join(apiRoot, '..', '..', 'mobile')
    const files = [
      'lib/api.ts',
      'components/settings/ComputeTab.tsx',
      'app/(app)/settings.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(join(mobile, file), 'utf8')
      expect(source, file).not.toContain('createInstanceCheckout')
      expect(source, file).not.toContain('InstanceComparisonTable')
    }
  })
})
