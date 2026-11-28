// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// A paged read on the desktop returns the newest rows first (SHO-610).
//
// Russell's report: a reply streamed in and then vanished from the screen when
// the turn ended, and reopening the chat painted an older part of the
// conversation — long replies came back blank. The desktop transcript asks for
// `?sessionId=…&limit=50&offset=0`; `localChatMessageHooks` installed no
// `beforeList`, so the generated route passed no `orderBy` and SQLite answered
// in primary-key (insert) order. The "newest 50" page was therefore the *oldest*
// slice, so the turn-end paint saw history-behind and the reopen painted stale
// rows. The cloud hook set has always defaulted `createdAt: 'desc'`.
//
// Everything here goes through `createLocalGeneratedRoutes()` and a real `GET`,
// not through the hook, because that is the wiring the desktop uses — a
// direct-hook assertion would pass without `local-routes.ts` installing the set.
//
// The fake Prisma deliberately behaves like SQLite: no `orderBy` means insertion
// order (what `main` does), and the seeded ids do NOT sort with `createdAt`, so
// neither an id sort nor the insert order can pass for the newest-first page.
//
// Run: bun test apps/api/src/__tests__/chat-message-local-history-order.test.ts

import { beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { createLocalGeneratedRoutes } from '../generated/local-routes'

type MessageRow = {
  id: string
  sessionId: string
  agent: string
  role: string
  content: string
  createdAt: Date
}

type SessionRow = {
  id: string
  updatedAt: Date
  inferredName: string
}

/** The subset of a Prisma `where` these reads can produce. */
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (expected && typeof expected === 'object' && 'in' in expected) {
      return (expected.in as unknown[]).includes(row[field])
    }
    if (expected instanceof Date) return row[field]?.getTime?.() === expected.getTime()
    return row[field] === expected
  })
}

function byOrder(rows: any[], orderBy: any): any[] {
  if (!orderBy) return rows
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      for (const [field, dir] of Object.entries(clause) as Array<[string, string]>) {
        const left = a[field]
        const right = b[field]
        const l = left instanceof Date ? left.getTime() : left
        const r = right instanceof Date ? right.getTime() : right
        if (l === r) continue
        const cmp = l < r ? -1 : 1
        return dir === 'asc' ? cmp : -cmp
      }
    }
    return 0
  })
}

/** An in-memory model that answers like Prisma over SQLite. */
function model(rows: any[]) {
  return {
    findMany: async (args: any = {}) => {
      let out = rows.filter((row) => matches(row, args.where ?? {}))
      out = byOrder(out, args.orderBy)
      if (args.skip) out = out.slice(args.skip)
      if (args.take !== undefined && args.take !== null) out = out.slice(0, args.take)
      return out
    },
    count: async (args: any = {}) => rows.filter((row) => matches(row, args.where ?? {})).length,
  }
}

let messages: MessageRow[] = []
let sessions: SessionRow[] = []

function makePrisma() {
  return {
    chatMessage: model(messages),
    chatSession: model(sessions),
  }
}

function makeLocalApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId: 'user-1' })
    await next()
  })
  app.route('/api', createLocalGeneratedRoutes(makePrisma() as any))
  return app
}

function listMessages(query: string): Promise<Response> {
  return makeLocalApp().request(`/api/chat-messages?${query}`)
}

function listSessions(query: string): Promise<Response> {
  return makeLocalApp().request(`/api/chat-sessions?${query}`)
}

const SESSION_ID = 'chat-1'
const TOTAL = 120
const BASE = Date.UTC(2026, 10, 1, 9, 0, 0)

/**
 * `ids` are a permutation of `createdAt` order (×53 mod 120 is a coprime walk),
 * so an id-ordered page and a createdAt-ordered page cannot be the same rows.
 */
function seedMessages() {
  messages = []
  for (let i = 0; i < TOTAL; i += 1) {
    messages.push({
      id: `msg-${String((i * 53) % TOTAL).padStart(3, '0')}`,
      sessionId: SESSION_ID,
      agent: 'technical',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      createdAt: new Date(BASE + i * 60_000),
    })
  }
}

beforeEach(() => {
  seedMessages()
  sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `chat-${String((i * 5) % 12).padStart(2, '0')}`,
    updatedAt: new Date(BASE + i * 3_600_000),
    inferredName: `chat ${i}`,
  }))
})

describe('GET /api/chat-messages on the local route set', () => {
  test('defaults to newest-first, so limit=50 is the newest page', async () => {
    const response = await listMessages(`sessionId=${SESSION_ID}&limit=50&offset=0`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; items: MessageRow[]; total: number }

    expect(body.total).toBe(TOTAL)
    expect(body.items).toHaveLength(50)
    // The reply just created is on the page — the whole point of the fix.
    expect(body.items[0].id).toBe(`msg-${String(((TOTAL - 1) * 53) % TOTAL).padStart(3, '0')}`)
    expect(body.items[49].id).toBe(`msg-${String(((TOTAL - 50) * 53) % TOTAL).padStart(3, '0')}`)

    const times = body.items.map((item) => new Date(item.createdAt).getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  test('offset=50 is the next older page, with no overlap or gap', async () => {
    const first = (await (await listMessages(`sessionId=${SESSION_ID}&limit=50&offset=0`)).json()) as {
      items: MessageRow[]
    }
    const second = (await (await listMessages(`sessionId=${SESSION_ID}&limit=50&offset=50`)).json()) as {
      items: MessageRow[]
      total: number
    }

    expect(second.total).toBe(TOTAL)
    expect(second.items).toHaveLength(50)
    expect(second.items[0].id).toBe(`msg-${String(((TOTAL - 51) * 53) % TOTAL).padStart(3, '0')}`)

    const firstIds = new Set(first.items.map((item) => item.id))
    expect(second.items.filter((item) => firstIds.has(item.id))).toEqual([])
    const firstOldest = new Date(first.items[first.items.length - 1].createdAt).getTime()
    const secondNewest = new Date(second.items[0].createdAt).getTime()
    expect(secondNewest).toBeLessThan(firstOldest)
  })

  test('the last page ends at the oldest message', async () => {
    const body = (await (await listMessages(`sessionId=${SESSION_ID}&limit=50&offset=100`)).json()) as {
      items: MessageRow[]
    }
    expect(body.items).toHaveLength(20)
    expect(body.items[body.items.length - 1].id).toBe('msg-000')
  })

  test('an explicit orderBy query param still wins over the default', async () => {
    const body = (await (
      await listMessages(`sessionId=${SESSION_ID}&limit=50&orderBy=createdAt:asc`)
    ).json()) as { items: MessageRow[] }

    expect(body.items).toHaveLength(50)
    expect(body.items[0].id).toBe(`msg-${String((0 * 53) % TOTAL).padStart(3, '0')}`)
    const times = body.items.map((item) => new Date(item.createdAt).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

describe('GET /api/chat-sessions on the local route set', () => {
  test('defaults to most recently active first', async () => {
    const response = await listSessions('limit=5&offset=0')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: SessionRow[]; total: number }

    expect(body.total).toBe(12)
    expect(body.items).toHaveLength(5)
    // Seeded ids are a permutation of `updatedAt` order, so insert order can't
    // stand in for "most recent": chat 11 (newest) is `chat-07`.
    expect(body.items[0].id).toBe('chat-07')
    const times = body.items.map((item) => new Date(item.updatedAt).getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })
})
