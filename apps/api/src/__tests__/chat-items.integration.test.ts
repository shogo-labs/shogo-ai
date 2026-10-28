// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins, saved items, drafts, scheduled messages, and reminders against a
 * real SQLite database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const presence = await import('../services/conversation-presence')
const items = await import('../services/chat-items')
const inbox = await import('../services/chat-inbox')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let privateId: string
let pushes: Array<{ userId: string; body: string }> = []
let events: any[] = []

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) {
    await service.listConversationsForUser(seed.workspaceId, user)
  }
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
  privateId = (await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'secret', kind: 'private' } as any)).id
  bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => events.push(envelope))
})

beforeEach(() => {
  pushes = []
  events = []
  presence._resetPresenceForTests()
  items._setReminderPushForTests(async (userId, payload) => { pushes.push({ userId, body: payload.body }) })
})

afterAll(async () => {
  items._setReminderPushForTests(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function post(conversationId: string, authorUserId: string, text: string) {
  return (await service.postMessage({ conversationId, authorType: 'user', authorUserId, text } as any)).row
}

describe('pins', () => {
  test('members pin and unpin; viewers cannot; pinned state rides on the message', async () => {
    const row = await post(generalId, seed.owner, 'release checklist')
    const pinned = await items.setPinned(row.id, seed.member, true)
    expect(pinned.pinned?.byId).toBe(seed.member)
    expect(events.some((e) => e.event.type === 'message.updated' && e.event.message.id === row.id)).toBe(true)
    expect((await items.listPins(generalId, seed.viewer)).map((m: any) => m.id)).toEqual([row.id])
    await expect(items.setPinned(row.id, seed.viewer, true)).rejects.toThrow()
    await items.setPinned(row.id, seed.member, false)
    expect(await items.listPins(generalId, seed.owner)).toEqual([])
  })
})

describe('saved', () => {
  test('saved items are personal and hidden once you lose access', async () => {
    const pub = await post(generalId, seed.owner, 'keep this')
    const secret = await post(privateId, seed.owner, 'secret plan')
    await items.setSaved(pub.id, seed.member, true)
    await items.setSaved(pub.id, seed.member, true)
    await expect(items.setSaved(secret.id, seed.member, true)).rejects.toThrow()
    await items.setSaved(secret.id, seed.owner, true)

    const mine = await items.listSaved(seed.workspaceId, seed.member)
    expect(mine.map((s: any) => s.message.id)).toEqual([pub.id])
    expect(mine[0].conversation.slug).toBe('general')
    expect(await items.listSaved(seed.workspaceId, seed.viewer)).toEqual([])

    await items.setSaved(pub.id, seed.member, false)
    expect(await items.listSaved(seed.workspaceId, seed.member)).toEqual([])
  })
})

describe('drafts', () => {
  test('one draft per conversation and thread, synced to your other devices, cleared when empty', async () => {
    const root = await post(generalId, seed.owner, 'thread root')
    await items.putDraft(generalId, seed.member, 'half-written idea')
    await items.putDraft(generalId, seed.member, 'reply draft', root.id)
    await items.putDraft(generalId, seed.member, 'half-written idea, revised')
    const drafts = await items.listDrafts(seed.workspaceId, seed.member)
    expect(drafts.map((d: any) => [d.threadRootId, d.text]).sort()).toEqual([[null, 'half-written idea, revised'], [root.id, 'reply draft']].sort())
    const synced = events.filter((e) => e.event.type === 'draft.changed')
    expect(synced.every((e) => e.audience?.length === 1 && e.audience[0] === seed.member)).toBe(true)

    await items.putDraft(generalId, seed.member, '   ')
    expect((await items.listDrafts(seed.workspaceId, seed.member)).map((d: any) => d.threadRootId)).toEqual([root.id])
    await expect(items.putDraft(privateId, seed.member, 'nope')).rejects.toThrow()
  })
})

describe('scheduled messages', () => {
  test('validates time and permissions, sends once when due, and can be edited or cancelled', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString()
    await expect(items.scheduleMessage({ conversationId: generalId, userId: seed.member, text: 'x', sendAt: new Date().toISOString() }))
      .rejects.toThrow('future')
    await expect(items.scheduleMessage({ conversationId: generalId, userId: seed.viewer, text: 'x', sendAt: soon })).rejects.toThrow()

    const a = await items.scheduleMessage({ conversationId: generalId, userId: seed.member, text: 'good morning team', sendAt: soon })
    const b = await items.scheduleMessage({ conversationId: generalId, userId: seed.member, text: 'never mind', sendAt: soon })
    await items.updateScheduled(a.id, seed.member, { text: 'good morning, team!' })
    await items.cancelScheduled(b.id, seed.member)
    await expect(items.cancelScheduled(a.id, seed.owner)).rejects.toThrow('not found')
    expect((await items.listScheduled(seed.workspaceId, seed.member)).map((s: any) => s.id)).toEqual([a.id])

    const later = new Date(Date.now() + 120_000)
    expect(await items.sendDueScheduledMessages(later)).toBe(1)
    expect(await items.sendDueScheduledMessages(later)).toBe(0)
    const sent = await db.scheduledMessage.findUnique({ where: { id: a.id } })
    expect(sent.status).toBe('sent')
    const msg = await db.conversationMessage.findUnique({ where: { id: sent.sentMessageId } })
    expect(msg).toMatchObject({ text: 'good morning, team!', authorUserId: seed.member, conversationId: generalId })
    expect((await db.scheduledMessage.findUnique({ where: { id: b.id } })).status).toBe('cancelled')
  })

  test('a message that can no longer be posted is marked failed', async () => {
    const s = await items.scheduleMessage({
      conversationId: privateId, userId: seed.owner, text: 'hi', sendAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await service.updateConversation(privateId, seed.owner, { archived: true } as any)
    await items.sendDueScheduledMessages(new Date(Date.now() + 120_000))
    const row = await db.scheduledMessage.findUnique({ where: { id: s.id } })
    expect(row.status).toBe('failed')
    expect(row.error).toContain('archived')
    await service.updateConversation(privateId, seed.owner, { archived: false } as any)
  })
})

describe('reminders', () => {
  test('/remind parses, fires once into the inbox with a push, and can be snoozed', async () => {
    await expect(items.createReminder({ workspaceId: seed.workspaceId, userId: seed.member, command: '/remind me to stretch' }))
      .rejects.toThrow('/remind me')
    const r = await items.createReminder({ workspaceId: seed.workspaceId, userId: seed.member, command: '/remind me to stretch in 5 minutes' })
    expect(r.text).toBe('stretch')

    expect(await items.fireDueReminders(new Date())).toBe(0)
    const later = new Date(Date.now() + 6 * 60_000)
    expect(await items.fireDueReminders(later)).toBe(1)
    expect(await items.fireDueReminders(later)).toBe(0)
    expect(pushes).toEqual([{ userId: seed.member, body: 'stretch' }])
    const { items: inboxItems } = await inbox.listInbox(seed.workspaceId, seed.member)
    expect(inboxItems[0]).toMatchObject({ kind: 'reminder', preview: 'stretch' })

    const snoozed = await items.updateReminder(r.id, seed.member, { remindAt: new Date(Date.now() + 3600_000).toISOString() })
    expect(snoozed.status).toBe('pending')
    await items.updateReminder(r.id, seed.member, { status: 'done' })
    expect(await items.listReminders(seed.workspaceId, seed.member)).toEqual([])
    await expect(items.updateReminder(r.id, seed.owner, { status: 'done' })).rejects.toThrow('not found')
  })

  test('"remind me about this message" checks access and defaults the text', async () => {
    const pub = await post(generalId, seed.owner, 'review the launch doc')
    const secret = await post(privateId, seed.owner, 'secret')
    const at = new Date(Date.now() + 3600_000).toISOString()
    const r = await items.createReminder({ workspaceId: seed.workspaceId, userId: seed.member, messageId: pub.id, remindAt: at })
    expect(r).toMatchObject({ text: 'review the launch doc', conversationId: generalId, messageId: pub.id })
    await expect(items.createReminder({ workspaceId: seed.workspaceId, userId: seed.member, messageId: secret.id, remindAt: at }))
      .rejects.toThrow()
  })
})

describe('inbox paging cursor', () => {
  const T = new Date('2026-05-01T12:00:00.000Z')
  const who = 'cursor-test-user'

  /** Four rows share one millisecond — a batch mention writes exactly like this. */
  const seedRows = async () => {
    await db.chatInboxItem.deleteMany({ where: { workspaceId: seed.workspaceId, userId: who } })
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      await db.chatInboxItem.create({
        data: { id, workspaceId: seed.workspaceId, userId: who, kind: 'mention', title: id, preview: id, createdAt: T },
      })
    }
    await db.chatInboxItem.create({
      data: {
        id: 'c5',
        workspaceId: seed.workspaceId,
        userId: who,
        kind: 'mention',
        title: 'c5',
        preview: 'c5',
        createdAt: new Date(T.getTime() - 1000),
      },
    })
  }

  test('a tie straddling the page boundary is not dropped', async () => {
    await seedRows()

    const first = await inbox.listInbox(seed.workspaceId, who, { limit: 2 })
    expect(first.items.map((i: any) => i.id)).toEqual(['c4', 'c3'])
    expect(first.hasMore).toBe(true)

    const last = first.items[first.items.length - 1] as any
    const second = await inbox.listInbox(seed.workspaceId, who, {
      limit: 2,
      before: last.createdAt,
      beforeId: last.id,
    })
    // c2 and c1 share c3's millisecond; without the id half both vanish.
    expect(second.items.map((i: any) => i.id)).toEqual(['c2', 'c1'])
    expect(second.hasMore).toBe(true)

    const lastSecond = second.items[second.items.length - 1] as any
    const third = await inbox.listInbox(seed.workspaceId, who, {
      limit: 2,
      before: lastSecond.createdAt,
      beforeId: lastSecond.id,
    })
    expect(third.items.map((i: any) => i.id)).toEqual(['c5'])
    expect(third.hasMore).toBe(false)
  })

  test('without the id half, the boundary millisecond is skipped entirely', async () => {
    await seedRows()

    const first = await inbox.listInbox(seed.workspaceId, who, { limit: 2 })
    const last = first.items[first.items.length - 1] as any
    const second = await inbox.listInbox(seed.workspaceId, who, { limit: 2, before: last.createdAt })

    // Pinning the old behaviour: this is the row loss the id half fixes.
    expect(second.items.map((i: any) => i.id)).toEqual(['c5'])
  })

  test('paging walks every row exactly once', async () => {
    await seedRows()

    const seen: string[] = []
    let before: string | null = null
    let beforeId: string | null = null
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await inbox.listInbox(seed.workspaceId, who, { limit: 2, before, beforeId })
      seen.push(...page.items.map((i: any) => i.id))
      if (!page.hasMore) break
      const last = page.items[page.items.length - 1] as any
      before = last.createdAt
      beforeId = last.id
    }

    expect(seen).toEqual(['c4', 'c3', 'c2', 'c1', 'c5'])
  })
})
