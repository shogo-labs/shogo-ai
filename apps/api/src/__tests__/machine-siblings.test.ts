// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One machine, one `instances` row (SHO-241 §C).
 *
 * The cloud files a machine under the workspace its device key was issued in, so
 * a desktop that fanned out one tunnel per stored key holds a row per workspace.
 * The first heartbeat from a single-tunnel desktop retires the rest — without
 * losing what pointed at them, and without losing the cloud copy.
 *
 *   bun test apps/api/src/__tests__/machine-siblings.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

type Row = Record<string, any>

const db: Record<string, Row[]> = {
  instance: [],
  project: [],
  pushSubscription: [],
  remoteAction: [],
  machineMirrorRow: [],
  machineSyncState: [],
  workspace: [],
}

/** The subset of Prisma the sweep touches, on plain arrays. */
const mockPrisma: any = {
  $transaction: async (fn: any) => fn(mockPrisma),
  instance: {
    findMany: async ({ where }: any) =>
      db.instance
        .filter((row) => (where.userId === undefined ? true : row.userId === where.userId))
        .filter((row) => (where.hostname === undefined ? true : row.hostname === where.hostname))
        .filter((row) => (where.kind === undefined ? true : row.kind === where.kind))
        .filter((row) => (where.workspaceId === undefined ? true : row.workspaceId === where.workspaceId))
        .filter((row) => (where.id?.not === undefined ? true : row.id !== where.id.not))
        .map((row) => ({ id: row.id })),
    deleteMany: async ({ where }: any) => {
      const ids: string[] = where.id.in
      db.instance = db.instance.filter((row) => !ids.includes(row.id))
      return { count: ids.length }
    },
  },
  project: {
    updateMany: async ({ where, data }: any) => {
      const ids: string[] = where.preferredInstanceId.in
      let count = 0
      for (const row of db.project) {
        if (row.preferredInstanceId && ids.includes(row.preferredInstanceId)) {
          row.preferredInstanceId = data.preferredInstanceId
          count++
        }
      }
      return { count }
    },
  },
  workspace: {
    updateMany: async ({ where, data }: any) => {
      const ids: string[] = where.machineInstanceId.in
      let count = 0
      for (const row of db.workspace) {
        if (row.machineInstanceId && ids.includes(row.machineInstanceId)) {
          row.machineInstanceId = data.machineInstanceId
          count++
        }
      }
      return { count }
    },
  },
  pushSubscription: {
    findMany: async ({ where }: any) =>
      db.pushSubscription
        .filter((row) =>
          where.instanceId?.in
            ? where.instanceId.in.includes(row.instanceId)
            : row.instanceId === where.instanceId,
        )
        .map((row) => ({ ...row })),
    deleteMany: async ({ where }: any) => {
      const ids: string[] = where.id.in
      db.pushSubscription = db.pushSubscription.filter((row) => !ids.includes(row.id))
      return { count: ids.length }
    },
    updateMany: async ({ where, data }: any) => {
      const ids: string[] = where.instanceId.in
      let count = 0
      for (const row of db.pushSubscription) {
        if (ids.includes(row.instanceId)) {
          row.instanceId = data.instanceId
          count++
        }
      }
      return { count }
    },
  },
  remoteAction: {
    updateMany: async ({ where, data }: any) => {
      const ids: string[] = where.instanceId.in
      let count = 0
      for (const row of db.remoteAction) {
        if (ids.includes(row.instanceId)) {
          row.instanceId = data.instanceId
          count++
        }
      }
      return { count }
    },
  },
  machineMirrorRow: {
    updateMany: async ({ where, data }: any) => {
      const ids: string[] = where.instanceId.in
      let count = 0
      for (const row of db.machineMirrorRow) {
        if (ids.includes(row.instanceId)) {
          row.instanceId = data.instanceId
          count++
        }
      }
      return { count }
    },
  },
  machineSyncState: {
    findUnique: async ({ where }: any) =>
      db.machineSyncState.find((row) => row.instanceId === where.instanceId) ?? null,
    findFirst: async ({ where }: any) => {
      const ids: string[] = where.instanceId.in
      const candidates = db.machineSyncState
        .filter((row) => ids.includes(row.instanceId))
        .filter((row) => (where.lastIngestAt?.not === null ? Boolean(row.lastIngestAt) : true))
        .sort(
          (a, b) =>
            (b.lastIngestAt?.getTime() ?? 0) - (a.lastIngestAt?.getTime() ?? 0) ||
            (b.cursor ?? 0) - (a.cursor ?? 0),
        )
      return candidates[0] ? { ...candidates[0] } : null
    },
    create: async ({ data }: any) => {
      db.machineSyncState.push({ ...data })
      return data
    },
    update: async ({ where, data }: any) => {
      const row = db.machineSyncState.find((entry) => entry.instanceId === where.instanceId)
      if (row) Object.assign(row, data)
      return row
    },
    deleteMany: async ({ where }: any) => {
      const ids: string[] = where.instanceId.in
      const before = db.machineSyncState.length
      db.machineSyncState = db.machineSyncState.filter((row) => !ids.includes(row.instanceId))
      return { count: before - db.machineSyncState.length }
    },
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))

const { retireMachineSiblings, _resetMachineSiblingSweep } = await import('../lib/machine-siblings')

const KEEP = 'i-keep'

function machine(id: string, workspaceId: string, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id,
    workspaceId,
    userId: 'u-1',
    hostname: 'Russells-MacBook-Pro-2.local',
    kind: 'desktop',
    ...overrides,
  }
  db.instance.push(row)
  return row
}

