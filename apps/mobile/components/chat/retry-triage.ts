// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure decision logic for the chat "Retry" button.
 *
 * The reported bug: when the model stopped/errored the UI showed
 * "Connection interrupted. Please tap Retry to continue." and tapping Retry
 * TRUNCATED the conversation (`setMessages(messages.slice(0, lastUserIdx))`)
 * and re-sent the original user message — discarding the interrupted turn's
 * completed tool calls and partial answer (potentially minutes of work).
 *
 * The fix triages the failure into one of four NON-destructive actions:
 *
 *   - `reconnect`: the runtime reports the turn is still `active` (a transport
 *     drop, not a real inference failure). The agent is still running and
 *     buffering frames server-side; reattach to the live stream. Nothing was
 *     lost and nothing is re-sent.
 *   - `reload`: the runtime reports the turn `completed` and the client lost
 *     track of it (e.g. the view died mid-stream). Reload the persisted
 *     messages; starting a `continue` turn here would bill the user for work
 *     that already finished.
 *   - `continue`: the turn genuinely ended but the last assistant turn left
 *     resumable work (completed tool calls / partial text preserved in the
 *     session). Continue from that preserved context instead of restarting.
 *   - `resend`: there is genuinely nothing to resume or continue (e.g. the very
 *     first model call produced zero output and ran no tools). Only then do we
 *     re-send the original user message.
 *
 * Critically, NONE of these actions truncate already-rendered completed work.
 * Extracted as a pure function so the regression can be unit-tested without
 * React or the runtime.
 */

import type { ChatTurnStatus } from "./probe-turn-status"

export type RetryAction = "reconnect" | "reload" | "continue" | "resend"

export interface RetryTriageInput {
  /** Status from the runtime's read-only `/turn` probe. */
  turnStatus: ChatTurnStatus
  /**
   * True when the last assistant turn left behind resumable work — completed
   * tool calls or partial text/reasoning that should be built upon rather than
   * thrown away. Compute via {@link lastAssistantHasResumableWork}.
   */
  hasResumableTurn: boolean
  /**
   * True when the client never saw the turn finish (no `data-turn-complete`,
   * a stall, or the view crashed mid-turn). When false the client already
   * rendered the whole turn, so reloading it would show the same result.
   */
  clientLostStream: boolean
}

/**
 * Decide how the "Retry" button should behave. Pure + total.
 *
 *  - `active`                              -> reconnect (agent still running)
 *  - `completed` + client lost the stream  -> reload (the work is already saved)
 *  - otherwise + resumable                 -> continue (preserve work)
 *  - otherwise + nothing                   -> resend (last resort)
 */
export function decideRetryAction({ turnStatus, hasResumableTurn, clientLostStream }: RetryTriageInput): RetryAction {
  if (turnStatus === "active") return "reconnect"
  if (turnStatus === "completed" && clientLostStream) return "reload"
  if (hasResumableTurn) return "continue"
  return "resend"
}

interface MinimalPart {
  type?: string
  text?: string
  state?: string
}

interface MinimalMessage {
  role?: string
  parts?: MinimalPart[]
}

/**
 * Does the most recent assistant message carry resumable work?
 *
 * Resumable work = any tool call (regardless of state — a completed tool result
 * is the canonical "minutes of work" we must not discard) or any non-empty
 * text/reasoning content. If the most recent message is the user's (the model
 * produced nothing at all yet), there is nothing to resume.
 */
export function lastAssistantHasResumableWork(messages: MinimalMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "assistant") {
      const parts = Array.isArray(m.parts) ? m.parts : []
      return parts.some((p) => {
        const t = typeof p.type === "string" ? p.type : ""
        if (t === "dynamic-tool" || t === "tool-invocation" || t.startsWith("tool-")) return true
        if ((t === "text" || t === "reasoning") && typeof p.text === "string" && p.text.trim().length > 0) {
          return true
        }
        return false
      })
    }
    if (m.role === "user") return false
  }
  return false
}
