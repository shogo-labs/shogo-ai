// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddles: who may join, the live roster, one live huddle per conversation,
 * the start/end system message, bus events, and LiveKit webhooks. LiveKit's
 * room listing is faked; tokens and webhook signatures are real.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'crypto'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

process.env.LIVEKIT_URL = 'wss://huddles.test'
process.env.LIVEKIT_API_KEY = 'test-key'
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256'

const sdk = await import('livekit-server-sdk')
/** What the fake LiveKit says is connected, by room. Rooms not listed don't exist. */
const liveRooms = new Map<string, string[]>()
const deletedRooms: string[] = []
mock.module('livekit-server-sdk', () => ({
  ...sdk,
  RoomServiceClient: class {
    async listParticipants(room: string) {
      return (liveRooms.get(room) ?? []).map((identity) => ({ identity }))
    }
    async deleteRoom(room: string) {
      deletedRooms.push(room)
      liveRooms.delete(room)
    }
  },
}))

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const huddles = await import('../services/huddle.service')

const db = prisma as any
let seed: SeededWorkspace
let events: any[] = []
let pushes: Array<{ userId: string; payload: any }> = []

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => events.push(envelope))
  huddles._setHuddlePushSenderForTests(async (userId, payload) => {
    pushes.push({ userId, payload })
  })
})

beforeEach(() => {
  events = []
  pushes = []
  liveRooms.clear()
  deletedRooms.length = 0
  huddles._resetHuddlesForTests()
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function channel(name: string, members: string[] = [seed.member]) {
  return service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name, kind: 'public', topic: null, memberUserIds: members })
}

function decodeJwt(token: string): any {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
}

async function signedWebhook(body: object): Promise<{ rawBody: string; authorization: string }> {
  const rawBody = JSON.stringify(body)
  const token = new sdk.AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
  token.sha256 = createHash('sha256').update(rawBody).digest('base64')
  return { rawBody, authorization: await token.toJwt() }
}

describe('joining and leaving', () => {
  test('the first join starts a huddle, posts a system message, and returns a room token', async () => {
    const conv = await channel(`huddle-start-${crypto.randomUUID().slice(0, 6)}`)
    const joined = await huddles.joinHuddle(conv.id, seed.owner)

    expect(joined.url).toBe('wss://huddles.test')
    expect(joined.huddle.participants.map((p) => p.userId)).toEqual([seed.owner])
    const row = await db.huddle.findUnique({ where: { id: joined.huddle.id } })
    expect(row.activeKey).toBe(conv.id)
    expect(row.roomName).toBe(huddles.huddleRoomName(seed.workspaceId, row.id))

    const claims = decodeJwt(joined.token)
    expect(claims.sub).toBe(seed.owner)
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: row.roomName,
      canPublishData: false,
      canPublishSources: ['microphone', 'camera', 'screen_share', 'screen_share_audio'],
    })

    const message = await db.conversationMessage.findUnique({ where: { id: row.messageId } })
    expect(message.authorType).toBe('system')
    expect(message.text).toBe(`<@u:${seed.owner}> started a huddle`)

    const updates = events.filter((e) => e.event.type === 'huddle.updated' && e.event.conversationId === conv.id)
    expect(updates.at(-1).event.huddle.id).toBe(row.id)
  })

  test('a second person joins the same huddle, and the last one out ends it', async () => {
    const conv = await channel(`huddle-pair-${crypto.randomUUID().slice(0, 6)}`)
    const first = await huddles.joinHuddle(conv.id, seed.owner)
    const second = await huddles.joinHuddle(conv.id, seed.member)
    expect(second.huddle.id).toBe(first.huddle.id)
    expect(second.huddle.participants.map((p) => p.userId).sort()).toEqual([seed.owner, seed.member].sort())

    const afterOwner = await huddles.leaveHuddle(conv.id, seed.owner)
    expect(afterOwner?.participants.map((p) => p.userId)).toEqual([seed.member])

    expect(await huddles.leaveHuddle(conv.id, seed.member)).toBeNull()
    const row = await db.huddle.findUnique({ where: { id: first.huddle.id } })
    expect(row.endedAt).not.toBeNull()
    expect(row.activeKey).toBeNull()
    expect(deletedRooms).toContain(row.roomName)
    expect(await huddles.getHuddle(conv.id, seed.owner)).toBeNull()

    const message = await db.conversationMessage.findUnique({ where: { id: row.messageId } })
    expect(message.text).toContain('lasted')
    expect(message.blocks.huddle).toMatchObject({ status: 'ended', participantIds: expect.arrayContaining([seed.owner, seed.member]) })
    expect(events.some((e) => e.event.type === 'huddle.updated' && e.event.conversationId === conv.id && e.event.huddle === null)).toBe(true)
  })

  test('joining twice keeps one roster entry, and a new huddle starts after one ends', async () => {
    const conv = await channel(`huddle-again-${crypto.randomUUID().slice(0, 6)}`)
    const first = await huddles.joinHuddle(conv.id, seed.owner)
    const again = await huddles.joinHuddle(conv.id, seed.owner)
    expect(again.huddle.participants).toHaveLength(1)

    await huddles.leaveHuddle(conv.id, seed.owner)
    const next = await huddles.joinHuddle(conv.id, seed.owner)
    expect(next.huddle.id).not.toBe(first.huddle.id)
  })

  test('concurrent first joins share one huddle', async () => {
    const conv = await channel(`huddle-race-${crypto.randomUUID().slice(0, 6)}`)
    const [a, b] = await Promise.all([huddles.joinHuddle(conv.id, seed.owner), huddles.joinHuddle(conv.id, seed.member)])
    expect(a.huddle.id).toBe(b.huddle.id)
    expect(await db.huddle.count({ where: { conversationId: conv.id } })).toBe(1)
  })
})

