// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Question cards end to end, with the model replaced by the designs in the
 * staging fixtures: an agent's prose ask becomes a card for the right person,
 * repeats fold into it, a later "no longer needed" closes it, and answering
 * from the app or a Slack button settles it, posts in the thread, wakes the
 * agent, and leaves exactly one line in #activity and one inbox item.
 */

process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'
import { STAGING_FIXTURES, type AskFixture } from './fixtures/staging-agent-asks'
import type { DesignRequest } from '../services/conversation-question-designer'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { conversationRoutes, agentChannelRoutes } = await import('../routes/conversations')
const bus = await import('../lib/conversation-bus')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const teamChannels = await import('../services/conversation-team-channels')
const outbound = await import('../services/chat-providers/outbound')
const designerModule = await import('../services/conversation-question-designer')
const questions = await import('../services/conversation-questions')
const { handleQuestionPress } = await import('../services/chat-providers/question-actions')

const db = prisma as any
let seed: SeededWorkspace
let agent: { projectId: string; name: string }
let invocations: Array<{ projectId: string | null; prompt: string }> = []
let replyText = 'Thanks, on it.'
let designerCalls: string[] = []

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api/internal', agentChannelRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: agent.projectId }),
}))
const internal = (path: string) => `/internal/workspaces/${seed.workspaceId}/agent-channels${path}`

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { ...(user ? { 'x-user': user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const fixture = (name: string): AskFixture => {
  const f = STAGING_FIXTURES.find((x) => x.name === name)
  if (!f) throw new Error(`no fixture ${name}`)
  return f
}

/** The fixture design for a message, with headers resolved to the open questions' ids. */
function useFixtureDesigner() {
  designerModule.setQuestionDesigner(async (request) => {
    designerCalls.push(request.text)
    const bare = (s: string) => s.replace(/\{me\}|<@u:[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const f = STAGING_FIXTURES.find((x) => bare(x.text) === bare(request.text))
    if (!f) return { questions: [], sameAs: [], moot: [] }
    const idFor = (header: string | null | undefined) => (header ? request.open.find((o) => o.header === header)?.id ?? null : null)
    return {
      questions: f.design.questions.map((q) => ({ ...q })),
      sameAs: (f.design.sameAs ?? f.design.questions.map(() => null)).map(idFor),
      moot: (f.design.moot ?? []).map(idFor).filter((id): id is string => !!id),
    }
  })
}

let channelCount = 0
async function freshChannel(): Promise<string> {
  const { channel } = await teamChannels.upsertTeamChannel(seed.workspaceId, {
    name: `questions-${++channelCount}`,
    agents: [{ projectId: agent.projectId, agentTrigger: 'mention' }],
    userEmails: [],
  })
  return channel.id
}

/** Post as the agent and run the designer on it, as the hooks would. */
async function agentSays(conversationId: string, text: string, opts: { to?: string | null; threadRootId?: string | null } = {}) {
  const rendered = text.replaceAll('{me}', opts.to ? `<@u:${opts.to}>` : '')
  const result = await outbound.postAgentMessage({ conversationId, text: rendered, agent, threadRootId: opts.threadRootId ?? null })
  await designerModule.designQuestionsFor(result.row.id)
  return reread(result.row.id)
}

const reread = (id: string) => db.conversationMessage.findUnique({ where: { id } })

async function activityLines(questionId: string) {
  const rows = await db.conversationMessage.findMany({ where: { workspaceId: seed.workspaceId, authorType: 'system' }, orderBy: { seq: 'asc' } })
  return rows.filter((r: any) => r.blocks?.type === 'activity' && r.blocks.questionId === questionId).map((r: any) => r.blocks.kind as string)
}

const questionInbox = (messageId: string, userId?: string) =>
  db.chatInboxItem.findMany({ where: { kind: 'question', messageId, ...(userId ? { userId } : {}) } })

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  agent = { projectId: seed.projectId, name: 'Billing Bot' }
})

beforeEach(() => {
  invocations = []
  designerCalls = []
  replyText = 'Thanks, on it.'
  questions._resetQuestionsForTests()
  designerModule._resetQuestionDesignerForTests()
  useFixtureDesigner()
  dispatcher._resetDispatcherForTests()
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      invocations.push({ projectId: args.projectId, prompt: args.prompt })
      return sseResponse([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: replyText },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ])
    },
  })
})

