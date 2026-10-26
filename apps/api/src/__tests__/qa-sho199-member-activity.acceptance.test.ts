// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-199, member activity: board activity, the people/agents
 * split, and the per-person export of what they sent.
 *
 * The card's own tests mock `lib/prisma`, so no real row ever reaches a real
 * query: the audience rule, the author stamp and the two-source keyset page are
 * all asserted against hand-built fixtures. This file closes that gap and runs
 * the same paths against a real database (desktop SQLite migrations by default,
 * Postgres when `CHANNELS_TEST_PG_URL` is set — which is also how the cloud
 * migration track is exercised):
 *
 *   1. The split. Seed one message per audience with a real mention row and a
 *      real DM membership, and the four buckets must both match and add up.
 *   2. Board activity, from the person's own `WorkItemEvent`s only — an
 *      agent's event has no user and must not be credited to anyone.
 *   3. The export: only what this person sent, full text and ids, no assistant
 *      or agent rows, no deleted rows, no rows from another workspace, and a
 *      cursor that neither repeats nor loses a row.
 *   4. The routes and the gate: admin 200, non-admin 403 on every one of the
 *      three, CSV rows equal to the JSON rows, `detail=board` narrows instead
 *      of switching route.
 *   5. `ChatMessage.authorUserId` stamped at the one insert point, so a forged
 *      body value is ignored and the prompt lands in the sender's export.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { setupChannelsTestDb, seedWorkspace, type SeededWorkspace } from './helpers/channels-test-db'

setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { workspaceAgentRoutes } = await import('../routes/workspace-agent')
const { getMemberWorkActivity } = await import('../services/engagement-analytics.service')
const { getMemberMessages, getAllMemberMessages } = await import('../services/member-messages.service')
const { chatMessageHooks } = await import('../generated/chat-message.hooks')

const db = prisma as any

/** Fixtures are relative to this instant, so no assertion reads the wall clock. */
const NOW = new Date('2026-10-24T12:00:00.000Z')
const MINUTE = 60_000
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MINUTE)
const FROM = '2026-10-24T05:00:00.000Z'
const UNTIL = '2026-10-24T12:00:00.000Z'

let seeded: SeededWorkspace
/** The person under review: an ordinary member, not the admin looking them up. */
let alice = ''
let admin = ''
let bob = ''
let viewer = ''

let publicConv = ''
let dmPerson = ''
let dmAgent = ''
let agentRootId = ''
let cardRootId = ''
let cardId = ''
let cardKey = 'QA-199'
let wsSessionId = ''
let projectSessionId = ''

/** The people/agents split this fixture is built to produce. */
const EXPECTED = {
  messagesSent: 7,
  person: 1,
  agent: 3,
  mixed: 1,
  channel: 2,
  /** Three: a stamped prompt, a pre-column prompt falling back to the session owner, and one in a shared project chat. */
  agentChatPrompts: 3,
  unattributed: 1,
  cardsCreated: 1,
  cardsMoved: 1,
  cardsCompleted: 1,
  cardComments: 1,
  cardAssignments: 1,
}

let aliceAddress = ''

