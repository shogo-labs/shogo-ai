// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat preferences (status, DND, quiet hours, default level, keywords), the
 * activity inbox, and the daily email digest against a real SQLite database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const presence = await import('../services/conversation-presence')
const notifications = await import('../services/conversation-notifications')
const settings = await import('../services/chat-settings')
const inbox = await import('../services/chat-inbox')
const digest = await import('../services/chat-digest')
const { userMentionToken } = await import('../services/conversation-mentions')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let pushes: Array<{ userId: string }> = []

async function post(input: Record<string, unknown>) {
  return service.postMessage({ conversationId: generalId, authorType: 'user', ...input } as any)
}

async function notified(result: any) {
  return (await notifications.notifyForMessage(result)).map((r) => `${r.userId}:${r.reason}`).sort()
}

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) {
    await service.listConversationsForUser(seed.workspaceId, user)
  }
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
  notifications.registerConversationNotifications()
})

beforeEach(async () => {
  pushes = []
  presence._resetPresenceForTests()
  notifications._setPushSenderForTests(async (userId) => { pushes.push({ userId }) })
  await db.conversationMember.updateMany({ where: { conversationId: generalId }, data: { muted: false, notifyLevel: 'default' } })
  await db.chatUserSettings.deleteMany({})
  await db.chatInboxItem.deleteMany({})
})

afterAll(async () => {
  notifications._setPushSenderForTests(null)
  digest._setDigestSenderForTests(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('settings', () => {
  test('defaults, validation, and status expiry', async () => {
    expect(await settings.getChatSettings(seed.workspaceId, seed.member)).toMatchObject({
      notifyDefault: 'mentions', keywords: [], emailDigest: 'off', statusText: null,
    })
    await expect(settings.updateChatSettings(seed.workspaceId, seed.member, { quietHours: '25:00-08:00' }))
      .rejects.toThrow('quietHours')
    await expect(settings.updateChatSettings(seed.workspaceId, seed.member, { timezone: 'Mars/Olympus' }))
      .rejects.toThrow('timezone')

    const saved = await settings.updateChatSettings(seed.workspaceId, seed.member, {
      statusEmoji: '🌴', statusText: 'On vacation', keywords: ['Deploy', 'deploy', 'incident'],
    })
    expect(saved.keywords).toEqual(['deploy', 'incident'])
    expect((await settings.listStatuses(seed.workspaceId))[seed.member]).toMatchObject({ emoji: '🌴', text: 'On vacation', dnd: false })

    await settings.updateChatSettings(seed.workspaceId, seed.member, { statusExpiresAt: new Date(Date.now() - 1000).toISOString() })
    expect((await settings.listStatuses(seed.workspaceId))[seed.member]).toBeUndefined()
  })

  test('quiet hours handle windows that cross midnight', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h, 30))
    expect(settings.inQuietHours('22:00-08:00', 'UTC', at(23))).toBe(true)
    expect(settings.inQuietHours('22:00-08:00', 'UTC', at(3))).toBe(true)
    expect(settings.inQuietHours('22:00-08:00', 'UTC', at(12))).toBe(false)
    expect(settings.inQuietHours('09:00-17:00', 'UTC', at(12))).toBe(true)
    // 12:30 UTC is 07:30 in New York in January.
    expect(settings.inQuietHours('22:00-08:00', 'America/New_York', at(12))).toBe(true)
  })
})

