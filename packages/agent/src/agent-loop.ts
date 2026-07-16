// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agentic Tool-Call Loop — Pi Agent Core Adapter
 *
 * Wraps Pi Agent Core's Agent class to provide runAgentLoop() for the gateway.
 * This replaces the previous hand-rolled Anthropic fetch loop with Pi's
 * production-tested multi-provider agent runtime.
 *
 * Pi Agent Core handles:
 * - Multi-provider LLM streaming (Anthropic, OpenAI, Google, xAI, Groq, etc.)
 * - Tool call validation via TypeBox/AJV
 * - Event-driven tool execution with abort support
 * - Streaming events for UI updates
 *
 * We layer on top:
 * - LoopDetector circuit breaker (wired via Agent.subscribe)
 * - Max iteration enforcement
 * - AgentLoopResult mapping for the gateway
 */

import type { AgentTool, AgentEvent, StreamFn } from '@mariozechner/pi-agent-core'
import { Agent } from '@mariozechner/pi-agent-core'
import { streamSimple } from '@mariozechner/pi-ai'
import type { Message, Api, ImageContent, AssistantMessage } from '@mariozechner/pi-ai'
import { LoopDetector, type LoopDetectorConfig, type LoopDetectorResult } from './loop-detector'
import {
  resolveModel,
  resolveApiKey,
  defaultConvertToLlm,
  extractFinalText,
  sumUsage,
} from './pi-adapter'
import { wrapToolsWithOrchestration, type OrchestrationOptions } from './tool-orchestration'
import { makeStallFallbackStreamFn, resolveStallFallbackOptions, type StallFallbackOptions } from './stall-fallback'
import { classifyRetryability } from './retry-classifier'
import {
  resolveInferenceRetryOptions,
  detectInferenceFailure,
  stripTrailingFailedAssistants,
  type InferenceRetryOptions,
  type InferenceRetryInfo,
} from './inference-retry'

