// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P4 — the unified inbox against a real SQLite database (desktop
 * migrations replayed), with a fake Zernio client at the service seam.
 *
 * The properties that matter are the ones a duplicate would expose: the same
 * provider event arriving twice (webhook retry, or a sweep overlapping it)
 * must leave one thread, one message and one unread — never two. And a reply
 * must go out exactly once, through the account that owns the thread.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { getSocialClient, setSocialClient } = await import('../client')
const { applySocialEvent } = await import('../webhooks')
const {
  backfillInbox,
  getConversation,
  listComments,
  listConversations,
  markConversationRead,
  replyToComment,
  replyToConversation,
} = await import('../inbox.service')

const db = prisma as any

let workspaceId = ''
const calls: any[] = []

/** One verified `message.received` payload, as Zernio sends it. */
const dmPayload = (over: Record<string, any> = {}) => ({
  type: 'message.received',
  profiles: [{ id: 'zp_1', externalId: `ws_${workspaceId}` }],
  account: { id: 'zernio_ig', platform: 'Instagram', username: 'acme.ig' },
  conversation: { id: 'conv_1', status: 'active' },
  message: {
    id: 'msg_in_1',
    conversationId: 'conv_1',
    platform: 'instagram',
    direction: 'incoming',
    text: 'Do you ship to Canada?',
    sender: { id: 'psid_9', name: 'Dana Reed', username: 'dana' },
    createdAt: '2026-10-19T21:00:00.000Z',
  },
  ...over,
})

/** One verified `comment.received` payload. */
const commentPayload = (over: Record<string, any> = {}) => ({
  type: 'comment.received',
  profiles: [{ id: 'zp_1', externalId: `ws_${workspaceId}` }],
  account: { id: 'zernio_ig', platform: 'Instagram', username: 'acme.ig' },
  post: { id: 'zernio_post_1', platformPostId: 'ig_media_1' },
  comment: {
    id: 'cmt_1',
    text: 'MERGE',
    createdTime: '2026-10-19T20:00:00.000Z',
    author: { id: 'ig_user_7', name: 'Dana Reed', username: 'dana' },
    platform: 'instagram',
    platformPostId: 'ig_media_1',
  },
  ...over,
})

