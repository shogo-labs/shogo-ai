// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-285 end to end: a workspace hosted on a paired desktop syncs both ways.
 *
 * The real halves are wired together — the cloud's ingest (`applyBatch`) and
 * change feed (`readHostFeed`), and the desktop's puller (`applyHostFeedPage`) —
 * over two in-memory databases, so this checks that the two sides agree on the
 * protocol, not only that each half behaves on its own:
 *
 *   AC1  a write made in the cloud reaches the desktop (same id, no mapping)
 *   AC2  a write made on the desktop reaches the cloud
 *   AC3  the same row edited on both sides converges on the later edit
 *   AC4  a message queued in the cloud while the desktop was off wakes its
 *        session on the desktop
 *   AC5  a pulled row is not pushed back up (no echo)
 *   AC6  the feed carries only the workspaces this desktop hosts
 *   AC7  a desktop snapshot never deletes what the cloud wrote
 */

import { describe, expect, test } from 'bun:test'
import { applyBatch } from '../lib/machine-sync/ingest'
import { readHostFeed } from '../lib/machine-sync/feed'
import { applyHostFeedPage } from '../lib/machine-sync/puller'
import { CHANGE_TABLE } from '../lib/machine-sync/triggers'

type Row = Record<string, any>

function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(value as string).getTime()
}

function matches(row: Row, where: any): boolean {
  if (!where) return true
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key]
    if (cond === null) {
      if (value != null) return false
      continue
    }
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as any
      if (c.in && !c.in.includes(value)) return false
      if ('not' in c && c.not === null && value == null) return false
      if ('not' in c && c.not !== null && value === c.not) return false
      if (c.gt !== undefined && !(value > c.gt)) return false
      if (c.lt !== undefined && !(timeOf(value) < timeOf(c.lt))) return false
      continue
    }
    if (value !== cond) return false
  }
  return true
}

/** A tiny Prisma-shaped database: a map of tables keyed by id. */
function memoryDb() {
  const tables = new Map<string, Map<string | number, Row>>()
  let seq = 0
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)!
  }
  const delegate = (name: string) => {
    const rows = table(name)
    return {
      findUnique: async ({ where }: any) => (rows.has(where.id) ? { ...rows.get(where.id) } : null),
      findFirst: async ({ where, orderBy }: any = {}) => {
        let out = [...rows.values()].filter((row) => matches(row, where))
        if (orderBy?.seq === 'desc') out = out.sort((a, b) => b.seq - a.seq)
        return out[0] ? { ...out[0] } : null
      },
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let out = [...rows.values()].filter((row) => matches(row, where)).map((row) => ({ ...row }))
        if (orderBy?.id === 'asc') out = out.sort((a, b) => (a.id < b.id ? -1 : 1))
        if (typeof take === 'number') out = out.slice(0, take)
        return out
      },
      create: async ({ data }: any) => {
        const row = { ...data }
        if (row.id === undefined) row.id = ++seq
        rows.set(row.id, row)
        return row
      },
      createMany: async ({ data }: any) => {
        for (const item of data) {
          const id = ++seq
          rows.set(id, { id, createdAt: new Date(0), ...item })
        }
        return { count: data.length }
      },
      upsert: async ({ where, create, update }: any) => {
        const next = rows.has(where.id) ? { ...rows.get(where.id), ...update } : { ...create }
        rows.set(where.id, next)
        return next
      },
      deleteMany: async ({ where }: any) => {
        let count = 0
        for (const [id, row] of [...rows]) {
          if (matches(row, where)) {
            rows.delete(id)
            count++
          }
        }
        return { count }
      },
    }
  }
  const db: any = new Proxy(
    {
      $transaction: async (fn: any) => fn(db),
      // The desktop puller drops the change-log rows its own writes produced.
      $executeRawUnsafe: async (sql: string, fromSeq: number, ...params: string[]) => {
        if (!sql.includes(CHANGE_TABLE)) return 0
        const changes = table('machineSyncChange')
        const pairs: Array<[string, string]> = []
        for (let i = 0; i < params.length; i += 2) pairs.push([params[i], params[i + 1]])
        let removed = 0
        for (const [key, row] of [...changes]) {
          if (row.seq > fromSeq && pairs.some(([model, id]) => row.model === model && row.recordId === id)) {
            changes.delete(key)
            removed++
          }
        }
        return removed
      },
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop]
        return delegate(prop)
      },
    },
  )
  return { db, table }
}

