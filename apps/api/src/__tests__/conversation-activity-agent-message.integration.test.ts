// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Finished agent posts in public channels show up once in #activity.
 * Placeholders, private channels, direct messages, and people do not.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, waitFor, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const pipeline = await import('../services/conversation-pipeline')
const activity = await import('../services/conversation-activity')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string

async function agentLines() {
  const channel = await service.getActivityConversation(seed.workspaceId)
  const rows = await db.conversationMessage.findMany({
    where: { conversationId: channel.id },
    orderBy: { seq: 'asc' },
  })
  return rows.filter((row: any) => row.blocks?.kind === 'agent.message')
}

async function postAgent(input: Record<string, unknown>) {
  const result = await service.postMessage({
    conversationId: generalId,
    authorType: 'agent',
    authorAgentRef: { projectId: seed.projectId, name: 'Billing Bot' },
    agentStatus: 'done',
    text: 'Invoices are reconciled.',
    ...input,
  } as any)
  await pipeline.afterMessagePosted(result, { actorUserId: null, origin: 'agent' })
  return result
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  activity.registerConversationActivity()
  await service.listConversationsForUser(seed.workspaceId, seed.owner)
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('#activity agent messages', () => {
  test('a finished agent post in a public channel is one #activity line', async () => {
    const posted = await postAgent({})
    const lines = await agentLines()
    const line = lines.find((row: any) => row.blocks?.messageId === posted.row.id)
    expect(line).toBeTruthy()
    expect(line.text).toBe(`**Billing Bot** sent a message in <#c:${generalId}>`)
    expect(line.blocks).toMatchObject({
      type: 'activity',
      kind: 'agent.message',
      conversationId: generalId,
      messageId: posted.row.id,
      threadRootId: null,
      projectId: seed.projectId,
    })
    expect(lines.filter((row: any) => row.blocks?.messageId === posted.row.id)).toHaveLength(1)
  })

  test('a thread reply says it replied in a thread', async () => {
    const root = await service.postMessage({
      conversationId: generalId,
      authorType: 'user',
      authorUserId: seed.owner,
      text: 'Can you check the invoices?',
    })
    const reply = await postAgent({ threadRootId: root.row.id, text: 'Three are overdue.' })
    const line = (await agentLines()).find((row: any) => row.blocks?.messageId === reply.row.id)
    expect(line.text).toBe(`**Billing Bot** replied in a thread in <#c:${generalId}>`)
    expect(line.blocks.threadRootId).toBe(root.row.id)
  })

  test('a running placeholder posts nothing; settling it posts exactly one line', async () => {
    const placeholder = await service.postMessage({
      conversationId: generalId,
      authorType: 'agent',
      authorAgentRef: { projectId: seed.projectId, name: 'Billing Bot' },
      text: '',
      agentStatus: 'running',
    })
    await pipeline.afterMessagePosted(placeholder, { actorUserId: null, origin: 'agent' })
    expect((await agentLines()).some((row: any) => row.blocks?.messageId === placeholder.row.id)).toBe(false)

    await service.updateMessageInternal(placeholder.row.id, { text: 'Done.', agentStatus: 'done' })
    const settled = await waitFor(async () => {
      const line = (await agentLines()).find((row: any) => row.blocks?.messageId === placeholder.row.id)
      return line ?? null
    })
    expect(settled.text).toBe(`**Billing Bot** sent a message in <#c:${generalId}>`)

    const row = await db.conversationMessage.findUnique({ where: { id: placeholder.row.id } })
    const conversation = await db.conversation.findUnique({ where: { id: generalId } })
    await pipeline.afterMessagePosted(
      { row, conversation, mentions: [], duplicate: false, message: null } as any,
      { actorUserId: null, origin: 'agent', settled: true },
    )
    expect((await agentLines()).filter((row: any) => row.blocks?.messageId === placeholder.row.id)).toHaveLength(1)
  })

  test('private channels, direct messages, and people post nothing', async () => {
    const before = (await agentLines()).length
    const priv = await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'secret', kind: 'private' })
    const hidden = await service.postMessage({
      conversationId: priv.id,
      authorType: 'agent',
      authorAgentRef: { projectId: seed.projectId, name: 'Billing Bot' },
      agentStatus: 'done',
      text: 'This stays private.',
    })
    await pipeline.afterMessagePosted(hidden, { actorUserId: null, origin: 'agent' })

    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const direct = await service.postMessage({
      conversationId: dm.id,
      authorType: 'agent',
      authorAgentRef: { projectId: seed.projectId, name: 'Billing Bot' },
      agentStatus: 'done',
      text: 'Hello there.',
    })
    await pipeline.afterMessagePosted(direct, { actorUserId: null, origin: 'agent' })

    const human = await service.postMessage({
      conversationId: generalId,
      authorType: 'user',
      authorUserId: seed.owner,
      text: 'I sent this myself.',
    })
    await pipeline.afterMessagePosted(human, { actorUserId: seed.owner, origin: 'app' })

    expect(await agentLines()).toHaveLength(before)
  })
})
