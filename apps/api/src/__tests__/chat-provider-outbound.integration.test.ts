// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Outbound seam: agent posts land in the conversation store and, for
 * conversations that mirror an external channel, on the provider too.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const registry = await import('../services/chat-providers/registry')
const installations = await import('../services/chat-providers/installations')
const outbound = await import('../services/chat-providers/outbound')
const types = await import('../services/chat-providers/types')
const conversations = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace

type Call = { op: 'post' | 'update'; externalId: string | null; thread: string | null; text: string; author: any; ref?: any }
let calls: Call[] = []
let nextId = 0
let edits = true

const fakeSlack: any = {
  kind: 'slack',
  get capabilities() {
    return { threads: true, edits, reactions: false, files: false, perAgentIdentity: true, readHistory: false }
  },
  async verifyAndParse() {
    return { events: [] }
  },
  async postMessage(conv: any, msg: any) {
    calls.push({ op: 'post', externalId: conv.externalId, thread: conv.threadExternalId, text: msg.text, author: msg.author })
    return { provider: 'slack', channelId: conv.externalId, id: `ts-${++nextId}`, threadId: conv.threadExternalId }
  },
  async updateMessage(conv: any, ref: any, msg: any) {
    calls.push({ op: 'update', externalId: conv.externalId, thread: conv.threadExternalId, text: msg.text, author: msg.author, ref })
  },
}

async function mkConversation(external: boolean) {
  return db.conversation.create({
    data: {
      workspaceId: seed.workspaceId,
      kind: 'public',
      name: external ? 'slack-general' : 'general',
      slug: `c-${crypto.randomUUID().slice(0, 8)}`,
      ...(external ? { provider: 'slack', externalId: `C${crypto.randomUUID().slice(0, 6)}` } : {}),
    },
  })
}

const agent = () => ({ projectId: seed.projectId, name: 'Billing Bot' })

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  await installations.upsertInstallation({
    workspaceId: seed.workspaceId,
    provider: 'slack',
    externalTenantId: `T-${seed.workspaceId}`,
    tenantName: 'Acme Slack',
    botUserId: 'B1',
    credentials: { botToken: 'xoxb-test' },
  })
})

beforeEach(() => {
  registry._resetChatProvidersForTests()
  registry.registerChatProvider(fakeSlack)
  calls = []
  edits = true
})