async function deliver(payload: Record<string, any>, eventId: string) {
  return applySocialEvent({
    workspaceId,
    externalId: `ws_${workspaceId}`,
    eventId,
    type: payload.type,
    account: { zernioAccountId: 'zernio_ig', platform: 'instagram', username: 'acme.ig' },
    detail: payload.type === 'comment.received' ? payload.comment : payload.message,
    payload,
  })
}

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: { name: 'Inbox Co', slug: `inbox-${crypto.randomUUID().slice(0, 8)}`, kind: 'team' },
  })
  workspaceId = workspace.id

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: '',
      zernioProfileId: 'zp_1',
      externalId: `ws_${workspaceId}`,
      name: 'Inbox Co',
    },
  })
  await db.socialAccount.create({
    data: {
      workspaceId,
      profileId: profile.id,
      zernioAccountId: 'zernio_ig',
      platform: 'instagram',
      username: 'acme.ig',
      displayName: 'Acme IG',
    },
  })

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path === '/inbox/conversations') {
        return {
          data: [
            {
              id: 'conv_1',
              platform: 'instagram',
              accountId: 'zernio_ig',
              participantId: 'psid_9',
              participantName: 'Dana Reed',
              lastMessage: 'Do you ship to Canada?',
              updatedTime: '2026-10-19T21:00:00.000Z',
              unreadCount: 1,
            },
            { id: 'conv_2', platform: 'instagram', accountId: 'zernio_ig', participantId: 'psid_10' },
          ],
        }
      }
      if (req.path === '/inbox/conversations/conv_1/messages' && req.method === 'GET') {
        return {
          messages: [
            {
              id: 'msg_in_1',
              conversationId: 'conv_1',
              accountId: 'zernio_ig',
              platform: 'instagram',
              direction: 'incoming',
              message: 'Do you ship to Canada?',
              senderId: 'psid_9',
              senderName: 'Dana Reed',
              createdAt: '2026-10-19T21:00:00.000Z',
            },
            {
              id: 'msg_old_1',
              conversationId: 'conv_1',
              accountId: 'zernio_ig',
              platform: 'instagram',
              direction: 'incoming',
              message: 'Hi there',
              senderId: 'psid_9',
              createdAt: '2026-10-18T10:00:00.000Z',
            },
          ],
        }
      }
      if (req.path === '/inbox/conversations/conv_2/messages') return { messages: [] }
      if (req.path === '/inbox/conversations/conv_1/messages' && req.method === 'POST') {
        return { data: { messageId: 'msg_out_1', status: 'sent' } }
      }
      if (req.path === '/inbox/comments') {
        return { data: [{ id: 'zernio_post_1', accountId: 'zernio_ig', platform: 'instagram', commentCount: 1 }] }
      }
      if (req.path === '/inbox/comments/zernio_post_1' && req.method === 'GET') {
        return {
          post: { id: 'zernio_post_1', platformPostId: 'ig_media_1', platform: 'instagram' },
          comments: [
            {
              id: 'cmt_1',
              message: 'MERGE',
              createdTime: '2026-10-19T20:00:00.000Z',
              from: { id: 'ig_user_7', name: 'Dana Reed', username: 'dana' },
            },
            {
              id: 'cmt_2',
              message: 'Price?',
              createdTime: '2026-10-19T20:30:00.000Z',
              from: { id: 'ig_user_8', name: 'Sam', username: 'sam' },
            },
          ],
        }
      }
      if (req.path === '/inbox/comments/zernio_post_1' && req.method === 'POST') {
        return { data: { commentId: 'cmt_reply_1' } }
      }
      throw new Error(`unexpected ${req.method} ${req.path}`)
    },
  })
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
})

describe('inbox ingestion', () => {
  test('a DM webhook writes one thread with its first message and one unread', async () => {
    const result = await deliver(dmPayload(), 'evt_dm_1')
    expect(result.status).toBe(200)
    expect((result.body as any).inbox).toMatchObject({ handled: true, created: true })

    const conversations = await listConversations(workspaceId)
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({
      zernioConversationId: 'conv_1',
      platform: 'instagram',
      participantName: 'Dana Reed',
      unreadCount: 1,
      lastMessagePreview: 'Do you ship to Canada?',
    })

    const thread = await getConversation(workspaceId, conversations[0].id)
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0]).toMatchObject({
      zernioMessageId: 'msg_in_1',
      direction: 'incoming',
      text: 'Do you ship to Canada?',
      status: 'sent',
    })
  })

  test('the same provider event twice — and a stale retry — leave one row and one unread', async () => {
    // A provider retry: same event id, so the outbox dedupes it, and the same
    // message id, so the inbox upserts rather than inserts.
    const retry = await deliver(dmPayload(), 'evt_dm_1')
    expect(retry.status).toBe(200)
    expect((retry.body as any).duplicate).toBe(true)

    // A different event id carrying the same message (sweep overlapping a
    // webhook) must not count unread twice either.
    await deliver(dmPayload(), 'evt_dm_1_dup')

    const conversations = await listConversations(workspaceId)
    const thread = await getConversation(workspaceId, conversations[0].id)
    expect(thread.messages).toHaveLength(1)
    expect(conversations[0].unreadCount).toBe(1)
  })

  test('a comment webhook writes one comment, linked to the account', async () => {
    const result = await deliver(commentPayload(), 'evt_cmt_1')
    expect(result.status).toBe(200)
    expect((result.body as any).inbox).toMatchObject({ handled: true, created: true })

    const comments = await listComments(workspaceId)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      zernioCommentId: 'cmt_1',
      platform: 'instagram',
      text: 'MERGE',
      authorUsername: 'dana',
      status: 'new',
      isOwn: false,
    })
  })

  test('the account\'s own comment is not work to answer', async () => {
    await deliver(
      commentPayload({
        comment: {
          id: 'cmt_own_1',
          text: 'Thanks Dana!',
          createdTime: '2026-10-19T20:05:00.000Z',
          author: { id: 'zernio_ig', username: 'acme.ig', isOwnAccount: true },
          platformPostId: 'ig_media_1',
        },
      }),
      'evt_cmt_own',
    )

    const comments = await listComments(workspaceId)
    expect(comments.map((comment: any) => comment.zernioCommentId)).not.toContain('cmt_own_1')

    const all = await listComments(workspaceId, { includeOwn: true })
    expect(all.find((comment: any) => comment.zernioCommentId === 'cmt_own_1')).toMatchObject({
      isOwn: true,
      status: 'replied',
    })
  })
})

