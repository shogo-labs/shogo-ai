// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA gate for SHO-103 — the Activity panel's Sent view, driven through the real
 * router so what is checked is the *contract the panel reads*, not only the
 * service behind it.
 *
 * What only the route can get wrong:
 * 1. the page shape — `items` / `hasMore`, and a row carrying exactly the
 *    conversation ref the row labels itself from plus a preview short enough
 *    to render on one line;
 * 2. the query the client actually sends (`before` + `beforeId` from the last
 *    row) must page without repeating or dropping a message on a tie;
 * 3. `limit` cannot be talked into dumping the whole workspace;
 * 4. the inbox the `All` chip renders stays inbound-only — a message you sent
 *    never becomes an inbox row for you (with a positive control, so a green
 *    run proves both directions);
 * 5. a channel you can no longer open does not hand its messages back, and a
 *    workspace you are not in answers 403 rather than a filtered 200.
 *
 * Plus the desktop half of the parity rule: both composers mount the same
 * router, so the local app must answer this path too.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const service = await import('../services/conversation.service')
const { conversationRoutes } = await import('../routes/conversations')
const notifications = await import('../services/conversation-notifications')

const db = prisma as any
let seed: SeededWorkspace

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function get(user: string | null, path: string) {
  const res = await app.request(`/api${path}`, { headers: user ? { 'x-user': user } : {} })
  const json: any = await res.json().catch(() => null)
  return { status: res.status, json }
}

const sentPath = (workspaceId: string, query = '') => `/workspaces/${workspaceId}/sent-messages${query}`

async function channel(
  name: string,
  opts: { kind?: 'public' | 'private'; memberUserIds?: string[] } = {},
) {
  return service.createChannel({
    workspaceId: seed.workspaceId,
    userId: seed.owner,
    name: `${name}-${crypto.randomUUID().slice(0, 6)}`,
    kind: opts.kind,
    memberUserIds: opts.memberUserIds,
  })
}

async function post(
  userId: string,
  text: string,
  opts: { conversationId: string; threadRootId?: string; createdAt?: Date },
) {
  return service.postMessage({
    conversationId: opts.conversationId,
    authorType: 'user',
    authorUserId: userId,
    text,
    threadRootId: opts.threadRootId,
    createdAt: opts.createdAt,
  } as any)
}

async function send(
  userId: string,
  text: string,
  opts: { conversationId: string; threadRootId?: string; createdAt?: Date },
) {
  const { row } = await post(userId, text, opts)
  return row
}

async function directMessage(userId: string, others: string[]) {
  return service.openDirectConversation(seed.workspaceId, userId, others)
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) {
    await service.listConversationsForUser(seed.workspaceId, user)
  }
  // Inbox rows are written by the after-post hook, so without this the
  // "nothing of mine reached my inbox" check would pass on an empty queue.
  notifications.registerConversationNotifications()
})