export type { LoopDetectorConfig, LoopDetectorResult }
export type { OrchestrationOptions }
export type { InferenceRetryOptions, InferenceRetryInfo }
// Re-exported so callers surfacing a failed turn (e.g. the agent-runtime
// gateway) classify inference errors with the SAME logic the loop used to
// retry them — keeping the retry decision and the user-facing message
// consistent (see retry-classifier.ts: "so the agent loop and any callers
// stay consistent").
export { classifyRetryability, stripStreamErrorMarker } from './retry-classifier'
export type { RetryClassification, RetryReason } from './retry-classifier'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface AgentLoopOptions {
  /** API key for the primary provider */
  apiKey?: string
  /** Provider name (default: 'anthropic') */
  provider?: string
  /** Model ID string (e.g. 'claude-sonnet-4-6') */
  model: string
  /** System prompt */
  system: string
  /** Existing conversation history (NOT including the new prompt) */
  history: Message[]
  /** The new user prompt text to send */
  prompt: string
  /** Optional images to include with the prompt (native vision support) */
  images?: ImageContent[]
  /** Pi AgentTool array */
  tools: AgentTool[]
  /** Max tool-call iterations (default: 10) */
  maxIterations?: number
  /** Max tokens per LLM call. Defaults to the model's max from the catalog. */
  maxTokens?: number
  /** Thinking/reasoning level (default: 'medium') */
  thinkingLevel?: ThinkingLevel
  /** Called when a tool is invoked */
  onToolCall?: (name: string, input: any) => void
  /** Called at each iteration */
  onIteration?: (iteration: number) => void
  /** Called with incremental text as the model streams */
  onTextDelta?: (delta: string) => void
  /** Called when thinking/reasoning starts */
  onThinkingStart?: () => void
  /** Called with incremental thinking/reasoning text */
  onThinkingDelta?: (delta: string) => void
  /** Called when thinking/reasoning ends */
  onThinkingEnd?: () => void
  /** Called before a tool executes (return false to skip) */
  onBeforeToolCall?: (toolName: string, args: any, toolCallId: string) => Promise<void>
  /** Called after a tool executes */
  onAfterToolCall?: (toolName: string, args: any, result: any, isError: boolean, toolCallId: string) => Promise<void>
  /** Called when the agent loop completes */
  onAgentEnd?: (result: AgentLoopResult) => Promise<void>
  /** Called when the LLM starts generating a tool call */
  onToolCallStart?: (toolName: string, toolCallId: string) => void
  /** Called with incremental JSON fragments as the LLM generates tool call arguments */
  onToolCallDelta?: (toolName: string, delta: string, toolCallId: string) => void
  /** Called when the LLM finishes generating a tool call (before execution) */
  onToolCallEnd?: (toolName: string, toolCallId: string) => void
  /** Loop detection config. Pass false to disable. */
  loopDetection?: Partial<LoopDetectorConfig> | false
  /** Custom stream function (for testing — replaces Pi's streamSimple) */
  streamFn?: StreamFn
  /**
   * Time-to-first-token stall fallback. When the active model produces no
   * streamed content within the configured window, the in-flight request is
   * aborted and retried against a stronger fallback model for a cooldown window
   * (default 60s); after the window the next call re-probes the primary.
   * Defaults to enabled (with the built-in MiMo→MiMo-Pro rule) whenever the
   * default `streamSimple` is used; pass `false` to disable, or a config object
   * to customize rules/threshold/window. Ignored when a custom `streamFn` is
   * supplied (tests/mocks run unwrapped). Can also be disabled via
   * `SHOGO_STALL_FALLBACK=0` and tuned via `SHOGO_STALL_FALLBACK_TTFT_MS` /
   * `SHOGO_STALL_FALLBACK_WINDOW_MS`.
   */
  stallFallback?: StallFallbackOptions | false
  /**
   * Inference reconnect/retry. When a single model call drops mid-generation
   * with a *retryable* failure (network reset, provider 5xx, idle timeout,
   * stream truncation before `message_stop`), the failed assistant tail is
   * stripped and the call is re-issued via `Agent.continue()` — without
   * re-running any already-executed tools. Capped + backed off; user aborts
   * and definitive errors (auth, content policy, billing, invalid request) are
   * never retried. Defaults to enabled (2 retries). Pass `false` to disable,
   * or a config object to tune. Can also be disabled via
   * `SHOGO_INFERENCE_RETRY=0` and tuned via
   * `SHOGO_INFERENCE_RETRY_MAX_ATTEMPTS` / `SHOGO_INFERENCE_RETRY_BASE_MS`.
   */
  inferenceRetry?: InferenceRetryOptions | false
  /**
   * Called just before each inference retry re-issues the dropped model call.
   * The gateway uses this to emit a `data-inference-retry` frame and reset the
   * in-progress UI step so the client discards the failed step's partial
   * deltas instead of concatenating the regenerated output.
   */
  onInferenceRetry?: (info: InferenceRetryInfo) => void
  /** Tool orchestration config. Pass false to disable wrapping (tools run raw parallel). */
  orchestration?: OrchestrationOptions | false
  /** AbortSignal for external cancellation (e.g., user stop). */
  signal?: AbortSignal
  /**
   * Layer 5: Reactive compaction callback. When the LLM returns a 413 or
   * context-overflow error, this is called to aggressively compact history.
   * Returns the new compacted history to retry with. Capped at 1 retry.
   */
  onContextOverflow?: () => Promise<Message[] | null>
  /**
   * Per-LLM-call context transform. pi-agent-core invokes its
   * `transformContext` hook inside `streamAssistantResponse`, which runs once
   * per assistant response — i.e. before every API call in the tool-use loop,
   * not just once per user turn. This is the hook for applying cheap,
   * prefix-stable compaction (e.g. `stableTransformContext`).
   *
   * The callback MUST be cache-stable: for any given tool_call_id, the emitted
   * bytes should not change between calls. See `stable-compaction.ts` for the
   * pattern. A stateless/naive transform that re-decides on each call will
   * invalidate the prompt cache and make multi-step turns dramatically more
   * expensive — observed at ~3.5x cache-write vs cache-read amplification.
   *
   * Contract (per pi-agent-core): must not throw.
   */
  transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]> | Message[]
  /**
   * Extra HTTP headers to attach to every outbound LLM request inside this
   * loop. Merged into the resolved Model's `headers` so pi-ai forwards them
   * on every `stream()` / `complete()` call.
   *
   * Used by Shogo's runtime to stamp `X-Chat-Session-Id` on every ai-proxy
   * request so the API-side billing session can be keyed by
   * `(projectId, chatSessionId)` and concurrent chat panels bill
   * independently.
   */
  extraHeaders?: Record<string, string>
}

export interface ToolCallRecord {
  name: string
  input: Record<string, any>
  output: any
}

