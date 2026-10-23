// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live captions for a huddle: whoever transcribes a speaker publishes each
 * partial and final into the room as a LiveKit text stream on
 * `lk.transcription`, so every participant — link guests, phones, desktop —
 * reads captions without a server round-trip. Captions are the notes stream
 * shown live, so with notes off there is nothing to show.
 *
 * This file is the pure part: an event in, the lines to show out.
 */
/** LiveKit's own topic for transcription text streams. */
export const CAPTION_TOPIC = 'lk.transcription'
/** Who said it: a user id, or a guest id. Never the sender's identity (a worker's is empty). */
export const CAPTION_SPEAKER_ATTRIBUTE = 'shogo.speaker'
/** The transcript item this line belongs to — a partial and its final share one. */
export const CAPTION_SEGMENT_ATTRIBUTE = 'lk.segment_id'
/** `'true'` once the recognizer has settled the line. */
export const CAPTION_FINAL_ATTRIBUTE = 'lk.transcription_final'
/** The mic track that was transcribed. */
export const CAPTION_TRACK_ATTRIBUTE = 'lk.transcribed_track_id'

/** A finished line stays up this long, so it can be read. */
export const CAPTION_FINAL_TTL_MS = 8_000
/** A partial that is never settled (the speaker went quiet) still has to go. */
export const CAPTION_PARTIAL_TTL_MS = 15_000
/** Two lines this close in time, from one person, saying the same words are one line. */
export const CAPTION_COLLAPSE_MS = 3_000
/** At most 5 partials a second per speaker reach the room. */
export const CAPTION_PARTIAL_MIN_INTERVAL_MS = 200

export interface CaptionLine {
  /** The transcript item id (`c:…` from a device, `lk:…` from the fallback worker). */
  itemId: string
  speakerId: string
  text: string
  /** Settled by the recognizer: it stays until it expires, and only finals are announced. */
  final: boolean
  /** When this line last changed. */
  at: number
  /** Where the line starts in the call, in seconds. */
  start: number
}

export interface CaptionState {
  /** Oldest first, so the newest line sits at the bottom of the strip. */
  lines: CaptionLine[]
}

export type CaptionEvent =
  | { type: 'partial'; itemId: string; speakerId: string; text: string; at: number; start?: number }
  | { type: 'final'; itemId: string; speakerId: string; text: string; at: number; start?: number }
  | { type: 'expire'; now: number }
  | { type: 'clear' }

export interface CaptionOptions {
  /** Lines on screen at once: 3 on a wide screen, 2 on a phone. */
  window?: number
}

export const EMPTY_CAPTIONS: CaptionState = { lines: [] }

/** Letters and digits only, lowercased: the same words written two ways compare equal. */
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

/** How many lines fit: phones get two, anything wider gets three. */
export function captionWindow(width: number): number {
  return width > 0 && width < 480 ? 2 : 3
}

/** What the strip says while the workspace agent works, answers, or gives up. */
export function captionsNotice(
  wake: { by: string; status: 'running' | 'replied' | 'failed' | 'limit'; reason?: string } | null,
): string | null {
  if (!wake) return null
  if (wake.status === 'limit') return 'Wake limit reached for this call'
  if (wake.status === 'running') return `⚡ Shogo is on it (${wake.by})`
  if (wake.status === 'replied') return 'Shogo replied in chat'
  const reason = wake.reason?.trim()
  return reason ? `Shogo couldn't answer: ${reason}` : "Shogo couldn't answer"
}

/** Whether a partial may be published now, instead of flooding the room. */
export function partialAllowed(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= CAPTION_PARTIAL_MIN_INTERVAL_MS
}

/** The attributes every caption stream carries, as LiveKit wants them: strings. */
export function captionAttributes(input: {
  itemId: string
  speakerId: string
  final: boolean
  trackId?: string | null
}): Record<string, string> {
  const attributes: Record<string, string> = {
    [CAPTION_SEGMENT_ATTRIBUTE]: input.itemId,
    [CAPTION_FINAL_ATTRIBUTE]: input.final ? 'true' : 'false',
    [CAPTION_SPEAKER_ATTRIBUTE]: input.speakerId,
  }
  if (input.trackId) attributes[CAPTION_TRACK_ATTRIBUTE] = input.trackId
  return attributes
}

