// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Change capture, the pusher and the cloud ingest, against real behaviour rather
 * than mocks of the code under test (SHO-185):
 *
 *   • the triggers run on a real SQLite database, so `updateMany`, `deleteMany`
 *     and raw SQL are proven to be captured — that was the whole reason for
 *     choosing triggers over a Prisma extension;
 *   • the pusher runs against an in-memory database and a fake `fetch`, so its
 *     batching, coalescing, cursor advance and epoch handling are exercised;
 *   • the ingest runs against an in-memory Prisma-shaped gateway, so ownership,
 *     rewrites and unknown-column handling are exercised without a Postgres.
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { installSyncTriggers, triggerStatements } from '../machine-sync/triggers.ts'
import { MachineSyncPusher, type SyncBatchRequest } from '../machine-sync/pusher.ts'
import { applyBatch, deleteMachineCopy, normaliseRow } from '../machine-sync/ingest.ts'
import { applyRewrites } from '../machine-sync/models.ts'

// ─── Triggers, on a real SQLite database ────────────────────────────────────

function tinyDatabase(): { db: Database; execute: (sql: string) => Promise<unknown> } {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE "machine_sync_changes" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  // The two tables the tests drive; the rest of the mirror set has no table in
  // this fixture, which is exactly the "older database" case the installer skips.
  db.run(`CREATE TABLE "chat_messages" ("id" TEXT PRIMARY KEY, "sessionId" TEXT, "content" TEXT, "role" TEXT)`)
  db.run(`CREATE TABLE "projects" ("id" TEXT PRIMARY KEY, "name" TEXT)`)
  return {
    db,
    execute: async (sql: string) => {
      db.run(sql)
      return null
    },
  }
}

describe('change capture triggers', () => {
  test('install skips models whose table is missing instead of failing boot', async () => {
    const { db, execute } = tinyDatabase()
    const result = await installSyncTriggers({ $executeRawUnsafe: execute })
    expect(result.installed).toBe(6) // three triggers each for two tables
    expect(result.skipped.length).toBeGreaterThan(50)
    db.close()
  })

  test('insert, update, deleteMany and raw SQL all land in the change log', async () => {
    const { db, execute } = tinyDatabase()
    await installSyncTriggers({ $executeRawUnsafe: execute })

    db.run(`INSERT INTO "chat_messages" ("id","sessionId","content","role") VALUES ('m1','s1','hi','user')`)
    db.run(`UPDATE "chat_messages" SET "content"='hello' WHERE "id"='m1'`)
    // `updateMany` shape: one statement touching several rows.
    db.run(`INSERT INTO "chat_messages" ("id","sessionId","content","role") VALUES ('m2','s1','x','user')`)
    db.run(`UPDATE "chat_messages" SET "role"='assistant' WHERE "sessionId"='s1'`)
    // `deleteMany` shape.
    db.run(`DELETE FROM "chat_messages" WHERE "sessionId"='s1'`)
    // Raw SQL is captured too — the reason triggers were chosen.
    db.run(`INSERT INTO "projects" ("id","name") VALUES ('p1','Project')`)

    const rows = db.query(`SELECT "model","recordId","op" FROM "machine_sync_changes" ORDER BY "seq"`).all() as Array<{
      model: string
      recordId: string
      op: string
    }>
    expect(rows).toEqual([
      { model: 'ChatMessage', recordId: 'm1', op: 'upsert' },
      { model: 'ChatMessage', recordId: 'm1', op: 'upsert' },
      { model: 'ChatMessage', recordId: 'm2', op: 'upsert' },
      { model: 'ChatMessage', recordId: 'm1', op: 'upsert' },
      { model: 'ChatMessage', recordId: 'm2', op: 'upsert' },
      { model: 'ChatMessage', recordId: 'm1', op: 'delete' },
      { model: 'ChatMessage', recordId: 'm2', op: 'delete' },
      { model: 'Project', recordId: 'p1', op: 'upsert' },
    ])
    db.close()
  })

  test('installing twice is a no-op', async () => {
    const { db, execute } = tinyDatabase()
    await installSyncTriggers({ $executeRawUnsafe: execute })
    const second = await installSyncTriggers({ $executeRawUnsafe: execute })
    expect(second.installed).toBe(6)
    db.close()
  })

  test('a trigger only ever writes the model name and id', () => {
    const statements = triggerStatements('ChatMessage')
    expect(statements[0]).toContain(`AFTER INSERT ON "chat_messages"`)
    expect(statements[2]).toContain(`AFTER DELETE ON "chat_messages"`)
    expect(statements[2]).toContain(`OLD."id"`)
  })
})

