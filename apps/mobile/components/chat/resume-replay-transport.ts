// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ChatTransport, UIMessage } from "ai"
import { coalesceChunkBursts } from "./chunk-coalescer"

/**
 * `resumeStream()` hits the SDK's default `/stream` URL, which carries no
 * `fromSeq`, so the runtime replays the buffered turn from seq 0. The SDK
 * seeds the resumed response with the last message when it is an
 * assistant message and applies every replayed chunk on top of it, so each
 * reasoning/text block already on screen is pushed a second time (tool
 * parts merge by id and don't duplicate).
 *
 * Dropping the unfinished assistant tail right before the replay starts
 * lets the replay rebuild that message from scratch. The SDK reads the last
 * message after `reconnectToStream` resolves, so the drop has to happen
 * inside the transport, and only when a replay stream actually came back —
 * a 204 (nothing buffered) must leave the message on screen.
 */

/**
 * True for an assistant message whose turn hasn't finished: no live
 * `data-turn-complete` frame and no persisted `completedAt`. A finished
 * assistant message from an earlier turn is left alone.
 */
export function isUnfinishedAssistant(message: UIMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false
  for (const part of (message.parts ?? []) as Array<Record<string, any>>) {
    if (part?.type === "data-turn-complete") return false
    if (
      part?.type === "data-turn-timing" &&
      typeof part?.data?.completedAt === "number"
    ) {
      return false
    }
  }
  return true
}

/**
 * Installs a resume snapshot as the last message: it replaces the unfinished
 * assistant tail (and any earlier copy of the same message id), since the
 * snapshot is that message rebuilt from the runtime's buffer.
 */
export function applyMessageSnapshot<T extends UIMessage>(
  messages: T[],
  snapshot: T,
): T[] {
  return [
    ...dropUnfinishedAssistantTail(messages.filter((m) => m.id !== snapshot.id)),
    snapshot,
  ]
}

export function dropUnfinishedAssistantTail<T extends UIMessage>(
  messages: T[],
): T[] {
  if (!isUnfinishedAssistant(messages[messages.length - 1])) return messages
  return messages.slice(0, -1)
}

/**
 * A runtime that was asked for `?snapshot=1` (see `useChatTransportConfig`'s
 * `resumeSnapshot`) opens the stream with one of these: the assistant message
 * assembled up to the last finished step. The rest of the stream continues
 * that message, so the client applies the snapshot instead of rebuilding the
 * turn chunk by chunk.
 */
export const MESSAGE_SNAPSHOT_CHUNK_TYPE = "data-message-snapshot"

/** How long to wait for the first chunk before assuming there is no snapshot. */
const SNAPSHOT_PEEK_MS = 1500

/**
 * Reads ahead at most one chunk without losing it: `stream()` yields the
 * original chunks, optionally minus the first one.
 */
function peekFirstChunk<T>(source: ReadableStream<T>, timeoutMs: number) {
  const reader = source.getReader()
  let firstRead: Promise<ReadableStreamReadResult<T>> | null = reader.read()
  let skipFirst = false
  const peeked = new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    firstRead!.then(
      (result) => {
        clearTimeout(timer)
        resolve(result.done ? undefined : result.value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
  return {
    peeked,
    stream(opts: { skipFirst: boolean }): ReadableStream<T> {
      skipFirst = opts.skipFirst
      return new ReadableStream<T>(
        {
          async pull(controller) {
            for (;;) {
              const read = firstRead ?? reader.read()
              const wasFirst = firstRead !== null
              firstRead = null
              const result = await read
              if (result.done) return controller.close()
              if (wasFirst && skipFirst) continue
              return controller.enqueue(result.value)
            }
          },
          cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
      )
    },
  }
}

/**
 * Also coalesces chunk bursts on both streams (see chunk-coalescer.ts): the
 * replay arrives as one burst, and a POST stream can carry one too when the
 * API resumes a cut turn server-side.
 *
 * When the resume stream opens with a message snapshot, `onSnapshot` gets it
 * (it must install the message before the SDK reads the last one, which
 * happens once this resolves) and `beforeReplay` is not called. Otherwise the
 * older replay path applies.
 */
export function withResumeReplayReset<T extends UIMessage>(
  transport: ChatTransport<T>,
  beforeReplay: () => void,
  onSnapshot?: (message: T) => void,
): ChatTransport<T> {
  return {
    sendMessages: async (options) =>
      coalesceChunkBursts(await transport.sendMessages(options)),
    reconnectToStream: async (options) => {
      const stream = await transport.reconnectToStream(options)
      if (!stream) return stream
      if (!onSnapshot) {
        beforeReplay()
        return coalesceChunkBursts(stream)
      }
      const peek = peekFirstChunk(stream, SNAPSHOT_PEEK_MS)
      const first = await peek.peeked
      const snapshot =
        first?.type === MESSAGE_SNAPSHOT_CHUNK_TYPE
          ? ((first as any).data?.message as T | undefined)
          : undefined
      if (snapshot) onSnapshot(snapshot)
      else beforeReplay()
      return coalesceChunkBursts(peek.stream({ skipFirst: first?.type === MESSAGE_SNAPSHOT_CHUNK_TYPE }))
    },
  }
}
