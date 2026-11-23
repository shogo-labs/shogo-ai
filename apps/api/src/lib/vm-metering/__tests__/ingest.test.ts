// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * metal host meter ingest (SHO-424).
 *
 * The contract these pin, in the order they matter:
 *
 *  1. **A heartbeat received twice bills once.** The control plane's cursor is
 *     the authority; replaying a payload computes a zero delta.
 *  2. **A lost heartbeat bills the same as a delivered one.** Counters are
 *     cumulative, so the next payload carries the whole total.
 *  3. **An agent restart never bills a negative amount** — a counter that goes
 *     backwards is taken as the new delta.
 *  4. **No time is silently dropped** — sub-second remainders stay in the cursor
 *     and are metered by a later tick.
 *  5. **A VM that cannot be attributed is still cursored**, or a deleted
 *     project re-sends its whole counter history on every heartbeat.
 *
 * Driven against a fake prisma whose cursor/usage tables behave like the real
 * ones (unique keys, compare-and-swap on the counter triple).
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

interface Cursor {
  id: string
  hostId: string
  vmId: string
  assignedAt: bigint
  agentMs: bigint
  appMs: bigint
  idleMs: bigint
  lastSeenAt: Date
}

interface UsageRow {
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
}

let cursors: Cursor[] = []
let usageRows: UsageRow[] = []
let nextId = 1
let projects: Array<{ id: string; workspaceId: string }> = []
let workspaces: Array<{ id: string }> = []

const cursorKey = (hostId: string, vmId: string, assignedAt: bigint) => `${hostId}|${vmId}|${assignedAt}`

function sameTriple(c: Cursor, where: any): boolean {
  return (
    (where.agentMs === undefined || where.agentMs === c.agentMs) &&
    (where.appMs === undefined || where.appMs === c.appMs) &&
    (where.idleMs === undefined || where.idleMs === c.idleMs)
  )
}

const fakePrisma: any = {
  project: {
    findMany: async (args: any) =>
      projects.filter((p) => (args.where.id.in as string[]).includes(p.id)).map((p) => ({ ...p })),
  },
  workspace: {
    findMany: async (args: any) =>
      workspaces.filter((w) => (args.where.id.in as string[]).includes(w.id)).map((w) => ({ id: w.id })),
  },
  vmMeterCursor: {
    findUnique: async (args: any) => {
      const k = args.where.hostId_vmId_assignedAt
      return cursors.find((c) => cursorKey(c.hostId, c.vmId, c.assignedAt) === cursorKey(k.hostId, k.vmId, k.assignedAt)) ?? null
    },
    create: async (args: any) => {
      const d = args.data
      if (cursors.some((c) => cursorKey(c.hostId, c.vmId, c.assignedAt) === cursorKey(d.hostId, d.vmId, d.assignedAt))) {
        const err: any = new Error('unique')
        err.code = 'P2002'
        throw err
      }
      const row: Cursor = { id: `cur_${nextId++}`, ...d }
      cursors.push(row)
      return row
    },
    updateMany: async (args: any) => {
      const hit = cursors.filter((c) => c.id === args.where.id && sameTriple(c, args.where))
      for (const c of hit) Object.assign(c, args.data)
      return { count: hit.length }
    },
    upsert: async (args: any) => {
      const k = args.where.hostId_vmId_assignedAt
      const found = cursors.find((c) => cursorKey(c.hostId, c.vmId, c.assignedAt) === cursorKey(k.hostId, k.vmId, k.assignedAt))
      if (found) {
        Object.assign(found, args.update)
        return found
      }
      const row: Cursor = { id: `cur_${nextId++}`, ...k, ...args.create }
      cursors.push(row)
      return row
    },
    deleteMany: async (args: any) => {
      const before = cursors.length
      const liveExclusions: Array<{ vmId: string; assignedAt: bigint }> = args.where.NOT?.OR ?? []
      cursors = cursors.filter(
        (c) =>
          !(
            c.hostId === args.where.hostId &&
            c.lastSeenAt < args.where.lastSeenAt.lt &&
            !liveExclusions.some((x) => x.vmId === c.vmId && x.assignedAt === c.assignedAt)
          ),
      )
      return { count: before - cursors.length }
    },
  },
  vmUsageHour: {
    upsert: async (args: any) => {
      const w = args.where.workspaceId_projectId_hour_hostId_vcpus_memMiB_cause
      const found = usageRows.find(
        (r) =>
          r.workspaceId === w.workspaceId &&
          r.projectId === w.projectId &&
          r.hour.getTime() === w.hour.getTime() &&
          r.hostId === w.hostId &&
          r.vcpus === w.vcpus &&
          r.memMiB === w.memMiB &&
          r.cause === w.cause,
      )
      if (found) {
        found.agentSeconds += args.update.agentSeconds?.increment ?? 0
        found.appSeconds += args.update.appSeconds?.increment ?? 0
        found.idleSeconds += args.update.idleSeconds?.increment ?? 0
        return found
      }
      const row: UsageRow = {
        workspaceId: args.create.workspaceId,
        projectId: args.create.projectId,
        hour: args.create.hour,
        hostId: args.create.hostId,
        vcpus: args.create.vcpus,
        memMiB: args.create.memMiB,
        cause: args.create.cause,
        agentSeconds: args.create.agentSeconds,
        appSeconds: args.create.appSeconds,
        idleSeconds: args.create.idleSeconds,
      }
      usageRows.push(row)
      return row
    },
  },
  $transaction: async (cb: any) => cb(fakePrisma),
}

