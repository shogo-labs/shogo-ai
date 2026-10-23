// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddles with more than the people in the conversation: invitations, access
 * for invited non-members, the participant cap, host moderation, the share
 * link with knock-to-join (members and guests), and polls and Q&A in the
 * huddle thread. LiveKit's server API is faked; tokens are real.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

process.env.LIVEKIT_URL = 'wss://huddles.test'
process.env.LIVEKIT_API_KEY = 'test-key'
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256'

const sdk = await import('livekit-server-sdk')
const liveRooms = new Map<string, string[]>()
const mutedTracks: Array<{ room: string; identity: string; sid: string }> = []
const removedFromRoom: Array<{ room: string; identity: string }> = []
mock.module('livekit-server-sdk', () => ({
  ...sdk,
  RoomServiceClient: class {
    async listParticipants(room: string) {
      return (liveRooms.get(room) ?? []).map((identity) => ({ identity }))
    }
    async deleteRoom(room: string) {
      liveRooms.delete(room)
    }
    async getParticipant(_room: string, identity: string) {
      return { identity, tracks: [{ sid: `TR_${identity}`, source: sdk.TrackSource.MICROPHONE, muted: false }] }
    }
    async mutePublishedTrack(room: string, identity: string, sid: string) {
      mutedTracks.push({ room, identity, sid })
    }
    async removeParticipant(room: string, identity: string) {
      removedFromRoom.push({ room, identity })
    }
  },
}))

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const huddles = await import('../services/huddle.service')
const polls = await import('../services/conversation-polls.service')
const { HUDDLE_MAX_PARTICIPANTS } = await import('../lib/chat-limits')

const db = prisma as any
let seed: SeededWorkspace
let events: any[] = []
let admin: string

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  admin = (await db.user.create({ data: { name: 'admin', email: `admin-${crypto.randomUUID().slice(0, 6)}@example.com` } })).id
  await db.member.create({ data: { userId: admin, workspaceId: seed.workspaceId, role: 'admin' } })
  bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => events.push(envelope))
  huddles._setHuddlePushSenderForTests(async () => {})
})

beforeEach(() => {
  events = []
  liveRooms.clear()
  mutedTracks.length = 0
  removedFromRoom.length = 0
  huddles._resetHuddlesForTests()
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

const slug = () => crypto.randomUUID().slice(0, 6)

/** A private channel only the owner is in, so the other workspace members are not conversation members. */
async function privateChannel(members: string[] = []) {
  return service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: `huddle-multi-${slug()}`, kind: 'private', topic: null, memberUserIds: members })
}

function claims(token: string): any {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
}

