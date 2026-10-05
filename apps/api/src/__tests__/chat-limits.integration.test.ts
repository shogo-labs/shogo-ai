// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat limits: cross-pod rate limits and agent-reply slots, and expiring
 * file links.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const limits = await import('../lib/chat-limits')
const files = await import('../lib/conversation-files')
const chatMode = await import('../services/chat-mode')
const { conversationRoutes } = await import('../routes/conversations')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
}

/** Just enough of Redis to run the two scripts in chat-limits. */
function fakeRedis() {
  const counters = new Map<string, number>()
  const zsets = new Map<string, Map<string, number>>()
  const calls: string[][] = []
  return {
    calls,
    async eval(script: string, _n: number, key: string, ...args: string[]) {
      calls.push([key, ...args])
      if (script.includes('INCR')) {
        const n = (counters.get(key) ?? 0) + 1
        counters.set(key, n)
        return n
      }
      const [now, expireAt, max, token] = args
      const set = zsets.get(key) ?? new Map<string, number>()
      zsets.set(key, set)
      for (const [member, score] of set) if (score <= Number(now)) set.delete(member)
      if (set.size >= Number(max)) return 0
      set.set(token, Number(expireAt))
      return 1
    },
    async zrem(key: string, token: string) {
      zsets.get(key)?.delete(token)
      return 1
    },
  }
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

beforeEach(() => {
  limits._setChatLimitsRedisForTests(null)
  chatMode._resetChatModeCacheForTests()
})

afterAll(async () => {
  limits._setChatLimitsRedisForTests(undefined)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('rate limits', () => {
  test('in-process fallback counts per key and window', async () => {
    const results = []
    for (let i = 0; i < 4; i++) results.push((await limits.takeRateLimit('k', 3, 60_000)).allowed)
    expect(results).toEqual([true, true, true, false])
    expect((await limits.takeRateLimit('other', 3, 60_000)).allowed).toBe(true)
  })

  test('Redis counts are shared, keyed by window', async () => {
    const redis = fakeRedis()
    limits._setChatLimitsRedisForTests(redis as any)
    expect((await limits.takeRateLimit('u1', 1, 60_000)).allowed).toBe(true)
    const second = await limits.takeRateLimit('u1', 1, 60_000)
    expect(second.allowed).toBe(false)
    expect(second.retryAfterSeconds).toBeGreaterThan(0)
    expect(redis.calls[0][0]).toMatch(/^chat:rl:u1:\d+$/)
    expect(redis.calls[0][1]).toBe('60000')
  })

  test('posting past the limit returns 429 with Retry-After', async () => {
    const created = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'busy', kind: 'public' })
    const id = created.json.conversation.id
    const { max } = limits.CHAT_RATE_LIMITS.message
    for (let i = 0; i < max; i++) {
      expect((await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: `m${i}` })).status).toBe(201)
    }
    const blocked = await call(seed.member, 'POST', `/conversations/${id}/messages`, { text: 'one more' })
    expect(blocked.status).toBe(429)
    expect(blocked.json.error.code).toBe('rate_limited')
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await call(seed.owner, 'POST', `/conversations/${id}/messages`, { text: 'others unaffected' })).status).toBe(201)
  })
})

describe('agent reply slots', () => {
  test('slots are shared, leased, and released once', async () => {
    const redis = fakeRedis()
    limits._setChatLimitsRedisForTests(redis as any)
    const a = await limits.tryAcquireSharedSlot('ws1', 2, 60_000)
    const b = await limits.tryAcquireSharedSlot('ws1', 2, 60_000)
    expect(typeof a).toBe('function')
    expect(typeof b).toBe('function')
    expect(await limits.tryAcquireSharedSlot('ws1', 2, 60_000)).toBe(false)
    ;(a as () => void)()
    ;(a as () => void)()
    await Promise.resolve()
    const c = await limits.tryAcquireSharedSlot('ws1', 2, 60_000)
    expect(typeof c).toBe('function')
    expect(await limits.tryAcquireSharedSlot('ws1', 2, 60_000)).toBe(false)
  })

  test('expired leases free their slot', async () => {
    const redis = fakeRedis()
    limits._setChatLimitsRedisForTests(redis as any)
    expect(typeof (await limits.tryAcquireSharedSlot('ws2', 1, -1))).toBe('function')
    expect(typeof (await limits.tryAcquireSharedSlot('ws2', 1, 60_000))).toBe('function')
  })

  test('no Redis means the caller uses its own limit', async () => {
    expect(await limits.tryAcquireSharedSlot('ws3', 1, 60_000)).toBeNull()
  })
})

describe('file links', () => {
  test('tokens expire and are bound to the attachment', () => {
    const now = Date.now()
    const token = files.signAttachmentToken('att-1', now)
    expect(files.verifyAttachmentToken('att-1', token, now)).toBe(true)
    expect(files.verifyAttachmentToken('att-1', token, now + 23 * 3_600_000)).toBe(true)
    expect(files.verifyAttachmentToken('att-1', token, now + 49 * 3_600_000)).toBe(false)
    expect(files.verifyAttachmentToken('att-2', token, now)).toBe(false)
    const [exp, mac] = token.split('.')
    const extended = `${(parseInt(exp, 36) + 86_400_000).toString(36)}.${mac}`
    expect(files.verifyAttachmentToken('att-1', extended, now)).toBe(false)
    expect(files.verifyAttachmentToken('att-1', files.signConversationFileToken('att-1'), now)).toBe(false)
    expect(files.conversationFileUrl({ id: 'att-1' })).toMatch(/^\/api\/conversation-files\/att-1\?t=[0-9a-z]+\.[0-9a-f]{64}$/)
  })

  test('file links stop working when team chat is off', async () => {
    const created = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name: 'files', kind: 'public' })
    const attachment = await db.conversationAttachment.create({
      data: {
        conversationId: created.json.conversation.id,
        uploaderUserId: seed.owner,
        storageKey: 'artifacts/conversations/missing',
        name: 'a.png',
        mimeType: 'image/png',
        size: 1,
      },
    })
    const url = `/conversation-files/${attachment.id}?t=${files.signAttachmentToken(attachment.id)}`
    expect((await call(null, 'GET', url)).status).toBe(404)
    await db.workspace.update({ where: { id: seed.workspaceId }, data: { chatMode: 'off' } })
    chatMode._resetChatModeCacheForTests()
    const off = await call(null, 'GET', url)
    expect(off.status).toBe(403)
    expect(off.json.error.code).toBe('chat_disabled')
    await db.workspace.update({ where: { id: seed.workspaceId }, data: { chatMode: null } })
  })
})
