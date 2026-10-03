// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reviewer isolation: an agent whose channel membership is `isolated` is run
 * from the hand-off, the task card's acceptance criteria and its links only,
 * always in a fresh session, and cannot read or search the discussion.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')

const db = prisma as any
let seed: SeededWorkspace
let builder: string
let reviewer: string
let agentAuth: { projectId: string | null | undefined } = { projectId: null }

interface Invocation { projectId: string | null; sessionId: string; userId: string; prompt: string }
let invocations: Invocation[] = []
type Script = (args: Invocation) => string | Promise<string>
let scripts: Record<string, Script> = {}

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: agentAuth.projectId }),
}))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const tag = (projectId: string) => `<@a:p:${projectId}>`
const internal = (path: string) => `/internal/workspaces/${seed.workspaceId}/agent-channels${path}`

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const mk = (name: string, description: string) =>
    db.project.create({ data: { name, description, workspaceId: seed.workspaceId } }).then((p: any) => p.id)
  builder = await mk('Builder', 'Writes the code')
  reviewer = await mk('Reviewer', 'Reviews pull requests')
})

beforeEach(() => {
  invocations = []
  scripts = {}
  agentAuth = { projectId: null }
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      const inv = { projectId: args.projectId, sessionId: args.sessionId, userId: args.userId, prompt: args.prompt }
      invocations.push(inv)
      const text = await (scripts[args.projectId ?? 'ws']?.(inv) ?? 'ok')
      return sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function engChannel(name: string, reviewerMode?: string) {
  const { channel } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name,
    agents: [
      { projectId: builder, agentTrigger: 'mention' },
      { projectId: reviewer, agentTrigger: 'mention', ...(reviewerMode ? { agentContextMode: reviewerMode } : {}) },
    ],
    userEmails: [],
  })
  return channel.id as string
}

async function post(user: string, conversationId: string, text: string, threadRootId?: string) {
  const res = await call(user, 'POST', `/conversations/${conversationId}/messages`, { text, threadRootId })
  return res.json.message.id as string
}

function doneReplies(threadRootId: string, projectId: string, n: number) {
  return waitFor(async () => {
    const rows = await db.conversationMessage.findMany({
      where: { threadRootId, authorType: 'agent', agentStatus: 'done' },
      orderBy: { seq: 'asc' },
    })
    const mine = rows.filter((r: any) => r.authorAgentRef?.projectId === projectId)
    return mine.length >= n ? mine : null
  })
}

const DISCUSSION = 'SECRET-DISCUSSION we agreed to round half-up because finance asked'
const CRITERIA = ['Totals round to cents', 'Existing invoice tests still pass']
const PR = 'https://github.com/acme/shop/pull/12'

/** The thread a builder works in: human request, discussion, the task card, then a hand-off to the reviewer. */
async function buildThread(channel: string) {
  const root = await post(seed.member, channel, 'Please fix the invoice total rounding bug')
  await post(seed.owner, channel, DISCUSSION, root)
  agentAuth = { projectId: builder }
  const card = await call(null, 'POST', internal('/' + channel + '/messages'), {
    threadRootId: root,
    card: { title: 'Fix invoice totals', status: 'working', steps: ['Build', 'Review'], step: 1, criteria: CRITERIA, links: [{ label: 'PR #12', url: PR }] },
  })
  expect(card.status).toBe(201)
  return root
}

