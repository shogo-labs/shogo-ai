// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The compaction eval's own tests (SHO-327).
 *
 * AC1: `run-eval --track compaction` runs end to end; this is that end-to-end
 * path driven with a **mocked summarizer**, so a test run makes no paid call
 * and the metric math is asserted exactly.
 * The gate is tested in both directions — including a hand-edited baseline,
 * which is the only way to make a regression look green.
 */
import { describe, test, expect } from 'bun:test'
import { syntheticFixtures } from '../evals/compaction/fixtures'
import { runFixtureVariant, type CompactionEvalDeps, type SummarizeStats } from '../evals/compaction/runner'
import { COMPACTION_VARIANTS } from '../compaction-variants'
import {
  freedPct,
  gradeNextAction,
  matchesExpected,
  reReadRate,
} from '../evals/compaction/graders'
import { evaluateVariantGate, parseRequiredTracks, trackStatuses } from '../evals/compaction/gate'
import { comparableFixtures, renderCompactionReport, summariseVariant } from '../evals/compaction/report'
import type { FixtureVariantResult, VariantSummary } from '../evals/compaction/types'
import type { ChatClient } from '../evals/compaction/model-client'

function mockDeps(transcript = '## Decisions\n- decided\n## Current state\n- next step\n'): CompactionEvalDeps {
  let stats: SummarizeStats = {
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, latencyMs: 5 },
    transcriptChars: 0,
    chunks: 0,
  }
  const probe: ChatClient = {
    model: 'mock',
    async complete({ prompt }) {
      // Echo the transcript so a string-matched probe can hit on real content.
      return {
        text: prompt,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0001, latencyMs: 1 },
      }
    },
    async firstToolCall() {
      return {
        tool: 'exec',
        args: { command: 'bun test' },
        text: '',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0001, latencyMs: 1 },
      }
    },
  }
  return {
    summarizeFor: () => async () => transcript,
    takeSummarizeStats: () => {
      const out = { ...stats, usage: { ...stats.usage } }
      stats = { ...stats, transcriptChars: 0, chunks: 0, usage: { ...stats.usage, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } }
      return out
    },
    probe,
    judge: async () => true,
  }
}

/** A minimal graded cell, for the aggregation tests. */
function fakeResult(overrides: Partial<FixtureVariantResult>): FixtureVariantResult {
  return {
    fixtureId: 'f1',
    variantId: 'A',
    tokensBefore: 1000,
    tokensAfter: 400,
    freedPct: 60,
    summaryChars: 100,
    summarizerChars: 50,
    summarize: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, latencyMs: 10 },
    firstCallCacheWriteTokens: 0,
    factRecall: 0.5,
    probesPassed: 1,
    probesAsked: 2,
    nextActionMatch: 0.5,
    reReadRate: 0,
    inventedTools: 0,
    droppedResults: 0,
    ...overrides,
  }
}

describe('fixtures', () => {
  test('six committed fixtures, each with all six planted facts', () => {
    const fixtures = syntheticFixtures()
    expect(fixtures.length).toBe(6)
    for (const fixture of fixtures) {
      const kinds = fixture.probes.map((p) => p.kind)
      expect(kinds).toContain('user-value')
      expect(kinds).toContain('error-fix')
      expect(kinds).toContain('decision')
      expect(kinds).toContain('file-location')
      expect(kinds).toContain('next-step')
      expect(kinds).toContain('tool-result-only')
      expect(fixture.nextUserMessage.length).toBeGreaterThan(0)
    }
  })

  test('the tool-result-only fact is inside a tool result, not user text', () => {
    for (const fixture of syntheticFixtures()) {
      const probe = fixture.probes.find((p) => p.kind === 'tool-result-only')!
      const userText = fixture.messages
        .filter((m) => m.role === 'user')
        .map((m) => String((m as any).content))
        .join('\n')
      expect(userText.includes(probe.expected[0])).toBe(false)
    }
  })
})

