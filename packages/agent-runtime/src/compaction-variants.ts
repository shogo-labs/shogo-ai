// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The compaction variants under test (SHO-327).
 *
 * A compaction has one cost and two benefits that can be traded against each
 * other: the summary itself costs a call, the freed context is what it buys,
 * and what the agent can still *do* afterwards is what it must not lose. The
 * evals score all three per variant; this module is the single switch that
 * selects one so the runtime and the eval run the same code.
 *
 * **`A` is production today.** With no configuration the variant resolves to
 * `A`, which drops nothing and hands the summarizer the full transcript — i.e.
 * byte-identical output to the code before this change (tested).
 *
 * - `B0/B1/B2` drop tool results in the *kept tail* at the moment a compaction
 *   applies, protecting the last 0/1/2 assistant rounds of that tail.
 * - `C` hands the summarizer the `← name result (N chars)` line instead of the
 *   result body (errors keep their first 300 chars), so the summarize call gets
 *   cheaper.
 * - `D` is `B1 + C`.
 */
import type { Message } from '@mariozechner/pi-ai'
import { dropToolResultsAtCompaction } from './compaction-drop'

export type CompactionVariantId = 'A' | 'B0' | 'B1' | 'B2' | 'C' | 'D'

export interface CompactionVariantConfig {
  id: CompactionVariantId
  /**
   * Assistant rounds of the kept tail whose tool results survive the drop.
   * `null` = never drop (variant A).
   */
  dropToolResultProtectedTurns: number | null
  /** Summarizer sees only the result line, not its body (variant C). */
  summaryOmitsResultBodies: boolean
}

export const COMPACTION_VARIANTS: Record<CompactionVariantId, CompactionVariantConfig> = {
  A: { id: 'A', dropToolResultProtectedTurns: null, summaryOmitsResultBodies: false },
  B0: { id: 'B0', dropToolResultProtectedTurns: 0, summaryOmitsResultBodies: false },
  B1: { id: 'B1', dropToolResultProtectedTurns: 1, summaryOmitsResultBodies: false },
  B2: { id: 'B2', dropToolResultProtectedTurns: 2, summaryOmitsResultBodies: false },
  C: { id: 'C', dropToolResultProtectedTurns: null, summaryOmitsResultBodies: true },
  D: { id: 'D', dropToolResultProtectedTurns: 1, summaryOmitsResultBodies: true },
}

/** Production behaviour until the eval says otherwise. */
export const DEFAULT_COMPACTION_VARIANT: CompactionVariantId = 'A'

/**
 * `COMPACTION_VARIANT` (A/B0/B1/B2/C/D), falling back to `A`. An unknown value
 * falls back to `A` rather than throwing: a typo must not change what ships.
 */
export function resolveCompactionVariant(
  raw?: string | null,
  source: Record<string, string | undefined> = process.env,
): CompactionVariantConfig {
  const id = (raw ?? source.COMPACTION_VARIANT ?? '').trim().toUpperCase()
  return COMPACTION_VARIANTS[id as CompactionVariantId] ?? COMPACTION_VARIANTS[DEFAULT_COMPACTION_VARIANT]
}

/**
 * Apply a variant's drop to the messages a compaction is about to keep.
 * A variant that drops nothing returns the array unchanged (same identities),
 * so `A` stays byte-identical.
 */
export function applyVariantToKeptTail(
  variant: CompactionVariantConfig,
  kept: Message[],
): ReturnType<typeof dropToolResultsAtCompaction> {
  if (variant.dropToolResultProtectedTurns === null) return { messages: kept, dropped: [] }
  return dropToolResultsAtCompaction(kept, { protectedTurns: variant.dropToolResultProtectedTurns })
}
