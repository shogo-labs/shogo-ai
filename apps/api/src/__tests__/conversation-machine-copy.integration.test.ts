// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reading a machine copy's channels writes nothing (SHO-185).
 *
 * The cloud serves a paired desktop's workspace from a copy of its rows, under
 * the desktop's ids. Listing a normal workspace's conversations seeds
 * #general, #activity and the reader's note-to-self when they are missing; on
 * a copy that minted cloud-only rows the desktop never wrote — opening the
 * laptop's workspace in production did exactly that.
 *
 * A copy with no #general is a desktop that has never listed its channels
 * (the desktop seeds them on its first read). The cloud says so with
 * `409 machine_copy_pending`, and the client reads them through the relay
 * instead of showing a workspace with no channels (SHO-257).
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

describe("listing a machine copy's conversations", () => {
  test('a copy with no #general is pending, and seeds nothing', async () => {
    const copy = await db.workspace.create({
      data: { name: 'Laptop', slug: `laptop-${crypto.randomUUID().slice(0, 8)}`, kind: 'team', machineInstanceId: 'inst-laptop' },
    })
    await db.member.create({ data: { userId: seed.owner, workspaceId: copy.id, role: 'owner' } })

    const err: any = await service.listConversationsForUser(copy.id, seed.owner).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(service.ConversationError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('machine_copy_pending')
    expect(await db.conversation.count({ where: { workspaceId: copy.id } })).toBe(0)
    expect(await db.conversationMember.count({ where: { conversation: { workspaceId: copy.id } } })).toBe(0)
  })

  test("lists the desktop's own channels as copied", async () => {
    const copy = await db.workspace.create({
      data: { name: 'Studio', slug: `studio-${crypto.randomUUID().slice(0, 8)}`, kind: 'team', machineInstanceId: 'inst-studio' },
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
