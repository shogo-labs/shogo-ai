// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /agent-tasks paging against a real SQLite database.
 *
 * The list is ordered by updatedAt, which is not unique — a batch of tasks that
 * finish together share a millisecond. Paging on updatedAt alone skipped the
 * rest of that millisecond, so a page boundary inside it silently lost rows.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { createAgentTaskRoutes } = await import('../routes/agent-tasks')

const db = prisma as any
let seed: SeededWorkspace

const TIE = new Date('2026-01-02T03:04:05.000Z')
const OLDER = new Date('2026-01-01T00:00:00.000Z')

function makeApp(userId: string) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId, isAuthenticated: true })
    await next()
  })
  app.route('/api', createAgentTaskRoutes())
  return app
}

async function mkTask(id: string, updatedAt: Date, workspaceId = seed.workspaceId) {
  return db.agentTask.create({
    data: {
      id,
      userId: seed.owner,
      workspaceId,
      title: `task ${id}`,
      status: 'completed',
      createdAt: updatedAt,
      updatedAt,
    },
  })
}

async function list(query: string, userId = seed.owner) {
  const res = await makeApp(userId).request(`/api/agent-tasks${query}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: Array<{ id: string }>; hasMore: boolean }
  return { ids: body.items.map((t) => t.id), hasMore: body.hasMore }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  // Four tasks finishing in the same millisecond, plus one older.
  await mkTask('c1', TIE)
  await mkTask('c2', TIE)
  await mkTask('c3', TIE)
  await mkTask('c4', TIE)
  await mkTask('c5', OLDER)
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent task paging', () => {
  test('orders by updatedAt then id, newest first', async () => {
    const { ids, hasMore } = await list('?limit=5')
    expect(ids).toEqual(['c4', 'c3', 'c2', 'c1', 'c5'])
    expect(hasMore).toBe(false)
  })

  test('hasMore is true while rows remain and false on the last page', async () => {
    expect((await list('?limit=2')).hasMore).toBe(true)
    const last = await list('?limit=2&before=' + encodeURIComponent(TIE.toISOString()) + '&beforeId=c2')
    expect(last.ids).toEqual(['c1', 'c5'])
    expect(last.hasMore).toBe(false)
  })

  test('a tie straddling the page boundary is not dropped', async () => {
    const page1 = await list('?limit=2')
    expect(page1.ids).toEqual(['c4', 'c3'])
    const page2 = await list('?limit=2&before=' + encodeURIComponent(TIE.toISOString()) + '&beforeId=c3')
    // c2 and c1 share c3's millisecond; the id half is what keeps them.
    expect(page2.ids).toEqual(['c2', 'c1'])
    expect(page2.hasMore).toBe(true)
  })

  test('without the id half, the boundary millisecond is skipped entirely', async () => {
    const page2 = await list('?limit=2&before=' + encodeURIComponent(TIE.toISOString()))
    // Pins the pre-fix behaviour: only the strictly older row survives.
    expect(page2.ids).toEqual(['c5'])
  })

  test('paging walks every row exactly once', async () => {
    const seen: string[] = []
    let query = '?limit=2'
    for (let page = 0; page < 10; page += 1) {
      const { ids, hasMore } = await list(query)
      seen.push(...ids)
      if (!hasMore || ids.length === 0) break
      const lastId = ids[ids.length - 1] as string
      query = `?limit=2&before=${encodeURIComponent(TIE.toISOString())}&beforeId=${lastId}`
      // The older row has its own timestamp, so resume from the row itself.
      if (lastId === 'c5') break
    }
    expect(seen).toEqual(['c4', 'c3', 'c2', 'c1', 'c5'])
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('scopes to one workspace, so another workspace cannot crowd out the page', async () => {
    await mkTask('x1', new Date('2026-02-01T00:00:00.000Z'), seed.otherWorkspaceId)
    await mkTask('x2', new Date('2026-02-01T00:00:01.000Z'), seed.otherWorkspaceId)
    const scoped = await list(`?limit=2&workspaceId=${seed.workspaceId}`)
    expect(scoped.ids).toEqual(['c4', 'c3'])
    const unscoped = await list('?limit=2')
    // Unscoped, the newest rows belong to the other workspace: exactly the
    // truncation the Tasks screen hit when it filtered client-side.
    expect(unscoped.ids).toEqual(['x2', 'x1'])
  })
})
