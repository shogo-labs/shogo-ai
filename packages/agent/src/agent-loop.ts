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
  PROVIDER_BACKOFF_REASONS,
  NO_PROGRESS_THRESHOLD,
  RetryWaker,
  type InferenceRetryOptions,
  type InferenceRetryInfo,
  type ProviderBackoffInfo,
} from './inference-retry'
import { waitForConnectivity, type ConnectivityWaitInfo } from './connectivity'
import type { RetryReason } from './retry-classifier'
import {
  createVisionDescriber,
  resolveVisionFallbackOptions,
  type ImageDescription,
  type VisionDescriber,
  type VisionFallbackOptions,
  type VisionSkipReason,
} from './vision-fallback'

export type { LoopDetectorConfig, LoopDetectorResult }
export type { OrchestrationOptions }
export type { InferenceRetryOptions, InferenceRetryInfo, ProviderBackoffInfo }
export { RetryWaker }

export type RetryLayer = 'fast' | 'connectivity_park' | 'provider_backoff'

export interface RetryEpisodeSummary {
  /** Deepest layer the episode reached. */
  layer: RetryLayer
  /** Reason of the most recent failure in the episode. */
  reason: RetryReason
  /** Total re-issues across all layers. */
  attempts: number
  elapsedMs: number
  outcome: 'recovered' | 'user_stopped' | 'failed_non_transient' | 'gave_up'
  suspectedDeterministic: boolean
  /** Last error text, truncated. */
  error: string
}
export type { ConnectivityWaitInfo } from './connectivity'
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
  onIteration?: (
    iteration: number,
    info?: {
      /** Usage reported by the assistant message that ended this iteration. */
      usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
      /** Messages in the loop's transcript at this point. */
      messageCount?: number
      /** Tool calls this iteration emitted. */
      toolCallCount?: number
    },
  ) => void
  /** Messages to add before the next model step (e.g. finished background tasks). They extend the turn. */
  takeInjectedMessages?: () => Message[]
  /** Called after tool results with only messages not reported by an earlier callback. */
  onProgress?: (messages: Message[]) => void
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
   * Which registered tools are advertised to the provider on each API call.
   * A tool that is not advertised stays callable — the loop dispatches it by
   * name — but its schema is left out of the request. Read once per API call
   * (not once per run), so a tool activated during a turn is advertised on the
   * loop's next request.
   */
  isAdvertisedTool?: (tool: AgentTool) => boolean
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
  /**
   * Layer 7: called on every backoff tick while the loop is "parked" waiting
   * for connectivity to return (see `connectivityWait` on `inferenceRetry`
   * and `connectivity.ts`'s module doc). Fires at least once every 15s so
   * the gateway can emit a `data-connectivity-wait` heartbeat frame that
   * keeps the client's stall watchdog and the stream buffer from treating
   * the turn as dead.
   */
  onConnectivityWait?: (info: ConnectivityWaitInfo) => void
  /**
   * Called once, right before the loop resumes generation after a
   * successful `onConnectivityWait` park. The gateway uses this to emit a
   * terminal `data-connectivity-wait` frame (`state: 'reconnected'`) so the
   * client can clear its "waiting for connection" banner.
   */
  onConnectivityReconnected?: () => void
  /**
   * Called before each provider-backoff re-issue (see `providerBackoff` on
   * `inferenceRetry`). Backoff delays are capped at 30s, so this doubles as a
   * heartbeat that keeps the client's stall watchdog quiet while waiting.
   */
  onProviderBackoff?: (info: ProviderBackoffInfo) => void
  /**
   * Called once when a retry episode ends — i.e. a run of consecutive
   * transient failures for the same model call is resolved (recovered),
   * stopped by the user, or ends on a non-retryable failure. Used for
   * "how often does each retry layer fire" telemetry.
   */
  onRetryEpisodeEnd?: (summary: RetryEpisodeSummary) => void
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
   * Last-resort repair when a provider rejects an image: called with the
   * current transcript and must return a copy in which images the provider
   * cannot decode are replaced by text placeholders. The runtime injects
   * `scrubInvalidImages` from image-size-guard; without it the loop falls back
   * to dropping image blocks outright (history first, then this turn's too).
   *
   * `opts.maxDimension` carries the per-image pixel cap the provider reported
   * for this request (see `onImageDimensionLimit`); passing it replaces only
   * the images over that cap instead of every image we cannot prove is fine.
   */
  scrubInvalidImages?: (
    messages: Message[],
    opts?: { maxDimension?: number },
  ) => Message[]
  /**
   * Called once the loop learns a provider's per-image *pixel* cap from a
   * rejected request — Anthropic answers `400 … At least one of the image
   * dimensions exceed max allowed size for many-image requests: 3000 pixels`,
   * a cap it applies per image once a request carries many images. The runtime
   * keeps it for the session and applies it to later calls, so a screenshot
   * taken after the cap is learned is replaced before it goes on the wire
   * instead of costing a failed request each time.
   */
  onImageDimensionLimit?: (limit: number) => void
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
  /**
   * How to let a model that cannot accept images still *inspect* one: a
   * catalog-picked vision model describes the image and the description takes
   * its place in the request. Enabled by default on models without `image`
   * input; `false` (or `SHOGO_VISION_FALLBACK=0`) restores SHO-41's note-only
   * behaviour. Ignored entirely on a vision model — those get the pixels.
   */
  visionFallback?: VisionFallbackOptions | false
}

export interface ToolCallRecord {
  name: string
  input: Record<string, any>
  output: any
}