// ─── The pusher ────────────────────────────────────────────────────────────

type FakeRow = Record<string, unknown>

function fakeDesktopDb(options: { rows?: Record<string, FakeRow[]>; changes?: FakeRow[]; seedState?: boolean } = {}) {
  const changes: FakeRow[] = options.changes ?? []
  const tables = new Map<string, Map<string, FakeRow>>()
  for (const [model, rows] of Object.entries(options.rows ?? {})) {
    tables.set(model, new Map(rows.map((row) => [String(row.id), row])))
  }
  const state: FakeRow & { instanceId: string } = {
    instanceId: 'inst-1',
    epoch: 'epoch-1',
    cursor: 0,
    enabled: true,
    lastIngestAt: null,
  }
  let seededState = options.seedState ?? (Boolean(options.rows) || Boolean(options.changes))

  const delegate = (name: string) => {
    if (name === 'machineSyncChange') {
      return {
        findFirst: async () => [...changes].sort((a, b) => Number(b.seq) - Number(a.seq))[0] ?? null,
        findMany: async (args: any) => {
          const after = args?.where?.seq?.gt ?? 0
          return changes
            .filter((change) => Number(change.seq) > Number(after))
            .sort((a, b) => Number(a.seq) - Number(b.seq))
            .slice(0, args?.take ?? changeCount)
        },
        deleteMany: async (args: any) => {
          const upto = args?.where?.seq?.lte ?? 0
          for (let i = changes.length - 1; i >= 0; i--) {
            if (Number(changes[i].seq) <= Number(upto)) changes.splice(i, 1)
          }
          return { count: 0 }
        },
      }
    }
    if (name === 'machineSyncState') {
      return {
        findUnique: async () => (seededState ? { ...state } : null),
        create: async ({ data }: any) => {
          Object.assign(state, data)
          seededState = true
          return { ...state }
        },
        update: async ({ data }: any) => {
          Object.assign(state, data)
          return { ...state }
        },
      }
    }
    const table = tables.get(name) ?? new Map<string, FakeRow>()
    tables.set(name, table)
    return {
      findMany: async (args: any) => {
        const ids: string[] = args?.where?.id?.in ?? [...table.keys()]
        const rows = ids.map((id) => table.get(id)).filter(Boolean) as FakeRow[]
        return args?.orderBy?.id === 'asc' ? rows.sort((a, b) => String(a.id).localeCompare(String(b.id))) : rows
      },
    }
  }

  const changeCount = 5_000
  const db: any = new Proxy(
    {
      $transaction: async (fn: any) => fn(db),
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop]
        return delegate(prop)
      },
    },
  )

  return { db, changes, state, tables }
}

function rowSeq(changes: FakeRow[], model: string, recordId: string, op = 'upsert') {
  const seq = changes.length ? Math.max(...changes.map((change) => Number(change.seq))) + 1 : 1
  changes.push({ seq, model, recordId, op })
  return seq
}

