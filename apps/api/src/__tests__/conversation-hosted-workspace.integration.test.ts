// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reading a hosted workspace's channels writes nothing (SHO-185, SHO-285).
 *
 * A workspace hosted on a paired desktop has the same rows, under the same ids,
 * on both sides. Its #general/#activity are seeded by the desktop and come up
 * with the sync; seeding them in the cloud too would mint a second set under
 * other ids that the two sides could never reconcile.
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

describe("listing a hosted workspace's conversations", () => {
  test('a hosted workspace whose channels have not synced yet seeds nothing', async () => {
    const hosted = await db.workspace.create({
      data: { name: 'Laptop', slug: `laptop-${crypto.randomUUID().slice(0, 8)}`, kind: 'team', hostInstanceId: 'inst-laptop' },
    })
    await db.member.create({ data: { userId: seed.owner, workspaceId: hosted.id, role: 'owner' } })

    const list = await service.listConversationsForUser(hosted.id, seed.owner)

    expect(list).toEqual([])
    expect(await db.conversation.count({ where: { workspaceId: hosted.id } })).toBe(0)
    expect(await db.conversationMember.count({ where: { conversation: { workspaceId: hosted.id } } })).toBe(0)
  })

  test("lists the desktop's own channels as synced", async () => {
    const copy = await db.workspace.create({
      data: { name: 'Studio', slug: `studio-${crypto.randomUUID().slice(0, 8)}`, kind: 'team', hostInstanceId: 'inst-studio' },
    })
    await db.member.create({ data: { userId: seed.owner, workspaceId: copy.id, role: 'owner' } })
    await db.conversation.create({
      data: { workspaceId: copy.id, kind: 'public', name: 'general', slug: 'general' },
    })
    await db.conversation.create({
      data: { workspaceId: copy.id, kind: 'public', name: 'design', slug: 'design' },
    })

    const list = await service.listConversationsForUser(copy.id, seed.owner)

    expect(list.map((c: any) => c.slug).sort()).toEqual(['design', 'general'])
    expect(await db.conversation.count({ where: { workspaceId: copy.id } })).toBe(2)
    expect(await db.conversationMember.count({ where: { conversation: { workspaceId: copy.id } } })).toBe(0)
  })

  test('a normal workspace still gets its defaults', async () => {
    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    expect(list.some((c: any) => c.slug === 'general')).toBe(true)
    expect(list.some((c: any) => c.kind === 'activity')).toBe(true)
  })
})