describe('access', () => {
  test('people outside the workspace cannot see or join', async () => {
    const conv = await channel(`huddle-private-${crypto.randomUUID().slice(0, 6)}`)
    await expect(huddles.joinHuddle(conv.id, seed.outsider)).rejects.toMatchObject({ status: 404 })
    await expect(huddles.getHuddle(conv.id, seed.outsider)).rejects.toMatchObject({ status: 404 })
    await expect(huddles.leaveHuddle(conv.id, seed.outsider)).rejects.toMatchObject({ status: 404 })
  })

  test('people who cannot post (viewers) cannot join', async () => {
    const conv = await channel(`huddle-viewer-${crypto.randomUUID().slice(0, 6)}`, [seed.member, seed.viewer])
    await expect(huddles.joinHuddle(conv.id, seed.viewer)).rejects.toMatchObject({ status: 403 })
  })

  test('DMs work, but a DM with no other person does not', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const joined = await huddles.joinHuddle(dm.id, seed.owner)
    expect(joined.huddle.conversationId).toBe(dm.id)
    const peerEvents = events.filter((e) => e.event.type === 'huddle.updated' && e.event.conversationId === dm.id)
    expect(peerEvents.at(-1).audience?.sort()).toEqual([seed.owner, seed.member].sort())
    await huddles.leaveHuddle(dm.id, seed.owner)

    const agentDm = await service.openAgentConversation(seed.workspaceId, seed.owner, { projectId: seed.projectId })
    await expect(huddles.joinHuddle(agentDm.id, seed.owner)).rejects.toMatchObject({ code: 'huddle_unavailable' })
  })

  test('the workspace list only shows huddles the person can see', async () => {
    const pub = await channel(`huddle-list-${crypto.randomUUID().slice(0, 6)}`)
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    await huddles.joinHuddle(pub.id, seed.owner)
    await huddles.joinHuddle(dm.id, seed.owner)

    const forViewer = await huddles.listActiveHuddles(seed.workspaceId, seed.viewer)
    expect(forViewer.some((h) => h.conversationId === pub.id)).toBe(true)
    expect(forViewer.some((h) => h.conversationId === dm.id)).toBe(false)
    const forMember = await huddles.listActiveHuddles(seed.workspaceId, seed.member)
    expect(forMember.some((h) => h.conversationId === dm.id)).toBe(true)

    await huddles.leaveHuddle(pub.id, seed.owner)
    await huddles.leaveHuddle(dm.id, seed.owner)
  })
})

