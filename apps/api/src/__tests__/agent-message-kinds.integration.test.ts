// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Message kinds and status cards: agents mark what a post is for, keep one
 * card up to date in place (mirrored to Slack), and only decisions and alerts
 * interrupt people.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

process.env.SECRETS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64')
const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const kinds = await import('../services/conversation-message-kind')
const registry = await import('../services/chat-providers/registry')
const installations = await import('../services/chat-providers/installations')
const outbound = await import('../services/chat-providers/outbound')
const slack = await import('../services/chat-providers/slack')
const service = await import('../services/conversation.service')
const notifications = await import('../services/conversation-notifications')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let slackCalls: Array<{ method: string; body: any }> = []

const agent = () => ({ projectId: seed.projectId, name: 'Builder' })

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) await service.listConversationsForUser(seed.workspaceId, user)
  generalId = (await service.listConversationsForUser(seed.workspaceId, seed.owner)).find((c: any) => c.slug === 'general')!.id
  await installations.upsertInstallation({
    workspaceId: seed.workspaceId,
    provider: 'slack',
    externalTenantId: `T-${seed.workspaceId}`,
    tenantName: 'Acme Slack',
    botUserId: 'B1',
    credentials: { botToken: 'xoxb-test' },
  })
})

beforeEach(async () => {
  slackCalls = []
  registry._resetChatProvidersForTests()
  registry.registerChatProvider(slack.slackProvider)
  slack._setSlackCallForTests(async (_token, method, body) => {
    slackCalls.push({ method, body })
    return { ok: true, channel: body.channel, ts: `1700.${slackCalls.length}` }
  })
  await db.conversationMember.updateMany({ where: { conversationId: generalId }, data: { muted: false, notifyLevel: 'default' } })
})

