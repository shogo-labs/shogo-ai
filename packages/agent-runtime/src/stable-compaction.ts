// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prefix-stable wrapper around the three cheap compaction layers
 * (applyToolResultBudget, microcompact, snipConsumedResults) so they can be
 * invoked before every LLM API call inside an agent loop without invalidating
 * the prompt cache on each call.
 *
 * Why this exists
 * ---------------
 * The raw layers make their decisions from scratch each call: as `messages`
 * grows over the course of a multi-tool-call turn, their decisions for OLD
 * tool results drift — the "last 3 assistant turns" window shifts forward,
 * aggregate budget checks start/stop firing, per-result budgets change. That
 * means re-running them before every call produces different bytes for the
 * same historical tool_result every time, which blows away the cached prefix
 * on every request (observed in practice as 612k cache-write vs 174k
 * cache-read in a 6-call turn — the cache is being rebuilt from scratch).
 *
 * The stable wrapper solves this by recording a write-once compaction
 * decision per tool_call_id in `ContentReplacementState` on the FIRST call
 * the id appears in. Once a decision is recorded, that exact byte-string
 * is re-applied on every future call — the raw layers never re-examine
 * that id. Including ids currently inside the protected window: those are
 * locked as `seenAndPreserved` on first sight, so when they later exit
 * the window the layers skip them (via frozenIds) and original bytes
 * continue to be emitted. This is what eliminates the "protected-window
 * exit" cache break that otherwise happens once per tool_result.
 *
 * This implements a write-once `ContentReplacementState` /
 * `enforceToolResultBudget` pattern for stable tool-result compaction.
 *
 * Cache-stability invariant
 * -------------------------
 * For any tool_call_id `T` and any pair of calls C1, C2 (C1 before C2):
 *   If `messages` at C1 and C2 both contain the toolResult with id T,
 *   the text emitted for T at C2 equals the text emitted at C1.
 *
 * Proof sketch:
 *   - If T ∈ state.replacements at C2: C2 emits state.replacements.get(T).
 *     Either C1 also had this entry (same bytes by Map immutability of
 *     existing keys) or C1 recorded it (so C1 also emitted this exact
 *     string, since recordDecisions captures the post-layer text).
 *   - If T ∈ state.seenAndPreserved at C2: layers skip T, C2 emits original.
 *     Either C1 had this entry (same) or C1 recorded it after observing the
 *     layers return the original unchanged — so C1 also emitted the original.
 *   - If T ∉ state at C2: C2 is the first time T has appeared, and C2
 *     records it (either replaced or preserved) based on the layers'
 *     decision right now. There is no C1 for T (vacuous).
 *
 * T's emitted bytes are fixed at the moment of first sight and never
 * change again for the lifetime of the session. Zero prefix breaks per
 * tool_result after the first call it appears in.
 */

import type { Message, ToolResultMessage, TextContent } from '@mariozechner/pi-ai'
import { applyToolResultBudget, snipConsumedResults } from './session-manager.js'
import { microcompact } from './microcompact.js'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Monotone per-session compaction-decision state.
 *
 * `replacements`: tool_call_id → exact text that replaced the tool_result's
 *   content the first time a layer chose to compact it. Write-once; never
 *   updated. Re-application is a pure Map lookup, cannot change bytes,
 *   cannot fail.
 *
 * `seenAndPreserved`: tool_call_ids that the layers chose NOT to compact
 *   in a prior call (but which are past the protected window, so the
 *   decision is final). Write-once; never updated. Their content flows
 *   through untouched by the layers (skipped via frozenIds).
 *
 * Both sets together form the "decided" set. A tool_call_id is in at most
 * one of them, and membership is monotone: once in, always in.
 */
export interface ContentReplacementState {
  replacements: Map<string, string>
  seenAndPreserved: Set<string>
}

