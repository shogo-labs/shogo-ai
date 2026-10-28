// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Context telemetry at turn boundaries.
 *
 * Every turn re-sends the whole context; the only reason that is affordable is
 * the provider's prompt cache. A compaction that rewrites the prefix, or a
 * boundary that drops the previous turn, therefore has a *measurable* cost —
 * and until this file existed it was never measured, so "20% of turn
 * boundaries start with <30% of the previous turn's messages" had to be mined
 * out of a proxy capture (SHO-122).
 *
 *   - `context_turn_boundary` — one per turn: what the turn started with, what
 *     the previous turn contained, whether the prefix it started with is a
 *     prefix of what the previous turn ended on, and the cache tokens the
 *     turn's FIRST model call reported.
 *   - `context_compaction` — one per compaction: which trigger fired, how many
 *     messages went, how big the summary is, and the files/tools the facts
 *     block recorded.
 *
 * Records go to the same OTEL/SigNoz log sink as `retry-telemetry.ts`. The
 * attribute names below are a stable API — saved SigNoz queries use them, and
 * the before/after comparison is read from them grouped by `variant`.
 */

import { createLogger } from '@shogo/shared-runtime'
import { compactionVariant } from './turn-boundary'
import type { TurnSummary } from './turn-boundary'

const log = createLogger('context-telemetry')

/**
 * Cache reads as a share of every billable prompt token on the call:
 * `cacheRead / (input + cacheRead + cacheWrite)`. 0 when the provider reported
 * no tokens at all (a fake LLM in a test reports none — do not read that as a
 * cache miss).
 */
export function cacheHitRatio(
  inputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined,
): number {
  const input = inputTokens ?? 0
  const read = cacheReadTokens ?? 0
  const write = cacheWriteTokens ?? 0
  const total = input + read + write
  return total > 0 ? read / total : 0
}

export interface TurnBoundaryRecord {
  sessionId: string
  model: string
  /** 1-based index of this turn within the session. */
  boundaryIndex: number
  /** Messages the turn's first request carried. */
  messagesAtStart: number
  /** What the previous turn contained (the thing that used to be summarized away). */
  previousTurn: TurnSummary
  /** True when a compaction ran at this boundary. */
  compactedHere: boolean
  compactedBefore?: number | null
  compactedAfter?: number | null
  /**
   * True when the previous turn's per-position prefix tags are a prefix of
   * this turn's — the cache-relevant invariant. `null` on the first turn.
   */
  prefixStable: boolean | null
  inputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

export function recordTurnBoundary(record: TurnBoundaryRecord): void {
  try {
    const attrs = {
      event: 'context_turn_boundary',
      projectId: process.env.PROJECT_ID ?? null,
      sessionId: record.sessionId,
      model: record.model,
      variant: compactionVariant(),
      boundaryIndex: record.boundaryIndex,
      messagesAtStart: record.messagesAtStart,
      previousTurnMessages: record.previousTurn.messages,
      previousTurnRounds: record.previousTurn.rounds,
      previousTurnToolCalls: record.previousTurn.toolCalls,
      previousTurnToolNames: record.previousTurn.toolNames.join(','),
      previousTurnPlaceholders: record.previousTurn.placeholders,
      compactedHere: record.compactedHere,
      compactedBefore: record.compactedBefore ?? null,
      compactedAfter: record.compactedAfter ?? null,
      prefixStable: record.prefixStable,
      inputTokens: record.inputTokens ?? null,
      cacheReadTokens: record.cacheReadTokens ?? null,
      cacheWriteTokens: record.cacheWriteTokens ?? null,
      cacheHitRatio: cacheHitRatio(record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens),
    }
    log.info('context turn boundary', attrs)
  } catch {
    /* telemetry never breaks a turn */
  }
}

export type CompactionTrigger = 'pre-turn' | 'post-turn' | 'reactive' | 'mid-turn'

export interface CompactionRecord {
  sessionId: string
  trigger: CompactionTrigger
  messagesBefore: number
  messagesAfter: number
  summaryChars: number
  /** Paths the deterministic facts block recorded. */
  filesTouched: string[]
  /** Tool names the deterministic facts block recorded. */
  toolsUsed: string[]
  /** Rounds folded by the oversized-turn valve. */
  foldedRounds?: number
  firstCallCacheHitRatio?: number | null
}

export function recordCompaction(record: CompactionRecord): void {
  try {
    const attrs = {
      event: 'context_compaction',
      projectId: process.env.PROJECT_ID ?? null,
      sessionId: record.sessionId,
      variant: compactionVariant(),
      trigger: record.trigger,
      messagesBefore: record.messagesBefore,
      messagesAfter: record.messagesAfter,
      summaryChars: record.summaryChars,
      foldedRounds: record.foldedRounds ?? 0,
      filesTouched: record.filesTouched.join(','),
      toolsUsed: record.toolsUsed.join(','),
      firstCallCacheHitRatio: record.firstCallCacheHitRatio ?? null,
    }
    log.info('context compaction', attrs)
  } catch {
    /* telemetry never breaks a turn */
  }
}

/**
 * True when `previous` is a prefix of `current`: the starting state of this
 * turn still begins with what the previous turn ended on, so the provider can
 * serve at least that much of the prefix from cache.
 */
export function isPrefixOf(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length > current.length) return false
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== current[i]) return false
  }
  return true
}
