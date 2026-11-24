// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The compaction summarizer, extracted from `AgentGateway` (SHO-327).
 *
 * The body used to live inline in the gateway's startup, which meant a
 * hand-copied version in an eval would be a different summarizer with the same
 * name — the eval would then be measuring itself. It is a factory now so the
 * runtime (`gateway.start`) and `run-eval --track compaction` call exactly the
 * same code.
 *
 * The model is the admin-selected summarizer (Hoshi 2.0 by default) and runs on
 * its own provider, never the session's: the proxy routes by provider, so a
 * mismatched pair sends the model to the wrong upstream.
 */
import type { Message } from '@mariozechner/pi-ai'
import { renderTranscriptForSummary } from './compaction-transcript'
import type { SummarizeFn, SummarizeMergeFn } from './session-manager'
import { resolveCompactionVariant } from './compaction-variants'

export interface CompactionSummarizerModel {
  id: string
  provider: string
}

export interface CompactionSummarizerOptions {
  model: CompactionSummarizerModel
  /**
   * Hand the summarizer only the `← name result (N chars)` line instead of the
   * result body (variant C). Defaults to the resolved variant's setting.
   */
  omitResultBodies?: boolean
  /** Override the transcript renderer (tests). */
  renderTranscript?: (messages: readonly Message[], opts: { resultBodies: boolean }) => string
  /**
   * One-shot model call, injected for tests so a unit test makes no paid call.
   * Defaults to `runAgentLoop` against the summarizer's provider.
   */
  runSummary?: (input: {
    provider: string
    model: string
    system: string
    prompt: string
  }) => Promise<string>
}

const SUMMARY_CONTRACT =
  'Output these sections, in this order, and nothing else:\n' +
  '## Decisions\n' +
  '## Files touched\n' +
  '## Current state\n' +
  '  (what is done, what is in progress, the next step)\n' +
  '## Tools used\n' +
  '  (exact names as `name` ×count)\n' +
  'Use only tool names that appear in the transcript — never invent one.'

/**
 * The merge call of the parallel map (SHO-556). Each partial already follows
 * the contract for its own chunk of the head; this call combines them — and
 * the running summary of an earlier fold, when there is one — into a single
 * summary that follows the same contract, without dropping a decision the
 * parts agree on.
 */
const MERGE_PROMPT =
  'You are given partial summaries of consecutive excerpts of one long agent ' +
  'conversation, in order, plus the running summary of what came before them ' +
  '(when present). Combine them into ONE summary of the whole conversation so ' +
  'far. Merge the parts instead of concatenating them: keep every decision, ' +
  'file edited, error and current next step, drop only repetition, and keep the ' +
  'latest state where two parts disagree.\n\n' +
  SUMMARY_CONTRACT

/** The default one-shot call: the summarizer's own provider, one iteration, no tools. */
async function defaultRunSummary(input: {
  provider: string
  model: string
  system: string
  prompt: string
}): Promise<string> {
  const { resolveModel: rm, resolveApiKey: rak } = await import('./pi-adapter')
  const { runAgentLoop } = await import('./agent-loop')
  const apiKey = rak(rm(input.provider, input.model).provider)
  if (!apiKey) throw new Error('No API key for summarization')
  const result = await runAgentLoop({
    provider: input.provider,
    model: input.model,
    system: input.system,
    history: [],
    prompt: input.prompt,
    tools: [],
    maxIterations: 1,
    loopDetection: false,
    thinkingLevel: 'off',
  })
  return result.text || '(summary unavailable)'
}

/**
 * The `SummarizeFn` the session manager installs. Runs the same summarizer code
 * the runtime uses, whichever caller asks for it.
 *
 * With more than one chunk the session manager calls it once per chunk with no
 * running summary and then calls `.merge` with the partials in chunk order, so
 * the merge call lives here next to the fold/fresh prompts (SHO-556). It is a
 * property on the function rather than a second return value so every existing
 * `SummarizeFn` caller — the compaction eval included — is unchanged.
 */
export function createCompactionSummarizer(opts: CompactionSummarizerOptions): CompactionSummarizer {
  const variant = resolveCompactionVariant()
  const omitResultBodies = opts.omitResultBodies ?? variant.summaryOmitsResultBodies
  const renderTranscript =
    opts.renderTranscript ??
    ((messages: readonly Message[], o: { resultBodies: boolean }) =>
      renderTranscriptForSummary(messages, { resultBodies: o.resultBodies }))
  const runSummary = opts.runSummary ?? defaultRunSummary

  const summarize: SummarizeFn = async (messages, previousSummary) => {
    // No truncation: the caller chunks the head at `summarizeChunkTokens` (100k
    // by default) so each excerpt is already bounded. The old 500-char-per-message
    // / 12k-char caps threw away ~99% of a long turn — including the decisions
    // the summary exists to preserve (SHO-96).
    //
    // Every toolCall is rendered, with its arguments, as `→ tool: name(args)`
    // (compaction-transcript.ts). Without that line the summarizer can only
    // write narration, and a model acting on narration invents a tool name —
    // `str_replace` was called eight times that way (SHO-122).
    const messageTexts = renderTranscript(messages, { resultBodies: !omitResultBodies })

    // Fold: when this excerpt follows an earlier chunk, the model must carry the
    // running summary forward instead of replacing it.
    const system = previousSummary
      ? `You maintain a running summary of a long agent turn. You receive the running summary so far and a new excerpt of the conversation. Merge the excerpt into the running summary. Preserve: key decisions, files edited, errors encountered, and current task state. Drop only redundant detail.\n\n${SUMMARY_CONTRACT}`
      : `Summarize the following conversation excerpt concisely. Preserve: key decisions, files edited, errors encountered, and current task state. Be factual and specific.\n\n${SUMMARY_CONTRACT}`

    const prompt = previousSummary
      ? `Running summary so far:\n${previousSummary}\n\nNew excerpt:\n${messageTexts}`
      : messageTexts

    return runSummary({
      provider: opts.model.provider,
      model: opts.model.id,
      system,
      prompt,
    })
  }

  const merge: SummarizeMergeFn = async (partials, previousSummary) => {
    const parts = partials
      .map((part, index) => `## Part ${index + 1} of ${partials.length}\n${part}`)
      .join('\n\n')
    const prompt = previousSummary
      ? `Running summary before these parts:\n${previousSummary}\n\nPartial summaries, in order:\n${parts}`
      : `Partial summaries, in order:\n${parts}`
    return runSummary({
      provider: opts.model.provider,
      model: opts.model.id,
      system: MERGE_PROMPT,
      prompt,
    })
  }

  return Object.assign(summarize, { merge })
}

/** The per-chunk summarizer, with the merge call for a parallel map attached. */
export type CompactionSummarizer = SummarizeFn & { merge: SummarizeMergeFn }
