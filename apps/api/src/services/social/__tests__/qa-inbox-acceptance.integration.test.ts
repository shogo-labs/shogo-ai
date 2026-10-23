// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-71 P4 QA acceptance — the properties AC3 needs that the service tests do
 * not pin: a thread belongs to one tenant only, a comment is answered from the
 * account that owns it, and a long thread opens on its recent messages rather
 * than its oldest ones.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setupChannelsTestDb } from '../../../__tests__/helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../../../lib/prisma')
const { setSocialClient } = await import('../client')
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
const suffix = crypto.randomUUID().slice(0, 8)
const calls: any[] = []

let workspaceA = ''
let workspaceB = ''
let igA = ''
let igB = ''
let conversationB = ''
let commentA = ''

const ingest = (workspaceId: string, account: { zernioAccountId: string }, payload: any) =>
  applySocialEvent({
    workspaceId,
    eventId: payload.eventId,
    externalId: `ws_${workspaceId}`,
    type: payload.type,
    account: { ...account, platform: 'instagram', username: 'qa.ig' },
    detail: payload.body[payload.type.split('.')[0]],
    payload: payload.body,
  })

beforeAll(async () => {
  const [a, b] = await Promise.all([
    db.workspace.create({ data: { name: 'QA A', slug: `qa-a-${suffix}`, kind: 'team' } }),
    db.workspace.create({ data: { name: 'QA B', slug: `qa-b-${suffix}`, kind: 'team' } }),
  ])
  workspaceA = a.id
  workspaceB = b.id

  for (const [workspaceId, tag] of [
    [workspaceA, 'a'],
    [workspaceB, 'b'],
  ] as const) {
    const profile = await db.socialProfile.create({
      data: {
        workspaceId,
        localWorkspaceId: '',
        zernioProfileId: `zp_qa_${tag}_${suffix}`,
        externalId: `ws_${workspaceId}`,
        name: `QA ${tag}`,
      },
    })
    const account = await db.socialAccount.create({
      data: {
        workspaceId,
        profileId: profile.id,
        zernioAccountId: `acc_qa_${tag}_${suffix}`,
        platform: 'instagram',
        username: `qa_${tag}.ig`,
        displayName: `QA ${tag}`,
      },
    })
    if (tag === 'a') {
      igA = account.id
      // A second account on the same platform: "one workspace = one brand"
      // does not mean "one account per platform".
      await db.socialAccount.create({
        data: {
          workspaceId,
          profileId: profile.id,
          zernioAccountId: `acc_qa_a2_${suffix}`,
          platform: 'instagram',
          username: `qa_a2.ig`,
          displayName: 'QA A second',
        },
      })
    } else {
      igB = account.id
    }
  }

  setSocialClient({
    mode: 'cloud',
    async request(req: any) {
      calls.push(req)
      if (req.path.endsWith('/messages')) return { data: { messageId: `out_${calls.length}_${suffix}` } }
      if (req.path.startsWith('/inbox/comments/')) return { data: { commentId: `reply_${calls.length}_${suffix}` } }
      return { data: {} }
    },
  })

  // A DM thread of B's, which A must never see.
  const ingested = await ingest(workspaceB, { zernioAccountId: `acc_qa_b_${suffix}` }, {
    eventId: `evt_b_${suffix}`,
    type: 'message.received',
    body: {
      conversation: { id: `conv_b_${suffix}`, platform: 'instagram', status: 'active' },
      message: {
        id: `msg_b_${suffix}`,
        conversationId: `conv_b_${suffix}`,
        direction: 'incoming',
        text: 'B private thread',
        sender: { name: 'B person' },
        // Pinned before the 120 messages the long-thread case adds, so "newest"
        // is a property of the fixture and not of the wall clock.
        createdAt: '2026-10-19T12:00:00.000Z',
      },
    },
  })
  conversationB = ingested.body.inbox.conversationId

  // A comment on A's post, linked to A's first account.
  const comment = await ingest(workspaceA, { zernioAccountId: `acc_qa_a_${suffix}` }, {
    eventId: `evt_c_${suffix}`,
    type: 'comment.received',
    body: {
      post: { id: `post_a_${suffix}`, platform: 'instagram' },
      comment: {
        id: `cmt_a_${suffix}`,
        text: 'MERGE',
        post: { id: `post_a_${suffix}` },
        author: { name: 'Marta', username: 'marta' },
      },
    },
  })
  commentA = comment.body.inbox.commentId
})

afterAll(async () => {
  setSocialClient(null)
  await db.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } }).catch(() => {})
})

