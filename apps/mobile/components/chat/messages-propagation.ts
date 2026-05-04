// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helper for the `ChatPanel → onMessagesChange` propagation gate.
 *
 * Why this exists:
 * `ChatPanel` drives `onMessagesChange?.(messages)` from a useEffect keyed on
 * `messages`. The AI SDK emits a new `messages` array reference on every
 * streaming chunk, so firing the callback unconditionally produces a
 * `setState` storm in the parent `ProjectLayout`, which then re-renders all
 * sibling `ChatPanel` tabs per character. This helper decides when the parent
 * actually needs to hear about a change.
 */
import type { UIMessage } from "@ai-sdk/react"

export interface DecideArgs {
  prev: readonly UIMessage[] | null
  next: readonly UIMessage[]
  isStreaming: boolean
  prevIsStreaming: boolean
  prevToolSig: string
}

export interface DecideResult {
  shouldPropagate: boolean
  toolSig: string
}

/**
 * Collapse the AI SDK's per-chunk tool states down to two buckets so the
 * `toolSig` only changes on lifecycle transitions (start, end), not on
 * every `tool-input-delta` between them.
 *
 * The parent's pending-tool / approval UI only cares about whether a tool
 * is running vs has finished, so flipping between e.g. `input-streaming`
 * and `input-available` mid-stream does not need to wake the parent.
 * Letting it through used to be a primary contributor to the per-chunk
 * re-render storm that surfaced as `Maximum update depth exceeded`.
 */
function bucketToolState(state: string | undefined): string {
  if (!state) return ""
  switch (state) {
    case "partial-call":
    case "input-streaming":
    case "input-available":
      return "running"
    default:
      return state
  }
}

/**
 * Decide whether to notify the parent AND return the tool-state signature for
 * the next comparison. Propagate only when:
 *   - first render with any messages (parent needs the initial snapshot)
 *   - count changed AND NOT streaming (e.g. history load, message deletion) —
 *     during streaming we intentionally suppress count-change propagations
 *     (user bubble + assistant bubble both appearing) because the parent does
 *     not use intermediate counts for anything time-sensitive, and each
 *     propagation re-renders every sibling tab
 *   - streaming just transitioned true → false (final authoritative snapshot)
 *   - a tool on the last message transitioned lifecycle bucket
 *     (running → result/error). Per-chunk state churn between two
 *     "running" sub-states is collapsed by `bucketToolState` so we don't
 *     wake the parent on every `tool-input-delta`.
 */
export function decideMessagesPropagation(args: DecideArgs): DecideResult {
  const { prev, next, isStreaming, prevIsStreaming, prevToolSig } = args

  const last = next[next.length - 1] as any
  const lastParts = last?.parts as any[] | undefined
  let toolSig = ""
  if (lastParts) {
    for (let i = 0; i < lastParts.length; i++) {
      const p = lastParts[i]
      if (p?.type === "tool-invocation") {
        toolSig += `|${p.toolInvocation?.toolCallId ?? i}:${bucketToolState(p.toolInvocation?.state)}`
      } else if (p?.type === "dynamic-tool") {
        toolSig += `|${p.toolCallId ?? i}:${bucketToolState(p.state)}`
      }
    }
  }

  const firstPropagation = prev === null
  const countChanged = prev !== null && prev.length !== next.length
  const streamEnded = prevIsStreaming && !isStreaming
  const toolSigChanged = prevToolSig !== toolSig

  // Suppress count-change propagations while streaming (stream-end carries the
  // final snapshot anyway). Tool-sig transitions still propagate so approval
  // UI stays live.
  const countChangedIdle = countChanged && !isStreaming

  const shouldPropagate =
    firstPropagation || countChangedIdle || streamEnded || toolSigChanged
  return { shouldPropagate, toolSig }
}