/**
 * Read a received caption stream's attributes. A participant's own identity is
 * only a last resort: the mobile sender is known here, but a hidden worker's
 * identity arrives empty, so the attribute is the source of truth.
 */
export function captionFromAttributes(
  attributes: Record<string, string> | undefined,
  fallbackSpeakerId?: string | null,
): { itemId: string; speakerId: string; final: boolean } | null {
  const itemId = attributes?.[CAPTION_SEGMENT_ATTRIBUTE]
  const speakerId = attributes?.[CAPTION_SPEAKER_ATTRIBUTE] || fallbackSpeakerId || ''
  if (!itemId || !speakerId) return null
  return { itemId, speakerId, final: attributes?.[CAPTION_FINAL_ATTRIBUTE] === 'true' }
}

/** The name to show for a line: from the roster by id, never from the stream's text. */
export function captionLineLabel(line: CaptionLine, nameOf: (speakerId: string) => string | undefined): string {
  return nameOf(line.speakerId) ?? 'Someone'
}

function upsert(lines: CaptionLine[], next: CaptionLine): CaptionLine[] {
  const index = lines.findIndex((line) => line.itemId === next.itemId)
  if (index < 0) return [...lines, next]
  const copy = [...lines]
  copy[index] = { ...copy[index], ...next }
  return copy
}

/**
 * A final replaces its own partial, and a line the same person said at the same
 * moment — once from their device and once from the fallback worker — is shown
 * once. The kept line stays where it was so the strip doesn't jump.
 */
function collapseFinal(lines: CaptionLine[], next: CaptionLine): CaptionLine[] {
  const twin = lines.findIndex(
    (line) =>
      line.itemId !== next.itemId &&
      line.speakerId === next.speakerId &&
      Math.abs(line.at - next.at) <= CAPTION_COLLAPSE_MS &&
      textSimilarity(line.text, next.text) >= 0.6,
  )
  if (twin < 0) return upsert(lines, next)
  const copy = [...lines]
  copy[twin] = { ...next, start: Math.min(copy[twin].start, next.start) }
  return copy
}

function trimmed(lines: CaptionLine[], window: number): CaptionLine[] {
  return lines.length > window ? lines.slice(lines.length - window) : lines
}

export function captionsReducer(
  state: CaptionState,
  event: CaptionEvent,
  options: CaptionOptions = {},
): CaptionState {
  const window = Math.max(1, options.window ?? 3)
  switch (event.type) {
    case 'clear':
      return state.lines.length ? EMPTY_CAPTIONS : state
    case 'expire': {
      const kept = state.lines.filter((line) =>
        event.now - line.at < (line.final ? CAPTION_FINAL_TTL_MS : CAPTION_PARTIAL_TTL_MS),
      )
      return kept.length === state.lines.length ? state : { lines: trimmed(kept, window) }
    }
    case 'partial': {
      const text = event.text.trim()
      // An empty partial is not a line; it must not clear what is already shown.
      if (!text) return state
      const next: CaptionLine = {
        itemId: event.itemId,
        speakerId: event.speakerId,
        text,
        final: false,
        at: event.at,
        start: event.start ?? 0,
      }
      return { lines: trimmed(upsert(state.lines, next), window) }
    }
    case 'final': {
      const text = event.text.trim()
      if (!text) return state
      const next: CaptionLine = {
        itemId: event.itemId,
        speakerId: event.speakerId,
        text,
        final: true,
        at: event.at,
        start: event.start ?? 0,
      }
      return { lines: trimmed(collapseFinal(state.lines, next), window) }
    }
    default:
      return state
  }
}

/** For tests and logs: whether two lines would be shown as one. */
export function sameUtterance(a: { speakerId: string; text: string; at: number }, b: { speakerId: string; text: string; at: number }): boolean {
  if (a.speakerId !== b.speakerId) return false
  if (Math.abs(a.at - b.at) > CAPTION_COLLAPSE_MS) return false
  if (!normalizeForCompare(a.text) || !normalizeForCompare(b.text)) return false
  return textSimilarity(a.text, b.text) >= 0.6
}
