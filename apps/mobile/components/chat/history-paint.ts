// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether a transcript rebuilt from saved history may replace the one on
 * screen (SHO-85).
 *
 * The assistant row is written by the API *after* the stream EOFs —
 * `trackUsageFromStream` → `persistAssistantSnapshot`, i.e. EOF, then billing
 * close, then a possible auto-resume. `onFinish` in the panel therefore usually
 * fires while the reply exists **only on screen**. Any paint from `/chat-messages`
 * in that window replaces the transcript with rows that end on the user's
 * prompt, and the reply the person just watched finish disappears until the
 * panel is reopened.
 *
 * The revalidate fetch itself must stay (it adopts canonical server ids and
 * picks up replies written elsewhere, SHO-31/SHO-53); it is the *paint* that
 * has to know when history is behind the screen. This module is that decision,
 * kept pure so it can be tested without a React tree or a running API.
 */

/** The shape the decision needs from a message — a server row or a live SDK message. */
export interface PaintableMessage {
  id?: string | null
  role?: string | null
}

export interface HistoryPaintInput<T extends PaintableMessage> {
  /** Transcript rebuilt purely from saved server rows, oldest first. */
  history: readonly T[]
  /** Transcript on screen now, oldest first — may end on a reply that only exists live. */
  current: readonly T[]
  /**
   * This panel streamed or joined the turn whose reply is on screen, so that
   * reply is real even though the server has not written it yet.
   */
  keepsLiveTail: boolean
}

export type HistoryPaintReason =
  /** Nothing on screen to protect. */
  | "no-live-tail"
  /** The on-screen tail is not an assistant reply (a prompt, or empty). */
  | "tail-not-a-reply"
  /** History already holds the on-screen reply, so painting it is safe. */
  | "history-has-reply"
  /** History holds fewer replies than the screen: it is missing the newest one. */
  | "history-behind"
  /** History has no trailing reply but this panel streamed the turn. */
  | "streamed-turn"

export interface HistoryPaintResult<T extends PaintableMessage> {
  /**
   * The array to paint. Identical to `input.current` when the live tail is
   * kept, so a caller can skip `setMessages` on reference equality and avoid a
   * re-render storm.
   */
  messages: readonly T[]
  /** True when the paint was refused to protect a reply the server has not written. */
  keptLiveTail: boolean
  reason: HistoryPaintReason
}

function isAssistant(message: PaintableMessage | undefined): boolean {
  return message?.role === "assistant"
}

function assistantCount(messages: readonly PaintableMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (isAssistant(message)) count += 1
  }
  return count
}

function holdsId(messages: readonly PaintableMessage[], id: string): boolean {
  return messages.some((message) => String(message?.id ?? "") === id)
}

/**
 * Decide what to paint. History wins whenever it can account for what is on
 * screen; the live tail wins only when the screen is provably ahead of it.
 */
export function resolveHistoryPaint<T extends PaintableMessage>(
  input: HistoryPaintInput<T>,
): HistoryPaintResult<T> {
  const { history, current, keepsLiveTail } = input
  const paint = (reason: HistoryPaintReason): HistoryPaintResult<T> => ({
    messages: history,
    keptLiveTail: false,
    reason,
  })
  const keep = (reason: HistoryPaintReason): HistoryPaintResult<T> => ({
    messages: current,
    keptLiveTail: true,
    reason,
  })

  const currentTail = current[current.length - 1]
  if (!currentTail) return paint("no-live-tail")
  if (!isAssistant(currentTail)) return paint("tail-not-a-reply")

  // Same reply already saved (canonical id adopted, or a live paint that landed
  // on the server row): painting history is what keeps a single copy.
  const currentTailId = String(currentTail.id ?? "")
  if (currentTailId && holdsId(history, currentTailId)) return paint("history-has-reply")

  const historyTail = history[history.length - 1]
  // The turn's reply is the only thing history lacks and it ends in prose, so
  // this panel's own stream is enough to know the tail is real.
  if (keepsLiveTail && !isAssistant(historyTail)) return keep("streamed-turn")

  // Fall back to counting replies: fewer on the server than on screen means the
  // newest one (or more) exists only live — whether history stops on the prompt
  // that produced it or on an earlier turn's reply.
  if (assistantCount(history) < assistantCount(current)) return keep("history-behind")

  return paint("history-has-reply")
}
