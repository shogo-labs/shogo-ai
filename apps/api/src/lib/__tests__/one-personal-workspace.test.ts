// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One Personal workspace per account, shared on every device (SHO-285 Update 2).
 *
 * The merge is the part that can destroy data, so it runs against a **real
 * SQLite database** through a Prisma-shaped adapter: the table walk, the
 * `workspaceId` rewrite and the row removal are real SQL, not a mock of the code
 * under test. The rewrites and the feed are pure functions over a fake gateway.
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRewrites } from '../machine-sync/models.ts'
import { readHostFeed } from '../machine-sync/feed.ts'
import { adoptCloudPersonal, mergePersonalWorkspace } from '../machine-sync/personal-workspace.ts'
import { applyHostFeedPage } from '../machine-sync/puller.ts'

// ─── A Prisma-shaped adapter over a real SQLite database ────────────────────

interface Adapter {
  db: Database
  prisma: any
}

function adapter(): Adapter {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE "workspaces" (
    "id" TEXT PRIMARY KEY, "name" TEXT, "slug" TEXT, "kind" TEXT,
    "personalOwnerId" TEXT, "hostInstanceId" TEXT, "createdAt" TEXT
  )`)
  db.run(`CREATE TABLE "members" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "userId" TEXT, "role" TEXT)`)
  db.run(`CREATE TABLE "workspace_agent_profiles" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "name" TEXT)`)
  db.run(`CREATE TABLE "projects" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "name" TEXT)`)
  db.run(`CREATE TABLE "conversations" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "title" TEXT)`)
  db.run(`CREATE TABLE "chat_messages" ("id" TEXT PRIMARY KEY, "conversationId" TEXT, "text" TEXT)`)
  db.run(`CREATE TABLE "agent_schedules" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "name" TEXT, "runOnInstanceId" TEXT)`)
  db.run(`CREATE TABLE "agent_configs" ("id" TEXT PRIMARY KEY, "projectId" TEXT, "runOnInstanceId" TEXT)`)

  const rows = (sql: string, params: unknown[] = []) => db.query(sql).all(...(params as any[])) as any[]
  const run = (sql: string, params: unknown[] = []) => db.query(sql).run(...(params as any[]))

  const delegate = (table: string) => ({
    findUnique: async ({ where }: any) => rows(`SELECT * FROM "${table}" WHERE "id" = ?`, [where.id])[0] ?? null,
    findFirst: async ({ where }: any = {}) => {
      const clauses: string[] = []
      const params: unknown[] = []
      for (const [key, value] of Object.entries(where ?? {})) {
        if (key === 'NOT') {
          clauses.push(`"id" <> ?`)
          params.push((value as any).id)
        } else if (value === null) clauses.push(`"${key}" IS NULL`)
        else {
          clauses.push(`"${key}" = ?`)
          params.push(value)
        }
      }
      const sql = `SELECT * FROM "${table}"${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`
      return rows(sql, params)[0] ?? null
    },
    findMany: async ({ where }: any = {}) => {
      const clauses: string[] = []
      const params: unknown[] = []
      for (const [key, value] of Object.entries(where ?? {})) {
        if (key === 'NOT') {
          clauses.push(`"id" <> ?`)
          params.push((value as any).id)
        } else if (value === null) clauses.push(`"${key}" IS NULL`)
        else {
          clauses.push(`"${key}" = ?`)
          params.push(value)
        }
      }
      const sql = `SELECT * FROM "${table}"${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`
      return rows(sql, params)
    },
    create: async ({ data }: any) => {
      const keys = Object.keys(data)
      run(
        `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        keys.map((key) => data[key]),
      )
      return data
    },
    update: async ({ where, data }: any) => {
      const keys = Object.keys(data)
      run(
        `UPDATE "${table}" SET ${keys.map((key) => `"${key}" = ?`).join(', ')} WHERE "id" = ?`,
        [...keys.map((key) => data[key]), where.id],
      )
      return { ...where, ...data }
    },
    delete: async ({ where }: any) => {
      run(`DELETE FROM "${table}" WHERE "id" = ?`, [where.id])
      return where
    },
    deleteMany: async ({ where }: any) => {
      const clauses: string[] = []
      const params: unknown[] = []
      for (const [key, value] of Object.entries(where ?? {})) {
        if (value === null) clauses.push(`"${key}" IS NULL`)
        else {
          clauses.push(`"${key}" = ?`)
          params.push(value)
        }
      }
      const result = run(`DELETE FROM "${table}"${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`, params)
      return { count: Number(result.changes) }
    },
    updateMany: async ({ where, data }: any) => {
      const clauses: string[] = []
      const params: unknown[] = []
      for (const [key, value] of Object.entries(where ?? {})) {
        if (value === null) clauses.push(`"${key}" IS NULL`)
        else if (value && typeof value === 'object' && 'in' in (value as any)) {
          const list = (value as any).in as unknown[]
          clauses.push(`"${key}" IN (${list.map(() => '?').join(', ')})`)
          params.push(...list)
        } else {
          clauses.push(`"${key}" = ?`)
          params.push(value)
        }
      }
      const keys = Object.keys(data)
      const result = run(
        `UPDATE "${table}" SET ${keys.map((key) => `"${key}" = ?`).join(', ')}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`,
        [...keys.map((key) => data[key]), ...params],
      )
      return { count: Number(result.changes) }
    },
  })

  const prisma: any = {
    workspace: delegate('workspaces'),
    member: delegate('members'),
    workspaceAgentProfile: delegate('workspace_agent_profiles'),
    project: delegate('projects'),
    conversation: delegate('conversations'),
    chatMessage: delegate('chat_messages'),
    agentSchedule: delegate('agent_schedules'),
    agentConfig: delegate('agent_configs'),
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => rows(sql, params),
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => Number(run(sql, params).changes),
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(prisma),
  }
  return { db, prisma }
}

