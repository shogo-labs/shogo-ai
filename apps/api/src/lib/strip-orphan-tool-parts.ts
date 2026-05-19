// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Strip "orphan" tool parts from a UIMessage array before handing it
 * to `convertToModelMessages` / `streamText`.
 *
 * An *orphan* is an assistant tool part whose state is anything other
 * than `output-available` / `output-error` / `output-denied` — i.e.
 * the model issued a `tool_use` but no `tool_result` ever came back
 * (the stream was interrupted, the page refreshed, the client tool
 * threw without reporting an error, a heartbeat raced with an
 * in-flight turn, etc.). When this happens, the AI SDK's prompt
 * conversion blows up with `AI_MissingToolResultsError` and the
 * server returns an opaque 500 to the client — every subsequent send
 * fails until the orphan is removed from history.
 *
 * Rather than mutate persisted state, we filter these parts at
 * request time. The downside is a small loss of context (the model
 * no longer sees the half-finished tool call) but in practice the
 * thread becomes usable again immediately, and the model can re-issue
 * the call if it still wants the data.
 */

import type { UIMessage } from 'ai'

/**
 * Tool-part states that count as "complete" — i.e. the model has a
 * tool_result it can reason over. Anything else is considered an
 * orphan and dropped.
 */
const COMPLETE_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
])

interface ToolLikePart {
  type: string
  state?: string
}

function isToolPart(part: unknown): part is ToolLikePart {
  if (!part || typeof part !== 'object') return false
  const type = (part as { type?: unknown }).type
  if (typeof type !== 'string') return false
  return type.startsWith('tool-') || type === 'dynamic-tool'
}

/**
 * Returns a new UIMessage array with orphan tool parts removed. The
 * input array is not mutated. Messages that end up with zero parts
 * after filtering are dropped entirely so an empty assistant turn
 * doesn't confuse the model.
 */
export function stripOrphanToolParts<T extends UIMessage = UIMessage>(
  messages: T[],
): { messages: T[]; droppedCount: number } {
  let droppedCount = 0
  const cleaned: T[] = []
  for (const m of messages) {
    const parts = (m as unknown as { parts?: unknown[] }).parts
    if (!Array.isArray(parts) || parts.length === 0) {
      cleaned.push(m)
      continue
    }
    const nextParts: unknown[] = []
    for (const part of parts) {
      if (!isToolPart(part)) {
        nextParts.push(part)
        continue
      }
      const state = part.state
      if (typeof state !== 'string' || !COMPLETE_TOOL_STATES.has(state)) {
        droppedCount += 1
        continue
      }
      nextParts.push(part)
    }
    if (nextParts.length === 0) continue
    cleaned.push({ ...m, parts: nextParts } as T)
  }
  return { messages: cleaned, droppedCount }
}