describe('metric math', () => {
  test('freedPct is wire tokens, not stored chars', () => {
    expect(freedPct(1000, 400)).toBe(60)
    expect(freedPct(0, 0)).toBe(0)
  })

  test('fact recall needs every expected string', () => {
    expect(matchesExpected('The path was src/a.ts line 12', ['src/a.ts', '12'])).toBe(true)
    expect(matchesExpected('The path was src/a.ts', ['src/a.ts', '12'])).toBe(false)
  })

  test('next action: 1 / 0.5 / 0', () => {
    const truth = { tool: 'read_file', targetPath: 'src/a.ts' }
    expect(gradeNextAction({ tool: 'read_file', update: { path: 'src/a.ts' } }, truth).score).toBe(1)
    expect(gradeNextAction({ tool: 'read_file', update: { path: 'src/b.ts' } }, truth).score).toBe(0.5)
    expect(gradeNextAction({ tool: 'exec', update: { command: 'ls' } }, truth).score).toBe(0)
    expect(gradeNextAction(null, truth).score).toBe(0)
    expect(gradeNextAction({ tool: 'x' }, null).score).toBeNull()
  })

  test('re-read rate counts repeats of a dropped call and is null when nothing dropped', () => {
    expect(reReadRate([{ tool: 'exec', argsKey: '{"command":"bun test"}' }], [])).toBeNull()
    expect(
      reReadRate(
        [{ tool: 'exec', argsKey: '{"command":"bun test"}' }, { tool: 'read_file', argsKey: '{"path":"a"}' }],
        [{ tool: 'exec', argsKey: '{"command":"bun test"}' }],
      ),
    ).toBe(0.5)
  })
})

describe('runner', () => {
  test('D frees more wire context than A on every synthetic fixture, with a mocked summarizer', async () => {
    const deps = mockDeps()
    for (const fixture of syntheticFixtures()) {
      const a = await runFixtureVariant(fixture, deps, { variant: COMPACTION_VARIANTS.A, skipProbes: true })
      const d = await runFixtureVariant(fixture, deps, { variant: COMPACTION_VARIANTS.D, skipProbes: true })
      expect(a.error).toBeUndefined()
      expect(d.error).toBeUndefined()
      expect(d.tokensAfter).toBeLessThan(a.tokensAfter)
      expect(d.summaryChars).toBeGreaterThan(0)
      expect(d.freedPct).toBeGreaterThan(a.freedPct)
    }
  })

  test('A drops nothing; B1 drops something and reports it', async () => {
    const deps = mockDeps()
    const fixture = syntheticFixtures()[0]
    const a = await runFixtureVariant(fixture, deps, { variant: COMPACTION_VARIANTS.A, skipProbes: true })
    const b = await runFixtureVariant(fixture, deps, { variant: COMPACTION_VARIANTS.B1, skipProbes: true })
    expect(a.droppedResults).toBe(0)
    expect(b.droppedResults).toBeGreaterThan(0)
    expect(b.reReadRate).not.toBeNull()
  })

  test('the full probe path runs and grades with the mocked client', async () => {
    const deps = mockDeps()
    const fixture = syntheticFixtures()[0]
    const result = await runFixtureVariant(fixture, deps, { variant: COMPACTION_VARIANTS.A })
    expect(result.error).toBeUndefined()
    expect(result.probesAsked).toBe(fixture.probes.length)
    // The mocked probe echoes the transcript and the judge always passes.
    expect(result.factRecall).toBeGreaterThan(0)
    expect(result.nextActionMatch).not.toBeNull()
    expect(result.inventedTools).toBe(0)
  })
})

function summary(overrides: Partial<VariantSummary>): VariantSummary {
  return {
    variantId: 'X',
    fixtures: 30,
    meanFreedPct: 50,
    meanTokensAfter: 80_000,
    meanFactRecall: 0.9,
    meanNextActionMatch: 0.8,
    meanReReadRate: 0.1,
    inventedTools: 0,
    meanSummaryChars: 12_000,
    totalCostUsd: 1,
    meanLatencyMs: 900,
    worst: [],
    errors: 0,
    ...overrides,
  }
}