export interface AgentLoopResult {
  text: string
  toolCalls: ToolCallRecord[]
  iterations: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** All new messages produced during this loop (user prompt + assistant + tool results) */
  newMessages: Message[]
  /** Set if the loop was terminated by the circuit breaker */
  loopBreak?: LoopDetectorResult
  /** Set if the agent encountered an error (provider failure, etc.). Partial results are still available. */
  error?: Error
  /** The actual model ID used for the final iteration (may differ from initial if router is active). */
  effectiveModelId?: string
  /** True when the loop stopped because maxIterations was reached, NOT because the model finished naturally */
  maxIterationsExhausted?: boolean
  /** The stop reason from the last LLM response (e.g. 'end_turn', 'tool_use', 'max_tokens') */
  lastStopReason?: string
  /** Whether the last turn included tool call executions (more reliable than checking stopReason) */
  lastTurnHadToolCalls?: boolean
  /**
   * Set when the loop terminated due to an explicit abort. Distinguishes a
   * user-initiated stop (`'external'`) from natural completion so callers
   * can tag the trailing `data-turn-complete` frame with `status: 'aborted'`
   * and downstream billing can charge the partial usage rather than
   * discarding the turn as a clean completion.
   */
  abortReason?: 'external' | 'max_iterations' | 'loop_detected'
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    apiKey,
    provider = 'anthropic',
    model: modelId,
    system,
    history,
    prompt,
    images,
    tools,
    maxIterations = 10,
    maxTokens,
    thinkingLevel = 'medium',
    onToolCall,
    onIteration,
    onTextDelta,
    onThinkingStart,
    onThinkingDelta,
    onThinkingEnd,
    onBeforeToolCall,
    onAfterToolCall,
    onAgentEnd,
    onToolCallStart,
    onToolCallDelta,
    onToolCallEnd,
  } = options

  const resolvedModel = resolveModel(provider, modelId)
  let model = maxTokens ? { ...resolvedModel, maxTokens } : resolvedModel
  if (options.extraHeaders && Object.keys(options.extraHeaders).length > 0) {
    model = { ...model, headers: { ...(model.headers || {}), ...options.extraHeaders } }
  }

  const loopDetector = options.loopDetection !== false
    ? new LoopDetector(typeof options.loopDetection === 'object' ? options.loopDetection : {})
    : null

  // Wrap tools with orchestration: read-only tools run freely in parallel,
  // write/mutating tools are serialized via an exclusive mutex, all gated
  // by a concurrency semaphore (default 10).
  const orchestrated = options.orchestration !== false
    ? wrapToolsWithOrchestration(tools, typeof options.orchestration === 'object' ? options.orchestration : {})
    : { tools, state: null }

  const toolCalls: ToolCallRecord[] = []
  const pendingArgs = new Map<string, any>()
  const streamingToolCalls = new Map<number, { name: string; id: string }>()
  let iterations = 0
  let loopBreak: LoopDetectorResult | undefined
  let abortTriggered = false
  let currentModelId = modelId
  let abortReason: 'external' | 'max_iterations' | 'loop_detected' | undefined
  let maxIterationsExhausted = false
  let lastStopReason: string | undefined
  let lastTurnHadToolCalls = false

  const { signal } = options

  if (signal?.aborted) {
    abortTriggered = true
  }

  // Per-API-call compaction hook. pi-agent-core's transformContext signature
  // is `(AgentMessage[]) => Promise<AgentMessage[]>`, where AgentMessage is
  // `Message | CustomAgentMessages[...]`. Shogo's compaction operates on
  // Message[]; the functions pass through any non-toolResult message
  // unchanged, so custom messages flow through safely. We cast at the
  // boundary. Wrapped with a try/catch per pi-agent-core's "must not throw"
  // contract.
  const wrappedTransformContext = options.transformContext
    ? async (msgs: Message[], signal?: AbortSignal): Promise<Message[]> => {
        try {
          return await options.transformContext!(msgs, signal)
        } catch (err: any) {
          console.warn(`[AgentLoop] transformContext threw — falling back to raw messages: ${err?.message}`)
          return msgs
        }
      }
    : undefined

  // Resolve the effective stream function. Tests/mocks pass an explicit
  // `streamFn` and must run unwrapped. When using Pi's default `streamSimple`,
  // optionally wrap it with TTFT stall-fallback (sticky for this run, so a
  // single wrapper instance is shared across every API call in the loop).
  let effectiveStreamFn: StreamFn | undefined = options.streamFn
  if (!options.streamFn) {
    const stallOpts = resolveStallFallbackOptions(options.stallFallback)
    if (stallOpts) {
      effectiveStreamFn = makeStallFallbackStreamFn(streamSimple, {
        logPrefix: '[AgentLoop:StallFallback]',
        ...stallOpts,
      })
    }
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: system,
      model,
      thinkingLevel: thinkingLevel === 'off' ? undefined : thinkingLevel,
      tools: orchestrated.tools,
      messages: [...history],
    },
    toolExecution: 'parallel',
    convertToLlm: defaultConvertToLlm,
    transformContext: wrappedTransformContext as any,
    streamFn: effectiveStreamFn,
    getApiKey: (prov) => {
      if (apiKey && prov === provider) return apiKey
      return resolveApiKey(prov)
    },
  })

  agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_update': {
        const ame = event.assistantMessageEvent
        if (ame.type === 'thinking_start') {
          onThinkingStart?.()
        } else if (ame.type === 'thinking_delta') {
          onThinkingDelta?.(ame.delta)
        } else if (ame.type === 'thinking_end') {
          onThinkingEnd?.()
        } else if (ame.type === 'text_delta') {
          onTextDelta?.(ame.delta)
        } else if (ame.type === 'toolcall_start') {
          const tc = ame.partial.content[ame.contentIndex]
          if (tc && tc.type === 'toolCall') {
            streamingToolCalls.set(ame.contentIndex, { name: tc.name, id: tc.id })
            onToolCallStart?.(tc.name, tc.id)
          }
        } else if (ame.type === 'toolcall_delta') {
          const info = streamingToolCalls.get(ame.contentIndex)
          if (info) {
            onToolCallDelta?.(info.name, ame.delta, info.id)
          }
        } else if (ame.type === 'toolcall_end') {
          const info = streamingToolCalls.get(ame.contentIndex)
          if (info) {
            onToolCallEnd?.(info.name, info.id)
            streamingToolCalls.delete(ame.contentIndex)
          }
        }
        break
      }

      case 'tool_execution_start':
        pendingArgs.set(event.toolCallId, event.args)
        onToolCall?.(event.toolName, event.args)
        await onBeforeToolCall?.(event.toolName, event.args, event.toolCallId)
        break

      case 'tool_execution_end': {
        const args = pendingArgs.get(event.toolCallId)
        pendingArgs.delete(event.toolCallId)

        const output = event.isError
          ? { error: event.result?.content?.[0]?.text || 'Tool error' }
          : event.result?.details ?? event.result

        toolCalls.push({
          name: event.toolName,
          input: args,
          output,
        })

        await onAfterToolCall?.(event.toolName, args, output, event.isError, event.toolCallId)

        if (loopDetector && !abortTriggered) {
          const check = loopDetector.recordAndCheck(event.toolName, args, output)
          if (check.loopDetected) {
            loopBreak = check
            abortTriggered = true
            abortReason = 'loop_detected'
            agent.abort()
          }
        }
        break
      }

      case 'turn_end': {
        iterations++
        const turnMsg = (event as any).message
        if (turnMsg?.role === 'assistant' && turnMsg.stopReason) {
          lastStopReason = turnMsg.stopReason
        }
        const turnToolResults = (event as any).toolResults
        lastTurnHadToolCalls = Array.isArray(turnToolResults) && turnToolResults.length > 0
        onIteration?.(iterations)
        // Track the stop reason from the last assistant message
        const msgs = agent.state.messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && (msgs[i] as any).stopReason) {
            lastStopReason = (msgs[i] as any).stopReason
            break
          }
        }
        if (iterations >= maxIterations && !abortTriggered) {
          maxIterationsExhausted = true
          abortTriggered = true
          abortReason = 'max_iterations'
          agent.abort()
        }
        break
      }
    }
  })

  const onAbort = () => {
    if (!abortTriggered) {
      abortTriggered = true
      abortReason = 'external'
      agent.abort()
    }
  }
  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  let promptError: Error | undefined
  let reactiveRetried = false
  try {
    if (abortTriggered) {
      promptError = new Error('Aborted before prompt')
    } else {
      await agent.prompt(prompt, images && images.length > 0 ? images : undefined)
    }
  } catch (err: any) {
    if (!abortTriggered) {
      // Layer 5: Reactive compaction on context overflow / 413
      if (options.onContextOverflow && !reactiveRetried && isContextOverflowError(err)) {
        reactiveRetried = true
        console.warn(`[AgentLoop] Context overflow detected — attempting reactive compaction`)
        try {
          const compactedHistory = await options.onContextOverflow()
          if (compactedHistory) {
            agent.state.messages = [...compactedHistory]
            await agent.prompt(prompt, images && images.length > 0 ? images : undefined)
          } else {
            promptError = err
          }
        } catch (retryErr: any) {
          console.error(`[AgentLoop] Reactive compaction retry failed:`, retryErr.message)
          promptError = retryErr
        }
      } else {
        promptError = err
      }
    } else if (abortReason === 'max_iterations') {
      // maxIterations abort should not silently swallow the error — the task
      // was likely incomplete. Surface it so the gateway can inform the user.
      promptError = new Error(
        `Agent reached the maximum iteration limit (${maxIterations}). The task may be incomplete — you can continue the conversation to pick up where it left off.`
      )
    }
    // External aborts (user stop) and loop detection aborts are intentional —
    // don't surface those as errors (loop detection is handled via loopBreak).
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  // Layer 6: Inference reconnect/retry. When the model call dropped mid-stream
  // with a *retryable* failure, re-issue the SAME call via Agent.continue()
  // after stripping the failed assistant tail. Because pi-agent-core executes
  // tools only after a complete assistant message, a call that died mid-stream
  // never ran that step's tools — so re-issuing is idempotent w.r.t. side
  // effects, and earlier completed tool results are preserved in the transcript.
  const inferenceRetry = resolveInferenceRetryOptions(options.inferenceRetry)
  // Billing policy for retries: the provider (and therefore Shogo's AI proxy
  // billing session) charges for tokens actually consumed on each call — even
  // a dropped/partial one. The proxy accumulates those into the per-session
  // bucket that `closeSession` bills, so the user is charged for the failed
  // partial attempt as the provider charged us. We strip the failed assistant
  // message from the transcript (so it isn't replayed to the model), but we
  // keep its usage here and fold it back into the loop's reported totals so the
  // surfaced usage stays consistent with what was actually billed. Retries are
  // capped (default 2) so cost amplification is bounded.
  const discardedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  if (inferenceRetry && !abortTriggered) {
    let retryAttempt = 0
    while (retryAttempt < inferenceRetry.maxAttempts) {
      if (abortTriggered || signal?.aborted) break

      const failure = detectInferenceFailure(agent.state.messages, promptError)
      if (!failure) break

      const classification = classifyRetryability({
        message: failure.errorText,
        stopReason: failure.stopReason,
        aborted: abortTriggered || signal?.aborted,
      })
      if (!classification.retryable) break

      // Strip the failed assistant tail so continue() resumes from the last
      // user/tool-result message. When the call rejected before pi appended any
      // assistant message (e.g. a synchronous stream throw on the very first
      // call), there's nothing to strip and the transcript already ends on a
      // user/tool-result message — continue() can re-issue directly.
      const trimmed = stripTrailingFailedAssistants(agent.state.messages) ?? agent.state.messages
      const last = trimmed[trimmed.length - 1]
      // Can't continue from a clean assistant tail (continue() rejects) — bail.
      if (!last || last.role === 'assistant') break
      if (trimmed !== agent.state.messages) {
        // Preserve the usage of the stripped failed attempt for billing parity.
        const removedUsage = sumUsage(agent.state.messages.slice(trimmed.length))
        discardedUsage.input += removedUsage.input
        discardedUsage.output += removedUsage.output
        discardedUsage.cacheRead += removedUsage.cacheRead
        discardedUsage.cacheWrite += removedUsage.cacheWrite
        agent.state.messages = trimmed
      }

      retryAttempt++
      const delayMs = inferenceRetry.computeDelayMs(retryAttempt)
      try {
        options.onInferenceRetry?.({
          attempt: retryAttempt,
          maxAttempts: inferenceRetry.maxAttempts,
          reason: classification.reason,
          delayMs,
          error: failure.errorText,
        })
      } catch { /* listener must not break the loop */ }
      console.warn(
        `[AgentLoop] INFERENCE_RETRY attempt=${retryAttempt}/${inferenceRetry.maxAttempts} ` +
          `reason=${classification.reason} delayMs=${delayMs} error=${failure.errorText.slice(0, 160)}`,
      )

      promptError = undefined
      if (delayMs > 0) await inferenceRetry.sleep(delayMs)
      if (abortTriggered || signal?.aborted) break

      try {
        await agent.continue()
      } catch (err: any) {
        promptError = err
      }
    }
  }

  let allMessages = agent.state.messages
  let newMessages = allMessages.slice(history.length)
  let finalText = extractFinalText(newMessages)
  let usage = sumUsage(newMessages)

  // Detect if the model's output was truncated (max_tokens hit → stopReason='length')
  // without maxIterations being exhausted. Mark as maxIterationsExhausted so the
  // caller knows to continue.
  if (!maxIterationsExhausted && !abortTriggered && lastStopReason === 'length') {
    maxIterationsExhausted = true
    console.warn('[AgentLoop] Model output truncated (stop_reason=max_tokens/length) — marking as incomplete for continuation')
  }

  // Determine the error to surface. promptError is set when agent.prompt()
  // throws directly. When the provider fails but pi-agent-core swallows the
  // error (e.g. stream function throws), agent.prompt() resolves with 0
  // output — detect that as an implicit error so callers can show a message.
  //
  // Also extract error messages from pi-agent-core (it catches stream errors
  // internally and appends error messages instead of re-throwing).
  const coreErrorMsg = newMessages.find((m: any) => m.errorMessage)
  const rawCoreError = (coreErrorMsg as any)?.errorMessage
  const coreError = rawCoreError ? parseProviderError(rawCoreError) : undefined
  const implicitError =
    !promptError && usage.output === 0 && toolCalls.length === 0 && !abortTriggered
      ? new Error(
          coreError
            ? `Provider error: ${coreError}`
            : 'Agent produced no output — possible provider error'
        )
      : undefined

  // If there was a core error but the agent DID make progress (tool calls executed),
  // don't treat it as a hard error — mark as exhausted so the caller can continue.
  if (coreError && !implicitError && !promptError && toolCalls.length > 0 && !maxIterationsExhausted) {
    maxIterationsExhausted = true
    console.warn(`[AgentLoop] Provider error mid-stream after ${toolCalls.length} tool calls — marking as incomplete for continuation: ${coreError}`)
  }

  if (coreError) {
    console.error(`[AgentLoop] Provider error from pi-agent-core: ${coreError}`)
  }

  const lastToolName = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1]?.name : undefined
  const stoppedByIterationLimit = abortReason === 'max_iterations'
  // An empty turn with no tools and no hard provider error means the model
  // ended without emitting a visible answer (e.g. it spent the turn on hidden
  // reasoning, or the structured task overwhelmed it). Elicit the answer with
  // a tool-free finalizer rather than returning nothing.
  const emptyNoToolTurn =
    toolCalls.length === 0 && !finalText.trim() && !implicitError && !promptError
  const shouldForceFinalText =
    lastToolName !== 'ask_user' &&
    !signal?.aborted &&
    !loopBreak &&
    (
      (toolCalls.length > 0 && (!finalText.trim() || maxIterationsExhausted || lastStopReason === 'length')) ||
      emptyNoToolTurn
    )

  if (shouldForceFinalText) {
    const truncatedMidAnswer = lastStopReason === 'length' && finalText.trim().length > 0
    const finalizationPrompt = truncatedMidAnswer
      ? [
          'Your previous reply was cut off because it hit the provider output-token limit.',
          'Continue your reply from exactly where it stopped, in the same voice and formatting, without restarting or re-introducing what you already wrote.',
          'Do not call any tools and do not ask the user to type "continue".',
          'When you reach a natural ending, finish the response so the user has a complete answer.',
        ].join('\n')
      : emptyNoToolTurn
        ? [
            'You ended your turn without producing a visible answer.',
            'Provide your COMPLETE final response to the user\'s request now, as a single self-contained deliverable.',
            'Do not call any tools. If the request asked for code or JSON, output exactly one clean block in the requested format with no extra prose.',
          ].join('\n')
        : [
          'Tool use is now closed for this visible turn.',
          'Do not call any tools. Write the final response to the user now.',
          'Summarize what was completed, include any important findings or blockers, and be explicit if the task is not fully finished.',
          'Do not ask the user to type "continue" unless there is a true terminal blocker that requires user input.',
        ].join('\n')

    if (!stoppedByIterationLimit) {
      try {
        const finalizerAgent = new Agent({
          initialState: {
            systemPrompt: system,
            model,
            thinkingLevel: thinkingLevel === 'off' ? undefined : thinkingLevel,
            tools: [],
            messages: [...allMessages],
          },
          toolExecution: 'parallel',
          convertToLlm: defaultConvertToLlm,
          transformContext: wrappedTransformContext as any,
          streamFn: effectiveStreamFn,
          getApiKey: (prov) => {
            if (apiKey && prov === provider) return apiKey
            return resolveApiKey(prov)
          },
        })

        finalizerAgent.subscribe((event: AgentEvent) => {
          if (event.type !== 'message_update') return
          const ame = event.assistantMessageEvent
          if (ame.type === 'text_delta') {
            onTextDelta?.(ame.delta)
          }
        })

        await finalizerAgent.prompt(finalizationPrompt)
        const finalizerMessages = finalizerAgent.state.messages.slice(allMessages.length)
        const assistantMessages = finalizerMessages.filter((m): m is AssistantMessage => m.role === 'assistant')
        const finalizerText = extractFinalText(assistantMessages)
        if (finalizerText.trim()) {
          newMessages = [...newMessages, ...assistantMessages]
          allMessages = [...allMessages, ...assistantMessages]
          finalText = finalizerText
          maxIterationsExhausted = false
          promptError = undefined
        }
      } catch (err: any) {
        console.warn(`[AgentLoop] Finalization pass failed after ${toolCalls.length} tool calls: ${err?.message || err}`)
      }
    } else {
      console.warn(`[AgentLoop] Iteration limit reached after ${toolCalls.length} tool calls — emitting explicit incomplete-turn fallback`)
    }

    if (!finalText.trim() || stoppedByIterationLimit) {
      finalText = buildIncompleteTurnFallback(toolCalls.length, maxIterationsExhausted, coreError || promptError?.message)
      onTextDelta?.(finalText)
      const fallbackMessage: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: finalText }],
        api: 'anthropic-messages',
        provider,
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      newMessages = [...newMessages, fallbackMessage]
      allMessages = [...allMessages, fallbackMessage]
      if (promptError && /maximum iteration limit/i.test(promptError.message)) {
        promptError = undefined
      }
    }
  }

  usage = sumUsage(newMessages)

  const result: AgentLoopResult = {
    text: loopBreak
      ? `[LOOP DETECTED] ${loopBreak.pattern || loopBreak.reason}`
      : finalText,
    toolCalls,
    iterations,
    inputTokens: usage.input + discardedUsage.input,
    outputTokens: usage.output + discardedUsage.output,
    cacheReadTokens: usage.cacheRead + discardedUsage.cacheRead,
    cacheWriteTokens: usage.cacheWrite + discardedUsage.cacheWrite,
    newMessages,
    loopBreak,
    error: promptError || implicitError,
    effectiveModelId: currentModelId,
    maxIterationsExhausted,
    lastStopReason,
    lastTurnHadToolCalls,
    abortReason: abortTriggered ? abortReason : undefined,
  }

  await onAgentEnd?.(result)

  return result
}

