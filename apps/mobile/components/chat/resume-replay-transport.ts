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
    // A turn the server declared dead is finished history: its text is what the
    // person read before the crash, and the resume appends to it (SHO-274).
    if (part?.type === TURN_INTERRUPTED_PART_TYPE) return false
    if (
      part?.type === "data-turn-timing" &&
      typeof part?.data?.completedAt === "number"
    ) {
      return false
    }
  }
  return true
}

/** The part the API stamps on a turn it declared dead (SHO-274). */
export const TURN_INTERRUPTED_PART_TYPE = "data-turn-interrupted"

/**
 * Which turn a message belongs to, as `turn:<id>` or `at:<startedAt>`.
 *
 * The runtime stamps `data-turn-start` on everything it streams and the API
 * copies the same stamp onto the persisted row as `data-turn-timing`, so one
 * key identifies a turn on both sides of the wire (SHO-274).
 */
export function messageTurnKey(message: UIMessage | undefined): string | null {
  for (const part of (message?.parts ?? []) as Array<Record<string, any>>) {
    if (part?.type !== "data-turn-start" && part?.type !== "data-turn-timing") continue
    const turnId = part?.data?.turnId
    if (typeof turnId === "string" && turnId) return `turn:${turnId}`
    const startedAt = part?.data?.startedAt
    if (typeof startedAt === "number") return `at:${startedAt}`
  }
  return null
}

/**
 * Whether this assistant message has a row behind it (`data-turn-timing` is
 * only ever written by the API when it persists a reply). A bubble built by the
 * AI SDK from this window's own stream has none, so it is the copy a replay
 * rebuilds; a persisted one is history and must survive (SHO-274).
 */