describe('inviting people mid-call', () => {
  test('an invite rings the person, shows a Ringing tile, and lets them in without joining the conversation', async () => {
    const conv = await privateChannel()
    await huddles.joinHuddle(conv.id, seed.owner)

    const view = await huddles.inviteToHuddle(conv.id, seed.owner, [seed.member])
    expect(view.invited).toEqual([expect.objectContaining({ userId: seed.member, status: 'ringing', invitedById: seed.owner })])
    const ring = events.find((e) => e.event.type === 'huddle.ring' && e.event.conversationId === conv.id)
    expect(ring.audience).toEqual([seed.member])
    expect(ring.event).toMatchObject({ invite: true, from: { userId: seed.owner } })

    const joined = await huddles.joinHuddle(conv.id, seed.member)
    expect(joined.huddle.participants.map((p) => p.userId).sort()).toEqual([seed.owner, seed.member].sort())
    expect(joined.huddle.invited).toEqual([])
    expect((await db.huddleInvite.findFirst({ where: { userId: seed.member } })).status).toBe('joined')
    // They are in the huddle, not the conversation.
    expect(await db.conversationMember.findFirst({ where: { conversationId: conv.id, userId: seed.member } })).toBeNull()
    await expect(service.requirePost(conv.id, seed.member)).rejects.toThrow()
  })

  test('someone who was never invited cannot join a private channel huddle', async () => {
    const conv = await privateChannel()
    await huddles.joinHuddle(conv.id, seed.owner)
    await expect(huddles.joinHuddle(conv.id, seed.member)).rejects.toThrow()
  })

  test('invite rules: be in the call, no viewers, nobody outside the workspace', async () => {
    const conv = await privateChannel([seed.member])
    await expect(huddles.inviteToHuddle(conv.id, seed.owner, [seed.member])).rejects.toMatchObject({ code: 'huddle_ended' })
    await huddles.joinHuddle(conv.id, seed.owner)
    await expect(huddles.inviteToHuddle(conv.id, seed.member, [admin])).rejects.toMatchObject({ code: 'forbidden' })
    await expect(huddles.inviteToHuddle(conv.id, seed.owner, [seed.viewer])).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(huddles.inviteToHuddle(conv.id, seed.owner, [seed.outsider])).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(huddles.inviteToHuddle(conv.id, seed.owner, [])).rejects.toMatchObject({ code: 'invalid_request' })
  })

  test('a channel huddle can ring specific members who are in the conversation too', async () => {
    const conv = await privateChannel([seed.member])
    await huddles.joinHuddle(conv.id, seed.owner)
    const view = await huddles.inviteToHuddle(conv.id, seed.owner, [seed.member])
    expect(view.invited.map((i) => i.userId)).toEqual([seed.member])
    expect(events.some((e) => e.event.type === 'huddle.ring' && e.audience?.includes(seed.member))).toBe(true)
  })

  test('declining or cancelling an invite closes the door', async () => {
    const conv = await privateChannel()
    await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.inviteToHuddle(conv.id, seed.owner, [seed.member, admin])

    const afterDecline = await huddles.declineHuddle(conv.id, seed.member)
    expect(afterDecline?.invited.find((i) => i.userId === seed.member)?.status).toBe('declined')
    expect(events.some((e) => e.event.type === 'huddle.declined' && e.event.userId === seed.member)).toBe(true)
    await expect(huddles.joinHuddle(conv.id, seed.member)).rejects.toThrow()

    const afterCancel = await huddles.cancelHuddleInvite(conv.id, seed.owner, admin)
    expect(afterCancel?.invited.find((i) => i.userId === admin)).toBeUndefined()
    await expect(huddles.joinHuddle(conv.id, admin)).rejects.toThrow()
  })

  test('an unanswered ring reads as missed', async () => {
    const conv = await privateChannel()
    await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.inviteToHuddle(conv.id, seed.owner, [seed.member])
    await huddles._expireRingsForTests()
    const view = await huddles.getHuddle(conv.id, seed.owner)
    expect(view?.invited[0]).toMatchObject({ userId: seed.member, status: 'missed' })
  })

  test('the participant cap keeps a full huddle closed to new joiners and invites', async () => {
    const conv = await privateChannel([seed.member])
    const first = await huddles.joinHuddle(conv.id, seed.owner)
    for (let i = 0; i < HUDDLE_MAX_PARTICIPANTS - 1; i++) {
      await db.huddleParticipant.create({ data: { huddleId: first.huddle.id, userId: `filler-${i}` } })
    }
    await expect(huddles.joinHuddle(conv.id, seed.member)).rejects.toMatchObject({ code: 'huddle_full' })
    await expect(huddles.inviteToHuddle(conv.id, seed.owner, [admin])).rejects.toMatchObject({ code: 'huddle_full' })
  })
})

describe('moderation', () => {
  test('the host mutes and removes people; others cannot', async () => {
    const conv = await privateChannel([seed.member, admin])
    const first = await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.joinHuddle(conv.id, seed.member)
    await huddles.joinHuddle(conv.id, admin)

    await expect(huddles.muteHuddleParticipant(conv.id, seed.member, admin)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await huddles.muteHuddleParticipant(conv.id, seed.owner, seed.member)).toEqual({ muted: true })
    expect(mutedTracks).toEqual([expect.objectContaining({ identity: seed.member, sid: `TR_${seed.member}` })])

    await expect(huddles.removeHuddleParticipant(conv.id, seed.owner, seed.owner)).rejects.toMatchObject({ code: 'invalid_request' })
    const after = await huddles.removeHuddleParticipant(conv.id, seed.owner, seed.member)
    expect(after?.participants.map((p) => p.userId).sort()).toEqual([seed.owner, admin].sort())
    expect(removedFromRoom).toEqual([expect.objectContaining({ identity: seed.member })])
    expect(first.huddle.id).toBeTruthy()
  })

  test('a workspace admin can moderate a huddle they did not start', async () => {
    const conv = await privateChannel([seed.member, admin])
    await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.joinHuddle(conv.id, seed.member)
    await huddles.joinHuddle(conv.id, admin)
    const after = await huddles.removeHuddleParticipant(conv.id, admin, seed.member)
    expect(after?.participants.map((p) => p.userId)).not.toContain(seed.member)
  })

  test('a removed invitee cannot walk back in with the same invite', async () => {
    const conv = await privateChannel()
    await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.inviteToHuddle(conv.id, seed.owner, [seed.member])
    await huddles.joinHuddle(conv.id, seed.member)
    await huddles.removeHuddleParticipant(conv.id, seed.owner, seed.member)
    await expect(huddles.joinHuddle(conv.id, seed.member)).rejects.toThrow()
  })
})