/**
 * Usage of a single model call inside one turn — one entry per assistant
 * message, in call order. The turn's totals are the sum of these, so a
 * cache-hit ratio can be computed per call instead of only per turn (a
 * per-iteration cache rewrite used to be invisible: turn totals hide it).
 */
export interface PerCallUsage {
  /** 1-based position of the assistant message in this turn's transcript; 0 for a dropped attempt. */
  iteration: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /**
   * True for a call whose assistant message the retry ladder dropped after a
   * failed/partial stream. The provider still billed it, so its usage is kept
   * here (and in the turn totals) even though it never reaches the transcript.
   */
  discarded?: boolean
}

export interface AgentLoopResult {
  text: string
  toolCalls: ToolCallRecord[]
  iterations: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Per-model-call breakdown of the token counts above. */
  perCallUsage: PerCallUsage[]
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
  /**
   * Set when the workspace hit its Shogo usage limit partway through the turn.
   * Retrying can't succeed until the limit resets or the plan changes, so the
   * turn ends with an explicit notice instead of a finalizer/auto-continue.
   */
  usageLimit?: UsageLimitInfo
}

export interface UsageLimitInfo {
  /** ISO time the exhausted usage window resets, when the API reported one. */
  resetsAt?: string
  window?: string
}

/**
 * Recognize the AI proxy's own 402 (`code: usage_limit_reached`). Deliberately
 * narrower than the retry classifier's `billing` bucket: an upstream provider
 * billing failure is our problem, not something the user can fix by upgrading.
 */
export function detectUsageLimit(raw: string | undefined): UsageLimitInfo | null {
  if (!raw || !/usage_limit_reached|usage limit reached/i.test(raw)) return null
  const info: UsageLimitInfo = {}
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart))
      const err = parsed?.error ?? parsed
      if (typeof err?.resetsAt === 'string') info.resetsAt = err.resetsAt
      if (typeof err?.window === 'string') info.window = err.window
    } catch {
      /* message-only form — no reset time available */
    }
  }
  return info
}

