// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Member activity against a REAL database (SHO-199).
 *
 * The unit tests for these two services mock `lib/prisma`, so they prove the
 * mapping but never build a query: a wrong relation name (`chatSession` instead
 * of `session` on `ChatMessage`, `projectId` on `ChatSession` — it carries
 * `contextType`/`contextId`) passes every one of them and throws at runtime.
 * QA caught exactly that, and because `collectActivity` is shared it also took
 * down the live Analytics → Team dashboard.
 *
 * This replays the desktop migration history into a temp SQLite file and runs
 * the real queries: the summary (channel vs agent vs person, board totals, the
 * card roll-up) and the per-member records with their paging and filters.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const conversation = await import('../services/conversation.service')
const analytics = await import('../services/engagement-analytics.service')
const messages = await import('../services/member-messages.service')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let dmId: string
let agentRootId: string
let owner: analytics.WorkspaceMemberRef

const post = async (conversationId: string, authorUserId: string, text: string, extra: Record<string, unknown> = {}) => {
  const result = await conversation.postMessage({
    conversationId,
    authorType: 'user',
    authorUserId,
    text,
    ...extra,
  } as any)
  return result.row.id as string
}

const mention = (messageId: string, data: Record<string, unknown>) =>
  db.conversationMention.create({ data: { messageId, ...data } })

/** A project chat with the four kinds of prompt row the query must tell apart. */
async function seedAgentChats() {
  const makeSession = (over: Record<string, unknown>) =>
    db.chatSession.create({
      data: {
        inferredName: 'Export work',
        contextType: 'project',
        contextId: seed.projectId,
        workspaceId: null,
        createdByUserId: null,
        ...over,
      },
    })

  // A project chat belongs to its project (contextId), not to a person.
  const projectChat = await makeSession({ name: 'Export work', createdByUserId: seed.owner })
  // A shared project chat with no owner: prompts there cannot be credited.
  const sharedChat = await makeSession({ name: 'Shared project chat', createdByUserId: null })

  const turn = (sessionId: string, role: 'user' | 'assistant', content: string, extra: Record<string, unknown> = {}) =>
    db.chatMessage.create({ data: { sessionId, role, content, ...extra } })

  // The stamped author wins over the session owner.
  await turn(projectChat.id, 'user', 'add the export button', { authorUserId: seed.owner })
  // A row written before the column existed: the session owner typed it.
  await turn(projectChat.id, 'user', 'and a CSV', { authorUserId: null })
  // Agent output is not a prompt.
  await turn(projectChat.id, 'assistant', 'shipped it')
  // A project_call relay is not something the person typed.
  await turn(projectChat.id, 'user', 'relay from another project', {
    authorUserId: null,
    agent: 'project_call',
  })
  // Someone else's prompt in the same chat.
  await turn(projectChat.id, 'user', 'my own prompt', { authorUserId: seed.member })
  // Nobody can say who typed this one.
  await turn(sharedChat.id, 'user', 'nobody knows who typed this', { authorUserId: null })
}

