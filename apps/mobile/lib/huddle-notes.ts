// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle notes: every participant's own device streams its microphone through
 * the meeting live-stream pipeline, so each line of the transcript carries a
 * speaker without diarization. One draft `Meeting` per huddle collects them
 * all; the server writes the summary when the call ends.
 *
 * A phone can't tap PCM out of LiveKit RN, so one web or desktop participant
 * covers it: that client taps the phone's remote audio and sends it under the
 * phone's name. `pickNotesCoverer` names exactly one coverer per roster, so the
 * same person is never transcribed twice.
 *
 * A muted mic is a disabled LiveKit track, so the tap reads silence and nothing
 * is sent: what the room didn't hear is not in the transcript.
 */
import type { HuddleRemoteAudio } from './huddle-room'
import { createLiveAudioContext, createPcmTap, type LiveCapture, type LiveChunk, type PcmTap } from './live-audio'
import { startAdaptiveLive, type AdaptiveLiveOptions } from './live-transcription'

/** One person in the call, as the coverer decision needs to see them. */
export interface NotesPeer {
  userId: string
  /** In the room right now. */
  present: boolean
  /** Their own device is streaming their audio. */
  self: boolean
  /** Their device can't stream its own audio (a phone), so someone has to cover them. */
  needsCover: boolean
}

/** Long enough for a browser that just joined to publish its own stream. */
export const COVER_GRACE_MS = 3_000

/** What this device is doing about notes. */
export type NotesMode =
  /** Not writing notes: the call's toggle is off, or notes can't run. */
  | 'off'
  /** Connecting this device's audio. */
  | 'starting'
  /** Streaming, at least for this device. */
  | 'live'
  /** This device can't stream (a phone): a web or desktop participant covers it. */
  | 'unsupported'
  /** The server can't transcribe right now; `message` says why. */
  | 'unavailable'

export interface HuddleNotesStatus {
  mode: NotesMode
  /** Why notes aren't running, when they aren't. */
  message: string | null
  /** People this device transcribes on their behalf. */
  covering: string[]
}

/**
 * Which single client covers the phones: the lowest user id that can stream.
 * Everyone derives the same answer from the same roster, so exactly one device
 * taps each phone.
 */
export function pickNotesCoverer(peers: readonly NotesPeer[]): string | null {
  const capable = peers
    .filter((p) => p.present && !p.needsCover)
    .map((p) => p.userId)
    .sort()
  return capable[0] ?? null
}

export interface CoverageInput {
  selfId: string
  /** From `pickNotesCoverer` for this roster. */
  covererId: string | null
  peers: readonly NotesPeer[]
  /** When each person was first seen without a stream of their own. */
  waitingSince: ReadonlyMap<string, number>
  now: number
  graceMs?: number
}

/**
 * The people this device transcribes on their behalf. Only the coverer acts,
 * and only for people who still have no stream of their own after the grace, so
 * a browser that is a second slow to publish is never doubled up.
 */
export function notesCoverTargets(input: CoverageInput): string[] {
  if (!input.covererId || input.covererId !== input.selfId) return []
  const grace = input.graceMs ?? COVER_GRACE_MS
  return input.peers
    .filter((p) => p.present && p.userId !== input.selfId && !p.self)
    .filter((p) => input.now - (input.waitingSince.get(p.userId) ?? input.now) >= grace)
    .map((p) => p.userId)
    .sort()
}

/** What the pill shows: the call-wide toggle plus what this device is doing. */
export type NotesPillState = HuddleNotesStatus & { enabled: boolean }

/** The one-line summary of the call's notes state. Shared by the window, mini card and PiP. */
export function notesPillLabel(notes: NotesPillState): string {
  if (!notes.enabled) return 'Notes off'
  if (notes.mode === 'unavailable') return notes.message ? `Notes incomplete: ${notes.message}` : 'Notes unavailable'
  if (notes.mode === 'unsupported') return 'Notes need someone on web or desktop'
  if (notes.covering.length) return `Notes on · ${notes.covering.length} covered`
  return 'Notes on'
}

/** `warn` is for notes that can't run here; `on` and `off` are just the toggle. */
export function notesPillTone(notes: NotesPillState): 'on' | 'off' | 'warn' {
  if (!notes.enabled) return 'off'
  if (notes.mode === 'unavailable' || notes.mode === 'unsupported') return 'warn'
  return 'on'
}

/** Whether this build can tap PCM at all. Phones can't, so they report `unsupported`. */
export function notesSupportedHere(): boolean {
  const g = globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown }
  return !!(g.AudioContext || g.webkitAudioContext)
}

export interface HuddleNotesTicketLike {
  ticket: string
  path: string
  backend: string
}

export interface HuddleNotesOptions {
  selfId: string
  /** `ws://` or `wss://` origin of the API. */
  wsBase: string
  /** A ticket for one person's audio; `forUserId` is set only when covering someone. */
  ticket(forUserId: string | null): Promise<HuddleNotesTicketLike>
  /** Upload one WAV chunk for one person, when the socket can't run. */
  postChunk(forUserId: string | null, chunk: LiveChunk): Promise<void>
  /** This device's microphone, as a MediaStream. */
  getLocalStream(): MediaStream | null
  /** Everyone else's microphone, for covering. */
  getRemoteStreams(): HuddleRemoteAudio[]
  /** The current roster, from the room. */
  getPeers(): NotesPeer[]
  /**
   * Whether that person's mic is muted right now (`null` = this device's own).
   * Muted audio is never forwarded, so it is never transcribed or billed.
   */
  isMuted?(forUserId: string | null): boolean
  /** Publish whether this device streams its own audio (`'self'`, `'unsupported'`, `''`). */
  setSource(state: 'self' | 'unsupported' | ''): Promise<void>
  onStatus?(status: HuddleNotesStatus): void
  /** Injected in tests; defaults to Web Audio and the real socket. */
  createTap?(stream: MediaStream, context: AudioContext | null): PcmTap | null
  startCapture?(options: AdaptiveLiveOptions): LiveCapture
}

