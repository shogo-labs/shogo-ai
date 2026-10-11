// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction: a channel agent whose runtime answers with one retryable 503
 * (cold start, or a stale placement the route has just invalidated) must
 * finish the reply. The project chat route's contract is that the caller
 * retries; the dispatcher used to treat the 503 as the final answer, so the
 * thread settled "I couldn't finish that: Runtime unreachable — please retry."
 * and a manual resend was what actually ran the agent.
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

async function call(user: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'x-user': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function unavailable(code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message, retryable: true } }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  })
}

function answer(text: string) {
  return sseResponse([
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'finish' },
  ])
}

let calls = 0

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
  calls = 0
  dispatcher._resetDispatcherForTests()
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function mentionAndSettle(firstFailure: Response) {
  dispatcher.configureConversationAgentDispatcher({
    retryDelaysMs: [0],
    retryBudgetMs: 60_000,
    invoke: async () => {
      calls += 1
      if (calls === 1) return firstFailure
      return answer('Ran it.')
    },
  })
  const posted = await call(seed.member, 'POST', `/conversations/${channel}/messages`, {
    text: `<@a:p:${agent}> run the check`,
  })
  const root = posted.json.message.id as string
  const reply = await waitFor(async () => {
    const row = await db.conversationMessage.findFirst({
      where: { threadRootId: root, authorType: 'agent', agentStatus: { not: 'running' } },
    })
    return row ?? null
  })
  return reply
}

describe('a cold runtime is retried', () => {
  test('one runtime_unreachable 503 still settles the reply as done', async () => {
    const reply = await mentionAndSettle(unavailable('runtime_unreachable', 'Runtime unreachable — please retry.'))
    expect(calls).toBe(2)
    expect(reply.agentStatus).toBe('done')
    expect(reply.text).toBe('Ran it.')
  })

  test('one pod_starting 503 still settles the reply as done', async () => {
    const reply = await mentionAndSettle(unavailable('pod_starting', 'Project runtime is starting up. Please retry in a few seconds.'))
    expect(calls).toBe(2)
    expect(reply.agentStatus).toBe('done')
    expect(reply.text).toBe('Ran it.')
  })
})
