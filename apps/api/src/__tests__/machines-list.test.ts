// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /api/machines` — one entry per machine, however many cloud workspaces it
 * registered in (SHO-87 §5).
 *
 * A desktop opens a tunnel per stored device key, so `odin` has one `instances`
 * row per workspace it is signed into. The workspace switcher must still show
 * `samasra` once, with every workspace it is in, or the fan-out turns into three
 * identical rows in the sidebar.
 *
 *   bun test apps/api/src/__tests__/machines-list.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'

type Instance = {
  id: string
  workspaceId: string
  userId: string | null
  hostname: string
  name: string
  os: string | null
  arch: string | null
  kind: string
  lastSeenAt: Date | null
  createdAt: Date
  metadata: any
  wsRequestedAt: Date | null
}

type SyncState = { instanceId: string; enabled: boolean; cursor: number; lastIngestAt: Date | null }

const rows: Instance[] = []
const workspaceNames = new Map<string, string>()
const syncStates: SyncState[] = []

const mockPrisma = {
  instance: {
    findUnique: async (args: any) => rows.find((r) => r.id === args.where.id) ?? null,
    findMany: async (args: any) => {
      const where = args?.where ?? {}
      return rows
        .filter((r) => (where.userId === undefined ? true : r.userId === where.userId))
        .filter((r) => (where.hostname === undefined ? true : r.hostname === where.hostname))
        .filter((r) => (where.kind?.not === undefined ? true : r.kind !== where.kind.not))
        .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
        .map((r) => ({ ...r }))
    },
    update: async (args: any) => {
      const row = rows.find((r) => r.id === args.where.id)
      if (row) Object.assign(row, args.data)
      return row
    },
  },
  workspace: {
    findMany: async (args: any) => {
      const ids: string[] = args?.where?.id?.in ?? []
      return ids.filter((id) => workspaceNames.has(id)).map((id) => ({ id, name: workspaceNames.get(id) as string }))
    },
    findUnique: async (args: any) => (workspaceNames.has(args.where.id) ? { id: args.where.id } : null),
  },
  remoteAction: { create: async (args: any) => args.data },
  // `GET /machines` reports `lastSyncedAt` / `syncEnabled` / `copyReady` per
  // machine (SHO-185, SHO-241).
  machineSyncState: {
    findMany: async (args: any) => {
      const ids: string[] = args?.where?.instanceId?.in ?? []
      return syncStates.filter((state) => !ids.length || ids.includes(state.instanceId)).map((s) => ({ ...s }))
    },
    findUnique: async (args: any) =>
      syncStates.find((state) => state.instanceId === args.where.instanceId) ?? null,
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => {},
  sendPushToUser: async () => {},
}))

const { machineRoutes, _testing } = await import('../routes/machines')

const OWNER = { id: 'u-1', userId: 'u-1', email: 'owner@x', role: 'member' }

function buildApp(auth: any = OWNER) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('auth', auth)
    await next()
  })
  app.route('/api', machineRoutes())
  return app
}

function seed(overrides: Partial<Instance> = {}): Instance {
  const row: Instance = {
    id: 'i-1',
    workspaceId: 'ws-personal',
    userId: 'u-1',
    hostname: 'odin',
    name: 'samasra',
    os: 'win32',
    arch: 'x64',
    kind: 'desktop',
    lastSeenAt: new Date('2026-10-20T10:00:00.000Z'),
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    metadata: {},
    wsRequestedAt: null,
    ...overrides,
  }
  rows.push(row)
  return row
}

beforeEach(() => {
  rows.length = 0
  workspaceNames.clear()
  syncStates.length = 0
  _testing.resetWakeDeadlineMs()
  _testing.setWakeDeadlineMs(120)
})

