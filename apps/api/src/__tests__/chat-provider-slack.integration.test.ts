// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Team chat on Slack: Slack events become shadow-conversation messages that
 * run agents, and agent replies go back to Slack in the right thread.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, sseResponse, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const chatMode = await import('../services/chat-mode')
const dispatcher = await import('../services/conversation-agent-dispatcher')
const registry = await import('../services/chat-providers/registry')
const installations = await import('../services/chat-providers/installations')
const inbound = await import('../services/chat-providers/inbound')
const slack = await import('../services/chat-providers/slack')
const adopt = await import('../services/chat-providers/slack-adopt')

const db = prisma as any
let seed: SeededWorkspace
let teamId: string
let slackCalls: Array<{ method: string; body: any }> = []
let invocations: Array<{ projectId: string | null; prompt: string; userId: string }> = []
let ts = 1_700_000_000

const nextTs = () => `${++ts}.000100`
const calls = (method: string) => slackCalls.filter((c) => c.method === method)

function event(fields: Record<string, unknown>) {
  return { team_id: teamId, event: { type: 'message', channel: 'C_GEN', channel_type: 'channel', ts: nextTs(), ...fields } }
}

async function deliver(payload: any) {
  const events = slack.slackEventsFromPayload(payload, 'B_SHOGO')
  let last: any = null
  for (const e of events) last = await inbound.handleInboundEvent(slack.slackProvider, e)
  return last
}

async function setMode(mode: string | null, provider: string | null) {
  await db.workspace.update({ where: { id: seed.workspaceId }, data: { chatMode: mode, chatProvider: provider } })
  chatMode._resetChatModeCacheForTests()
}

async function linkSlackUser(slackUserId: string, userId: string) {
  await installations.linkIdentity({ provider: 'slack', externalTenantId: teamId, externalUserId: slackUserId, userId })
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  teamId = `T-${seed.workspaceId.slice(0, 6)}`
  await installations.upsertInstallation({
    workspaceId: seed.workspaceId,
    provider: 'slack',
    externalTenantId: teamId,
    tenantName: 'Acme Slack',
    botUserId: 'B_SHOGO',
    credentials: { botToken: 'xoxb-test' },
  })
  registry._resetChatProvidersForTests()
  registry.registerChatProvider(slack.slackProvider)
  slack._setSlackCallForTests(async (token, method, body) => {
    expect(token).toBe('xoxb-test')
    slackCalls.push({ method, body })
    if (method === 'conversations.info') return { ok: true, channel: { id: body.channel, name: 'general', is_private: false } }
    if (method === 'conversations.open') return { ok: true, channel: { id: 'D_PRIVATE' } }
    if (method === 'chat.postMessage') return { ok: true, channel: body.channel, ts: nextTs() }
    return { ok: true }
  })
  dispatcher.configureConversationAgentDispatcher({
    invoke: async (args) => {
      invocations.push({ projectId: args.projectId, prompt: args.prompt, userId: args.userId })
      return sseResponse([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'All **three** invoices are paid.' },
        { type: 'text-end', id: 't' },
        { type: 'finish' },
      ])
    },
  })
})

beforeEach(async () => {
  slackCalls = []
  invocations = []
  await setMode('external', 'slack')
})