export function createContentReplacementState(): ContentReplacementState {
  return {
    replacements: new Map(),
    seenAndPreserved: new Set(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROTECTED_TURNS = 3

function extractText(msg: Message): string {
  if (msg.role !== 'toolResult') return ''
  return (msg as ToolResultMessage).content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

/**
 * Pre-apply known replacements from state to messages. Output is byte-identical
 * for any id in state.replacements across calls — this is the core of prefix
 * stability. Messages without a recorded replacement pass through by reference.
 */
function applyKnownReplacements(
  messages: Message[],
  state: ContentReplacementState,
): Message[] {
  if (state.replacements.size === 0) return messages
  let anyChange = false
  const out = messages.map((msg) => {
    if (msg.role !== 'toolResult') return msg
    const id = (msg as ToolResultMessage).toolCallId
    const replacement = state.replacements.get(id)
    if (replacement === undefined) return msg
    anyChange = true
    return {
      ...(msg as ToolResultMessage),
      content: [{ type: 'text' as const, text: replacement }],
    } as ToolResultMessage
  })
  return anyChange ? out : messages
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export interface StableTransformResult {
  messages: Message[]
  /** Debug stats — safe to log at high verbosity. */
  stats: {
    totalToolResults: number
    frozenCount: number
    newlyDecided: number
    newlyReplaced: number
    newlyPreserved: number
  }
}

/**
 * Run the three cheap compaction layers against `messages` with prefix-stability
 * guarantees, mutating `state` in place to record new decisions.
 *
 * Ordering (matches current gateway sequence):
 *   1. applyToolResultBudget — aggregate budget trim
 *   2. microcompact — per-result head/tail or file-read placeholder
 *   3. snipConsumedResults — replace consumed (has-following-assistant) large
 *      results with a tiny placeholder
 *
 * The three layers are all idempotent on their own output (a second pass
 * produces identical bytes), so the snapshot captured in `state.replacements`
 * after all three is stable under re-application.
 */
export function stableTransformContext(
  messages: Message[],
  state: ContentReplacementState,
  contextBudgetChars: number,
): StableTransformResult {
  // Step 1: replay all frozen replacements. After this, any id in
  // state.replacements has its final, byte-stable content in place.
  const withReplacements = applyKnownReplacements(messages, state)

  // Step 2: build the frozen-id skip set so the layers don't re-examine
  // decided ids. Replacements AND preserved — both are locked.
  const frozenIds: Set<string> = new Set()
  for (const id of state.replacements.keys()) frozenIds.add(id)
  for (const id of state.seenAndPreserved) frozenIds.add(id)

  // Step 3: run the three layers with frozen-id skip. For ids already in
  // state, these are all no-ops. The only non-trivial work happens for
  // fresh ids that have just exited the protected window.
  const step1 = applyToolResultBudget(withReplacements, contextBudgetChars, frozenIds)
  const step2 = microcompact(step1, { frozenIds }).messages
  const step3 = snipConsumedResults(step2, PROTECTED_TURNS, frozenIds)

  // Step 4: record a decision for EVERY tool_result whose id isn't yet in
  // state — including results currently inside the protected window. This
  // is the critical prefix-stability invariant:
  //
  //   Every tool_result must receive its compaction decision on the FIRST
  //   API call where it appears, not on the first call where it's eligible
  //   for compaction.
  //
  // Why it has to be this way:
  //   All three layers respect the protected window, so a fresh tool_result
  //   in the protected window passes through untouched on call N. If we
  //   defer recording until it exits the window on call N+k, the layers
  //   will then decide to compact it, emitting different bytes at the same
  //   position in the message stream. Anthropic's prompt cache keys on
  //   exact prefix bytes, so that single byte-shift at position p forces
  //   a cache-miss for every message at position ≥ p from then on — which
  //   collapses cache-read down to sys+tools only (~8k tokens) for a
  //   100k-token history.
  //
  // By recording on first sight we pin the bytes emitted on call N as the
  // permanent bytes for this id:
  //   - origText === finalText (protected window, or layers chose not to
  //     compact): record as seenAndPreserved. frozenIds will skip this id
  //     on all future calls → original bytes forever.
  //   - origText !== finalText (layers compacted it now): record the
  //     compacted text in replacements. applyKnownReplacements will pin
  //     the same string on all future calls → compacted bytes forever.
  //
  // Trade-off: a tool_result first seen inside the protected window is
  // locked as "preserved" even if compacting it later would free budget.
  // That's fine — by the time it ages out, newer (unrecorded) tool_results
  // are the compaction candidates. Preserves monotone
  // ContentReplacementState semantics.
  let newlyDecided = 0
  let newlyReplaced = 0
  let newlyPreserved = 0
  let totalToolResults = 0

  for (let i = 0; i < messages.length; i++) {
    const origMsg = messages[i]
    if (origMsg.role !== 'toolResult') continue
    totalToolResults++
    const id = (origMsg as ToolResultMessage).toolCallId
    if (state.replacements.has(id) || state.seenAndPreserved.has(id)) continue

    const origText = extractText(origMsg)
    const finalText = extractText(step3[i])

    if (origText !== finalText) {
      state.replacements.set(id, finalText)
      newlyReplaced++
    } else {
      state.seenAndPreserved.add(id)
      newlyPreserved++
    }
    newlyDecided++
  }

  return {
    messages: step3,
    stats: {
      totalToolResults,
      frozenCount: frozenIds.size,
      newlyDecided,
      newlyReplaced,
      newlyPreserved,
    },
  }
}

// ---------------------------------------------------------------------------
// Management helpers
// ---------------------------------------------------------------------------

/**
 * Drop entries whose tool_call_id no longer appears in the given messages.
 * Called after operations that fundamentally rewrite history (LLM
 * autocompact summarization) — stale entries are harmless for correctness
 * (they'd just never be looked up) but bloat memory over long sessions.
 *
 * Not required for cache stability; purely a memory hygiene call.
 */
export function pruneReplacementState(
  state: ContentReplacementState,
  messages: Message[],
): void {
  const liveIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'toolResult') {
      liveIds.add((msg as ToolResultMessage).toolCallId)
    }
  }
  for (const id of state.replacements.keys()) {
    if (!liveIds.has(id)) state.replacements.delete(id)
  }
  for (const id of state.seenAndPreserved) {
    if (!liveIds.has(id)) state.seenAndPreserved.delete(id)
  }
}
