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
import type { SummarizeFn } from './session-manager'
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
 */
export function createCompactionSummarizer(opts: CompactionSummarizerOptions): SummarizeFn {
  const variant = resolveCompactionVariant()
  const omitResultBodies = opts.omitResultBodies ?? variant.summaryOmitsResultBodies
  const renderTranscript =
    opts.renderTranscript ??
    ((messages: readonly Message[], o: { resultBodies: boolean }) =>
      renderTranscriptForSummary(messages, { resultBodies: o.resultBodies }))
  const runSummary = opts.runSummary ?? defaultRunSummary

  return async (messages, previousSummary) => {
    // No truncation: the caller chunks the head at `summarizeChunkTokens` so
    // each excerpt is already bounded. The old 500-char-per-message / 12k-char
    // caps threw away ~99% of a long turn — including the decisions the summary
    // exists to preserve (SHO-96).
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
}