export function buildUsageLimitNotice(toolCallCount: number, info: UsageLimitInfo, now: Date = new Date()): string {
  const progress = toolCallCount > 0
    ? `I completed ${toolCallCount} step${toolCallCount === 1 ? '' : 's'} before stopping, and that work is saved.`
    : 'Nothing from this step was lost.'
  let when = ''
  const resetsAt = info.resetsAt ? new Date(info.resetsAt) : null
  if (resetsAt && !Number.isNaN(resetsAt.getTime()) && resetsAt.getTime() > now.getTime()) {
    const minutes = Math.ceil((resetsAt.getTime() - now.getTime()) / 60_000)
    const inText = minutes < 60
      ? `${minutes} minute${minutes === 1 ? '' : 's'}`
      : minutes < 48 * 60
        ? `about ${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'}`
        : `about ${Math.round(minutes / (24 * 60))} days`
    when = ` Upgrade in **Settings > Billing** to keep going now, or wait until your usage resets (in ${inText}).`
  } else {
    when = ' Upgrade in **Settings > Billing** to keep going now, or wait until your usage resets.'
  }
  // The billing action is the way out. Telling the user to send "continue" made
  // a hard limit look like a stalled turn, and they answered it over and over
  // instead of upgrading (SHO-121).
  return `**You've reached your usage limit, so I had to stop partway through this task.** ${progress}${when} Your work is saved and picks up exactly where it stopped.`
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
    takeInjectedMessages,
    onProgress,
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

  // pi-ai's openai-completions / google converters forward image blocks only
  // when the model's catalog entry advertises image input; otherwise they drop
  // them without a word. Know which case we're in before the first call.
  const modelAcceptsImages =
    Array.isArray((model as any).input) && ((model as any).input as string[]).includes('image')

  // A model with no `image` input still has to *see* a screenshot, not just be
  // told it cannot. Route those images through a catalog-picked vision model
  // once per distinct image; anything that cannot be described (no vision
  // model, no key, over the per-run cap, provider error) falls back to
  // SHO-41's note, so the failure mode is never worse than before.
  const visionConfig = modelAcceptsImages ? false : resolveVisionFallbackOptions(options.visionFallback)
  const vision: VisionDescriber | null = visionConfig
    ? createVisionDescriber({
        ...visionConfig,
        log: (line) => console.warn(`[AgentLoop] ${line}`),
      })
    : null
  const visionContext = (signal?: AbortSignal) => ({
    provider,
    modelId,
    apiKey,
    extraHeaders: options.extraHeaders,
    signal: signal ?? options.signal,
  })

  // Same rule for images attached to the prompt itself: fold a description
  // into the text rather than let the provider converter bin them.
  let promptText = prompt
  let promptImages = images
  if (images && images.length > 0 && !modelAcceptsImages) {
    let described = 0
    const parts: string[] = []
    for (const image of images) {
      const outcome = vision ? await vision.describe(image, visionContext()) : null
      if (outcome?.ok) {
        described += 1
        parts.push(formatDescribedImage({ description: outcome.description, modelId }))
      } else {
        parts.push(
          buildImageOmittedNote({
            modelId,
            reason: outcome ? skipReasonText(outcome.reason) : 'this model only accepts text input',
          }),
        )
      }
    }
    promptText = `${prompt}\n\n${parts.join('\n\n')}`
    promptImages = undefined
    if (described === 0) {
      console.warn(
        `[AgentLoop] MODEL_NO_IMAGE_INPUT model=${modelId} — ${images.length} attached image(s) not sent`,
      )
    }
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
  // Index where this turn's messages begin in `agent.state.messages`.
  // Reactive compaction swaps in a shorter history, so this moves with it.
  let historyLength = history.length
  let lastProgressMessageCount = historyLength

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
  //
  // It also enforces what the routed model can actually accept: pi-ai's
  // openai-completions and google converters silently discard image blocks
  // when the catalog entry for the model has no `image` input, which is how a
  // screenshot ended up reaching the agent as nothing but the tool's JSON
  // `path`. Replacing those blocks with a note keeps the fact — and the path —
  // in the transcript instead of dropping it on the floor.
  let warnedNoImageInput = false
  const omittedNote = (msg: Message, reason: string) =>
    buildImageOmittedNote({
      modelId,
      toolName: msg.role === 'toolResult' ? msg.toolName : undefined,
      pathHint: extractPathHint(msg),
      reason,
    })
  const applyModelImageSupport = async (msgs: Message[], signal?: AbortSignal): Promise<Message[]> => {
    if (modelAcceptsImages) return msgs

    if (vision) {
      return replaceImageBlocksAsync(msgs, async (image, msg) => {
        const outcome = await vision.describe(image, visionContext(signal))
        const text = outcome.ok
          ? formatDescribedImage({
              description: outcome.description,
              modelId,
              toolName: msg.role === 'toolResult' ? msg.toolName : undefined,
              pathHint: extractPathHint(msg),
            })
          : omittedNote(msg, skipReasonText(outcome.reason))
        return [{ type: 'text', text }]
      })
    }

    const stripped = replaceImageBlocks(msgs, () => true, (msg) =>
      omittedNote(msg, 'this model only accepts text input'),
    )
    if (stripped !== msgs && !warnedNoImageInput) {
      warnedNoImageInput = true
      console.warn(
        `[AgentLoop] MODEL_NO_IMAGE_INPUT model=${modelId} — image blocks replaced with text notes ` +
          '(the provider would have dropped them silently)',
      )
    }
    return stripped
  }
  const wrappedTransformContext = async (msgs: Message[], signal?: AbortSignal): Promise<Message[]> => {
    let next: Message[] = msgs
    if (options.transformContext) {
      try {
        next = await options.transformContext(msgs, signal)
      } catch (err: any) {
        console.warn(`[AgentLoop] transformContext threw — falling back to raw messages: ${err?.message}`)
        next = msgs
      }
    }
    return await applyModelImageSupport(next, signal)
  }

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
  // Legacy tools flagged `hidden`, plus the caller's advertised set (SHO-97),
  // are stripped from every provider request. Hidden tools stay dispatchable.
  const advertisedTool = options.isAdvertisedTool
  if (orchestrated.tools.some(isHiddenTool) || advertisedTool) {
    effectiveStreamFn = withoutUnadvertisedTools(effectiveStreamFn ?? streamSimple, advertisedTool)
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
        const progressMessages = agent.state.messages.slice(historyLength)
        if (progressMessages.length > lastProgressMessageCount - historyLength) {
          const newProgress = progressMessages.slice(lastProgressMessageCount - historyLength)
          lastProgressMessageCount = agent.state.messages.length
          onProgress?.(newProgress)
        }

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
        const turnToolCalls = Array.isArray(turnMsg?.content)
          ? turnMsg.content.filter((block: any) => block?.type === 'toolCall').length
          : 0
        onIteration?.(iterations, {
          usage: turnMsg?.usage,
          messageCount: agent.state.messages.length,
          toolCallCount: turnToolCalls,
        })
        for (const message of takeInjectedMessages?.() ?? []) agent.steer(message)
        const iterationMessages = agent.state.messages.slice(historyLength)
        if (iterationMessages.length > lastProgressMessageCount - historyLength) {
          const newProgress = iterationMessages.slice(lastProgressMessageCount - historyLength)
          lastProgressMessageCount = agent.state.messages.length
          onProgress?.(newProgress)
        }
        // Track the stop reason from the last assistant message
        const msgs = agent.state.messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && (msgs[i] as any).stopReason) {
            lastStopReason = (msgs[i] as any).stopReason
            break
          }
        }
        if (loopDetector && !abortTriggered) {
          const check = loopDetector.recordTurnEnd()
          if (check.loopDetected) {
            loopBreak = check
            abortTriggered = true
            abortReason = 'loop_detected'
            agent.abort()
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
      await agent.prompt(promptText, promptImages && promptImages.length > 0 ? promptImages : undefined)
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
            historyLength = compactedHistory.length
            lastProgressMessageCount = historyLength
            await agent.prompt(promptText, promptImages && promptImages.length > 0 ? promptImages : undefined)
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
  // Error text of the last failure the retry loop gave up on. Retries strip the
  // failed assistant (and its `errorMessage`) from the transcript, so without
  // this a give-up surfaces as "Agent produced no output" and the real cause
  // (connection dropped, 5xx, overloaded) never reaches the user.
  let unresolvedFailureText: string | undefined

  // Strip a failed assistant tail so `continue()` can re-issue from the last
  // user/tool-result message, folding the dropped attempt's usage into the
  // totals we report (the provider billed for it).
  const trimFailedAssistantTail = (): Message[] => {
    const trimmed = stripTrailingFailedAssistants(agent.state.messages) ?? agent.state.messages
    if (trimmed !== agent.state.messages) {
      const removedUsage = sumUsage(agent.state.messages.slice(trimmed.length))
      discardedUsage.input += removedUsage.input
      discardedUsage.output += removedUsage.output
      discardedUsage.cacheRead += removedUsage.cacheRead
      discardedUsage.cacheWrite += removedUsage.cacheWrite
      agent.state.messages = trimmed
    }
    return trimmed
  }

  // Rebuilds the transcript on compacted history + this turn's messages and
  // re-issues. Returns false when compaction produced nothing to retry with.
  const compactAfterOverflow = async (errorText: string): Promise<boolean> => {
    console.warn(`[AgentLoop] Context overflow reported by provider — attempting reactive compaction: ${errorText.slice(0, 160)}`)
    let compactedHistory: Message[] | null
    try {
      compactedHistory = (await options.onContextOverflow?.()) ?? null
    } catch (err: any) {
      console.error(`[AgentLoop] Reactive compaction failed:`, err?.message)
      return false
    }
    if (!compactedHistory) return false
    const trimmed = stripTrailingFailedAssistants(agent.state.messages) ?? agent.state.messages
    // Progress persisted mid-turn may survive compaction verbatim (same
    // object); anything summarized away must be re-added.
    const kept = new Set<Message>(compactedHistory)
    const originalTurn = trimmed.slice(historyLength)
    const turnMessages = originalTurn.filter((m) => !kept.has(m))
    // The failed attempt itself may have been persisted and kept.
    const combined = [...compactedHistory, ...turnMessages]
    const next = stripTrailingFailedAssistants(combined) ?? combined
    const tail = next[next.length - 1]
    if (!tail || tail.role === 'assistant') {
      console.warn(`[AgentLoop] Reactive compaction left no user/tool-result tail to continue from (tail=${tail?.role ?? 'none'})`)
      return false
    }
    const reported = Math.max(0, lastProgressMessageCount - historyLength)
    agent.state.messages = next
    const turnStart = originalTurn.length ? next.indexOf(originalTurn[0]) : -1
    historyLength = turnStart >= 0 ? turnStart : Math.min(compactedHistory.length, next.length)
    lastProgressMessageCount = historyLength + Math.min(reported, next.length - historyLength)
    promptError = undefined
    try {
      await agent.continue()
    } catch (err: any) {
      promptError = err
    }
    return true
  }

  // Image rejections (`400 ... You have uploaded an unsupported image`) are not
  // retryable as-is: the offending block lives in the transcript, so re-issuing
  // the same request fails identically — this turn and every later one. Repair
  // the transcript instead, escalating: replace only the images over a pixel
  // cap the provider named, then remove images we can prove are undecodable,
  // then every image in history, then this turn's as well. Each stage that
  // actually changes something buys exactly one retry.
  let imageRecoveryStage = 0
  /**
   * Per-image pixel cap a provider named on a rejected request — Anthropic
   * answers `400 … At least one of the image dimensions exceed max allowed size
   * for many-image requests: 3000 pixels`, a cap it applies per image once a
   * request carries many images. Until we know it, no image is ever rejected
   * for its dimensions.
   */
  let imageMaxDimension: number | undefined
  let imageRecoveryStages: Array<() => Message[] | null> | null = null
  const imageNote = (msg: Message) =>
    buildImageOmittedNote({
      modelId,
      toolName: msg.role === 'toolResult' ? msg.toolName : undefined,
      pathHint: extractPathHint(msg),
      reason: 'the provider rejected this image',
    })
  const scrubImages = (maxDimension?: number) => {
    if (!options.scrubInvalidImages) return null
    try {
      const scrubbed = options.scrubInvalidImages(agent.state.messages, { maxDimension })
      return scrubbed === agent.state.messages ? null : scrubbed
    } catch (err: any) {
      console.warn(`[AgentLoop] IMAGE_RECOVERY scrub threw: ${err?.message}`)
      return null
    }
  }
  /**
   * Laid out on the first image rejection, because whether the ladder can start
   * with the dimension stage depends on whether the provider has named a cap by
   * then. Building it lazily also keeps the stage numbering unchanged for every
   * rejection that has no cap in it.
   */
  const buildImageRecoveryStages = (): Array<() => Message[] | null> => {
    const stages: Array<() => Message[] | null> = []
    if (imageMaxDimension !== undefined) {
      // Replace only the images over the reported cap. Blanket-dropping the
      // history would also discard the screenshots the provider accepted.
      stages.push(() => scrubImages(imageMaxDimension))
    }
    if (options.scrubInvalidImages) stages.push(() => scrubImages())
    stages.push(() => {
      const next = replaceImageBlocks(agent.state.messages, (i) => i < historyLength, imageNote)
      return next === agent.state.messages ? null : next
    })
    stages.push(() => {
      const next = replaceImageBlocks(agent.state.messages, () => true, imageNote)
      return next === agent.state.messages ? null : next
    })
    return stages
  }

  if (inferenceRetry && !abortTriggered) {
    let retryAttempt = 0
    let backoffAttempt = 0
    let backoffStartedAt: number | null = null
    let lastFailureLength = -1
    let lastBackoffReason: RetryReason | null = null
    let sameReasonStreak = 0
    const waker = inferenceRetry.waker

    // One "episode" = consecutive failures of the same model call. It ends
    // when a re-issue gets further (new messages), or the loop exits.
    let episode: {
      startedAt: number
      layer: RetryLayer
      reason: RetryReason
      attempts: number
      suspectedDeterministic: boolean
      error: string
    } | null = null
    const endEpisode = (outcome: RetryEpisodeSummary['outcome']) => {
      if (!episode) return
      const summary: RetryEpisodeSummary = {
        layer: episode.layer,
        reason: episode.reason,
        attempts: episode.attempts,
        elapsedMs: Date.now() - episode.startedAt,
        outcome,
        suspectedDeterministic: episode.suspectedDeterministic,
        error: episode.error.slice(0, 300),
      }
      episode = null
      try {
        options.onRetryEpisodeEnd?.(summary)
      } catch { /* listener must not break the loop */ }
    }
    const LAYER_DEPTH: Record<RetryLayer, number> = { fast: 0, connectivity_park: 1, provider_backoff: 2 }
    const noteAttempt = (layer: RetryLayer, reason: RetryReason, error: string) => {
      if (!episode) {
        episode = { startedAt: Date.now(), layer, reason, attempts: 0, suspectedDeterministic: false, error }
      }
      if (LAYER_DEPTH[layer] > LAYER_DEPTH[episode.layer]) episode.layer = layer
      episode.reason = reason
      episode.error = error
      episode.attempts++
    }
    /** Returns true the first time an episode is flagged. */
    const markSuspectedDeterministic = (): boolean => {
      if (!episode || episode.suspectedDeterministic) return false
      episode.suspectedDeterministic = true
      return true
    }

    while (true) {
      if (abortTriggered || signal?.aborted) {
        endEpisode('user_stopped')
        break
      }

      const failure = detectInferenceFailure(agent.state.messages, promptError)
      if (!failure) {
        unresolvedFailureText = undefined
        endEpisode('recovered')
        break
      }
      unresolvedFailureText = failure.errorText

      if (IMAGE_REJECTION_RE.test(failure.errorText)) {
        const dimensionLimit = parseImageDimensionLimit(failure.errorText)
        if (dimensionLimit !== undefined && dimensionLimit !== imageMaxDimension) {
          imageMaxDimension = dimensionLimit
          try {
            options.onImageDimensionLimit?.(dimensionLimit)
          } catch { /* listener must not break the loop */ }
          // Nothing of the ladder has run yet on the first rejection, so it can
          // still start with the dimension stage. Once a blanket stage has run
          // there is no image left for the cap to preserve, so leave it alone.
          if (imageRecoveryStage === 0) imageRecoveryStages = null
        }
        const stages = (imageRecoveryStages ??= buildImageRecoveryStages())
        let retried = false
        while (imageRecoveryStage < stages.length) {
          const stage = ++imageRecoveryStage
          const before = trimFailedAssistantTail()
          const imageIndexes = imageBlockIndexes(before)
          const repaired = stages[stage - 1]()
          if (!repaired) continue
          console.warn(
            `[AgentLoop] IMAGE_RECOVERY stage=${stage}/${stages.length} model=${modelId} ` +
              `imagesAt=[${imageIndexes.join(',')}] error=${failure.errorText.slice(0, 200)}`,
          )
          agent.state.messages = repaired
          promptError = undefined
          try {
            await agent.continue()
          } catch (err: any) {
            promptError = err
          }
          retried = true
          break
        }
        if (retried) continue
        console.warn(
          `[AgentLoop] IMAGE_RECOVERY exhausted after ${stages.length} stage(s) — surfacing image failure: ` +
            failure.errorText.slice(0, 300),
        )
        promptError = new Error(
          'The model provider rejected the images in this conversation, and the turn could not continue. ' +
            `Provider said: ${failure.errorText}`,
        )
        endEpisode('failed_non_transient')
        break
      }

      const classification = classifyRetryability({
        message: failure.errorText,
        stopReason: failure.stopReason,
        aborted: abortTriggered || signal?.aborted,
      })
      if (!classification.retryable) {
        // Layer 5 for providers that report context overflow as an error
        // message (pi-ai doesn't throw) rather than a thrown error.
        if (
          options.onContextOverflow &&
          !reactiveRetried &&
          isContextOverflowError({ message: failure.errorText })
        ) {
          reactiveRetried = true
          const compacted = await compactAfterOverflow(failure.errorText)
          if (compacted) continue
        }
        endEpisode('failed_non_transient')
        break
      }

      // Strip the failed assistant tail so continue() resumes from the last
      // user/tool-result message. When the call rejected before pi appended any
      // assistant message (e.g. a synchronous stream throw on the very first
      // call), there's nothing to strip and the transcript already ends on a
      // user/tool-result message — continue() can re-issue directly.
      const trimmed = trimFailedAssistantTail()
      const last = trimmed[trimmed.length - 1]
      // Can't continue from a clean assistant tail (continue() rejects) — bail.
      if (!last || last.role === 'assistant') {
        endEpisode('failed_non_transient')
        break
      }

      // A re-issued call succeeded and later work failed anew: the new failure
      // gets its own backoff window (and its own episode) rather than
      // inheriting the old one.
      if (lastFailureLength >= 0 && trimmed.length > lastFailureLength) {
        endEpisode('recovered')
        backoffAttempt = 0
        backoffStartedAt = null
        lastBackoffReason = null
        sameReasonStreak = 0
      }
      lastFailureLength = trimmed.length

      if (retryAttempt < inferenceRetry.maxAttempts) {
        // Fast tier: short bounded backoff for blips (default 2 attempts,
        // 0.5-8s). This is unchanged from before Layer 7 existed.
        retryAttempt++
        noteAttempt('fast', classification.reason, failure.errorText)
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
        if (abortTriggered || signal?.aborted) {
          endEpisode('user_stopped')
          break
        }

        try {
          await agent.continue()
        } catch (err: any) {
          promptError = err
        }
        continue
      }

      // Layer 7: fast budget exhausted on a failure that's still classified
      // retryable. Rather than guess whether that means "no internet" or
      // "provider is having a bad moment", ask: probe upstream reachability
      // and, if the network path itself is down, park here polling with
      // backoff until it comes back, instead of failing the turn. Only
      // engages when a probe URL is configured (desktop's RuntimeManager
      // injects `AI_UPSTREAM_HEALTH_URL`; deployments that don't set it, or
      // that pass `connectivityWait: false`, skip straight to Layer 8).
      const park = inferenceRetry.connectivityWait
      if (park) {
        console.warn(
          `[AgentLoop] CONNECTIVITY_PARK fast-retry budget exhausted (${inferenceRetry.maxAttempts} attempts) ` +
            `reason=${classification.reason} — probing upstream connectivity before giving up`,
        )
        let parked = false
        const parkResult = await waitForConnectivity({
          probeUrl: park.probeUrl,
          signal,
          maxWaitMs: park.maxWaitMs,
          probe: park.probe,
          sleep: park.sleep,
          now: park.now,
          waker,
          onWaiting: (info) => {
            parked = true
            try {
              options.onConnectivityWait?.(info)
            } catch { /* listener must not break the loop */ }
          },
        })

        if (parkResult !== 'reconnected') {
          console.warn(`[AgentLoop] CONNECTIVITY_PARK ended without reconnecting (result=${parkResult})`)
          endEpisode(parkResult === 'aborted' ? 'user_stopped' : 'gave_up')
          break
        }

        if (parked) {
          console.warn('[AgentLoop] CONNECTIVITY_PARK reconnected — resuming turn')
          noteAttempt('connectivity_park', classification.reason, failure.errorText)
          try {
            options.onConnectivityReconnected?.()
          } catch { /* listener must not break the loop */ }

          // Connectivity is back — reset the fast budget and re-issue the
          // dropped call. Tools already executed earlier in this turn are
          // untouched (same idempotency invariant the fast tier relies on).
          retryAttempt = 0
          backoffAttempt = 0
          backoffStartedAt = null
          lastBackoffReason = null
          sameReasonStreak = 0
          promptError = undefined
          if (abortTriggered || signal?.aborted) {
            endEpisode('user_stopped')
            break
          }

          try {
            await agent.continue()
          } catch (err: any) {
            promptError = err
          }
          continue
        }
        // Reachable on the first probe: the network is fine and the provider
        // is the one failing. Resetting the fast budget here would re-issue
        // every ~1.5s with no end, so hand off to Layer 8 instead.
      }

      // Layer 8: provider backoff. The network is up but the provider keeps
      // failing (overloaded, 5xx, dropped connections). Keep re-issuing with
      // capped exponential backoff — by default until it works or the user
      // stops the turn.
      const backoff = inferenceRetry.providerBackoff
      if (!backoff || !PROVIDER_BACKOFF_REASONS.has(classification.reason)) {
        endEpisode('gave_up')
        break
      }

      const now = backoff.now()
      if (backoffStartedAt === null) backoffStartedAt = now
      const elapsedMs = now - backoffStartedAt
      if (backoffAttempt >= backoff.maxAttempts || elapsedMs >= backoff.maxWaitMs) {
        console.warn(
          `[AgentLoop] PROVIDER_BACKOFF giving up after ${backoffAttempt} attempts / ${Math.round(elapsedMs / 1000)}s ` +
            `reason=${classification.reason} error=${failure.errorText.slice(0, 160)}`,
        )
        endEpisode('gave_up')
        break
      }

      sameReasonStreak = classification.reason === lastBackoffReason ? sameReasonStreak + 1 : 1
      lastBackoffReason = classification.reason
      const suspectedDeterministic = sameReasonStreak >= NO_PROGRESS_THRESHOLD

      backoffAttempt++
      noteAttempt('provider_backoff', classification.reason, failure.errorText)
      if (suspectedDeterministic && markSuspectedDeterministic()) {
        console.warn(
          `[AgentLoop] PROVIDER_BACKOFF_NO_PROGRESS ${sameReasonStreak} identical failures with no progress ` +
            `reason=${classification.reason} error=${failure.errorText.slice(0, 300)}`,
        )
      }
      const delayMs = Math.max(0, Math.min(backoff.computeDelayMs(backoffAttempt), backoff.maxWaitMs - elapsedMs))
      try {
        options.onProviderBackoff?.({
          attempt: backoffAttempt,
          reason: classification.reason,
          delayMs,
          elapsedMs,
          maxWaitMs: backoff.maxWaitMs,
          error: failure.errorText,
          suspectedDeterministic,
        })
      } catch { /* listener must not break the loop */ }
      console.warn(
        `[AgentLoop] PROVIDER_BACKOFF attempt=${backoffAttempt} reason=${classification.reason} ` +
          `delayMs=${delayMs} elapsedMs=${elapsedMs} error=${failure.errorText.slice(0, 160)}`,
      )

      promptError = undefined
      if (delayMs > 0) await backoff.sleep(delayMs, signal, waker)
      if (abortTriggered || signal?.aborted) {
        endEpisode('user_stopped')
        break
      }

      try {
        await agent.continue()
      } catch (err: any) {
        promptError = err
      }
    }
  }

  let allMessages = agent.state.messages
  let newMessages = allMessages.slice(historyLength)
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
  const rawCoreError = (coreErrorMsg as any)?.errorMessage ?? (promptError ? undefined : unresolvedFailureText)
  const coreError = rawCoreError ? parseProviderError(rawCoreError) : undefined

  // A usage limit ends the turn with a notice (and the client's Upgrade
  // prompt) whether or not the turn made progress first.
  const usageLimit = !abortTriggered
    ? detectUsageLimit(rawCoreError) ?? detectUsageLimit(promptError?.message)
    : null
  if (usageLimit && promptError) promptError = undefined

  const implicitError =
    !usageLimit && !promptError && usage.output === 0 && toolCalls.length === 0 && !abortTriggered
      ? new Error(
          coreError
            ? `Provider error: ${coreError}`
            : 'Agent produced no output — possible provider error'
        )
      : undefined

  // If there was a core error but the agent DID make progress (tool calls executed),
  // don't treat it as a hard error — mark as exhausted so the caller can continue.
  if (coreError && !usageLimit && !implicitError && !promptError && toolCalls.length > 0 && !maxIterationsExhausted) {
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
    !usageLimit &&
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

    // An empty turn with no tool calls has nothing to preserve, so leave it
    // empty and let the caller retry or explain, not claim tool work happened.
    if ((!finalText.trim() && !emptyNoToolTurn) || stoppedByIterationLimit) {
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

  if (usageLimit) {
    console.warn(`[AgentLoop] Usage limit reached after ${toolCalls.length} tool calls — ending turn with limit notice`)
    const notice = buildUsageLimitNotice(toolCalls.length, usageLimit)
    const noticeText = finalText.trim() ? `\n\n${notice}` : notice
    onTextDelta?.(noticeText)
    finalText = finalText.trim() ? `${finalText}${noticeText}` : notice
    const noticeMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: notice }],
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
    newMessages = [...newMessages, noticeMessage]
    allMessages = [...allMessages, noticeMessage]
    maxIterationsExhausted = false
    promptError = undefined
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
    perCallUsage: collectPerCallUsage(newMessages, discardedUsage),
    newMessages,
    loopBreak,
    error: promptError || implicitError,
    effectiveModelId: currentModelId,
    maxIterationsExhausted,
    lastStopReason,
    lastTurnHadToolCalls,
    abortReason: abortTriggered ? abortReason : undefined,
    usageLimit: usageLimit ?? undefined,
  }

  await onAgentEnd?.(result)

  return result
}

/**
 * Provider errors that mean "there is an image in this request I cannot
 * accept". Anthropic: `messages[N].image[0]: You have uploaded an unsupported
 * image`, and — separately — `messages.N.content.N.image.source.base64.data:
 * At least one of the image dimensions exceed max allowed size for many-image
 * requests: 3000 pixels`, which it raises per image once a request carries many
 * images. OpenAI-compatible providers: `invalid image` / `unsupported image`.
 *
 * The dimension form uses a dotted path rather than `image[0]` and never says
 * "unsupported", so it needs its own alternatives: without them the error fell
 * through to `classifyRetryability`, was marked non-retryable, and the turn
 * stopped instead of repairing the transcript.
 */
const IMAGE_REJECTION_RE =
  /You have uploaded an unsupported image|unsupported image|invalid image|image\[\d+\]|image\.source|image dimensions? exceed|exceed max allowed size for many-image requests/i

/**
 * The per-image pixel cap named in a dimension rejection
 * (`… many-image requests: 3000 pixels`). Only consulted once
 * `IMAGE_REJECTION_RE` has matched, so an unrelated "N pixels" cannot be
 * mistaken for a cap.
 */
const IMAGE_DIMENSION_LIMIT_RE = /(\d{3,6})\s*pixels?\b/i

/** Pixel cap named by a provider's image-dimension 400, if it named one. */
function parseImageDimensionLimit(errorText: string): number | undefined {
  const match = errorText.match(IMAGE_DIMENSION_LIMIT_RE)
  if (!match) return undefined
  const limit = Number.parseInt(match[1], 10)
  return Number.isFinite(limit) && limit > 0 ? limit : undefined
}

/** Indexes of messages carrying at least one image block (for the logs). */
function imageBlockIndexes(messages: ReadonlyArray<Message>): number[] {
  const out: number[] = []
  messages.forEach((msg, index) => {
    if (msg.role !== 'user' && msg.role !== 'toolResult') return
    if (!Array.isArray(msg.content)) return
    if (msg.content.some((block) => block.type === 'image')) out.push(index)
  })
  return out
}

/** Best-effort image path from a message's sibling text block. */
function extractPathHint(msg: Message): string | undefined {
  if (!Array.isArray(msg.content)) return undefined
  for (const block of msg.content as Array<{ type: string; text?: string }>) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const match = block.text.match(/"path"\s*:\s*"([^"]+)"/)
    if (match) return match[1]
  }
  return undefined
}

