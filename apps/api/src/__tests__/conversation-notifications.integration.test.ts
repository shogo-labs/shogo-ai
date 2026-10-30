// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel notifications against a real SQLite database: who gets notified,
 * mute/notify-level rules, and push vs in-app delivery by presence.
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
const { userMentionToken } = await import('../services/conversation-mentions')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let pushes: Array<{ userId: string; title: string; body: string; data: any }> = []
let events: any[] = []

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
  bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => {
    if (envelope.event.type === 'notification') events.push(envelope)
  })
})

beforeEach(async () => {
  pushes = []
  events = []
  presence._resetPresenceForTests()
  notifications._setPushSenderForTests(async (userId, payload) => {
    pushes.push({ userId, title: payload.title, body: payload.body, data: payload.data })
  })
  await db.conversationMember.updateMany({ where: { conversationId: generalId }, data: { muted: false, notifyLevel: 'default' } })
})

afterAll(async () => {
  notifications._setPushSenderForTests(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('recipients', () => {
  test('plain channel messages notify nobody; mentions notify the mentioned person', async () => {
    expect(await notified(await post({ authorUserId: seed.owner, text: 'morning all' }))).toEqual([])
    const result = await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} can you look?` })
    expect(await notified(result)).toEqual([`${seed.member}:mention`])
    expect(pushes[0].title).toBe('owner in #general')
    expect(pushes[0].body).toBe('@member can you look?')
    expect(pushes[0].data.conversationId).toBe(generalId)
  })

  test('outsiders and the author are never notified', async () => {
    const result = await post({
      authorUserId: seed.owner,
      text: `${userMentionToken(seed.owner)} ${userMentionToken(seed.outsider)} note to self`,
    })
    expect(await notified(result)).toEqual([])
  })

  test('mentioning a workspace member who is not in this channel never notifies them, public or private', async () => {
    for (const kind of ['public', 'private'] as const) {
      const channel = await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: `no-${kind}-${kind}`, kind })
      const result = await service.postMessage({
        conversationId: channel.id, authorType: 'user', authorUserId: seed.owner,
        text: `${userMentionToken(seed.member)} can you look?`,
      })
      expect(await notified(result)).toEqual([])

      await service.addUserMembers(channel.id, seed.owner, [seed.member])
      const afterJoining = await service.postMessage({
        conversationId: channel.id, authorType: 'user', authorUserId: seed.owner,
        text: `${userMentionToken(seed.member)} thanks for joining`,
      })
      expect(await notified(afterJoining)).toEqual([`${seed.member}:mention`])
    }
  })

  test('muted channels still deliver direct mentions but not @channel; notify level none silences both', async () => {
    await db.conversationMember.updateMany({ where: { conversationId: generalId, userId: seed.member }, data: { muted: true } })
    expect(await notified(await post({ authorUserId: seed.owner, text: '<!channel> standup' }))).toEqual([`${seed.viewer}:broadcast`])
    expect(await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} ping` })))
      .toEqual([`${seed.member}:mention`])
    await db.conversationMember.updateMany({ where: { conversationId: generalId, userId: seed.member }, data: { notifyLevel: 'none' } })
    expect(await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} ping` }))).toEqual([])
  })

  test('@here only reaches people who are active', async () => {
    await presence.recordPresence(seed.workspaceId, seed.viewer, 'active')
    expect(await notified(await post({ authorUserId: seed.owner, text: '<!here> anyone around?' }))).toEqual([`${seed.viewer}:broadcast`])
  })

  test('thread replies notify the root author and earlier repliers', async () => {
    const root = await post({ authorUserId: seed.owner, text: 'proposal' })
    await post({ authorUserId: seed.viewer, text: 'looks good', threadRootId: root.row.id })
    const reply = await post({ authorUserId: seed.member, text: 'one question', threadRootId: root.row.id })
    expect(await notified(reply)).toEqual([`${seed.owner}:thread`, `${seed.viewer}:thread`])
  })

  test('someone mentioned in the thread root follows later replies without replying', async () => {
    const root = await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} quick question` })
    expect(await notified(root)).toEqual([`${seed.member}:mention`])
    const reply = await post({ authorUserId: seed.owner, text: 'how are you', threadRootId: root.row.id })
    expect(await notified(reply)).toEqual([`${seed.member}:thread`])
  })

  test('someone mentioned in an earlier reply follows the rest of the thread', async () => {
    const root = await post({ authorUserId: seed.owner, text: 'proposal' })
    await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.viewer)} thoughts?`, threadRootId: root.row.id })
    const reply = await post({ authorUserId: seed.owner, text: 'any update', threadRootId: root.row.id })
    expect(await notified(reply)).toEqual([`${seed.viewer}:thread`])
  })

  test('mentioned followers who muted the channel or left it hear nothing about plain replies', async () => {
    const root = await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} ${userMentionToken(seed.outsider)} look` })
    await db.conversationMember.updateMany({ where: { conversationId: generalId, userId: seed.member }, data: { muted: true } })
    const reply = await post({ authorUserId: seed.owner, text: 'following up', threadRootId: root.row.id })
    expect(await notified(reply)).toEqual([])
  })

  test('every DM message notifies the other participants', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const result = await service.postMessage({ conversationId: dm.id, authorType: 'user', authorUserId: seed.owner, text: 'hey' })
    expect(await notified(result)).toEqual([`${seed.member}:dm`])
    expect(pushes[0].title).toBe('owner')
  })

  test('a group DM banner names the others in the group, so it does not read as a 1:1 DM', async () => {
    const group = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member, seed.viewer])
    expect(group.kind).toBe('group_dm')
    const result = await service.postMessage({ conversationId: group.id, authorType: 'user', authorUserId: seed.owner, text: 'lunch?' })
    expect(await notified(result)).toEqual([`${seed.member}:dm`, `${seed.viewer}:dm`].sort())
    // Everyone but the sender and the person alerted, like the sidebar lists the chat.
    const titleFor = (userId: string) => pushes.find((p) => p.userId === userId)!.title
    expect(titleFor(seed.member)).toBe('owner in group with viewer')
    expect(titleFor(seed.viewer)).toBe('owner in group with member')
    expect(events.map((e) => e.event.title).sort()).toEqual(['owner in group with member', 'owner in group with viewer'])
  })

  test('a thread reply in a group DM says it replied', async () => {
    const group = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member, seed.viewer])
    const root = await service.postMessage({ conversationId: group.id, authorType: 'user', authorUserId: seed.owner, text: 'root' })
    pushes = []
    const reply = await service.postMessage({ conversationId: group.id, authorType: 'user', authorUserId: seed.owner, text: 'more', threadRootId: root.row.id })
    await notified(reply)
    expect(pushes.find((p) => p.userId === seed.member)!.title).toBe('owner replied in group with viewer')
  })

  test('running agent placeholders and #activity posts notify nobody', async () => {
    const placeholder = await post({ authorType: 'agent', authorAgentRef: { projectId: null, name: 'Shogo' }, text: '', agentStatus: 'running' })
    expect(await notified(placeholder)).toEqual([])
  })
})