/** A board with one card the owner moved to Done, plus an agent action that must not count. */
async function seedBoard() {
  const suffix = crypto.randomUUID().slice(0, 6)
  const board = await db.board.create({
    data: { workspaceId: seed.workspaceId, name: 'Dev', slug: `dev-${suffix}`, keyPrefix: 'SHO' },
  })
  await db.boardColumn.create({ data: { boardId: board.id, name: 'In Dev', position: 0 } })
  const done = await db.boardColumn.create({
    data: { boardId: board.id, name: 'Done', position: 1, category: 'done' },
  })
  const item = await db.workItem.create({
    data: {
      workspaceId: seed.workspaceId,
      boardId: board.id,
      columnId: done.id,
      key: 'SHO-7',
      number: 7,
      title: 'Export button',
      conversationId: generalId,
      threadRootMessageId: agentRootId,
    },
  })
  const event = (type: string, actorUserId: string | null, eventData: unknown, createdAt: Date) =>
    db.workItemEvent.create({
      data: { workItemId: item.id, workspaceId: seed.workspaceId, type, actorUserId, eventData, createdAt },
    })
  const now = Date.now()
  await event('created', seed.owner, { column: 'In Dev' }, new Date(now - 60_000))
  await event('moved', seed.owner, { to: { column: 'Done', category: 'done' } }, new Date(now - 40_000))
  await event('assigned', seed.owner, { label: 'Shogo QA' }, new Date(now - 20_000))
  // Agent actions carry `actorAgentRef` and no user.
  await event('commented', null, { agentRef: 'project:other' }, new Date(now - 10_000))
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const list = await conversation.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
  const dm = await conversation.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
  dmId = dm.id

  // An agent's thread, so an untagged reply below it is aimed at that agent.
  const root = await conversation.postMessage({
    conversationId: generalId,
    authorType: 'agent',
    authorUserId: null,
    authorAgentRef: { name: 'Planner', projectId: null },
    text: 'I will break that down',
  } as any)
  agentRootId = root.row.id

  // The five kinds of message the split has to separate.
  await post(generalId, seed.owner, 'standup notes for today')
  const toAgent = await post(generalId, seed.owner, 'break this down please')
  await mention(toAgent, { targetType: 'agent', projectId: seed.foreignProjectId })
  const toBoth = await post(generalId, seed.owner, 'thoughts, both of you?')
  await mention(toBoth, { targetType: 'user', targetUserId: seed.member })
  await mention(toBoth, { targetType: 'agent', projectId: seed.foreignProjectId })
  await post(dmId, seed.owner, 'thanks for the review')
  await post(generalId, seed.owner, 'go ahead then', { threadRootId: agentRootId })
  // Someone else's message must never be counted for the owner.
  await post(generalId, seed.member, 'mine, not the owners')
  // A deleted message stays out of every count.
  const deleted = await post(generalId, seed.owner, 'this one was deleted')
  await db.conversationMessage.update({ where: { id: deleted }, data: { deletedAt: new Date() } })

  await seedAgentChats()
  await seedBoard()

  owner = (await analytics.findWorkspaceMember(seed.workspaceId, seed.owner))!
  expect(owner).toBeTruthy()
}, 60_000)

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('collectActivity / getMemberWorkActivity on a real database', () => {
  test('the team dashboard query still builds (it shares collectActivity)', async () => {
    const team = await analytics.getTeamWork(seed.workspaceId, { period: '7d', tz: 'UTC' })
    expect(team.rows.some((r: any) => r.userId === seed.owner)).toBe(true)
  })

  test('splits the owner’s messages by who they were aimed at', async () => {
    const out = await analytics.getMemberWorkActivity(seed.workspaceId, owner, { range: '7d', tz: 'UTC' })
    expect(out.totals).toMatchObject({
      messagesSent: 5,
      messagesToChannel: 1,
      messagesToAgents: 2,
      messagesMixed: 1,
      messagesToPeople: 1,
      // The stamped prompt and the legacy row credited to the session owner;
      // the relay, the assistant row and someone else's prompt are excluded.
      agentChatPrompts: 2,
      unattributedPrompts: 1,
    })
  })

  test('counts only the owner’s own board actions, and rolls them up per card', async () => {
    const out = await analytics.getMemberWorkActivity(seed.workspaceId, owner, { range: '7d', tz: 'UTC' })
    expect(out.totals).toMatchObject({
      cardsCreated: 1,
      cardsMoved: 1,
      cardsCompleted: 1,
      cardAssignments: 1,
      // The agent's `commented` event is excluded.
      cardComments: 0,
    })
    expect(out.cards[0]).toMatchObject({
      key: 'SHO-7',
      title: 'Export button',
      board: 'Dev',
      column: 'Done',
      lastAction: 'assigned Shogo QA',
    })
    // Someone whose activity is messages and cards must not get an empty feed.
    expect(out.recent.some((r: any) => r.kind === 'chat_prompt')).toBe(true)
    expect(out.recent.some((r: any) => r.kind === 'card_event')).toBe(true)
    expect(out.recent.some((r: any) => r.kind === 'message')).toBe(true)
  })

  test('detail=board returns card events only', async () => {
    const out = await analytics.getMemberWorkActivity(
      seed.workspaceId,
      owner,
      { range: '7d', tz: 'UTC' },
      new Date(),
      { boardOnly: true },
    )
    expect(out.recent.length).toBeGreaterThan(0)
    expect(out.recent.every((r: any) => r.kind === 'card_event')).toBe(true)
    expect(out.cards.length).toBeGreaterThan(0)
  })
})