/**
 * One entry per model call: pi-agent-core appends one assistant message per
 * request, so the assistant messages in this turn's slice ARE the calls. Entries
 * with no tokens at all are skipped (the synthetic max-turns notice, mocked
 * turns), and a dropped retry attempt is appended once with `discarded: true`
 * so the sum of `perCallUsage` always equals the turn's reported totals.
 */
function collectPerCallUsage(
  messages: ReadonlyArray<Message>,
  discarded: { input: number; output: number; cacheRead: number; cacheWrite: number },
): PerCallUsage[] {
  const out: PerCallUsage[] = []
  let call = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    call++
    const entry: PerCallUsage = {
      iteration: call,
      input: msg.usage.input,
      output: msg.usage.output,
      cacheRead: msg.usage.cacheRead ?? 0,
      cacheWrite: msg.usage.cacheWrite ?? 0,
    }
    if (entry.input + entry.output + entry.cacheRead + entry.cacheWrite === 0) continue
    out.push(entry)
  }
  if (discarded.input + discarded.output + discarded.cacheRead + discarded.cacheWrite > 0) {
    out.push({ iteration: 0, ...discarded, discarded: true })
  }
  return out
}

function buildImageOmittedNote(opts: {
  modelId: string
  toolName?: string
  pathHint?: string
  reason: string
}): string {
  const source = opts.toolName ? `from ${opts.toolName}` : 'attached here'
  const where = opts.pathHint ? ` The image file is still at "${opts.pathHint}".` : ''
  return (
    `[Image omitted — ${source}] This image was not sent to ${opts.modelId} (${opts.reason}).${where} ` +
    'Do not describe or guess what it shows; tell the user the image could not be viewed and where it is saved.'
  )
}