describe('gate', () => {
  const baseline = summary({ variantId: 'A', meanFreedPct: 50 })

  test('passes a variant that frees 15+ points and holds quality', () => {
    const result = evaluateVariantGate({
      summary: summary({ variantId: 'B1', meanFreedPct: 65, meanFactRecall: 0.88, meanNextActionMatch: 0.78, meanReReadRate: 0.18 }),
      baseline,
      requiredTracks: { 'context-retention': true, 'cache-compaction-recovery': true },
    })
    expect(result.ok).toBe(true)
  })

  test('fails a variant that frees too little', () => {
    const result = evaluateVariantGate({ summary: summary({ variantId: 'C', meanFreedPct: 55 }), baseline })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'freedPct')!.ok).toBe(false)
  })

  test('fails a variant that loses fact recall', () => {
    const result = evaluateVariantGate({
      summary: summary({ variantId: 'D', meanFreedPct: 70, meanFactRecall: 0.8 }),
      baseline,
    })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'factRecall')!.ok).toBe(false)
  })

  test('fails a variant that makes the agent re-read', () => {
    const result = evaluateVariantGate({
      summary: summary({ variantId: 'B0', meanFreedPct: 70, meanReReadRate: 0.35 }),
      baseline,
    })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'reReadRate')!.ok).toBe(false)
  })

  test('fails when a required track fails', () => {
    const result = evaluateVariantGate({
      summary: summary({ variantId: 'B1', meanFreedPct: 70 }),
      baseline,
      requiredTracks: { 'context-retention': true, 'cache-compaction-recovery': false },
    })
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('external-track-failed')
  })

  // QA round 1, SHO-327: the check used to pass when a track was absent, so a
  // run that executed neither supporting track printed "required tracks pass"
  // — a false green on the one check that guards the default flip.
  test('fails closed when a required track never ran', () => {
    const result = evaluateVariantGate({
      summary: summary({ variantId: 'B1', meanFreedPct: 90, meanFactRecall: 0.95, meanReReadRate: 0.05 }),
      baseline,
    })
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('external-track-not-run')
    const check = result.checks.find((c) => c.name === 'requiredTracks')!
    expect(check.ok).toBe(false)
    expect(check.detail).toContain('not run: context-retention')
    expect(check.detail).not.toContain('pass')
  })

  test('one unrun track fails the gate even when the other passed', () => {
    const result = evaluateVariantGate({
      summary: summary({ variantId: 'B1', meanFreedPct: 90 }),
      baseline,
      requiredTracks: { 'context-retention': true },
    })
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'requiredTracks')!.detail).toBe('not run: cache-compaction-recovery')
  })

  test('tracks read as pass, fail or not-run — absence is not a pass', () => {
    expect(trackStatuses()).toEqual({ 'context-retention': 'not-run', 'cache-compaction-recovery': 'not-run' })
    expect(trackStatuses({ 'context-retention': true, 'cache-compaction-recovery': false })).toEqual({
      'context-retention': 'pass',
      'cache-compaction-recovery': 'fail',
    })
    // An extra track a run chose to record is reported alongside the required pair.
    expect(trackStatuses({ 'my-extra-track': true })['my-extra-track']).toBe('pass')
  })

  test('--tracks parses explicit results and rejects anything vague', () => {
    expect(parseRequiredTracks(undefined)).toEqual({})
    expect(parseRequiredTracks('')).toEqual({})
    expect(parseRequiredTracks('context-retention=true, cache-compaction-recovery=false')).toEqual({
      'context-retention': true,
      'cache-compaction-recovery': false,
    })
    expect(() => parseRequiredTracks('context-retention=yes')).toThrow(/true or false/)
    expect(() => parseRequiredTracks('context-retention')).toThrow(/name=true\|false/)
    expect(() => parseRequiredTracks('vibes=true')).toThrow(/unknown track/)
  })

  test('a hand-edited baseline cannot make a regression look green', () => {
    // Baseline hand-lowered to "frees nothing": a candidate that frees 5 more
    // points would pass on freed%, but quality is compared against it too.
    const edited = summary({ variantId: 'A', meanFreedPct: 0, meanFactRecall: 1, meanNextActionMatch: 1 })
    const result = evaluateVariantGate({
      summary: summary({ variantId: 'B1', meanFreedPct: 5, meanFactRecall: 0.9 }),
      baseline: edited,
    })
    expect(result.ok).toBe(false)
  })

  test('no baseline is not a pass', () => {
    const result = evaluateVariantGate({ summary: summary({}), baseline: null })
    expect(result.ok).toBe(false)
    expect(result.reasons).toEqual(['no-baseline'])
  })
})

