// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from 'bun:test'
import type { HuddleRemoteAudio } from '../huddle-room'
import {
  COVER_GRACE_MS,
  notesCoverTargets,
  notesPillLabel,
  notesPillTone,
  pickNotesCoverer,
  startHuddleNotes,
  type HuddleNotesOptions,
  type HuddleNotesStatus,
  type NotesPeer,
  type NotesPillState,
} from '../huddle-notes'
import type { LiveCapture } from '../live-audio'
import type { AdaptiveLiveOptions } from '../live-transcription'

const peer = (userId: string, over: Partial<NotesPeer> = {}): NotesPeer => ({
  userId,
  present: true,
  self: false,
  needsCover: false,
  ...over,
})

const pill = (over: Partial<NotesPillState> = {}): NotesPillState => ({
  enabled: true,
  mode: 'live',
  message: null,
  covering: [],
  ...over,
})

const remote = (userId: string): HuddleRemoteAudio => ({
  userId,
  stream: {} as MediaStream,
  notesSelf: false,
  notesNeedsCover: true,
})

const realNow = Date.now
const clock = { offset: 0 }

afterEach(() => {
  Date.now = realNow
  clock.offset = 0
})

function advance(ms: number) {
  clock.offset += ms
}

interface Capture extends LiveCapture {
  options: AdaptiveLiveOptions
  stopped: boolean
}

/** Runs the engine with a fake tap and a fake capture, recording what it asked for. */
function harness(
  peers: NotesPeer[],
  remotes: string[],
  options: { localStream?: boolean; coverer?: boolean } = {},
  over: Partial<HuddleNotesOptions> = {},
) {
  Date.now = () => realNow() + clock.offset
  const captures: Capture[] = []
  const sources: string[] = []
  const tickets: Array<string | null> = []
  const chunks: Array<string | null> = []
  let roster = peers
  let ticketError: unknown = null
  let status: HuddleNotesStatus | null = null

  const engine = startHuddleNotes({
    selfId: 'me',
    wsBase: 'wss://api.test',
    ticket: async (forUserId) => {
      tickets.push(forUserId)
      if (ticketError) throw ticketError
      return { ticket: `t:${forUserId ?? 'self'}`, path: '/api/meetings/live-stream', backend: 'openai' }
    },
    postChunk: async (forUserId) => {
      chunks.push(forUserId)
    },
    getLocalStream: () => (options.localStream === false ? null : ({} as MediaStream)),
    getRemoteStreams: () => remotes.map(remote),
    getPeers: () => roster,
    setSource: async (state) => {
      sources.push(state)
    },
    onStatus: (next) => {
      status = next
    },
    ...(options.coverer === false
      ? {}
      : {
          createTap: () => ({ sampleRate: 16_000, attach() {}, disconnect() {}, close() {} }),
        }),
    startCapture: (captureOptions) => {
      const capture: Capture = {
        options: captureOptions,
        stopped: false,
        stop: async (stopOptions?: { discard?: boolean }) => {
          capture.stopped = true
          return { complete: stopOptions?.discard === true, chunks: 0, seconds: 0 }
        },
      } as unknown as Capture
      captures.push(capture)
      return capture
    },
    ...over,
  })

  return {
    engine,
    captures,
    sources,
    tickets,
    chunks,
    status: () => (status ?? engine.status()) as HuddleNotesStatus,
    setPeers: (next: NotesPeer[]) => {
      roster = next
    },
    failTicketWith: (err: unknown) => {
      ticketError = err
    },
  }
}

describe('pickNotesCoverer', () => {
  test('is the lowest user id that can stream, so every client agrees', () => {
    expect(pickNotesCoverer([peer('ana'), peer('ben'), peer('cy')])).toBe('ana')
    expect(pickNotesCoverer([peer('zoe'), peer('ana')])).toBe('ana')
  })

  test('skips phones, which cannot tap their own audio', () => {
    expect(pickNotesCoverer([peer('ana', { needsCover: true }), peer('ben')])).toBe('ben')
  })

  test('skips people who left, and is null when nobody can stream', () => {
    expect(pickNotesCoverer([peer('ana', { present: false }), peer('ben', { needsCover: true })])).toBeNull()
    expect(pickNotesCoverer([])).toBeNull()
  })
})

