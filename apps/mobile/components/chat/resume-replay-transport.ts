// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ChatTransport, UIMessage } from "ai"

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

export function dropUnfinishedAssistantTail<T extends UIMessage>(
  messages: T[],
): T[] {
  if (!isUnfinishedAssistant(messages[messages.length - 1])) return messages
  return messages.slice(0, -1)
}

export function withResumeReplayReset<T extends UIMessage>(
  transport: ChatTransport<T>,
  beforeReplay: () => void,
): ChatTransport<T> {
  return {
    sendMessages: (options) => transport.sendMessages(options),
    reconnectToStream: async (options) => {
      const stream = await transport.reconnectToStream(options)
      if (stream) beforeReplay()
      return stream
    },
  }
}
