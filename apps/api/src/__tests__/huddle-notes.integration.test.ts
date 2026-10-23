// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle notes: who gets a streaming ticket and for whom, the on/off switch and
 * the event that announces it, reading the transcript back, and the summary
 * posted once when the call ends. LiveKit is faked; tickets are real.
 *
 * Transcription is never started here: the recognizer only runs once audio is
 * pushed at it, which these tests don't do (no network, no provider calls).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

process.env.LIVEKIT_URL = 'wss://huddles.test'
process.env.LIVEKIT_API_KEY = 'test-key'
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256'
// Enough for a streaming ticket; nothing connects, so no provider is ever called.
process.env.OPENAI_API_KEY = 'sk-test'

const sdk = await import('livekit-server-sdk')
/** Every explicit dispatch a join or a toggle asked for. */
const dispatches: Array<{ room: string; agent: string; huddleId: string }> = []
mock.module('livekit-server-sdk', () => ({
  ...sdk,
  RoomServiceClient: class {
    async listParticipants(room: string) {
      return (liveRooms.get(room) ?? []).map((identity) => ({ identity }))
    }
    async listRooms(names?: string[]) {
      return (names ?? [...roomMetadata.keys()]).map((name) => ({ name, metadata: JSON.stringify(roomMetadata.get(name) ?? {}) }))
    }
    async deleteRoom(room: string) {
      liveRooms.delete(room)
    }
    async updateRoomMetadata(room: string, metadata: string) {
      roomMetadata.set(room, JSON.parse(metadata))
    }
  },
  AgentDispatchClient: class {
    async createDispatch(room: string, agent: string, options?: { metadata?: string }) {
      dispatches.push({ room, agent, huddleId: JSON.parse(options?.metadata ?? '{}').huddleId })
      return { id: `dispatch-${dispatches.length}` }
    }
  },
}))

const liveRooms = new Map<string, string[]>()
const roomMetadata = new Map<string, any>()

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const meetings = await import('../services/meeting.service')
const { verifyStreamTicket } = await import('../lib/meeting-stream-ticket')
const huddles = await import('../services/huddle.service')

const db = prisma as any
let seed: SeededWorkspace
let events: any[] = []

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  bus.subscribeWorkspaceEvents(seed.workspaceId, (envelope) => events.push(envelope))
  huddles._setHuddlePushSenderForTests(async () => {})
})