function seedPersonal(a: Adapter, opts: { id: string; name: string; owner?: string | null; createdAt: string }) {
  a.db.run(
    `INSERT INTO "workspaces" ("id","name","slug","kind","personalOwnerId","hostInstanceId","createdAt")
     VALUES (?,?,?,?,?,?,?)`,
    [opts.id, opts.name, `user-${opts.id}-personal`, 'personal', opts.owner ?? null, null, opts.createdAt],
  )
}

// ─── The merge ──────────────────────────────────────────────────────────────

describe('mergePersonalWorkspace', () => {
  let a: Adapter
  beforeEach(() => {
    a = adapter()
    seedPersonal(a, { id: 'cloud-personal', name: 'Russell Personal', owner: 'user-1', createdAt: '2026-10-01' })
    seedPersonal(a, { id: 'desktop-personal', name: 'Local User Personal', createdAt: '2026-10-20' })
    a.db.run(`INSERT INTO "members" VALUES ('m1','cloud-personal','user-1','owner')`)
    a.db.run(`INSERT INTO "members" VALUES ('m2','desktop-personal','user-1','owner')`)
    a.db.run(`INSERT INTO "workspace_agent_profiles" VALUES ('p1','desktop-personal','Shogo')`)
    a.db.run(`INSERT INTO "projects" VALUES ('proj-1','desktop-personal','my-app')`)
    a.db.run(`INSERT INTO "conversations" VALUES ('conv-1','desktop-personal','hello')`)
    a.db.run(`INSERT INTO "chat_messages" VALUES ('msg-1','conv-1','hi')`)
  })

  test('every row that names the duplicate is rewritten into the winner', async () => {
    const result = await mergePersonalWorkspace(a.prisma, {
      fromId: 'desktop-personal',
      toId: 'cloud-personal',
      deviceName: "Russell's MacBook",
    })
    expect(result.merged).toBe(true)
    // project, conversation, agent profile (members are removed, not rewritten)
    expect(result.rows).toBe(3)

    const projects = a.db.query(`SELECT "workspaceId" FROM "projects"`).all() as any[]
    expect(projects.map((row) => row.workspaceId)).toEqual(['cloud-personal'])
    const conversations = a.db.query(`SELECT "workspaceId" FROM "conversations"`).all() as any[]
    expect(conversations.map((row) => row.workspaceId)).toEqual(['cloud-personal'])
    // The message hangs off the conversation, so it came along untouched.
    expect((a.db.query(`SELECT COUNT(*) AS n FROM "chat_messages"`).get() as any).n).toBe(1)
  })

  test('the duplicate row and its members are removed, the winner is untouched', async () => {
    await mergePersonalWorkspace(a.prisma, { fromId: 'desktop-personal', toId: 'cloud-personal' })
    const workspaces = a.db.query(`SELECT "id","name" FROM "workspaces"`).all() as any[]
    expect(workspaces).toEqual([{ id: 'cloud-personal', name: 'Russell Personal' }])
    const members = a.db.query(`SELECT "workspaceId" FROM "members"`).all() as any[]
    expect(members.map((row) => row.workspaceId)).toEqual(['cloud-personal'])
  })

  test('a rerun is a no-op', async () => {
    await mergePersonalWorkspace(a.prisma, { fromId: 'desktop-personal', toId: 'cloud-personal' })
    const again = await mergePersonalWorkspace(a.prisma, { fromId: 'desktop-personal', toId: 'cloud-personal' })
    expect(again).toEqual({ merged: false, rows: 0, files: 0 })
  })

  test('a missing winner is refused rather than deleting the duplicate', async () => {
    const result = await mergePersonalWorkspace(a.prisma, { fromId: 'desktop-personal', toId: 'nope' })
    expect(result.merged).toBe(false)
    expect((a.db.query(`SELECT COUNT(*) AS n FROM "workspaces"`).get() as any).n).toBe(2)
  })

  test('the duplicate\'s jobs are pinned to the device that ran them', async () => {
    a.db.run(`INSERT INTO "agent_schedules" VALUES ('s1','desktop-personal','morning',NULL)`)
    a.db.run(`INSERT INTO "agent_schedules" VALUES ('s2','desktop-personal','pinned','inst-other')`)
    a.db.run(`INSERT INTO "agent_configs" VALUES ('c1','proj-1',NULL)`)

    await mergePersonalWorkspace(a.prisma, {
      fromId: 'desktop-personal',
      toId: 'cloud-personal',
      pinToInstanceId: 'inst-mac',
    })

    const schedules = a.db.query(`SELECT "id","workspaceId","runOnInstanceId" FROM "agent_schedules" ORDER BY "id"`).all() as any[]
    expect(schedules).toEqual([
      { id: 's1', workspaceId: 'cloud-personal', runOnInstanceId: 'inst-mac' },
      // An explicit placement is never overwritten: it was chosen by hand.
      { id: 's2', workspaceId: 'cloud-personal', runOnInstanceId: 'inst-other' },
    ])
    const configs = a.db.query(`SELECT "runOnInstanceId" FROM "agent_configs"`).all() as any[]
    expect(configs).toEqual([{ runOnInstanceId: 'inst-mac' }])
  })

  test('without a device to pin to, a job keeps running in the cloud', async () => {
    a.db.run(`INSERT INTO "agent_schedules" VALUES ('s1','desktop-personal','morning',NULL)`)
    await mergePersonalWorkspace(a.prisma, { fromId: 'desktop-personal', toId: 'cloud-personal' })
    const schedule = a.db.query(`SELECT "workspaceId","runOnInstanceId" FROM "agent_schedules"`).get() as any
    expect(schedule).toEqual({ workspaceId: 'cloud-personal', runOnInstanceId: null })
  })
})

