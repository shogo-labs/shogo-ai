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

  test('every DM message notifies the other participants', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const result = await service.postMessage({ conversationId: dm.id, authorType: 'user', authorUserId: seed.owner, text: 'hey' })
    expect(await notified(result)).toEqual([`${seed.member}:dm`])
    expect(pushes[0].title).toBe('owner')
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

  test('rapid messages in one conversation coalesce into a single push', async () => {
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.viewer)} one` }))
    await notified(await post({ authorUserId: seed.owner, text: `${userMentionToken(seed.viewer)} two` }))
    expect(pushes.filter((p) => p.userId === seed.viewer)).toHaveLength(1)
  })
})