/**
 * What the model reads instead of an image that could not be described. Same
 * shape as SHO-41's note, so the agent still learns where the file is — but it
 * says which fallback failed rather than "do not describe".
 */
function formatDescribedImage(opts: {
  description: ImageDescription
  modelId: string
  toolName?: string
  pathHint?: string
}): string {
  const source = opts.toolName ? `from ${opts.toolName}` : 'attached here'
  const where = opts.pathHint
    ? `\nThe image file is still at "${opts.pathHint}". Ask for a re-read if you need a second look.`
    : ''
  return (
    `[Image ${source}, described by ${opts.description.modelId} because ${opts.modelId} only accepts text input]\n` +
    `${opts.description.text}${where}`
  )
}

function skipReasonText(reason: VisionSkipReason): string {
  switch (reason) {
    case 'no-vision-model':
      return 'no vision model is available to describe it'
    case 'no-api-key':
      return 'no API key is available for the vision model'
    case 'cap-reached':
      return 'this run already used its image-description budget'
    case 'too-large':
      return 'the image is too large to send to another model'
    case 'unsupported-format':
      return 'the image format is not supported'
    case 'describe-failed':
      return 'another model could not describe it'
  }
}

/**
 * Async sibling of `replaceImageBlocks` for the describe path: each image block
 * becomes one or more text blocks, in place, keeping the block order the model
 * sees stable across transform passes.
 */