describe('notesCoverTargets', () => {
  const base = {
    selfId: 'me',
    covererId: 'me',
    peers: [peer('me'), peer('phone', { needsCover: true })],
    waitingSince: new Map([['phone', 0]]),
    now: COVER_GRACE_MS,
  }

  test('only the coverer covers', () => {
    expect(notesCoverTargets({ ...base, covererId: 'ana' })).toEqual([])
    expect(notesCoverTargets(base)).toEqual(['phone'])
  })

  test('waits out the grace, so a browser starting up is never doubled', () => {
    expect(notesCoverTargets({ ...base, now: COVER_GRACE_MS - 1 })).toEqual([])
    expect(notesCoverTargets({ ...base, now: COVER_GRACE_MS })).toEqual(['phone'])
  })

  test('covers a browser with no stream of its own, not just phones', () => {
    const peers = [peer('me'), peer('quiet')]
    expect(
      notesCoverTargets({ ...base, peers, waitingSince: new Map([['quiet', 0]]) }),
    ).toEqual(['quiet'])
  })

  test('drops a peer the moment it streams itself, and never covers the coverer', () => {
    const peers = [peer('me'), peer('phone', { needsCover: true, self: true }), peer('ana')]
    const waitingSince = new Map([
      ['phone', 0],
      ['ana', 0],
    ])
    expect(notesCoverTargets({ ...base, peers, waitingSince })).toEqual(['ana'])
  })

  test('leaves people who are not in the call alone', () => {
    const peers = [peer('me'), peer('gone', { present: false, needsCover: true })]
    expect(notesCoverTargets({ ...base, peers })).toEqual([])
  })
})

describe('notesPillLabel', () => {
  test('says what the call is doing, and why when it cannot', () => {
    expect(notesPillLabel(pill())).toBe('Notes on')
    expect(notesPillLabel(pill({ covering: ['ana'] }))).toBe('Notes on · 1 covered')
    expect(notesPillLabel(pill({ enabled: false, mode: 'off' }))).toBe('Notes off')
    expect(notesPillLabel(pill({ mode: 'unsupported' }))).toBe('Notes need someone on web or desktop')
    expect(notesPillLabel(pill({ mode: 'unavailable', message: 'no recognizer' }))).toBe('Notes incomplete: no recognizer')
    expect(notesPillLabel(pill({ mode: 'unavailable' }))).toBe('Notes unavailable')
  })

  test('warns only when notes cannot run here', () => {
    expect(notesPillTone(pill())).toBe('on')
    expect(notesPillTone(pill({ enabled: false, mode: 'off' }))).toBe('off')
    expect(notesPillTone(pill({ mode: 'unsupported' }))).toBe('warn')
    expect(notesPillTone(pill({ mode: 'unavailable' }))).toBe('warn')
  })
})