describe('ringing in DMs', () => {
  async function freshDm() {
    await db.conversation.deleteMany({ where: { workspaceId: seed.workspaceId, kind: 'dm' } })
    return service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
  }

  test('starting a huddle in a DM rings the other person and pushes when they are away', async () => {
    const dm = await freshDm()
    const joined = await huddles.joinHuddle(dm.id, seed.owner)

    const ring = events.find((e) => e.event.type === 'huddle.ring' && e.event.conversationId === dm.id)
    expect(ring.audience).toEqual([seed.member])
    expect(ring.event).toMatchObject({ huddleId: joined.huddle.id, conversationKind: 'dm', from: { userId: seed.owner } })
    expect(pushes).toEqual([
      expect.objectContaining({
        userId: seed.member,
        payload: expect.objectContaining({ type: 'huddle-ring', body: 'is calling you', data: expect.objectContaining({ conversationId: dm.id }) }),
      }),
    ])

    events = []
    await huddles.joinHuddle(dm.id, seed.member)
    expect(events.some((e) => e.event.type === 'huddle.ring')).toBe(false)
    await huddles.leaveHuddle(dm.id, seed.member)
    await huddles.leaveHuddle(dm.id, seed.owner)
  })

  test('channels, muted DMs, and Do Not Disturb do not ring', async () => {
    await huddles.joinHuddle((await channel(`huddle-noring-${crypto.randomUUID().slice(0, 6)}`)).id, seed.owner)
    expect(events.some((e) => e.event.type === 'huddle.ring')).toBe(false)

    const dm = await freshDm()
    await db.conversationMember.updateMany({ where: { conversationId: dm.id, userId: seed.member }, data: { muted: true } })
    await huddles.joinHuddle(dm.id, seed.owner)
    expect(events.some((e) => e.event.type === 'huddle.ring')).toBe(false)
    await huddles.leaveHuddle(dm.id, seed.owner)

    await db.conversationMember.updateMany({ where: { conversationId: dm.id, userId: seed.member }, data: { muted: false } })
    await db.chatUserSettings.create({ data: { workspaceId: seed.workspaceId, userId: seed.member, dndUntil: new Date(Date.now() + 3_600_000) } })
    try {
      await huddles.joinHuddle(dm.id, seed.owner)
      expect(events.some((e) => e.event.type === 'huddle.ring')).toBe(false)
      expect(pushes).toHaveLength(0)
      await huddles.leaveHuddle(dm.id, seed.owner)
    } finally {
      await db.chatUserSettings.deleteMany({ where: { workspaceId: seed.workspaceId, userId: seed.member } })
    }
  })

  test('declining a 1:1 call tells the caller and ends it as missed', async () => {
    const dm = await freshDm()
    const joined = await huddles.joinHuddle(dm.id, seed.owner)
    expect(await huddles.declineHuddle(dm.id, seed.member)).toBeNull()

    const declined = events.find((e) => e.event.type === 'huddle.declined' && e.event.conversationId === dm.id)
    expect(declined.event).toMatchObject({ huddleId: joined.huddle.id, userId: seed.member })
    expect(declined.audience.sort()).toEqual([seed.owner, seed.member].sort())

    const row = await db.huddle.findUnique({ where: { id: joined.huddle.id } })
    expect(row.endedAt).not.toBeNull()
    expect(deletedRooms).toContain(row.roomName)
    const message = await db.conversationMessage.findUnique({ where: { id: row.messageId } })
    expect(message.text).toBe(`Missed huddle from <@u:${seed.owner}>`)
    expect(message.blocks.huddle.status).toBe('missed')
  })

  test('declining after joining, or with nothing live, changes nothing', async () => {
    const dm = await freshDm()
    expect(await huddles.declineHuddle(dm.id, seed.member)).toBeNull()
    await huddles.joinHuddle(dm.id, seed.owner)
    await huddles.joinHuddle(dm.id, seed.member)
    const view = await huddles.declineHuddle(dm.id, seed.member)
    expect(view?.participants).toHaveLength(2)
    expect(events.some((e) => e.event.type === 'huddle.declined')).toBe(false)
    await huddles.leaveHuddle(dm.id, seed.member)
    await huddles.leaveHuddle(dm.id, seed.owner)
  })

  test('the workspace list marks a fresh DM huddle as ringing for the people not in it yet', async () => {
    const dm = await freshDm()
    const joined = await huddles.joinHuddle(dm.id, seed.owner)
    const forMember = (await huddles.listActiveHuddles(seed.workspaceId, seed.member)).find((h) => h.id === joined.huddle.id)
    expect(forMember).toMatchObject({ conversationKind: 'dm', ringing: true })
    const forCaller = (await huddles.listActiveHuddles(seed.workspaceId, seed.owner)).find((h) => h.id === joined.huddle.id)
    expect(forCaller?.ringing).toBe(false)

    await db.huddle.update({ where: { id: joined.huddle.id }, data: { startedAt: new Date(Date.now() - 60_000) } })
    const later = (await huddles.listActiveHuddles(seed.workspaceId, seed.member)).find((h) => h.id === joined.huddle.id)
    expect(later?.ringing).toBe(false)
    await huddles.leaveHuddle(dm.id, seed.owner)
  })

  test('outsiders cannot decline', async () => {
    const dm = await freshDm()
    await expect(huddles.declineHuddle(dm.id, seed.outsider)).rejects.toMatchObject({ status: 404 })
  })
})