afterAll(async () => {
  slack._setSlackCallForTests(null)
  notifications._setPushSenderForTests(null)
  registry._resetChatProvidersForTests()
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('normalizing agent input', () => {
  test('kinds are a closed set', () => {
    expect(kinds.normalizeKind('decision')).toBe('decision')
    expect(kinds.normalizeKind('urgent')).toBeNull()
    expect(kinds.normalizeKind(3)).toBeNull()
  })

  test('cards need a title; steps, links and step index are bounded and cleaned', () => {
    expect(kinds.normalizeCard({ status: 'done' })).toBeNull()
    expect(kinds.normalizeCard('x')).toBeNull()
    const card = kinds.normalizeCard({
      title: '  Fix totals  ',
      status: 'weird',
      steps: ['Triage', '', 'Fix', 42],
      step: 99,
      links: [{ label: 'PR', url: 'https://github.com/a/b/pull/1' }, { url: 'javascript:alert(1)' }, { url: 'https://x.dev' }],
      criteria: ['Total is correct with a coupon'],
    })!
    expect(card.title).toBe('Fix totals')
    expect(card.status).toBe('working')
    expect(card.steps).toEqual(['Triage', 'Fix'])
    expect(card.step).toBe(2)
    expect(card.links).toEqual([{ label: 'PR', url: 'https://github.com/a/b/pull/1' }, { label: 'https://x.dev', url: 'https://x.dev' }])
  })

  test('the markdown rendering shows progress, criteria, links and the summary', () => {
    const md = kinds.cardToMarkdown({
      title: 'Fix totals',
      status: 'working',
      steps: ['Triage', 'Fix', 'Review'],
      step: 1,
      criteria: ['Coupon total is right'],
      links: [{ label: 'PR', url: 'https://github.com/a/b/pull/1' }],
    })
    expect(md).toContain('**Fix totals** — In progress')
    expect(md).toContain('✅ Triage\n🔄 Fix\n⬜ Review')
    expect(md).toContain('- Coupon total is right')
    expect(md).toContain('[PR](https://github.com/a/b/pull/1)')
    const done = kinds.cardToMarkdown({ title: 'Fix totals', status: 'done', steps: ['Triage', 'Fix'], step: 0, summary: 'Shipped.' })
    expect(done).toContain('✅ Triage\n✅ Fix')
    expect(done).toContain('Shipped.')
  })
})

describe('posting and updating a card', () => {
  async function slackConversation() {
    return db.conversation.create({
      data: {
        workspaceId: seed.workspaceId, kind: 'public', name: 'eng', slug: `eng-${crypto.randomUUID().slice(0, 6)}`,
        provider: 'slack', externalId: `C${crypto.randomUUID().slice(0, 6)}`,
      },
    })
  }

  test('the card is stored structured and rendered as text', async () => {
    const card = kinds.normalizeCard({ title: 'Fix totals', steps: ['Triage', 'Fix'], step: 0 })!
    const res = await outbound.postAgentMessage({
      conversationId: generalId,
      text: kinds.cardToMarkdown(card),
      agent: agent(),
      blocks: kinds.blocksForKind({ kind: 'status', card }),
    })
    expect(res.row.blocks).toMatchObject({ type: 'status_card', messageKind: 'status', card: { title: 'Fix totals' } })
    expect(res.message.text).toContain('🔄 Triage')
  })

  test('an update edits the same message, here and on Slack, without posting again', async () => {
    const conv = await slackConversation()
    const card = kinds.normalizeCard({ title: 'Fix totals', steps: ['Triage', 'Fix'], step: 0 })!
    const first = await outbound.postAgentMessage({
      conversationId: conv.id, text: kinds.cardToMarkdown(card), agent: agent(), blocks: kinds.blocksForKind({ kind: 'status', card }),
    })
    const posts = slackCalls.filter((c) => c.method === 'chat.postMessage').length

    const next = kinds.normalizeCard({
      title: 'Fix totals', steps: ['Triage', 'Fix'], step: 1, links: [{ label: 'PR', url: 'https://github.com/a/b/pull/1' }],
    })!
    const { message } = await outbound.updateAgentMessage({
      messageId: first.row.id, workspaceId: seed.workspaceId, projectId: seed.projectId, card: next,
    })
    expect(message.id).toBe(first.row.id)
    expect(message.text).toContain('✅ Triage\n🔄 Fix')
    expect(message.blocks.card.step).toBe(1)
    expect(message.blocks.messageKind).toBe('status')
    expect(message.editedAt).toBeNull()

    expect(slackCalls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(posts)
    const update = slackCalls.find((c) => c.method === 'chat.update')!
    expect(update.body.channel).toBe(conv.externalId)
    expect(update.body.text).toContain('Fix')
    expect(update.body.text).toContain('<https://github.com/a/b/pull/1|PR>')
  })

  test('finishing a card sets it done with a summary and keeps its kind unless changed', async () => {
    const card = kinds.normalizeCard({ title: 'Fix totals', steps: ['Triage'] })!
    const first = await outbound.postAgentMessage({
      conversationId: generalId, text: kinds.cardToMarkdown(card), agent: agent(), blocks: kinds.blocksForKind({ kind: 'status', card }),
    })
    const { message } = await outbound.updateAgentMessage({
      messageId: first.row.id, workspaceId: seed.workspaceId, projectId: seed.projectId,
      card: kinds.normalizeCard({ title: 'Fix totals', status: 'done', steps: ['Triage'], summary: 'Merged.' })!,
      kind: 'result',
    })
    expect(message.blocks).toMatchObject({ messageKind: 'result', card: { status: 'done', summary: 'Merged.' } })
    expect(message.text).toContain('Merged.')
  })

  test('a note under a card is kept; text alone on a card message keeps the card', async () => {
    const card = kinds.normalizeCard({ title: 'Fix totals', steps: ['Triage'] })!
    const first = await outbound.postAgentMessage({
      conversationId: generalId, text: kinds.cardToMarkdown(card), agent: agent(), blocks: kinds.blocksForKind({ card }),
    })
    const { message } = await outbound.updateAgentMessage({
      messageId: first.row.id, workspaceId: seed.workspaceId, projectId: seed.projectId, text: 'Waiting on CI',
    })
    expect(message.blocks.card.title).toBe('Fix totals')
    expect(message.text).toContain('**Fix totals**')
    expect(message.text.endsWith('Waiting on CI')).toBe(true)
  })

  test('only the agent that wrote a message can update it, and not while it is streaming', async () => {
    const first = await outbound.postAgentMessage({ conversationId: generalId, text: 'hello', agent: agent() })
    const other = await db.project.create({ data: { name: 'Other agent', workspaceId: seed.workspaceId, createdBy: seed.owner } })
    await expect(outbound.updateAgentMessage({ messageId: first.row.id, workspaceId: seed.workspaceId, projectId: other.id, text: 'x' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(outbound.updateAgentMessage({ messageId: first.row.id, workspaceId: seed.workspaceId, projectId: null, text: 'x' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(outbound.updateAgentMessage({ messageId: first.row.id, workspaceId: 'elsewhere', projectId: seed.projectId, text: 'x' }))
      .rejects.toMatchObject({ status: 404 })

    const human = await service.postMessage({ conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: 'mine' })
    await expect(outbound.updateAgentMessage({ messageId: human.row.id, workspaceId: seed.workspaceId, projectId: seed.projectId, text: 'x' }))
      .rejects.toMatchObject({ status: 403 })

    const running = await outbound.postAgentMessage({ conversationId: generalId, text: '', agent: agent(), agentStatus: 'running' })
    await expect(outbound.updateAgentMessage({ messageId: running.row.id, workspaceId: seed.workspaceId, projectId: seed.projectId, text: 'x' }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('agents working in a thread can move its task card, but not another agent\'s other messages', async () => {
    const root = await service.postMessage({ conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: 'Checkout total is wrong' })
    const builder = await db.project.create({ data: { name: 'Builder agent', workspaceId: seed.workspaceId, createdBy: seed.owner } })
    const outsider = await db.project.create({ data: { name: 'Outsider agent', workspaceId: seed.workspaceId, createdBy: seed.owner } })
    const card = kinds.normalizeCard({ title: 'Fix totals', steps: ['Triage', 'Fix', 'Review'], step: 0 })!
    const posted = await outbound.postAgentMessage({
      conversationId: generalId, text: kinds.cardToMarkdown(card), agent: agent(), threadRootId: root.row.id,
      blocks: kinds.blocksForKind({ kind: 'status', card }),
    })
    const note = await outbound.postAgentMessage({ conversationId: generalId, text: 'Triage notes', agent: agent(), threadRootId: root.row.id })
    const update = (messageId: string, projectId: string) => outbound.updateAgentMessage({
      messageId, workspaceId: seed.workspaceId, projectId, card: { ...card, step: 1 },
    })

    // Not yet part of the thread: refused.
    await expect(update(posted.row.id, builder.id)).rejects.toMatchObject({ status: 403 })

    await outbound.postAgentMessage({ conversationId: generalId, text: 'On it', agent: { projectId: builder.id, name: 'Builder agent' }, threadRootId: root.row.id })
    const moved = await update(posted.row.id, builder.id)
    expect(moved.message.blocks.card.step).toBe(1)
    expect(moved.message.text).toContain('🔄 Fix')

    // Naming the thread's report instead of the card still moves the card.
    const viaRoot = await outbound.updateAgentMessage({
      messageId: root.row.id, workspaceId: seed.workspaceId, projectId: builder.id, card: { ...card, step: 2 },
    })
    expect(viaRoot.message.id).toBe(posted.row.id)
    expect(viaRoot.message.blocks.card.step).toBe(2)

    // A plain message of the other agent stays theirs; so does a card in a thread the agent never wrote in.
    await expect(outbound.updateAgentMessage({ messageId: note.row.id, workspaceId: seed.workspaceId, projectId: builder.id, text: 'x' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(update(posted.row.id, outsider.id)).rejects.toMatchObject({ status: 403 })
  })

  test('an update that says nothing is rejected', async () => {
    const first = await outbound.postAgentMessage({ conversationId: generalId, text: 'hello', agent: agent() })
    await expect(outbound.updateAgentMessage({ messageId: first.row.id, workspaceId: seed.workspaceId, projectId: seed.projectId, text: '  ' }))
      .rejects.toMatchObject({ status: 400 })
  })
})

describe('who gets notified', () => {
  async function notified(result: any) {
    return (await notifications.notifyForMessage(result)).map((r) => `${r.userId}:${r.reason}`).sort()
  }

  async function agentReply(rootId: string, kind: string | null, text = 'update') {
    return outbound.postAgentMessage({
      conversationId: generalId, text, agent: agent(), threadRootId: rootId,
      blocks: kind ? kinds.blocksForKind({ kind: kind as any }) : undefined,
    })
  }

  async function threadWithFollowers() {
    const root = await service.postMessage({ conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: 'please fix totals' })
    await service.postMessage({ conversationId: generalId, authorType: 'user', authorUserId: seed.viewer, text: 'me too', threadRootId: root.row.id })
    return root.row.id as string
  }

  test('status and result updates stay quiet for people on the default level', async () => {
    notifications._setPushSenderForTests(async () => {})
    const root = await threadWithFollowers()
    expect(await notified(await agentReply(root, 'status'))).toEqual([])
    expect(await notified(await agentReply(root, 'result', 'PR ready'))).toEqual([])
  })

  test('decisions and alerts reach everyone following the thread', async () => {
    notifications._setPushSenderForTests(async () => {})
    const root = await threadWithFollowers()
    const expected = [`${seed.owner}:thread`, `${seed.viewer}:thread`]
    expect(await notified(await agentReply(root, 'decision', 'Merge the fix?'))).toEqual(expected)
    expect(await notified(await agentReply(root, 'alert', 'CI is red'))).toEqual(expected)
  })

  test('agent messages without a kind behave as before', async () => {
    notifications._setPushSenderForTests(async () => {})
    const root = await threadWithFollowers()
    expect(await notified(await agentReply(root, null))).toEqual([`${seed.owner}:thread`, `${seed.viewer}:thread`])
  })

  test('people who asked for every message still hear routine updates', async () => {
    notifications._setPushSenderForTests(async () => {})
    const root = await threadWithFollowers()
    await db.conversationMember.updateMany({ where: { conversationId: generalId, userId: seed.owner }, data: { notifyLevel: 'all' } })
    expect(await notified(await agentReply(root, 'status'))).toEqual([`${seed.owner}:thread`])
  })

  test('a decision sends one push, not one per step', async () => {
    const pushes: string[] = []
    notifications._setPushSenderForTests(async (userId, payload) => { pushes.push(`${userId}:${payload.body}`) })
    const root = await threadWithFollowers()
    await notified(await agentReply(root, 'status', 'step 1'))
    await notified(await agentReply(root, 'status', 'step 2'))
    await notified(await agentReply(root, 'decision', 'Merge the fix?'))
    expect(pushes.filter((p) => p.endsWith('Merge the fix?'))).toHaveLength(2)
    expect(pushes.some((p) => p.includes('step'))).toBe(false)
  })
})
