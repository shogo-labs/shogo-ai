// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Everyone has a direct message with themselves — the scratchpad Slack calls
 * "You". It is provisioned rather than created on demand, so the row has to
 * name the viewer (a normal DM hides them), and it must stay quiet: no
 * notification and no unread badge for your own note.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const notifications = await import('../services/conversation-notifications')
const workspaceEvents = await import('../services/workspace-events')

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

const selfRow = (list: any[], userId: string) =>
  list.find((c: any) => c.kind === 'dm' && (c.participants ?? []).some((p: any) => p.id === userId && p.self))

describe('the note-to-self conversation', () => {
  test('every member gets one on their next list load, and provisioning is idempotent', async () => {
    const first = await service.listConversationsForUser(seed.workspaceId, seed.member)
    const mine = selfRow(first, seed.member)
    expect(mine).toBeTruthy()
    expect(mine.joined).toBe(true)
    expect(mine.archivedAt).toBeNull()

    // A second load reuses the same conversation rather than adding another.
    const second = await service.listConversationsForUser(seed.workspaceId, seed.member)
    const rows = second.filter((c: any) => c.kind === 'dm' && (c.participants ?? []).some((p: any) => p.self))
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(mine.id)

    const stored = await db.conversation.findMany({ where: { workspaceId: seed.workspaceId, dmKey: `u:${seed.member}` } })
    expect(stored.length).toBe(1)
  })

  test('it names the viewer instead of rendering an empty row', async () => {
    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    const mine = selfRow(list, seed.owner)!
    expect(mine.participants.length).toBe(1)
    expect(mine.participants[0].type).toBe('user')
    expect(mine.participants[0].id).toBe(seed.owner)
    expect(mine.participants[0].self).toBe(true)
    expect(typeof mine.participants[0].name).toBe('string')
    expect(mine.participants[0].name.length).toBeGreaterThan(0)
  })

  test('a normal DM still hides the viewer, and a group DM still lists only the others', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const group = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member, seed.viewer])

    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    const dmRow = list.find((c: any) => c.id === dm.id)!
    expect(dmRow.participants.map((p: any) => p.id)).toEqual([seed.member])
    expect(dmRow.participants.some((p: any) => p.self)).toBe(false)

    const groupRow = list.find((c: any) => c.id === group.id)!
    expect(groupRow.participants.map((p: any) => p.id).sort()).toEqual([seed.member, seed.viewer].sort())
    expect(groupRow.participants.some((p: any) => p.self)).toBe(false)
  })

  test('an agent DM still hides the viewer from the row', async () => {
    const agentDm = await service.openAgentConversation(seed.workspaceId, seed.owner, { projectId: seed.projectId })
    const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
    const row = list.find((c: any) => c.id === agentDm.id)!
    expect(row.participants.some((p: any) => p.type === 'agent')).toBe(true)
    expect(row.participants.some((p: any) => p.type === 'user')).toBe(false)
  })

  test('your own note never notifies you and never shows unread', async () => {
    const note = await service.ensureSelfConversation(seed.workspaceId, seed.viewer)
    const posted = await service.postMessage({
      conversationId: note.id,
      authorType: 'user',
      authorUserId: seed.viewer,
      text: 'buy milk, call the bank',
    } as any)

    expect(await notifications.resolveRecipients(posted)).toEqual([])

    const list = await service.listConversationsForUser(seed.workspaceId, seed.viewer)
    const row = list.find((c: any) => c.id === note.id)!
    expect(row.unreadCount).toBe(0)
    expect(row.mentionCount).toBe(0)
  })

  test('someone outside the workspace gets nothing', async () => {
    const result = await service.ensureSelfConversation(seed.otherWorkspaceId, seed.viewer)
    expect(result).toBeNull()
    const stored = await db.conversation.findMany({ where: { workspaceId: seed.otherWorkspaceId, dmKey: `u:${seed.viewer}` } })
    expect(stored.length).toBe(0)
  })

  test('joining a workspace provisions it up front, without waiting for a chat list', async () => {
    const joiner = await db.user.create({ data: { email: `joiner-${Date.now()}@example.com`, name: 'Joiner' } })
    const key = `u:${joiner.id}`
    try {
      await db.member.create({ data: { workspaceId: seed.workspaceId, userId: joiner.id, role: 'member' } })
      await workspaceEvents.onWorkspaceMemberJoined({
        workspaceId: seed.workspaceId,
        userId: joiner.id,
        memberId: 'member-self-dm-provisioning',
        source: 'invitation',
      })

      // Provisioning is deliberately detached so it can never block the join,
      // so wait for the row instead of assuming it landed synchronously.
      let stored: any[] = []
      for (let i = 0; i < 50 && !stored.length; i++) {
        stored = await db.conversation.findMany({ where: { workspaceId: seed.workspaceId, dmKey: key } })
        if (!stored.length) await new Promise((r) => setTimeout(r, 20))
      }
      expect(stored.length).toBe(1)

      const members = await db.conversationMember.findMany({ where: { conversationId: stored[0].id } })
      expect(members.length).toBe(1)
      expect(members[0].userId).toBe(joiner.id)
    } finally {
      await db.conversationMember.deleteMany({ where: { conversation: { dmKey: key } } })
      await db.conversation.deleteMany({ where: { workspaceId: seed.workspaceId, dmKey: key } })
      await db.member.deleteMany({ where: { workspaceId: seed.workspaceId, userId: joiner.id } })
      await db.user.deleteMany({ where: { id: joiner.id } })
    }
  })
})
