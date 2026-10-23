// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who is transcribing whom, and what to do when that changes mid-call.
 *
 * Every mic track is covered by exactly one transcriber: its owner's device
 * (`notes: 'self'`), a web/desktop coverer (`notesCovering: 'a,b'`), or the
 * hidden LiveKit agent, which only picks up a track that has been uncovered for
 * `FALLBACK_DELAY_MS`. When the two paths do overlap around a handover, both
 * write the same words, so the transcript is de-duplicated before the summary.
 *
 * Pure functions only: the worker passes in what it saw, so this is testable
 * without a room, and the same rules run on every pod.
 */

/** Participant attribute a device sets to `self` while it streams its own mic. */
export const NOTES_ATTRIBUTE = 'notes'
/** Participant attribute a coverer sets to the identities whose tracks it streams. */
export const NOTES_COVERING_ATTRIBUTE = 'notesCovering'

/** How long a track must be uncovered before the fallback takes it. */
export const FALLBACK_DELAY_MS = 5_000
/** How quickly the fallback gives a track back once a client covers it again. */
export const FALLBACK_RELEASE_MS = 1_000
/** How often the fallback re-reads the room's participant attributes. */
export const NOTES_COVERAGE_TICK_MS = 1_000

/** The minimum a participant needs for a coverage decision. */
export interface NotesParticipant {
  identity: string
  /** False for the hidden agent itself and for anyone not publishing a mic. */
  hasMicrophone?: boolean
  muted?: boolean
  attributes?: Record<string, string> | null
}

/** LiveKit identity of the hidden fallback agent; never a participant people see. */
export const NOTES_AGENT_IDENTITY = 'huddle-notes'

export function isNotesAgent(identity: string): boolean {
  return identity === NOTES_AGENT_IDENTITY || identity.startsWith(`${NOTES_AGENT_IDENTITY}-`)
}

/** Identities a coverer says it is streaming, from its `notesCovering` attribute. */
export function parseCovering(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Which identities clients are already transcribing: their own device saying
 * `notes: 'self'`, or somebody else's `notesCovering` naming them. A track with
 * no microphone, or a muted one, never needs covering.
 */
export function coveredIdentities(participants: NotesParticipant[]): Set<string> {
  const covered = new Set<string>()
  for (const participant of participants) {
    if (isNotesAgent(participant.identity)) continue
    const attributes = participant.attributes ?? {}
    if (attributes[NOTES_ATTRIBUTE] === 'self') covered.add(participant.identity)
    for (const identity of parseCovering(attributes[NOTES_COVERING_ATTRIBUTE])) covered.add(identity)
  }
  return covered
}

/** Participants the fallback should be transcribing right now. */
export function uncoveredSpeakers(participants: NotesParticipant[]): string[] {
  const covered = coveredIdentities(participants)
  return participants
    .filter((participant) => !isNotesAgent(participant.identity))
    .filter((participant) => participant.hasMicrophone !== false && participant.muted !== true)
    .filter((participant) => !covered.has(participant.identity))
    .map((participant) => participant.identity)
}

/**
 * The fallback's per-call ledger of uncovered streaks: a track only gets an STT
 * stream once it has been uncovered for `FALLBACK_DELAY_MS`, so a browser that
 * is a second slow to start its own stream never gets transcribed twice.
 */
export class NotesCoverage {
  private readonly uncoveredSince = new Map<string, number>()
  private readonly started = new Set<string>()

  constructor(private readonly delayMs = FALLBACK_DELAY_MS) {}

  /**
   * The streams to open now and the ones to close now. A track that stays
   * uncovered is in neither list after its first `start`, so the caller's
   * "already open" set is the source of truth for what keeps running.
   */
  sync(participants: NotesParticipant[], now = Date.now()): { start: string[]; stop: string[] } {
    const uncovered = new Set(uncoveredSpeakers(participants))

    for (const identity of uncovered) {
      if (!this.uncoveredSince.has(identity)) this.uncoveredSince.set(identity, now)
    }
    const start = [...uncovered]
      .filter((identity) => now - (this.uncoveredSince.get(identity) ?? now) >= this.delayMs)
      .filter((identity) => !this.started.has(identity))
    for (const identity of start) this.started.add(identity)

    // Covered (or gone) tracks stop at once: a silent fallback is cheap,
    // double-transcription is not.
    const stop = [...this.started].filter((identity) => !uncovered.has(identity))
    for (const identity of stop) {
      this.started.delete(identity)
      this.uncoveredSince.delete(identity)
    }
    return { start, stop }
  }

  /** Identities the fallback currently has an STT stream open for. */
  get active(): string[] {
    return [...this.started]
  }

  /** Forget everyone, e.g. when notes turn off. */
  clear(): void {
    this.uncoveredSince.clear()
    this.started.clear()
  }
}

/** `c:<speakerId>:<n>` for a client stream, `lk:<identity>:<n>` for the agent. */
export function notesItemSource(itemId: string | null | undefined): 'client' | 'livekit' | null {
  if (!itemId) return null
  if (itemId.startsWith('c:')) return 'client'
  if (itemId.startsWith('lk:')) return 'livekit'
  return null
}

/** Lowercase, strip punctuation and collapse spaces, for near-identical text. */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Token overlap (Jaccard) — 1 when identical, 0 when nothing in common. */
export function textSimilarity(a: string, b: string): number {
  const left = new Set(normalizeForCompare(a).split(' ').filter(Boolean))
  const right = new Set(normalizeForCompare(b).split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return left.size === right.size ? 1 : 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** A transcript segment as finalize sees it. */
export interface HandoverSegment {
  start?: number | null
  end?: number | null
  text: string
  speaker?: string | null
  itemId?: string | null
}

/** Same speaker, overlapping time, near-identical words — one line said once. */
const SIMILARITY_THRESHOLD = 0.6

function overlaps(a: HandoverSegment, b: HandoverSegment): boolean {
  if (a.start == null || b.start == null) return false
  const aEnd = a.end ?? a.start
  const bEnd = b.end ?? b.start
  return a.start <= bEnd && b.start <= aEnd
}

/**
 * Drop the duplicate a handover produces. The two paths transcribe the same
 * audio for a second or two, so one line lands twice with different item ids;
 * keep the client's copy (it has the better speaker label) and drop the
 * fallback's. A line said twice by the same person at the same moment with the
 * same source is left alone — that is a real repeat, and losing it would be a
 * worse bug than keeping it.
 */
export function dedupeHandoverSegments<T extends HandoverSegment>(segments: T[]): T[] {
  const kept: T[] = []
  const dropped = new Set<number>()
  for (let i = 0; i < segments.length; i++) {
    if (dropped.has(i)) continue
    const candidate = segments[i]
    for (let j = i + 1; j < segments.length; j++) {
      if (dropped.has(j)) continue
      const other = segments[j]
      if ((candidate.speaker ?? '') !== (other.speaker ?? '')) continue
      const a = notesItemSource(candidate.itemId)
      const b = notesItemSource(other.itemId)
      if (!a || !b || a === b) continue
      if (!overlaps(candidate, other)) continue
      if (textSimilarity(candidate.text, other.text) < SIMILARITY_THRESHOLD) continue
      // Client wins: its speaker label is the user's own device, not a guess.
      dropped.add(a === 'client' ? j : i)
      if (a !== 'client') break
    }
    if (!dropped.has(i)) kept.push(candidate)
  }
  return kept
}