/**
 * The desktop's SQLite triggers, in miniature: every local write appends to the
 * change log the pusher reads.
 */
function desktopWrite(desktop: ReturnType<typeof memoryDb>, model: string, row: Row) {
  const delegateName = model.charAt(0).toLowerCase() + model.slice(1)
  desktop.table(delegateName).set(row.id, { ...row })
  const log = desktop.table('machineSyncChange')
  const seqNo = log.size + 1 + Math.floor(Math.random() * 1e6)
  log.set(seqNo, { seq: seqNo, model, recordId: row.id, op: 'upsert' })
}

/** A cloud write to a hosted workspace, with the change-log entry the cloud client adds. */
function cloudWrite(cloud: ReturnType<typeof memoryDb>, model: string, row: Row, workspaceId: string) {
  const delegateName = model.charAt(0).toLowerCase() + model.slice(1)
  cloud.table(delegateName).set(row.id, { ...row })
  const feed = cloud.table('hostSyncChange')
  const id = feed.size + 1
  feed.set(id, { id, workspaceId, model, recordId: row.id, op: 'upsert', createdAt: new Date(0) })
}

const INSTANCE = 'inst-mac'
const OWNER = 'user-russell'

function pair() {
  const cloud = memoryDb()
  const desktop = memoryDb()
  // Same id on both sides (SHO-285): the workspace and its owner.
  cloud.table('workspace').set('ws-samsara', { id: 'ws-samsara', name: 'Samsara', hostInstanceId: INSTANCE })
  cloud.table('workspace').set('ws-cloud', { id: 'ws-cloud', name: 'Acme', hostInstanceId: null })
  cloud.table('user').set(OWNER, { id: OWNER, name: 'Russell', email: 'r@example.com' })
  cloud.table('machineSyncState').set(INSTANCE, {
    id: INSTANCE,
    instanceId: INSTANCE,
    epoch: 'epoch-1',
    cursor: 0,
    enabled: true,
    lastIngestAt: new Date('2026-11-01T00:00:00Z'),
  })
  desktop.table('workspace').set('ws-samsara', { id: 'ws-samsara', name: 'Samsara' })
  desktop.table('user').set(OWNER, { id: OWNER, name: 'Russell' })
  // `machineSyncState.findUnique({ where: { instanceId } })` keys by instanceId.
  const state = cloud.table('machineSyncState')
  ;(cloud.db as any).machineSyncState = {
    findUnique: async ({ where }: any) => state.get(where.instanceId) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const next = state.has(where.instanceId) ? { ...state.get(where.instanceId), ...update } : { ...create }
      state.set(where.instanceId, next)
      return next
    },
  }
  return { cloud, desktop }
}

const ctx = (db: any) => ({ prisma: db, instanceId: INSTANCE, ownerUserId: OWNER, homeRegion: 'us-ashburn-1' })

async function pull(cloud: ReturnType<typeof memoryDb>, desktop: ReturnType<typeof memoryDb>, cursor = 0) {
  const page = await readHostFeed(cloud.db, { instanceId: INSTANCE, ownerUserId: OWNER, cursor, now: Date.now() })
  const result = await applyHostFeedPage(desktop.db, page)
  return { page, result }
}

async function push(cloud: ReturnType<typeof memoryDb>, model: string, rows: Row[], cursor: number) {
  return applyBatch(ctx(cloud.db), { epoch: 'epoch-1', mode: 'changes', cursor, models: [{ model, rows }] })
}

