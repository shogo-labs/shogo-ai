// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agents @mentioning agents in channels: chained dispatch billed to the
 * person who started it, tool posts joining the chain, chain limits and the
 * paused note, thread owners, friendly `@Name` resolution, scope checks, the
 * team directory, and manifest channel upserts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SHOGO_AGENT_CHAIN_MAX_DEPTH = '6'
process.env.SHOGO_AGENT_CHAIN_MAX_PING_PONG = '3'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')

const db = prisma as any
let seed: SeededWorkspace
let analyst: string
let planner: string
let implementer: string
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
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

const tag = (projectId: string) => `<@a:p:${projectId}>`

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const mk = (name: string, description: string) =>
    db.project.create({ data: { name, description, workspaceId: seed.workspaceId } }).then((p: any) => p.id)
  analyst = await mk('Issue Pipeline — Analyst', 'Finds root causes and proposes options')
  planner = await mk('Planner', 'Writes implementation plans')
  implementer = await mk('Implementer', 'Writes the code')
})

beforeEach(() => {
  invocations = []
  scripts = {}
  agentAuth = { projectId: null }
  delete process.env.SHOGO_AGENT_MENTION_CHAINS
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

async function channel(name: string, kind: 'public' | 'private' = 'public') {
  const res = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name, kind })
  return res.json.conversation.id as string
}

async function post(user: string, conversationId: string, text: string, threadRootId?: string) {
  const res = await call(user, 'POST', `/conversations/${conversationId}/messages`, { text, threadRootId })
  return res.json.message.id as string
}

function doneReply(threadRootId: string, projectId: string, n = 1) {
  return waitFor(async () => {
    const rows = await db.conversationMessage.findMany({
      where: { threadRootId, authorType: 'agent', agentStatus: 'done' },
      orderBy: { seq: 'asc' },
    })
    const mine = rows.filter((r: any) => r.authorAgentRef?.projectId === projectId)
    return mine.length >= n ? mine[n - 1] : null
  })
}

async function settle(ms = 150) {
  await new Promise((r) => setTimeout(r, ms))
  await waitFor(async () => !(await db.conversationMessage.findFirst({ where: { agentStatus: 'running' } })))
}

describe('agent-to-agent hand-offs', () => {
  test('a final reply tagging the next agent runs it, down the chain, billed to the person who started it', async () => {
    const id = await channel('handoffs')
    scripts[analyst] = () => `Root cause found. ${tag(planner)} please plan the fix.`
    scripts[planner] = () => `Plan attached. ${tag(implementer)} go.`
    scripts[implementer] = () => 'PR opened.'
    const root = await post(seed.member, id, `${tag(analyst)} look at issue 12`)

    const done = await doneReply(root, implementer)
    expect(done.text).toBe('PR opened.')
    expect(invocations.map((i) => i.projectId)).toEqual([analyst, planner, implementer])
    expect(invocations.every((i) => i.userId === seed.member)).toBe(true)

    const replies = await db.conversationMessage.findMany({ where: { threadRootId: root, authorType: 'agent' }, orderBy: { seq: 'asc' } })
    expect(replies.map((r: any) => r.agentChain.depth)).toEqual([1, 2, 3])
    expect(replies.every((r: any) => r.agentChain.originUserId === seed.member && r.agentChain.rootMessageId === root)).toBe(true)
    expect(replies[2].agentChain.hops).toEqual([`p:${analyst}`, `p:${planner}`, `p:${implementer}`])

    expect(invocations[1].prompt).toContain(`channel id ${id}`)
    expect(invocations[1].prompt).toContain(`thread id ${root}`)
    expect(invocations[1].prompt).toContain('Issue Pipeline — Analyst (an agent) handed this to you.')
    expect(invocations[0].prompt).not.toContain('handed this to you')
  })

  test('plain @Name in a reply resolves to the agent (short names included) and wakes it', async () => {
    const id = await channel('friendly')
    scripts[planner] = () => 'Over to @Analyst for a second look.'
    scripts[analyst] = () => 'Looks right.'
    const root = await post(seed.member, id, `${tag(planner)} draft a plan`)
    const reply = await doneReply(root, analyst)
    expect(reply.text).toBe('Looks right.')
    const plannerReply = await doneReply(root, planner)
    expect(plannerReply.text).toBe(`Over to ${tag(analyst)} for a second look.`)
  })

  test('tagging a person in a final reply records the mention so they are notified', async () => {
    const id = await channel('decisions')
    const member = await db.user.findUnique({ where: { id: seed.member } })
    scripts[analyst] = () => `Option 1 or 2? @${member.name} please pick.`
    const root = await post(seed.owner, id, `${tag(analyst)} analyze`)
    const reply = await doneReply(root, analyst)
    expect(reply.text).toContain(`<@u:${seed.member}>`)
    const mentions = await db.conversationMention.findMany({ where: { messageId: reply.id } })
    expect(mentions.map((m: any) => m.targetUserId)).toEqual([seed.member])
  })

  test('a team_chat_post tagging an agent wakes it; mid-run posts join the chain and bill its originator', async () => {
    const id = await channel('tool-posts')
    scripts[analyst] = async (inv) => {
      agentAuth = { projectId: analyst }
      await call(null, 'POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/tool-posts/messages`, {
        text: `@Planner FYI while I keep digging`,
        sessionId: inv.sessionId,
      })
      return 'Still digging.'
    }
    scripts[planner] = () => 'Noted.'
    const root = await post(seed.member, id, `${tag(analyst)} investigate`)
    await doneReply(root, analyst)
    const plannerRun = await waitFor(async () => invocations.find((i) => i.projectId === planner))
    expect(plannerRun.userId).toBe(seed.member)
    const toolPost = await db.conversationMessage.findFirst({ where: { conversationId: id, threadRootId: null, authorType: 'agent' } })
    expect(toolPost.agentChain.originUserId).toBe(seed.member)
    expect(toolPost.agentChain.depth).toBe(1)
    await settle()
  })

  test('a tool post outside any run starts a chain billed to the workspace owner', async () => {
    await channel('heartbeat')
    scripts[planner] = () => 'On it.'
    agentAuth = { projectId: analyst }
    const res = await call(null, 'POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/heartbeat/messages`, {
      text: `Nightly triage found 2 issues. ${tag(planner)} plan them.`,
      runId: 'run-nightly',
    })
    expect(res.status).toBe(201)
    expect(res.json.message.threadRootId).toBe(res.json.message.id)
    expect(res.json.message.runId).toBe('run-nightly')
    const reply = await doneReply(res.json.message.id, planner)
    expect(reply.agentChain.runId).toBe('run-nightly')
    expect(invocations[0].userId).toBe(seed.owner)
    expect(invocations[0].prompt).toContain('run id run-nightly')
  })
})

