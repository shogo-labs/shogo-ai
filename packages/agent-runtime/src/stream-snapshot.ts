// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Snapshot replay for a client that joins a live turn.
 *
 * Replaying the buffered stream, even compacted, makes the client run every
 * chunk through the AI SDK and re-render the growing message. A joining client
 * instead gets the message assembled so far in a single `data-message-snapshot`
 * chunk, followed by only what is still open as a compacted stream, then the
 * live frames.
 *
 * The snapshot covers everything up to the last point where no part is open:
 * every text / reasoning part has ended and every tool call has its final
 * output. Only there can the SDK on the client (which throws on a delta for a
 * part it never saw open) pick the stream up from the continuation.
 *
 * A step boundary is such a point, but the runtime opens one step for the whole
 * turn and closes it when the turn ends, so a live turn never has a mid-turn
 * `finish-step` to cut at. The parts are walked instead: a text / reasoning part
 * runs from its `*-start` to its `*-end`, and a tool call from `tool-input-start`
 * until its final (non-preliminary) `tool-output-available`, `tool-output-error`
 * or `tool-input-error` — a sub-agent's preliminary outputs leave the call open.
 */
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { compactSseFrames } from '@shogo-ai/sdk/stream-buffer'

export const MESSAGE_SNAPSHOT_EVENT_TYPE = 'data-message-snapshot' as const

type Chunk = Record<string, any>
type Entry = { chunk: Chunk } | { raw: string }

const encodeEvent = (chunk: Chunk) => `data: ${JSON.stringify(chunk)}\n\n`

function parseEntries(bytes: Uint8Array): Entry[] {
  const events = new TextDecoder().decode(bytes).split('\n\n')
  const tail = events.pop() ?? ''
  const entries: Entry[] = []
  for (const event of events) {
    let chunk: Chunk | null = null
    if (event.startsWith('data: ') && !event.includes('\n')) {
      try {
        const parsed = JSON.parse(event.slice(6))
        if (parsed && typeof parsed.type === 'string') chunk = parsed
      } catch { /* not JSON: keep verbatim */ }
    }
    entries.push(chunk ? { chunk } : { raw: event })
  }
  if (tail) entries.push({ raw: tail })
  return entries
}

async function assembleMessage(chunks: Chunk[]): Promise<UIMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as UIMessageChunk)
      controller.close()
    },
  })
  let last: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream, terminateOnError: false, onError: () => {} })) {
    last = message
  }
  return last
}

/**
 * The last index at which every part is closed — the newest point the
 * continuation can start from. -1 when no part has closed yet (the turn's first
 * part is still open, or no part has started), in which case there is nothing
 * worth snapshotting.
 */
function lastClosedPartIndex(entries: Entry[]): number {
  const openText = new Set<string>()
  const openReasoning = new Set<string>()
  const openTools = new Set<string>()
  const isOpen = () => openText.size > 0 || openReasoning.size > 0 || openTools.size > 0

  let boundary = -1
  let sawPart = false
  entries.forEach((entry, index) => {
    if ('chunk' in entry) {
      const chunk = entry.chunk
      const id = String(chunk.id ?? '')
      switch (chunk.type) {
        case 'text-start':
          openText.add(id)
          sawPart = true
          break
        case 'text-end':
          openText.delete(id)
          break
        case 'reasoning-start':
          openReasoning.add(id)
          sawPart = true
          break
        case 'reasoning-end':
          openReasoning.delete(id)
          break
        case 'tool-input-start':
          openTools.add(String(chunk.toolCallId))
          sawPart = true
          break
        case 'tool-input-error':
          openTools.delete(String(chunk.toolCallId))
          break
        case 'tool-output-available':
          // A preliminary output is one update of a still-running call.
          if (chunk.preliminary !== true) openTools.delete(String(chunk.toolCallId))
          break
        case 'tool-output-error':
          openTools.delete(String(chunk.toolCallId))
          break
        case 'finish-step':
          // The SDK drops its open-part maps here, so nothing can still be open.
          openText.clear()
          openReasoning.clear()
          openTools.clear()
          break
      }
    }
    if (sawPart && !isOpen()) boundary = index
  })
  return boundary
}

/**
 * Builds the replay bytes for `StreamBufferStore.createReplayStream`'s
 * `buildReplay`. Falls back to the plain compacted replay when no part has
 * closed yet (the turn's very first part is still open).
 */
export async function buildSnapshotReplay(frames: Uint8Array[]): Promise<Uint8Array> {
  const compacted = compactSseFrames(frames)
  const entries = parseEntries(compacted)

  const boundary = lastClosedPartIndex(entries)
  if (boundary < 0) return compacted

  const prefix = entries.slice(0, boundary + 1)
  const message = await assembleMessage(prefix.flatMap((e) => ('chunk' in e ? [e.chunk] : [])))
  if (!message) return compacted

  // Transient `data-*` chunks never reach `message.parts` — the client acts on
  // them in `onData` (process list, context usage, connectivity). They are
  // state, not history, so only the latest of each type is worth delivering.
  const latestTransient = new Map<string, Chunk>()
  for (const entry of prefix) {
    if ('chunk' in entry && entry.chunk.transient === true && entry.chunk.type.startsWith('data-')) {
      latestTransient.set(entry.chunk.type, entry.chunk)
    }
  }

  let out = encodeEvent({ type: MESSAGE_SNAPSHOT_EVENT_TYPE, data: { message }, transient: true })
  for (const chunk of latestTransient.values()) out += encodeEvent(chunk)
  for (const entry of entries.slice(boundary + 1)) {
    out += 'chunk' in entry ? encodeEvent(entry.chunk) : `${entry.raw}\n\n`
  }
  return new TextEncoder().encode(out)
}