describe('the pusher', () => {
  let posted: SyncBatchRequest[] = []
  let responses: Array<{ status: number; body: unknown }> = []

  beforeEach(() => {
    posted = []
    responses = []
  })

  function fakeFetch(): typeof fetch {
    return (async (_url: string, init: any) => {
      posted.push(JSON.parse(init.body))
      const next = responses.shift() ?? { status: 200, body: { ok: true, cursor: 0 } }
      return new Response(JSON.stringify(next.body), { status: next.status })
    }) as unknown as typeof fetch
  }

  test('pushes the current row state, not the ops, and advances the cursor', async () => {
    const { db, changes, state } = fakeDesktopDb({
      rows: { chatMessage: [{ id: 'm1', sessionId: 's1', content: 'hello' }] },
    })
    rowSeq(changes, 'ChatMessage', 'm1')
    rowSeq(changes, 'ChatMessage', 'm1')
    responses = [{ status: 200, body: { ok: true, cursor: 2 } }]

    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl: fakeFetch(),
    })
    await pusher.tick()

    expect(posted).toHaveLength(1)
    expect(posted[0].mode).toBe('changes')
    expect(posted[0].epoch).toBe('epoch-1')
    expect(posted[0].cursor).toBe(2)
    // Coalesced: two changes to one row are one row in the batch.
    expect(posted[0].models).toEqual([
      { model: 'ChatMessage', rows: [{ id: 'm1', sessionId: 's1', content: 'hello' }] },
    ])
    // Acked changes are pruned so the log does not grow.
    expect(changes).toHaveLength(0)
    expect(state.cursor).toBe(2)
  })

  test('start() starts the pusher and schedules a tick', async () => {
    const { db } = fakeDesktopDb()
    const lines: string[] = []
    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl: fakeFetch(),
      log: (line) => lines.push(line),
    })

    await pusher.start()

    expect(pusher.status.running).toBe(true)
    expect(lines).toContain('[MachineSync] Pusher started')
    pusher.stop()
  })

  test('a desktop that has never pushed sends a full snapshot', async () => {
    // A fresh install: the rows exist, but the triggers were installed after
    // they were written, so the change log is empty and only a snapshot can
    // bring them across.
    const { db } = fakeDesktopDb({
      rows: { workspace: [{ id: 'w1', name: 'Samsara', slug: 'samsara' }] },
      seedState: false,
    })

    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl: fakeFetch(),
    })
    await pusher.tick()

    expect(posted.length).toBeGreaterThan(0)
    expect(posted.every((request) => request.mode === 'snapshot')).toBe(true)
    expect(posted.some((request) =>
      request.models.some((model) => model.model === 'Workspace' && model.rows[0]?.id === 'w1'),
    )).toBe(true)
    // The last request claims the epoch, so the delta stream starts from here.
    expect(posted[posted.length - 1].snapshot).toEqual({ complete: true, models: expect.any(Array) })
  })

  test('a delete for a row that no longer exists becomes a delete, not an upsert', async () => {
    const { db, changes } = fakeDesktopDb({ rows: { chatMessage: [] } })
    rowSeq(changes, 'ChatMessage', 'gone')
    responses = [{ status: 200, body: { ok: true, cursor: 1 } }]

    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl: fakeFetch(),
    })
    await pusher.tick()

    expect(posted[0].models).toEqual([])
    expect(posted[0].deletes).toEqual([{ model: 'ChatMessage', recordId: 'gone' }])
  })

  test('an epoch mismatch starts a full snapshot', async () => {
    const { db, changes } = fakeDesktopDb({
      rows: { workspace: [{ id: 'w1', name: 'Personal', slug: 'personal' }] },
    })
    rowSeq(changes, 'Workspace', 'w1')
    responses = [
      { status: 409, body: { error: { code: 'epoch_mismatch' } } },
      // the snapshot pages, then the completion request
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]

    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl: fakeFetch(),
    })
    await pusher.tick()
    await pusher.tick()

    const snapshot = posted.filter((batch) => batch.mode === 'snapshot')
    expect(snapshot.length).toBeGreaterThan(0)
    expect(snapshot[0].models[0].model).toBe('Workspace')
    const last = posted[posted.length - 1]
    expect(last.snapshot?.complete).toBe(true)
  })

  /**
   * A cloud stub that enforces the same rule as `applyBatch`: a delta under an
   * epoch the cloud does not hold is refused, and the desktop has to snapshot
   * again. Any refusal is recorded, because one after the first snapshot is the
   * bug this suite exists for (SHO-188).
   */
  function epochRuleFetch(cloud: { epoch: string | null; cursor: number }, rejections: SyncBatchRequest[]) {
    return (async (_url: string, init: any) => {
      const body = JSON.parse(init.body) as SyncBatchRequest
      posted.push(body)
      if (body.mode === 'changes') {
        if (cloud.epoch && body.epoch && cloud.epoch !== body.epoch) {
          rejections.push(body)
          return new Response(JSON.stringify({ error: { code: 'epoch_mismatch' } }), { status: 409 })
        }
        cloud.cursor = body.cursor
        return new Response(JSON.stringify({ ok: true, cursor: body.cursor }), { status: 200 })
      }
      cloud.epoch = body.epoch
      if (body.snapshot?.complete) cloud.cursor = body.cursor
      return new Response(JSON.stringify({ ok: true, cursor: body.cursor }), { status: 200 })
    }) as unknown as typeof fetch
  }

  test('a snapshot adopts its epoch locally, so later deltas are not refused', async () => {
    const { db, changes, state } = fakeDesktopDb({
      rows: { workspace: [{ id: 'w1', name: 'Samsara', slug: 'samsara' }] },
      seedState: false,
    })
    const cloud = { epoch: null as string | null, cursor: 0 }
    const rejections: SyncBatchRequest[] = []
    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl: epochRuleFetch(cloud, rejections),
    })

    // The first push is a snapshot under a brand new epoch.
    await pusher.tick()
    expect(posted.every((batch) => batch.mode === 'snapshot')).toBe(true)
    const snapshots = posted.filter((batch) => batch.mode === 'snapshot').length
    // The desktop keeps the epoch the cloud just claimed. Without this the next
    // delta goes out under the pre-snapshot epoch and every change costs a
    // full snapshot, forever.
    expect(state.epoch).toBe(cloud.epoch as string)

    // A local write after the snapshot is a plain delta: pushed, accepted, and
    // no second snapshot.
    rowSeq(changes, 'Workspace', 'w1')
    await pusher.tick()

    expect(rejections).toHaveLength(0)
    expect(posted.filter((batch) => batch.mode === 'snapshot')).toHaveLength(snapshots)
    const delta = posted[posted.length - 1]
    expect(delta.mode).toBe('changes')
    expect(delta.epoch).toBe(cloud.epoch as string)
    expect(delta.models).toEqual([{ model: 'Workspace', rows: [expect.objectContaining({ id: 'w1' })] }])
  })

  test('a row written while the snapshot pages are read is replayed, not pruned', async () => {
    const { db, changes, state, tables } = fakeDesktopDb({
      rows: { workspace: [{ id: 'w1', name: 'Samsara', slug: 'samsara' }] },
      seedState: false,
    })
    const cloud = { epoch: null as string | null, cursor: 0 }
    const rejections: SyncBatchRequest[] = []
    const inner = epochRuleFetch(cloud, rejections)
    // A desktop write that lands between the snapshot's first page and its
    // completion request: the page it belongs to has already been read.
    let wrote = false
    const fetchImpl = (async (url: string, init: any) => {
      if (!wrote) {
        wrote = true
        tables.get('workspace')!.set('w2', { id: 'w2', name: 'Later', slug: 'later' })
        rowSeq(changes, 'Workspace', 'w2')
      }
      return inner(url, init)
    }) as unknown as typeof fetch

    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl,
    })
    await pusher.tick()

    // The snapshot claims only what existed before its pages, so the racing
    // change is still in the log rather than deleted unsent.
    expect(state.cursor).toBe(0)
    expect(changes.map((change) => change.recordId)).toEqual(['w2'])

    await pusher.tick()
    const delta = posted[posted.length - 1]
    expect(delta.mode).toBe('changes')
    expect(delta.models).toEqual([{ model: 'Workspace', rows: [expect.objectContaining({ id: 'w2' })] }])
    expect(rejections).toHaveLength(0)
  })

  test('a delete made while the snapshot pages are read is replayed, not pruned', async () => {
    const { db, changes, state, tables } = fakeDesktopDb({
      rows: {
        workspace: [
          { id: 'w1', name: 'Samsara', slug: 'samsara' },
          { id: 'w2', name: 'Scratch', slug: 'scratch' },
        ],
      },
      seedState: false,
    })
    const cloud = { epoch: null as string | null, cursor: 0 }
    const rejections: SyncBatchRequest[] = []
    const inner = epochRuleFetch(cloud, rejections)
    // The Workspace page has already been read (and sent) when this delete
    // lands, so the cloud holds w2 from the snapshot itself: only a replayed
    // delta can take it away again.
    let removed = false
    const fetchImpl = (async (url: string, init: any) => {
      if (!removed) {
        removed = true
        tables.get('workspace')!.delete('w2')
        rowSeq(changes, 'Workspace', 'w2', 'delete')
      }
      return inner(url, init)
    }) as unknown as typeof fetch

    const pusher = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => 'inst-1',
      fetchImpl,
    })
    await pusher.tick()

    // The delete was not part of the snapshot's pages' honest content, so it
    // must stay in the log rather than be pruned unsent.
    expect(state.cursor).toBe(0)
    expect(changes.map((change) => `${change.recordId}:${change.op}`)).toEqual(['w2:delete'])
    expect(posted.some((batch) =>
      batch.models.some((model) => model.rows.some((row) => row.id === 'w2')),
    )).toBe(true)

    await pusher.tick()
    const delta = posted[posted.length - 1]
    expect(delta.mode).toBe('changes')
    expect(delta.deletes).toEqual([{ model: 'Workspace', recordId: 'w2' }])
    expect(rejections).toHaveLength(0)
  })

  test('nothing is pushed without a device key or an instance id', async () => {
    const { db, changes } = fakeDesktopDb({ rows: { chatMessage: [] } })
    rowSeq(changes, 'ChatMessage', 'm1')

    const noKey = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => null,
      getInstanceId: () => 'inst-1',
      fetchImpl: fakeFetch(),
    })
    await noKey.tick()
    expect(posted).toHaveLength(0)

    const noInstance = new MachineSyncPusher({
      prisma: db,
      getCloudUrl: () => 'https://studio.example',
      getApiKey: () => 'key-1',
      getInstanceId: () => null,
      fetchImpl: fakeFetch(),
    })
    await noInstance.tick()
    expect(posted).toHaveLength(0)
  })
})

