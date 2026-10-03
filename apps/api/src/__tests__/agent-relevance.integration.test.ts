// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel-watching agents (`auto` trigger): they answer only when a message is
 * theirs, one at a time, at a limited rate, and can be muted with `@agent mute`.
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
const relevance = await import('../services/conversation-agent-relevance')
const directory = await import('../services/conversation-directory')

const db = prisma as any
let seed: SeededWorkspace
let coordinator: string
let designer: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const tag = (projectId: string) => `<@a:p:${projectId}>`
let invocations: Array<{ projectId: string | null; prompt: string }> = []
let asked: relevance.RelevanceRequest[] = []
let choose: (request: relevance.RelevanceRequest) => string | null | Error = () => null

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  const mk = (name: string, description: string) =>
    db.project.create({ data: { name, description, workspaceId: seed.workspaceId } }).then((p: any) => p.id)
  coordinator = await mk('Coordinator', 'Turns bug reports and requests into tracked issues')
  designer = await mk('Designer', 'Reviews UI copy and layout')
})

beforeEach(() => {
  invocations = []
  asked = []
  choose = () => null
  relevance.resetAutoReplyLimits()
  relevance.setRelevanceDecider(async (request) => {
    asked.push(request)
    const result = choose(request)
    if (result instanceof Error) throw result
    return result
  })
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      invocations.push({ projectId: args.projectId, prompt: args.prompt })
      return sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'On it.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

afterAll(async () => {
  relevance.setRelevanceDecider(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function channel(name: string, agents: Array<{ projectId: string; trigger: string }>) {
  const res = await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/conversations`, { name, kind: 'public' })
  const id = res.json.conversation.id as string
  for (const agent of agents) await call(seed.owner, 'POST', `/conversations/${id}/agents`, agent)
  return id
}

async function post(conversationId: string, text: string, threadRootId?: string) {
  const res = await call(seed.member, 'POST', `/conversations/${conversationId}/messages`, { text, threadRootId })
  return res.json.message.id as string
}

async function settle(ms = 150) {
  await new Promise((r) => setTimeout(r, ms))
  await waitFor(async () => !(await db.conversationMessage.findFirst({ where: { agentStatus: 'running' } })))
}

const keyOf = (projectId: string) => `p:${projectId}`

describe('relevance gate', () => {
  test('an auto agent replies in a thread when the check picks it, and is told what the channel said', async () => {
    const id = await channel('rel-pick', [{ projectId: coordinator, trigger: 'auto' }])
    await post(id, 'morning everyone')
    await waitFor(async () => asked.length === 1)
    await settle()
    relevance.resetAutoReplyLimits()
    choose = () => keyOf(coordinator)
    const root = await post(id, 'Checkout throws a 500 when the cart is empty, can someone look?')

    const reply = await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'done' } }))
    expect(reply.authorAgentRef.projectId).toBe(coordinator)
    expect(invocations).toHaveLength(1)

    const request = asked.at(-1)!
    expect(request.text).toContain('Checkout throws a 500')
    expect(request.recent).toContain('morning everyone')
    expect(request.candidates.map((c) => [c.name, c.about])).toEqual([['Coordinator', 'Turns bug reports and requests into tracked issues']])
  })

  test('staying quiet: the check says no, the message is chatter, or the model fails', async () => {
    const id = await channel('rel-quiet', [{ projectId: coordinator, trigger: 'auto' }])
    await post(id, 'lunch anyone? the new place on 5th is good')
    await waitFor(async () => asked.length === 1)

    await post(id, 'ok thx')
    await post(id, '👍👍👍👍👍👍👍👍')
    await settle()
    expect(asked).toHaveLength(1)

    relevance.resetAutoReplyLimits()
    choose = () => new Error('model unavailable')
    await post(id, 'Is the staging deploy broken for anyone else?')
    await waitFor(async () => asked.length === 2)
    await settle()
    expect(asked).toHaveLength(2)
    expect(invocations).toHaveLength(0)
  })

  test('only one of several watching agents answers', async () => {
    const id = await channel('rel-one', [{ projectId: coordinator, trigger: 'auto' }, { projectId: designer, trigger: 'auto' }])
    choose = (request) => {
      expect(request.candidates.map((c) => c.name).sort()).toEqual(['Coordinator', 'Designer'])
      return keyOf(designer)
    }
    const root = await post(id, 'The pricing page headline feels off, thoughts?')
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'done' } }))
    await settle()
    expect(invocations.map((i) => i.projectId)).toEqual([designer])
  })

  test('an agent named by the check that is not a candidate does not run', async () => {
    const id = await channel('rel-bogus', [{ projectId: coordinator, trigger: 'auto' }])
    choose = () => keyOf(designer)
    await post(id, 'Please file an issue for the broken avatar upload')
    await settle()
    expect(invocations).toHaveLength(0)
  })

  test('explicit mentions and keyword matches skip the check; thread replies are not watched', async () => {
    const id = await channel('rel-skip', [
      { projectId: coordinator, trigger: 'auto' },
      { projectId: designer, trigger: 'keyword', keywords: 'figma' } as any,
    ])
    choose = () => keyOf(coordinator)

    const mention = await post(id, `${tag(designer)} can you check the empty state?`)
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: mention, authorType: 'agent', agentStatus: 'done' } }))
    const keyword = await post(id, 'new figma file for the onboarding flow is up')
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: keyword, authorType: 'agent', agentStatus: 'done' } }))
    expect(asked).toHaveLength(0)
    expect(invocations.map((i) => i.projectId)).toEqual([designer, designer])

    const before = invocations.length
    const root = await post(id, 'Heads up, release notes are being written today')
    await settle()
    const asks = asked.length
    await post(id, 'Can someone double check the changelog wording for me?', root)
    await settle()
    expect(asked.length).toBe(asks)
    expect(invocations.length).toBeGreaterThanOrEqual(before)
  })

  test('an agent speaks up unprompted at most once per interval per channel', async () => {
    const id = await channel('rel-rate', [{ projectId: coordinator, trigger: 'auto' }])
    choose = () => keyOf(coordinator)
    const first = await post(id, 'Search returns nothing for names with accents')
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: first, authorType: 'agent', agentStatus: 'done' } }))

    await post(id, 'Also the export button does nothing on Safari')
    await settle()
    expect(asked).toHaveLength(1)
    expect(invocations).toHaveLength(1)

    const other = await channel('rel-rate-2', [{ projectId: coordinator, trigger: 'auto' }])
    const second = await post(other, 'The signup email arrives twice for some users')
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: second, authorType: 'agent', agentStatus: 'done' } }))
    expect(invocations).toHaveLength(2)

    expect(relevance.autoReplyAllowed(id, { projectId: coordinator }, Date.now() + relevance.AUTO_REPLY_INTERVAL_MS + 1)).toBe(true)
    expect(relevance.autoReplyAllowed(id, { projectId: coordinator })).toBe(false)
  })
})

describe('mute', () => {
  const muteState = async (id: string) =>
    (await db.conversationMember.findFirst({ where: { conversationId: id, memberType: 'agent', projectId: coordinator } })).agentMuted

  test('"@agent mute" silences watching, confirms in a thread, and "@agent unmute" restores it', async () => {
    const id = await channel('mute-cmd', [{ projectId: coordinator, trigger: 'auto' }])
    const cmd = await post(id, `${tag(coordinator)} mute`)
    const note = await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: cmd, authorType: 'system' } }))
    expect(note.text).toContain('Coordinator will stay quiet')
    expect(await muteState(id)).toBe(true)
    expect(invocations).toHaveLength(0)

    choose = () => keyOf(coordinator)
    await post(id, 'Webhooks retry forever when the receiver returns 410')
    await settle()
    expect(asked).toHaveLength(0)
    expect(invocations).toHaveLength(0)

    const direct = await post(id, `${tag(coordinator)} can you triage the webhook retry thing?`)
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: direct, authorType: 'agent', agentStatus: 'done' } }))
    expect(invocations).toHaveLength(1)

    const un = await post(id, `${tag(coordinator)} unmute please`)
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: un, authorType: 'system' } }))
    expect(await muteState(id)).toBe(false)
    await post(id, 'The nightly job has been failing since Tuesday')
    await waitFor(async () => asked.length === 1)
    expect(asked).toHaveLength(1)
  })

  test('mute silences keyword and all triggers too', async () => {
    const id = await channel('mute-all', [{ projectId: coordinator, trigger: 'all' }])
    await post(id, `${tag(coordinator)} mute`)
    await waitFor(() => muteState(id))
    await post(id, 'anything at all')
    await settle()
    expect(invocations).toHaveLength(0)
  })

  test('a mention with other words is a normal request, not a mute command', async () => {
    const id = await channel('mute-not', [{ projectId: coordinator, trigger: 'auto' }])
    const root = await post(id, `${tag(coordinator)} can you mute the noisy alert rule?`)
    await waitFor(() => db.conversationMessage.findFirst({ where: { threadRootId: root, authorType: 'agent', agentStatus: 'done' } }))
    expect(await muteState(id)).toBe(false)
    expect(invocations).toHaveLength(1)
  })

  test('the profile card shows the trigger and mute state, and members can toggle it', async () => {
    const id = await channel('mute-card', [{ projectId: coordinator, trigger: 'auto' }])
    const off = await call(seed.member, 'PATCH', `/conversations/${id}/agents`, { projectId: coordinator, muted: true })
    expect(off.status).toBe(200)
    const card = await directory.loadAgentCard(seed.workspaceId, coordinator, seed.member)
    const entry = card!.channels.find((c) => c.conversationId === id)!
    expect(entry.agentTrigger).toBe('auto')
    expect(entry.muted).toBe(true)

    expect((await call(seed.viewer, 'PATCH', `/conversations/${id}/agents`, { projectId: coordinator, muted: false })).status).toBe(403)
    expect((await call(seed.member, 'PATCH', `/conversations/${id}/agents`, { projectId: designer, muted: true })).status).toBe(404)
    expect((await call(seed.member, 'PATCH', `/conversations/${id}/agents`, { projectId: coordinator })).status).toBe(400)
    expect((await call(seed.member, 'PATCH', `/conversations/${id}/agents`, { projectId: coordinator, muted: false })).status).toBe(200)
    expect((await directory.loadAgentCard(seed.workspaceId, coordinator, seed.member))!.channels.find((c) => c.conversationId === id)!.muted).toBe(false)
  })
})

describe('helpers', () => {
  test('parseResponder accepts only a listed key out of the model reply', () => {
    const keys = new Set(['p:a', 'p:b'])
    expect(relevance.parseResponder('{"responder": "p:a"}', keys)).toBe('p:a')
    expect(relevance.parseResponder('Sure!\n```json\n{"responder":"p:b"}\n```', keys)).toBe('p:b')
    expect(relevance.parseResponder('{"responder": null}', keys)).toBeNull()
    expect(relevance.parseResponder('{"responder": "p:z"}', keys)).toBeNull()
    expect(relevance.parseResponder('not json', keys)).toBeNull()
    expect(relevance.parseResponder('{oops}', keys)).toBeNull()
  })

  test('worthAsking skips mentions-only, emoji-only and very short text', () => {
    expect(relevance.worthAsking('ok thx')).toBe(false)
    expect(relevance.worthAsking('<@u:abc> <@a:p:x>')).toBe(false)
    expect(relevance.worthAsking('👍👍👍👍👍👍👍👍')).toBe(false)
    expect(relevance.worthAsking('The checkout page is broken')).toBe(true)
  })

  test('parseMuteCommand needs an agent mention and nothing but mute or unmute', () => {
    const a = [{ projectId: 'a' }]
    expect(relevance.parseMuteCommand('<@a:p:a> mute', a)).toEqual({ muted: true, targets: a })
    expect(relevance.parseMuteCommand('<@a:p:a> Mute.', a)?.muted).toBe(true)
    expect(relevance.parseMuteCommand('please <@a:p:a> unmute', a)?.muted).toBe(false)
    expect(relevance.parseMuteCommand('<@a:p:a> mute the alert', a)).toBeNull()
    expect(relevance.parseMuteCommand('mute', [])).toBeNull()
  })
})