describe('replying', () => {
  test('a DM reply goes out once through the owning account and lands in the thread', async () => {
    const [conversation] = await listConversations(workspaceId)
    const reply = await replyToConversation(workspaceId, conversation.id, { text: 'Yes — we ship to Canada.' })

    const sent = calls.filter((call) => call.method === 'POST' && call.path === '/inbox/conversations/conv_1/messages')
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual({ accountId: 'zernio_ig', message: 'Yes — we ship to Canada.' })
    // An Idempotency-Key is what makes a retry after a lost response safe.
    expect(sent[0].idempotencyKey).toBeString()

    expect(reply).toMatchObject({ providerMessageId: 'msg_out_1', metered: false })

    const thread = await getConversation(workspaceId, conversation.id)
    expect(thread.messages.map((message: any) => message.direction)).toEqual(['incoming', 'outgoing'])
    expect(thread.conversation.unreadCount).toBe(0)
  })

  test('the read marker follows the thread, not the clock', async () => {
    const [conversation] = await listConversations(workspaceId)
    await replyToConversation(workspaceId, conversation.id, { text: 'Anchored reply' })

    const row = await db.socialConversation.findFirst({ where: { id: conversation.id } })
    const newestIncoming = await db.socialMessage.findFirst({
      where: { conversationId: conversation.id, direction: 'incoming' },
      orderBy: { sentAt: 'desc' },
    })
    // The reply row itself carries our clock; the marker must still sit on the
    // newest thing the reader was shown, or a message the provider sent before
    // the reply but delivered after it would be swept away as already read.
    expect(row.lastReadAt.getTime()).toBe(newestIncoming.sentAt.getTime())
    expect(newestIncoming.zernioMessageId).toBe('msg_in_1')
    expect(row.lastReadAt.getTime()).toBeLessThan(row.lastMessageAt.getTime())
  })

  test('a repeated reply is a new send, while a retry of the same one is not', async () => {
    const [conversation] = await listConversations(workspaceId)
    const keysFor = () =>
      calls
        .filter((call) => call.method === 'POST' && call.path === '/inbox/conversations/conv_1/messages')
        .map((call) => call.idempotencyKey)

    const baseline = keysFor().length
    await replyToConversation(workspaceId, conversation.id, { text: 'Repeated answer' })
    await replyToConversation(workspaceId, conversation.id, { text: 'Repeated answer' })
    const keys = keysFor().slice(baseline)
    // A deliberate second copy of the same words has to actually go out, so it
    // cannot share the first attempt's key.
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])

    // A send whose response never arrives records nothing, so its retry derives
    // the very same key — which is the whole point of the key.
    const previous = getSocialClient()
    setSocialClient({
      mode: 'cloud',
      async request(req: any) {
        calls.push(req)
        throw new Error('socket hang up')
      },
    } as any)
    try {
      await expect(
        replyToConversation(workspaceId, conversation.id, { text: 'Repeated answer' }),
      ).rejects.toThrow()
    } finally {
      setSocialClient(previous as any)
    }

    const lostKey = keysFor()[baseline + 2]
    await replyToConversation(workspaceId, conversation.id, { text: 'Repeated answer' })
    expect(keysFor()[baseline + 3]).toBe(lostKey)
  })

  test('a comment reply is addressed to the comment and marks it answered', async () => {
    const [comment] = await listComments(workspaceId)
    const reply = await replyToComment(workspaceId, comment.id, { text: 'Just merged — thanks!' })

    const sent = calls.find((call) => call.method === 'POST' && call.path === '/inbox/comments/zernio_post_1')
    expect(sent.body).toEqual({
      accountId: 'zernio_ig',
      message: 'Just merged — thanks!',
      commentId: 'cmt_1',
    })
    expect(reply.providerReplyId).toBe('cmt_reply_1')

    const after = await db.socialComment.findFirst({ where: { workspaceId, zernioCommentId: 'cmt_1' } })
    expect(after.status).toBe('replied')
    expect(after.repliedAt).not.toBeNull()

    // Our own reply is stored immediately, so the thread shows it without
    // waiting for the platform to echo it back.
    const withOwn = await listComments(workspaceId, { includeOwn: true })
    expect(withOwn.some((row: any) => row.zernioCommentId === 'cmt_reply_1' && row.isOwn)).toBe(true)
  })

  test('an empty reply, a missing thread and an own comment are refused', async () => {
    const [conversation] = await listConversations(workspaceId)
    await expect(replyToConversation(workspaceId, conversation.id, { text: '   ' })).rejects.toMatchObject({
      status: 400,
      code: 'empty_message',
    })
    await expect(replyToConversation(workspaceId, 'no-such-id', { text: 'hi' })).rejects.toMatchObject({
      status: 404,
    })

    const own = await db.socialComment.findFirst({ where: { workspaceId, zernioCommentId: 'cmt_own_1' } })
    await expect(replyToComment(workspaceId, own.id, { text: 'hi' })).rejects.toMatchObject({
      status: 409,
      code: 'comment_is_own',
    })
  })

  test('another workspace cannot reach this one\'s threads', async () => {
    const [conversation] = await listConversations(workspaceId)
    await expect(replyToConversation('other-workspace', conversation.id, { text: 'hi' })).rejects.toMatchObject({
      status: 404,
    })
    await expect(getConversation('other-workspace', conversation.id)).rejects.toMatchObject({ status: 404 })
  })
})