afterAll(async () => {
  designerModule._resetQuestionDesignerForTests()
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('designing cards from prose', () => {
  test('a choice buried in a long report becomes a card for the person tagged', async () => {
    const channel = await freshChannel()
    const row = await agentSays(channel, fixture('choice buried in a long status report').text, { to: seed.member })
    const [q] = row.blocks.questions
    expect(row.blocks.messageKind).toBe('decision')
    expect(row.blocks.questionScan).toBe('done')
    expect(q).toMatchObject({ header: 'Alert destination', interaction: 'choice', status: 'open', source: 'inferred', to: { userIds: [seed.member], via: 'mention' } })
    expect(q.options.map((o: any) => o.label)).toEqual(['Slack webhook', 'Email list', 'PagerDuty'])

    await waitFor(async () => ((await activityLines(q.id)).length === 1 ? true : null))
    expect(await activityLines(q.id)).toEqual(['question.asked'])
    const inbox = await waitFor(async () => {
      const items = await questionInbox(row.id)
      return items.length ? items : null
    })
    expect(inbox.map((i: any) => i.userId)).toEqual([seed.member])
    expect(inbox[0].readAt).toBeNull()
  })

  test('repeats fold into the open card; a later "no longer needed" closes it', async () => {
    const channel = await freshChannel()
    const first = await agentSays(channel, fixture('choice buried in a long status report').text, { to: seed.member })
    const original = first.blocks.questions[0]
    await waitFor(async () => ((await questionInbox(first.id)).length ? true : null))

    const again = await agentSays(channel, fixture('the same ask again from another agent').text, { to: seed.member })
    expect(again.blocks.questions ?? []).toHaveLength(0)
    expect(again.blocks.questionRefs).toEqual([{ messageId: first.id, questionId: original.id, header: 'Alert destination', prompt: original.prompt }])
    const bumped = (await reread(first.id)).blocks.questions[0]
    expect(bumped.askCount).toBe(2)
    expect(bumped.status).toBe('open')
    expect(await activityLines(original.id)).toEqual(['question.asked'])
    expect(await questionInbox(again.id)).toHaveLength(0)

    // Not a "?" in sight, but an open question means the model still reads it.
    const moot = await agentSays(channel, fixture('a later message says the ask is moot').text, { to: seed.member })
    expect(designerCalls.some((t) => t.startsWith('Update: platform-oncall'))).toBe(true)
    expect(moot.blocks.questions ?? []).toHaveLength(0)
    const closed = (await reread(first.id)).blocks.questions[0]
    expect(closed.status).toBe('superseded')
    expect(closed.closedReason).toContain('no longer needed')
    await waitFor(async () => ((await activityLines(original.id)).includes('question.closed') ? true : null))
    expect(await activityLines(original.id)).toEqual(['question.asked', 'question.closed'])
    const [item] = await waitFor(async () => {
      const items = await questionInbox(first.id, seed.member)
      return items[0]?.readAt ? items : null
    })
    expect(item.readAt).not.toBeNull()
  })

  test('several questions in one message, nobody tagged, go to the channel', async () => {
    const channel = await freshChannel()
    const row = await agentSays(channel, fixture('three numbered questions, nobody tagged').text)
    expect(row.blocks.questions.map((q: any) => q.interaction)).toEqual(['choice', 'text', 'confirm'])
    for (const q of row.blocks.questions) expect(q.to).toMatchObject({ anyone: true, via: 'channel' })
  })

  test('greetings, offers and agent-to-agent asks get no card', async () => {
    const channel = await freshChannel()
    for (const name of ['DM greeting', 'offer, not a question', 'agent-to-agent ask']) {
      const row = await agentSays(channel, fixture(name).text)
      expect(row.blocks?.questions ?? []).toHaveLength(0)
      expect(row.blocks?.questionScan).toBe('done')
      expect(row.blocks?.messageKind).not.toBe('decision')
    }
  })

  test('plain updates never reach the model', async () => {
    const channel = await freshChannel()
    for (const name of ['plain status, no ask', 'question marks only in code and links']) {
      await agentSays(channel, fixture(name).text)
    }
    expect(designerCalls).toHaveLength(0)
  })

  test('a streamed reply asking an untagged question goes to the person who started the run', async () => {
    const channel = await freshChannel()
    replyText = fixture('go/no-go').text.replace('{me} ', '')
    const posted = await call(seed.owner, 'POST', `/conversations/${channel}/messages`, { text: `<@a:p:${agent.projectId}> review the three proposals`, clientMsgId: crypto.randomUUID() })
    expect(posted.status).toBe(201)
    const reply = await waitFor(async () => {
      const rows = await db.conversationMessage.findMany({ where: { threadRootId: posted.json.message.id, authorType: 'agent' } })
      return rows.find((r: any) => r.blocks?.questions?.length) ?? null
    })
    expect(reply.blocks.questions[0]).toMatchObject({ interaction: 'confirm', to: { userIds: [seed.owner], via: 'run' } })
  })

  test('an untagged ask in a thread goes to whoever started the thread', async () => {
    const channel = await freshChannel()
    const root = await call(seed.owner, 'POST', `/conversations/${channel}/messages`, { text: 'Can someone look at the SigNoz setup?', clientMsgId: crypto.randomUUID() })
    expect(root.status).toBe(201)
    const row = await agentSays(channel, fixture('who has access').text, { threadRootId: root.json.message.id })
    expect(row.blocks.questions[0]).toMatchObject({ interaction: 'person', to: { userIds: [seed.owner], via: 'thread' } })
  })
})

describe('questions addressed to someone in particular', () => {
  /** A model reply that addresses each question to the tagged names given, parsed as the real one is. */
  function routeTo(questionsFor: Array<{ header: string; to: string[] }>) {
    const requests: DesignRequest[] = []
    designerModule.setQuestionDesigner(async (request) => {
      requests.push(request)
      const keyOf = (name: string) => request.tagged?.find((t) => t.name === name)?.key ?? name
      const reply = { questions: questionsFor.map((q) => ({ header: q.header, prompt: `${q.header}?`, interaction: 'text', to: q.to.map(keyOf) })), moot: [] }
      return designerModule.parseDesign(JSON.stringify(reply), new Set(request.open.map((o) => o.id)), request.tagged)
    })
    return requests
  }

  test('two people tagged, one question each: each gets only theirs', async () => {
    const requests = routeTo([{ header: 'Budget', to: ['owner'] }, { header: 'Vendor', to: ['member'] }])
    const channel = await freshChannel()
    const row = await agentSays(channel, `<@u:${seed.owner}> can you approve the budget? <@u:${seed.member}> which vendor should we use?`)
    expect(requests[0]!.tagged).toEqual([
      { key: `u:${seed.owner}`, name: 'owner', kind: 'person' },
      { key: `u:${seed.member}`, name: 'member', kind: 'person' },
    ])
    const [budget, vendor] = row.blocks.questions
    expect(budget.to).toEqual({ userIds: [seed.owner], via: 'mention' })
    expect(vendor.to).toEqual({ userIds: [seed.member], via: 'mention' })
    const inbox = await waitFor(async () => {
      const items = await questionInbox(row.id)
      return items.length === 2 ? items : null
    })
    expect(inbox.map((i: any) => [i.userId, i.title]).sort()).toEqual([
      [seed.member, 'Billing Bot asked you: Vendor'],
      [seed.owner, 'Billing Bot asked you: Budget'],
    ].sort())
  })

  test('a question for another agent is no card for the person who started the run', async () => {
    const devops = await db.project.create({ data: { name: 'DevOps', workspaceId: seed.workspaceId } })
    const requests = routeTo([{ header: 'Capacity', to: ['DevOps'] }])
    const channel = await freshChannel()
    replyText = `<@a:p:${devops.id}> can you confirm the staging cluster has spare capacity?`
    const posted = await call(seed.owner, 'POST', `/conversations/${channel}/messages`, { text: `<@a:p:${agent.projectId}> get the deploy ready`, clientMsgId: crypto.randomUUID() })
    expect(posted.status).toBe(201)
    const reply = await waitFor(async () => {
      const rows = await db.conversationMessage.findMany({ where: { threadRootId: posted.json.message.id, authorType: 'agent' } })
      return rows.find((r: any) => r.blocks?.questionScan) ?? null
    })
    expect(requests[0]!.tagged).toEqual([{ key: `a:p:${devops.id}`, name: 'DevOps', kind: 'agent' }])
    expect(reply.blocks.questions ?? []).toHaveLength(0)
    expect(await questionInbox(reply.id)).toHaveLength(0)
  })

  test('an unaddressed question next to an agent tag still goes to the person who started the run', async () => {
    const devops = await db.project.create({ data: { name: 'DevOps 2', workspaceId: seed.workspaceId } })
    routeTo([{ header: 'Proceed', to: [] }])
    const channel = await freshChannel()
    replyText = `I've asked <@a:p:${devops.id}> to check capacity. Should I go ahead with the deploy?`
    const posted = await call(seed.owner, 'POST', `/conversations/${channel}/messages`, { text: `<@a:p:${agent.projectId}> get the deploy ready`, clientMsgId: crypto.randomUUID() })
    expect(posted.status).toBe(201)
    const reply = await waitFor(async () => {
      const rows = await db.conversationMessage.findMany({ where: { threadRootId: posted.json.message.id, authorType: 'agent' } })
      return rows.find((r: any) => r.blocks?.questions?.length) ?? null
    })
    expect(reply.blocks.questions[0].to).toEqual({ userIds: [seed.owner], via: 'run' })
  })
})

describe('questions an agent passes itself', () => {
  test('team_chat_post with questions: a card without a model call, and the secret comes back to the agent', async () => {
    await freshChannel()
    const slug = `questions-${channelCount}`
    const posted = await call(null, 'POST', internal(`/${slug}/messages`), {
      text: `<@u:${seed.member}> I need the Stripe key to finish the billing sync.`,
      questions: [{ header: 'Stripe key', prompt: 'Paste the Stripe secret key?', interaction: 'secret', secretName: 'STRIPE_SECRET_KEY' }],
    })
    expect(posted.status).toBe(201)
    const id = posted.json.message.id as string
    const row = await waitFor(async () => {
      const r = await reread(id)
      return r?.blocks?.questions?.length ? r : null
    })
    expect(row.blocks).toMatchObject({ messageKind: 'decision', questionScan: 'explicit' })
    expect(row.blocks.questions[0]).toMatchObject({ source: 'agent', interaction: 'secret', to: { userIds: [seed.member], via: 'mention' } })
    expect(designerCalls).toHaveLength(0)

    const q = row.blocks.questions[0]
    const early = await call(null, 'GET', internal(`/messages/${id}/questions/${q.id}/secret`))
    expect(early.status).toBe(409)
    await call(seed.member, 'POST', `/conversation-messages/${id}/questions/${q.id}/answer`, { secret: 'sk_test_abc' })
    const read = await call(null, 'GET', internal(`/messages/${id}/questions/${q.id}/secret`))
    expect(read.json).toEqual({ name: 'STRIPE_SECRET_KEY', value: 'sk_test_abc' })
  })

  test('a malformed question list is cleaned up rather than rejected', async () => {
    await freshChannel()
    const slug = `questions-${channelCount}`
    const posted = await call(null, 'POST', internal(`/${slug}/messages`), {
      text: 'Which region should the replica go in?',
      questions: [{ header: 'Region', prompt: 'Which region?', interaction: 'choice', options: [{ label: 'us-east' }] }, { header: 'no prompt' }],
    })
    expect(posted.status).toBe(201)
    const row = await waitFor(async () => {
      const r = await reread(posted.json.message.id)
      return r?.blocks?.questions?.length ? r : null
    })
    expect(row.blocks.questions).toHaveLength(1)
    expect(row.blocks.questions[0]).toMatchObject({ interaction: 'text', to: { anyone: true, via: 'channel' } })
  })
})

describe('answering', () => {
  test('from the app: settles the card, posts in the thread, wakes the agent, one activity line', async () => {
    const channel = await freshChannel()
    const row = await agentSays(channel, fixture('go/no-go').text, { to: seed.member })
    const q = row.blocks.questions[0]
    expect(q.interaction).toBe('confirm')
    await waitFor(async () => ((await questionInbox(row.id, seed.member)).length ? true : null))

    const stranger = await call(seed.owner, 'POST', `/conversation-messages/${row.id}/questions/${q.id}/answer`, { answer: 'Approve' })
    expect(stranger.status).toBe(403)

    const res = await call(seed.member, 'POST', `/conversation-messages/${row.id}/questions/${q.id}/answer`, { answer: 'Approve' })
    expect(res.status).toBe(200)
    expect(res.json.question).toMatchObject({ status: 'answered', answer: { text: 'Approve', by: { userId: seed.member } } })
    expect(res.json.reply.threadRootId).toBe(row.id)
    expect(res.json.reply.text).toBe(`<@a:p:${agent.projectId}> **Proceed:** Approve`)

    const again = await call(seed.member, 'POST', `/conversation-messages/${row.id}/questions/${q.id}/answer`, { answer: 'Not yet' })
    expect(again.status).toBe(409)

    await waitFor(async () => (invocations.some((i) => i.projectId === agent.projectId) ? true : null))
    await waitFor(async () => ((await activityLines(q.id)).includes('question.answered') ? true : null))
    expect(await activityLines(q.id)).toEqual(['question.asked', 'question.answered'])
    const [item] = await questionInbox(row.id, seed.member)
    expect(item.readAt).not.toBeNull()
  })

  test('a secret is stored for the asking agent only and never posted', async () => {
    const channel = await freshChannel()
    const row = await agentSays(channel, fixture('a secret and a budget in one ask').text, { to: seed.member })
    const [secretQ, budgetQ] = row.blocks.questions
    expect(secretQ).toMatchObject({ interaction: 'secret', secretName: 'ENSEMBLEDATA_API_TOKEN' })
    expect(budgetQ).toMatchObject({ interaction: 'text', hint: 'number' })

    const res = await call(seed.member, 'POST', `/conversation-messages/${row.id}/questions/${secretQ.id}/answer`, { secret: 'ed_live_123456' })
    expect(res.status).toBe(200)
    expect(res.json.question.answer.text).toBe('Provided `ENSEMBLEDATA_API_TOKEN`')
    expect(res.json.question.secretCipher).toBeUndefined()
    expect(res.json.reply.text).not.toContain('ed_live_123456')
    expect(JSON.stringify(res.json.message)).not.toContain('ed_live_123456')

    const listed = await call(seed.member, 'GET', `/conversations/${channel}/messages`)
    expect(JSON.stringify(listed.json)).not.toContain(secretQ.secretCipher ?? 'v1:')

    expect(await questions.readQuestionSecret({ workspaceId: seed.workspaceId, messageId: row.id, questionId: secretQ.id, projectId: agent.projectId }))
      .toEqual({ name: 'ENSEMBLEDATA_API_TOKEN', value: 'ed_live_123456' })
    await expect(questions.readQuestionSecret({ workspaceId: seed.workspaceId, messageId: row.id, questionId: secretQ.id, projectId: null })).rejects.toThrow('Only the agent')

    // One question left open on the message, so the inbox item stays.
    const [item] = await questionInbox(row.id, seed.member)
    expect(item.readAt).toBeNull()
  })

  test('from a Slack button, for a linked person in the same workspace', async () => {
    const channel = await freshChannel()
    const row = await agentSays(channel, fixture('choice buried in a long status report').text, { to: seed.member })
    const q = row.blocks.questions[0]
    const tenant = `T-${seed.workspaceId.slice(0, 8)}`
    await db.chatInstallation.create({ data: { workspaceId: seed.workspaceId, provider: 'slack', externalTenantId: tenant } })
    const value = questions.questionActionValue(row.id, q.id, 2)

    const unlinked = await handleQuestionPress({ provider: 'slack', tenantId: tenant, externalUserId: 'U-NOBODY', value })
    expect(unlinked).toMatchObject({ ok: false })
    expect(unlinked.message).toContain('Link your Shogo account')

    await db.chatIdentityLink.create({ data: { provider: 'slack', externalTenantId: tenant, externalUserId: 'U-MEMBER', userId: seed.member } })
    const pressed = await handleQuestionPress({ provider: 'slack', tenantId: tenant, externalUserId: 'U-MEMBER', value })
    expect(pressed).toEqual({ ok: true, message: 'Answered: PagerDuty' })
    const settled = (await reread(row.id)).blocks.questions[0]
    expect(settled).toMatchObject({ status: 'answered', answer: { text: 'PagerDuty', by: { userId: seed.member } } })
    await waitFor(async () => ((await activityLines(q.id)).includes('question.answered') ? true : null))
    expect(await activityLines(q.id)).toEqual(['question.asked', 'question.answered'])

    const late = await handleQuestionPress({ provider: 'slack', tenantId: tenant, externalUserId: 'U-MEMBER', value })
    expect(late.ok).toBe(false)
  })
})

describe('the Questions inbox', () => {
  test('lists open questions for the viewer with a count, and answered ones on request', async () => {
    const channel = await freshChannel()
    const row = await agentSays(channel, fixture('who has access').text, { to: seed.member })
    const q = row.blocks.questions[0]

    const mine = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/questions`)
    expect(mine.status).toBe(200)
    const item = mine.json.questions.find((i: any) => i.question.id === q.id)
    expect(item).toMatchObject({ messageId: row.id, conversationId: channel, mine: true, canAnswer: true, agent: { name: 'Billing Bot' } })
    expect(mine.json.openCount).toBeGreaterThanOrEqual(1)

    const theirs = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/questions`)
    expect(theirs.json.questions.some((i: any) => i.question.id === q.id)).toBe(false)
    const everyone = await call(seed.owner, 'GET', `/workspaces/${seed.workspaceId}/questions?scope=all`)
    expect(everyone.json.questions.find((i: any) => i.question.id === q.id)).toMatchObject({ mine: false, canAnswer: false })

    await call(seed.member, 'POST', `/conversation-messages/${row.id}/questions/${q.id}/answer`, { answer: 'Dana (dana@example.com)' })
    const open = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/questions`)
    expect(open.json.questions.some((i: any) => i.question.id === q.id)).toBe(false)
    const answered = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/questions?status=answered`)
    expect(answered.json.questions.find((i: any) => i.question.id === q.id)?.question.status).toBe('answered')
  })

  test('dismissing closes it for everyone and logs it', async () => {
    const channel = await freshChannel()
    const row = await agentSays(channel, fixture('go/no-go').text, { to: seed.member })
    const q = row.blocks.questions[0]
    const viewer = await call(seed.viewer, 'POST', `/conversation-messages/${row.id}/questions/${q.id}/dismiss`)
    expect(viewer.status).toBe(403)
    const res = await call(seed.member, 'POST', `/conversation-messages/${row.id}/questions/${q.id}/dismiss`)
    expect(res.status).toBe(200)
    expect(res.json.question.status).toBe('dismissed')
    await waitFor(async () => ((await activityLines(q.id)).includes('question.closed') ? true : null))
  })
})