describe('report', () => {
  test('one table row per variant, with spend and the worst fixtures', () => {
    const results: FixtureVariantResult[] = [
      {
        fixtureId: 'f1',
        variantId: 'A',
        tokensBefore: 1000,
        tokensAfter: 400,
        freedPct: 60,
        summaryChars: 100,
        summarizerChars: 50,
        summarize: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, latencyMs: 10 },
        firstCallCacheWriteTokens: 0,
        factRecall: 0.5,
        probesPassed: 1,
        probesAsked: 2,
        nextActionMatch: 0.5,
        reReadRate: 0,
        inventedTools: 0,
        droppedResults: 0,
      },
    ]
    const summaries = [summariseVariant('A', results)]
    const report = renderCompactionReport({
      fixtures: 1,
      model: 'mock',
      summarizerModel: 'mock',
      variants: summaries,
      results,
      baseline: summaries[0],
      spendUsd: 0.01,
    })
    expect(report).toContain('| **A** |')
    expect(report).toContain('$0.0100')
    expect(report).toContain('f1')
  })

  test('only fixtures every variant graded are comparable', () => {
    const results = [
      fakeResult({ fixtureId: 'shared-1', variantId: 'A' }),
      fakeResult({ fixtureId: 'shared-1', variantId: 'B1' }),
      fakeResult({ fixtureId: 'shared-2', variantId: 'A' }),
      fakeResult({ fixtureId: 'shared-2', variantId: 'B1' }),
      fakeResult({ fixtureId: 'a-only', variantId: 'A' }),
    ]
    expect(comparableFixtures(results, ['A', 'B1'])).toEqual(['shared-1', 'shared-2'])
    // A variant that graded nothing makes every fixture incomparable — the
    // caller must fall back to the full set rather than report an empty sample.
    expect(comparableFixtures(results, ['A', 'B1', 'D'])).toEqual([])
    expect(comparableFixtures([], ['A'])).toEqual([])
  })

  test('the report header shows a track that never ran as NOT RUN', () => {
    const report = renderCompactionReport({
      fixtures: 1,
      model: 'mock',
      summarizerModel: 'mock',
      variants: [summariseVariant('A', [fakeResult({})])],
      results: [fakeResult({})],
      baseline: null,
      requiredTracks: { 'context-retention': true },
      spendUsd: 0,
    })
    expect(report).toContain('context-retention: pass')
    expect(report).toContain('cache-compaction-recovery: **NOT RUN**')
  })

  test('the report states when partial coverage was excluded', () => {
    const cell = fakeResult({})
    const report = renderCompactionReport({
      fixtures: 2,
      model: 'mock',
      summarizerModel: 'mock',
      variants: [summariseVariant('A', [cell])],
      results: [cell],
      baseline: null,
      excludedCells: 4,
      spendUsd: 0.01,
    })
    expect(report).toContain('graded by **every** variant')
    expect(report).toContain('4 cell(s) with partial coverage excluded')
  })
})