async function replaceImageBlocksAsync(
  messages: ReadonlyArray<Message>,
  buildBlocks: (image: ImageContent, msg: Message) => Promise<Array<{ type: 'text'; text: string }>>,
): Promise<Message[]> {
  let mutated = false
  const out: Message[] = []
  for (const msg of messages) {
    const carriesImages =
      (msg.role === 'user' || msg.role === 'toolResult') &&
      Array.isArray(msg.content) &&
      msg.content.some((block) => block.type === 'image')
    if (!carriesImages) {
      out.push(msg)
      continue
    }
    const next: Array<{ type: string; text?: string;[key: string]: unknown }> = []
    for (const block of msg.content as Array<{ type: string }>) {
      if (block.type !== 'image') {
        next.push(block)
        continue
      }
      next.push(...(await buildBlocks(block as ImageContent, msg)))
      mutated = true
    }
    out.push({ ...msg, content: next } as Message)
  }
  return mutated ? out : (messages as Message[])
}

/**
 * Replace every image block in the selected messages with one text note per
 * message. Returns the input array unchanged when nothing was replaced, so
 * callers can use reference equality to decide whether a retry is worth it.
 */
function replaceImageBlocks(
  messages: ReadonlyArray<Message>,
  shouldReplace: (index: number) => boolean,
  buildNote: (msg: Message) => string,
): Message[] {
  let mutated = false
  const out: Message[] = []
  messages.forEach((msg, index) => {
    const carriesImages =
      (msg.role === 'user' || msg.role === 'toolResult') &&
      Array.isArray(msg.content) &&
      shouldReplace(index) &&
      msg.content.some((block) => block.type === 'image')
    if (!carriesImages) {
      out.push(msg)
      return
    }
    const note = buildNote(msg)
    const next: Array<{ type: string; text?: string }> = []
    let noted = false
    for (const block of msg.content as Array<{ type: string }>) {
      if (block.type !== 'image') {
        next.push(block)
      } else if (!noted) {
        next.push({ type: 'text', text: note })
        noted = true
      }
    }
    out.push({ ...msg, content: next } as Message)
    mutated = true
  })
  return mutated ? out : (messages as Message[])
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

/** Tools flagged `hidden` stay executable but are never advertised to the model. */
export function isHiddenTool(tool: AgentTool): boolean {
  return (tool as AgentTool & { hidden?: boolean }).hidden === true
}

/**
 * Strip hidden tools and anything the caller's advertised set defers from every
 * provider request. Evaluated per request, so activating a tool mid-turn takes
 * effect on the loop's next API call.
 */
function withoutUnadvertisedTools(
  streamFn: StreamFn,
  isAdvertisedTool?: (tool: AgentTool) => boolean,
): StreamFn {
  return (model, context, opts) =>
    streamFn(
      model,
      {
        ...context,
        tools: context.tools?.filter(
          (t) => !isHiddenTool(t as AgentTool) && (isAdvertisedTool ? isAdvertisedTool(t as AgentTool) : true),
        ),
      },
      opts,
    )
}