describe('thread owners', () => {
  test("an agent's top-level post owns the thread; unaddressed human replies go to the owner, not the last replier", async () => {
    await channel('owned')
    scripts[planner] = () => 'Plan ready.'
    scripts[analyst] = () => 'Thanks, noted the choice.'
    agentAuth = { projectId: analyst }
    const res = await call(null, 'POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/owned/messages`, {
      text: `Options are ready. ${tag(planner)} sketch plans for each.`,
    })
    const root = res.json.message.id
    const rootRow = await db.conversationMessage.findUnique({ where: { id: root } })
    expect(rootRow.agentChain.owner).toEqual({ projectId: analyst })
    await doneReply(root, planner)

    const conversationId = rootRow.conversationId
    await post(seed.member, conversationId, 'go with 2', root)
    const ownerReply = await doneReply(root, analyst)
    expect(ownerReply.text).toBe('Thanks, noted the choice.')
    expect(invocations.map((i) => i.projectId)).toEqual([planner, analyst])
  })

  test('owner: true claims an existing thread', async () => {
    const id = await channel('claimed')
    const root = await post(seed.member, id, 'Someone should look at the flaky test')
    agentAuth = { projectId: implementer }
    await call(null, 'POST', `/internal/workspaces/${seed.workspaceId}/agent-channels/claimed/messages`, {
      text: 'I will take this one.',
      threadRootId: root,
      owner: true,
    })
    const rootRow = await db.conversationMessage.findUnique({ where: { id: root } })
    expect(rootRow.agentChain.owner).toEqual({ projectId: implementer })
    scripts[implementer] = () => 'Fixed.'
    await post(seed.member, id, 'thanks, any update?', root)
    expect((await doneReply(root, implementer, 2)).text).toBe('Fixed.')
  })
})

describe('chain limits', () => {
  test('the depth limit pauses the chain with a note that tags and notifies the originator; a human reply resumes', async () => {
    const id = await channel('depth')
    scripts[analyst] = () => `${tag(planner)} next`
    scripts[planner] = () => `${tag(implementer)} next`
    scripts[implementer] = () => `${tag(analyst)} next`
    const root = await post(seed.member, id, `${tag(analyst)} start`)

    const paused = await waitFor(async () => db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'system' } }), 5000)
    await settle()
    expect(paused.text).toContain('Paused after 6 agent hand-offs')
    expect(paused.text).toContain(`<@u:${seed.member}>`)
    expect(paused.blocks).toEqual({ chainPaused: { limit: 'depth', depth: 6 } })
    expect(invocations).toHaveLength(6)
    const mention = await db.conversationMention.findFirst({ where: { messageId: paused.id, targetUserId: seed.member } })
    expect(mention).toBeTruthy()

    scripts[analyst] = () => 'Stopping here.'
    await post(seed.member, id, `${tag(analyst)} wrap up`, root)
    await waitFor(async () => (await db.conversationMessage.findFirst({
      where: { threadRootId: root, authorType: 'agent', text: 'Stopping here.', agentStatus: 'done' },
    })))
    expect(invocations).toHaveLength(7)
    expect(invocations[6].userId).toBe(seed.member)
  })

  test('two agents handing work back and forth are stopped', async () => {
    const id = await channel('ping-pong')
    scripts[analyst] = () => `${tag(planner)} your turn`
    scripts[planner] = () => `${tag(analyst)} no, yours`
    const root = await post(seed.member, id, `${tag(analyst)} decide who owns this`)
    const paused = await waitFor(async () => db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'system' } }), 5000)
    await settle()
    expect(paused.blocks.chainPaused.limit).toBe('ping_pong')
    expect(invocations).toHaveLength(3)
  })

  test('agents never wake themselves', async () => {
    const id = await channel('self')
    scripts[analyst] = () => `Note to self ${tag(analyst)}: check again later.`
    const root = await post(seed.member, id, `${tag(analyst)} check`)
    await doneReply(root, analyst)
    await settle()
    expect(invocations).toHaveLength(1)
  })

  test('agent-to-agent dispatch can be switched off', async () => {
    process.env.SHOGO_AGENT_MENTION_CHAINS = 'false'
    const id = await channel('flag-off')
    scripts[analyst] = () => `${tag(planner)} over to you`
    const root = await post(seed.member, id, `${tag(analyst)} go`)
    await doneReply(root, analyst)
    await settle()
    expect(invocations.map((i) => i.projectId)).toEqual([analyst])
  })
})