mock.module('../../../lib/prisma', () => ({ prisma: fakePrisma }))

const { advanceCounter, ingestMetalMeters, resolveRuntimeKeys, truncateToHour } = await import('../ingest')

const HOST = 'metal-us-1'
const T0 = Date.UTC(2026, 10, 18, 10, 15, 0)

function payload(fields: {
  seq?: number
  vmId?: string
  runtimeKey?: string
  assignedAt?: number
  agentMs?: number
  appMs?: number
  idleMs?: number
  vcpus?: number
  memMiB?: number
  cause?: string
  closed?: any[]
}) {
  return {
    seq: fields.seq ?? 1,
    vms: [
      {
        vmId: fields.vmId ?? 'vm-1',
        runtimeKey: fields.runtimeKey ?? 'ws:ws-1',
        assignedAt: fields.assignedAt ?? T0,
        vcpus: fields.vcpus,
        memMiB: fields.memMiB,
        cause: fields.cause,
        agentMs: fields.agentMs ?? 0,
        appMs: fields.appMs ?? 0,
        idleMs: fields.idleMs ?? 0,
      },
    ],
    closed: fields.closed ?? [],
  }
}

function totalSeconds(): { agent: number; app: number; idle: number } {
  return usageRows.reduce(
    (acc, r) => ({
      agent: acc.agent + r.agentSeconds,
      app: acc.app + r.appSeconds,
      idle: acc.idle + r.idleSeconds,
    }),
    { agent: 0, app: 0, idle: 0 },
  )
}