afterAll(async () => {
  await (db as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /workspaces/:id/sent-messages', () => {
  test('answers with the page and row shape the panel destructures', async () => {
    const ch = await channel('qa-sent-shape')
    const first = await send(seed.member, 'first thing', { conversationId: ch.id })
    const root = await send(seed.member, 'a root', { conversationId: ch.id })
    await Bun.sleep(5)
    const reply = await send(seed.member, 'a reply', { conversationId: ch.id, threadRootId: root.id })
    const dm = await directMessage(seed.member, [seed.owner])
    const dmRow = await send(seed.member, 'psst', { conversationId: dm.id })
    await send(seed.owner, 'not yours', { conversationId: ch.id })

    const { status, json } = await get(seed.member, sentPath(seed.workspaceId, '?limit=100'))
    expect(status).toBe(200)
    expect(Array.isArray(json.items)).toBe(true)
    expect(typeof json.hasMore).toBe('boolean')

    // Only the viewer's own user messages, never another author's.
    const ids = json.items.map((i: any) => i.id)
    expect(ids).toContain(first.id)
    expect(ids).toContain(reply.id)
    expect(ids).toContain(dmRow.id)
    expect(json.items.some((i: any) => i.text === 'not yours')).toBe(false)
    expect(new Set(ids).size).toBe(ids.length)

    // Newest first: `createdAt` never increases down the page.
    const times = json.items.map((i: any) => Date.parse(i.createdAt))
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a))

    // The row is exactly what `sentEntry()` reads: the text, the moment, the
    // thread it belonged to, and the conversation ref it labels itself from.
    const replyRow = json.items.find((i: any) => i.id === reply.id)
    expect(Object.keys(replyRow).sort()).toEqual([
      'conversation',
      'conversationId',
      'createdAt',
      'id',
      'text',
      'threadRootId',
    ])
    expect(replyRow.text).toBe('a reply')
    expect(replyRow.threadRootId).toBe(root.id)
    expect(replyRow.createdAt).toBe(new Date(replyRow.createdAt).toISOString())
    expect(Object.keys(replyRow.conversation).sort()).toEqual(['id', 'kind', 'name', 'slug'])

    // A channel row labels as `#<name>`; the root of a thread is not a reply.
    expect(replyRow.conversation).toMatchObject({ id: ch.id, kind: 'public', name: ch.name })
    expect(json.items.find((i: any) => i.id === root.id).threadRootId).toBeNull()
    // A DM is a DM, so the row says "Direct Message" instead of `#`.
    expect(json.items.find((i: any) => i.id === dmRow.id).conversation.kind).toBe('dm')
  })

  test('a long message comes back as a one-row preview', async () => {
    const ch = await channel('qa-sent-long')
    const text = `${'shipping the long version of this note. '.repeat(200)}END`
    const row = await send(seed.member, text, { conversationId: ch.id })

    const { json } = await get(seed.member, sentPath(seed.workspaceId, '?limit=100'))
    const item = json.items.find((i: any) => i.id === row.id)
    expect(item.text.length).toBe(280)
    expect(item.text).toBe(text.slice(0, 280))
  })

  test('paging on before + beforeId repeats nothing and drops nothing, even on a tie', async () => {
    const ch = await channel('qa-sent-pages')
    // Ahead of "now", so these seven are the newest rows the viewer has and the
    // page boundaries land where the assertions say they do.
    const base = new Date(Date.now() + 3_600_000)
    const sameMoment = new Date(base.getTime() + 3_000)
    const expected: string[] = []
    for (let i = 0; i < 7; i += 1) {
      const createdAt = i >= 2 && i <= 4 ? sameMoment : new Date(base.getTime() + i * 1_000)
      const row = await send(seed.member, `page ${i}`, { conversationId: ch.id, createdAt })
      expected.push(row.id)
    }

    const seen: string[] = []
    let query = '?limit=2'
    for (let guard = 0; guard < 10; guard += 1) {
      const { status, json } = await get(seed.member, sentPath(seed.workspaceId, query))
      expect(status).toBe(200)
      const ids: string[] = json.items
        .map((i: any) => i.id)
        .filter((id: string) => expected.includes(id))
      // Nothing outside this channel's own rows may be silently mixed in by a
      // cursor: the page itself is capped at the limit asked for.
      expect(json.items.length).toBeLessThanOrEqual(2)
      seen.push(...ids)
      if (!json.hasMore) break
      const last = json.items[json.items.length - 1]
      query = `?limit=2&before=${encodeURIComponent(last.createdAt)}&beforeId=${encodeURIComponent(last.id)}`
    }

    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(new Set(seen)).toEqual(new Set(expected))
    // Two distinct newest timestamps lead; the three that share a millisecond
    // follow in a stable id order; the two oldest close the list.
    expect(seen.slice(0, 2)).toEqual([expected[6], expected[5]])
    expect(new Set(seen.slice(2, 5))).toEqual(new Set([expected[2], expected[3], expected[4]]))
    expect(seen[5]).toBe(expected[1])
    expect(seen[6]).toBe(expected[0])
  })

  test('limit is clamped and a missing limit falls back to the default page', async () => {
    const ch = await channel('qa-sent-limit')
    const base = new Date('2026-09-01T00:00:00.000Z')
    const rows = Array.from({ length: 105 }, (_, i) => ({
      conversationId: ch.id,
      workspaceId: seed.workspaceId,
      seq: i + 1,
      authorType: 'user',
      authorUserId: seed.viewer,
      text: `bulk ${i}`,
      createdAt: new Date(base.getTime() + i * 1_000),
    }))
    await db.conversationMessage.createMany({ data: rows })

    const big = await get(seed.viewer, sentPath(seed.workspaceId, '?limit=1000'))
    expect(big.status).toBe(200)
    expect(big.json.items.length).toBe(100)
    expect(big.json.hasMore).toBe(true)

    const zero = await get(seed.viewer, sentPath(seed.workspaceId, '?limit=0'))
    expect(zero.status).toBe(200)
    expect(zero.json.items.length).toBe(50)
  })

  test('a private channel you left does not hand its messages back', async () => {
    const ch = await channel('qa-sent-private', { kind: 'private', memberUserIds: [seed.member] })
    const kept = await send(seed.member, 'while i was in', { conversationId: ch.id })

    const before = await get(seed.member, sentPath(seed.workspaceId, '?limit=100'))
    expect(before.json.items.some((i: any) => i.id === kept.id)).toBe(true)

    await service.leaveConversation(ch.id, seed.member)

    const after = await get(seed.member, sentPath(seed.workspaceId, '?limit=100'))
    expect(after.status).toBe(200)
    expect(after.json.items.some((i: any) => i.id === kept.id)).toBe(false)
  })

  test('a workspace you are not in answers 403, not a filtered 200', async () => {
    const { status } = await get(seed.member, sentPath(seed.otherWorkspaceId))
    expect(status).toBe(403)
  })

  test('what you sent never becomes an inbox row for you, so All cannot show it', async () => {
    const ch = await channel('qa-sent-inbox', { memberUserIds: [seed.member] })
    const root = await post(seed.owner, 'ask a question', { conversationId: ch.id })
    const reply = await post(seed.member, 'answering you', {
      conversationId: ch.id,
      threadRootId: root.row.id,
    })

    // The real after-post hook's recipient resolution, awaited: the person who
    // was answered is a recipient, the author never is.
    const recipients = await notifications.notifyForMessage(reply)
    const recipientIds = recipients.map((r: any) => r.userId)
    expect(recipientIds).toContain(seed.owner)
    expect(recipientIds).not.toContain(seed.member)

    // Both directions through the route the All chip renders from: the answer
    // shows up for the person answered, and never for the person who sent it.
    const ownerInbox = await get(seed.owner, `/workspaces/${seed.workspaceId}/inbox?limit=100`)
    expect(ownerInbox.status).toBe(200)
    expect(ownerInbox.json.items.some((i: any) => i.messageId === reply.row.id)).toBe(true)

    const authorInbox = await get(seed.member, `/workspaces/${seed.workspaceId}/inbox?limit=100`)
    expect(authorInbox.status).toBe(200)
    expect(authorInbox.json.items.some((i: any) => i.messageId === reply.row.id)).toBe(false)
  })

  test('the desktop composer mounts the same route', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'
    mock.module('@shogo-ai/sdk/cli/pkg', () => ({
      pkg: { version: '0.0.0', name: '@shogo-ai/sdk' },
      PlatformPackageManager: class {},
      NodeMissingError: class NodeMissingError extends Error {
        constructor(message: string) {
          super(message)
          this.name = 'NodeMissingError'
        }
      },
      isNodeAvailableOnUnix: () => Promise.resolve(false),
      isNodeAvailableOnWindows: () => Promise.resolve(false),
      _resetUnixNodeCache: () => {},
      resolveBinInvocation: (command: string) => command,
    }))
    const { createLocalApp } = await import('../app/create-local-app')
    const local = await createLocalApp()
    const routes = new Set(local.app.routes.map((r: any) => `${r.method} ${r.path}`))
    // Both surfaces talk to the same composer-owned path; a desktop that did not
    // mount it would show an empty Sent panel with no error at all.
    expect(routes.has('GET /api/workspaces/:workspaceId/sent-messages')).toBe(true)
  })
})