describe('startHuddleNotes', () => {
  test('each stream knows when its speaker is muted, so silence is never forwarded', () => {
    let anaMuted = false
    const h = harness([peer('me'), peer('ana', { needsCover: true })], ['ana'], {}, {
      isMuted: (forUserId) => (forUserId === 'ana' ? anaMuted : true),
    })
    h.engine.sync()
    advance(COVER_GRACE_MS + 1)
    h.engine.sync()
    expect(h.captures).toHaveLength(2)
    // Our own mic is muted, and the capture has to know that continuously.
    expect(h.captures[0].options.isMuted?.()).toBe(true)
    expect(h.captures[1].options.isMuted?.()).toBe(false)
    anaMuted = true
    expect(h.captures[1].options.isMuted?.()).toBe(true)
  })

  test('streams this device and tells the room it is the one doing it', () => {
    const h = harness([peer('me'), peer('ana', { self: true })], [])
    h.engine.sync()
    expect(h.captures).toHaveLength(1)
    expect(h.sources).toEqual(['self'])
    expect(h.status()).toMatchObject({ mode: 'live', message: null, covering: [] })
  })

  test('a device that cannot tap PCM streams nothing and asks to be covered', () => {
    const h = harness([peer('me', { needsCover: true }), peer('ana')], [], { coverer: false })
    h.engine.sync()
    expect(h.captures).toHaveLength(0)
    expect(h.sources).toEqual(['unsupported'])
    expect(h.status().mode).toBe('unsupported')
  })

  test('the coverer taps a peer under that peer’s name, and stops when it streams itself', () => {
    const h = harness([peer('me'), peer('ana', { needsCover: true })], ['ana'])
    h.engine.sync()
    // The grace has not passed yet: only our own stream is open.
    expect(h.captures).toHaveLength(1)
    advance(COVER_GRACE_MS + 1)
    h.engine.sync()
    expect(h.captures).toHaveLength(2)
    expect(h.status().covering).toEqual(['ana'])
    expect(h.status().mode).toBe('live')

    h.setPeers([peer('me'), peer('ana', { needsCover: true, self: true })])
    h.engine.sync()
    expect(h.captures[1].stopped).toBe(true)
    expect(h.status().covering).toEqual([])
  })

  test('someone else being the coverer leaves the phone alone', () => {
    const h = harness([peer('aaa'), peer('me'), peer('phone', { needsCover: true })], ['phone'])
    h.engine.sync()
    advance(COVER_GRACE_MS + 1)
    h.engine.sync()
    expect(h.captures).toHaveLength(1)
    expect(h.status().covering).toEqual([])
  })

  test('a phone that left is not covered, and a failed peer is not retried', () => {
    const h = harness([peer('me'), peer('phone', { needsCover: true })], ['phone'])
    h.engine.sync()
    advance(COVER_GRACE_MS + 1)
    h.engine.sync()
    expect(h.status().covering).toEqual(['phone'])

    h.setPeers([peer('me')])
    h.engine.sync()
    expect(h.captures.at(-1)?.stopped).toBe(true)
    expect(h.status().covering).toEqual([])
  })

  test('a ticket the server refuses as unavailable turns notes off for the whole call', async () => {
    const h = harness([peer('me')], [])
    h.engine.sync()
    h.failTicketWith(Object.assign(new Error('No recognizer configured'), { status: 502 }))
    await expect(h.captures[0].options.getTicket()).rejects.toThrow('No recognizer configured')
    expect(h.status()).toMatchObject({ mode: 'unavailable', message: 'No recognizer configured' })
    expect(h.captures[0].stopped).toBe(true)
    expect(h.sources.at(-1)).toBe('unsupported')
  })

  test('a missing local stream keeps the engine from claiming to be live', () => {
    const h = harness([peer('me')], [], { localStream: false })
    h.engine.sync()
    expect(h.captures).toHaveLength(0)
    expect(h.status().mode).toBe('starting')
    expect(h.sources).toEqual([])
  })

  test('stops every stream and clears the attribute on teardown', async () => {
    const h = harness([peer('me'), peer('ana', { needsCover: true })], ['ana'])
    h.engine.sync()
    advance(COVER_GRACE_MS + 1)
    h.engine.sync()
    expect(h.captures).toHaveLength(2)

    await h.engine.stop({ discard: true })
    expect(h.captures.every((c) => c.stopped)).toBe(true)
    expect(h.sources.at(-1)).toBe('')
    expect(h.status()).toMatchObject({ mode: 'off', covering: [] })
  })

  test('a stopped engine stays stopped when the roster changes', async () => {
    const h = harness([peer('me'), peer('ana')], [])
    h.engine.sync()
    await h.engine.stop()
    h.engine.sync()
    expect(h.captures).toHaveLength(1)
    expect(h.status().mode).toBe('off')
  })
})