describe('share link and knock to join', () => {
  async function liveHuddle() {
    const conv = await privateChannel()
    const joined = await huddles.joinHuddle(conv.id, seed.owner)
    const link = await huddles.getHuddleLink(conv.id, seed.owner)
    return { conv, huddle: joined.huddle, link }
  }

  test('the link is stable, only people in the call can copy it, and only the host can rotate it', async () => {
    const { conv, link } = await liveHuddle()
    expect(link.path).toBe(`/huddle/join/${link.token}`)
    expect(await huddles.getHuddleLink(conv.id, seed.owner)).toEqual(link)
    await expect(huddles.getHuddleLink(conv.id, seed.member)).rejects.toThrow()
    const rotated = await huddles.getHuddleLink(conv.id, seed.owner, { rotate: true })
    expect(rotated.token).not.toBe(link.token)
    expect(await huddles.getHuddleLinkInfo(link.token, null)).toEqual({ live: false })
    expect((await huddles.getHuddleLinkInfo(rotated.token, null)).live).toBe(true)
  })

  test('link info shows nothing about the conversation to people who cannot see it', async () => {
    const { conv, link } = await liveHuddle()
    const stranger = await huddles.getHuddleLinkInfo(link.token, null)
    expect(stranger).toMatchObject({ live: true, access: 'knock', participantCount: 1 })
    expect(stranger.conversationId).toBeUndefined()
    expect(stranger.label).toBeUndefined()
    const outsiderInfo = await huddles.getHuddleLinkInfo(link.token, seed.member)
    expect(outsiderInfo.access).toBe('knock')
    const insider = await huddles.getHuddleLinkInfo(link.token, seed.owner)
    expect(insider).toMatchObject({ access: 'member', conversationId: conv.id, workspaceId: seed.workspaceId })
  })

  test('a guest knocks, is admitted by someone in the call, and gets a guest token that reaches only the call', async () => {
    const { conv, huddle, link } = await liveHuddle()
    const knock = await huddles.knockOnHuddle(link.token, { userId: null, guestName: '  Gus   Guest ' })
    expect(knock).toMatchObject({ status: 'waiting', guest: true })

    const waiting = await huddles.getHuddle(conv.id, seed.owner)
    expect(waiting?.requests).toEqual([expect.objectContaining({ id: knock.requestId, name: 'Gus Guest', guest: true, userId: null })])
    expect(events.some((e) => e.event.type === 'huddle.knock' && e.event.request.name === 'Gus Guest')).toBe(true)
    expect(await huddles.getHuddleJoinRequest(knock.requestId!, null)).toEqual({ status: 'waiting' })

    await huddles.resolveHuddleRequest(conv.id, seed.owner, knock.requestId!, 'admit')
    const result = await huddles.getHuddleJoinRequest(knock.requestId!, null)
    expect(result.status).toBe('admitted')
    expect(result.guestId).toMatch(/^guest_/)
    const token = claims(result.token!)
    expect(token.sub).toBe(result.guestId)
    expect(token.name).toBe('Gus Guest')
    expect(JSON.parse(token.metadata)).toMatchObject({ guest: true })

    const view = await huddles.getHuddle(conv.id, seed.owner)
    expect(view?.requests).toEqual([])
    expect(view?.participants.find((p) => p.userId === result.guestId)).toMatchObject({ guest: true, name: 'Gus Guest' })
    // Guests are never conversation members and the conversation's data is not theirs.
    expect(await db.conversationMember.findFirst({ where: { conversationId: conv.id, userId: result.guestId } })).toBeNull()
    expect(huddle.id).toBeTruthy()

    await huddles.guestLeaveHuddle(knock.requestId!)
    expect((await huddles.getHuddle(conv.id, seed.owner))?.participants.map((p) => p.userId)).toEqual([seed.owner])
  })

  test('a guest must give a name, and denied guests stay out', async () => {
    const { conv, link } = await liveHuddle()
    await expect(huddles.knockOnHuddle(link.token, { userId: null, guestName: '   ' })).rejects.toMatchObject({ code: 'invalid_request' })
    const knock = await huddles.knockOnHuddle(link.token, { userId: null, guestName: 'Dee' })
    await huddles.resolveHuddleRequest(conv.id, seed.owner, knock.requestId!, 'deny')
    expect(await huddles.getHuddleJoinRequest(knock.requestId!, null)).toEqual({ status: 'denied' })
  })

  test('only people in the call can admit', async () => {
    const { conv, link } = await liveHuddle()
    const knock = await huddles.knockOnHuddle(link.token, { userId: null, guestName: 'Dee' })
    await expect(huddles.resolveHuddleRequest(conv.id, seed.member, knock.requestId!, 'admit')).rejects.toThrow()
    await expect(huddles.resolveHuddleRequest(conv.id, seed.owner, 'nope', 'admit')).rejects.toMatchObject({ code: 'not_found' })
  })

  test('a request that nobody answers expires', async () => {
    const { conv, link } = await liveHuddle()
    const knock = await huddles.knockOnHuddle(link.token, { userId: null, guestName: 'Dee' })
    await db.huddleJoinRequest.update({ where: { id: knock.requestId }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } })
    expect((await huddles.getHuddle(conv.id, seed.owner))?.requests).toEqual([])
    await expect(huddles.resolveHuddleRequest(conv.id, seed.owner, knock.requestId!, 'admit')).rejects.toMatchObject({ code: 'request_expired' })
    expect(await huddles.getHuddleJoinRequest(knock.requestId!, null)).toEqual({ status: 'expired' })
  })

  test('rotating the link lapses requests waiting on the old one', async () => {
    const { conv, link } = await liveHuddle()
    const knock = await huddles.knockOnHuddle(link.token, { userId: null, guestName: 'Dee' })
    await huddles.getHuddleLink(conv.id, seed.owner, { rotate: true })
    expect(await huddles.getHuddleJoinRequest(knock.requestId!, null)).toEqual({ status: 'expired' })
    await expect(huddles.knockOnHuddle(link.token, { userId: null, guestName: 'Eve' })).rejects.toMatchObject({ code: 'huddle_ended' })
  })

  test('a workspace member without access knocks, is admitted, and joins the huddle but not the channel', async () => {
    const { conv, link } = await liveHuddle()
    const knock = await huddles.knockOnHuddle(link.token, { userId: seed.member })
    expect(knock).toMatchObject({ status: 'waiting', guest: false })
    // Knocking again reuses the open request.
    expect((await huddles.knockOnHuddle(link.token, { userId: seed.member })).requestId).toBe(knock.requestId)
    // Another person's request id tells you nothing.
    await expect(huddles.getHuddleJoinRequest(knock.requestId!, admin)).rejects.toMatchObject({ code: 'not_found' })

    await huddles.resolveHuddleRequest(conv.id, seed.owner, knock.requestId!, 'admit')
    expect(await huddles.getHuddleJoinRequest(knock.requestId!, seed.member)).toEqual({
      status: 'admitted',
      conversationId: conv.id,
      workspaceId: seed.workspaceId,
    })
    const joined = await huddles.joinHuddle(conv.id, seed.member)
    expect(joined.huddle.participants.map((p) => p.userId)).toContain(seed.member)
    await expect(service.requirePost(conv.id, seed.member)).rejects.toThrow()
  })

  test('people who can already join are sent straight in, and viewers cannot knock', async () => {
    const conv = await privateChannel([seed.member])
    await huddles.joinHuddle(conv.id, seed.owner)
    const link = await huddles.getHuddleLink(conv.id, seed.owner)
    await expect(huddles.knockOnHuddle(link.token, { userId: seed.member })).rejects.toMatchObject({ code: 'already_has_access' })
    await expect(huddles.knockOnHuddle(link.token, { userId: seed.viewer })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(huddles.knockOnHuddle(link.token, { userId: seed.outsider })).rejects.toMatchObject({ code: 'forbidden' })
  })

  test('the link stops working when the huddle ends', async () => {
    const { conv, link } = await liveHuddle()
    await huddles.leaveHuddle(conv.id, seed.owner)
    expect(await huddles.getHuddleLinkInfo(link.token, null)).toEqual({ live: false })
    await expect(huddles.knockOnHuddle(link.token, { userId: null, guestName: 'Dee' })).rejects.toMatchObject({ code: 'huddle_ended' })
  })
})

