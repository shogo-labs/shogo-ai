// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ChatTransport, UIMessage } from "ai"
import { coalesceChunkBursts } from "./chunk-coalescer"
import { TURN_STOPPED_PART_TYPE } from "./stopped-turn"

/**
 * `resumeStream()` hits the SDK's default `/stream` URL, which carries no
 * `fromSeq`, so the runtime replays the buffered turn from seq 0. The SDK
 * builds a resumed response as a new assistant message, so an unfinished
 * copy of that turn already on screen (from history or an earlier attach)
 * would sit right before it, and the turn list shows only the last
 * assistant message of a turn.
 *
 * Dropping the unfinished assistant tail when a replay stream comes back lets
 * the replay rebuild that message from scratch. A 204 (nothing buffered) must
 * leave the message on screen.
 */

/**
 * True for an assistant message whose turn hasn't finished: no live
 * `data-turn-complete` frame and no persisted `completedAt`. A finished
 * assistant message from an earlier turn is left alone.
 *
 * A reply the user stopped carries neither of those — the turn was cancelled,
 * so the runtime never reports it complete — but it is finished history, not
 * a message a replay should rebuild (see stopped-turn.ts).
 */
export function isUnfinishedAssistant(message: UIMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false
  for (const part of (message.parts ?? []) as Array<Record<string, any>>) {
    if (part?.type === "data-turn-complete") return false
    if (part?.type === TURN_STOPPED_PART_TYPE) return false
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

/**
 * The rest of a snapshot stream lands in a new message the SDK appends after
 * the snapshot, and the turn list shows only a turn's last assistant message.
 * Shows the two as one message: the snapshot's parts, then the rest of the
 * turn. The snapshot ends where the last part closed, so no part is split
 * across them.
 */
export function foldSnapshotContinuation<T extends UIMessage>(
  messages: T[],
  snapshotId: string | null,
): T[] {
  const n = messages.length
  if (!snapshotId || n < 2) return messages
  const snapshot = messages[n - 2]
  const continuation = messages[n - 1]
  if (
    snapshot.id !== snapshotId ||
    snapshot.role !== "assistant" ||
    continuation.role !== "assistant"
  ) {
    return messages
  }
  return [
    ...messages.slice(0, -2),
    {
      ...continuation,
      id: snapshot.id,
      metadata: continuation.metadata ?? snapshot.metadata,
      parts: [...snapshot.parts, ...continuation.parts],
    },
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
 * assembled up to the last point where no part was open. The rest of the stream
 * continues that message, so the client applies the snapshot instead of
 * rebuilding the turn chunk by chunk.
 */
export const MESSAGE_SNAPSHOT_CHUNK_TYPE = "data-message-snapshot"

/** How long to wait for the first chunk before assuming there is no snapshot. */
const SNAPSHOT_PEEK_MS = 1500

/**
 * Reads ahead at most one chunk without losing it: `stream()` yields the
 * original chunks, optionally minus the first one. `endedWithoutFrames` says
 * the peek ended because the stream closed, not because it went quiet: a held
 * open stream with nothing to send yet is a live turn, a closed one is a
 * runtime with nothing buffered.
 */
function peekFirstChunk<T>(source: ReadableStream<T>, timeoutMs: number) {
  const reader = source.getReader()
  let firstRead: Promise<ReadableStreamReadResult<T>> | null = reader.read()
  let skipFirst = false
  let endedWithoutFrames = false
  const peeked = new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    firstRead!.then(
      (result) => {
        clearTimeout(timer)
        endedWithoutFrames = result.done === true
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
    get endedWithoutFrames() {
      return endedWithoutFrames
    },
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
 * Whether a resume may drop the unfinished copy of the message on screen: the
 * replay has to be about to rebuild it. A buffered heartbeat, or a stream that
 * closed without a single frame, means the runtime has nothing left to replay —
 * dropping then leaves the transcript with no copy at all, which is how a reply
 * the person watched finish disappeared. Silence alone is not evidence of that
 * (a live turn's stream is held open with nothing to send yet), so it keeps the
 * old drop.
 */
export function replayRebuildsMessage(args: {
  first: { type?: unknown; transient?: unknown } | undefined
  endedWithoutFrames: boolean
  appliesSnapshot: boolean
}): boolean {
  const { first, endedWithoutFrames, appliesSnapshot } = args
  if (first === undefined) return !endedWithoutFrames
  if (first.type === MESSAGE_SNAPSHOT_CHUNK_TYPE) return !appliesSnapshot
  return first.transient !== true
}

/**
 * Also coalesces chunk bursts on both streams (see chunk-coalescer.ts): the
 * replay arrives as one burst, and a POST stream can carry one too when the
 * API resumes a cut turn server-side.
 *
 * When the resume stream opens with a message snapshot, `onSnapshot` gets it
 * (it must install the message before the SDK reads the last one, which
 * happens once this resolves) and `beforeReplay` is not called. Otherwise the
 * older replay path applies, and only when the replay is really going to
 * rebuild the message (see `replayRebuildsMessage`).
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
      const peek = peekFirstChunk(stream, SNAPSHOT_PEEK_MS)
      const first = await peek.peeked
      const isSnapshotChunk = first?.type === MESSAGE_SNAPSHOT_CHUNK_TYPE
      const snapshot = isSnapshotChunk ? ((first as any).data?.message as T | undefined) : undefined
      if (snapshot && onSnapshot) onSnapshot(snapshot)
      else if (
        replayRebuildsMessage({
          first: first as { type?: unknown; transient?: unknown } | undefined,
          endedWithoutFrames: peek.endedWithoutFrames,
          appliesSnapshot: Boolean(onSnapshot),
        })
      ) {
        beforeReplay()
      }
      return coalesceChunkBursts(peek.stream({ skipFirst: Boolean(snapshot && onSnapshot) }))
    },
  }
}
