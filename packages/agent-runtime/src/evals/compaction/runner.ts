// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The compaction eval itself (SHO-327).
 *
 * For every (fixture, variant) pair it runs the *production* pipeline —
 * `SessionManager.compact`, then `buildHistory`, then the wire layers
 * (`applyToolResultBudget` → `microcompact` → `snipConsumedResults`) — and
 * measures the array that would actually be sent, never the stored one.
 *
 * Then it asks two questions of that array, with the same model:
 *  - `factRecall`: can the agent still answer what it was told? Planted facts
 *    are string-matched; decisions and the next step go to a model judge.
 *  - `nextActionMatch`: handed the compaction and the real next user message,
 *    does it call the same tool it really called next?
 *
 * All model work is behind `deps`, so a unit test runs the whole thing with a
 * mocked summarizer and no paid call.
 */
import type { Message } from '@mariozechner/pi-ai'
import {
  SessionManager,
  applyToolResultBudget,
  snipConsumedResults,
  estimateMessageArrayTokens,
  type SummarizeFn,
} from '../../session-manager'
import { microcompact } from '../../microcompact'
import { renderTranscriptForSummary } from '../../compaction-transcript'
import type { CompactionVariantConfig } from '../../compaction-variants'
import type { ChatClient, ChatToolSpec } from './model-client'
import type { CallUsage, CompactionFixture, FixtureVariantResult } from './types'
import { factRecall as factRecallOf, freedPct, gradeNextAction, matchesExpected, reReadRate } from './graders'

export interface SummarizeStats {
  usage: CallUsage
  /** Chars of transcript handed to the summarizer across all chunks. */
  transcriptChars: number
  chunks: number
}

export interface CompactionEvalDeps {
  /** The summarizer for one variant — variant C hands it a different transcript. */
  summarizeFor: (variant: CompactionVariantConfig) => SummarizeFn
  /** Stats accrued since the previous call, then reset. */
  takeSummarizeStats: () => SummarizeStats
  probe: ChatClient
  /** Grades a free-text answer against a rubric. */
  judge: (rubric: string, answer: string) => Promise<boolean>
}

const EMPTY_STATS: SummarizeStats = {
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, latencyMs: 0 },
  transcriptChars: 0,
  chunks: 0,
}

/** The gateway's pre-send pipeline, in the gateway's order. */
export function wireLayers(sm: SessionManager, history: Message[], contextBudgetChars: number): Message[] {
  let out = applyToolResultBudget(history, contextBudgetChars)
  out = microcompact(out).messages
  out = snipConsumedResults(out)
  return out
}

/** Every tool the fixture offers, with a permissive schema. */
export function fixtureToolSpecs(names: readonly string[]): ChatToolSpec[] {
  return names.map((name) => ({
    name,
    description:
      name === 'read_file'
        ? 'Read a file from the workspace'
        : name === 'exec'
          ? 'Run a shell command'
          : `${name} — the agent tool of this name`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        command: { type: 'string' },
        pattern: { type: 'string' },
        query: { type: 'string' },
      },
    },
  }))
}

/** Render what the agent would see, for a probe turn. */
export function renderWireForProbe(messages: readonly Message[]): string {
  return renderTranscriptForSummary(messages, { maxChars: 400_000 })
}

export interface RunOptions {
  variant: CompactionVariantConfig
  /** Skip the model probes (measures context only) — used by the unit test. */
  skipProbes?: boolean
}

/**
 * Run one fixture under one variant. Never throws: a summarizer failure is
 * reported in `error` so one bad fixture cannot abort a paid run.
 */