// ─── The cloud ingest ──────────────────────────────────────────────────────

function fakeCloudDb(options: { owned?: Record<string, string>; cloudRows?: Record<string, string[]> } = {}) {
  const tables = new Map<string, Map<string, FakeRow>>()
  const mirror = new Map<string, { model: string; recordId: string; instanceId: string; epoch: string }>()
  for (const [key, instanceId] of Object.entries(options.owned ?? {})) {
    const [model, recordId] = key.split('|')
    mirror.set(key, { model, recordId, instanceId, epoch: 'old' })
  }
  for (const [model, ids] of Object.entries(options.cloudRows ?? {})) {
    const table = new Map<string, FakeRow>()
    for (const id of ids) table.set(id, { id })
    tables.set(model, table)
  }
  const state: FakeRow = { instanceId: 'inst-1', epoch: 'epoch-1', cursor: 0, enabled: true, lastIngestAt: null }
  const members: FakeRow[] = []

  const table = (name: string) => {
    let found = tables.get(name)
    if (!found) {
      found = new Map()
      tables.set(name, found)
    }
    return found
  }

  const db: any = new Proxy(
    { $transaction: async (fn: any) => fn(db) },
    {
      get(target, prop: string) {
        if (prop in target) return (target as any)[prop]
        if (prop === 'machineSyncState') {
          return {
            findUnique: async () => ({ ...state }),
            upsert: async ({ create, update }: any) => {
              Object.assign(state, state.created ? update : { ...create, created: true })
              state.created = true
              return { ...state }
            },
          }
        }
        if (prop === 'machineMirrorRow') {
          return {
            findMany: async ({ where }: any) => {
              let rows = [...mirror.values()]
              if (where?.instanceId) rows = rows.filter((row) => row.instanceId === where.instanceId)
              if (where?.epoch?.not) rows = rows.filter((row) => row.epoch !== where.epoch.not)
              if (where?.recordId?.in) rows = rows.filter((row) => where.recordId.in.includes(row.recordId))
              return rows
            },
            upsert: async ({ where, create, update }: any) => {
              const key = `${where.model_recordId.model}|${where.model_recordId.recordId}`
              const next = mirror.has(key) ? { ...mirror.get(key)!, ...update } : { ...create }
              mirror.set(key, next)
              return next
            },
            deleteMany: async ({ where }: any) => {
              for (const [key, row] of [...mirror]) {
                if (where?.instanceId && row.instanceId !== where.instanceId) continue
                if (where?.epoch?.not && row.epoch === where.epoch.not) continue
                if (where?.model && row.model !== where.model) continue
                if (where?.recordId && row.recordId !== where.recordId) continue
                mirror.delete(key)
              }
              return { count: 0 }
            },
          }
        }
        if (prop === 'member') {
          return {
            findFirst: async ({ where }: any) =>
              members.find(
                (row) =>
                  row.workspaceId === where.workspaceId &&
                  row.userId === where.userId &&
                  (row.projectId ?? null) === (where.projectId ?? null),
              ) ?? null,
            create: async ({ data }: any) => {
              members.push(data)
              return data
            },
          }
        }
        // Any other model: a plain table keyed by id.
        const rows = table(prop)
        return {
          findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
          findMany: async ({ where }: any) => {
            const ids: string[] = where?.id?.in ?? [...rows.keys()]
            return ids.map((id) => rows.get(id)).filter(Boolean)
          },
          upsert: async ({ where, create, update }: any) => {
            const existing = rows.get(where.id)
            const next = existing ? { ...existing, ...update } : { ...create }
            rows.set(where.id, next)
            return next
          },
          deleteMany: async ({ where }: any) => {
            const ids: string[] = where?.id?.in ?? (where?.id ? [where.id] : [...rows.keys()])
            let count = 0
            for (const id of ids) if (rows.delete(id)) count++
            return { count }
          },
          update: async ({ where, data }: any) => {
            const next = { ...(rows.get(where.id) ?? { id: where.id }), ...data }
            rows.set(where.id, next)
            return next
          },
        }
      },
    },
  )

  return { db, mirror, syncState: state, members, tables }
}