function buildIncompleteTurnFallback(toolCallCount: number, maxIterationsExhausted: boolean, error?: string): string {
  const reason = error
    ? ` The last model call hit a recoverable provider error: ${error}`
    : maxIterationsExhausted
      ? ' The turn reached its internal continuation limit before the model produced a natural final paragraph.'
      : ''
  return `I completed ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}, but the model did not produce a final answer after tool execution.${reason} I preserved the completed tool results so the next turn can continue from this exact point instead of starting over.`
}

/**
 * Extract a human-readable message from raw provider error strings.
 * pi-agent-core often returns errors like: `402 {"type":"error","error":{"type":"billing_error","message":"..."}}`
 */
function parseProviderError(raw: string): string {
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart))
      const msg = parsed?.error?.message || parsed?.message
      if (msg) {
        const status = raw.slice(0, jsonStart).trim()
        return status ? `${status} ${msg}` : msg
      }
    } catch {}
  }
  return raw
}

function isContextOverflowError(err: any): boolean {
  if (!err) return false
  const status = err.status ?? err.statusCode ?? err.code
  if (status === 413) return true
  const msg = String(err.message || err).toLowerCase()
  return (
    msg.includes('context') && (msg.includes('overflow') || msg.includes('too long') || msg.includes('exceed'))
  ) || msg.includes('prompt is too long')
    || msg.includes('maximum context length')
    || msg.includes('request too large')
}