// ─── Adoption ───────────────────────────────────────────────────────────────

describe('adoptCloudPersonal', () => {
  test('creates the cloud Personal locally and folds the device Personal into it', async () => {
    const a = adapter()
    seedPersonal(a, { id: 'desktop-personal', name: 'Local User Personal', createdAt: '2026-10-20' })
    a.db.run(`INSERT INTO "projects" VALUES ('proj-1','desktop-personal','my-app')`)

    const result = await adoptCloudPersonal(
      a.prisma,
      { id: 'cloud-personal', name: 'Russell Personal', slug: 'user-abc-personal' },
      { userId: 'user-1', deviceName: "Russell's MacBook" },
    )

    expect(result).toEqual({ id: 'cloud-personal', created: true, merged: ['desktop-personal'] })
    const workspaces = a.db.query(`SELECT "id","name","slug","kind","personalOwnerId" FROM "workspaces"`).all() as any[]
    expect(workspaces).toEqual([
      { id: 'cloud-personal', name: 'Russell Personal', slug: 'user-abc-personal', kind: 'personal', personalOwnerId: 'user-1' },
    ])
    expect((a.db.query(`SELECT "workspaceId" FROM "projects"`).all() as any[])[0].workspaceId).toBe('cloud-personal')
  })

  test('a second run adopts nothing new and merges nothing', async () => {
    const a = adapter()
    const personal = { id: 'cloud-personal', name: 'Russell Personal', slug: 'user-abc-personal' }
    await adoptCloudPersonal(a.prisma, personal, { userId: 'user-1' })
    const again = await adoptCloudPersonal(a.prisma, personal, { userId: 'user-1' })
    expect(again).toEqual({ id: 'cloud-personal', created: false, merged: [] })
    expect((a.db.query(`SELECT COUNT(*) AS n FROM "workspaces"`).get() as any).n).toBe(1)
  })
})

// ─── The cloud-side merge cannot move a desktop's files ─────────────────────