beforeAll(async () => {
  seeded = await seedWorkspace(db)
  admin = seeded.owner
  alice = seeded.member
  viewer = seeded.viewer
  // A second person to DM — the outsider belongs to another workspace and must never appear.
  bob = seeded.outsider
  await db.member.create({ data: { userId: bob, workspaceId: seeded.workspaceId, role: 'member' } })

  aliceAddress = (await db.user.findUnique({ where: { id: alice }, select: { email: true } }))!.email

  const conversation = (data: Record<string, unknown>) =>
    db.conversation.create({ data: { workspaceId: seeded.workspaceId, provider: 'shogo', ...data } })

  const channel = await conversation({ kind: 'public', name: 'shogo-dev', slug: 'shogo-dev' })
  publicConv = channel.id
  const personDm = await conversation({ kind: 'dm', dmKey: [alice, bob].sort().join('|') })
  dmPerson = personDm.id
  const agentDm = await conversation({ kind: 'dm', dmKey: `agent|${alice}` })
  dmAgent = agentDm.id

  await db.conversationMember.createMany({
    data: [
      { conversationId: dmPerson, memberType: 'user', userId: alice },
      { conversationId: dmPerson, memberType: 'user', userId: bob },
      { conversationId: dmAgent, memberType: 'user', userId: alice },
      { conversationId: dmAgent, memberType: 'agent', projectId: seeded.projectId, projectAgentId: 'reviewer' },
    ],
  })

  const seqs: Record<string, number> = {}
  const nextSeq = (conversationId: string) => (seqs[conversationId] = (seqs[conversationId] ?? 0) + 1)

  const message = async (data: Record<string, any>) => {
    const row = await db.conversationMessage.create({
      data: {
        workspaceId: seeded.workspaceId,
        authorType: 'user',
        authorUserId: alice,
        seq: nextSeq(data.conversationId),
        deletedAt: null,
        ...data,
      },
    })
    return row.id as string
  }

  // A thread whose root an agent posted: an untagged reply in it is aimed at that agent.
  agentRootId = (
    await db.conversationMessage.create({
      data: {
        conversationId: publicConv,
        workspaceId: seeded.workspaceId,
        seq: nextSeq(publicConv),
        authorType: 'agent',
        authorAgentRef: { name: 'Shogo Dev 1' },
        text: 'I picked this up',
      },
    })
  ).id

  // A card thread: a post in it names the card in the export.
  cardRootId = (
    await db.conversationMessage.create({
      data: {
        conversationId: publicConv,
        workspaceId: seeded.workspaceId,
        seq: nextSeq(publicConv),
        authorType: 'user',
        authorUserId: bob,
        text: 'Opened a card for the export',
      },
    })
  ).id

  // ---- the six team-chat messages under review (all by alice) ---------------
  await message({ conversationId: dmPerson, text: 'dm to a person', createdAt: at(60) })
  await message({ conversationId: dmAgent, text: 'dm to an agent', createdAt: at(120) })
  const m3 = await message({ conversationId: publicConv, text: 'tagged the agent', createdAt: at(180) })
  const m4 = await message({ conversationId: publicConv, text: 'tagged both', createdAt: at(240) })
  await message({ conversationId: publicConv, text: 'plain channel post', createdAt: at(300) })
  await message({
    conversationId: publicConv,
    threadRootId: agentRootId,
    text: 'replying in the agent thread',
    createdAt: at(360),
  })
  await message({
    conversationId: publicConv,
    threadRootId: cardRootId,
    text: 'comment on the card thread',
    createdAt: at(420),
  })

  await db.conversationMention.createMany({
    data: [
      { messageId: m3, targetType: 'agent', projectId: seeded.projectId, projectAgentId: 'reviewer' },
      { messageId: m4, targetType: 'user', targetUserId: bob },
      { messageId: m4, targetType: 'agent', projectId: seeded.projectId, projectAgentId: 'reviewer' },
    ],
  })

  // ---- decoys that must never reach alice's rows ----------------------------
  await message({ conversationId: publicConv, authorUserId: viewer, text: 'someone else typed this', createdAt: at(150) })
  await message({
    conversationId: publicConv,
    authorType: 'agent',
    authorUserId: null,
    authorAgentRef: { name: 'Shogo Dev 2' },
    text: 'the agent answered',
    createdAt: at(165),
  })
  await message({ conversationId: publicConv, text: 'deleted by its author', createdAt: at(170), deletedAt: at(169) })
  await db.conversationMessage.create({
    data: {
      conversationId: (
        await db.conversation.create({
          data: { workspaceId: seeded.otherWorkspaceId, kind: 'public', name: 'elsewhere', slug: 'elsewhere' },
        })
      ).id,
      workspaceId: seeded.otherWorkspaceId,
      seq: 1,
      authorType: 'user',
      authorUserId: alice,
      text: 'same person, another workspace',
      createdAt: at(60),
    },
  })
  // ---- agent chats ---------------------------------------------------------
  const wsSession = await db.chatSession.create({
    data: {
      inferredName: 'export work',
      contextType: 'workspace',
      workspaceId: seeded.workspaceId,
      createdByUserId: alice,
    },
  })
  wsSessionId = wsSession.id
  const projectSession = await db.chatSession.create({
    data: { inferredName: 'project chat', contextType: 'project', contextId: seeded.projectId },
  })
  projectSessionId = projectSession.id

  await db.chatMessage.createMany({
    data: [
      // Stamped author, in the person's own chat.
      { sessionId: wsSessionId, role: 'user', content: 'prompt one', authorUserId: alice, createdAt: at(30) },
      // Written before the column existed: falls back to the session owner.
      { sessionId: wsSessionId, role: 'user', content: 'prompt two', authorUserId: null, createdAt: at(45) },
      // The assistant's reply is output, never something the person sent.
      { sessionId: wsSessionId, role: 'assistant', content: 'the answer', authorUserId: null, createdAt: at(29) },
      // A shared project chat prompt with its author stamped: still alice's.
      { sessionId: projectSessionId, role: 'user', content: 'prompt in the shared project chat', authorUserId: alice, createdAt: at(75) },
      // Shared chat, no author, no owner: nobody can be credited.
      { sessionId: projectSessionId, role: 'user', content: 'prompt nobody owns', authorUserId: null, createdAt: at(76) },
      // A relay the server wrote on someone's behalf: not something they typed.
      { sessionId: projectSessionId, role: 'user', agent: 'project_call', content: 'relayed call', authorUserId: alice, createdAt: at(77) },
    ],
  })

  // The same person, in a chat that belongs to another workspace: never exported from this one.
  const foreignSession = await db.chatSession.create({
    data: { inferredName: 'other workspace chat', contextType: 'workspace', workspaceId: seeded.otherWorkspaceId, createdByUserId: alice },
  })
  await db.chatMessage.create({
    data: { sessionId: foreignSession.id, role: 'user', content: 'prompt in another workspace', authorUserId: alice, createdAt: at(78) },
  })

  // ---- the board ----------------------------------------------------------
  const board = await db.board.create({
    data: {
      workspaceId: seeded.workspaceId,
      conversationId: publicConv,
      name: 'QA Board',
      slug: `qa-board-${seeded.workspaceId.slice(0, 6)}`,
      keyPrefix: 'QA',
      itemType: 'task',
    },
  })
  await db.boardColumn.create({ data: { boardId: board.id, name: 'Planning', position: 0, category: 'backlog' } })
  const done = await db.boardColumn.create({ data: { boardId: board.id, name: 'Done', position: 1, category: 'done' } })

  const card = await db.workItem.create({
    data: {
      workspaceId: seeded.workspaceId,
      boardId: board.id,
      columnId: done.id,
      key: cardKey,
      number: 199,
      title: 'Board activity in member_activity',
      threadRootMessageId: cardRootId,
      conversationId: publicConv,
      columnEnteredAt: at(20),
      lastActivityAt: at(10),
    },
  })
  cardId = card.id
  cardKey = card.key

  const agentEvent = (type: string, minutes: number) =>
    db.workItemEvent.create({
      data: {
        workItemId: card.id,
        workspaceId: seeded.workspaceId,
        type,
        actorUserId: null,
        actorAgentRef: `project:${seeded.projectId}`,
        eventData: { to: { column: 'Done', category: 'done' } },
        createdAt: at(minutes),
      },
    })

  await db.workItemEvent.createMany({
    data: [
      {
        workItemId: card.id,
        workspaceId: seeded.workspaceId,
        type: 'created',
        actorUserId: alice,
        eventData: { column: 'Planning' },
        createdAt: at(60),
      },
      {
        workItemId: card.id,
        workspaceId: seeded.workspaceId,
        type: 'moved',
        actorUserId: alice,
        eventData: { from: { column: 'Planning' }, to: { column: 'Done', category: 'done' } },
        createdAt: at(30),
      },
      { workItemId: card.id, workspaceId: seeded.workspaceId, type: 'commented', actorUserId: alice, createdAt: at(20) },
      {
        workItemId: card.id,
        workspaceId: seeded.workspaceId,
        type: 'assigned',
        actorUserId: alice,
        eventData: { label: 'Shogo Dev 1' },
        createdAt: at(10),
      },
    ],
  })
  // The agent moved the same card after her: it must not be credited to her.
  await agentEvent('moved', 5)
})