describe('getMemberMessages on a real database', () => {
  test('returns only what the owner sent, with text, ids and audience', async () => {
    const page = await messages.getMemberMessages(seed.workspaceId, seed.owner, {})
    const byAudience = page.items.reduce<Record<string, number>>((acc, item) => {
      acc[item.audience] = (acc[item.audience] ?? 0) + 1
      return acc
    }, {})

    expect(byAudience).toEqual({ channel: 1, agent: 4, mixed: 1, person: 1 })
    expect(page.items.every((i) => i.text.length > 0)).toBe(true)
    expect(page.items.every((i) => !!i.id)).toBe(true)
    // Nobody else's message, and not the deleted one.
    expect(page.items.some((i) => i.text.includes('not the owners'))).toBe(false)
    expect(page.items.some((i) => i.text.includes('deleted'))).toBe(false)
    expect(page.items.filter((i) => i.source === 'agent_chat')).toHaveLength(2)
    expect(page.unattributed).toBe(1)
  })

  test('filters by audience and by source, on real queries', async () => {
    const people = await messages.getMemberMessages(seed.workspaceId, seed.owner, { audience: 'person' })
    expect(people.items.map((i) => i.audience)).toEqual(['person'])

    const agents = await messages.getMemberMessages(seed.workspaceId, seed.owner, { audience: 'agent' })
    expect(agents.items).toHaveLength(4)
    expect(agents.items.every((i) => i.audience === 'agent')).toBe(true)

    const teamOnly = await messages.getMemberMessages(seed.workspaceId, seed.owner, { source: 'team_chat' })
    expect(teamOnly.items).toHaveLength(5)
    expect(teamOnly.items.every((i) => i.source === 'team_chat')).toBe(true)

    const chatOnly = await messages.getMemberMessages(seed.workspaceId, seed.owner, { source: 'agent_chat' })
    expect(chatOnly.items.map((i) => i.source)).toEqual(['agent_chat', 'agent_chat'])
    const prompt = chatOnly.items.find((i) => i.text === 'add the export button')!
    expect(prompt.chatSession).toMatchObject({ name: 'Export work', projectId: seed.projectId })
    expect(prompt.audience).toBe('agent')
  })

  test('pages with a stable cursor and never repeats or drops a row', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 20; i++) {
      const page = await messages.getMemberMessages(seed.workspaceId, seed.owner, { limit: 2, cursor })
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    const all = await messages.getMemberMessages(seed.workspaceId, seed.owner, { limit: 200 })
    expect(seen).toEqual(all.items.map((i) => i.id))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(7)
  })

  test('the CSV reads the same rows in one pass', async () => {
    const all = await messages.getAllMemberMessages(seed.workspaceId, seed.owner, {})
    const paged = await messages.getMemberMessages(seed.workspaceId, seed.owner, { limit: 200 })
    expect(all.items.map((i) => i.id)).toEqual(paged.items.map((i) => i.id))
    expect(all.unattributed).toBe(1)
    expect(all.truncated).toBe(false)
  })
})