describe('polls and Q&A in the huddle thread', () => {
  async function inCall() {
    const conv = await privateChannel([seed.member, admin])
    const joined = await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.joinHuddle(conv.id, seed.member)
    await huddles.joinHuddle(conv.id, admin)
    return { conv, huddle: joined.huddle }
  }

  test('a poll is posted in the thread and tallies votes live', async () => {
    const { conv, huddle } = await inCall()
    const message = await polls.postHuddlePoll(conv.id, seed.owner, { question: 'Ship it?', options: ['Yes', 'No', 'Yes'], multiple: false })
    expect(message.threadRootId).toBe(huddle.messageId)
    const poll = (message.blocks as any).poll
    expect(poll.options.map((o: any) => o.text)).toEqual(['Yes', 'No'])
    const [yes, no] = poll.options

    events = []
    await polls.voteOnMessage(message.id, seed.member, yes.id)
    const afterTwo = await polls.voteOnMessage(message.id, admin, yes.id)
    expect((afterTwo.blocks as any).poll.tally).toEqual({ [yes.id]: 2 })
    expect((afterTwo.blocks as any).poll.voters[yes.id].sort()).toEqual([seed.member, admin].sort())
    expect(events.some((e) => e.event.type === 'message.updated' && e.event.message.id === message.id)).toBe(true)

    // Single choice: voting for another option moves the vote; voting again takes it back.
    const moved = await polls.voteOnMessage(message.id, seed.member, no.id)
    expect((moved.blocks as any).poll.tally).toEqual({ [yes.id]: 1, [no.id]: 1 })
    const withdrawn = await polls.voteOnMessage(message.id, seed.member, no.id)
    expect((withdrawn.blocks as any).poll.tally).toEqual({ [yes.id]: 1 })
  })

  test('multiple-choice polls keep every pick, and closed polls take no more votes', async () => {
    const { conv } = await inCall()
    const message = await polls.postHuddlePoll(conv.id, seed.owner, { question: 'Lunch?', options: ['Pizza', 'Tacos', 'Salad'], multiple: true })
    const [pizza, tacos] = (message.blocks as any).poll.options
    await polls.voteOnMessage(message.id, seed.member, pizza.id)
    const both = await polls.voteOnMessage(message.id, seed.member, tacos.id)
    expect((both.blocks as any).poll.tally).toEqual({ [pizza.id]: 1, [tacos.id]: 1 })

    await expect(polls.closePoll(message.id, seed.member)).rejects.toMatchObject({ code: 'forbidden' })
    const closed = await polls.closePoll(message.id, seed.owner)
    expect((closed.blocks as any).poll.closed).toBe(true)
    await expect(polls.voteOnMessage(message.id, admin, pizza.id)).rejects.toMatchObject({ code: 'poll_closed' })
  })

  test('polls need a question, at least two options, an option that exists, and a person in the call', async () => {
    const { conv } = await inCall()
    await expect(polls.postHuddlePoll(conv.id, seed.owner, { question: '', options: ['a', 'b'] })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(polls.postHuddlePoll(conv.id, seed.owner, { question: 'Q', options: ['only'] })).rejects.toMatchObject({ code: 'invalid_request' })
    const message = await polls.postHuddlePoll(conv.id, seed.owner, { question: 'Q', options: ['a', 'b'] })
    await expect(polls.voteOnMessage(message.id, seed.member, 'bogus')).rejects.toMatchObject({ code: 'invalid_request' })
    await huddles.leaveHuddle(conv.id, admin)
    await expect(polls.postHuddlePoll(conv.id, admin, { question: 'Q', options: ['a', 'b'] })).rejects.toMatchObject({ code: 'forbidden' })
  })

  test('questions are upvoted, sorted by the client, and marked answered by whoever asked', async () => {
    const { conv, huddle } = await inCall()
    const question = await polls.postHuddleQuestion(conv.id, seed.member, { text: 'When is the launch?' })
    expect(question.threadRootId).toBe(huddle.messageId)
    expect((question.blocks as any).question).toMatchObject({ answered: false, upvotes: 0 })

    await polls.voteOnMessage(question.id, seed.owner, 'up')
    const up = await polls.voteOnMessage(question.id, admin, 'up')
    expect((up.blocks as any).question).toMatchObject({ upvotes: 2 })
    const down = await polls.voteOnMessage(question.id, admin, 'up')
    expect((down.blocks as any).question).toMatchObject({ upvotes: 1, upvoters: [seed.owner] })
    await expect(polls.voteOnMessage(question.id, admin, 'other')).rejects.toMatchObject({ code: 'invalid_request' })

    const answered = await polls.setQuestionAnswered(question.id, seed.member, true)
    expect((answered.blocks as any).question.answered).toBe(true)
    // The huddle's host can too; someone else cannot.
    const other = await polls.postHuddleQuestion(conv.id, admin, { text: 'Who is on call?' })
    await expect(polls.setQuestionAnswered(other.id, seed.member, true)).rejects.toMatchObject({ code: 'forbidden' })
    expect(((await polls.setQuestionAnswered(other.id, seed.owner, true)).blocks as any).question.answered).toBe(true)
  })

  test('ordinary messages are not votable', async () => {
    const { conv } = await inCall()
    const plain = await service.postMessage({ conversationId: conv.id, authorType: 'user', authorUserId: seed.owner, text: 'hello' })
    await expect(polls.voteOnMessage(plain.message.id, seed.member, 'up')).rejects.toMatchObject({ code: 'not_votable' })
  })
})

describe('where the call chat lives', () => {
  let crab: string
  beforeAll(async () => {
    crab = (await db.user.create({ data: { name: 'crab', email: `crab-${slug()}@example.com` } })).id
    await db.member.create({ data: { userId: crab, workspaceId: seed.workspaceId, role: 'member' } })
  })

  /** Owner calls member in their DM. Any call left over from an earlier test is ended first, since the DM is shared. */
  async function dmCall() {
    await db.huddle.updateMany({ where: { activeKey: { not: null } }, data: { activeKey: null, endedAt: new Date() } })
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    const joined = await huddles.joinHuddle(dm.id, seed.owner)
    await huddles.joinHuddle(dm.id, seed.member)
    return { dm, huddle: joined.huddle }
  }

  test('two people chat in their DM, under the huddle message', async () => {
    const { dm, huddle } = await dmCall()
    for (const user of [seed.owner, seed.member]) {
      const chat = await huddles.getHuddleChat(dm.id, user)
      expect(chat).toMatchObject({ conversationId: dm.id, kind: 'dm', threadRootId: huddle.messageId, moved: false })
    }
  })

  test('adding a third person moves everyone to the group with exactly those people, found again next time', async () => {
    const { dm } = await dmCall()
    await huddles.inviteToHuddle(dm.id, seed.owner, [crab])
    await huddles.joinHuddle(dm.id, crab)

    const forCrab = await huddles.getHuddleChat(dm.id, crab)
    expect(forCrab).toMatchObject({ kind: 'group_dm', threadRootId: null, moved: true })
    expect(forCrab!.members).toEqual([seed.owner, seed.member, crab].sort())
    const members = await db.conversationMember.findMany({ where: { conversationId: forCrab!.conversationId } })
    expect(members.map((m: any) => m.userId).sort()).toEqual([seed.owner, seed.member, crab].sort())

    // Everyone lands in the same group, and asking again reuses it.
    for (const user of [seed.owner, seed.member, crab]) {
      expect((await huddles.getHuddleChat(dm.id, user))!.conversationId).toBe(forCrab!.conversationId)
    }
    expect(await db.conversation.count({ where: { workspaceId: seed.workspaceId, dmKey: `u:${[seed.owner, seed.member, crab].sort().join(',')}` } })).toBe(1)

    // The invited person can post there, and the view tells clients the set changed.
    await service.postMessage({ conversationId: forCrab!.conversationId, authorType: 'user', authorUserId: crab, text: 'hello from the crab' })
    const view = await huddles.getHuddle(dm.id, seed.owner)
    expect(view?.chatMembers).toEqual([seed.owner, seed.member, crab].sort())
  })

  test('a fourth person means a new group, and leaving does not shrink the set', async () => {
    const { dm } = await dmCall()
    await huddles.inviteToHuddle(dm.id, seed.owner, [crab])
    await huddles.joinHuddle(dm.id, crab)
    const three = (await huddles.getHuddleChat(dm.id, seed.owner))!
    await huddles.inviteToHuddle(dm.id, seed.owner, [admin])
    await huddles.joinHuddle(dm.id, admin)
    const four = (await huddles.getHuddleChat(dm.id, seed.owner))!
    expect(four.conversationId).not.toBe(three.conversationId)
    expect(four.members).toHaveLength(4)

    await huddles.leaveHuddle(dm.id, crab)
    expect((await huddles.getHuddleChat(dm.id, seed.owner))!.conversationId).toBe(four.conversationId)
    expect((await huddles.getHuddleChat(dm.id, admin))!.conversationId).toBe(four.conversationId)
  })

  test('someone invited but not yet in the call is already part of the set; a declined one is not', async () => {
    const { dm } = await dmCall()
    await huddles.inviteToHuddle(dm.id, seed.owner, [crab])
    expect((await huddles.getHuddle(dm.id, seed.owner))?.chatMembers).toContain(crab)
    await huddles.declineHuddle(dm.id, crab)
    expect((await huddles.getHuddle(dm.id, seed.owner))?.chatMembers).not.toContain(crab)
  })

  test('polls and questions follow the call chat, so an invited non-member can use them', async () => {
    const { dm } = await dmCall()
    await huddles.inviteToHuddle(dm.id, seed.owner, [crab])
    await huddles.joinHuddle(dm.id, crab)
    const group = (await huddles.getHuddleChat(dm.id, crab))!

    const poll = await polls.postHuddlePoll(dm.id, crab, { question: 'Lunch?', options: ['Yes', 'No'] })
    expect(poll.conversationId).toBe(group.conversationId)
    const yes = (poll.blocks as any).poll.options[0].id
    const voted = await polls.voteOnMessage(poll.id, seed.owner, yes)
    expect((voted.blocks as any).poll.tally).toEqual({ [yes]: 1 })

    const question = await polls.postHuddleQuestion(dm.id, crab, { text: 'Who is driving?' })
    expect(question.conversationId).toBe(group.conversationId)
  })

  test('people outside the call have no chat to ask for', async () => {
    const { dm } = await dmCall()
    await expect(huddles.getHuddleChat(dm.id, crab)).rejects.toMatchObject({ status: 403 })
    await expect(huddles.getHuddleChat(dm.id, seed.outsider)).rejects.toBeTruthy()
  })

  test('in a channel, members keep the huddle thread and non-members use the group', async () => {
    const conv = await privateChannel([seed.member])
    const joined = await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.inviteToHuddle(conv.id, seed.owner, [crab])
    await huddles.joinHuddle(conv.id, crab)

    const forOwner = (await huddles.getHuddleChat(conv.id, seed.owner))!
    expect(forOwner).toMatchObject({ conversationId: conv.id, threadRootId: joined.huddle.messageId, moved: false })
    const forCrab = (await huddles.getHuddleChat(conv.id, crab))!
    expect(forCrab.conversationId).not.toBe(conv.id)
    expect(forCrab.kind).toBe('dm')
    expect(forCrab.members).toEqual([seed.owner, crab].sort())
  })

  test('a call too big for a group falls back to the conversation it started in', async () => {
    const { dm } = await dmCall()
    const row = await db.huddle.findUnique({ where: { activeKey: dm.id } })
    for (let i = 0; i < 8; i++) {
      const id = (await db.user.create({ data: { name: `p${i}`, email: `p${i}-${slug()}@example.com` } })).id
      await db.member.create({ data: { userId: id, workspaceId: seed.workspaceId, role: 'member' } })
      await db.huddleInvite.create({ data: { huddleId: row.id, userId: id, invitedById: seed.owner, status: 'ringing' } })
    }
    const chat = (await huddles.getHuddleChat(dm.id, seed.owner))!
    expect(chat.members.length).toBeGreaterThan(9)
    expect(chat).toMatchObject({ conversationId: dm.id, moved: false })
  })

  test('people added to the call hear the chat set change, including ones who cannot see the conversation', async () => {
    const { dm } = await dmCall()
    // Someone no earlier test grouped with these two, so the group is new.
    const newcomer = (await db.user.create({ data: { name: 'newcomer', email: `newcomer-${slug()}@example.com` } })).id
    await db.member.create({ data: { userId: newcomer, workspaceId: seed.workspaceId, role: 'member' } })
    events = []
    await huddles.inviteToHuddle(dm.id, seed.owner, [newcomer])
    const update = events.filter((e) => e.event.type === 'huddle.updated' && e.event.conversationId === dm.id).at(-1)
    expect(update.event.huddle.chatMembers).toContain(newcomer)
    expect(update.audience).toContain(newcomer)

    // Looking the chat up creates the group once and tells the workspace about it.
    events = []
    await huddles.joinHuddle(dm.id, newcomer)
    const chat = await huddles.getHuddleChat(dm.id, newcomer)
    expect(events.some((e) => e.event.type === 'conversation.created' && e.event.conversation?.id === chat!.conversationId)).toBe(true)
  })

  test('once the call ends there is no chat to look up', async () => {
    const { dm } = await dmCall()
    await huddles.leaveHuddle(dm.id, seed.owner)
    await huddles.leaveHuddle(dm.id, seed.member)
    await expect(huddles.getHuddleChat(dm.id, seed.owner)).rejects.toMatchObject({ code: 'huddle_ended' })
  })

  test('everyone in the call can open a group that was only half set up when they asked', async () => {
    const { dm } = await dmCall()
    const sam = (await db.user.create({ data: { name: 'sam', email: `sam-${slug()}@example.com` } })).id
    await db.member.create({ data: { userId: sam, workspaceId: seed.workspaceId, role: 'member' } })
    await huddles.inviteToHuddle(dm.id, seed.owner, [sam])
    await huddles.joinHuddle(dm.id, sam)

    // The group exists with only its creator in it: what the others see when
    // everyone asks at once and one request has not finished adding people.
    const key = `u:${[seed.owner, seed.member, sam].sort().join(',')}`
    const half = await db.conversation.create({ data: { workspaceId: seed.workspaceId, kind: 'group_dm', dmKey: key, createdById: sam } })
    await db.conversationMember.create({ data: { conversationId: half.id, memberType: 'user', userId: sam } })

    for (const user of [seed.owner, seed.member, sam]) {
      const chat = await huddles.getHuddleChat(dm.id, user)
      expect(chat!.conversationId).toBe(half.id)
      const message = await service.postMessage({ conversationId: chat!.conversationId, authorType: 'user', authorUserId: user, text: `hi from ${user}` })
      expect(message).toBeTruthy()
    }
    const members = await db.conversationMember.findMany({ where: { conversationId: half.id } })
    expect(members.map((m: any) => m.userId).sort()).toEqual([seed.owner, seed.member, sam].sort())
    // Reading it is allowed for all of them, too.
    for (const user of [seed.owner, seed.member, sam]) {
      await expect(service.requirePost(half.id, user)).resolves.toBeTruthy()
    }
  })

  test('asking for the same group many times at once creates it once with everyone in it', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = (await db.user.create({ data: { name: `g${i}`, email: `g${i}-${slug()}@example.com` } })).id
      await db.member.create({ data: { userId: id, workspaceId: seed.workspaceId, role: 'member' } })
      ids.push(id)
    }
    const all = [...ids].sort()
    const opened = await Promise.all(all.map((u) => service.openDirectConversation(seed.workspaceId, u, all.filter((x) => x !== u))))
    expect(new Set(opened.map((c: any) => c.id)).size).toBe(1)
    const members = await db.conversationMember.findMany({ where: { conversationId: opened[0].id } })
    expect(members.map((m: any) => m.userId).sort()).toEqual(all)
  })
})