describe('notification preferences', () => {
  test('a workspace default of "all" notifies for every message; channel overrides win', async () => {
    await settings.updateChatSettings(seed.workspaceId, seed.member, { notifyDefault: 'all' })
    expect(await notified(await post({ authorUserId: seed.owner, text: 'plain update' }))).toEqual([`${seed.member}:message`])

    const m = await db.conversationMember.findFirst({ where: { conversationId: generalId, userId: seed.member } })
    await db.conversationMember.update({ where: { id: m.id }, data: { notifyLevel: 'mentions' } })
    expect(await notified(await post({ authorUserId: seed.owner, text: 'another update' }))).toEqual([])
  })

  test('keywords notify like a mention, on word boundaries, and respect mute', async () => {
    await settings.updateChatSettings(seed.workspaceId, seed.viewer, { keywords: ['deploy'] })
    expect(await notified(await post({ authorUserId: seed.owner, text: 'Deploy is done' }))).toEqual([`${seed.viewer}:keyword`])
    expect(await notified(await post({ authorUserId: seed.owner, text: 'redeployed it' }))).toEqual([])

    await db.conversationMember.updateMany({ where: { conversationId: generalId, userId: seed.viewer }, data: { muted: true } })
    expect(await notified(await post({ authorUserId: seed.owner, text: 'deploy again' }))).toEqual([])
  })

  test('Do Not Disturb holds alerts but still records the inbox item', async () => {
    await settings.updateChatSettings(seed.workspaceId, seed.member, { dndUntil: new Date(Date.now() + 3600_000).toISOString() })
    const recipients = await notifications.notifyForMessage(
      await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} urgent` }),
    )
    expect(recipients).toEqual([{ userId: seed.member, reason: 'mention', silenced: true }])
    expect(pushes).toHaveLength(0)
    const { items, unread } = await inbox.listInbox(seed.workspaceId, seed.member)
    expect(unread).toBe(1)
    expect(items[0]).toMatchObject({ kind: 'mention', conversationId: generalId, title: 'owner in #general' })
  })
})

describe('inbox', () => {
  test('mentions land in the inbox and clear when the channel is read', async () => {
    await notifications.notifyForMessage(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} look` }))
    expect((await inbox.listInbox(seed.workspaceId, seed.member)).unread).toBe(1)
    await service.markRead(generalId, seed.member)
    expect((await inbox.listInbox(seed.workspaceId, seed.member)).unread).toBe(0)
  })

  test('plain DMs stay out of the inbox; mark read by id and mark all', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    await notifications.notifyForMessage(
      await service.postMessage({ conversationId: dm.id, authorType: 'user', authorUserId: seed.owner, text: 'hey' } as any),
    )
    expect((await inbox.listInbox(seed.workspaceId, seed.member)).unread).toBe(0)

    for (const text of ['one', 'two']) {
      await notifications.notifyForMessage(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} ${text}` }))
    }
    const { items } = await inbox.listInbox(seed.workspaceId, seed.member)
    expect(await inbox.markInboxRead(seed.workspaceId, seed.member, { ids: [items[0].id] })).toBe(1)
    expect((await inbox.listInbox(seed.workspaceId, seed.member, { unreadOnly: true })).items).toHaveLength(1)
    expect(await inbox.markInboxRead(seed.workspaceId, seed.owner, { all: true })).toBe(0)
    expect(await inbox.markInboxRead(seed.workspaceId, seed.member, { all: true })).toBe(1)
  })

  test('reactions to your message create one inbox item per reactor', async () => {
    const { row } = await post({ authorUserId: seed.member, text: 'shipped' })
    await service.setReaction(row.id, seed.owner, '🎉', true)
    await service.setReaction(row.id, seed.owner, '🎉', false)
    await service.setReaction(row.id, seed.owner, '🎉', true)
    await service.setReaction(row.id, seed.member, '👍', true)
    await Bun.sleep(30)
    const { items } = await inbox.listInbox(seed.workspaceId, seed.member)
    expect(items.map((i: any) => i.kind)).toEqual(['reaction'])
    expect(items[0].title).toBe('owner reacted 🎉 to your message')
  })
})

describe('email digest', () => {
  test('due only at 9am local time, at most once a day', () => {
    const nine = new Date(Date.UTC(2026, 0, 1, 14, 5))
    const row = { emailDigest: 'daily', timezone: 'America/New_York', lastDigestAt: null }
    expect(digest.isDigestDue(row, nine)).toBe(true)
    expect(digest.isDigestDue({ ...row, timezone: 'UTC' }, nine)).toBe(false)
    expect(digest.isDigestDue({ ...row, lastDigestAt: new Date(nine.getTime() - 3600_000) }, nine)).toBe(false)
    expect(digest.isDigestDue({ ...row, emailDigest: 'off' }, nine)).toBe(false)
  })

  test('sends unread inbox items and DMs, then records the send', async () => {
    const sent: any[] = []
    digest._setDigestSenderForTests(async (params) => { sent.push(params); return { success: true } })
    await settings.updateChatSettings(seed.workspaceId, seed.member, { emailDigest: 'daily', timezone: 'UTC' })
    await settings.updateChatSettings(seed.workspaceId, seed.viewer, { emailDigest: 'daily', timezone: 'UTC' })
    await notifications.notifyForMessage(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} review pls` }))

    const nineUtc = new Date()
    nineUtc.setUTCHours(9, 10, 0, 0)
    expect(await digest.runDigestPass(nineUtc)).toBe(1)
    expect(sent[0].summary).toContain('owner in #general: @member review pls')
    expect(sent[0].countLabel).toMatch(/unread update/)
    expect(await digest.runDigestPass(nineUtc)).toBe(0)
    const rows = await db.chatUserSettings.findMany({ where: { workspaceId: seed.workspaceId, emailDigest: 'daily' } })
    expect(rows.every((r: any) => r.lastDigestAt)).toBe(true)
  })
})