describe('ingestMetalMeters', () => {
  beforeEach(() => {
    cursors = []
    usageRows = []
    nextId = 1
    projects = [{ id: 'proj-1', workspaceId: 'ws-1' }]
    workspaces = [{ id: 'ws-1' }]
  })

  it('records the first payload against the hour it landed in', async () => {
    const out = await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 60_000 }), now: new Date(T0) })
    expect(out.metered).toBe(1)
    expect(usageRows).toHaveLength(1)
    expect(usageRows[0]).toMatchObject({
      workspaceId: 'ws-1',
      projectId: '',
      hour: new Date(truncateToHour(new Date(T0)).getTime()),
      hostId: HOST,
      cause: 'user_open',
      agentSeconds: 60,
    })
  })

  it('bills a replayed heartbeat once', async () => {
    const p = payload({ agentMs: 30_000, appMs: 10_000 })
    await ingestMetalMeters({ hostId: HOST, payload: p, now: new Date(T0) })
    const second = await ingestMetalMeters({ hostId: HOST, payload: p, now: new Date(T0 + 30_000) })

    expect(second.metered).toBe(0)
    expect(totalSeconds()).toEqual({ agent: 30, app: 10, idle: 0 })
  })

  it('bills a skipped heartbeat in full on the next one', async () => {
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 30_000 }), now: new Date(T0) })
    // The 30s tick is dropped entirely; the next payload carries the total.
    const out = await ingestMetalMeters({
      hostId: HOST,
      payload: payload({ seq: 3, agentMs: 90_000 }),
      now: new Date(T0 + 90_000),
    })

    expect(out.metered).toBe(1)
    expect(totalSeconds().agent).toBe(90)
  })

  it('takes a backwards counter as the new delta instead of a negative charge', async () => {
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 60_000 }), now: new Date(T0) })
    // Agent restarted: counters live in memory and start again from zero.
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 5_000 }), now: new Date(T0 + 60_000) })

    expect(totalSeconds().agent).toBe(65)
  })

  it('re-baselines the cursor on a restart so later heartbeats bill their own delta', async () => {
    // 60 s, the agent restarts and reports 5 s, then a legitimate 30 s more.
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 60_000 }), now: new Date(T0) })
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 5_000 }), now: new Date(T0 + 60_000) })
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 35_000 }), now: new Date(T0 + 90_000) })

    // 60 + 5 + 30. An accumulating cursor would read the last 35 s as a second
    // reset and bill 100 s — and keep over-billing for the process's lifetime.
    expect(totalSeconds().agent).toBe(95)
    expect(cursors[0].agentMs).toBe(BigInt(35_000))
  })

  it('keeps the sub-second remainder in the cursor', async () => {
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 500 }), now: new Date(T0) })
    expect(totalSeconds().agent).toBe(0)
    // 500ms + 700ms crosses a whole second; without the remainder the first
    // 500ms would be dropped on every tick.
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 1_200 }), now: new Date(T0 + 1_000) })
    expect(totalSeconds().agent).toBe(1)
    expect(cursors[0].agentMs).toBe(BigInt(1_000))
  })

  it('splits agent, app and idle seconds into separate columns', async () => {
    await ingestMetalMeters({
      hostId: HOST,
      payload: payload({ agentMs: 10_000, appMs: 20_000, idleMs: 30_000 }),
      now: new Date(T0),
    })
    expect(totalSeconds()).toEqual({ agent: 10, app: 20, idle: 30 })
  })

  it('accumulates a second VM heartbeat into the same hour row', async () => {
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 30_000 }), now: new Date(T0) })
    await ingestMetalMeters({ hostId: HOST, payload: payload({ seq: 2, agentMs: 60_000 }), now: new Date(T0 + 30_000) })
    expect(usageRows).toHaveLength(1)
    expect(usageRows[0].agentSeconds).toBe(60)
  })

  it('attributes a project runtime to its workspace and project', async () => {
    const out = await ingestMetalMeters({
      hostId: HOST,
      payload: payload({ runtimeKey: 'proj-1', agentMs: 30_000 }),
      now: new Date(T0),
    })
    expect(out.metered).toBe(1)
    expect(usageRows[0]).toMatchObject({ workspaceId: 'ws-1', projectId: 'proj-1' })
  })

  it('does not meter a published site VM (billed as published_hosting already)', async () => {
    const out = await ingestMetalMeters({
      hostId: HOST,
      payload: payload({ runtimeKey: 'published:env-1', agentMs: 30_000 }),
      now: new Date(T0),
    })
    expect(out.unresolved).toBe(1)
    expect(usageRows).toHaveLength(0)
  })

  it('keeps metering a VM whose workspace was deleted at zero cost, but advances its cursor', async () => {
    workspaces = []
    const out = await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 30_000 }), now: new Date(T0) })

    expect(out.unresolved).toBe(1)
    expect(usageRows).toHaveLength(0)
    // Without the cursor the deleted runtime re-sends its whole history forever.
    expect(cursors).toHaveLength(1)

    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 60_000 }), now: new Date(T0 + 30_000) })
    expect(cursors[0].agentMs).toBe(BigInt(60_000))
  })

  it('counts malformed rows without throwing, so liveness survives a bad meter', async () => {
    const out = await ingestMetalMeters({
      hostId: HOST,
      payload: { seq: 7, vms: [{ runtimeKey: 'ws:ws-1' }, null, { vmId: 'x', runtimeKey: 'ws:ws-1', assignedAt: 0 }] },
      now: new Date(T0),
    })
    expect(out.ack).toBe(7)
    expect(out.invalid).toBe(3)
    expect(usageRows).toHaveLength(0)
  })

  it('ignores a payload that is not a meter block', async () => {
    const out = await ingestMetalMeters({ hostId: HOST, payload: { nope: true }, now: new Date(T0) })
    expect(out.ack).toBe(0)
    expect(out.rows).toBe(0)
  })

  it('meters closed VMs reported in the same payload', async () => {
    const out = await ingestMetalMeters({
      hostId: HOST,
      payload: {
        seq: 2,
        vms: [],
        closed: [
          { vmId: 'vm-gone', runtimeKey: 'ws:ws-1', assignedAt: T0 - 1_000, agentMs: 60_000, endedAt: T0 },
        ],
      },
      now: new Date(T0),
    })
    expect(out.metered).toBe(1)
    expect(totalSeconds().agent).toBe(60)
  })

  it('prunes only this host cursors that have gone quiet', async () => {
    await ingestMetalMeters({ hostId: HOST, payload: payload({ agentMs: 1_000 }), now: new Date(T0) })
    await ingestMetalMeters({ hostId: 'other-host', payload: payload({ agentMs: 1_000 }), now: new Date(T0) })
    // Two days later, this host reports a different VM: the stale cursor on
    // THIS host goes, the peer host's cursor is left alone.
    await ingestMetalMeters({
      hostId: HOST,
      payload: payload({ seq: 3, vmId: 'vm-2', agentMs: 1_000 }),
      now: new Date(T0 + 2 * 24 * 3_600_000),
    })

    expect(cursors.map((c) => `${c.hostId}/${c.vmId}`).sort()).toEqual(['metal-us-1/vm-2', 'other-host/vm-1'])
  })
})

