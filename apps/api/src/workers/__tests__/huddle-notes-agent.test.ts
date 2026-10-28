// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The hidden fallback worker, driven without LiveKit: which item id each final
 * gets (one per line, never one per stream), and how a final reaches the API
 * process that is allowed to store it and wake an agent.
 *
 * Both regressions here are SHO-176 defects found while planning SHO-187.
 */

import { describe, expect, test } from 'bun:test'
import { TrackKind } from '@livekit/rtc-node'
import { stt } from '@livekit/agents'
import {
  NOTES_WORKER_TOKEN_ENV,
  postHuddleNoteFinal,
  runNotesJob,
  type NoteFinalInput,
  type NotesJobDeps,
} from '../huddle-notes-agent'

const HUDDLE = 'huddle-1'
const SPEAKER = 'u-ana'

function fakeSpeck(lines: string[]) {
  let finish: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    pushed: 0,
    pushFrame() {
      this.pushed += 1
    },
    endInput: () => finish(),
    async *[Symbol.asyncIterator]() {
      for (const text of lines) {
        yield { type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [{ text }] }
      }
      await ended
    },
  }
}

/** A room with one uncovered participant publishing a mic. */
function fakeRoom(identity: string) {
  const remoteParticipants = new Map<string, any>()
  remoteParticipants.set(identity, {
    identity,
    attributes: {},
    isMicrophoneEnabled: true,
    trackPublications: new Map([
      ['TR_mic', { kind: TrackKind.KIND_AUDIO, source: 1, track: { sid: 'TR_mic' } }],
    ]),
  })
  return { remoteParticipants, localParticipant: { identity: 'huddle-notes' }, on: () => {} }
}

function depsOver(overrides: Partial<NotesJobDeps> = {}) {
  const finals: NoteFinalInput[] = []
  const deps: NotesJobDeps = {
    async appendFinal(input) {
      finals.push({ huddleId: input.huddleId, identity: input.identity, itemId: input.itemId, text: input.text, start: input.start, end: input.end })
    },
    async meteredSeconds() {},
    async notesEnabled() {
      return true
    },
    async balanceOk() {
      return true
    },
    async notesOff() {},
    async startedAt() {
      return 1_000_000 - 10_000
    },
    ...overrides,
  }
  return { deps, finals }
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the job')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('the fallback worker’s finals', () => {
  test('three lines from one stream are three stored finals, each with its own item id', async () => {
    const { deps, finals } = depsOver()
    const room = fakeRoom(SPEAKER)
    const speck = fakeSpeck(['we should ship friday', 'ship it friday', 'and tell the team'])
    let now = 1_000_000

    const job = runNotesJob({
      huddleId: HUDDLE,
      deps,
      room: room as any,
      sttFor: () => ({ stream: () => speck }),
      now: () => now,
    })

    // The job's first tick records when the track was first seen uncovered; only
    // after that does moving the clock past the fallback delay open a stream.
    await new Promise((resolve) => setTimeout(resolve, 250))
    now += 6_000
    await until(() => finals.length === 3)
    room.remoteParticipants.clear()
    await job

    expect(finals.map((final) => final.text)).toEqual(['we should ship friday', 'ship it friday', 'and tell the team'])
    // One id per final: `appendStreamFinal` dedupes per item id, so a shared id
    // would silently drop every line after the first.
    expect(new Set(finals.map((final) => final.itemId)).size).toBe(3)
    expect(finals.map((final) => final.itemId)).toEqual([`lk:${SPEAKER}:1:1`, `lk:${SPEAKER}:1:2`, `lk:${SPEAKER}:1:3`])
  })

  test('a second stream for the same person counts from a fresh stream number', async () => {
    const { deps, finals } = depsOver()
    const room = fakeRoom(SPEAKER)
    let now = 1_000_000

    const job = runNotesJob({
      huddleId: HUDDLE,
      deps,
      room: room as any,
      sttFor: () => ({ stream: () => fakeSpeck(['one', 'two']) }),
      now: () => now,
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    now += 6_000
    await until(() => finals.length === 2)

    // They start streaming their own audio (a coverer took over), so the
    // fallback lets the track go — and picks it up again when it is released.
    const participant = room.remoteParticipants.get(SPEAKER)
    participant.attributes = { notes: 'self' }
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    participant.attributes = {}
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    now += 6_000
    await until(() => finals.length === 4)

    room.remoteParticipants.clear()
    await job
    expect(finals.map((final) => final.itemId)).toEqual([
      `lk:${SPEAKER}:1:1`,
      `lk:${SPEAKER}:1:2`,
      `lk:${SPEAKER}:2:1`,
      `lk:${SPEAKER}:2:2`,
    ])
  }, 20_000)
})

describe('posting a final to the API process', () => {
  const input: NoteFinalInput = {
    huddleId: HUDDLE,
    identity: SPEAKER,
    itemId: `lk:${SPEAKER}:1:1`,
    text: 'hey shogo, make a card',
    start: 4,
    end: 6,
  }

  test('posts the final with the per-boot token to the internal route', async () => {
    process.env[NOTES_WORKER_TOKEN_ENV] = 'token-abc'
    const calls: Array<{ url: string; init: any }> = []
    const ok = await postHuddleNoteFinal(input, {
      url: 'http://127.0.0.1:39100/api/internal/huddle-notes/finals',
      fetchImpl: (async (url: string, init: any) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ ok: true, stored: true }), { status: 200 })
      }) as any,
    })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:39100/api/internal/huddle-notes/finals')
    expect(calls[0].init.headers['x-shogo-notes-worker']).toBe('token-abc')
    expect(JSON.parse(calls[0].init.body)).toEqual(input)
  })

  test('a server error is retried, and a 4xx is not', async () => {
    process.env[NOTES_WORKER_TOKEN_ENV] = 'token-abc'
    let attempts = 0
    const flaky = (async () => {
      attempts += 1
      return new Response('{}', { status: attempts < 3 ? 503 : 200 })
    }) as any
    expect(await postHuddleNoteFinal(input, { url: 'http://x/api/internal/huddle-notes/finals', fetchImpl: flaky })).toBe(true)
    expect(attempts).toBe(3)

    attempts = 0
    const refused = (async () => {
      attempts += 1
      return new Response('{}', { status: 401 })
    }) as any
    expect(await postHuddleNoteFinal(input, { url: 'http://x/api/internal/huddle-notes/finals', fetchImpl: refused })).toBe(false)
    expect(attempts).toBe(1)
  })

  test('with no token in this process, nothing is posted', async () => {
    delete process.env[NOTES_WORKER_TOKEN_ENV]
    let attempts = 0
    const fetchImpl = (async () => {
      attempts += 1
      return new Response('{}', { status: 200 })
    }) as any
    expect(await postHuddleNoteFinal(input, { url: 'http://x/api/internal/huddle-notes/finals', fetchImpl })).toBe(false)
    expect(attempts).toBe(0)
  })
})
