// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Snapshot replay for a client that joins a live turn.
 *
 * Replaying the buffered stream, even compacted, makes the client run every
 * chunk through the AI SDK and re-render the growing message. A joining client
 * instead gets the message assembled so far in a single `data-message-snapshot`
 * chunk, followed by only the unfinished step as a compacted stream, then the
 * live frames.
 *
 * The snapshot covers everything up to the last `finish-step`. A step boundary
 * is the only point where every text / reasoning / tool-input part is closed,
 * so the SDK on the client (which throws on a delta for a part it never saw
 * open) can pick the stream up from there.
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
 * Builds the replay bytes for `StreamBufferStore.createReplayStream`'s
 * `buildReplay`. Falls back to the plain compacted replay when there is no
 * completed step to snapshot yet.
 */
export async function buildSnapshotReplay(frames: Uint8Array[]): Promise<Uint8Array> {
  const compacted = compactSseFrames(frames)
  const entries = parseEntries(compacted)

  let boundary = -1
  entries.forEach((entry, index) => {
    if ('chunk' in entry && entry.chunk.type === 'finish-step') boundary = index
  })
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