const windowQuery = `since=${encodeURIComponent(FROM)}&until=${encodeURIComponent(UNTIL)}&tz=UTC`

function appAs(userId?: string) {
  const app = new Hono()
  app.route(
    '/api',
    workspaceAgentRoutes({
      authorize: async (c: any) => ({
        workspaceId: c.req.param('workspaceId'),
        ...(userId ? { userId } : {}),
      }),
    }),
  )
  return app
}

const messagesUrl = (qs: string) =>
  `/api/workspaces/${seeded.workspaceId}/member-activity/messages?user=${encodeURIComponent(aliceAddress)}&${qs}`

describe('the people/agents split, the board totals and what a person touched', () => {
  const summary = async () =>
    getMemberWorkActivity(
      seeded.workspaceId,
      { userId: alice, name: 'Alice', email: aliceAddress, image: null, role: 'member' },
      { since: FROM, until: UNTIL, tz: 'UTC' },
      NOW,
    )

  test('counts each message against the audience it was aimed at, and the four add up', async () => {
    const activity = await summary()
    const totals = activity.totals

    expect(totals.messagesToPeople).toBe(EXPECTED.person)
    expect(totals.messagesToAgents).toBe(EXPECTED.agent)
    expect(totals.messagesMixed).toBe(EXPECTED.mixed)
    expect(totals.messagesToChannel).toBe(EXPECTED.channel)
    expect(totals.messagesSent).toBe(EXPECTED.messagesSent)
    expect(
      totals.messagesToPeople + totals.messagesToAgents + totals.messagesMixed + totals.messagesToChannel,
    ).toBe(totals.messagesSent)
  })

  test('counts agent-chat prompts for their sender, and reports the ones nobody can be credited for', async () => {
    const totals = (await summary()).totals
    // prompt one (stamped) + the shared project-chat prompt (stamped);
    // prompt two has no author but the session owner is alice, so it is hers too.
    expect(totals.agentChatPrompts).toBe(EXPECTED.agentChatPrompts)
    expect(totals.unattributedPrompts).toBe(EXPECTED.unattributed)
  })

  test('credits only the person`s own board events, with the done column counted as completed', async () => {
    const totals = (await summary()).totals
    expect(totals.cardsCreated).toBe(EXPECTED.cardsCreated)
    expect(totals.cardsMoved).toBe(EXPECTED.cardsMoved)
    expect(totals.cardsCompleted).toBe(EXPECTED.cardsCompleted)
    expect(totals.cardComments).toBe(EXPECTED.cardComments)
    expect(totals.cardAssignments).toBe(EXPECTED.cardAssignments)
  })

  test('lists the cards she touched, with where each stands now and her own last action', async () => {
    const activity = await summary()
    expect(activity.cards).toHaveLength(1)
    const card = activity.cards[0]
    expect(card.key).toBe(cardKey)
    expect(card.title).toBe('Board activity in member_activity')
    expect(card.board).toBe('QA Board')
    expect(card.column).toBe('Done')
    // The agent's later move is not hers, so her last action is the assignment.
    expect(card.lastAction).toBe('assigned Shogo Dev 1')
  })

  test('recent is never empty for someone whose activity is messages and card moves', async () => {
    const activity = await summary()
    const kinds = new Set(activity.recent.map((r) => r.kind))
    expect(activity.recent.length).toBeGreaterThan(5)
    expect(kinds.has('message')).toBe(true)
    expect(kinds.has('card_event')).toBe(true)
    expect(kinds.has('chat_prompt')).toBe(true)
    // Every record carries an id, so a reader can go and look at it.
    for (const row of activity.recent) expect(row.id).toBeTruthy()
  })

  test('detail=board returns only card activity', async () => {
    const res = await appAs(admin).request(
      `/api/workspaces/${seeded.workspaceId}/member-activity?user=${encodeURIComponent(aliceAddress)}&detail=board&${windowQuery}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.activity.recent.length).toBeGreaterThan(0)
    expect(body.activity.recent.every((r: any) => r.kind === 'card_event')).toBe(true)
    expect(body.activity.cards).toHaveLength(1)
  })
})

describe('the export of what one person sent', () => {
  test('returns her messages, with full text, ids and the audience of each', async () => {
    const page = await getMemberMessages(seeded.workspaceId, alice, { since: new Date(FROM), until: new Date(UNTIL), limit: 200 })
    const texts = page.items.map((i) => i.text)

    expect(texts).toContain('dm to a person')
    expect(texts).toContain('dm to an agent')
    expect(texts).toContain('tagged the agent')
    expect(texts).toContain('tagged both')
    expect(texts).toContain('plain channel post')
    expect(texts).toContain('replying in the agent thread')
    expect(texts).toContain('comment on the card thread')

    // Never someone else's message, the agent's answer, a deleted row or another workspace.
    expect(texts).not.toContain('someone else typed this')
    expect(texts).not.toContain('the agent answered')
    expect(texts).not.toContain('deleted by its author')
    expect(texts).not.toContain('same person, another workspace')

    for (const item of page.items) {
      expect(item.id).toBeTruthy()
      expect(['person', 'agent', 'mixed', 'channel']).toContain(item.audience)
      expect(item.text.length).toBeGreaterThan(0)
    }

    const byText = new Map(page.items.map((i) => [i.text, i]))
    expect(byText.get('dm to a person')!.audience).toBe('person')
    expect(byText.get('dm to an agent')!.audience).toBe('agent')
    expect(byText.get('tagged the agent')!.audience).toBe('agent')
    expect(byText.get('tagged both')!.audience).toBe('mixed')
    expect(byText.get('plain channel post')!.audience).toBe('channel')
    expect(byText.get('replying in the agent thread')!.audience).toBe('agent')
    expect(byText.get('comment on the card thread')!.workItemKey).toBe(cardKey)
    expect(page.unattributed).toBe(EXPECTED.unattributed)
  })

  test('includes the prompts she typed in an agent chat, and no replies', async () => {
    const page = await getMemberMessages(seeded.workspaceId, alice, {
      since: new Date(FROM),
      until: new Date(UNTIL),
      source: 'agent_chat',
      limit: 200,
    })
    const texts = page.items.map((i) => i.text)
    expect(texts).toHaveLength(3)
    expect(texts).toContain('prompt one')
    expect(texts).toContain('prompt two')
    expect(texts).toContain('prompt in the shared project chat')
    expect(texts).not.toContain('the answer')
    expect(texts).not.toContain('relayed call')
    expect(texts).not.toContain('prompt nobody owns')
    expect(texts).not.toContain('prompt in another workspace')
    for (const item of page.items) {
      expect(item.source).toBe('agent_chat')
      expect(item.audience).toBe('agent')
      expect(item.chatSession?.id).toBeTruthy()
    }
    // An agent-chat export still reports the prompts nobody can be credited for,
    // so a reader knows the list is incomplete rather than empty.
    expect(page.unattributed).toBe(EXPECTED.unattributed)
  })

  test('filters by audience and by source', async () => {
    const people = await getMemberMessages(seeded.workspaceId, alice, {
      since: new Date(FROM),
      until: new Date(UNTIL),
      audience: 'person',
      limit: 200,
    })
    expect(people.items.map((i) => i.text)).toEqual(['dm to a person'])

    const agents = await getMemberMessages(seeded.workspaceId, alice, {
      since: new Date(FROM),
      until: new Date(UNTIL),
      audience: 'agent',
      limit: 200,
    })
    expect(new Set(agents.items.map((i) => i.text))).toEqual(
      new Set(['dm to an agent', 'tagged the agent', 'replying in the agent thread', 'prompt one', 'prompt two', 'prompt in the shared project chat']),
    )

    const channelOnly = await getMemberMessages(seeded.workspaceId, alice, {
      since: new Date(FROM),
      until: new Date(UNTIL),
      source: 'team_chat',
      limit: 200,
    })
    expect(channelOnly.items).toHaveLength(EXPECTED.messagesSent)
    expect(channelOnly.items.every((i) => i.source === 'team_chat')).toBe(true)
  })

  test('pages with a stable cursor: every row once, none skipped', async () => {
    const all = await getMemberMessages(seeded.workspaceId, alice, { since: new Date(FROM), until: new Date(UNTIL), limit: 200 })
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard++) {
      const page = await getMemberMessages(seeded.workspaceId, alice, {
        since: new Date(FROM),
        until: new Date(UNTIL),
        limit: 4,
        cursor,
      })
      seen.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.sort()).toEqual(all.items.map((i) => i.id).sort())
  })

  test('the window is exclusive: a message outside it is not exported', async () => {
    const inside = await getMemberMessages(seeded.workspaceId, alice, {
      since: new Date('2026-10-24T10:55:00.000Z'),
      until: new Date('2026-10-24T11:05:00.000Z'),
      limit: 200,
    })
    expect(inside.items.map((i) => i.text)).toEqual(['dm to a person'])
  })

  test('the CSV is every page of the same rows', async () => {
    const { items, truncated } = await getAllMemberMessages(seeded.workspaceId, alice, {
      since: new Date(FROM),
      until: new Date(UNTIL),
    })
    const paged = await getMemberMessages(seeded.workspaceId, alice, { since: new Date(FROM), until: new Date(UNTIL), limit: 200 })
    expect(truncated).toBe(false)
    expect(items.map((i) => i.id).sort()).toEqual(paged.items.map((i) => i.id).sort())
  })
})

describe('the routes and the gate', () => {
  test('an admin gets a page with ids', async () => {
    const res = await appAs(admin).request(messagesUrl(windowQuery))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0].id).toBeTruthy()
    expect(body.nextCursor === null || typeof body.nextCursor === 'string').toBe(true)
  })

  test('the CSV downloads with its header and one line per message', async () => {
    const res = await appAs(admin).request(`${messagesUrl(windowQuery)}`.replace('/messages?', '/messages.csv?'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const text = await res.text()
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('created_at,source,audience,conversation,thread_root_id,card,chat_session_id,message_id,text')
    expect(lines.length).toBe(1 + EXPECTED.messagesSent + 3)
    expect(text).toContain('dm to a person')
    expect(text).not.toContain('the answer')
  })

  test('a non-admin is refused on all three lookups', async () => {
    const viewerApp = appAs(viewer)
    const summary = await viewerApp.request(
      `/api/workspaces/${seeded.workspaceId}/member-activity?user=${encodeURIComponent(aliceAddress)}`,
    )
    expect(summary.status).toBe(403)
    expect((await viewerApp.request(messagesUrl(windowQuery))).status).toBe(403)
    expect(
      (await viewerApp.request(`${messagesUrl(windowQuery)}`.replace('/messages?', '/messages.csv?'))).status,
    ).toBe(403)
  })

  test('an internal caller must name who is asking, and that person must be an admin', async () => {
    const internal = appAs()
    const noActor = await internal.request(
      `/api/workspaces/${seeded.workspaceId}/member-activity?user=${encodeURIComponent(aliceAddress)}`,
    )
    expect(noActor.status).toBe(400)
    const borrowed = await internal.request(
      `/api/workspaces/${seeded.workspaceId}/member-activity?user=${encodeURIComponent(aliceAddress)}&requestedBy=${viewer}`,
    )
    expect(borrowed.status).toBe(403)
    const ok = await internal.request(
      `/api/workspaces/${seeded.workspaceId}/member-activity/messages?user=${encodeURIComponent(aliceAddress)}&requestedBy=${admin}&${windowQuery}`,
    )
    expect(ok.status).toBe(200)
  })

  test('a bad audience is a 400, not an empty page', async () => {
    const res = await appAs(admin).request(`${messagesUrl(windowQuery)}&audience=everyone`)
    expect(res.status).toBe(400)
  })
})

describe('the author stamp at the insert point', () => {
  test('a forged authorUserId in the body is ignored; the signed-in user is stamped', async () => {
    const hook = await chatMessageHooks.beforeCreate(
      { sessionId: wsSessionId, role: 'user', content: 'typed through the hook', authorUserId: alice },
      { userId: admin, prisma: db, tunnelAuthenticated: true } as any,
    )
    expect(hook.ok).toBe(true)
    expect((hook.data as any).authorUserId).toBe(admin)

    const row = await db.chatMessage.create({
      data: {
        sessionId: wsSessionId,
        role: (hook.data as any).role,
        content: (hook.data as any).content,
        authorUserId: (hook.data as any).authorUserId,
        createdAt: at(1),
      },
    })

    // The admin typed it, so it is in the admin's export and not in alice's.
    const admins = await getMemberMessages(seeded.workspaceId, admin, { since: new Date(FROM), until: new Date(UNTIL), limit: 200 })
    expect(admins.items.map((i) => i.id)).toContain(row.id)
    const alices = await getMemberMessages(seeded.workspaceId, alice, { since: new Date(FROM), until: new Date(UNTIL), limit: 200 })
    expect(alices.items.map((i) => i.id)).not.toContain(row.id)
  })

  test('an assistant row is never stamped as a person', async () => {
    const hook = await chatMessageHooks.beforeCreate(
      { sessionId: wsSessionId, role: 'assistant', content: 'an answer', authorUserId: alice },
      { userId: alice, prisma: db, tunnelAuthenticated: true } as any,
    )
    expect(hook.ok).toBe(true)
    expect((hook.data as any).authorUserId).toBeNull()
  })
})

describe('both migration tracks carry the column', () => {
  test('the cloud and desktop migrations add the same column and index', () => {
    const read = (p: string) => readFileSync(resolve(import.meta.dir, p), 'utf-8')
    const cloud = read('../../../../prisma/migrations/20261024180000_add_chat_message_author/migration.sql')
    const desktop = read('../../../../apps/desktop/prisma/migrations/20261024180000_add_chat_message_author/migration.sql')
    for (const sql of [cloud, desktop]) {
      expect(sql).toContain('"authorUserId"')
      expect(sql).toContain('chat_messages_authorUserId_createdAt_idx')
    }
  })
})