describe('SHO-285 — a hosted workspace syncs both ways', () => {
  test('AC1 · a card made in the cloud lands on the desktop under the same id', async () => {
    const { cloud, desktop } = pair()
    cloudWrite(
      cloud,
      'WorkItem',
      { id: 'card-1', workspaceId: 'ws-samsara', title: 'From the phone', updatedAt: new Date('2026-11-02T10:00:00Z') },
      'ws-samsara',
    )

    const { page, result } = await pull(cloud, desktop)

    expect(page.userId).toBe(OWNER)
    expect(result.applied).toBeGreaterThanOrEqual(1)
    expect(desktop.table('workItem').get('card-1')).toMatchObject({ workspaceId: 'ws-samsara', title: 'From the phone' })
  })

  test('AC2 · a card edited on the desktop lands in the cloud', async () => {
    const { cloud } = pair()
    const result = await push(
      cloud,
      'WorkItem',
      [{ id: 'card-2', workspaceId: 'ws-samsara', title: 'From the Mac', updatedAt: '2026-11-02T10:00:00Z' }],
      1,
    )
    expect(result).toMatchObject({ ok: true, applied: 1 })
    expect(cloud.table('workItem').get('card-2')).toMatchObject({ title: 'From the Mac' })
  })

  test('AC3 · the same card edited on both sides ends up with the later edit everywhere', async () => {
    const { cloud, desktop } = pair()
    // Desktop edits at :01, cloud edits at :05 (the phone, while the Mac was asleep).
    desktopWrite(desktop, 'WorkItem', {
      id: 'card-3',
      workspaceId: 'ws-samsara',
      title: 'desktop',
      updatedAt: new Date('2026-11-02T10:00:01Z'),
    })
    cloudWrite(
      cloud,
      'WorkItem',
      { id: 'card-3', workspaceId: 'ws-samsara', title: 'cloud', updatedAt: new Date('2026-11-02T10:00:05Z') },
      'ws-samsara',
    )

    // The Mac wakes: it pushes its older edit, then pulls.
    const pushed = await push(cloud, 'WorkItem', [desktop.table('workItem').get('card-3')!], 2)
    expect(pushed).toMatchObject({ ok: true, applied: 0 })
    await pull(cloud, desktop)

    expect(cloud.table('workItem').get('card-3')!.title).toBe('cloud')
    expect(desktop.table('workItem').get('card-3')!.title).toBe('cloud')
  })

  test('AC4 · a message queued in the cloud while the Mac was off wakes its session there', async () => {
    const { cloud, desktop } = pair()
    cloudWrite(
      cloud,
      'ChatQueuedMessage',
      { id: 'q-1', sessionId: 'session-1', status: 'pending', createdAt: new Date('2026-11-02T10:00:00Z') },
      'ws-samsara',
    )
    const { result } = await pull(cloud, desktop)
    expect(desktop.table('chatQueuedMessage').get('q-1')).toMatchObject({ status: 'pending' })
    expect(result.queuedSessions).toEqual(['session-1'])
  })

  test('AC5 · a row pulled from the cloud is not pushed back up', async () => {
    const { cloud, desktop } = pair()
    cloudWrite(
      cloud,
      'WorkItem',
      { id: 'card-5', workspaceId: 'ws-samsara', title: 'once', updatedAt: new Date('2026-11-02T10:00:00Z') },
      'ws-samsara',
    )
    // The desktop's triggers log the puller's own write, as SQLite would.
    const log = desktop.table('machineSyncChange')
    const realUpsert = desktop.db.workItem.upsert
    ;(desktop.db as any).workItem = {
      ...desktop.db.workItem,
      upsert: async (args: any) => {
        const out = await realUpsert(args)
        log.set(999, { seq: 999, model: 'WorkItem', recordId: args.where.id, op: 'upsert' })
        return out
      },
    }
    await pull(cloud, desktop)
    expect([...log.values()].filter((row) => row.recordId === 'card-5')).toEqual([])
  })

  test("AC6 · the feed never carries another workspace's rows", async () => {
    const { cloud, desktop } = pair()
    cloudWrite(cloud, 'WorkItem', { id: 'card-other', workspaceId: 'ws-cloud', title: 'not yours' }, 'ws-cloud')
    const { page } = await pull(cloud, desktop)
    expect(page.models).toEqual([])
    expect(desktop.table('workItem').has('card-other')).toBe(false)

    // …and the desktop cannot write one either.
    const refused = await push(cloud, 'WorkItem', [{ id: 'card-x', workspaceId: 'ws-cloud', title: 'guess' }], 3)
    expect(refused).toMatchObject({ code: 'workspace_ownership' })
  })

  test('AC7 · a full snapshot from the desktop deletes nothing the cloud wrote', async () => {
    const { cloud } = pair()
    cloudWrite(cloud, 'WorkItem', { id: 'card-cloud', workspaceId: 'ws-samsara', title: 'phone' }, 'ws-samsara')
    const done = await applyBatch(ctx(cloud.db), {
      epoch: 'epoch-2',
      mode: 'snapshot',
      cursor: 0,
      models: [],
      snapshot: { complete: true },
    })
    expect(done).toMatchObject({ ok: true, deleted: 0 })
    expect(cloud.table('workItem').has('card-cloud')).toBe(true)
  })
})