beforeEach(() => {
  events = []
  dispatches.length = 0
  roomMetadata.clear()
  huddles._resetHuddlesForTests()
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

const slug = () => crypto.randomUUID().slice(0, 6)

async function channel(name: string, members: string[] = [seed.member], kind: 'public' | 'private' = 'public') {
  return service.createChannel({
    workspaceId: seed.workspaceId,
    userId: seed.owner,
    name: `${name}-${slug()}`,
    kind,
    topic: null,
    memberUserIds: members,
  })
}

/** A call the owner and the member are both in. */
async function liveHuddle(kind: 'public' | 'private' = 'public') {
  const conv = await channel('huddle-notes', [seed.member], kind)
  const joined = await huddles.joinHuddle(conv.id, seed.owner)
  await huddles.joinHuddle(conv.id, seed.member)
  return { conv, huddleId: joined.huddle.id }
}

const notesEvents = () => events.filter((e) => e.event.type === 'huddle.notes').map((e) => e.event)

function claimsOf(ticket: string) {
  const verified = verifyStreamTicket(ticket)
  expect(verified).toBeTruthy()
  return verified!
}

describe('notes tickets', () => {
  test('a participant gets a ticket that names the huddle, the shared draft and the speaker', async () => {
    const { conv, huddleId } = await liveHuddle()
    const ticket = await huddles.createHuddleNotesTicket(conv.id, seed.owner)
    expect(ticket.path).toBe('/api/meetings/live-stream')
    expect(ticket.expiresInMs).toBeGreaterThan(0)

    const claims = claimsOf(ticket.ticket)
    expect(claims).toMatchObject({
      workspaceId: seed.workspaceId,
      huddleId,
      speakerId: seed.owner,
      recordingId: meetings.huddleRecordingId(huddleId),
    })
    expect(claims.speaker).toBeTruthy()
  })

  test('someone outside the call gets no ticket', async () => {
    const { conv } = await liveHuddle()
    await expect(huddles.createHuddleNotesTicket(conv.id, seed.viewer)).rejects.toMatchObject({ status: 403 })
  })

  test('a covering client asks for someone else’s ticket, under that person’s name', async () => {
    const { conv } = await liveHuddle()
    const covering = await huddles.createHuddleNotesTicket(conv.id, seed.owner, { forUserId: seed.member, client: 'web' })
    const claims = claimsOf(covering.ticket)
    expect(claims.speakerId).toBe(seed.member)
    expect(claims.userId).toBe(seed.owner)

    // A phone can't tap a remote track, so it can't cover anyone.
    await expect(
      huddles.createHuddleNotesTicket(conv.id, seed.owner, { forUserId: seed.member, client: 'native' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  test('a covering client may not name someone who is not in the call', async () => {
    const { conv } = await liveHuddle()
    await expect(
      huddles.createHuddleNotesTicket(conv.id, seed.owner, { forUserId: seed.viewer, client: 'web' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  test('an ended huddle has no tickets', async () => {
    const conv = await channel('huddle-notes-ended')
    await huddles.joinHuddle(conv.id, seed.owner)
    await huddles.leaveHuddle(conv.id, seed.owner)
    await expect(huddles.createHuddleNotesTicket(conv.id, seed.owner)).rejects.toMatchObject({ status: 409, code: 'huddle_ended' })
  })

  test('an admitted guest gets a ticket under their guest name', async () => {
    const conv = await channel('huddle-notes-guest')
    await huddles.joinHuddle(conv.id, seed.owner)
    const link = await huddles.getHuddleLink(conv.id, seed.owner)
    const knock = await huddles.knockOnHuddle(link.token, { userId: null, guestName: 'Gus Guest' })
    await huddles.resolveHuddleRequest(conv.id, seed.owner, knock.requestId!, 'admit')
    const admitted = await huddles.getHuddleJoinRequest(knock.requestId!, null)
    expect(admitted.status).toBe('admitted')

    const ticket = await huddles.guestHuddleNotesTicket(knock.requestId!)
    const claims = claimsOf(ticket.ticket)
    expect(claims.speakerId).toBe(admitted.guestId!)
    expect(claims.speaker).toBe('Gus Guest')
  })
})

describe('turning notes off', () => {
  test('any participant can, everyone is told who did it, and the tickets stop', async () => {
    // A private channel narrows the audience, so the announcement is checkable.
    const { conv } = await liveHuddle('private')
    const off = await huddles.setHuddleNotes(conv.id, seed.member, false)
    expect(off?.notes.enabled).toBe(false)

    expect(notesEvents()).toEqual([
      expect.objectContaining({ conversationId: conv.id, enabled: false, changedById: seed.member }),
    ])
    expect(notesEvents()[0].name).toBeTruthy()
    expect(events.find((e) => e.event.type === 'huddle.notes')?.audience.sort()).toEqual([seed.owner, seed.member].sort())

    await expect(huddles.createHuddleNotesTicket(conv.id, seed.owner)).rejects.toMatchObject({ status: 409, code: 'notes_off' })

    const on = await huddles.setHuddleNotes(conv.id, seed.member, true)
    expect(on?.notes.enabled).toBe(true)
    expect(notesEvents().map((e) => e.enabled)).toEqual([false, true])
    await expect(huddles.createHuddleNotesTicket(conv.id, seed.owner)).resolves.toBeTruthy()
  })

  test('setting the same value twice announces nothing', async () => {
    const { conv } = await liveHuddle()
    await huddles.setHuddleNotes(conv.id, seed.owner, false)
    await huddles.setHuddleNotes(conv.id, seed.owner, false)
    expect(notesEvents()).toHaveLength(1)
  })

  test('someone outside the call cannot change it', async () => {
    const { conv } = await liveHuddle()
    await expect(huddles.setHuddleNotes(conv.id, seed.viewer, false)).rejects.toMatchObject({ status: 403 })
    expect(notesEvents()).toHaveLength(0)
  })
})

describe('the fallback agent', () => {
  /** The dispatch lives in a `void` call, so give it a beat (and a deadline). */
  const until = async (check: () => boolean, ms = 2_000) => {
    const started = Date.now()
    while (!check() && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 10))
  }

  test('a call that starts with notes on dispatches it, without anyone touching the toggle', async () => {
    const { conv } = await liveHuddle()
    await until(() => dispatches.length === 1)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].agent).toBe('huddle-notes')
    expect(roomMetadata.get(dispatches[0].room)?.notes).toBe(true)
    // Every participant joining asks again; only one job is minted.
    await huddles.joinHuddle(conv.id, seed.owner)
    await new Promise((r) => setTimeout(r, 50))
    expect(dispatches).toHaveLength(1)
  })

  test('a call with notes already off asks for nothing', async () => {
    const conv = await channel('huddle-notes', [seed.member])
    const joined = await huddles.joinHuddle(conv.id, seed.owner)
    await until(() => dispatches.length === 1)
    await huddles.setHuddleNotes(conv.id, seed.owner, false)
    dispatches.length = 0
    await huddles.leaveHuddle(conv.id, seed.member)
    await huddles.joinHuddle(conv.id, seed.member)
    await new Promise((r) => setTimeout(r, 50))
    expect(dispatches).toHaveLength(0)
    expect(joined.huddle.id).toBeTruthy()
  })

  test('turning notes off and on again does not mint a second job', async () => {
    const conv = await channel('huddle-notes', [seed.member])
    await huddles.joinHuddle(conv.id, seed.owner)
    await until(() => dispatches.length === 1)
    await huddles.setHuddleNotes(conv.id, seed.owner, false)
    await huddles.setHuddleNotes(conv.id, seed.owner, true)
    await new Promise((r) => setTimeout(r, 50))
    // One job for the call: the second ask is remembered, and the agent already
    // in the room is the cross-pod check on top of that.
    expect(dispatches).toHaveLength(1)
  })

  test('metering is idempotent: a replayed flush charges nothing, and the counter only climbs', async () => {
    const { huddleId } = await liveHuddle()
    const base = { huddleId, identity: seed.member, streamNo: 1, flushNo: 1 }
    await huddles.notesLivekitFallback({ ...base, seconds: 60, totalSeconds: 60 })
    let row = await db.huddle.findUnique({ where: { id: huddleId } })
    expect(row.notesLivekitSeconds).toBe(60)

    // The same flush again (a retry, a duplicate delivery): no new charge.
    await huddles.notesLivekitFallback({ ...base, seconds: 60, totalSeconds: 60 })
    row = await db.huddle.findUnique({ where: { id: huddleId } })
    expect(row.notesLivekitSeconds).toBe(60)

    // The next minute continues from where the ledger is.
    await huddles.notesLivekitFallback({ ...base, seconds: 60, flushNo: 2, totalSeconds: 120 })
    row = await db.huddle.findUnique({ where: { id: huddleId } })
    expect(row.notesLivekitSeconds).toBe(120)
  })

  test('a re-dispatched job that starts from zero cannot bill the same audio twice', async () => {
    const { huddleId } = await liveHuddle()
    await huddles.notesLivekitFallback({ huddleId, identity: seed.member, seconds: 300, streamNo: 1, flushNo: 1, totalSeconds: 300 })
    // The replacement job's counters restart at zero; its first flush is below
    // the ledger, so nothing is charged.
    await huddles.notesLivekitFallback({ huddleId, identity: seed.member, seconds: 60, streamNo: 1, flushNo: 1, totalSeconds: 60 })
    const row = await db.huddle.findUnique({ where: { id: huddleId } })
    expect(row.notesLivekitSeconds).toBe(300)
  })
})

describe('reading the notes', () => {
  test('a huddle with no draft has no notes yet', async () => {
    const { huddleId } = await liveHuddle()
    await expect(huddles.getHuddleNotes(huddleId, seed.owner)).rejects.toMatchObject({ status: 404, code: 'no_notes' })
  })

  test('participants read the transcript, someone who was never in the huddle cannot', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.meeting.update({
      where: { id: draft.id },
      data: {
        transcript: {
          text: 'Ana: ship it',
          segments: [{ start: 0, end: 2, text: 'ship it', speaker: 'Ana' }],
          language: 'en',
        },
      },
    })

    const view = await huddles.getHuddleNotes(huddleId, seed.member)
    expect(view.huddleId).toBe(huddleId)
    expect(view.transcript.text).toBe('Ana: ship it')
    expect(view.transcript.segments).toEqual([expect.objectContaining({ text: 'ship it', speaker: 'Ana' })])
    expect(view.meeting.source).toBe('huddle')

    await expect(huddles.getHuddleNotes(huddleId, seed.outsider)).rejects.toMatchObject({ status: 403 })
  })

  test('the draft is titled after the conversation, so the summary has a name', async () => {
    const conv = await channel('design-review')
    await huddles.joinHuddle(conv.id, seed.owner)
    const draft = await meetings.ensureHuddleNotesDraft((await huddles.getHuddle(conv.id, seed.owner))!.id)
    expect(draft.status).toBe('recording')
    expect(draft.title).toContain(`#${conv.name}`)
  })
})

describe('the summary when the call ends', () => {
  /** Ends the call and leaves a draft with a real transcript and a written summary. */
  async function endedWithSummary() {
    const { conv, huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.meeting.update({
      where: { id: draft.id },
      data: {
        status: 'ready',
        transcript: { text: 'Ana: ship it', segments: [{ start: 0, end: 2, text: 'ship it', speaker: 'Ana' }] },
        enhanceStatus: 'ready',
        enhancedNotes: '## Decisions\n- Ship it',
        title: 'Design review',
      },
    })
    const startedAt = new Date(Date.now() - 5 * 60_000)
    await db.huddle.update({ where: { id: huddleId }, data: { startedAt, endedAt: new Date() } })
    return { conv, huddleId, draft }
  }

  test('one system message carries the summary, with the transcript behind it', async () => {
    const { conv, huddleId, draft } = await endedWithSummary()
    await huddles.finalizeHuddleNotes(huddleId)

    const row = await db.huddle.findUnique({ where: { id: huddleId } })
    expect(row.notesMessageId).toBeTruthy()

    const message = await db.conversationMessage.findUnique({ where: { id: row.notesMessageId } })
    expect(message.conversationId).toBe(conv.id)
    expect(message.authorType).toBe('system')
    expect(message.text).toContain('Huddle notes: Design review')
    expect(message.text).toContain('Ship it')
    expect(message.blocks.huddleNotes).toEqual({
      huddleId,
      meetingId: draft.id,
      title: 'Design review',
      status: 'ready',
    })

    // The ended huddle card links to the same notes.
    const start = await db.conversationMessage.findUnique({ where: { id: row.messageId } })
    expect(start.blocks.huddle.notesMeetingId).toBe(draft.id)
  })

  test('posting twice never writes a second message', async () => {
    const { huddleId } = await endedWithSummary()
    await huddles.finalizeHuddleNotes(huddleId)
    const first = await db.huddle.findUnique({ where: { id: huddleId } })
    await huddles.finalizeHuddleNotes(huddleId)
    const second = await db.huddle.findUnique({ where: { id: huddleId } })
    expect(second.notesMessageId).toBe(first.notesMessageId)

    const count = await db.conversationMessage.count({
      where: { conversationId: second.conversationId, authorType: 'system', text: { contains: 'Huddle notes:' } },
    })
    expect(count).toBe(1)
  })

  test('a summary that could not be written still leaves the transcript and says so', async () => {
    const { huddleId } = await endedWithSummary()
    await db.meeting.updateMany({
      where: { recordingId: meetings.huddleRecordingId(huddleId) },
      // Enhance already ran and produced nothing: finalize must not call the model again.
      data: { enhanceStatus: 'ready', enhancedNotes: null },
    })
    await huddles.finalizeHuddleNotes(huddleId)

    const row = await db.huddle.findUnique({ where: { id: huddleId } })
    const message = await db.conversationMessage.findUnique({ where: { id: row.notesMessageId } })
    expect(message.text).toContain('The summary could not be written')
    expect(message.blocks.huddleNotes.status).toBe('failed')
    // The transcript itself is still there.
    const view = await huddles.getHuddleNotes(huddleId, seed.owner)
    expect(view.transcript.text).toBe('Ana: ship it')
  })

  test('a handover duplicates nothing in the transcript the summary is written from', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.meeting.update({
      where: { id: draft.id },
      data: {
        status: 'ready',
        enhanceStatus: 'ready',
        enhancedNotes: '## Notes\n- ship it',
        title: 'Design review',
        transcript: {
          text: 'ship it ship it we should ship',
          segments: [
            // The client had the track, then the fallback took it over for a
            // beat: the same words arrive from both paths.
            { start: 10, end: 12, text: 'ship it friday', speaker: 'Ana', itemId: 'c:ana:1' },
            { start: 11, end: 13, text: 'Ship it Friday', speaker: 'Ana', itemId: 'lk:ana:1' },
            { start: 14, end: 16, text: 'we should ship', speaker: 'Ben', itemId: 'c:ben:1' },
          ],
        },
      },
    })
    await db.huddle.update({ where: { id: huddleId }, data: { startedAt: new Date(Date.now() - 300_000), endedAt: new Date() } })

    await huddles.finalizeHuddleNotes(huddleId)

    const view = await huddles.getHuddleNotes(huddleId, seed.owner)
    expect(view.transcript.segments.map((segment: any) => segment.text)).toEqual(['ship it friday', 'we should ship'])
    expect(view.transcript.segments[0].itemId).toBe('c:ana:1')
    expect(view.transcript.text).toBe('ship it friday we should ship')
  })

  test('a call nobody spoke in leaves nothing behind', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.huddle.update({
      where: { id: huddleId },
      data: { startedAt: new Date(Date.now() - 5 * 60_000), endedAt: new Date() },
    })
    await huddles.finalizeHuddleNotes(huddleId)

    expect(await db.meeting.findUnique({ where: { id: draft.id } })).toBeNull()
    const row = await db.huddle.findUnique({ where: { id: huddleId } })
    expect(row.notesMessageId).toBeNull()
  })

  test('a call under half a minute leaves nothing behind', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.meeting.update({
      where: { id: draft.id },
      data: { transcript: { text: 'Ana: hi', segments: [{ start: 0, end: 1, text: 'hi', speaker: 'Ana' }] } },
    })
    await db.huddle.update({
      where: { id: huddleId },
      data: { startedAt: new Date(Date.now() - 10_000), endedAt: new Date() },
    })
    await huddles.finalizeHuddleNotes(huddleId)

    expect(await db.meeting.findUnique({ where: { id: draft.id } })).toBeNull()
    expect((await db.huddle.findUnique({ where: { id: huddleId } })).notesMessageId).toBeNull()
  })

  test('a call still running is not finalized', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await huddles.finalizeHuddleNotes(huddleId)
    expect(await db.meeting.findUnique({ where: { id: draft.id } })).toBeTruthy()
  })
})

describe('notes left behind by a pod that went away', () => {
  test('an abandoned huddle draft is finished by the sweeper, not by the recorder sweeper', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.huddle.update({
      where: { id: huddleId },
      // Well past the orphan window, as a pod that died mid-call would leave it.
      data: { startedAt: new Date(Date.now() - 6 * 60_000), endedAt: new Date(Date.now() - 4 * 60_000) },
    })

    // The recorder sweeper leaves huddle drafts to this one.
    expect(await meetings.sweepStaleRecordingDrafts()).toBe(0)
    expect(await db.meeting.findUnique({ where: { id: draft.id } })).toBeTruthy()

    expect(await meetings.sweepOrphanedHuddleDrafts()).toBe(1)
    // A huddle nobody spoke in leaves nothing behind, but the draft is settled.
    expect(await db.meeting.findUnique({ where: { id: draft.id } })).toBeNull()
  })

  test('a call that just ended keeps its draft, so the streamers can flush into it', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.huddle.update({
      where: { id: huddleId },
      data: { startedAt: new Date(Date.now() - 60_000), endedAt: new Date(Date.now() - 1_000) },
    })
    expect(await meetings.sweepOrphanedHuddleDrafts()).toBe(0)
    expect(await db.meeting.findUnique({ where: { id: draft.id } })).toBeTruthy()
  })
})

describe('deleting the notes', () => {
  test('the person who started the huddle deletes them, and the message says so', async () => {
    const { conv, huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    await db.meeting.update({
      where: { id: draft.id },
      data: { status: 'ready', enhancedNotes: '## Notes\n- ship it', enhanceStatus: 'ready' },
    })
    await db.huddle.update({ where: { id: huddleId }, data: { endedAt: new Date() } })
    await huddles.finalizeHuddleNotes(huddleId)
    const posted = await db.huddle.findUnique({ where: { id: huddleId } })

    await huddles.deleteHuddleNotes(huddleId, seed.owner)
    expect(await db.meeting.findUnique({ where: { id: draft.id } })).toBeNull()
    const message = await db.conversationMessage.findUnique({ where: { id: posted.notesMessageId } })
    expect(message.text).toBe('Huddle notes deleted.')
    expect(message.blocks.huddleNotes).toEqual({ huddleId, meetingId: null, title: null, status: 'deleted' })
    expect((await db.huddle.findUnique({ where: { id: huddleId } })).notesMessageId).toBeNull()
    await expect(huddles.getHuddleNotes(huddleId, seed.owner)).rejects.toMatchObject({ code: 'no_notes' })
    expect(conv.id).toBeTruthy()
  })

  test('someone else in the call may not delete them', async () => {
    const { huddleId } = await liveHuddle()
    await expect(huddles.deleteHuddleNotes(huddleId, seed.member)).rejects.toMatchObject({ status: 403 })
  })
})
