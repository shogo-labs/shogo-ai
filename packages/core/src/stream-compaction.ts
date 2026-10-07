// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Compaction of a buffered AI SDK UI-message stream for replay.
 *
 * A long turn buffers tens of thousands of tiny frames (one per text, reasoning
 * or tool-input delta). Replaying them one by one makes a reconnecting client
 * rebuild the message chunk by chunk, which takes seconds on a phone. The
 * compacted replay produces the same message with a handful of chunks:
 *
 *   - all deltas of one text / reasoning part are merged into its first delta
 *     (a part runs from its `*-start` to its `*-end`; providers reuse ids
 *     across steps, so merging never crosses a start);
 *   - tool-input deltas are merged per tool call, and dropped entirely once
 *     `tool-input-available` / `tool-input-error` carries the full input;
 *   - `data-turn-seq` heartbeats are dropped; the caller appends one with the
 *     exact current seq so `?fromSeq=N` reconnects stay correct.
 *
 * Anything that isn't a parseable `data: {json}` event is kept verbatim, in
 * place, as is a trailing partial event.
 */

export const TURN_SEQ_EVENT_TYPE = 'data-turn-seq' as const

type Chunk = Record<string, any>
type Entry = { raw: string } | { chunk: Chunk } | null

const DELTA_PART: Record<string, string> = {
  'text-delta': 'text',
  'reasoning-delta': 'reasoning',
}
const PART_BOUNDARY: Record<string, string> = {
  'text-end': 'text',
  'reasoning-end': 'reasoning',
  'text-start': 'text',
  'reasoning-start': 'reasoning',
}

export function compactSseFrames(frames: Uint8Array[]): Uint8Array {
  if (frames.length === 0) return new Uint8Array(0)
  const decoder = new TextDecoder()
  let text = ''
  for (const frame of frames) text += decoder.decode(frame, { stream: true })
  text += decoder.decode()

  const events = text.split('\n\n')
  const tail = events.pop() ?? ''

  const out: Entry[] = []
  const openParts = new Map<string, Chunk>()
  const openToolInputs = new Map<string, number>()

  for (const event of events) {
    const chunk = parseEvent(event)
    if (!chunk) {
      out.push({ raw: event })
      continue
    }
    const type = chunk.type

    if (type === TURN_SEQ_EVENT_TYPE) continue

    if (type in PART_BOUNDARY) {
      openParts.delete(`${PART_BOUNDARY[type]}:${chunk.id}`)
      out.push({ chunk })
      continue
    }

    if (type in DELTA_PART && typeof chunk.delta === 'string') {
      const key = `${DELTA_PART[type]}:${chunk.id}`
      const merged = openParts.get(key)
      if (merged) {
        merged.delta += chunk.delta
        if (chunk.providerMetadata !== undefined) merged.providerMetadata = chunk.providerMetadata
        continue
      }
      const copy = { ...chunk }
      openParts.set(key, copy)
      out.push({ chunk: copy })
      continue
    }

    if (type === 'tool-input-delta' && typeof chunk.inputTextDelta === 'string') {
      const index = openToolInputs.get(chunk.toolCallId)
      const existing = index !== undefined ? out[index] : null
      if (existing && 'chunk' in existing) {
        existing.chunk.inputTextDelta += chunk.inputTextDelta
        continue
      }
      openToolInputs.set(chunk.toolCallId, out.length)
      out.push({ chunk: { ...chunk } })
      continue
    }

    if (type === 'tool-input-available' || type === 'tool-input-error') {
      const index = openToolInputs.get(chunk.toolCallId)
      if (index !== undefined) out[index] = null
      openToolInputs.delete(chunk.toolCallId)
    } else if (type === 'tool-input-start') {
      openToolInputs.delete(chunk.toolCallId)
    }
    out.push({ chunk })
  }

  let result = ''
  for (const entry of out) {
    if (!entry) continue
    result += 'chunk' in entry ? encodeEvent(entry.chunk) : `${entry.raw}\n\n`
  }
  result += tail
  return new TextEncoder().encode(result)
}

export function encodeTurnSeqFrame(turnId: string, seq: number): Uint8Array {
  return new TextEncoder().encode(
    encodeEvent({ type: TURN_SEQ_EVENT_TYPE, data: { turnId, seq }, transient: true }),
  )
}

function encodeEvent(chunk: Chunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function parseEvent(event: string): Chunk | null {
  if (!event.startsWith('data: ') || event.includes('\n')) return null
  const payload = event.slice(6)
  if (!payload.startsWith('{')) return null
  try {
    const chunk = JSON.parse(payload)
    return chunk && typeof chunk.type === 'string' ? chunk : null
  } catch {
    return null
  }
}