export async function runFixtureVariant(
  fixture: CompactionFixture,
  deps: CompactionEvalDeps,
  opts: RunOptions,
): Promise<FixtureVariantResult> {
  const sm = new SessionManager({
    sessionTtlSeconds: 3_600,
    maxMessages: 0,
    estimatedTokensPerMessage: 1,
    maxEstimatedTokens: 0,
    keepRecentMessages: 8,
    pruneIntervalSeconds: 3_600,
    pruning: false,
    contextWindowTokens: 400_000,
    compactionVariant: opts.variant.id,
  })
  sm.setSummarizeFn(deps.summarizeFor(opts.variant))

  const sessionId = `eval-${fixture.id}`
  sm.getOrCreate(sessionId)
  sm.addMessages(sessionId, ...fixture.messages)

  const contextBudgetChars = sm.autocompactThreshold * 4
  const before = wireLayers(sm, sm.buildHistory(sessionId), contextBudgetChars)
  const tokensBefore = estimateMessageArrayTokens(before)

  deps.takeSummarizeStats() // reset

  let droppedCalls: Array<{ tool: string; argsKey?: string }> = []
  let droppedResults = 0
  let summaryChars = 0
  try {
    const result = await sm.compact(sessionId)
    if (result) {
      summaryChars = result.summary.length
      droppedResults = result.droppedToolResults ?? 0
      droppedCalls = (result.droppedCalls ?? []).map((c) => ({ tool: c.toolName, argsKey: c.args }))
    }
  } catch (err: any) {
    return failed(fixture, opts, tokensBefore, err?.message ?? String(err))
  }

  const stats = deps.takeSummarizeStats()
  const after = wireLayers(sm, sm.buildHistory(sessionId), contextBudgetChars)
  const tokensAfter = estimateMessageArrayTokens(after)

  const base: FixtureVariantResult = {
    fixtureId: fixture.id,
    variantId: opts.variant.id,
    tokensBefore,
    tokensAfter,
    freedPct: freedPct(tokensBefore, tokensAfter),
    summaryChars,
    summarizerChars: stats.transcriptChars,
    summarize: stats.usage,
    firstCallCacheWriteTokens: stats.usage.cacheWriteTokens,
    factRecall: 1,
    probesPassed: 0,
    probesAsked: 0,
    nextActionMatch: null,
    reReadRate: reReadRate(fixture.continuationCalls, droppedCalls),
    inventedTools: 0,
    droppedResults,
  }

  if (opts.skipProbes) return base

  try {
    const rendered = renderWireForProbe(after)
    const system =
      'You are the same coding agent that has been working on this task. ' +
      'You have just been through a context compaction. Answer only from the transcript below — ' +
      'if a fact is not there, say "not available". Be terse.'

    let passed = 0
    for (const probe of fixture.probes) {
      const { text } = await deps.probe.complete({
        system,
        prompt: `Transcript:\n${rendered}\n\nQuestion: ${probe.question}`,
        // Generative-reasoning models spend most of a small budget thinking and
        // return null content, which reads as "cannot answer" — a measurement
        // artefact, not a compaction failure.
        maxTokens: 1_500,
      })
      const ok =
        probe.grader === 'string'
          ? matchesExpected(text, probe.expected)
          : await deps.judge(probe.rubric ?? probe.question, text)
      if (ok) passed++
    }
    base.probesAsked = fixture.probes.length
    base.probesPassed = passed
    base.factRecall = factRecallOf(passed, fixture.probes.length)

    const step = await deps.probe.firstToolCall({
      system:
        'You are the same coding agent continuing this task. You have just been through a context ' +
        'compaction. Call the single tool you would call next — do not explain.',
      prompt: `Transcript:\n${rendered}\n\nNext user message:\n${fixture.nextUserMessage}`,
      tools: fixtureToolSpecs(fixture.tools),
    })
    if (step.tool && !fixture.tools.includes(step.tool)) base.inventedTools = 1
    const graded = gradeNextAction(
      step.tool ? { tool: step.tool, update: step.args } : null,
      fixture.nextAction,
    )
    base.nextActionMatch = graded.score
    base.nextActionDetail = graded.detail
  } catch (err: any) {
    base.error = `probe failed: ${err?.message ?? err}`
  }

  return base
}

function failed(
  fixture: CompactionFixture,
  opts: RunOptions,
  tokensBefore: number,
  message: string,
): FixtureVariantResult {
  return {
    fixtureId: fixture.id,
    variantId: opts.variant.id,
    tokensBefore,
    tokensAfter: tokensBefore,
    freedPct: 0,
    summaryChars: 0,
    summarizerChars: 0,
    summarize: EMPTY_STATS.usage,
    firstCallCacheWriteTokens: 0,
    factRecall: 0,
    probesPassed: 0,
    probesAsked: fixture.probes.length,
    nextActionMatch: null,
    reReadRate: null,
    inventedTools: 0,
    droppedResults: 0,
    error: message,
  }
}
