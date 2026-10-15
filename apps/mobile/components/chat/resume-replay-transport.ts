// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"
import { coalesceChunkBursts } from "./chunk-coalescer"

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
 * that message.
 */
export const MESSAGE_SNAPSHOT_CHUNK_TYPE = "data-message-snapshot"

/**
 * The chunks that rebuild `message`, one per part. The snapshot ends at a
 * step boundary, so every part is closed and each can be sent whole.
 *
 * The SDK can't be handed the snapshot as the message to continue (a resumed
 * response always starts a new one), so a snapshot installed beside the
 * stream ends up as a separate message the rest of the turn hides. Sending it
 * as chunks keeps the turn in one message the SDK owns.
 */
export function messageToChunks(message: UIMessage): UIMessageChunk[] {
  const out: UIMessageChunk[] = [
    {
      type: "start",
      ...(message.id ? { messageId: message.id } : {}),
      ...(message.metadata !== undefined ? { messageMetadata: message.metadata } : {}),
    } as UIMessageChunk,
  ]
  let inStep = false
  ;((message.parts ?? []) as Array<Record<string, any>>).forEach((part, index) => {
    const type = String(part?.type ?? "")
    const providerMetadata = part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}
    if (type === "step-start") {
      if (inStep) out.push({ type: "finish-step" })
      out.push({ type: "start-step" })
      inStep = true
    } else if (type === "text" || type === "reasoning") {
      const id = `snapshot-${index}`
      out.push({ type: `${type}-start`, id, ...providerMetadata } as UIMessageChunk)
      if (part.text) out.push({ type: `${type}-delta`, id, delta: part.text } as UIMessageChunk)
      out.push({ type: `${type}-end`, id, ...providerMetadata } as UIMessageChunk)
    } else if (type === "dynamic-tool" || type.startsWith("tool-")) {
      out.push(...toolPartToChunks(part, type))
    } else if (type.startsWith("data-")) {
      out.push({ type, ...(part.id ? { id: part.id } : {}), data: part.data } as UIMessageChunk)
    } else if (type === "source-url") {
      out.push({ type, sourceId: part.sourceId, url: part.url, title: part.title, ...providerMetadata } as UIMessageChunk)
    } else if (type === "source-document") {
      out.push({
        type,
        sourceId: part.sourceId,
        mediaType: part.mediaType,
        title: part.title,
        filename: part.filename,
        ...providerMetadata,
      } as UIMessageChunk)
    } else if (type === "file") {
      out.push({ type, url: part.url, mediaType: part.mediaType, ...providerMetadata } as UIMessageChunk)
    }
  })
  if (inStep) out.push({ type: "finish-step" })
  return out
}

function toolPartToChunks(part: Record<string, any>, type: string): UIMessageChunk[] {
  const dynamic = type === "dynamic-tool"
  const common = {
    toolCallId: part.toolCallId,
    ...(part.providerExecuted !== undefined ? { providerExecuted: part.providerExecuted } : {}),
    ...(dynamic ? { dynamic: true } : {}),
  }
  const toolName = dynamic ? part.toolName : type.slice("tool-".length)
  const out: UIMessageChunk[] = [
    {
      type: "tool-input-available",
      ...common,
      toolName,
      input: part.input ?? part.rawInput,
      ...(part.callProviderMetadata ? { providerMetadata: part.callProviderMetadata } : {}),
      ...(part.title ? { title: part.title } : {}),
    } as UIMessageChunk,
  ]
  if (part.approval?.id && ["approval-requested", "approval-responded", "output-denied"].includes(part.state)) {
    out.push({ type: "tool-approval-request", approvalId: part.approval.id, toolCallId: part.toolCallId } as UIMessageChunk)
  }
  if (part.state === "output-available") {
    out.push({
      type: "tool-output-available",
      ...common,
      output: part.output,
      ...(part.preliminary ? { preliminary: true } : {}),
    } as UIMessageChunk)
  } else if (part.state === "output-error") {
    out.push({ type: "tool-output-error", ...common, errorText: part.errorText ?? "" } as UIMessageChunk)
  } else if (part.state === "output-denied") {
    out.push({ type: "tool-output-denied", toolCallId: part.toolCallId } as UIMessageChunk)
  }
  return out
}

/** Expands a leading snapshot chunk into the chunks that rebuild its message. */
function expandSnapshot<T>(source: ReadableStream<T>): ReadableStream<T> {
  const reader = source.getReader()
  let first = true
  return new ReadableStream<T>(
    {
      async pull(controller) {
        const result = await reader.read()
        if (result.done) return controller.close()
        const chunk = result.value as any
        const wasFirst = first
        first = false
        const message = chunk?.data?.message as UIMessage | undefined
        if (wasFirst && chunk?.type === MESSAGE_SNAPSHOT_CHUNK_TYPE && message) {
          for (const rebuilt of messageToChunks(message)) controller.enqueue(rebuilt as T)
          return
        }
        controller.enqueue(result.value)
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}

/**
 * Also coalesces chunk bursts on both streams (see chunk-coalescer.ts): the
 * replay arrives as one burst, and a POST stream can carry one too when the
 * API resumes a cut turn server-side.
 */
export function withResumeReplayReset<T extends UIMessage>(
  transport: ChatTransport<T>,
  beforeReplay: () => void,
): ChatTransport<T> {
  return {
    sendMessages: async (options) =>
      coalesceChunkBursts(await transport.sendMessages(options)),
    reconnectToStream: async (options) => {
      const stream = await transport.reconnectToStream(options)
      if (!stream) return stream
      beforeReplay()
      return coalesceChunkBursts(expandSnapshot(stream))
    },
  }
}