describe('scope', () => {
  test("agents can't wake another workspace's agent or an agent outside a private channel", async () => {
    const privateId = await channel('secret', 'private')
    await call(seed.owner, 'POST', `/conversations/${privateId}/agents`, { projectId: analyst })
    scripts[analyst] = () => `${tag(planner)} and ${tag(seed.foreignProjectId)} take a look`
    const root = await post(seed.owner, privateId, `${tag(analyst)} review`)
    await doneReply(root, analyst)
    await settle()
    expect(invocations.map((i) => i.projectId)).toEqual([analyst])
  })

  test('the directory lists only this workspace', async () => {
    const group = await db.userGroup.create({ data: { workspaceId: seed.workspaceId, handle: 'maintainers', name: 'Maintainers', createdById: seed.owner } })
    const res = await call(null, 'GET', `/internal/workspaces/${seed.workspaceId}/agent-channels/directory`)
    expect(res.status).toBe(200)
    const { people, agents, groups } = res.json.directory
    expect(people.map((p: any) => p.userId).sort()).toEqual([seed.owner, seed.member, seed.viewer].sort())
    expect(agents.map((a: any) => a.projectId)).toContain(analyst)
    expect(agents.map((a: any) => a.projectId)).not.toContain(seed.foreignProjectId)
    expect(agents.find((a: any) => a.projectId === planner)).toEqual({
      projectId: planner, name: 'Planner', role: 'Writes implementation plans', tag: tag(planner),
    })
    expect(agents[0]).toMatchObject({ projectId: null, tag: '<@a:ws>' })
    expect(groups).toEqual([{ groupId: group.id, handle: 'maintainers', name: 'Maintainers', tag: `<@g:${group.id}>` }])
  })
})

describe('manifest channels', () => {
  test('upsert creates a channel with agents and people, then reports no changes', async () => {
    const member = await db.user.findUnique({ where: { id: seed.member } })
    const body = {
      topic: 'One thread per issue',
      agents: [{ projectId: analyst, agentTrigger: 'mention' }, { projectId: planner, agentTrigger: 'all' }],
      userEmails: [member.email],
      groupHandles: ['maintainers'],
    }
    const first = await call(null, 'PUT', `/internal/workspaces/${seed.workspaceId}/agent-channels/team-channels/issue-pipeline`, body)
    expect(first.status).toBe(201)
    expect(first.json.channel.agents).toHaveLength(2)
    expect(first.json.channel.userEmails).toContain(member.email.toLowerCase())

    const again = await call(null, 'PUT', `/internal/workspaces/${seed.workspaceId}/agent-channels/team-channels/issue-pipeline`, body)
    expect(again.status).toBe(200)
    expect(again.json.changes).toEqual([])

    const listed = await call(null, 'GET', `/internal/workspaces/${seed.workspaceId}/agent-channels/team-channels`)
    const pipeline = listed.json.channels.find((c: any) => c.name === 'issue-pipeline')
    expect(pipeline.topic).toBe('One thread per issue')
    expect(listed.json.groups.maintainers).toEqual([])

    const removed = await call(null, 'PUT', `/internal/workspaces/${seed.workspaceId}/agent-channels/team-channels/issue-pipeline`, {
      removeAgentProjectIds: [planner],
    })
    expect(removed.json.channel.agents.map((a: any) => a.projectId)).toEqual([analyst])
  })

  test("upsert rejects another workspace's project", async () => {
    const res = await call(null, 'PUT', `/internal/workspaces/${seed.workspaceId}/agent-channels/team-channels/leaky`, {
      agents: [{ projectId: seed.foreignProjectId }],
    })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('invalid_agent')
  })
})