export interface HuddleNotesEngine {
  /** Recompute what this device streams. Call after the roster, mic or toggle changes. */
  sync(): void
  /** Stop every stream (leaving the call, notes off, call ended). */
  stop(options?: { discard?: boolean }): Promise<void>
  status(): HuddleNotesStatus
}

const SELF_KEY = 'me'

/** The HTTP status of a failed ticket or chunk, if it had one. */
function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export function startHuddleNotes(options: HuddleNotesOptions): HuddleNotesEngine {
  const canStream = !!options.createTap || notesSupportedHere()
  const sessions = new Map<string, LiveCapture>()
  const waitingSince = new Map<string, number>()
  /** People whose stream failed (not in the call any more, notes refused): don't retry until they change. */
  const failed = new Set<string>()
  let context: AudioContext | null = null
  let source: 'self' | 'unsupported' | '' = ''
  let mode: NotesMode = 'starting'
  let message: string | null = null
  let stopping = false

  const status = (): HuddleNotesStatus => ({
    mode: stopping ? 'off' : mode,
    message: stopping ? null : message,
    covering: [...sessions.keys()].filter((k) => k !== SELF_KEY),
  })

  const emit = () => options.onStatus?.(status())

  const claim = (next: 'self' | 'unsupported' | '') => {
    if (source === next) return
    source = next
    void options.setSource(next).catch(() => {})
  }

  /** The server can't help any more (no recognizer, notes off, call over). */
  const unavailable = (reason: string) => {
    message = reason
    mode = 'unavailable'
    for (const [key, capture] of sessions) {
      sessions.delete(key)
      void capture.stop({ discard: true }).catch(() => {})
    }
    // Let another device cover us: we are not streaming our own audio.
    claim('unsupported')
    emit()
  }

  const failedFor = (err: unknown) => {
    const status = statusOf(err)
    // 409 notes_off / huddle_ended, 502 no recognizer here: nothing to retry for anyone.
    if (status === 409 || status === 502) unavailable(messageOf(err, 'Notes are unavailable'))
  }

  const open = (key: string, stream: MediaStream, forUserId: string | null): boolean => {
    const createTap = options.createTap ?? createPcmTap
    const startCapture = options.startCapture ?? startAdaptiveLive
    if (!context) context = createLiveAudioContext()
    const tap = createTap(stream, context)
    if (!tap) {
      failed.add(key)
      return false
    }
    const capture = startCapture({
      tap,
      wsBase: options.wsBase,
      isMuted: () => options.isMuted?.(forUserId) === true,
      getTicket: async () => {
        try {
          return await options.ticket(forUserId)
        } catch (err) {
          failed.add(key)
          failedFor(err)
          throw err
        }
      },
      postChunk: async (chunk) => {
        try {
          await options.postChunk(forUserId, chunk)
        } catch (err) {
          // 409/404: the call ended or this person left. Anything else keeps the audio.
          if (statusOf(err) === 409 || statusOf(err) === 404) failed.add(key)
          failedFor(err)
          throw err
        }
      },
    })
    sessions.set(key, capture)
    if (!forUserId) {
      mode = 'live'
      message = null
      claim('self')
    }
    return true
  }

  const close = (key: string) => {
    const capture = sessions.get(key)
    if (!capture) return
    sessions.delete(key)
    void capture.stop({ discard: true }).catch(() => {})
  }

  const sync = () => {
    if (stopping) return
    if (!canStream) {
      // A phone: no PCM tap, so a web or desktop participant transcribes for us.
      mode = 'unsupported'
      claim('unsupported')
      emit()
      return
    }
    const peers = options.getPeers()
    const present = new Map(peers.filter((p) => p.present).map((p) => [p.userId, p]))

    // Forget people who left or now stream themselves.
    for (const id of [...waitingSince.keys()]) {
      const peer = present.get(id)
      if (!peer || peer.self) waitingSince.delete(id)
    }
    for (const id of [...failed]) {
      const peer = present.get(id)
      if (!peer || peer.self) failed.delete(id)
    }

    if (!sessions.has(SELF_KEY) && !failed.has(SELF_KEY)) {
      const stream = options.getLocalStream()
      if (stream) open(SELF_KEY, stream, null)
      else if (mode === 'live') mode = 'starting'
    }

    const now = Date.now()
    for (const peer of peers) {
      if (peer.present && !peer.self && peer.userId !== options.selfId && !waitingSince.has(peer.userId)) {
        waitingSince.set(peer.userId, now)
      }
    }
    const targets = new Set(
      notesCoverTargets({
        selfId: options.selfId,
        covererId: pickNotesCoverer(peers),
        peers,
        waitingSince,
        now,
      }),
    )
    for (const key of [...sessions.keys()]) {
      if (key !== SELF_KEY && !targets.has(key)) close(key)
    }
    if (targets.size) {
      const remote = options.getRemoteStreams()
      for (const id of targets) {
        if (sessions.has(id) || failed.has(id)) continue
        const audio = remote.find((r) => r.userId === id)
        if (audio) open(id, audio.stream, id)
      }
    }
    if (sessions.size > 1) {
      mode = 'live'
      message = null
    }
    emit()
  }

  const stop = async (stopOptions: { discard?: boolean } = {}) => {
    if (stopping) return
    stopping = true
    const captures = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(captures.map((capture) => capture.stop({ discard: stopOptions.discard === true })))
    claim('')
    source = ''
    emit()
  }

  return { sync, stop, status }
}