const retire = () =>
  retireMachineSiblings({
    instanceId: KEEP,
    workspaceId: 'ws-personal',
    userId: 'u-1',
    hostname: 'Russells-MacBook-Pro-2.local',
    kind: 'desktop' as any,
  })

beforeEach(() => {
  for (const table of Object.keys(db)) db[table].length = 0
  _resetMachineSiblingSweep()
})

describe('retireMachineSiblings', () => {
  test('leaves one row per machine and re-points what pointed at the rest', async () => {
    // Nine rows, one per workspace device key, the way a 2.4.2 Mac registers.
    machine(KEEP, 'ws-personal')
    for (let i = 1; i < 9; i++) machine(`i-${i}`, `ws-${i}`)

    db.project.push({ id: 'p-1', preferredInstanceId: 'i-4' })
    db.pushSubscription.push({ id: 'sub-1', instanceId: 'i-6', pushToken: 'tok-1' })
    db.remoteAction.push({ id: 'act-1', instanceId: 'i-2' })
    // `machineInstanceId` is a bare column: a machine workspace tagged by the row
    // that goes away would hand the client a dead id and 404 every write.
    db.workspace.push({ id: 'ws-machine-1', machineInstanceId: 'i-3' })

    const result = await retire()

    expect(result.retired).toBe(8)
    expect(db.instance.map((row) => row.id)).toEqual([KEEP])
    expect(db.project[0].preferredInstanceId).toBe(KEEP)
    expect(db.pushSubscription[0].instanceId).toBe(KEEP)
    expect(db.remoteAction[0].instanceId).toBe(KEEP)
    expect(db.workspace[0].machineInstanceId).toBe(KEEP)
  })

  test('the cloud copy follows the row that survives', async () => {
    machine(KEEP, 'ws-personal')
    machine('i-2', 'ws-odin')
    // The pusher resolved its id from the tunnel that answered first, so the copy
    // sits on the sibling — deleting it would throw away a 1.2 GB snapshot.
    db.machineMirrorRow.push({ model: 'ChatMessage', recordId: 'm1', instanceId: 'i-2' })
    db.machineSyncState.push({
      instanceId: 'i-2',
      epoch: 'epoch-abc',
      cursor: 563_098,
      lastIngestAt: new Date('2026-10-28T05:00:00.000Z'),
      enabled: true,
    })

    await retire()

    expect(db.machineMirrorRow.map((row) => row.instanceId)).toEqual([KEEP])
    const state = db.machineSyncState.find((row) => row.instanceId === KEEP)
    expect(state).toMatchObject({ epoch: 'epoch-abc', cursor: 563_098 })
    expect(state?.lastIngestAt).toBeInstanceOf(Date)
    // One state per machine: the sibling's own row is gone.
    expect(db.machineSyncState).toHaveLength(1)
  })

  test('the freshest accepted copy wins when both rows have one', async () => {
    machine(KEEP, 'ws-personal')
    machine('i-2', 'ws-odin')
    db.machineSyncState.push({
      instanceId: KEEP,
      epoch: 'epoch-old',
      cursor: 10,
      lastIngestAt: new Date('2026-10-20T00:00:00.000Z'),
      enabled: true,
    })
    db.machineSyncState.push({
      instanceId: 'i-2',
      epoch: 'epoch-new',
      cursor: 99,
      lastIngestAt: new Date('2026-10-27T00:00:00.000Z'),
      enabled: true,
    })

    await retire()

    expect(db.machineSyncState).toHaveLength(1)
    expect(db.machineSyncState[0]).toMatchObject({ instanceId: KEEP, epoch: 'epoch-new', cursor: 99 })
  })

  test('a push token both rows already have is dropped, not duplicated', async () => {
    machine(KEEP, 'ws-personal')
    machine('i-2', 'ws-odin')
    // (instanceId, pushToken) is unique: re-pointing the twin would violate it.
    db.pushSubscription.push({ id: 'sub-keep', instanceId: KEEP, pushToken: 'tok-shared' })
    db.pushSubscription.push({ id: 'sub-dup', instanceId: 'i-2', pushToken: 'tok-shared' })
    db.pushSubscription.push({ id: 'sub-mine', instanceId: 'i-2', pushToken: 'tok-other' })

    await retire()

    expect(db.pushSubscription.map((row) => row.id).sort()).toEqual(['sub-keep', 'sub-mine'])
    expect(db.pushSubscription.every((row) => row.instanceId === KEEP)).toBe(true)
  })

  test('a cli_worker on the same host is a different thing and is left alone', async () => {
    machine(KEEP, 'ws-personal')
    machine('worker-1', 'ws-personal', { kind: 'cli_worker', hostname: 'dev-box' })
    machine('worker-2', 'ws-odin', { kind: 'cli_worker', hostname: 'dev-box' })

    const result = await retireMachineSiblings({
      instanceId: 'worker-1',
      workspaceId: 'ws-personal',
      userId: 'u-1',
      hostname: 'dev-box',
      kind: 'cli_worker' as any,
    })

    // Workers stay workspace-scoped: only the same workspace's row is a sibling.
    expect(result.retired).toBe(0)
    expect(db.instance.map((row) => row.id).sort()).toEqual([KEEP, 'worker-1', 'worker-2'])
  })

  test('sweeps a machine once per process, and does nothing when there is nothing to do', async () => {
    machine(KEEP, 'ws-personal')
    expect(await retire()).toEqual({ retired: 0 })

    // An old desktop re-creates a sibling; the sweep has already run for this
    // machine, and `/machines` grouping covers what is left.
    machine('i-2', 'ws-odin')
    expect(await retire()).toEqual({ retired: 0 })
    expect(db.instance).toHaveLength(2)
  })
})