const ingestCtx = (db: any) => ({
  prisma: db,
  instanceId: 'inst-1',
  ownerUserId: 'cloud-user-1',
  homeRegion: 'us-ashburn-1',
})

describe('the ingest', () => {
  test('drops columns the cloud does not have and fills what an older desktop omitted', () => {
    const meta = {
      model: {
        name: 'Workspace',
        table: 'workspaces',
        fields: [],
        compoundUniques: [],
        compoundId: [],
        indexes: [],
      },
      columns: new Set(['id', 'name', 'slug']),
      required: [{ name: 'name', type: 'String' as const }],
      hasWorkspaceId: false,
      order: 0,
    }
    const row = normaliseRow('Workspace', { id: 'w1', slug: 'personal', fromTheFuture: true }, meta as any)
    expect(row).toEqual({ id: 'w1', slug: 'personal', name: '' })
  })

  test('a row with no id is refused', () => {
    const meta = { columns: new Set(['id']), required: [], model: { fields: [] } } as any
    expect(normaliseRow('Workspace', { name: 'x' }, meta)).toBeNull()
  })

  test('rewrites the two globals and tags the workspace', () => {
    const workspace = applyRewrites(
      'Workspace',
      { id: 'w1', slug: 'personal', homeRegion: null },
      { instanceId: 'inst-abcdef123456', homeRegion: 'eu-frankfurt-1' },
    )
    expect(workspace.slug).toBe('personal-m-inst-abc')
    expect(workspace.machineInstanceId).toBe('inst-abcdef123456')
    expect(workspace.homeRegion).toBe('eu-frankfurt-1')

    const user = applyRewrites('User', { id: 'u1', email: 'local@shogo.local' }, {
      instanceId: 'inst-1',
      homeRegion: 'us',
    })
    expect(user.email).toBe('u1@machines.shogo.invalid')
  })

  test('stores a workspace with the desktop id and adds the owner as a member', async () => {
    const { db, members, tables } = fakeCloudDb()
    const result = await applyBatch(ingestCtx(db), {
      epoch: 'epoch-1',
      mode: 'changes',
      cursor: 1,
      models: [
        {
          model: 'Workspace',
          rows: [{ id: 'w1', name: 'Personal', slug: 'personal', homeRegion: null }],
        },
      ],
    })

    expect('ok' in result && result.ok).toBe(true)
    expect(tables.get('workspace')?.get('w1')).toMatchObject({
      id: 'w1',
      machineInstanceId: 'inst-1',
      homeRegion: 'us-ashburn-1',
    })
    expect(members).toEqual([
      { workspaceId: 'w1', userId: 'cloud-user-1', role: 'owner', isBillingAdmin: false },
    ])
  })

  test('a row owned by another machine rejects the whole batch', async () => {
    const { db } = fakeCloudDb({ owned: { 'Workspace|w1': 'inst-OTHER' } })
    const result = await applyBatch(ingestCtx(db), {
      epoch: 'epoch-1',
      mode: 'changes',
      models: [{ model: 'Workspace', rows: [{ id: 'w1', name: 'Stolen', slug: 'stolen' }] }],
    })
    expect('code' in result && result.code).toBe('mirror_ownership')
  })

  test('a row that already exists in the cloud and is not this machine rejects the batch', async () => {
    const { db } = fakeCloudDb({ cloudRows: { workspace: ['w1'] } })
    const result = await applyBatch(ingestCtx(db), {
      epoch: 'epoch-1',
      mode: 'changes',
      models: [{ model: 'Workspace', rows: [{ id: 'w1', name: 'Mine now', slug: 'mine' }] }],
    })
    expect('code' in result && result.code).toBe('mirror_ownership')
  })

  test('a delta under a stale epoch asks for a snapshot', async () => {
    const { db } = fakeCloudDb()
    const result = await applyBatch(ingestCtx(db), {
      epoch: 'from-a-deleted-database',
      mode: 'changes',
      models: [],
    })
    expect('code' in result && result.code).toBe('epoch_mismatch')
  })

  test('a child row pointing at a workspace this machine does not own is refused', async () => {
    const { db } = fakeCloudDb()
    const result = await applyBatch(ingestCtx(db), {
      epoch: 'epoch-1',
      mode: 'changes',
      models: [{ model: 'Project', rows: [{ id: 'p1', name: 'P', workspaceId: 'someone-else' }] }],
    })
    expect('code' in result && result.code).toBe('workspace_ownership')
  })

  test('a delete only removes a row this machine owns', async () => {
    const { db, tables } = fakeCloudDb({ owned: { 'ChatMessage|mine': 'inst-1' } })
    const workspaceTable = tables.get('chatMessage') ?? new Map()
    workspaceTable.set('mine', { id: 'mine' })
    workspaceTable.set('theirs', { id: 'theirs' })
    tables.set('chatMessage', workspaceTable)

    const result = await applyBatch(ingestCtx(db), {
      epoch: 'epoch-1',
      mode: 'changes',
      deletes: [
        { model: 'ChatMessage', recordId: 'mine' },
        { model: 'ChatMessage', recordId: 'theirs' },
      ],
    })

    expect('ok' in result && result.deleted).toBe(1)
    expect(workspaceTable.has('mine')).toBe(false)
    expect(workspaceTable.has('theirs')).toBe(true)
  })

  test('a completed snapshot drops rows from the previous epoch', async () => {
    const { db, mirror, tables } = fakeCloudDb({ owned: { 'ChatMessage|old-1': 'inst-1' } })
    const chat = new Map<string, FakeRow>([['old-1', { id: 'old-1' }]])
    tables.set('chatMessage', chat)

    const result = await applyBatch(ingestCtx(db), {
      epoch: 'epoch-2',
      mode: 'snapshot',
      cursor: 0,
      models: [],
      snapshot: { complete: true },
    })

    expect('ok' in result && result.ok).toBe(true)
    expect(chat.has('old-1')).toBe(false)
    expect([...mirror.keys()]).toEqual([])
  })

  test('deleting a copy leaves the sync switch off, and clears the epoch', async () => {
    const { db, mirror, tables, syncState } = fakeCloudDb({ owned: { 'Workspace|w1': 'inst-1' } })
    tables.set('workspace', new Map([['w1', { id: 'w1', name: 'Samsara' }]]))
    syncState.enabled = false
    syncState.cursor = 41
    syncState.epoch = 'epoch-1'

    const removed = await deleteMachineCopy(db, 'inst-1')

    expect(removed).toEqual({ rows: 1, workspaces: 1 })
    expect([...mirror.keys()]).toEqual([])
    // The state row survives on purpose: deleting it would let a desktop that is
    // still running recreate the copy a person just switched off.
    expect(syncState.enabled).toBe(false)
    expect(syncState.cursor).toBe(0)
    expect(syncState.epoch).toBe('')
  })
})