afterAll(async () => {
  registry._resetChatProvidersForTests()
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('external refs', () => {
  test('round-trip ids containing separators', () => {
    const ref = { provider: 'teams' as const, channelId: '19:abc@thread.tacv2', id: '1712:0001/x' }
    expect(types.parseExternalRef(types.externalRefFor(ref))).toEqual({ provider: 'teams', channelId: ref.channelId, id: ref.id })
    expect(types.externalRefFor({ provider: 'slack', channelId: 'C1', id: '1712.0001' })).toBe('slack:C1:1712.0001')
    expect(types.parseExternalRef('slack:C1')).toBeNull()
  })
})

describe('postAgentMessage', () => {
  test('native conversations never reach a provider', async () => {
    const conv = await mkConversation(false)
    const res = await outbound.postAgentMessage({ conversationId: conv.id, text: 'hi', agent: agent(), externalRef: 'task:1' })
    expect(calls).toHaveLength(0)
    expect(res.row.externalRef).toBe('task:1')
  })

  test('external conversations are mirrored and keep the provider message id', async () => {
    const conv = await mkConversation(true)
    const res = await outbound.postAgentMessage({ conversationId: conv.id, text: 'Invoice sent', agent: agent(), externalRef: 'task:2' })
    expect(calls).toEqual([
      { op: 'post', externalId: conv.externalId, thread: null, text: 'Invoice sent', author: { type: 'agent', ...agent() } },
    ])
    const row = await db.conversationMessage.findUnique({ where: { id: res.row.id } })
    expect(row.externalRef).toBe(`slack:${conv.externalId}:ts-${nextId}`)
    expect(row.clientMsgId).toBe('task:2')

    const again = await outbound.postAgentMessage({ conversationId: conv.id, text: 'Invoice sent', agent: agent(), externalRef: 'task:2' })
    expect(again.duplicate).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('thread replies target the root message on the provider', async () => {
    const conv = await mkConversation(true)
    const { row: root } = await conversations.postMessage({
      conversationId: conv.id,
      text: 'q',
      authorType: 'user',
      authorUserId: seed.member,
      externalRef: `slack:${conv.externalId}:1700.01`,
    })
    await outbound.postAgentMessage({ conversationId: conv.id, text: 'a', agent: agent(), threadRootId: root.id })
    expect(calls[0].thread).toBe('1700.01')
  })

  test('a provider failure still keeps the message in Shogo', async () => {
    const conv = await mkConversation(true)
    const failing = { ...fakeSlack, capabilities: fakeSlack.capabilities, postMessage: async () => { throw new Error('channel_not_found') } }
    registry._resetChatProvidersForTests()
    registry.registerChatProvider(failing)
    const res = await outbound.postAgentMessage({ conversationId: conv.id, text: 'x', agent: agent() })
    const row = await db.conversationMessage.findUnique({ where: { id: res.row.id } })
    expect(row.text).toBe('x')
    expect(row.externalRef).toBeNull()
  })
})

describe('streamed replies', () => {
  test('placeholder, throttled progress, and final edit', async () => {
    const conv = await mkConversation(true)
    const handle = await outbound.startAgentReply({ conversation: conv, agent: agent(), threadRootId: null, agentSessionId: 's1' })
    expect(calls.map((c) => c.op)).toEqual(['post'])
    expect(calls[0].text).toContain('Working on it')

    await outbound.streamAgentReply(handle, { text: 'Look', tool: null })
    expect(calls).toHaveLength(1)
    handle.lastExternalUpdate -= outbound.EXTERNAL_STREAM_THROTTLE_MS
    await outbound.streamAgentReply(handle, { text: 'Looking up', tool: 'search' })
    expect(calls[1]).toMatchObject({ op: 'update', text: '_Using search…_' })

    await outbound.finishAgentReply(handle, { text: 'Done: 3 invoices', agentStatus: 'done' })
    expect(calls[2]).toMatchObject({ op: 'update', text: 'Done: 3 invoices' })
    expect(calls[2].ref.id).toBe(calls[1].ref.id)
    const row = await db.conversationMessage.findUnique({ where: { id: handle.messageId } })
    expect(row).toMatchObject({ text: 'Done: 3 invoices', agentStatus: 'done' })
  })

  test('the final edit ends with how long the agent worked, in the same words as the app', async () => {
    const conv = await mkConversation(true)
    const handle = await outbound.startAgentReply({ conversation: conv, agent: agent(), threadRootId: null, agentSessionId: 's3' })
    await outbound.finishAgentReply(handle, {
      text: 'Merged.',
      agentStatus: 'done',
      work: { chatMessageId: 'cm1', startedAt: 0, completedAt: 65_000, toolCalls: 4 },
    })
    expect(calls.at(-1)).toMatchObject({ op: 'update', text: 'Merged.\n\n_Worked for 1m 05s_' })
    const row = await db.conversationMessage.findUnique({ where: { id: handle.messageId } })
    expect(row.text).toBe('Merged.')
    expect(row.blocks.work.toolCalls).toBe(4)
  })

  test('providers without edits get the final text as a new message', async () => {
    edits = false
    const conv = await mkConversation(true)
    const handle = await outbound.startAgentReply({ conversation: conv, agent: agent(), threadRootId: null, agentSessionId: 's2' })
    handle.lastExternalUpdate -= outbound.EXTERNAL_STREAM_THROTTLE_MS
    await outbound.streamAgentReply(handle, { text: 'partial', tool: null })
    await outbound.finishAgentReply(handle, { text: 'final', agentStatus: 'done' })
    expect(calls.map((c) => [c.op, c.text])).toEqual([['post', '_Working on it…_'], ['post', 'final']])
  })
})
