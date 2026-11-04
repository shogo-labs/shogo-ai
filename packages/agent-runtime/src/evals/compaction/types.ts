// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Types for the compaction eval (SHO-327).
 *
 * A compaction is scored on three things at once — how much wire context it
 * actually freed, what the agent can still *do* afterwards, and what it cost to
 * get there. `Stored chars` is not a metric: `buildHistory`, the tool-result
 * budget, microcompact and `snipConsumedResults` all rewrite the array again
 * before it is sent, so every number here is measured **after every layer**.
 */
import type { Message } from '@mariozechner/pi-ai'

export type CompactionFixtureSource = 'synthetic' | 'real'

/** A probe question with its ground truth. */
export interface CompactionProbe {
  id: string
  /** What the planted fact is, for the report. */
  kind: 'user-value' | 'error-fix' | 'decision' | 'file-location' | 'next-step' | 'tool-result-only'
  question: string
  /**
   * Strings the answer must contain (case-insensitive) — the ground truth for
   * anything a string match can grade, taken from the fixture itself and never
   * from the summary under test.
   */
  expected: string[]
  /**
   * `judge` asks a model to grade the answer against `rubric`; `string` is a
   * plain containment check.
   */
  grader: 'string' | 'judge'
  /** Only for `grader: 'judge'`. */
  rubric?: string
}

/** The real next step a fixture's continuation begins with. */
export interface CompactionNextAction {
  tool: string
  /** Path the call touched, when the tool takes one. */
  targetPath?: string
  /** Canonical argument fingerprint, for the re-read detector. */
  argsKey?: string
}

export interface CompactionFixture {
  id: string
  source: CompactionFixtureSource
  /** Project the session came from, for the report ("planner", "dev", …). */
  project?: string
  /** History as it stood when the compaction fired (or would fire). */
  messages: Message[]
  /** The user message that followed the compaction, verbatim. */
  nextUserMessage: string
  /** First tool call of the continuation, from the real transcript. */
  nextAction: CompactionNextAction | null
  /** Calls made in the continuation (up to 3) — the re-read denominator. */
  continuationCalls: CompactionNextAction[]
  /** Probe questions, ground truth plantable in the head. */
  probes: CompactionProbe[]
  /** Tools offered to the next-step probe. */
  tools: string[]
}

/** One summarizer call's accounting. */
export interface CallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  latencyMs: number
}

/** Metrics for one (fixture, variant) pair. */
export interface FixtureVariantResult {
  fixtureId: string
  variantId: string
  tokensBefore: number
  tokensAfter: number
  /** Points of wire context freed: (before - after) / before * 100. */
  freedPct: number
  summaryChars: number
  summarizerChars: number
  summarize: CallUsage
  /** Cache-write tokens on the first call after the compaction (0 when unmeasured). */
  firstCallCacheWriteTokens: number
  /** 0..1 — share of probes answered correctly. */
  factRecall: number
  /** Probes answered correctly / asked. */
  probesPassed: number
  probesAsked: number
  /** 0, 0.5 or 1 for the next-step probe; null when the fixture has no next action. */
  nextActionMatch: number | null
  nextActionDetail?: string
  /** Share of continuation calls that repeat a call whose result was dropped. */
  reReadRate: number | null
  /** Calls to tools that were never offered (SHO-122 guard). */
  inventedTools: number
  /** Tool results the variant dropped in this fixture (0 for A/C). */
  droppedResults: number
  error?: string
}

/** Aggregate over fixtures for one variant. */
export interface VariantSummary {
  variantId: string
  fixtures: number
  meanFreedPct: number
  meanTokensAfter: number
  meanFactRecall: number
  meanNextActionMatch: number
  meanReReadRate: number
  inventedTools: number
  meanSummaryChars: number
  totalCostUsd: number
  meanLatencyMs: number
  /** The 3 fixtures that scored worst on fact recall, then next action. */
  worst: FixtureVariantResult[]
  errors: number
}
