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
import { Hono } from 'hono'
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
    async sendData(room: string, data: Uint8Array, _kind?: unknown, options?: { topic?: string }) {
      roomData.push({ room, topic: options?.topic, payload: JSON.parse(new TextDecoder().decode(data)) })
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
/** What the server pushed over the room data channel, in order. */
const roomData: Array<{ room: string; topic?: string; payload: any }> = []

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const meetings = await import('../services/meeting.service')
const { verifyStreamTicket } = await import('../lib/meeting-stream-ticket')
const huddles = await import('../services/huddle.service')
const wakeService = await import('../services/huddle-wake.service')

// The wake runs the workspace agent; here it only records that it was asked to.
// Spread the real module so the internal app's other importers still link.
const dispatcher = await import('../services/conversation-agent-dispatcher')
const replies: any[] = []
mock.module('../services/conversation-agent-dispatcher', () => ({
  ...dispatcher,
  runAgentReply: async (args: any) => {
    replies.push(args)
  },
}))

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
  replies.length = 0
  roomMetadata.clear()
  roomData.length = 0
  huddles._resetHuddlesForTests()
  wakeService._resetHuddleWakeForTests()
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

describe('a fallback final, written through the API', () => {
  /** The draft's transcript as stored right now. */
  async function transcriptOf(meetingId: string) {
    const row = await db.meeting.findUnique({ where: { id: meetingId } })
    return meetings.readTranscript(row.transcript)!
  }

  test('lands under the speaker’s name and user id, not their raw identity', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)

    const written = await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.member,
      itemId: `lk:${seed.member}:1:1`,
      text: 'we should ship friday',
      start: 4,
      end: 7,
    })

    expect(written).toEqual({ ok: true, stored: true })
    const transcript = await transcriptOf(draft.id)
    expect(transcript.segments).toHaveLength(1)
    expect(transcript.segments[0].speaker).toBe('member')
    expect(transcript.segments[0].speakerId).toBe(seed.member)
    expect(transcript.segments[0].itemId).toBe(`lk:${seed.member}:1:1`)
  })

  test('three finals from one worker stream are three stored lines', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    for (const [n, text] of ['one line', 'two lines', 'three lines'].entries()) {
      await huddles.appendHuddleNoteFinal({
        huddleId,
        identity: seed.member,
        itemId: `lk:${seed.member}:1:${n + 1}`,
        text,
        start: n * 3,
        end: n * 3 + 2,
      })
    }
    expect((await transcriptOf(draft.id)).segments).toHaveLength(3)
  })

  test('the same final posted twice is stored once', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)
    const final = { huddleId, identity: seed.member, itemId: `lk:${seed.member}:1:1`, text: 'only once', start: 1, end: 3 }
    expect(await huddles.appendHuddleNoteFinal(final)).toEqual({ ok: true, stored: true })
    expect(await huddles.appendHuddleNoteFinal(final)).toEqual({ ok: true, stored: false })
    expect((await transcriptOf(draft.id)).segments).toHaveLength(1)
  })

  test('a handover duplicate is removed at finalize, through the writers production uses', async () => {
    const { huddleId } = await liveHuddle()
    const draft = await meetings.ensureHuddleNotesDraft(huddleId)

    // The client's own stream stores the line first (`c:…`, as the stream
    // session writes it), then the fallback's final for the same utterance
    // arrives through the API (`lk:…`) while the track changes hands.
    await meetings.appendStreamFinal(draft.id, {
      itemId: `c:${seed.owner}:item-1`,
      segment: { start: 10, end: 12, text: 'ship it friday' },
      speaker: 'owner',
      speakerId: seed.owner,
    })
    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.owner,
      itemId: `lk:${seed.owner}:1:1`,
      text: 'Ship it Friday',
      start: 11,
      end: 13,
    })
    expect((await transcriptOf(draft.id)).segments).toHaveLength(2)

    // Promote the live transcript the way the end of a call does, then finalize.
    await meetings.finalizeLiveTranscript(draft.id, 60)
    await db.meeting.update({ where: { id: draft.id }, data: { enhanceStatus: 'ready', enhancedNotes: '## Notes\n- ship it' } })
    await db.huddle.update({ where: { id: huddleId }, data: { startedAt: new Date(Date.now() - 120_000), endedAt: new Date() } })
    await huddles.finalizeHuddleNotes(huddleId)

    const view = await huddles.getHuddleNotes(huddleId, seed.owner)
    expect(view.transcript.segments).toHaveLength(1)
    expect(view.transcript.segments[0]).toMatchObject({ text: 'ship it friday', speaker: 'owner', itemId: `c:${seed.owner}:item-1` })
  })

  test('the internal route refuses a call without the worker token, and takes one with it', async () => {
    const { huddleId } = await liveHuddle()
    const { default: internal } = await import('../routes/internal')
    const app = new Hono()
    app.route('/api/internal', internal)
    const body = JSON.stringify({ huddleId, identity: seed.member, itemId: `lk:${seed.member}:2:1`, text: 'hello from the worker', start: 2, end: 4 })

    delete process.env.SHOGO_NOTES_WORKER_TOKEN
    const refused = await app.request('/api/internal/huddle-notes/finals', { method: 'POST', body, headers: { 'content-type': 'application/json' } })
    expect(refused.status).toBe(401)

    process.env.SHOGO_NOTES_WORKER_TOKEN = 'worker-token-for-test'
    try {
      const wrong = await app.request('/api/internal/huddle-notes/finals', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-shogo-notes-worker': 'nope' },
      })
      expect(wrong.status).toBe(401)

      const accepted = await app.request('/api/internal/huddle-notes/finals', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-shogo-notes-worker': 'worker-token-for-test' },
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({ ok: true, stored: true })
    } finally {
      delete process.env.SHOGO_NOTES_WORKER_TOKEN
    }
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

describe('saying "hey Shogo" in a huddle', () => {
  /** The wake is fire-and-forget, so wait for it to land rather than racing it. */
  async function until<T>(read: () => Promise<T | null | undefined>, ms = 4_000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await read()
      if (value) return value
      if (Date.now() > deadline) throw new Error('the wake never happened')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  const wakesOf = (huddleId: string) => db.huddleWake.findMany({ where: { huddleId } })

  test('a spoken phrase posts a note and runs the agent as the person who said it', async () => {
    const { conv, huddleId } = await liveHuddle()
    // A little context before the wake, so the note has something to hand over.
    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.member,
      itemId: `lk:${seed.member}:1:1`,
      text: 'the login button is broken on safari',
      start: 1,
      end: 3,
    })

    const stored = await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.owner,
      itemId: `lk:${seed.owner}:1:1`,
      text: 'hey shogo can you make a card for the login bug',
      start: 4,
      end: 7,
    })
    expect(stored).toEqual({ ok: true, stored: true })

    const row = await until(() => db.huddleWake.findFirst({ where: { huddleId } }))
    expect(row).toMatchObject({ speakerId: seed.owner, itemId: `lk:${seed.owner}:1:1` })

    await until(() => (replies.length ? replies : null))
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ userId: seed.owner })

    const note = await db.conversationMessage.findUnique({ where: { id: row.messageId } })
    expect(note.conversationId).toBe(conv.id)
    expect(note.authorType).toBe('system')
    // The request, and the last minute of the call with a name on every line.
    expect(note.text).toContain('make a card for the login bug')
    expect(note.text).toContain('the login button is broken on safari')
    expect(note.blocks.huddleWake).toMatchObject({ huddleId, speakerId: seed.owner })
    expect((await db.huddle.findUnique({ where: { id: huddleId } })).lastWakeAt).toBeTruthy()

    // The call learns where the agent is without reading the chat bus.
    const statuses = roomData.filter((entry) => entry.payload?.type === 'wake').map((entry) => entry.payload.status)
    expect(statuses).toEqual(['running', 'replied'])
    expect(roomData[0].topic).toBe('shogo.huddle')
    expect(roomData[0].payload.by).toBe('owner')
  })

  test('a second phrase inside 10 s does not start a second run', async () => {
    const { huddleId } = await liveHuddle()
    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.owner,
      itemId: `lk:${seed.owner}:1:1`,
      text: 'hey shogo summarise where we are',
      start: 1,
      end: 3,
    })
    await until(() => db.huddleWake.findFirst({ where: { huddleId } }))
    await until(() => (replies.length ? replies : null))

    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.member,
      itemId: `lk:${seed.member}:1:1`,
      text: 'hey shogo what about the other thing',
      start: 4,
      end: 6,
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await wakesOf(huddleId)).toHaveLength(1)
    expect(replies).toHaveLength(1)
  })

  test('the same transcript item can never wake twice', async () => {
    const { huddleId } = await liveHuddle()
    const text = 'hey shogo file this as a bug please'
    await huddles.appendHuddleNoteFinal({ huddleId, identity: seed.owner, itemId: 'lk:dup:1', text, start: 1, end: 3 })
    await until(() => db.huddleWake.findFirst({ where: { huddleId } }))
    // Move the cooldown out of the way, leaving the item-id guard as the only thing left.
    await db.huddle.update({ where: { id: huddleId }, data: { lastWakeAt: new Date(Date.now() - 60_000) } })
    await huddles.appendHuddleNoteFinal({ huddleId, identity: seed.owner, itemId: 'lk:dup:1', text, start: 1, end: 3 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await wakesOf(huddleId)).toHaveLength(1)
  })

  test('a guest’s words are captioned but never woken', async () => {
    const { huddleId } = await liveHuddle()
    wakeService.onHuddleFinalStored({
      meetingId: (await meetings.ensureHuddleNotesDraft(huddleId)).id,
      huddleId,
      itemId: 'lk:guest:1',
      speakerId: `guest_${crypto.randomUUID().slice(0, 6)}`,
      speaker: 'Guest',
      segment: { start: 1, end: 3, text: 'hey shogo can you hear the guest' },
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await wakesOf(huddleId)).toHaveLength(0)
    expect(replies).toHaveLength(0)
  })

  test('with the notes off there is nothing to wake from', async () => {
    const { huddleId } = await liveHuddle()
    await db.huddle.update({ where: { id: huddleId }, data: { notesEnabled: false } })
    wakeService.onHuddleFinalStored({
      meetingId: (await meetings.ensureHuddleNotesDraft(huddleId)).id,
      huddleId,
      itemId: 'lk:owner:9',
      speakerId: seed.owner,
      speaker: 'owner',
      segment: { start: 1, end: 3, text: 'hey shogo are the notes even on' },
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await wakesOf(huddleId)).toHaveLength(0)
    expect(replies).toHaveLength(0)
  })

  // QA (SHO-187): the answer has to land where the call's chat panel reads it,
  // and a call that has used up its wakes or lost its speaker must stay quiet.
  test('a channel huddle puts the note and the agent’s answer in the huddle’s thread', async () => {
    const { huddleId } = await liveHuddle()
    const huddle = await db.huddle.findUnique({ where: { id: huddleId } })
    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.owner,
      itemId: 'lk:thread:1',
      text: 'hey shogo where did we land on the release',
      start: 1,
      end: 3,
    })
    const row = await until(() => db.huddleWake.findFirst({ where: { huddleId } }))
    await until(() => (replies.length ? replies : null))

    const note = await db.conversationMessage.findUnique({ where: { id: row.messageId } })
    expect(note.threadRootId).toBe(huddle.messageId)
    // HuddleThreadPanel reads that thread, so the answer must be written into it.
    expect(replies[0].threadRootId).toBe(huddle.messageId)
  })

  test('a DM huddle puts the note and the answer at the top level, where its chat panel reads', async () => {
    const dm = await service.openDirectConversation(seed.workspaceId, seed.owner, [seed.member])
    await huddles.joinHuddle(dm.id, seed.owner)
    const joined = await huddles.joinHuddle(dm.id, seed.member)
    const huddleId = joined.huddle.id

    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.owner,
      itemId: 'lk:dm:1',
      text: 'hey shogo make a card for the safari login bug',
      start: 1,
      end: 3,
    })
    const row = await until(() => db.huddleWake.findFirst({ where: { huddleId } }))
    await until(() => (replies.length ? replies : null))

    const note = await db.conversationMessage.findUnique({ where: { id: row.messageId } })
    expect(note.conversationId).toBe(dm.id)
    // A thread here is a thread the call's chat panel never shows.
    expect(note.threadRootId).toBeNull()
    expect(replies[0].threadRootId).toBeNull()
  })

  test('someone who has left the call cannot wake the agent', async () => {
    const { conv, huddleId } = await liveHuddle()
    await huddles.leaveHuddle(conv.id, seed.member)
    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.member,
      itemId: 'lk:left:1',
      text: 'hey shogo am I still here',
      start: 1,
      end: 3,
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await wakesOf(huddleId)).toHaveLength(0)
    expect(replies).toHaveLength(0)
  })

  test('a call that has used its 20 wakes stays quiet, and says nothing it cannot back up', async () => {
    const { huddleId } = await liveHuddle()
    const wakeAt = Date.now() - 5 * 60_000
    await db.huddleWake.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        huddleId,
        speakerId: seed.owner,
        itemId: `lk:used:${i}`,
        status: 'replied',
        createdAt: new Date(wakeAt + i * 1_000),
      })),
    })
    const before = await db.conversationMessage.count({})

    await huddles.appendHuddleNoteFinal({
      huddleId,
      identity: seed.owner,
      itemId: 'lk:cap:1',
      text: 'hey shogo one more thing',
      start: 320,
      end: 322,
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await wakesOf(huddleId)).toHaveLength(20)
    expect(replies).toHaveLength(0)
    expect(await db.conversationMessage.count({})).toBe(before)

    // The call is told the cap was reached, so "hey Shogo" going quiet does not
    // look like a broken agent — and it says nothing it cannot back up: no note,
    // no run, just the one notice.
    const notices = roomData.filter((entry) => entry.payload?.type === 'wake')
    expect(notices.map((entry) => entry.payload.status)).toEqual(['limit'])
    expect(notices[0].topic).toBe('shogo.huddle')
    expect(notices[0].payload.by).toBe('owner')
    expect(notices[0].payload.messageId).toBeUndefined()
  })
})
