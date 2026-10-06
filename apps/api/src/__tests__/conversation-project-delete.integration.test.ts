// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Deleting a project takes its agent out of team chat: DMs are archived, channel
 * memberships are removed, and the agent drops out of the mentionables list.
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

describe('removeProjectAgent', () => {
  test('archives the agent DM, leaves channels, and drops out of mentionables', async () => {
    const project = await db.project.create({ data: { name: 'Doomed agent', workspaceId: seed.workspaceId, createdBy: seed.owner } })
    const dm = await service.openAgentConversation(seed.workspaceId, seed.owner, { projectId: project.id })
    const channel = await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'doomed-room' } as any)
    await service.addAgentMember(channel.id, seed.owner, { projectId: project.id })

    expect((await service.listMentionables(seed.workspaceId)).agents.some((a: any) => a.projectId === project.id)).toBe(true)

    await db.project.delete({ where: { id: project.id } })
    await service.removeProjectAgent(project.id, seed.workspaceId)

    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    expect(list.find((c: any) => c.id === dm.id)!.archivedAt).toBeTruthy()
    expect(await service.listAgentMembers(channel.id)).toHaveLength(0)
    expect((await service.listMentionables(seed.workspaceId)).agents.some((a: any) => a.projectId === project.id)).toBe(false)
  })

  test('archives agent DMs orphaned before cleanup existed when the list loads', async () => {
    const project = await db.project.create({ data: { name: 'Legacy orphan', workspaceId: seed.workspaceId, createdBy: seed.owner } })
    const dm = await service.openAgentConversation(seed.workspaceId, seed.owner, { projectId: project.id })
    await db.project.delete({ where: { id: project.id } })

    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    expect(list.find((c: any) => c.id === dm.id)!.archivedAt).toBeTruthy()
    const stored = await db.conversation.findUnique({ where: { id: dm.id } })
    expect(stored.archivedAt).toBeTruthy()
  })
})