describe('advanceCounter', () => {
  it('treats a missing cursor as zero', () => {
    expect(advanceCounter(null, 1_500)).toEqual({ seconds: 1, cursorMs: 1_000 })
    expect(advanceCounter(undefined, 1_500)).toEqual({ seconds: 1, cursorMs: 1_000 })
  })

  it('keeps the sub-second remainder in the cursor', () => {
    // 1.5 s billed as 1 s, cursor at 1 s: the 0.5 s is not lost, it rides along.
    expect(advanceCounter(0, 1_500)).toEqual({ seconds: 1, cursorMs: 1_000 })
    expect(advanceCounter(1_000, 2_200)).toEqual({ seconds: 1, cursorMs: 2_000 })
  })

  it('re-baselines the cursor when the counter goes backwards (agent restart)', () => {
    // 60 s billed, then the process restarted and reports 5 s of new time.
    const restart = advanceCounter(60_000, 5_000)
    expect(restart).toEqual({ seconds: 5, cursorMs: 5_000 })
    // The point of the re-baseline: the NEXT legitimate heartbeat is above the
    // new cursor, so it bills its own delta instead of being read as another
    // reset and re-billing everything.
    expect(advanceCounter(restart.cursorMs, 35_000)).toEqual({ seconds: 30, cursorMs: 35_000 })
  })

  it('never returns a negative number of seconds', () => {
    const d = advanceCounter(5_000, 0)
    expect(d.seconds).toBe(0)
    expect(d.cursorMs).toBe(0)
  })
})

describe('resolveRuntimeKeys', () => {
  beforeEach(() => {
    projects = [{ id: 'proj-1', workspaceId: 'ws-1' }]
    workspaces = [{ id: 'ws-1' }]
  })

  it('maps a workspace runtime, a project runtime and skips published sites', async () => {
    const out = await resolveRuntimeKeys(['ws:ws-1', 'proj-1', 'published:env-9'])
    expect(out.get('ws:ws-1')).toEqual({ workspaceId: 'ws-1', projectId: '' })
    expect(out.get('proj-1')).toEqual({ workspaceId: 'ws-1', projectId: 'proj-1' })
    expect(out.get('published:env-9')).toBeNull()
  })

  it('maps a workspace-scoped project runtime', async () => {
    const out = await resolveRuntimeKeys(['ws:proj:proj-1'])
    expect(out.get('ws:proj:proj-1')).toEqual({ workspaceId: 'ws-1', projectId: 'proj-1' })
  })
})