describe('backfill', () => {
  test('the sweep fills history the webhook never saw, and converges with what it did', async () => {
    const result = await backfillInbox(workspaceId)
    expect(result.conversations).toBeGreaterThanOrEqual(2)
    // msg_in_1 already existed from the webhook; msg_old_1 is new.
    expect(result.comments).toBeGreaterThanOrEqual(1)
    expect(result.failedAccounts).toEqual([])

    const conversations = await listConversations(workspaceId)
    const first = conversations.find((row: any) => row.zernioConversationId === 'conv_1')
    const thread = await getConversation(workspaceId, first.id)
    expect(thread.messages.map((message: any) => message.zernioMessageId).sort()).toEqual([
      'msg_in_1',
      'msg_old_1',
      'msg_out_1',
    ])

    // Running it again changes nothing: same provider ids, same rows.
    const before = thread.messages.length
    await backfillInbox(workspaceId)
    const after = await getConversation(workspaceId, first.id)
    expect(after.messages.length).toBe(before)

    const comments = await listComments(workspaceId)
    expect(comments.map((comment: any) => comment.zernioCommentId).sort()).toEqual(['cmt_1', 'cmt_2'])
  })

  test('marking a thread read clears its unread count', async () => {
    await deliver(
      dmPayload({
        message: {
          id: 'msg_in_2',
          conversationId: 'conv_1',
          platform: 'instagram',
          direction: 'incoming',
          text: 'Any update?',
          sender: { id: 'psid_9', name: 'Dana Reed' },
          createdAt: '2026-10-19T22:00:00.000Z',
        },
      }),
      'evt_dm_2',
    )
    const conversations = await listConversations(workspaceId)
    const first = conversations.find((row: any) => row.zernioConversationId === 'conv_1')
    expect(first.unreadCount).toBe(1)

    const read = await markConversationRead(workspaceId, first.id)
    expect(read.unreadCount).toBe(0)
    // Anchored to the newest message in the thread, not to "now" — otherwise a
    // message sent before this read but delivered after it never counts.
    expect(read.lastReadAt.toISOString()).toBe('2026-10-19T22:00:00.000Z')
  })
})

