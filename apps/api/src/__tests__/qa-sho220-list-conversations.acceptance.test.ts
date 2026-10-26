// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-220 acceptance: the conversation list on a grown-up workspace.
 *
 * The card promises two things about `GET /workspaces/:id/conversations` on a
 * 150-channel workspace:
 *
 * - a steady-state call does **no writes** (the #general / #activity /
 *   note-to-self set-up used to run on every single list call), and
 * - it uses a **bounded number of queries** — the count must not grow with the
 *   number of conversations, which is what "one query per conversation" means.
 *
 * Both are counted directly on the Prisma client rather than timed, so a
 * loaded CI runner cannot turn this red or green by accident.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')

const db = prisma as any
let seed: SeededWorkspace

const BIG_CHANNELS = 150
const SMALL_CHANNELS = 3

/** A ceiling for the whole list, independent of how many conversations it returns. */
const QUERY_BUDGET = 12

const WRITE_METHODS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const
const READ_METHODS = [
  'findMany',
  'findFirst',
  'findUnique',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'groupBy',
  'count',
  'aggregate',
] as const

interface Counters {
  reads: number
  writes: number
  writeCalls: string[]
  models: string[]
}

/**
 * Count every delegate call the request makes. Prisma keeps one delegate object
 * per model on the client, so patching its methods is enough for every caller
 * in the request path — including services that imported `prisma` directly.
 */
function instrument(): Counters {
  const counters: Counters = { reads: 0, writes: 0, writeCalls: [], models: [] }
  const seen = new Set<string>()
  let target: any = db
  while (target && target !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (seen.has(name) || name.startsWith('_') || name.startsWith('$')) continue
      seen.add(name)
      let delegate: any
      try {
        delegate = (db as any)[name]
      } catch {
        continue
      }
      if (!delegate || typeof delegate !== 'object' || typeof delegate.findMany !== 'function') continue
      counters.models.push(name)
      for (const method of WRITE_METHODS) {
        const original = delegate[method]
        if (typeof original !== 'function') continue
        delegate[method] = (...args: any[]) => {
          counters.writes += 1
          counters.writeCalls.push(`${name}.${method}`)
          return original.apply(delegate, args)
        }
      }
      for (const method of READ_METHODS) {
        const original = delegate[method]
        if (typeof original !== 'function') continue
        delegate[method] = (...args: any[]) => {
          counters.reads += 1
          return original.apply(delegate, args)
        }
      }
    }
    target = Object.getPrototypeOf(target)
  }
  return counters
}

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function list(workspaceId: string, userId: string, query = '') {
  const res = await app.request(`/api/workspaces/${workspaceId}/conversations${query}`, {
    headers: { 'x-user': userId },
  })
  const json: any = await res.json()
  return { status: res.status, conversations: (json.conversations ?? []) as any[], syncedAt: json.syncedAt as string }
}

async function seedChannels(workspaceId: string, ownerId: string, count: number, prefix: string) {
  const base = Date.now() - count * 1_000
  await db.conversation.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      workspaceId,
      kind: 'public' as const,
      name: `${prefix}-${i}`,
      slug: `${prefix}-${i}`,
      createdById: ownerId,
      lastSeq: 1,
      lastMessageAt: new Date(base + i * 1_000),
      createdAt: new Date(base + i * 1_000),
      updatedAt: new Date(base + i * 1_000),
    })),
  })
  const rows = await db.conversation.findMany({
    where: { workspaceId, slug: { startsWith: `${prefix}-` } },
    select: { id: true },
    orderBy: { slug: 'asc' },
  })
  await db.conversationMember.createMany({
    data: rows.map((row: any, i: number) => ({ conversationId: row.id, memberType: 'user', userId: ownerId, lastReadSeq: i % 2 })),
  })
  await db.conversationMessage.createMany({
    data: rows.map((row: any, i: number) => ({
      conversationId: row.id,
      workspaceId,
      seq: 1,
      authorType: 'user' as const,
      authorUserId: ownerId,
      text: `message ${i}`,
    })),
  })
  return rows as Array<{ id: string }>
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  await seedChannels(seed.workspaceId, seed.owner, BIG_CHANNELS, 'channel')
  await seedChannels(seed.otherWorkspaceId, seed.outsider, SMALL_CHANNELS, 'small')
  // Warm both workspaces once: the first read of a workspace is the set-up
  // path, which is expected to write.
  await list(seed.workspaceId, seed.owner)
  await list(seed.otherWorkspaceId, seed.outsider)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SHO-220: the conversation list on a 150-channel workspace', () => {
  test('a repeat call performs no writes at all', async () => {
    const counters = instrument()
    const result = await list(seed.workspaceId, seed.owner)
    expect(result.status).toBe(200)
    expect(result.conversations.length).toBeGreaterThanOrEqual(BIG_CHANNELS)
    expect(counters.models.length).toBeGreaterThan(0)
    expect(counters.writeCalls).toEqual([])
    expect(counters.writes).toBe(0)
  })

  test('the query count is bounded, not one query per conversation', async () => {
    const big = instrument()
    const bigList = await list(seed.workspaceId, seed.owner)
    const bigReads = big.reads

    const small = instrument()
    const smallList = await list(seed.otherWorkspaceId, seed.outsider)
    const smallReads = small.reads

    // 150 conversations, and 3. If the list ran a query per conversation these
    // two numbers would differ by ~147.
    expect(bigList.conversations.length).toBeGreaterThanOrEqual(BIG_CHANNELS)
    expect(smallList.conversations.length).toBeGreaterThanOrEqual(SMALL_CHANNELS)
    expect(bigReads).toBeLessThanOrEqual(QUERY_BUDGET)
    expect(smallReads).toBeLessThanOrEqual(QUERY_BUDGET)
    expect(bigReads - smallReads).toBeLessThanOrEqual(2)
  })

  test('a `since` catch-up is cheaper than the full list and writes nothing', async () => {
    const full = await list(seed.workspaceId, seed.owner)
    expect(full.syncedAt).toBeTruthy()

    const counters = instrument()
    const quiet = await list(seed.workspaceId, seed.owner, `?since=${encodeURIComponent(full.syncedAt)}`)
    expect(quiet.status).toBe(200)
    expect(quiet.conversations).toEqual([])
    expect(counters.writes).toBe(0)
    expect(counters.reads).toBeLessThanOrEqual(QUERY_BUDGET)
  })

  test('the set-up path still runs for a workspace that has never been listed', async () => {
    const fresh = await db.workspace.create({
      data: { name: 'Fresh', slug: `fresh-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
    })
    const person = await db.user.create({
      data: { name: 'fresh', email: `fresh-${crypto.randomUUID().slice(0, 8)}@example.com` },
    })
    await db.member.create({ data: { userId: person.id, workspaceId: fresh.id, role: 'owner' } })

    const counters = instrument()
    const first = await list(fresh.id, person.id)
    expect(first.status).toBe(200)
    // #general, #activity and the note-to-self are created on this first read.
    expect(counters.writes).toBeGreaterThan(0)
    expect(first.conversations.map((c) => c.slug ?? c.kind)).toContain('general')
  })
})