afterAll(async () => {
  registry._resetChatProvidersForTests()
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('event normalization', () => {
  test('mentions, markup, and bot posts', () => {
    const [msg] = slack.slackEventsFromPayload(
      event({ type: 'app_mention', user: 'U1', text: '<@B_SHOGO> check <https://x.io|the doc> in <#C9|ops> &amp; ping <@U2|dana>' }),
      'B_SHOGO',
    ) as any[]
    expect(msg).toMatchObject({ type: 'message', addressed: true, channelKind: 'public', text: 'check the doc (https://x.io) in #ops & ping @dana' })
    expect(slack.slackEventsFromPayload(event({ user: 'U1', text: 'hi', bot_id: 'BX' }), 'B_SHOGO')).toEqual([])
    expect(slack.slackEventsFromPayload(event({ user: 'B_SHOGO', text: 'echo' }), 'B_SHOGO')).toEqual([])
    const [dm] = slack.slackEventsFromPayload(event({ user: 'U1', text: 'hello', channel: 'D1', channel_type: 'im' }), 'B_SHOGO') as any[]
    expect(dm).toMatchObject({ addressed: true, channelKind: 'dm' })
    const [edit] = slack.slackEventsFromPayload(event({ subtype: 'message_changed', message: { ts: '1.2', user: 'U1', text: 'fixed' } }), 'B_SHOGO')
    expect(edit).toMatchObject({ type: 'edit', messageId: '1.2', text: 'fixed' })
  })

  test('outbound markdown becomes mrkdwn', () => {
    expect(slack.markdownToSlack('## Plan\n**Bold** and [docs](https://d.io) ~~old~~ a<b')).toBe('*Plan*\n*Bold* and <https://d.io|docs> ~old~ a&lt;b')
  })
})

describe('bridge', () => {
  test('nothing is bridged while team chat is not on Slack', async () => {
    await setMode('native', null)
    expect(await deliver(event({ type: 'app_mention', user: 'U_OWNER', text: '<@B_SHOGO> hi' }))).toBeNull()
  })

  test('unlinked people are recorded but get a private link prompt instead of an agent', async () => {
    const res = await deliver(event({ type: 'app_mention', user: 'U_STRANGER', text: '<@B_SHOGO> what is our MRR?' }))
    expect(res.row.authorUserId).toBeNull()
    expect(res.message.author).toMatchObject({ id: 'ext:slack:U_STRANGER' })
    expect(calls('conversations.open')[0].body.users).toBe('U_STRANGER')
    const prompt = calls('chat.postMessage')[0].body
    expect(prompt.channel).toBe('D_PRIVATE')
    expect(prompt.blocks[1].elements[0].url).toContain('/auth/slack-link?state=')
    expect(invocations).toHaveLength(0)
  })

  test('a linked mention creates the shadow channel, runs the agent, and replies in the Slack thread', async () => {
    await linkSlackUser('U_OWNER', seed.owner)
    const payload = event({ type: 'app_mention', user: 'U_OWNER', text: '<@B_SHOGO> are the invoices paid?' })
    const res = await deliver(payload)
    expect(res.conversation).toMatchObject({ provider: 'slack', externalId: 'C_GEN', name: 'general', kind: 'public' })
    expect(res.row.text).toBe('<@a:ws> are the invoices paid?')

    const reply = await waitFor(async () => {
      const row = await db.conversationMessage.findFirst({ where: { threadRootId: res.row.id, authorType: 'agent', agentStatus: 'done' } })
      return row
    })
    expect(reply.text).toBe('All **three** invoices are paid.')
    expect(invocations[0]).toMatchObject({ projectId: null, userId: seed.owner })
    expect(invocations[0].prompt).toContain('team chat in Slack')

    const placeholder = calls('chat.postMessage').at(-1)!.body
    expect(placeholder).toMatchObject({ channel: 'C_GEN', thread_ts: payload.event.ts, text: '_Working on it…_' })
    expect(placeholder.username).toBeTruthy()
    await waitFor(async () => calls('chat.update').some((c) => c.body.text === 'All *three* invoices are paid.'))
    expect(reply.externalRef).toMatch(/^slack:C_GEN:/)

    // Slack sends message and app_mention for the same post; the second is a no-op.
    const again = await deliver({ ...payload, event: { ...payload.event, type: 'message' } })
    expect(again.duplicate).toBe(true)
    expect(invocations).toHaveLength(1)
  })

  test('a thread follow-up without a mention goes to the agent that replied', async () => {
    await linkSlackUser('U_MEMBER', seed.member)
    const root = event({ type: 'app_mention', user: 'U_MEMBER', text: `<@B_SHOGO> project="Billing Bot" draft the reminder` })
    const first = await deliver(root)
    expect(first.row.text).toBe(`<@a:p:${seed.projectId}> draft the reminder`)
    await waitFor(async () => invocations.length === 1)
    await waitFor(async () => db.conversationMessage.findFirst({ where: { threadRootId: first.row.id, agentStatus: 'done' } }))

    const follow = await deliver(event({ user: 'U_MEMBER', text: 'make it shorter', thread_ts: root.event.ts }))
    expect(follow.row.threadRootId).toBe(first.row.id)
    await waitFor(async () => invocations.length === 2)
    expect(invocations[1].projectId).toBe(seed.projectId)

    const unrelated = await deliver(event({ user: 'U_MEMBER', text: 'lunch?' }))
    expect(unrelated.row.threadRootId).toBeNull()
    await new Promise((r) => setTimeout(r, 50))
    expect(invocations).toHaveLength(2)
  })

  test('replies in threads that predate the bridge still thread', async () => {
    await linkSlackUser('U_OWNER', seed.owner)
    const res = await deliver(event({ user: 'U_OWNER', text: 'old thread reply', thread_ts: '1600000000.000001' }))
    const root = await db.conversationMessage.findUnique({ where: { id: res.row.threadRootId } })
    expect(root).toMatchObject({ authorType: 'system', externalRef: 'slack:C_GEN:1600000000.000001' })
  })

  test('edits and deletes follow the Slack message', async () => {
    await linkSlackUser('U_OWNER', seed.owner)
    const posted = event({ user: 'U_OWNER', text: 'typo here' })
    const res = await deliver(posted)
    await deliver(event({ subtype: 'message_changed', message: { ts: posted.event.ts, user: 'U_OWNER', text: 'fixed here' } }))
    expect((await db.conversationMessage.findUnique({ where: { id: res.row.id } })).text).toBe('fixed here')
    await deliver(event({ subtype: 'message_deleted', deleted_ts: posted.event.ts }))
    expect((await db.conversationMessage.findUnique({ where: { id: res.row.id } })).deletedAt).not.toBeNull()
  })

  test('DMs with the app go to the default agent without threading', async () => {
    await linkSlackUser('U_OWNER', seed.owner)
    const res = await deliver(event({ user: 'U_OWNER', text: 'hello', channel: 'D_OWNER', channel_type: 'im' }))
    expect(res.conversation).toMatchObject({ kind: 'dm', dmKey: `a:ext:slack:D_OWNER` })
    await waitFor(async () => invocations.length === 1)
    await waitFor(async () => calls('chat.postMessage').some((c) => c.body.channel === 'D_OWNER'))
    expect(calls('chat.postMessage').find((c) => c.body.channel === 'D_OWNER')!.body.thread_ts).toBeUndefined()
  })

  test('linking resumes the message that prompted it', async () => {
    const posted = event({ type: 'app_mention', user: 'U_LATE', text: '<@B_SHOGO> summarize #general' })
    const res = await deliver(posted)
    expect(invocations).toHaveLength(0)
    await linkSlackUser('U_LATE', seed.viewer)
    const resumed = await inbound.resumeAfterLink(slack.slackProvider, { tenantId: teamId, channelId: 'C_GEN', messageId: posted.event.ts }, seed.viewer)
    expect(resumed).toBe(true)
    await waitFor(async () => invocations.length === 1)
    expect(invocations[0].userId).toBe(seed.viewer)
    expect((await db.conversationMessage.findUnique({ where: { id: res.row.id } })).authorUserId).toBe(seed.viewer)
  })
})

describe('adopting Slack agent routing', () => {
  test('channel defaults become agent members and keyword rules move to the install', async () => {
    await db.slackWorkspaceInstallation.create({
      data: { workspaceId: seed.workspaceId, slackTeamId: teamId, botAccessTokenEncrypted: 'x', botUserId: 'B_SHOGO', defaultProjectId: seed.projectId },
    })
    await db.slackChannelSettings.create({ data: { slackTeamId: teamId, slackChannelId: 'C_BILLING', defaultProjectId: seed.projectId } })
    await db.slackProjectRoutingRule.create({ data: { slackTeamId: teamId, keyword: 'refund', projectId: seed.projectId } })
    await db.slackProjectRoutingRule.create({ data: { slackTeamId: teamId, keyword: 'elsewhere', projectId: seed.foreignProjectId } })
    expect(await adopt.adoptSlackRouting(seed.workspaceId)).toEqual({ channels: 1, rules: 1 })
    expect(await adopt.adoptSlackRouting(seed.workspaceId)).toEqual({ channels: 1, rules: 1 })

    const billing = await db.conversation.findFirst({ where: { workspaceId: seed.workspaceId, provider: 'slack', externalId: 'C_BILLING' } })
    const members = await db.conversationMember.findMany({ where: { conversationId: billing.id, memberType: 'agent' } })
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ projectId: seed.projectId, agentTrigger: 'mention' })

    await linkSlackUser('U_OWNER', seed.owner)
    const inBilling = await deliver(event({ type: 'app_mention', channel: 'C_BILLING', user: 'U_OWNER', text: '<@B_SHOGO> status?' }))
    expect(inBilling.row.text).toBe(`<@a:p:${seed.projectId}> status?`)
    const keyword = await deliver(event({ type: 'app_mention', channel: 'C_RANDOM', user: 'U_OWNER', text: '<@B_SHOGO> refund order 12' }))
    expect(keyword.row.text).toBe(`<@a:p:${seed.projectId}> refund order 12`)
  })
})
