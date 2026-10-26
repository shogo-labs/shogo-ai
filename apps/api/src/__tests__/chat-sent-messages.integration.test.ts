// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Activity panel's Sent view (SHO-103): the team-chat messages you sent,
 * newest first, pages that neither repeat nor drop a row, and nothing you can
 * no longer open.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const service = await import('../services/conversation.service')
const sent = await import('../services/chat-sent')

const db = prisma as any
let seed: SeededWorkspace

async function channel(
  name: string,
  opts: { kind?: 'public' | 'private'; memberUserIds?: string[]; workspaceId?: string; ownerId?: string } = {},
) {
  return service.createChannel({
    workspaceId: opts.workspaceId ?? seed.workspaceId,
    userId: opts.ownerId ?? seed.owner,
    name: `${name}-${crypto.randomUUID().slice(0, 6)}`,
    kind: opts.kind,
    memberUserIds: opts.memberUserIds,
  })
}

async function send(
  userId: string,
  text: string,
  opts: { conversationId: string; threadRootId?: string; createdAt?: Date },
) {
  const { row } = await service.postMessage({
    conversationId: opts.conversationId,
    authorType: 'user',
    authorUserId: userId,
    text,
    threadRootId: opts.threadRootId,
    createdAt: opts.createdAt,
  } as any)
  return row
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) {
    await service.listConversationsForUser(seed.workspaceId, user)
  }
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('sent messages', () => {
  test('lists only your own user messages, newest first', async () => {
    const ch = await channel('sent-mine')
    const older = await send(seed.member, 'mine older', { conversationId: ch.id })
    await Bun.sleep(5)
    const newer = await send(seed.member, 'mine newer', { conversationId: ch.id })
    await send(seed.owner, 'not mine', { conversationId: ch.id })
    await service.postMessage({ conversationId: ch.id, authorType: 'agent', text: 'agent words' } as any)

    const page = await sent.listSentMessages(seed.workspaceId, seed.member, { limit: 100 })
    const mine = page.items.filter((i: any) => i.conversationId === ch.id)
    expect(mine.map((i: any) => i.id)).toEqual([newer.id, older.id])
    expect(mine.map((i: any) => i.text)).toEqual(['mine newer', 'mine older'])
    expect(mine.every((i: any) => i.conversation.kind === 'public')).toBe(true)
  })

  test('a deleted message drops out', async () => {
    const ch = await channel('sent-deleted')
    const row = await send(seed.member, 'gone soon', { conversationId: ch.id })
    await db.conversationMessage.update({ where: { id: row.id }, data: { deletedAt: new Date() } })
    const page = await sent.listSentMessages(seed.workspaceId, seed.member, { limit: 100 })
    expect(page.items.some((i: any) => i.id === row.id)).toBe(false)
  })

  test('thread replies keep their root, DMs read as direct', async () => {
    const ch = await channel('sent-thread')
    const root = await send(seed.member, 'the root', { conversationId: ch.id })
    const reply = await send(seed.member, 'a reply', { conversationId: ch.id, threadRootId: root.id })
    const dm = await service.openDirectConversation(seed.workspaceId, seed.member, [seed.owner])
    const dmRow = await send(seed.member, 'psst', { conversationId: dm.id })

    const page = await sent.listSentMessages(seed.workspaceId, seed.member, { limit: 100 })
    const byId = new Map(page.items.map((i: any) => [i.id, i]))
    expect((byId.get(reply.id) as any).threadRootId).toBe(root.id)
    expect((byId.get(root.id) as any).threadRootId).toBeNull()
    expect((byId.get(dmRow.id) as any).conversation.kind).toBe('dm')
  })

  test('a private channel you left takes its messages with it', async () => {
    const ch = await channel('sent-private', { kind: 'private', memberUserIds: [seed.member] })
    const kept = await send(seed.member, 'while i was in', { conversationId: ch.id })

    let page = await sent.listSentMessages(seed.workspaceId, seed.member, { limit: 100 })
    expect(page.items.some((i: any) => i.id === kept.id)).toBe(true)

    await service.leaveConversation(ch.id, seed.member)
    page = await sent.listSentMessages(seed.workspaceId, seed.member, { limit: 100 })
    expect(page.items.some((i: any) => i.id === kept.id)).toBe(false)
  })

  test('another workspace never leaks in', async () => {
    await db.member.create({ data: { userId: seed.owner, workspaceId: seed.otherWorkspaceId, role: 'member' } })
    const home = await channel('sent-home')
    const away = await channel('sent-away', {
      workspaceId: seed.otherWorkspaceId,
      ownerId: seed.outsider,
      memberUserIds: [seed.owner],
    })
    const homeRow = await send(seed.owner, 'at home', { conversationId: home.id })
    const awayRow = await send(seed.owner, 'away', { conversationId: away.id })

    const here = await sent.listSentMessages(seed.workspaceId, seed.owner, { limit: 100 })
    const there = await sent.listSentMessages(seed.otherWorkspaceId, seed.owner, { limit: 100 })
    expect(here.items.some((i: any) => i.id === homeRow.id)).toBe(true)
    expect(here.items.some((i: any) => i.id === awayRow.id)).toBe(false)
    expect(there.items.some((i: any) => i.id === awayRow.id)).toBe(true)
    expect(there.items.some((i: any) => i.id === homeRow.id)).toBe(false)
  })

  test('pages on (createdAt, id): no duplicate, no gap, even on a tie', async () => {
    const ch = await channel('sent-pages')
    const base = new Date(Date.now() - 60_000)
    const sameMoment = new Date(base.getTime() + 1_000)
    const expected: string[] = []
    // Three messages share one millisecond, so a createdAt-only cursor would
    // either repeat or drop one of them.
    for (let i = 0; i < 7; i += 1) {
      const createdAt = i >= 2 && i <= 4 ? sameMoment : new Date(base.getTime() + i * 1_000)
      const row = await send(seed.viewer, `page ${i}`, { conversationId: ch.id, createdAt })
      expected.push(row.id)
    }

    const seen: string[] = []
    let cursor: { before: string; beforeId: string } | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const page: any = await sent.listSentMessages(seed.workspaceId, seed.viewer, { ...cursor, limit: 2 })
      const ids = page.items.map((i: any) => i.id).filter((id: string) => expected.includes(id))
      seen.push(...ids)
      if (!page.hasMore) break
      const last = page.items[page.items.length - 1]
      cursor = { before: last.createdAt, beforeId: last.id }
    }

    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    // Newest first: the two distinct latest timestamps lead, the four that share
    // a millisecond follow in any stable id order, and the oldest closes the list.
    expect(seen.slice(0, 2)).toEqual([expected[6], expected[5]])
    expect(new Set(seen.slice(2, 6))).toEqual(new Set([expected[1], expected[2], expected[3], expected[4]]))
    expect(seen[6]).toBe(expected[0])
  })

  test('a page reports hasMore only when another page exists', async () => {
    const ch = await channel('sent-hasmore')
    for (let i = 0; i < 3; i += 1) await send(seed.viewer, `edge ${i}`, { conversationId: ch.id })
    const first = await sent.listSentMessages(seed.workspaceId, seed.viewer, { limit: 3 })
    expect(first.items.length).toBe(3)
    expect(first.hasMore).toBe(true)
    const rest = await sent.listSentMessages(seed.workspaceId, seed.viewer, { limit: 100 })
    expect(rest.hasMore).toBe(false)
  })
})