describe('isolated reviewer', () => {
  test('gets the hand-off, criteria and links, and none of the discussion', async () => {
    const channel = await engChannel('iso-prompt', 'isolated')
    const root = await buildThread(channel)
    scripts[reviewer] = () => 'pass: criteria met.'

    const handoff = await post(seed.member, channel, `${tag(reviewer)} please review PR #12 for the invoice fix`, root)
    await doneReplies(root, reviewer, 1)
    const run = invocations.find((i) => i.projectId === reviewer)!
    expect(run.prompt).toContain('independent reviewer')
    expect(run.prompt).toContain('please review PR #12 for the invoice fix')
    expect(run.prompt).toContain('Task: Fix invoice totals')
    expect(run.prompt).toContain('- Totals round to cents')
    expect(run.prompt).toContain('- Existing invoice tests still pass')
    expect(run.prompt).toContain(`PR #12: ${PR}`)
    expect(run.prompt).toContain(`channel id ${channel}`)
    expect(run.prompt).toContain(`thread id ${root}`)
    expect(run.prompt).toContain('"pass" or "fail"')

    expect(run.prompt).not.toContain('SECRET-DISCUSSION')
    expect(run.prompt).not.toContain('invoice total rounding bug')
    expect(run.prompt).not.toContain('thread so far')
    expect(run.prompt).not.toContain('Recent messages')
    expect(handoff).toBeTruthy()
  })

  test('a shared agent still sees the thread', async () => {
    const channel = await engChannel('iso-shared')
    const root = await buildThread(channel)
    await post(seed.member, channel, `${tag(reviewer)} please review PR #12`, root)
    await doneReplies(root, reviewer, 1)
    const run = invocations.find((i) => i.projectId === reviewer)!
    expect(run.prompt).toContain('SECRET-DISCUSSION')
    expect(run.prompt).toContain('the thread so far')
  })

  test('without criteria on a card the reviewer is told so rather than shown the discussion', async () => {
    const channel = await engChannel('iso-nocard', 'isolated')
    const root = await post(seed.member, channel, 'Fix the login redirect')
    await post(seed.owner, channel, DISCUSSION, root)
    await post(seed.member, channel, `${tag(reviewer)} review the login fix`, root)
    await doneReplies(root, reviewer, 1)
    const run = invocations.find((i) => i.projectId === reviewer)!
    expect(run.prompt).toContain('none were recorded on the task card')
    expect(run.prompt).toContain('review the login fix')
    expect(run.prompt).not.toContain('SECRET-DISCUSSION')
    expect(run.prompt).not.toContain('Fix the login redirect')
  })

  test('every review runs in a fresh session; shared agents keep theirs', async () => {
    const channel = await engChannel('iso-fresh', 'isolated')
    const root = await buildThread(channel)
    await post(seed.member, channel, `${tag(reviewer)} review round one`, root)
    await doneReplies(root, reviewer, 1)
    await post(seed.member, channel, `${tag(reviewer)} review round two after the fixes`, root)
    await doneReplies(root, reviewer, 2)
    await post(seed.member, channel, `${tag(builder)} thanks, building`, root)
    await doneReplies(root, builder, 1)
    await post(seed.member, channel, `${tag(builder)} and again`, root)
    await doneReplies(root, builder, 2)

    const sessions = (id: string) => invocations.filter((i) => i.projectId === id).map((i) => i.sessionId)
    const reviews = sessions(reviewer)
    expect(reviews).toHaveLength(2)
    expect(new Set(reviews).size).toBe(2)
    const builds = sessions(builder)
    expect(builds).toHaveLength(2)
    expect(builds[0]).toBe(builds[1])
    const second = invocations.filter((i) => i.projectId === reviewer)[1]
    expect(second.prompt).not.toContain('review round one')
    expect(second.prompt).toContain('review round two')
  })

  test('the hand-off can come from an agent', async () => {
    const channel = await engChannel('iso-agent', 'isolated')
    const root = await buildThread(channel)
    scripts[builder] = () => `PR #12 is up. ${tag(reviewer)} please review against the criteria.`
    await post(seed.member, channel, `${tag(builder)} finish the work`, root)
    await doneReplies(root, reviewer, 1)
    const run = invocations.find((i) => i.projectId === reviewer)!
    expect(run.prompt).toContain('Builder (agent) [mentions you]: ')
    expect(run.prompt).toContain('PR #12 is up.')
    expect(run.prompt).toContain('handed this to you')
    expect(run.prompt).not.toContain('SECRET-DISCUSSION')
  })

  test('cannot read or search the discussion through the channel tools', async () => {
    const channel = await engChannel('iso-tools', 'isolated')
    const root = await buildThread(channel)
    agentAuth = { projectId: reviewer }
    const read = await call(null, 'GET', internal(`/${channel}/messages?threadRootId=${root}`))
    expect(read.status).toBe(403)
    expect(read.json.error.code).toBe('isolated')
    const search = await call(null, 'GET', internal('/search?q=SECRET-DISCUSSION'))
    expect(search.status).toBe(403)

    agentAuth = { projectId: builder }
    const builderRead = await call(null, 'GET', internal(`/${channel}/messages?threadRootId=${root}`))
    expect(builderRead.status).toBe(200)
    expect(builderRead.json.messages.length).toBeGreaterThan(1)
    const builderSearch = await call(null, 'GET', internal('/search?q=SECRET-DISCUSSION'))
    expect(builderSearch.status).toBe(200)

    // It can still report back.
    agentAuth = { projectId: reviewer }
    const verdict = await call(null, 'POST', internal(`/${channel}/messages`), { threadRootId: root, text: 'pass', kind: 'result' })
    expect(verdict.status).toBe(201)
  })
})

describe('team channel config', () => {
  test('the context mode is stored, reported in the snapshot, updated in place, and defaults to shared', async () => {
    const channel = await engChannel('iso-config', 'isolated')
    const modeOf = async () =>
      (await teamChannels.listTeamChannels(seed.workspaceId)).channels.find((c) => c.id === channel)!.agents.find((a) => a.projectId === reviewer)!.agentContextMode
    expect(await modeOf()).toBe('isolated')

    const back = await teamChannels.upsertTeamChannel(seed.workspaceId, { name: 'iso-config', agents: [{ projectId: reviewer, agentTrigger: 'mention', agentContextMode: 'shared' }] })
    expect(back.changes).toContain(`agent~${reviewer}`)
    expect(await modeOf()).toBe('shared')

    await teamChannels.upsertTeamChannel(seed.workspaceId, { name: 'iso-config', agents: [{ projectId: reviewer, agentTrigger: 'mention', agentContextMode: 'weird' }] })
    expect(await modeOf()).toBe('shared')
    const same = await teamChannels.upsertTeamChannel(seed.workspaceId, { name: 'iso-config', agents: [{ projectId: reviewer, agentTrigger: 'mention' }] })
    expect(same.changes).toEqual([])
  })
})