describe('GET /api/machines', () => {
  test('one machine, with every workspace it registered in', async () => {
    workspaceNames.set('ws-personal', 'Personal')
    workspaceNames.set('ws-odin', 'Odin AI')
    workspaceNames.set('ws-samsara', 'Samsara')
    seed({ id: 'i-personal', workspaceId: 'ws-personal', createdAt: new Date('2026-10-01T00:00:00.000Z') })
    seed({
      id: 'i-odin',
      workspaceId: 'ws-odin',
      lastSeenAt: new Date('2026-10-20T11:00:00.000Z'),
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
    })
    seed({ id: 'i-samsara', workspaceId: 'ws-samsara', createdAt: new Date('2026-10-03T00:00:00.000Z') })

    const res = await buildApp().fetch(new Request('http://x/api/machines'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    expect(body.machines).toHaveLength(1)
    const [machine] = body.machines
    // The representative row is the *oldest* one, not the freshest heartbeat:
    // the desktop's rows heartbeat in turn, and naming the machine by whichever
    // one spoke last handed the client a new id every few seconds (SHO-241).
    expect(machine.id).toBe('i-personal')
    expect(machine.instanceIds.sort()).toEqual(['i-odin', 'i-personal', 'i-samsara'])
    expect(machine.hostname).toBe('odin')
    expect(machine.workspaces.map((w: any) => w.name).sort()).toEqual([
      'Odin AI',
      'Personal',
      'Samsara',
    ])
  })

  test('the representative id does not move as the rows heartbeat in turn', async () => {
    seed({ id: 'i-a', createdAt: new Date('2026-10-01T00:00:00.000Z') })
    seed({ id: 'i-b', createdAt: new Date('2026-10-02T00:00:00.000Z') })
    seed({ id: 'i-c', createdAt: new Date('2026-10-03T00:00:00.000Z') })

    const seen = new Set<string>()
    for (let poll = 0; poll < 10; poll++) {
      // One row at a time is the freshest, the way nine device keys heartbeat.
      const row = rows[poll % rows.length]
      row.lastSeenAt = new Date(Date.now() + poll * 1_000)
      const body = (await (await buildApp().fetch(new Request('http://x/api/machines'))).json()) as any
      seen.add(body.machines[0].id)
    }
    expect([...seen]).toEqual(['i-a'])
  })

  test('the row that owns the copy represents the machine', async () => {
    seed({ id: 'i-a', createdAt: new Date('2026-10-01T00:00:00.000Z') })
    seed({ id: 'i-b', createdAt: new Date('2026-10-02T00:00:00.000Z') })
    syncStates.push({
      instanceId: 'i-b',
      enabled: true,
      cursor: 12,
      lastIngestAt: new Date('2026-10-20T12:00:00.000Z'),
    })

    const body = (await (await buildApp().fetch(new Request('http://x/api/machines'))).json()) as any
    const [machine] = body.machines
    expect(machine.id).toBe('i-b')
    expect(machine.copyReady).toBe(true)
    expect(machine.lastSyncedAt).toBe('2026-10-20T12:00:00.000Z')
    expect(machine.instanceIds.sort()).toEqual(['i-a', 'i-b'])
  })

  test('no completed snapshot means no copy yet', async () => {
    seed({ id: 'i-a' })
    // The desktop created its state row but never got a snapshot through: the
    // cloud has no rows for this machine, and the client has to read through the
    // relay rather than being told "No access" (SHO-241).
    syncStates.push({ instanceId: 'i-a', enabled: true, cursor: 0, lastIngestAt: null })

    const body = (await (await buildApp().fetch(new Request('http://x/api/machines'))).json()) as any
    expect(body.machines[0]).toMatchObject({ copyReady: false, lastSyncedAt: null })
  })

  test('a desktop-reported sync error is surfaced with the machine', async () => {
    seed({
      id: 'i-a',
      metadata: { machine: { workspaces: [], sync: { lastError: 'mirror_ownership', pendingChanges: 7 } } },
    })
    const body = (await (await buildApp().fetch(new Request('http://x/api/machines'))).json()) as any
    expect(body.machines[0]).toMatchObject({
      lastSyncError: 'mirror_ownership',
      pendingChanges: 7,
    })
  })

  test('two machines stay two entries', async () => {
    seed({ id: 'i-odin', hostname: 'odin' })
    seed({ id: 'i-mac', hostname: 'mac', name: 'MacBook' })
    const body = (await (await buildApp().fetch(new Request('http://x/api/machines'))).json()) as any
    expect(body.machines.map((m: any) => m.hostname).sort()).toEqual(['mac', 'odin'])
  })

  test('another member of the same workspace sees nothing', async () => {
    seed()
    const body = (await (await buildApp({ id: 'u-2', userId: 'u-2', role: 'member' }).fetch(
      new Request('http://x/api/machines'),
    )).json()) as any
    expect(body.machines).toEqual([])
  })

  test('a machine whose copy state is unreadable still lists, with the defaults', async () => {
    seed()
    const body = (await (await buildApp().fetch(new Request('http://x/api/machines'))).json()) as any
    // Sync to cloud is on until a machine says otherwise, and it has never
    // pushed — the switch and "Last synced" read these two fields.
    expect(body.machines[0]).toMatchObject({ syncEnabled: true, lastSyncedAt: null })
  })

  test('a client with no copy-state table cannot take the machine list down', async () => {
    // The copy state is a convenience, and a Prisma client generated before
    // those tables exist throws on the property *access* — before any `.catch()`
    // on the call could see it — so `GET /api/machines` used to 500 and the
    // switcher lost every machine. Reproduced here by removing the delegate.
    seed()
    const table = (mockPrisma as any).machineSyncState
    delete (mockPrisma as any).machineSyncState
    try {
      const res = await buildApp().fetch(new Request('http://x/api/machines'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.machines).toHaveLength(1)
      expect(body.machines[0]).toMatchObject({ syncEnabled: true, lastSyncedAt: null })
    } finally {
      ;(mockPrisma as any).machineSyncState = table
    }
  })
})