describe('reconciling with LiveKit', () => {
  test('people LiveKit no longer has are dropped once past the connect grace period', async () => {
    const conv = await channel(`huddle-stale-${crypto.randomUUID().slice(0, 6)}`)
    const joined = await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.joinHuddle(conv.id, seed.member)
    const row = await db.huddle.findUnique({ where: { id: joined.huddle.id } })
    await db.huddleParticipant.updateMany({ where: { huddleId: row.id, userId: seed.owner }, data: { joinedAt: new Date(Date.now() - 5 * 60_000) } })
    liveRooms.set(row.roomName, [seed.member])

    huddles._resetHuddlesForTests()
    const view = await huddles.getHuddle(conv.id, seed.member)
    expect(view?.participants.map((p) => p.userId)).toEqual([seed.member])

    await db.huddleParticipant.updateMany({ where: { huddleId: row.id }, data: { joinedAt: new Date(Date.now() - 5 * 60_000) } })
    liveRooms.delete(row.roomName)
    huddles._resetHuddlesForTests()
    expect(await huddles.getHuddle(conv.id, seed.member)).toBeNull()
  })
})

describe('LiveKit webhooks', () => {
  test('room names carry the workspace id', () => {
    expect(huddles.workspaceIdFromRoomName(huddles.huddleRoomName('ws-1', 'h-1'))).toBe('ws-1')
    expect(huddles.workspaceIdFromRoomName('something-else')).toBeNull()
  })

  test('a bad signature is rejected', async () => {
    const result = await huddles.handleLiveKitWebhook({ rawBody: '{"event":"room_finished"}', authorization: 'nope' })
    expect(result.status).toBe(401)
  })

  test('participant_left drops the person and room_finished ends the huddle', async () => {
    const conv = await channel(`huddle-hook-${crypto.randomUUID().slice(0, 6)}`)
    const joined = await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.joinHuddle(conv.id, seed.member)
    const row = await db.huddle.findUnique({ where: { id: joined.huddle.id } })

    liveRooms.set(row.roomName, [seed.owner])
    const left = await huddles.handleLiveKitWebhook(
      await signedWebhook({ event: 'participant_left', room: { name: row.roomName }, participant: { identity: seed.member } }),
    )
    expect(left.status).toBe(200)
    expect((await huddles.getHuddle(conv.id, seed.owner))?.participants.map((p) => p.userId)).toEqual([seed.owner])

    const finished = await huddles.handleLiveKitWebhook(await signedWebhook({ event: 'room_finished', room: { name: row.roomName } }))
    expect(finished.status).toBe(200)
    expect((await db.huddle.findUnique({ where: { id: row.id } })).endedAt).not.toBeNull()
  })

  test('a leave for someone still connected (a second device took over) is ignored', async () => {
    const conv = await channel(`huddle-dup-${crypto.randomUUID().slice(0, 6)}`)
    const joined = await huddles.joinHuddle(conv.id, seed.owner)
    const row = await db.huddle.findUnique({ where: { id: joined.huddle.id } })
    liveRooms.set(row.roomName, [seed.owner])
    await huddles.handleLiveKitWebhook(
      await signedWebhook({ event: 'participant_left', room: { name: row.roomName }, participant: { identity: seed.owner } }),
    )
    expect((await db.huddle.findUnique({ where: { id: row.id } })).endedAt).toBeNull()
    await huddles.leaveHuddle(conv.id, seed.owner)
  })
})