describe('a long thread', () => {
  test('opens on its recent end and pages backwards to the first message', async () => {
    const thread = await db.socialConversation.create({
      data: { workspaceId, zernioConversationId: 'conv_long', platform: 'instagram' },
    })
    const base = Date.UTC(2026, 9, 19, 12, 0, 0)

    // 250 messages, so the default 100-message window cannot hold them.
    for (let index = 1; index <= 250; index++) {
      await db.socialMessage.create({
        data: {
          workspaceId,
          conversationId: thread.id,
          zernioMessageId: `msg_long_${index}`,
          direction: index % 2 ? 'incoming' : 'outgoing',
          platform: 'instagram',
          text: `long ${index}`,
          sentAt: new Date(base + index * 60_000),
        },
      })
    }

    const first = await getConversation(workspaceId, thread.id)
    expect(first.messages).toHaveLength(100)
    expect(first.messages.at(-1).text).toBe('long 250')
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBe(first.messages[0].id)

    // Page backwards: strictly older, no overlap, and it terminates at message 1.
    const second = await getConversation(workspaceId, thread.id, { before: first.nextCursor })
    expect(second.messages.at(-1).text).toBe('long 150')
    expect(second.messages[0].text).toBe('long 51')
    const third = await getConversation(workspaceId, thread.id, { before: second.nextCursor })
    expect(third.messages.at(-1).text).toBe('long 50')
    expect(third.messages[0].text).toBe('long 1')
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBeNull()

    // The whole thread, read through the cursor, is every message exactly once.
    const seen = [...third.messages, ...second.messages, ...first.messages].map((message: any) => message.text)
    expect(new Set(seen).size).toBe(250)

    // A cursor from another thread is refused rather than silently ignored.
    await expect(
      getConversation(workspaceId, thread.id, { before: 'not-a-message-of-this-thread' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })

    await db.socialMessage.deleteMany({ where: { conversationId: thread.id } })
    await db.socialConversation.delete({ where: { id: thread.id } })
  })
})

describe('a payload the event catalog refuses', () => {
  test('is reported as a failure to retry, and the inbox row is still written', async () => {
    const payload = commentPayload({
      comment: {
        id: 'cmt_rejected',
        text: 'the catalog will refuse this event',
        createdTime: '2026-10-19T23:00:00.000Z',
        author: { id: 'ig_user_9', username: 'pat' },
        platformPostId: 'ig_media_1',
      },
    })

    // `externalId` must be a string in the catalog; a number cannot be.
    const result = await applySocialEvent({
      workspaceId,
      externalId: 12345 as unknown as string,
      eventId: 'evt_rejected',
      type: 'comment.received',
      account: { zernioAccountId: 'zernio_ig', platform: 'instagram', username: 'acme.ig' },
      detail: payload.comment,
      payload,
    })

    // Not a silent `200 { ok: true }`: the trigger did not run, so a provider
    // (or the desktop) must see a failure and retry.
    expect(result.status).toBe(502)
    expect((result.body as any).error.code).toBe('social_event_rejected')

    // The comment itself landed, so nothing is lost while it retries.
    expect((result.body as any).inbox).toMatchObject({ handled: true, created: true })
    const stored = await db.socialComment.findFirst({
      where: { workspaceId, zernioCommentId: 'cmt_rejected' },
    })
    expect(stored).not.toBeNull()
  })
})
