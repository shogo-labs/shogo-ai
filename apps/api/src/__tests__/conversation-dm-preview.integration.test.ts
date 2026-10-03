// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The conversation list carries each direct message's newest message, for the
 * second line of the DMs tab.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function post(conversationId: string, authorUserId: string, text: string, extra: Record<string, unknown> = {}) {
  return (await service.postMessage({ conversationId, authorType: 'user', authorUserId, text, ...extra } as any)).row
}

describe('lastMessage on the conversation list', () => {
  test('a direct message carries its newest top-level message, flattened and trimmed', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    await post(dm.id, seed.owner, 'first')
    const newest = await post(dm.id, seed.member, `  ship\n\nit  ${'x'.repeat(300)}`)
    // A thread reply is not the conversation's latest message.
    await post(dm.id, seed.owner, 'in a thread', { threadRootId: newest.id })

    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    const row = list.find((c: any) => c.id === dm.id)!
    expect(row.lastMessage.authorId).toBe(seed.member)
    expect(row.lastMessage.preview.startsWith('ship it xxx')).toBe(true)
    expect(row.lastMessage.preview.length).toBe(140)
  })

  test('deleted messages are skipped and channels carry no preview', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.viewer])
    await post(dm.id, seed.viewer, 'keep me')
    const gone = await post(dm.id, seed.viewer, 'delete me')
    await db.conversationMessage.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })

    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    expect(list.find((c: any) => c.id === dm.id)!.lastMessage.preview).toBe('keep me')
    for (const channel of list.filter((c: any) => c.kind === 'public' || c.kind === 'activity')) {
      expect(channel.lastMessage).toBeUndefined()
    }
  })

  test('a direct message with no messages has no preview', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.member, [seed.viewer])
    const list = await service.listConversationsForUser(seed.workspaceId, seed.member)
    expect(list.find((c: any) => c.id === dm.id)!.lastMessage).toBeUndefined()
  })
})