describe('delivery', () => {
  test('active users get an in-app alert instead of a push', async () => {
    await presence.recordPresence(seed.workspaceId, seed.member, 'active')
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} ship it` }))
    expect(pushes).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect(events[0].audience).toEqual([seed.member])
    expect(events[0].event.reason).toBe('mention')
  })

  test('users who are not active get both a push and a socket alert for any open client', async () => {
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} when you're back` }))
    expect(pushes.filter((p) => p.userId === seed.member)).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(events[0].audience).toEqual([seed.member])
  })

  test('rapid messages in one conversation coalesce into a single push', async () => {
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.viewer)} one` }))
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.viewer)} two` }))
    expect(pushes.filter((p) => p.userId === seed.viewer)).toHaveLength(1)
  })
})

describe('activity inbox and phone push timing', () => {
  const settingsSvc = () => import('../services/chat-settings')
  const inboxSvc = () => import('../services/chat-inbox')
  const queue = () => import('../services/push-delay-queue')

  beforeEach(async () => {
    const s = await settingsSvc()
    await s.updateChatSettings(seed.workspaceId, seed.member, {
      dmInActivity: false,
      threadRepliesInBadge: true,
      mobilePushDelay: 'inactive',
      messageSound: 'default',
    })
  })

  test('direct messages reach the Activity inbox only when the person asked for that', async () => {
    const inbox = await inboxSvc()
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const dmItems = async () => (await inbox.listInbox(seed.workspaceId, seed.member)).items.filter((i) => i.kind === 'dm')
    const dmSend = (text: string) => service.postMessage({ conversationId: dm.id, authorType: 'user', authorUserId: seed.owner, text })

    await notifications.notifyForMessage(await dmSend('off by default'))
    expect(await dmItems()).toHaveLength(0)

    const s = await settingsSvc()
    await s.updateChatSettings(seed.workspaceId, seed.member, { dmInActivity: true })
    await notifications.notifyForMessage(await dmSend('now in activity'))
    const items = await dmItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'dm', conversationId: dm.id, preview: 'now in activity' })
    await s.updateChatSettings(seed.workspaceId, seed.member, { dmInActivity: false })
  })

  test('a reply in a DM thread reaches Activity even with dmInActivity off', async () => {
    const inbox = await inboxSvc()
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const send = (authorUserId: string, text: string, threadRootId?: string) =>
      service.postMessage({ conversationId: dm.id, authorType: 'user', authorUserId, text, ...(threadRootId ? { threadRootId } : {}) } as any)
    const items = async () => (await inbox.listInbox(seed.workspaceId, seed.owner)).items.filter((i) => i.conversationId === dm.id)

    const root = await send(seed.owner, 'can you review this?')
    await notifications.notifyForMessage(root)
    const reply = await send(seed.member, 'looks good', root.row.id)
    expect(await notified(reply)).toEqual([`${seed.owner}:thread`])

    expect(await items()).toEqual([expect.objectContaining({ kind: 'thread', messageId: reply.row.id, preview: 'looks good' })])
    expect((await inbox.listInbox(seed.workspaceId, seed.owner)).unreadThreads).toBeGreaterThan(0)

    // A plain top-level DM still follows the setting.
    const plain = await send(seed.member, 'unrelated')
    expect(await notified(plain)).toEqual([`${seed.owner}:dm`])
    expect(await items()).toHaveLength(1)
  })

  test('threading under your own message in a 1:1 DM reaches the other person\'s Activity', async () => {
    const inbox = await inboxSvc()
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const send = (text: string, threadRootId?: string) =>
      service.postMessage({ conversationId: dm.id, authorType: 'user', authorUserId: seed.owner, text, ...(threadRootId ? { threadRootId } : {}) } as any)
    const memberItems = async () => (await inbox.listInbox(seed.workspaceId, seed.member)).items.filter((i) => i.conversationId === dm.id && i.kind === 'thread')

    const root = await send('hello')
    await notifications.notifyForMessage(root)
    expect(await memberItems()).toHaveLength(0)

    // The member has not replied, so they are not a follower by authorship.
    const reply = await send('how are you doing', root.row.id)
    expect(await notified(reply)).toEqual([`${seed.member}:thread`])
    expect(await memberItems()).toEqual([expect.objectContaining({ kind: 'thread', messageId: reply.row.id })])
  })

  test('a group DM thread only reaches Activity for people following it', async () => {
    const inbox = await inboxSvc()
    const group = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member, seed.viewer])
    const send = (authorUserId: string, text: string, threadRootId?: string) =>
      service.postMessage({ conversationId: group.id, authorType: 'user', authorUserId, text, ...(threadRootId ? { threadRootId } : {}) } as any)
    const root = await send(seed.owner, 'plan?')
    await notifications.notifyForMessage(root)
    await send(seed.member, 'sure', root.row.id)
    const reply = await send(seed.owner, 'great', root.row.id)
    expect(await notified(reply)).toEqual([`${seed.member}:thread`, `${seed.viewer}:dm`])
    const viewerItems = (await inbox.listInbox(seed.workspaceId, seed.viewer)).items.filter((i) => i.conversationId === group.id)
    expect(viewerItems).toHaveLength(0)
  })

  test('mobilePushDelay "immediate" pushes even while the person is active', async () => {
    const s = await settingsSvc()
    await presence.recordPresence(seed.workspaceId, seed.member, 'active')
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} now` }))
    expect(pushes).toHaveLength(0)

    await s.updateChatSettings(seed.workspaceId, seed.member, { mobilePushDelay: 'immediate' })
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} again` }))
    expect(pushes.map((p) => p.userId)).toEqual([seed.member])
  })

  test('a delayed push waits, and reading the conversation first cancels it', async () => {
    const s = await settingsSvc()
    const q = await queue()
    await s.updateChatSettings(seed.workspaceId, seed.member, { mobilePushDelay: 'inactive_5m' })
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} look later` }))
    expect(pushes).toHaveLength(0)
    expect(q.delayedPushCount()).toBe(1)

    await service.markRead(generalId, seed.member)
    expect(q.delayedPushCount()).toBe(0)
    expect(pushes).toHaveLength(0)
  })

  test('the delayed push is dropped if the person came back before it fired', async () => {
    const s = await settingsSvc()
    const q = await queue()
    await s.updateChatSettings(seed.workspaceId, seed.member, { mobilePushDelay: 'inactive_5m' })
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} ping` }))
    expect(q.delayedPushCount()).toBe(1)
    await presence.recordPresence(seed.workspaceId, seed.member, 'active')
    await q.flushDelayedPushesForTests()
    expect(pushes).toHaveLength(0)
    expect(q.delayedPushCount()).toBe(0)
  })

  test('the delayed push is sent when the person is still away at the end of the wait', async () => {
    const s = await settingsSvc()
    const q = await queue()
    await s.updateChatSettings(seed.workspaceId, seed.member, { mobilePushDelay: 'inactive_10m' })
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.member)} still there?` }))
    await q.flushDelayedPushesForTests()
    expect(pushes.map((p) => p.userId)).toEqual([seed.member])
    expect(pushes[0].body).toBe('@member still there?')
  })
})