describe("the cloud's merge does not strand a desktop root", () => {
  let roots: string
  let previous: string | undefined

  beforeEach(() => {
    roots = mkdtempSync(join(tmpdir(), 'sho285-roots-'))
    previous = process.env.SHOGO_WORKSPACE_ROOTS
    process.env.SHOGO_WORKSPACE_ROOTS = roots
  })

  const restore = () => {
    if (previous === undefined) delete process.env.SHOGO_WORKSPACE_ROOTS
    else process.env.SHOGO_WORKSPACE_ROOTS = previous
    rmSync(roots, { recursive: true, force: true })
  }

  test("a Personal the cloud merged away has its root moved to merged/<device>/", async () => {
    const a = adapter()
    seedPersonal(a, { id: 'cloud-personal', name: 'Russell Personal', owner: 'user-1', createdAt: '2026-10-01' })
    seedPersonal(a, { id: 'desktop-personal', name: 'Local User Personal', createdAt: '2026-10-20' })
    try {
      // The files the cloud never had: they only ever existed on this disk.
      mkdirSync(join(roots, 'desktop-personal'), { recursive: true })
      writeFileSync(join(roots, 'desktop-personal', 'MEMORY.md'), 'a line only this device wrote\n')

      // What the puller gets when the cloud already merged the duplicate: the
      // row is gone up there, so the feed carries a delete for it.
      const result = await applyHostFeedPage(
        a.prisma,
        { models: [], deletes: [{ model: 'Workspace', recordId: 'desktop-personal' }] },
        () => {},
        { deviceName: 'Samsara' },
      )

      expect(result.deleted).toBe(1)
      // AC7: the duplicate's root ends up inside the surviving Personal.
      expect(readFileSync(join(roots, 'cloud-personal', 'merged', 'Samsara', 'MEMORY.md'), 'utf-8')).toBe(
        'a line only this device wrote\n',
      )
      // ... and the old directory is gone, so the root sync cannot upload it twice.
      expect(existsSync(join(roots, 'desktop-personal'))).toBe(false)
    } finally {
      restore()
    }
  })

  test('deleting an ordinary workspace leaves its root where it is', async () => {
    const a = adapter()
    seedPersonal(a, { id: 'cloud-personal', name: 'Russell Personal', owner: 'user-1', createdAt: '2026-10-01' })
    a.db.run(
      `INSERT INTO "workspaces" ("id","name","slug","kind","personalOwnerId","hostInstanceId","createdAt")
       VALUES ('team-ws','Team','team','team',NULL,NULL,'2026-10-20')`,
    )
    try {
      mkdirSync(join(roots, 'team-ws'), { recursive: true })
      writeFileSync(join(roots, 'team-ws', 'AGENTS.md'), 'not a Personal\n')

      await applyHostFeedPage(
        a.prisma,
        { models: [], deletes: [{ model: 'Workspace', recordId: 'team-ws' }] },
        () => {},
        { deviceName: 'Samsara' },
      )

      expect(readFileSync(join(roots, 'team-ws', 'AGENTS.md'), 'utf-8')).toBe('not a Personal\n')
      expect(existsSync(join(roots, 'cloud-personal', 'merged'))).toBe(false)
    } finally {
      restore()
    }
  })
})

// ─── Rewrites: the Personal keeps its identity ──────────────────────────────

describe('the Personal is never rewritten into a machine copy', () => {
  const ctx = { instanceId: 'inst-abcdef12', homeRegion: 'us' }

  test('keeps the cloud slug and stays unhosted', () => {
    const row = { id: 'cloud-personal', slug: 'user-abc-personal', kind: 'personal', personalOwnerId: 'user-1' }
    const out = applyRewrites('Workspace', row, ctx)
    expect(out.slug).toBe('user-abc-personal')
    expect(out.hostInstanceId).toBeNull()
  })

  test('a team workspace is still suffixed and hosted', () => {
    const row = { id: 'ws-1', slug: 'my-workspace', kind: 'team', personalOwnerId: null }
    const out = applyRewrites('Workspace', row, ctx)
    expect(out.slug).toBe('my-workspace-m-inst-abc')
    expect(out.hostInstanceId).toBe('inst-abcdef12')
  })
})

// ─── The change feed carries the Personal down ──────────────────────────────

describe('readHostFeed', () => {
  test("includes the caller's Personal, not only the workspaces it hosts", async () => {
    // The Workspace delegate is asked twice: once for the ids the feed covers
    // (hosted OR the caller's Personal), once for the changed rows themselves.
    let call = 0
    const db = {
      workspace: {
        findMany: async ({ where }: any) => {
          call++
          if (call === 1) {
            expect(where.OR).toEqual([{ hostInstanceId: 'inst-1' }, { personalOwnerId: 'user-1' }])
            return [{ id: 'cloud-personal' }]
          }
          return [{ id: 'cloud-personal', slug: 'user-abc-personal' }]
        },
      },
      hostSyncChange: {
        findMany: async () => [{ id: 7, model: 'Workspace', recordId: 'cloud-personal', op: 'upsert' }],
      },
      user: { findMany: async () => [] },
    }

    const page = await readHostFeed(db, {
      instanceId: 'inst-1',
      ownerUserId: 'user-1',
      cursor: 0,
      now: Date.now() + 10_000,
    })
    expect(page.models.map((entry) => entry.model)).toContain('Workspace')
    expect(page.models.flatMap((entry) => entry.rows).map((row: any) => row.id)).toContain('cloud-personal')
  })
})
