// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DurableTurnRunner — agent-level auto-continuation and checkpointing.
 *
 * Wraps `runAgentLoop` so a single user-visible "turn" can span multiple
 * LLM iterations, context compactions, and provider retries without the
 * client ever observing a silent EOF.
 *
 * Background: `runAgentLoop` returns `maxIterationsExhausted === true`
 * when the model stopped because of `max_tokens`, our per-turn iteration
 * cap, or a mid-stream provider error after at least one tool call.
 * Previously the gateway translated that into an error UI frame asking
 * the user to type "continue" — that is what made very long Anthropic
 * sessions look like they stopped at `tokens: 0, tool calls: 11`.
 *
 * Instead, this runner:
 *   1. Calls `runAgentLoop` as usual.
 *   2. If the loop ended for a recoverable reason and we still have budget,
 *      it re-invokes the loop with the carried-over session history and
 *      a synthetic continuation prompt. No user-visible error is emitted.
 *   3. It merges results across attempts: text concatenated, toolCalls
 *      union, usage summed, final `newMessages` from the last attempt
 *      (since `runAgentLoop` already receives the updated `history`).
 *   4. On genuine terminal errors (billing/auth, loop detected, user
 *      abort) it surfaces the error unchanged.
 *
 * Inspired by claude-code-source/src/query.ts' `maxOutputTokensRecoveryCount`
 * and Anthropic's official "Resume directly from the cut-off" guidance.
 */

import type { Message } from '@mariozechner/pi-ai'
import {
  runAgentLoop,
  type AgentLoopOptions,
  type AgentLoopResult,
  type ToolCallRecord,
} from './agent-loop'

/** A lightweight semantic checkpoint persisted as the runner progresses. */
export interface TurnCheckpoint {
  /** Monotonic inside a single turn; reset to 0 for each new user prompt. */
  attempt: number
  /** ISO timestamp of the checkpoint. */
  at: string
  /**
   * Reason we recorded this checkpoint — e.g. 'attempt_end',
   * 'continuation_max_tokens', 'continuation_iteration_limit',
   * 'continuation_provider_error', 'abort', 'terminal'.
   */
  reason: string
  /** Effective model used for this attempt (routing may differ per attempt). */
  modelId?: string
  /** How many LLM iterations this attempt consumed. */
  iterations: number
  /** How many new tool calls executed this attempt. */
  toolCallsThisAttempt: number
  /** Cumulative tool calls across attempts of this turn. */
  toolCallsTotal: number
  /** Cumulative output tokens across attempts. */
  outputTokensTotal: number
  /** `lastStopReason` from the LLM at the end of this attempt. */
  lastStopReason?: string
  /** Whether the runner intends to auto-continue after this checkpoint. */
  willContinue: boolean
  /** Serializable error label for terminal attempts. */
  error?: string
}

export type TurnCheckpointListener = (checkpoint: TurnCheckpoint) => void

/**
 * Options for the runner. Everything except the persistence/metrics hooks
 * flows into the inner `runAgentLoop` call for the first attempt.
 */
export interface DurableTurnRunnerOptions extends AgentLoopOptions {
  /** Stable turn identifier (propagates to ledger headers). */
  turnId?: string
  /**
   * Max continuation attempts after the first. Default: 5.
   * Override via env `AGENT_MAX_CONTINUATIONS`.
   */
  maxContinuations?: number
  /**
   * Mid-stream provider retry budget per attempt. Default: 2.
   * Override via env `AGENT_PROVIDER_RETRIES`.
   */
  providerRetriesPerAttempt?: number
  /**
   * Persist callback invoked for every checkpoint. Typically wired to
   * the turn ledger / stream-buffer.
   */
  onCheckpoint?: TurnCheckpointListener
  /**
   * After `runAgentLoop` returns — with or without error — but before
   * deciding to auto-continue. Gives callers (e.g. the gateway) a hook
   * to update the session history so the next attempt sees the newly
   * produced tool results. Returning `null` aborts further continuations
   * (e.g. user cancelled in the meantime).
   */
  prepareNextHistory?: (previous: AgentLoopResult) => Promise<Message[] | null> | Message[] | null
  /**
   * Build the continuation prompt. Defaults to an Anthropic-friendly
   * "resume" instruction modeled after claude-code-source/query.ts.
   */
  buildContinuationPrompt?: (reason: ContinuationReason, previous: AgentLoopResult) => string
  /**
   * Test hook: allows unit tests to inject a deterministic agent-loop
   * driver without having to mock pi-agent-core. Do NOT use in production
   * code paths — production always uses the real `runAgentLoop`.
   * @internal
   */
  _runLoopForTests?: (opts: AgentLoopOptions) => Promise<AgentLoopResult>
}