function hasServerRow(message: UIMessage | undefined): boolean {
  for (const part of (message?.parts ?? []) as Array<Record<string, any>>) {
    if (part?.type === "data-turn-timing" || part?.type === TURN_INTERRUPTED_PART_TYPE) return true
  }
  return false
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
    ...dropUnfinishedAssistantTail(messages.filter((m) => m.id !== snapshot.id), snapshot),
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

/**
 * Drop the unfinished assistant tail, but only when the replay is going to
 * rebuild *that* message.
 *
 * A crash leaves an unfinished assistant row on screen. Dropping it whenever a
 * replay arrives deleted history the person had already read — and the next
 * device-cache write stored the array without it (SHO-274). A stored row is kept
 * unless the replay is the same turn; a bubble this window streamed is dropped
 * because the replay rebuilds it from scratch.
 *
 * @param replay the message the replay starts from, when the caller knows it
 *   (a snapshot carries its turn). Without it, only a bubble with no stored row
 *   is dropped — a replay never rewrites a row it is not following.
 */
export function dropUnfinishedAssistantTail<T extends UIMessage>(
  messages: T[],
  replay?: T | null,
): T[] {
  const tail = messages[messages.length - 1]
  if (!isUnfinishedAssistant(tail)) return messages
  if (hasServerRow(tail)) {
    const replayKey = messageTurnKey(replay ?? undefined)
    const tailKey = messageTurnKey(tail)
    // Same turn: the replay is rebuilding this row, so its copy goes.
    if (!replayKey || !tailKey || replayKey !== tailKey) return messages
  }
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

/**
 * A snapshot always needs an id: `foldSnapshotContinuation` joins the
 * continuation to it by id, and without one the turn shows only its latest
 * action (the 2.4.1 regression). Runtimes before the fix send `id: ""`, so the
 * client names it the way the runtime now does: after the turn.
 */
export function withSnapshotId<T extends UIMessage>(snapshot: T | undefined): T | undefined {
  if (!snapshot || snapshot.id) return snapshot
  let turnId: string | undefined
  for (const part of (snapshot.parts ?? []) as Array<Record<string, any>>) {
    if (part?.type === "data-turn-start" && typeof part.data?.turnId === "string") {
      turnId = part.data.turnId
      break
    }
  }
  const id = turnId
    ? `turn-${turnId}`
    : `turn-snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return { ...snapshot, id }
}

/** How long to wait for the first chunk before assuming there is no snapshot. */
const SNAPSHOT_PEEK_MS = 1500

/**
 * How far the peek reads past the first chunk while looking for the replay's
 * `data-turn-start`. The runtime writes it as the second frame of a turn
 * (`buffered-turn.ts`), so the bound only bites on a runtime too old to send it.
 */
const REPLAY_LOOKAHEAD_CHUNKS = 24

/** The runtime's frame naming the turn the following frames rebuild. */
export const TURN_START_PART_TYPE = "data-turn-start"

/** Which turn a replay stream is rebuilding, as far as it said so up front. */
export interface ReplayTurnStart {
  turnId?: string
  startedAt?: number
}

/**
 * The turn a chunk announces, if it is a `data-turn-start` frame. The runtime
 * writes `{ turnId, chatSessionId, startedAt }`; an older one carries no turn
 * id, so `startedAt` is the fallback `messageTurnKey` already understands.
 */
export function turnStartOf(chunk: unknown): ReplayTurnStart | undefined {
  const frame = chunk as { type?: unknown; data?: Record<string, unknown> } | undefined
  if (frame?.type !== TURN_START_PART_TYPE) return undefined
  const turnId = frame.data?.turnId
  const startedAt = frame.data?.startedAt
  const start: ReplayTurnStart = {}
  if (typeof turnId === "string" && turnId) start.turnId = turnId
  if (typeof startedAt === "number") start.startedAt = startedAt
  return Object.keys(start).length > 0 ? start : undefined
}

/**
 * A message carrying only the turn the replay is rebuilding, so the tail drop
 * can tell "the copy on screen is this turn" from "this is another turn's row"
 * (`dropUnfinishedAssistantTail`). Same shape the snapshot path compares with.
 */
export function replayTurnMessage(start: ReplayTurnStart): UIMessage {
  return {
    id: `replay-${start.turnId ?? start.startedAt ?? "turn"}`,
    role: "assistant",
    parts: [{ type: TURN_START_PART_TYPE, data: { ...start } }],
  } as UIMessage
}

/**
 * Reads ahead a bounded number of chunks without losing any: `stream()` yields
 * the peeked chunks in order, optionally minus the first one, then continues
 * with the rest of the source. `endedWithoutFrames` says the source closed
 * before a single frame arrived — a runtime with nothing buffered — as opposed
 * to a held-open stream that has nothing to send yet.
 *
 * `readMore` can be called again to look further; a read still in flight when
 * the deadline passes is handed to `stream()`.
 */
function peekChunks<T>(source: ReadableStream<T>) {
  const reader = source.getReader()
  const buffered: T[] = []
  let pending: Promise<ReadableStreamReadResult<T>> | null = null
  let ended = false
  const nextRead = () => (pending ??= reader.read())

  const readMore = async (opts: {
    timeoutMs: number
    upTo: number
    stopOn?: (chunk: T) => boolean
  }): Promise<void> => {
    const deadline = Date.now() + opts.timeoutMs
    while (buffered.length < opts.upTo) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining)
      })
      const read = nextRead().then(
        (result) => ({ result }) as const,
        (error) => ({ error }) as const,
      )
      const outcome = await Promise.race([read, timeout])
      clearTimeout(timer)
      if (outcome === "timeout") return
      if ("error" in outcome) throw outcome.error
      pending = null
      const result = outcome.result
      if (result.done) {
        ended = true
        return
      }
      buffered.push(result.value)
      if (opts.stopOn?.(result.value)) return
    }
  }

  return {
    readMore,
    get buffered() {
      return buffered
    },
    get endedWithoutFrames() {
      return ended && buffered.length === 0
    },
    stream(opts: { skipFirst: boolean }): ReadableStream<T> {
      let cursor = opts.skipFirst ? 1 : 0
      return new ReadableStream<T>(
        {
          async pull(controller) {
            for (;;) {
              if (cursor < buffered.length) return controller.enqueue(buffered[cursor++])
              if (ended) return controller.close()
              const read = pending ?? reader.read()
              pending = null
              const result = await read
              if (result.done) {
                ended = true
                return controller.close()
              }
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
 *
 * `beforeReplay` is told which turn the replay rebuilds, read from its
 * `data-turn-start` frame: without it the tail drop cannot tell the persisted
 * partial of *this* turn (which the replay is about to rebuild) from another
 * turn's row (which must survive), and the reply shows twice (SHO-278). A
 * runtime that never sends the frame leaves it undefined, and the drop keeps
 * its old, conservative behaviour.
 */
export function withResumeReplayReset<T extends UIMessage>(
  transport: ChatTransport<T>,
  beforeReplay: (start?: ReplayTurnStart) => void,
  onSnapshot?: (message: T) => void,
): ChatTransport<T> {
  return {
    sendMessages: async (options) =>
      coalesceChunkBursts(await transport.sendMessages(options)),
    reconnectToStream: async (options) => {
      const stream = await transport.reconnectToStream(options)
      if (!stream) return stream
      const deadline = Date.now() + SNAPSHOT_PEEK_MS
      // One chunk tells a snapshot apart from a replay. A replay then has to be
      // read on (bounded) to its `data-turn-start`: the tail drop can only
      // replace the copy on screen when it knows which turn is being rebuilt.
      const peek = peekChunks(stream)
      await peek.readMore({ timeoutMs: SNAPSHOT_PEEK_MS, upTo: 1 })
      const first = peek.buffered[0]
      const isSnapshotChunk = first?.type === MESSAGE_SNAPSHOT_CHUNK_TYPE
      const snapshot = isSnapshotChunk
        ? withSnapshotId((first as any).data?.message as T | undefined)
        : undefined
      if (snapshot && onSnapshot) {
        onSnapshot(snapshot)
        return coalesceChunkBursts(peek.stream({ skipFirst: true }))
      } else if (
        replayRebuildsMessage({
          first: first as { type?: unknown; transient?: unknown } | undefined,
          endedWithoutFrames: peek.endedWithoutFrames,
          appliesSnapshot: Boolean(onSnapshot),
        })
      ) {
        if (!turnStartOf(first)) {
          await peek.readMore({
            timeoutMs: Math.max(0, deadline - Date.now()),
            upTo: REPLAY_LOOKAHEAD_CHUNKS,
            stopOn: (chunk) => turnStartOf(chunk) !== undefined,
          })
        }
        let start: ReplayTurnStart | undefined
        for (const chunk of peek.buffered) {
          start = turnStartOf(chunk)
          if (start) break
        }
        beforeReplay(start)
      }
      return coalesceChunkBursts(peek.stream({ skipFirst: false }))
    },
  }
}
