// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction: mentioning an agent in a channel saves the dispatch wrapper
 * ("You are … a teammate in", "Team chat context:") as an ordinary user
 * message. The session view then shows that prompt as if the person typed it.
 * The saved message should carry a data-channel-dispatch part naming the
 * channel, the thread and the message that woke the agent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let agent: string
let channel: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  agent = (await db.project.create({ data: { name: 'Ops', workspaceId: seed.workspaceId } })).id
  const { channel: ch } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name: 'ops',
    agents: [{ projectId: agent, agentTrigger: 'mention' }],
    userEmails: [],
  })
  channel = ch.id
})

beforeEach(() => {
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async () => sseResponse([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'On it.' },
      { type: 'finish' },
    ]),
  })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('dispatch prompt shape', () => {
  test('the saved user message carries who mentioned the agent, where, and what they said', async () => {
    const res = await app.request(`/api/conversations/${channel}/messages`, {
      method: 'POST',
      headers: { 'x-user': seed.member, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `<@a:p:${agent}> run the check` }),
    })
    const root = (await res.json()).message.id as string
    const reply = await waitFor(async () => {
      const row = await db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'done' } })
      return row ?? null
    })
    const prompt = await db.chatMessage.findFirst({ where: { sessionId: reply.agentSessionId, role: 'user' } })
    const parts = JSON.parse(prompt.parts) as Array<{ type: string; data?: any }>
    const dispatch = parts.find((p) => p.type === 'data-channel-dispatch')
    expect(dispatch?.data).toMatchObject({
      conversationId: channel,
      conversationName: 'ops',
      threadRootId: root,
      agentName: 'Ops',
      trigger: { authorName: 'member', text: '@Ops run the check' },
      contextMode: 'shared',
    })
    expect(parts.some((p) => p.type === 'text')).toBe(true)
  })
})