export type ContinuationReason =
  | 'max_tokens'
  | 'iteration_limit'
  | 'provider_error_after_tools'

export interface DurableTurnResult extends AgentLoopResult {
  /** Per-attempt results in order. */
  attempts: AgentLoopResult[]
  /** Reason we stopped auto-continuing (may be 'completed'). */
  terminationReason:
    | 'completed'
    | 'user_abort'
    | 'loop_detected'
    | 'provider_fatal'
    | 'max_continuations'
    | 'host_cancelled'
  /** Aggregate checkpoints emitted during the turn. */
  checkpoints: TurnCheckpoint[]
}

const DEFAULT_CONTINUATION_PROMPT: Record<ContinuationReason, string> = {
  max_tokens:
    'Output token limit hit. Resume directly where you left off, without repeating anything already said. Complete the remaining work.',
  iteration_limit:
    'Agent iteration budget refreshed. Continue from where you paused and finish the user\'s original request. Avoid repeating completed steps.',
  provider_error_after_tools:
    'The upstream model stream was interrupted after partial progress. Resume from the last completed tool call and keep going. Do not repeat work you already did.',
}

function defaultBuildContinuationPrompt(
  reason: ContinuationReason,
  _previous: AgentLoopResult,
): string {
  return DEFAULT_CONTINUATION_PROMPT[reason]
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Classify a finished attempt into a continuation decision.
 */
export function classifyAttempt(result: AgentLoopResult): {
  reason: ContinuationReason | null
  fatal: boolean
  fatalLabel?: string
} {
  if (result.loopBreak) {
    return { reason: null, fatal: true, fatalLabel: 'loop_detected' }
  }

  const err = result.error
  const msg = err?.message || ''

  // Recoverable iteration/length cases — these populate maxIterationsExhausted.
  if (result.maxIterationsExhausted) {
    if (result.lastStopReason === 'length') {
      return { reason: 'max_tokens', fatal: false }
    }
    if (/maximum iteration limit/i.test(msg) || result.iterations > 0) {
      return { reason: 'iteration_limit', fatal: false }
    }
    // A provider error after at least one tool call promotes
    // maxIterationsExhausted inside runAgentLoop — treat as recoverable.
    if (result.toolCalls.length > 0) {
      return { reason: 'provider_error_after_tools', fatal: false }
    }
  }

  if (err) {
    // Non-recoverable: billing, auth, no-output-at-all provider error.
    const fatalLabel = /billing|insufficient.credits|401|403|unauthorized|forbidden/i.test(msg)
      ? 'billing_or_auth'
      : /context|too long|overflow/i.test(msg)
        ? 'context_overflow'
        : 'provider_fatal'
    return { reason: null, fatal: true, fatalLabel }
  }

  return { reason: null, fatal: false }
}

/**
 * Merge a second attempt's result into an accumulating result.
 *
 * Text is concatenated with a single blank line separator; tool calls are
 * unioned; usage is summed. `newMessages`, however, is the LAST attempt
 * only — the expectation is that between attempts the caller (via
 * `prepareNextHistory`) has already committed the previous attempt's
 * messages to the session store, so double-committing would duplicate.
 * This keeps the semantics identical to `runAgentLoop`: "the new messages
 * the caller still owes the session after this call."
 */
function mergeAttempt(acc: AgentLoopResult, next: AgentLoopResult): AgentLoopResult {
  const joinedText = [acc.text, next.text].filter(Boolean).join('\n\n')
  const mergedToolCalls: ToolCallRecord[] = [...acc.toolCalls, ...next.toolCalls]
  return {
    text: joinedText,
    toolCalls: mergedToolCalls,
    iterations: acc.iterations + next.iterations,
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    cacheReadTokens: acc.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens + next.cacheWriteTokens,
    newMessages: next.newMessages,
    loopBreak: next.loopBreak ?? acc.loopBreak,
    error: next.error,
    effectiveModelId: next.effectiveModelId || acc.effectiveModelId,
    maxIterationsExhausted: next.maxIterationsExhausted,
    lastStopReason: next.lastStopReason ?? acc.lastStopReason,
    lastTurnHadToolCalls:
      typeof next.lastTurnHadToolCalls === 'boolean'
        ? next.lastTurnHadToolCalls
        : acc.lastTurnHadToolCalls,
  }
}

/**
 * Run an agent turn with automatic, bounded continuation.
 *
 * Contract:
 *   - Returns a single AgentLoopResult-compatible object that the gateway
 *     treats like the original `runAgentLoop` output, plus per-attempt
 *     metadata under `.attempts` / `.checkpoints` for observability.
 *   - Never throws from the continuation logic itself: any throw from
 *     `runAgentLoop` is already caught and surfaced via `.error`.
 *   - External abort (signal) immediately short-circuits further attempts.
 */
export async function runDurableTurn(
  options: DurableTurnRunnerOptions,
): Promise<DurableTurnResult> {
  const maxContinuations = options.maxContinuations ?? envInt('AGENT_MAX_CONTINUATIONS', 5)
  const providerRetriesPerAttempt =
    options.providerRetriesPerAttempt ?? envInt('AGENT_PROVIDER_RETRIES', 2)
  const buildPrompt = options.buildContinuationPrompt ?? defaultBuildContinuationPrompt
  const runLoop = options._runLoopForTests ?? runAgentLoop
  const emitCheckpoint = (cp: TurnCheckpoint) => {
    checkpoints.push(cp)
    try { options.onCheckpoint?.(cp) } catch (err: any) {
      console.warn('[DurableTurnRunner] onCheckpoint threw:', err?.message || err)
    }
  }

  const attempts: AgentLoopResult[] = []
  const checkpoints: TurnCheckpoint[] = []

  let currentPrompt = options.prompt
  let currentHistory = options.history
  let attemptIndex = 0
  let cumulativeOutputTokens = 0
  let cumulativeToolCalls = 0

  // The overall accumulator — seeded with the first attempt.
  let accumulated: AgentLoopResult | null = null
  let terminationReason: DurableTurnResult['terminationReason'] = 'completed'

  while (true) {
    attemptIndex++

    if (options.signal?.aborted) {
      terminationReason = 'user_abort'
      emitCheckpoint({
        attempt: attemptIndex,
        at: new Date().toISOString(),
        reason: 'abort_before_attempt',
        iterations: 0,
        toolCallsThisAttempt: 0,
        toolCallsTotal: cumulativeToolCalls,
        outputTokensTotal: cumulativeOutputTokens,
        willContinue: false,
      })
      break
    }

    let attemptResult: AgentLoopResult | null = null
    let providerRetry = 0
    // Per-attempt provider-mid-stream retry. We re-invoke runAgentLoop with
    // the same (history, prompt) because pi-agent-core captures the
    // interrupted stream's state in `newMessages`; each retry begins from
    // the latest history snapshot prepared by `prepareNextHistory`.
    while (providerRetry <= providerRetriesPerAttempt) {
      attemptResult = await runLoop({
        ...options,
        prompt: currentPrompt,
        history: currentHistory,
      })

      // Retry only if this attempt saw a mid-stream provider failure
      // AND we made no tool progress AND there's budget left. Progressing
      // attempts don't retry at this layer — they go through the outer
      // continuation branch below.
      const needsProviderRetry =
        !!attemptResult.error &&
        attemptResult.toolCalls.length === 0 &&
        attemptResult.outputTokens === 0 &&
        providerRetry < providerRetriesPerAttempt &&
        !/billing|insufficient.credits|401|403|unauthorized|forbidden/i.test(
          attemptResult.error.message || '',
        )

      if (!needsProviderRetry) break

      providerRetry++
      const backoffMs = Math.min(1_000 * Math.pow(2, providerRetry - 1), 30_000)
      console.warn(
        `[DurableTurnRunner] Provider error on attempt ${attemptIndex}; ` +
          `retry ${providerRetry}/${providerRetriesPerAttempt} in ${backoffMs}ms: ` +
          `${attemptResult.error?.message}`,
      )
      await new Promise((r) => setTimeout(r, backoffMs))
      if (options.signal?.aborted) break
    }

    if (!attemptResult) break
    attempts.push(attemptResult)
    cumulativeOutputTokens += attemptResult.outputTokens
    cumulativeToolCalls += attemptResult.toolCalls.length
    accumulated = accumulated ? mergeAttempt(accumulated, attemptResult) : attemptResult

    const { reason, fatal, fatalLabel } = classifyAttempt(attemptResult)
    const remaining = Math.max(0, maxContinuations - (attemptIndex - 1))
    const willContinue = !fatal && !!reason && remaining > 0 && !options.signal?.aborted

    emitCheckpoint({
      attempt: attemptIndex,
      at: new Date().toISOString(),
      reason: fatal
        ? `terminal_${fatalLabel || 'unknown'}`
        : reason
          ? `continuation_${reason}`
          : 'attempt_end',
      modelId: attemptResult.effectiveModelId,
      iterations: attemptResult.iterations,
      toolCallsThisAttempt: attemptResult.toolCalls.length,
      toolCallsTotal: cumulativeToolCalls,
      outputTokensTotal: cumulativeOutputTokens,
      lastStopReason: attemptResult.lastStopReason,
      willContinue,
      error: attemptResult.error?.message,
    })

    if (fatal) {
      terminationReason = attemptResult.loopBreak ? 'loop_detected' : 'provider_fatal'
      break
    }

    if (!reason) {
      terminationReason = 'completed'
      break
    }

    if (options.signal?.aborted) {
      terminationReason = 'user_abort'
      break
    }

    if (remaining <= 0) {
      terminationReason = 'max_continuations'
      console.warn(
        `[DurableTurnRunner] Reached max continuations (${maxContinuations}); stopping. ` +
          'The turn will surface as incomplete so the caller can decide what to do.',
      )
      break
    }

    // Hand the caller a chance to refresh history (e.g. add newMessages to
    // the session so the next attempt sees completed tool results) and
    // short-circuit if the user has cancelled or the host wants to stop.
    let nextHistory: Message[] | null = null
    try {
      const prepared = options.prepareNextHistory
        ? await options.prepareNextHistory(attemptResult)
        : undefined
      if (prepared === null) {
        terminationReason = 'host_cancelled'
        break
      }
      nextHistory = prepared ?? null
    } catch (err: any) {
      console.warn('[DurableTurnRunner] prepareNextHistory threw:', err?.message || err)
    }

    currentHistory = nextHistory ?? [...currentHistory, ...attemptResult.newMessages]
    currentPrompt = buildPrompt(reason, attemptResult)
  }

  const base: AgentLoopResult = accumulated ?? {
    text: '',
    toolCalls: [],
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    newMessages: [],
    maxIterationsExhausted: false,
  }

  // If we ended on a recoverable condition but exhausted our budget,
  // don't surface an "error" unless there genuinely is one — the caller
  // can read terminationReason to decide whether to show a banner.
  if (terminationReason === 'max_continuations' && base.error) {
    // Keep the error in place; callers can still interpret it.
  }

  // No-silent-EOF gate (Phase 5.3): if the turn ended with ZERO output
  // tokens, ZERO tool calls, no text, no error, and we're marking it
  // 'completed', something unusual happened (e.g. the provider returned
  // an empty stream). Promote this to an explicit error so the client
  // never sees a silent blank response; the caller can still inspect
  // `terminationReason` to render a more useful banner.
  const isSilentEmpty =
    terminationReason === 'completed' &&
    !base.error &&
    !base.loopBreak &&
    base.outputTokens === 0 &&
    base.toolCalls.length === 0 &&
    (!base.text || base.text.trim().length === 0)
  if (isSilentEmpty) {
    const silentErr = new Error(
      'Agent turn completed without emitting any output, tool calls, or error. ' +
        'This is usually caused by a provider returning an empty stream; the client ' +
        'should retry or rephrase.',
    )
    emitCheckpoint({
      attempt: attemptIndex,
      at: new Date().toISOString(),
      reason: 'terminal_silent_empty',
      iterations: base.iterations,
      toolCallsThisAttempt: 0,
      toolCallsTotal: cumulativeToolCalls,
      outputTokensTotal: cumulativeOutputTokens,
      willContinue: false,
      error: silentErr.message,
    })
    return {
      ...base,
      error: silentErr,
      attempts,
      terminationReason: 'provider_fatal',
      checkpoints,
    }
  }

  return { ...base, attempts, terminationReason, checkpoints }
}
