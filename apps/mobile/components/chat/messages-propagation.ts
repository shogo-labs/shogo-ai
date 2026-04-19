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
 * Decide whether to notify the parent AND return the tool-state signature for
 * the next comparison. Propagate only when:
 *   - first render with any messages (parent needs the initial snapshot)
 *   - count changed AND NOT streaming (e.g. history load, message deletion) —
 *     during streaming we intentionally suppress count-change propagations
 *     (user bubble + assistant bubble both appearing) because the parent does
 *     not use intermediate counts for anything time-sensitive, and each
 *     propagation re-renders every sibling tab
 *   - streaming just transitioned true → false (final authoritative snapshot)
 *   - a tool on the last message transitioned state (running → result/error).
 *     Tool transitions DO fire mid-stream because the parent uses them for
 *     pending-tool / approval UI.
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
        toolSig += `|${p.toolInvocation?.toolCallId ?? i}:${p.toolInvocation?.state ?? ""}`
      } else if (p?.type === "dynamic-tool") {
        toolSig += `|${p.toolCallId ?? i}:${p.state ?? ""}`
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
