// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Graders — pure functions, no model calls, so the metric math is unit-tested
 * with a mocked summarizer and a test run never bills anyone (SHO-327).
 */
import type { CompactionNextAction, CompactionProbe } from './types'

/** Case- and whitespace-insensitive containment check. */
export function matchesExpected(answer: string, expected: readonly string[]): boolean {
  const haystack = answer.toLowerCase().replace(/\s+/g, ' ')
  return expected.every((needle) => haystack.includes(needle.toLowerCase().replace(/\s+/g, ' ')))
}

/** Fraction of `expected` strings present — used to explain a partial miss. */
export function expectedCoverage(answer: string, expected: readonly string[]): number {
  if (expected.length === 0) return 1
  const haystack = answer.toLowerCase().replace(/\s+/g, ' ')
  const hits = expected.filter((n) => haystack.includes(n.toLowerCase().replace(/\s+/g, ' '))).length
  return hits / expected.length
}

/**
 * 1 — same tool and the same target; 0.5 — same tool only; 0 — anything else.
 * `actual` is the first call the model made when handed the compacted context
 * and the real next user message.
 */
export function gradeNextAction(
  actual: { tool: string; update?: Record<string, any> } | null,
  truth: CompactionNextAction | null,
): { score: number | null; detail: string } {
  if (!truth) return { score: null, detail: 'no ground truth' }
  if (!actual) return { score: 0, detail: 'no tool call made' }
  if (actual.tool !== truth.tool) {
    return { score: 0, detail: `called ${actual.tool}, expected ${truth.tool}` }
  }
  if (!truth.targetPath && !truth.argsKey) {
    return { score: 0.5, detail: `same tool (${truth.tool}), target not compared` }
  }
  const args = actual.update ?? {}
  const actualPath = String(args.path ?? args.file_path ?? args.target_file ?? '')
  const samePath =
    truth.targetPath !== undefined &&
    (actualPath === truth.targetPath || actualPath.endsWith(`/${truth.targetPath}`))
  const sameArgs =
    truth.argsKey !== undefined && normaliseArgs(JSON.stringify(args)) === normaliseArgs(truth.argsKey)
  if (samePath || sameArgs) return { score: 1, detail: `same tool and target (${truth.tool})` }
  return {
    score: 0.5,
    detail: `same tool (${truth.tool}), different target ${actualPath || JSON.stringify(args)}`,
  }
}

/** Argument objects serialise with different key order; compare sorted. */
function normaliseArgs(json: string): string {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    return JSON.stringify(Object.keys(parsed).sort().map((k) => [k, parsed[k]]))
  } catch {
    return json
  }
}

/**
 * Share of continuation calls that repeat a call whose result the compaction
 * dropped — what dropping costs. `null` when nothing was dropped or the
 * fixture has no continuation, so it is excluded from the mean rather than
 * silently counted as zero.
 */
export function reReadRate(
  continuationCalls: readonly CompactionNextAction[],
  droppedCalls: readonly CompactionNextAction[],
): number | null {
  if (droppedCalls.length === 0) return null
  if (continuationCalls.length === 0) return 0
  const dropped = new Set(droppedCalls.map((c) => `${c.tool}|${normaliseArgs(c.argsKey ?? '')}`))
  const repeats = continuationCalls.filter((c) => dropped.has(`${c.tool}|${normaliseArgs(c.argsKey ?? '')}`))
  return repeats.length / continuationCalls.length
}

/** A call to a tool that was never offered (the SHO-122 regression). */
export function countsAsInvented(tool: string, offered: readonly string[]): boolean {
  return !offered.includes(tool)
}

/** `factRecall` over one fixture's probes: passed / asked. */
export function factRecall(passed: number, asked: number): number {
  return asked === 0 ? 1 : passed / asked
}

/** Mean of the defined values; `null` when none are. */
export function mean(values: ReadonlyArray<number | null | undefined>): number {
  const defined = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (defined.length === 0) return 0
  return defined.reduce((sum, v) => sum + v, 0) / defined.length
}

/** Points of wire context a compaction freed. */
export function freedPct(tokensBefore: number, tokensAfter: number): number {
  if (tokensBefore <= 0) return 0
  return ((tokensBefore - tokensAfter) / tokensBefore) * 100
}

/** Probe ids this fixture can only answer from a tool result. */
export function toolResultProbes(probes: readonly CompactionProbe[]): CompactionProbe[] {
  return probes.filter((p) => p.kind === 'tool-result-only')
}
