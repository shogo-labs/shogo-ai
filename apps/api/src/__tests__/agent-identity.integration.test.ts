// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent identity in team chat: each agent posts under its own name and
 * avatar (Slack `username` + `icon_url`) and has a profile card.
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
const slack = await import('../services/chat-providers/slack')
const directory = await import('../services/conversation-directory')

const db = prisma as any
let seed: SeededWorkspace
let slackCalls: Array<{ method: string; body: any }> = []
let failScope = false

const ICON = 'https://cdn.example.com/agents/billing.png'

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
  await db.project.update({ where: { id: seed.projectId }, data: { thumbnailUrl: ICON, description: 'Sends invoices', createdBy: seed.owner } })
})

beforeEach(() => {
  slackCalls = []
  failScope = false
  registry._resetChatProvidersForTests()
  registry.registerChatProvider(slack.slackProvider)
  slack._setSlackCallForTests(async (_token, method, body) => {
    slackCalls.push({ method, body })
    if (failScope && (body.username || body.icon_url)) return { ok: false, error: 'missing_scope' }
    return { ok: true, channel: body.channel, ts: `1700.${slackCalls.length}` }
  })
})

afterAll(async () => {
  slack._setSlackCallForTests(null)
  registry._resetChatProvidersForTests()
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function slackConversation() {
  return db.conversation.create({
    data: {
      workspaceId: seed.workspaceId,
      kind: 'public',
      name: 'eng',
      slug: `eng-${crypto.randomUUID().slice(0, 6)}`,
      provider: 'slack',
      externalId: `C${crypto.randomUUID().slice(0, 6)}`,
    },
  })
}

describe('slackIconUrl', () => {
  test('only public https images are sent to Slack', () => {
    expect(slack.slackIconUrl(ICON)).toBe(ICON)
    expect(slack.slackIconUrl('http://cdn.example.com/a.png')).toBeNull()
    expect(slack.slackIconUrl('https://localhost:3000/a.png')).toBeNull()
    expect(slack.slackIconUrl('https://192.168.1.4/a.png')).toBeNull()
    expect(slack.slackIconUrl('not a url')).toBeNull()
    expect(slack.slackIconUrl(null)).toBeNull()
  })
})

describe('agent avatars on Slack', () => {
  test('an agent post carries its own name and avatar', async () => {
    const conv = await slackConversation()
    const res = await outbound.postAgentMessage({
      conversationId: conv.id,
      text: 'Invoice sent',
      agent: { projectId: seed.projectId, name: 'Billing Bot' },
    })
    const post = slackCalls.find((c) => c.method === 'chat.postMessage')!
    expect(post.body.username).toBe('Billing Bot')
    expect(post.body.icon_url).toBe(ICON)
    const row = await db.conversationMessage.findUnique({ where: { id: res.row.id } })
    expect(row.authorAgentRef).toMatchObject({ projectId: seed.projectId, name: 'Billing Bot', iconUrl: ICON })
  })

  test('a streamed reply opens with the same identity', async () => {
    const conv = await slackConversation()
    const handle = await outbound.startAgentReply({
      conversation: conv,
      agent: { projectId: seed.projectId, name: 'Billing Bot' },
      threadRootId: null,
      agentSessionId: 's1',
    })
    const post = slackCalls.find((c) => c.method === 'chat.postMessage')!
    expect(post.body).toMatchObject({ username: 'Billing Bot', icon_url: ICON })
    expect(handle.author).toMatchObject({ type: 'agent', iconUrl: ICON })
  })

  test('older installs without chat:write.customize fall back to the app identity', async () => {
    failScope = true
    const conv = await slackConversation()
    await outbound.postAgentMessage({ conversationId: conv.id, text: 'hi', agent: { projectId: seed.projectId, name: 'Billing Bot' } })
    const posts = slackCalls.filter((c) => c.method === 'chat.postMessage')
    expect(posts).toHaveLength(2)
    expect(posts[1].body.username).toBeUndefined()
    expect(posts[1].body.icon_url).toBeUndefined()
  })

  test('the workspace agent uses its profile avatar', async () => {
    await db.workspaceAgentProfile.upsert({
      where: { workspaceId: seed.workspaceId },
      create: { workspaceId: seed.workspaceId, name: 'Shogo', avatarUrl: 'https://cdn.example.com/ws.png' },
      update: { avatarUrl: 'https://cdn.example.com/ws.png' },
    })
    const conv = await slackConversation()
    await outbound.postAgentMessage({ conversationId: conv.id, text: 'hi', agent: { projectId: null, name: 'Shogo' } })
    expect(slackCalls.find((c) => c.method === 'chat.postMessage')!.body.icon_url).toBe('https://cdn.example.com/ws.png')
  })

  test('agents without an avatar post by name only', async () => {
    const other = await db.project.create({ data: { name: 'Plain', workspaceId: seed.workspaceId, createdBy: seed.owner } })
    const conv = await slackConversation()
    await outbound.postAgentMessage({ conversationId: conv.id, text: 'hi', agent: { projectId: other.id, name: 'Plain' } })
    const post = slackCalls.find((c) => c.method === 'chat.postMessage')!
    expect(post.body.username).toBe('Plain')
    expect(post.body.icon_url).toBeUndefined()
  })
})

describe('agent profile card', () => {
  test('shows role, owner, avatar and the channels the viewer can see', async () => {
    const visible = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, kind: 'public', name: 'eng', slug: `v-${crypto.randomUUID().slice(0, 6)}` },
    })
    const hidden = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, kind: 'private', name: 'secret', slug: `h-${crypto.randomUUID().slice(0, 6)}` },
    })
    for (const c of [visible, hidden]) {
      await db.conversationMember.create({
        data: { conversationId: c.id, memberType: 'agent', projectId: seed.projectId, agentTrigger: 'keyword' },
      })
    }
    const card = await directory.loadAgentCard(seed.workspaceId, seed.projectId, seed.member)
    expect(card).toMatchObject({ projectId: seed.projectId, role: 'Sends invoices', iconUrl: ICON })
    expect(card!.owner?.id).toBe(seed.owner)
    const names = card!.channels.map((c) => c.name)
    expect(names).toContain('eng')
    expect(names).not.toContain('secret')
    expect(card!.channels.find((c) => c.name === 'eng')!.agentTrigger).toBe('keyword')
  })

  test('the workspace agent has a card, unknown projects do not', async () => {
    const ws = await directory.loadAgentCard(seed.workspaceId, null, seed.member)
    expect(ws).toMatchObject({ projectId: null, name: 'Shogo' })
    expect(await directory.loadAgentCard(seed.workspaceId, 'missing', seed.member)).toBeNull()
    expect(await directory.loadAgentCard(seed.workspaceId, seed.foreignProjectId, seed.member)).toBeNull()
  })
})