describe('inbox tenancy', () => {
  test('another workspace\'s thread is invisible and unrepliable', async () => {
    const list = await listConversations(workspaceA)
    expect(list.map((row: any) => row.id)).not.toContain(conversationB)

    await expect(getConversation(workspaceA, conversationB)).rejects.toThrow()
    await expect(replyToConversation(workspaceA, conversationB, { text: 'hello' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test('another workspace\'s comment is invisible and unrepliable', async () => {
    await expect(listComments(workspaceB)).resolves.toHaveLength(0)
    const own = await listComments(workspaceA)
    expect(own).toHaveLength(1)
    expect(own[0].id).toBe(commentA)
  })
})

describe('replying to a comment', () => {
  test('goes out from the account the comment arrived on, not just any Instagram account', async () => {
    calls.length = 0
    await replyToComment(workspaceA, commentA, { text: 'Sent you a DM!' })

    const outgoing = calls.find((call) => call.method === 'POST' && call.path.startsWith('/inbox/comments/'))
    expect(outgoing).toBeTruthy()
    expect(outgoing.body.accountId).toBe(`acc_qa_a_${suffix}`)
    expect(outgoing.path).toBe(`/inbox/comments/post_a_${suffix}`)
  })
})

describe('a long thread', () => {
  test('opens on its recent messages, not its oldest ones', async () => {
    const conversation = await db.socialConversation.findUnique({
      where: { zernioConversationId: `conv_b_${suffix}` },
    })
    // 120 messages is an ordinary support thread, and the default window is 100.
    for (let index = 2; index <= 121; index++) {
      await db.socialMessage.create({
        data: {
          workspaceId: workspaceB,
          conversationId: conversation.id,
          zernioMessageId: `msg_b_${index}_${suffix}`,
          direction: 'incoming',
          platform: 'instagram',
          text: `message ${index}`,
          sentAt: new Date(Date.UTC(2026, 9, 19, 12, 0, index)),
        },
      })
    }

    const view = await getConversation(workspaceB, conversation.id)
    expect(view.messages).toHaveLength(100)
    // The newest message must be in the window — a chat UI that opens on
    // message 1 of 121 can never show the reply someone is answering.
    expect(view.messages.at(-1)?.text).toBe('message 121')
  })
})

describe('the unread badge', () => {
  test('a sweep never hides a message the reader has not seen', async () => {
    const conversationId = `conv_late_${suffix}`
    const ingestAt = (id: string, text: string, sentAt: string, eventId: string) =>
      ingest(workspaceA, { zernioAccountId: `acc_qa_a_${suffix}` }, {
        eventId,
        type: 'message.received',
        body: {
          conversation: { id: conversationId, platform: 'instagram', status: 'active' },
          message: {
            id,
            conversationId,
            direction: 'incoming',
            text,
            createdAt: sentAt,
            sender: { name: 'Late Person' },
          },
        },
      })

    await ingestAt(`late_1_${suffix}`, 'first question', '2026-10-19T11:00:00.000Z', `evt_late1_${suffix}`)
    const thread = await db.socialConversation.findUnique({ where: { zernioConversationId: conversationId } })
    expect(thread.unreadCount).toBe(1)

    // Someone reads the thread while there is nothing new in it.
    await markConversationRead(workspaceA, thread.id)

    // A message the provider only tells us about afterwards, but which was sent
    // before that read: the reader has never seen it, so it is unread.
    await ingestAt(`late_2_${suffix}`, 'second question', '2026-10-19T11:05:00.000Z', `evt_late2_${suffix}`)
    expect(
      (await db.socialConversation.findUnique({ where: { zernioConversationId: conversationId } })).unreadCount,
    ).toBe(1)

    // The desktop comes back from offline and sweeps. The sweep brings in one
    // more message nobody has seen, and recomputes the badge.
    setSocialClient({
      mode: 'cloud',
      async request(req: any) {
        if (req.path === '/inbox/conversations') {
          return {
            data: [
              {
                id: conversationId,
                accountId: `acc_qa_a_${suffix}`,
                platform: 'instagram',
                status: 'active',
                unreadCount: 2,
                updatedTime: '2026-10-19T11:06:00.000Z',
              },
            ],
          }
        }
        return {
          messages: [
            { id: `late_1_${suffix}`, direction: 'incoming', text: 'first question', createdAt: '2026-10-19T11:00:00.000Z' },
            { id: `late_2_${suffix}`, direction: 'incoming', text: 'second question', createdAt: '2026-10-19T11:05:00.000Z' },
            { id: `late_3_${suffix}`, direction: 'incoming', text: 'third question', createdAt: '2026-10-19T11:06:00.000Z' },
          ],
        }
      },
    })
    try {
      await backfillInbox(workspaceA)
    } finally {
      setSocialClient(null)
    }

    const swept = await db.socialConversation.findUnique({ where: { zernioConversationId: conversationId } })
    // Both late messages are unseen; a read that happened before they arrived
    // must not be able to clear them.
    expect(swept.unreadCount).toBe(2)
  })
})
