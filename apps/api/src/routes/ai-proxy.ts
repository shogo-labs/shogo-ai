// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Model Proxy Routes
 *
 * Provides both OpenAI-compatible and Anthropic-native API proxies:
 * - Authenticates requests via project-scoped tokens (no raw API keys exposed)
 * - Routes to Anthropic or OpenAI based on the requested model
 * - Supports streaming (SSE) and non-streaming responses
 * - Logs usage events for analytics and billing
 *
 * Endpoints:
 * - POST /ai/v1/chat/completions       - OpenAI-compatible chat completions
 * - GET  /ai/v1/models                 - List available models
 * - POST /ai/anthropic/v1/messages     - Anthropic-native pass-through (for agent-runtime)
 * - POST /ai/anthropic/v1/messages/count_tokens - Token counting pass-through
 * - GET  /ai/anthropic/v1/models       - Anthropic models pass-through  
 * - POST /ai/proxy/tokens              - Generate a proxy token for a project
 *
 * Authentication:
 * - OpenAI-compatible: `Authorization: Bearer <proxy-token>`
 * - Anthropic-native: `x-api-key: <proxy-token>` (agent-runtime sends this)
 *
 * Environment Variables:
 * - ANTHROPIC_API_KEY: Anthropic API key (server-side only)
 * - OPENAI_API_KEY: OpenAI API key (server-side only)
 * - AI_PROXY_SECRET: Secret for signing proxy tokens (falls back to BETTER_AUTH_SECRET)
 */

import { metrics } from '@opentelemetry/api'
import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  generateProxyToken,
  verifyProxyToken,
  type ProxyTokenPayload,
} from '../lib/ai-proxy-token'
import { verifyRuntimeToken } from '../lib/runtime-token'
import { resolveApiKey } from './api-keys'
import { getDbRoutingConfigSync, getMergedModelEntrySync, type ModelUpstreamFallback } from '../services/model-registry.service'
import { isModelVisibleForWorkspace } from '../services/workspace-models.service'
import { isModelAccessibleForWorkspace } from '../lib/model-access'
import { getNativeProviderApiKeySync } from '../services/provider-credentials.service'
import {
  resolveVisibleModelsForWorkspace,
  isModelProviderConfigured,
} from '../services/visible-models.service'
import { wipeCloudKeyIfRejected } from '../lib/cloud-key-wipe'
import { cloudPassthroughHeaders, forwardToShogoCloud } from '../lib/cloud-request-forward'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import { getRuntimeManager } from '../lib/runtime'
import { beginCapture } from '../lib/proxy-capture'
import {
  MODEL_CATALOG,
  MODEL_ALIASES,
  IMAGE_MODEL_CATALOG,
  VIDEO_MODEL_CATALOG,
  AGENT_MODE_DEFAULTS,
  OPENROUTER_MODEL_PREFIX,
  resolveAgentModeDefault,
  getMaxOutputTokens,
  modelSupportsAudioInput,
  isLiveModel,
  isOpenRouterModel,
  stripOpenRouterPrefix,
  supportsAdaptiveThinking,
  type Provider,
  type ImageProvider,
  type ImageModelEntry,
  type ModelOptionField,
  type VideoModelEntry,
  getVideoModelEntry,
  mergeModelOptions,
  endpointsOf,
  resolveMediaModelId,
  type AgentMode,
  type ModelTier,
} from '@shogo/model-catalog'
import { randomUUID } from 'node:crypto'
import { putVideoJob, getVideoJob, claimVideoCharge, type VideoJobRecord } from '../lib/video-job-store'
import { put3dJob, get3dJob, claim3dCharge } from '../lib/3d-job-store'
import {
  DEFAULT_TRIPO_MODEL,
  DEFAULT_TRIPO_RIG_MODEL,
  TRIPO_CONVERT_FORMATS,
  TRIPO_MAX_ANIMATIONS,
  TRIPO_MODELS,
  TRIPO_OPS,
  type TripoOp,
  estimateTripoCredits,
  getTripoModel,
  isFileToken,
  isHttpsUrl,
  isTaskId,
  parseDataUri,
  tripoCreateTask,
  tripoGetTask,
  tripoUploadFile,
  TripoApiError,
} from '../lib/tripo-3d'

// =============================================================================
// Types
// =============================================================================

/**
 * Anthropic prompt-cache directive. Wire shape is `{ type: 'ephemeral', ttl?: '5m' | '1h' }`.
 * Kept loose (string) to avoid going stale if Anthropic adds new variants.
 */
interface AnthropicCacheControl { type: string; ttl?: string }

/** Vercel AI SDK provider-options shape for Anthropic (per-message / per-block / top-level). */
interface AnthropicProviderOptions { cacheControl?: AnthropicCacheControl }
interface ProviderOptionsField {
  anthropic?: AnthropicProviderOptions
  /** Shogo's private provider options namespace for custom upstreams. */
  shogo?: {
    thinking?: { type?: 'enabled' | 'disabled' }
    reasoning_effort?: string
  }
}

/** A content block on a chat-completion message. We accept both OpenAI-shaped
 *  parts and Anthropic-shaped passthrough metadata so SDK clients that set
 *  `providerOptions.anthropic.cacheControl` (or pre-translated `cache_control`)
 *  on individual parts have those preserved through to the Anthropic body. */
interface ChatCompletionContentBlock {
  type: string
  text?: string
  image_url?: { url: string }
  /** OpenAI Chat Completions audio-input shape. Only forwarded as-is to
   *  upstream OpenAI; only models with `capabilities.supportsAudioInput`
   *  (currently `gpt-audio`) accept it — see the `input_audio` validation
   *  in the `/ai/v1/chat/completions` handler below. */
  input_audio?: { data: string; format: string }
  /** Anthropic-native passthrough (used when client pre-translated). */
  cache_control?: AnthropicCacheControl
  /** Vercel AI SDK style; translated to wire `cache_control` in convertToAnthropicFormat. */
  providerOptions?: ProviderOptionsField
}

/** OpenAI-compatible chat completion request */
export interface ChatCompletionRequest {
  model: string
  messages: Array<{
    // `developer` is OpenAI's reasoning-model alias for the system prompt;
    // accept it here so callers routed through the OpenAI chat-completions
    // shape (pi-ai's openai-completions provider) don't trip the converter.
    role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
    content: string | Array<ChatCompletionContentBlock>
    name?: string
    tool_call_id?: string
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
    /** Per-message provider options. The Anthropic cache directive is applied
     *  to the last content block of the message (matching SDK semantics). */
    providerOptions?: ProviderOptionsField
  }>
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  stop?: string | string[]
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description?: string
      parameters?: Record<string, unknown>
    }
    /** Anthropic-native passthrough (pi-ai's `cacheControlFormat: 'anthropic'`). */
    cache_control?: AnthropicCacheControl
  }>
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
  /** OpenAI-compatible reasoning controls forwarded to DeepSeek. */
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: string
  /** DeepSeek requires this field on replayed assistant tool-call messages. */
  reasoning_content?: string
  /** Top-level provider options. The Anthropic cache directive is applied to
   *  the last system block AND the last user message's last content block,
   *  matching Anthropic's documented cacheable anchors. */
  providerOptions?: ProviderOptionsField
}

/** Model routing configuration (derived from the shared catalog) */
export interface ModelConfig {
  provider: Provider
  apiModel: string
  displayName: string
  /** Custom-provider (`provider === 'custom'`) OpenAI-compatible base URL. */
  baseUrl?: string
  /** Custom-provider decrypted upstream API key. */
  apiKey?: string
  /** Custom-provider auth style for attaching the key. */
  authStyle?: 'bearer' | 'api-key-header'
  /** Model-configured reasoning effort, used by upstreams such as DeepSeek. */
  reasoningEffort?: string
  /** Optional upstream identifier for provider-specific body compatibility. */
  upstream?: string
  /** Pre-first-byte failover target (DeepSeek direct while Hoshi 2.0 is on OpenRouter). */
  fallback?: ModelUpstreamFallback
  /** OpenRouter `provider` routing preferences from model capabilities. */
  openrouterProvider?: Record<string, unknown>
}

// =============================================================================
// Model Registry — built from the shared catalog
// =============================================================================

const MODEL_REGISTRY: Record<string, ModelConfig> = {}

for (const entry of Object.values(MODEL_CATALOG)) {
  MODEL_REGISTRY[entry.id] = {
    provider: entry.provider,
    apiModel: entry.apiModel,
    displayName: entry.displayName,
  }
}

for (const [alias, canonicalId] of Object.entries(MODEL_ALIASES)) {
  if (MODEL_REGISTRY[canonicalId]) {
    MODEL_REGISTRY[alias] = MODEL_REGISTRY[canonicalId]
  }
}

// =============================================================================
// Provider Routing
// =============================================================================

/**
 * Resolve a model name to its configuration.
 * Supports exact matches and prefix matching (e.g., "claude-3" matches the first claude-3.x model).
 */
export function resolveModel(model: string): ModelConfig | null {
  // Agent mode aliases — resolve via resolveAgentModel (handles local vs cloud)
  if (model === 'basic' || model === 'advanced') {
    const { resolvedModel, isLocal } = resolveAgentModel(model)
    if (isLocal) {
      return { provider: 'local', apiModel: resolvedModel, displayName: model }
    }
    return resolveModel(resolvedModel)
  }

  // OpenRouter — model id has the `openrouter:` prefix; the suffix is the
  // canonical OpenRouter model id (e.g. `meta-llama/llama-3.1-405b-instruct`).
  if (isOpenRouterModel(model)) {
    const apiModel = stripOpenRouterPrefix(model)
    return { provider: 'openrouter', apiModel, displayName: apiModel }
  }

  // DB-defined models (incl. custom OpenAI-compatible providers like MiMo).
  // These augment and override the static catalog, so consult them before
  // the static MODEL_REGISTRY. Resolves DB aliases internally.
  const dbRouting = getDbRoutingConfigSync(model)
  if (dbRouting) {
    return {
      provider: dbRouting.provider as Provider,
      apiModel: dbRouting.apiModel,
      displayName: dbRouting.displayName,
      baseUrl: dbRouting.baseUrl,
      apiKey: dbRouting.apiKey,
      authStyle: dbRouting.authStyle,
      reasoningEffort: dbRouting.reasoningEffort,
      upstream: dbRouting.upstream,
      fallback: dbRouting.fallback,
      openrouterProvider: dbRouting.openrouterProvider,
    }
  }

  // Exact match
  if (MODEL_REGISTRY[model]) {
    return MODEL_REGISTRY[model]
  }

  // Prefix match (e.g., "claude-3.5-sonnet" → "claude-3-5-sonnet-20241022")
  for (const [key, config] of Object.entries(MODEL_REGISTRY)) {
    if (key.startsWith(model) || config.apiModel.startsWith(model)) {
      return config
    }
  }

  // Infer provider from model name
  // Local development may use an arbitrary Ollama model id that is not part
  // of Shogo's static catalog (for example `qwen2.5:3b`). When the local LLM
  // is configured, route unknown ids to the OpenAI-compatible local endpoint
  // instead of rejecting them as unsupported cloud models.
  if (isLocalDev && process.env.LOCAL_LLM_BASE_URL) {
    return {
      provider: 'local',
      apiModel: model,
      displayName: model,
    }
  }
  if (model.startsWith('claude')) {
    return {
      provider: 'anthropic',
      apiModel: model,
      displayName: model,
    }
  }
  if (model.startsWith('gpt')) {
    return {
      provider: 'openai',
      apiModel: model,
      displayName: model,
    }
  }

  return null
}

/**
 * Resolve the access tier for a model id, honoring DB-defined models (incl.
 * custom providers) over the static catalog so admin-configured tiers gate
 * correctly. Falls back to the static heuristic for unknown ids.
 */
export function resolveModelTier(model: string): ModelTier {
  const dbEntry = getMergedModelEntrySync(model)
  if (dbEntry) return dbEntry.tier
  return getModelTier(model)
}

/**
 * Whether a model accepts `input_audio` content blocks natively, honoring
 * DB-defined models (incl. custom OpenAI-compatible providers like MiMo v2.5,
 * which backs the `hoshi-1.0` public alias) over the static catalog.
 *
 * `modelSupportsAudioInput` (from `@shogo/model-catalog`) only knows about
 * the static `MODEL_CATALOG` (e.g. `gpt-audio`) — it can't see admin-entered
 * `capabilities` on `ModelDefinition` rows, since that package can't depend
 * on `model-registry.service.ts`. Mirrors the `resolveModelTier` pattern above.
 */
export function resolveModelSupportsAudioInput(model: string): boolean {
  const dbEntry = getMergedModelEntrySync(model)
  if (dbEntry) return dbEntry.capabilities?.supportsAudioInput === true
  return modelSupportsAudioInput(model)
}

/**
 * Get the API key for a provider.
 */
function getProviderApiKey(provider: Provider): string | null {
  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'openrouter':
      // DB-stored (admin-entered, encrypted) key first, else the env var.
      return getNativeProviderApiKeySync(provider)
    case 'local':
      return 'local'
    default:
      // 'custom' providers carry their (decrypted) key on the ModelConfig,
      // resolved by `resolveModelApiKey` below — not from an env var.
      return null
  }
}

/**
 * Resolve the upstream API key for a resolved model. Custom providers carry
 * their decrypted key on the config (from the encrypted DB row); everything
 * else reads the server-side env var for its provider.
 */
export function resolveModelApiKey(modelConfig: ModelConfig): string | null {
  if (modelConfig.provider === 'custom') return modelConfig.apiKey || null
  return getProviderApiKey(modelConfig.provider)
}

/**
 * OpenAI-shaped 403 for a model the workspace admin has hidden. Used on the
 * local path and before forwarding to Shogo Cloud, so a forwarded call can't
 * skip this workspace's allowlist.
 */
function modelNotVisibleResponse(c: any, model: string) {
  return c.json(
    {
      error: {
        message: `Model '${model}' is not available for this workspace. A workspace admin has restricted the available models.`,
        type: 'invalid_request_error',
        code: 'model_not_visible',
      },
    },
    403
  )
}

/**
 * Resolve 'basic' / 'advanced' agent modes to actual model names.
 *
 * When local mode and LOCAL_LLM_BASE_URL are set: use admin-configured local models.
 * Otherwise: use defaults from the shared model catalog.
 */
function resolveAgentModel(model: string): { resolvedModel: string; isLocal: boolean } {
  const localBaseUrl = isLocalDev ? process.env.LOCAL_LLM_BASE_URL : undefined
  if (localBaseUrl) {
    if (model === 'basic') {
      return { resolvedModel: process.env.LOCAL_LLM_BASIC_MODEL || 'llama3', isLocal: true }
    }
    if (model === 'advanced') {
      return { resolvedModel: process.env.LOCAL_LLM_ADVANCED_MODEL || 'llama3', isLocal: true }
    }
    return { resolvedModel: model, isLocal: true }
  }
  if (model === 'basic' || model === 'advanced') {
    return { resolvedModel: resolveAgentModeDefault(model as AgentMode), isLocal: false }
  }
  return { resolvedModel: model, isLocal: false }
}

// =============================================================================
// Streaming Resilience — retry + mid-stream error visibility + SSE keepalive
// =============================================================================
//
// These helpers harden the upstream legs that hit Anthropic (or Shogo Cloud,
// which fronts Anthropic). They are modelled on `@anthropic-ai/sdk` (the
// library Claude Code CLI uses internally) and fix the failure modes that
// surface to users as "Claude connection lost":
//
//  1. Transient 429 / 5xx / 529 "overloaded_error" / TCP reset on the initial
//     POST — retried here instead of bubbling to the agent runtime.
//  2. Mid-stream disconnect where Anthropic's response body aborts after
//     `message_start` but before `message_stop`. Previously the SSE pipe
//     closed silently at EOF and the downstream SDK threw an opaque error.
//     We now inject an Anthropic-shaped `event: error` frame so the SDK
//     surfaces a typed, actionable error.
//  3. Opus-specific idle timeouts: Opus pauses tens of seconds during
//     extended thinking. Intermediate proxies (Cloudflare ~100s, AWS ALB
//     default 60s, Kubernetes Ingress often 60s) kill idle TCP in that
//     window. We emit SSE keepalive comments (`: keepalive\n\n`) every
//     KEEPALIVE_INTERVAL_MS when upstream is silent — parsers ignore
//     comments but intermediaries see live traffic.
//
// Parity notes vs @anthropic-ai/sdk (>= v0.30):
//   - SDK default `maxRetries`: 2. We use 2 for cloud hops (where upstream
//     already retries) and 3 for direct Anthropic hops (slightly more
//     aggressive since we are the only retry layer).
//   - SDK retries 408/409/429 + all 5xx. We add 425 (Too Early) + 529
//     (Anthropic Overloaded) which both Claude Code and the Python SDK
//     treat as retryable.
//   - SDK: exponential backoff with jitter honoring Retry-After /
//     Retry-After-Ms. Matching us. Cap at 30s (guard against buggy
//     upstream wedging a worker).
//
// We intentionally DO NOT retry mid-stream: Anthropic's Messages API has no
// resume-by-event-id semantics, so a silent retry would duplicate tokens.
// The agent runtime handles turn-level retries safely (same tool_use ids).

/** HTTP status codes that are worth retrying against Anthropic / Shogo Cloud. */
const ANTHROPIC_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

/** Node/undici network error codes that indicate a retry-able transient fault. */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** How long upstream can be silent before we send a keepalive comment. */
const KEEPALIVE_INTERVAL_MS = 15_000

/**
 * Env escape-hatch: set to disable retries in the cloud-forwarding path.
 * Prevents 3x (local) * 3x (cloud) = 9 attempt amplification when both
 * layers run this same code. When unset, we use a smaller attempt budget
 * (2) for cloud hops as a safe default.
 */
const SHOGO_CLOUD_DISABLE_LOCAL_RETRY =
  process.env.SHOGO_CLOUD_DISABLE_LOCAL_RETRY === 'true'

export interface RetryOptions {
  /**
   * Max attempts (inclusive of the first try). Defaults: 3 for direct
   * Anthropic hops, 2 for cloud hops (upstream has its own retries).
   */
  maxAttempts?: number
  /** Base delay for exponential backoff, in ms. Default 500. */
  baseDelayMs?: number
  /** Upper bound on a single wait, in ms. Default 8000. */
  maxDelayMs?: number
  /** Label used in logs (e.g. "anthropic" or "shogo-cloud"). */
  label?: string
  /** AbortSignal — when aborted we stop retrying immediately. */
  signal?: AbortSignal
}

export function isRetryableNetworkError(err: any): boolean {
  if (!err) return false
  const code = err.code || err.cause?.code
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true
  // undici surfaces many network faults as { name: 'TypeError', message: 'fetch failed' }
  const msg = String(err.message || '')
  if (/fetch failed|socket hang up|network.*error|terminated/i.test(msg)) return true
  return false
}

/**
 * Parse a `Retry-After` header value (RFC 7231 §7.1.3): integer seconds or
 * HTTP-date. Result is in milliseconds, capped at 30s.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const asInt = Number(header)
  if (Number.isFinite(asInt) && asInt >= 0) return Math.min(asInt * 1000, 30_000)
  const asDate = Date.parse(header)
  if (Number.isFinite(asDate)) return Math.max(0, Math.min(asDate - Date.now(), 30_000))
  return null
}

/**
 * Parse Anthropic's `Retry-After-Ms` header (milliseconds, integer).
 * Capped at 30s to avoid wedging a worker on a buggy upstream.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const ms = Number(header)
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.min(ms, 30_000)
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Split-frame-safe terminal-event detector.
 *
 * A TCP read can cleave `"type":"message_stop"` across two chunks, so the
 * caller must scan a rolling tail buffer — not individual chunks. We line-
 * match against `data:` lines so a value that coincidentally quotes the
 * string in a text delta cannot false-positive us.
 */
export const TERMINAL_EVENT_RE =
  /(?:^|\n)data:[^\n]*"type"\s*:\s*"(message_stop|error)"/

export function scanForTerminalEvent(buffer: string): boolean {
  return TERMINAL_EVENT_RE.test(buffer)
}

/**
 * Fetch wrapper that retries transient failures before any stream bytes flow.
 *
 * Retries are confined to the *connection* phase — once `fetch()` resolves
 * with a 2xx, we return the Response as-is and let the caller stream the
 * body. This preserves idempotency: the upstream has not yet emitted any
 * tokens when we retry, so duplicate-token risk is zero.
 *
 * Retries on:
 *   - Network errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, "fetch failed")
 *   - HTTP 408 / 409 / 425 / 429 / 500 / 502 / 503 / 504 / 529
 *
 * Does NOT retry on:
 *   - AbortError caused by the caller's signal (client cancel → surface 499)
 *   - 4xx responses other than the transient set above
 *   - Cloud hops when SHOGO_CLOUD_DISABLE_LOCAL_RETRY=true (trust upstream)
 *
 * Honors `Retry-After-Ms` (Anthropic-specific) and `Retry-After` response
 * headers, capped at 30s to avoid wedging a worker on a buggy upstream.
 */
export async function fetchAnthropicWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const isCloudHop = opts.label === 'shogo-cloud'
  const defaultAttempts = isCloudHop
    ? SHOGO_CLOUD_DISABLE_LOCAL_RETRY ? 1 : 2
    : 3
  const maxAttempts = opts.maxAttempts ?? defaultAttempts
  const baseDelayMs = opts.baseDelayMs ?? 500
  const maxDelayMs = opts.maxDelayMs ?? 8000
  const label = opts.label ?? 'anthropic'
  const signal = opts.signal ?? (init.signal as AbortSignal | undefined)

  let lastError: any = null
  let lastStatus: number | null = null
  let lastRetryAfterMs: number | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    try {
      const response = await fetch(url, { ...init, signal })

      // Success or non-retryable client error — return to caller.
      if (response.ok || !ANTHROPIC_RETRYABLE_STATUS.has(response.status)) {
        return response
      }

      // Retryable HTTP status — drain body so we can reuse the connection.
      lastStatus = response.status
      // Anthropic returns `retry-after-ms` (integer ms) in addition to the
      // standard `Retry-After` (seconds or HTTP-date). Prefer the ms one.
      lastRetryAfterMs =
        parseRetryAfterMs(response.headers.get('retry-after-ms')) ??
        parseRetryAfter(response.headers.get('retry-after'))
      try {
        lastError = new Error(await response.text())
      } catch {
        lastError = new Error(`${label} HTTP ${response.status}`)
      }

      if (attempt >= maxAttempts) {
        // Out of attempts — synthesize a Response so the caller can forward
        // the last error body verbatim (preserves Anthropic's error shape).
        return new Response(lastError.message, {
          status: response.status,
          headers: {
            'Content-Type':
              response.headers.get('Content-Type') || 'application/json',
          },
        })
      }
    } catch (err: any) {
      // Client-initiated abort must bubble up; never retry it.
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw err
      }
      if (!isRetryableNetworkError(err)) {
        throw err
      }
      lastError = err
      lastStatus = null
      lastRetryAfterMs = null
      if (attempt >= maxAttempts) break
    }

    // Compute backoff: Retry-After wins; otherwise exponential with full jitter.
    const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
    const jittered = Math.floor(Math.random() * exp)
    const delay = lastRetryAfterMs ?? jittered
    console.warn(
      `[AI Proxy] ${label} transient failure (attempt ${attempt}/${maxAttempts}, ` +
        `status=${lastStatus ?? 'network'}): retrying in ${delay}ms — ${lastError?.message || lastError?.code || 'unknown'}`,
    )
    await sleepWithAbort(delay, signal)
  }

  // Network error path exhausted without a Response — rethrow the last error.
  throw lastError ?? new Error(`${label} request failed after ${maxAttempts} attempts`)
}

/**
 * Status to relay for a failed provider call. A provider 401 means the
 * platform's own provider key was rejected; passed through as-is, clients
 * that authenticate with a Shogo key can't tell it from their key being
 * revoked.
 */
export function relayStatusForProviderError(status: number): number {
  return status === 401 ? 502 : status
}

/**
 * Log a provider's non-2xx response before relaying it. The runtime shows the
 * user a generic "please try again" for these, so the server log is the only
 * place the upstream reason (e.g. Anthropic's 400 on an unsupported thinking
 * shape) is visible.
 */
export function logUpstreamError(upstream: string, status: number, model: string | undefined, body: string): void {
  console.error(`[AI Proxy] ${upstream} upstream error (${status}, model=${model ?? 'unknown'}): ${body.slice(0, 500)}`)
}

/**
 * Classify a stream error into a typed code for downstream consumers.
 * The code lets the UI decide whether to auto-retry (retryable) or surface
 * a fatal message (non-retryable).
 */
export type StreamErrorCode =
  | 'upstream_truncated' // clean EOF without message_stop
  | 'network_drop'       // ECONNRESET, socket hang up, etc.
  | 'idle_timeout'       // MAX_IDLE_MS exceeded with no upstream data
  | 'upstream_error'     // catch-all for other errors

export interface StreamErrorPayload {
  type: 'error'
  error: {
    type: 'stream_error'
    code: StreamErrorCode
    retryable: boolean
    message: string
    meta: {
      chunks: number
      bytes: number
      durationMs: number
      idleMs: number
    }
  }
}

function classifyStreamError(err: any): StreamErrorCode {
  if (!err) return 'upstream_truncated'
  const msg = String(err?.message ?? '')
  if (err?.code === 'ETIMEDOUT' || /idle.?timeout/i.test(msg)) return 'idle_timeout'
  if (/ECONNRESET|socket hang up|terminated|fetch failed/i.test(msg)) return 'network_drop'
  if (err?.code && RETRYABLE_ERROR_CODES.has(err.code)) return 'network_drop'
  return 'upstream_error'
}

/**
 * Maximum time (ms) the upstream can be silent (no real chunks) before we
 * abort and inject a retryable error. 120s is well below the 30min fetch
 * timeout but long enough for Opus extended-thinking pauses (which are
 * covered by keepalive comments, not this watchdog).
 */
const MAX_IDLE_MS = 120_000

export interface StreamWrapOptions {
  /** Idle ms before emitting a SSE keepalive comment. Default 15000. */
  keepaliveMs?: number
  /** Hard idle limit before injecting a retryable error. Default 120000. */
  maxIdleMs?: number
  /** How often to check the watchdog condition, in ms. Default 5000. */
  watchdogIntervalMs?: number
}

/**
 * Wrap an upstream SSE body so that (a) mid-stream disconnects surface as
 * explicit `event: error` frames, and (b) an idle upstream does not cause
 * intermediate proxies to drop the TCP connection.
 *
 * Without (a): when Anthropic's TCP connection drops after `message_start`
 * but before `message_stop`, the downstream SDK sees a normal end-of-stream
 * and throws an opaque "connection lost" error. We now inject a structured
 * error event so the SDK surfaces a typed, actionable error.
 *
 * Without (b): Opus streams frequently pause 30–60s during extended
 * thinking. Cloudflare / AWS ALB / Kubernetes Ingress can kill idle TCP in
 * that window. A SSE comment line (`: keepalive\n\n`) is ignored by parsers
 * (per https://html.spec.whatwg.org/multipage/server-sent-events.html) but
 * keeps the socket hot.
 *
 * We track whether a terminal event (`message_stop` or `error`) was observed
 * in a split-frame-safe rolling buffer, so we only inject synthetic errors
 * on actual truncation.
 */
export function wrapSseForErrorVisibility(
  upstream: ReadableStream<Uint8Array>,
  providerLabel: string,
  options: StreamWrapOptions = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_INTERVAL_MS
  const maxIdleMs = options.maxIdleMs ?? MAX_IDLE_MS
  const watchdogIntervalMs = options.watchdogIntervalMs ?? 5_000
  let tailBuffer = ''
  let sawTerminalEvent = false
  let chunkCount = 0
  let totalBytes = 0
  const startedAt = Date.now()
  let lastChunkAt = startedAt

  function buildErrorPayload(
    code: StreamErrorCode,
    message: string,
  ): StreamErrorPayload {
    const retryable = code !== 'upstream_error'
    // Embed a stable, machine-readable marker so the retryable flag + code
    // survive transport through the provider SDK into pi-ai's `errorMessage`,
    // where the agent-runtime's retry classifier can read them deterministically
    // instead of guessing from prose. Kept in sync with
    // `packages/agent/src/retry-classifier.ts` (parseStreamErrorMarker) and
    // stripped from user-facing text by `formatErrorMessage`.
    const taggedMessage = `${message} [shogo:retryable=${retryable};code=${code}]`
    return {
      type: 'error',
      error: {
        type: 'stream_error',
        code,
        retryable,
        message: taggedMessage,
        meta: {
          chunks: chunkCount,
          bytes: totalBytes,
          durationMs: Date.now() - startedAt,
          idleMs: Date.now() - lastChunkAt,
        },
      },
    }
  }

  function emitErrorFrame(
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: StreamErrorPayload,
  ) {
    try {
      controller.enqueue(
        encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`),
      )
    } catch { /* downstream gone */ }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader()
      let idleWatchdogFired = false

      // Keepalive: emit a SSE comment when upstream is silent so intermediate
      // proxies see live traffic and refresh their idle timer.
      const keepaliveTimer = setInterval(() => {
        const idleFor = Date.now() - lastChunkAt
        if (idleFor < keepaliveMs) return
        try {
          controller.enqueue(encoder.encode(`: keepalive ${idleFor}ms\n\n`))
        } catch {
          // Downstream gone or controller closed — nothing to do.
        }
      }, keepaliveMs)

      // Watchdog: if upstream produces zero real chunks for MAX_IDLE_MS,
      // inject a retryable error and cancel. 120s is well beyond any
      // Opus thinking pause (covered by keepalive), so this catches
      // genuinely-stuck upstream connections.
      const watchdogTimer = setInterval(() => {
        const idle = Date.now() - lastChunkAt
        if (idle <= maxIdleMs) return
        idleWatchdogFired = true
        const payload = buildErrorPayload(
          'idle_timeout',
          `No data from ${providerLabel} for ${idle}ms; giving up. Please retry.`,
        )
        emitErrorFrame(controller, payload)
        console.warn(
          `[AI Proxy] ${providerLabel} idle watchdog fired after ${idle}ms. ` +
            `chunks=${chunkCount} bytes=${totalBytes} duration=${Date.now() - startedAt}ms.`,
        )
        try { reader.cancel('idle timeout') } catch { /* noop */ }
        try { controller.close() } catch { /* noop */ }
      }, watchdogIntervalMs)

      try {
        while (true) {
          if (idleWatchdogFired) break
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            chunkCount++
            totalBytes += value.byteLength
            lastChunkAt = Date.now()
            const text = decoder.decode(value, { stream: true })
            tailBuffer = (tailBuffer + text).slice(-8192)
            if (!sawTerminalEvent && scanForTerminalEvent(tailBuffer)) {
              sawTerminalEvent = true
            }
            controller.enqueue(value)
          }
        }
        // Clean EOF. If we never saw a terminal event (and watchdog didn't
        // already handle this), synthesize a typed error frame.
        if (!sawTerminalEvent && !idleWatchdogFired) {
          const payload = buildErrorPayload(
            'upstream_truncated',
            `Upstream ${providerLabel} stream ended without message_stop after ${Date.now() - startedAt}ms (likely network drop; idle ${Date.now() - lastChunkAt}ms before close). The turn may be incomplete; please retry.`,
          )
          emitErrorFrame(controller, payload)
          console.warn(
            `[AI Proxy] ${providerLabel} stream truncated — injected error frame. ` +
              `chunks=${chunkCount} bytes=${totalBytes} duration=${payload.error.meta.durationMs}ms idle=${payload.error.meta.idleMs}ms. ` +
              `Last bytes: ${tailBuffer.slice(-200).replace(/\n/g, '\\n')}`,
          )
        }
        if (!idleWatchdogFired) {
          try { controller.close() } catch { /* noop */ }
        }
      } catch (err: any) {
        if (idleWatchdogFired) return
        if (err?.name === 'AbortError') {
          try { controller.close() } catch { /* noop */ }
          return
        }
        const code = classifyStreamError(err)
        const payload = buildErrorPayload(
          code,
          `Upstream ${providerLabel} stream dropped after ${Date.now() - startedAt}ms (idle ${Date.now() - lastChunkAt}ms): ${err?.message || err?.code || 'unknown network error'}. Please retry.`,
        )
        emitErrorFrame(controller, payload)
        console.warn(
          `[AI Proxy] ${providerLabel} stream faulted mid-body [${code}]: ${err?.message || err?.code}. ` +
            `chunks=${chunkCount} bytes=${totalBytes} duration=${payload.error.meta.durationMs}ms idle=${payload.error.meta.idleMs}ms. ` +
            `Last bytes: ${tailBuffer.slice(-200).replace(/\n/g, '\\n')}`,
        )
        try { controller.close() } catch { /* noop */ }
      } finally {
        clearInterval(keepaliveTimer)
        clearInterval(watchdogTimer)
        try { reader.releaseLock() } catch { /* noop */ }
      }
    },
    cancel(reason) {
      upstream.cancel(reason).catch(() => { /* noop */ })
    },
  })
}

// =============================================================================
// Anthropic Proxy
// =============================================================================

/**
 * Map a Vercel AI SDK `cacheControl` to the Anthropic wire `cache_control`.
 * 1:1 today; isolates future spec drift (e.g. additional `ttl` variants).
 */
function mapCacheControl(cc?: AnthropicCacheControl): AnthropicCacheControl | undefined {
  if (!cc?.type) return undefined
  return cc.ttl ? { type: cc.type, ttl: cc.ttl } : { type: cc.type }
}

/**
 * Opt-in diagnostic: when AI_PROXY_LOG_CACHE=1, log how many system / last-user
 * content blocks carry `cache_control` immediately before the outbound Anthropic
 * fetch. Lets us confirm cache directives actually reach the wire without
 * relying on an Anthropic SDK trace.
 */
function logCacheControlIfEnabled(body: Record<string, unknown>, where: string): void {
  if (process.env.AI_PROXY_LOG_CACHE !== '1') return
  const system = (body as { system?: unknown }).system
  const sysArr = Array.isArray(system) ? system as Array<{ cache_control?: unknown }> : []
  const sysCC = sysArr.filter(b => b?.cache_control).length
  const sysShape = typeof system === 'string' ? 'string' : (Array.isArray(system) ? `array(${sysArr.length})` : 'none')
  const msgs = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages || []
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  const lastUserContent = Array.isArray(lastUser?.content)
    ? lastUser!.content as Array<{ cache_control?: unknown }>
    : []
  const lastUserCC = lastUserContent.filter(b => b?.cache_control).length
  console.log(
    `[AI Proxy] [cache:${where}] system=${sysShape} system_cache_control=${sysCC}, ` +
    `lastUserMsg blocks=${lastUserContent.length} cache_control=${lastUserCC}`
  )
}

/**
 * Convert OpenAI-format messages to Anthropic format.
 * Anthropic uses a separate `system` parameter and has different message structure.
 *
 * When the incoming request carries Vercel AI SDK `providerOptions.anthropic.cacheControl`
 * (top-level, per-message, or per-content-block) OR pre-translated Anthropic `cache_control`
 * on content parts, we promote `system` to a block array and propagate `cache_control` onto
 * the appropriate Anthropic blocks so prompt caching takes effect. Without cache metadata,
 * we keep the simpler string-system fast path for full backwards compatibility with every
 * existing chat-completions caller.
 */
/** Translate OpenAI content parts to Anthropic blocks, carrying cache metadata. */
function toAnthropicBlocks(content: ChatCompletionContentBlock[]): any[] {
  const blocks: any[] = []
  for (const b of content) {
    if (b.type === 'text' && !b.text) continue
    const bcc = b.cache_control ?? mapCacheControl(b.providerOptions?.anthropic?.cacheControl)
    let out: Record<string, unknown>
    if (b.type === 'image_url' && b.image_url?.url) {
      const url = b.image_url.url
      const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      out = {
        type: 'image',
        source: dataUrl
          ? { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] }
          : { type: 'url', url },
      }
    } else {
      out = { ...b }
      delete out.providerOptions
      delete out.cache_control
    }
    if (bcc) out.cache_control = bcc
    blocks.push(out)
  }
  return blocks
}

function parseToolArguments(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function convertToAnthropicFormat(request: ChatCompletionRequest) {
  // Detect whether ANY cache metadata is present. If not, take the fast path.
  const topCC = mapCacheControl(request.providerOptions?.anthropic?.cacheControl)
  const anyCacheMeta = !!topCC || request.messages.some(m => {
    if (m.providerOptions?.anthropic?.cacheControl) return true
    if (Array.isArray(m.content)) {
      return m.content.some(b => b.cache_control || b.providerOptions?.anthropic?.cacheControl)
    }
    return false
  })

  const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: AnthropicCacheControl }> = []
  let systemPromptString: string | undefined
  const messages: Array<{ role: string; content: string | Array<any> }> = []

  for (const msg of request.messages) {
    // Anthropic has no `developer` role — OpenAI reasoning models use it as the
    // system-prompt channel — so fold `developer` into the `system` parameter.
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(p => p.text || '').join('\n')

      if (anyCacheMeta) {
        // Prefer per-message providerOptions; fall back to the last content block's
        // cache_control / providerOptions when the message-level field is absent.
        let cc = mapCacheControl(msg.providerOptions?.anthropic?.cacheControl)
        if (!cc && Array.isArray(msg.content) && msg.content.length) {
          const last = msg.content[msg.content.length - 1]
          cc = mapCacheControl(last.cache_control ?? last.providerOptions?.anthropic?.cacheControl)
        }
        systemBlocks.push({ type: 'text', text, ...(cc ? { cache_control: cc } : {}) })
      } else {
        // Fast path: merge multiple system messages into a single string, as before.
        systemPromptString = systemPromptString
          ? `${systemPromptString}\n${text}`
          : text
      }
      continue
    }

    const msgCC = mapCacheControl(msg.providerOptions?.anthropic?.cacheControl)

    // OpenAI tool results → Anthropic `tool_result` blocks on a user turn.
    // Parallel calls produce consecutive `tool` messages; Anthropic wants all
    // of an assistant turn's results together in the following user message.
    if (msg.role === 'tool') {
      const resultContent = typeof msg.content === 'string'
        ? msg.content
        : toAnthropicBlocks(msg.content ?? [])
      const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: msg.tool_call_id }
      if (resultContent.length) block.content = resultContent
      if (msgCC) block.cache_control = msgCC
      const prev = messages[messages.length - 1]
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content.every((b: any) => b.type === 'tool_result')) {
        prev.content.push(block)
      } else {
        messages.push({ role: 'user', content: [block] })
      }
      continue
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    const toolUses = role === 'assistant'
      ? (msg.tool_calls ?? []).map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseToolArguments(tc.function.arguments),
        }))
      : []

    if (Array.isArray(msg.content) || toolUses.length || msg.content == null) {
      const blocks: any[] = [
        ...(Array.isArray(msg.content)
          ? toAnthropicBlocks(msg.content)
          : msg.content ? [{ type: 'text', text: msg.content }] : []),
        ...toolUses,
      ]
      // Anthropic rejects empty content (e.g. an assistant turn that was
      // `content: null` with no tool calls), so drop the message entirely.
      if (!blocks.length) continue
      // Per-message providerOptions applies to the last block (matches SDK semantics).
      if (msgCC) {
        const last = blocks[blocks.length - 1] as { cache_control?: AnthropicCacheControl }
        if (!last.cache_control) last.cache_control = msgCC
      }
      messages.push({ role, content: blocks })
    } else if (typeof msg.content === 'string' && msgCC) {
      // Coerce string content to a single text block so cache_control has a home.
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: msg.content, cache_control: msgCC }],
      })
    } else {
      // No cache metadata on this message — pass through unchanged.
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      })
    }
  }

  // Top-level cache_control: apply to the last system block AND the last user
  // message's last content block — matches Anthropic's documented cacheable
  // anchors and lets clients enable caching with a single top-level directive.
  if (topCC) {
    if (systemBlocks.length && !systemBlocks[systemBlocks.length - 1].cache_control) {
      systemBlocks[systemBlocks.length - 1].cache_control = topCC
    }
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    if (lastUser && Array.isArray(lastUser.content) && lastUser.content.length) {
      const lastBlock = lastUser.content[lastUser.content.length - 1] as { cache_control?: AnthropicCacheControl }
      if (!lastBlock.cache_control) lastBlock.cache_control = topCC
    } else if (lastUser && typeof lastUser.content === 'string') {
      // Promote to a text block so the cache anchor has a place to live.
      lastUser.content = [{ type: 'text', text: lastUser.content, cache_control: topCC }]
    }
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens || getMaxOutputTokens(request.model),
  }

  if (anyCacheMeta && systemBlocks.length) body.system = systemBlocks
  else if (systemPromptString) body.system = systemPromptString
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.top_p !== undefined) body.top_p = request.top_p
  if (request.stop) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop]
  if (request.stream) body.stream = true

  // Convert tools to Anthropic format
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(tool => {
      const cc = mapCacheControl(tool.cache_control)
      return {
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} },
        ...(cc ? { cache_control: cc } : {}),
      }
    })
  }

  if (request.tool_choice) {
    if (request.tool_choice === 'auto') {
      body.tool_choice = { type: 'auto' }
    } else if (request.tool_choice === 'required') {
      body.tool_choice = { type: 'any' }
    } else if (request.tool_choice === 'none') {
      // Anthropic doesn't have "none", omit tools instead
      delete body.tools
    } else if (typeof request.tool_choice === 'object') {
      body.tool_choice = { type: 'tool', name: request.tool_choice.function.name }
    }
  }

  return body
}

/** Anthropic accepts at most four `cache_control` breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4
const UNCACHEABLE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

function countCacheBreakpoints(body: Record<string, any>): number {
  let n = 0
  const countBlocks = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b?.cache_control) n++
      if (b?.type === 'tool_result') countBlocks(b.content)
    }
  }
  countBlocks(body.system)
  countBlocks(body.tools)
  for (const m of body.messages ?? []) countBlocks(m?.content)
  return n
}

/** Last block of a message that may carry `cache_control`, promoting string content. */
function lastCacheableBlock(message: { content: unknown } | undefined): Record<string, any> | undefined {
  if (!message) return undefined
  if (typeof message.content === 'string') {
    if (!message.content) return undefined
    message.content = [{ type: 'text', text: message.content }]
  }
  if (!Array.isArray(message.content)) return undefined
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i]
    if (!block || UNCACHEABLE_BLOCK_TYPES.has(block.type)) continue
    if (block.type === 'text' && !block.text) continue
    return block
  }
  return undefined
}

/**
 * Backstop prompt caching for chat-completions requests routed to Anthropic.
 *
 * The OpenAI wire format has no caching concept, so callers that never send
 * cache markers (older desktop runtimes routing Anthropic models by DB id
 * through this endpoint) were billed full input price on every step of a
 * long agent turn. Clients that do send markers (pi-ai's anthropic compat)
 * place the last-message marker on the latest user/assistant *text*, which in
 * a tool loop is the original prompt, leaving every tool result uncached.
 *
 * Caching never changes model output, so fill breakpoints up to Anthropic's
 * limit, in priority order: the final message (the rolling anchor that makes
 * each step's growth cacheable), the stable system prompt, the last tool, and
 * the second-to-last message. Also strips the runtime's `<|CACHE_BOUNDARY|>`
 * marker from the system prompt, which would otherwise reach the model as text.
 *
 * `AI_PROXY_AUTO_CACHE=0` disables adding breakpoints.
 */
export function applyDefaultCacheBreakpoints(body: Record<string, any>): void {
  const autoCache = process.env.AI_PROXY_AUTO_CACHE !== '0'
  let stableSystemBlock: Record<string, any> | undefined
  if (typeof body.system === 'string' && (autoCache || body.system.includes(CACHE_BOUNDARY))) {
    if (body.system) body.system = [{ type: 'text', text: body.system }]
    else delete body.system
  }
  if (Array.isArray(body.system)) {
    const blocks: any[] = []
    for (const block of body.system) {
      if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.includes(CACHE_BOUNDARY)) {
        blocks.push(block)
        continue
      }
      const idx = block.text.indexOf(CACHE_BOUNDARY)
      const stableText = block.text.slice(0, idx).trimEnd()
      const dynamicText = block.text.slice(idx + CACHE_BOUNDARY.length).trimStart()
      if (stableText) {
        const stable: Record<string, any> = { type: 'text', text: stableText }
        if (block.cache_control) stable.cache_control = block.cache_control
        blocks.push(stable)
        stableSystemBlock ??= stable
      }
      if (dynamicText) blocks.push({ type: 'text', text: dynamicText })
    }
    body.system = blocks
    stableSystemBlock ??= [...blocks].reverse().find(b => b?.type === 'text' && b.text)
  }

  if (!autoCache) return

  const messages: Array<{ role: string; content: unknown }> = body.messages ?? []
  const tools: Array<Record<string, any>> | undefined = Array.isArray(body.tools) ? body.tools : undefined
  const candidates = [
    () => lastCacheableBlock(messages[messages.length - 1]),
    () => stableSystemBlock,
    () => tools?.[tools.length - 1],
    () => lastCacheableBlock(messages[messages.length - 2]),
  ]
  let budget = MAX_CACHE_BREAKPOINTS - countCacheBreakpoints(body)
  for (const pick of candidates) {
    if (budget <= 0) break
    const target = pick()
    if (!target || target.cache_control) continue
    target.cache_control = { type: 'ephemeral' }
    budget--
  }
}

/**
 * Convert Anthropic non-streaming response to OpenAI format.
 */
function convertAnthropicResponseToOpenAI(anthropicResponse: any, model: string) {
  const content = anthropicResponse.content || []
  const textParts = content.filter((c: any) => c.type === 'text')
  const toolParts = content.filter((c: any) => c.type === 'tool_use')

  const message: any = {
    role: 'assistant',
    content: textParts.map((t: any) => t.text).join('') || null,
  }

  if (toolParts.length > 0) {
    message.tool_calls = toolParts.map((t: any, i: number) => ({
      id: t.id,
      type: 'function',
      function: {
        name: t.name,
        arguments: JSON.stringify(t.input),
      },
    }))
  }

  return {
    id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapAnthropicStopReason(anthropicResponse.stop_reason),
      },
    ],
    usage: anthropicUsageToOpenAI(
      anthropicResponse.usage?.input_tokens || 0,
      anthropicResponse.usage?.cache_read_input_tokens || 0,
      anthropicResponse.usage?.cache_creation_input_tokens || 0,
      anthropicResponse.usage?.output_tokens || 0,
    ),
  }
}

/**
 * OpenAI-format usage for an Anthropic response, shared by the streaming
 * terminal chunk and the non-stream converter. Follows OpenRouter's cache
 * convention, which is what the runtime's OpenAI-completions parser reads:
 * `prompt_tokens` and `cached_tokens` both include cache writes, and
 * `cache_write_tokens` carries them separately. `splitOpenAIPromptUsage`
 * reverses it. Top-level `cache_creation_input_tokens` stays for clients that
 * read the older shape.
 */
export function anthropicUsageToOpenAI(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
) {
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    prompt_tokens_details: cacheWriteTokens > 0
      ? { cached_tokens: cacheReadTokens + cacheWriteTokens, cache_write_tokens: cacheWriteTokens }
      : { cached_tokens: cacheReadTokens },
    ...(cacheWriteTokens > 0 ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
  }
}

function mapAnthropicStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'end_turn':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'stop'
  }
}

// =============================================================================
// Anthropic <-> OpenAI Format Conversion (for local LLM providers)
// =============================================================================

function convertAnthropicRequestToOpenAIMessages(anthropicReq: any): any[] {
  const messages: any[] = []
  if (anthropicReq.system) {
    const systemText = typeof anthropicReq.system === 'string'
      ? anthropicReq.system
      : anthropicReq.system.map((b: any) => b.text || '').join('\n')
    messages.push({ role: 'system', content: systemText })
  }
  for (const msg of anthropicReq.messages || []) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
        if (textParts) {
          messages.push({ role: msg.role, content: textParts })
        }
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input) },
              }],
            })
          }
          if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : (block.content || []).map((c: any) => c.text || '').join('\n')
            messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: resultContent,
            })
          }
        }
      }
    }
  }
  return messages
}

function convertOpenAIResponseToAnthropic(openaiResp: any, model: string): any {
  const choice = openaiResp.choices?.[0]
  const content: any[] = []
  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content })
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      })
    }
  }
  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  }
}

export function convertOpenAIStreamToAnthropicStream(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let sseBuffer = ''
  let contentIndex = 0
  // Block 0 is the text block opened up front. Tool calls open later blocks;
  // only one block is open at a time (OpenAI streams tool calls sequentially).
  let nextBlockIndex = 1
  let openBlock: number | null = 0
  let sawToolCall = false
  const toolBlockByOpenAIIndex = new Map<number, number>()

  const event = (name: string, data: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  const closeOpenBlock = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (openBlock === null) return
    controller.enqueue(event('content_block_stop', { type: 'content_block_stop', index: openBlock }))
    openBlock = null
  }

  return new ReadableStream({
    start(controller) {
      controller.enqueue(event('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }))
      controller.enqueue(event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }))
    },
    async pull(controller) {
      const reader = body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuffer += decoder.decode(value, { stream: true })
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              closeOpenBlock(controller)
              controller.enqueue(event('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: sawToolCall ? 'tool_use' : 'end_turn' },
                usage: { output_tokens: contentIndex },
              }))
              controller.enqueue(event('message_stop', { type: 'message_stop' }))
              controller.close()
              return
            }
            try {
              const chunk = JSON.parse(data)
              const delta = chunk.choices?.[0]?.delta
              if (delta?.content && openBlock === 0) {
                contentIndex += delta.content.length
                controller.enqueue(event('content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: delta.content },
                }))
              }
              for (const call of delta?.tool_calls ?? []) {
                const openAIIndex = typeof call.index === 'number' ? call.index : 0
                let blockIndex = toolBlockByOpenAIIndex.get(openAIIndex)
                if (blockIndex === undefined) {
                  closeOpenBlock(controller)
                  blockIndex = nextBlockIndex++
                  toolBlockByOpenAIIndex.set(openAIIndex, blockIndex)
                  openBlock = blockIndex
                  sawToolCall = true
                  controller.enqueue(event('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: call.id || `toolu_${Date.now()}_${blockIndex}`,
                      name: call.function?.name ?? '',
                      input: {},
                    },
                  }))
                }
                const args = call.function?.arguments
                if (args) {
                  controller.enqueue(event('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: args },
                  }))
                }
              }
            } catch { /* ignore malformed chunks */ }
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * Proxy a streaming request to Anthropic and convert SSE to OpenAI format.
 */
export async function proxyAnthropicStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig,
  onComplete?: (inputTokens: number, outputTokens: number, cachedInputTokens: number, cacheWriteTokens: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  const body = convertToAnthropicFormat({
    ...request,
    model: modelConfig.apiModel,
    stream: true,
  })
  applyDefaultCacheBreakpoints(body)

  logCacheControlIfEnabled(body, 'stream')

  const response = await fetchAnthropicWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    },
    { label: 'anthropic', signal },
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`)
  }

  // Transform Anthropic SSE stream to OpenAI SSE format
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const completionId = `chatcmpl-${Date.now()}`
  let inputTokens = 0
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      const lines = text.split('\n')

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        try {
          const event = JSON.parse(data)
          const openAIChunk = convertAnthropicStreamEvent(event, completionId, request.model)
          if (openAIChunk) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`))
          }

          if (event.type === 'message_start' && event.message?.usage) {
            const usage = event.message.usage
            inputTokens = usage.input_tokens || 0
            cacheWriteTokens = usage.cache_creation_input_tokens || 0
            cachedInputTokens = usage.cache_read_input_tokens || 0
          }
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens || 0
          }
        } catch {
          // Skip unparseable lines
        }
      }
    },
    flush(controller) {
      // OpenAI-compatible clients (pi-ai sets `stream_options.include_usage`)
      // read token usage from a terminal chunk that has empty `choices` and a
      // `usage` object. Anthropic carries usage out-of-band (on `message_start`
      // / `message_delta`), so we synthesize that terminal chunk here. Without
      // it the agent runtime parses `completion_tokens: 0` and misreports a
      // fully-streamed answer as "Agent produced no output — possible provider
      // error" once the turn completes.
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [],
            usage: anthropicUsageToOpenAI(inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens),
          })}\n\n`,
        ),
      )
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      onComplete?.(inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens)
    },
  })

  // Wrap upstream with keepalive + mid-stream error visibility before the
  // OpenAI translator runs, so truncation-related `event: error` frames flow
  // through `convertAnthropicStreamEvent` and surface as typed errors.
  const wrapped = wrapSseForErrorVisibility(response.body!, 'anthropic')
  const transformed = wrapped.pipeThrough(transformStream)

  return new Response(transformed, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Proxy-Provider': 'anthropic',
      'X-Proxy-Model': modelConfig.apiModel,
    },
  })
}

/**
 * Convert a single Anthropic SSE event to OpenAI SSE chunk format.
 */
function convertAnthropicStreamEvent(event: any, id: string, model: string): any | null {
  switch (event.type) {
    case 'content_block_start':
      if (event.content_block?.type === 'text') {
        return {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        }
      }
      if (event.content_block?.type === 'tool_use') {
        return {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: event.index || 0,
                    id: event.content_block.id,
                    type: 'function',
                    function: {
                      name: event.content_block.name,
                      arguments: '',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }
      }
      return null

    case 'content_block_delta':
      if (event.delta?.type === 'text_delta') {
        return {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content: event.delta.text },
              finish_reason: null,
            },
          ],
        }
      }
      if (event.delta?.type === 'input_json_delta') {
        return {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: event.index || 0,
                    function: { arguments: event.delta.partial_json },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }
      }
      // Anthropic streams extended thinking as `thinking_delta`. Map it to the
      // OpenAI-compatible `reasoning_content` delta field that pi-ai reads, so
      // reasoning is surfaced on the chat-completions conversion path instead of
      // being silently dropped. (`signature_delta` carries the opaque thinking
      // signature; it has no place in the OpenAI stream shape and is not echoed
      // back on this path, so we drop it.)
      if (event.delta?.type === 'thinking_delta') {
        return {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: event.delta.thinking ?? '' },
              finish_reason: null,
            },
          ],
        }
      }
      return null

    case 'message_delta':
      return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mapAnthropicStopReason(event.delta?.stop_reason),
          },
        ],
      }

    // Synthetic `event: error` frames produced by `wrapSseForErrorVisibility`
    // (or returned verbatim by Anthropic on hard errors). We surface the
    // structured error payload at the chunk level while keeping
    // `finish_reason: 'stop'` — strict OpenAI SDKs reject non-standard
    // finish_reason values, and the `error` field on the chunk is what the
    // Vercel AI SDK and `@anthropic-ai/sdk` consumers inspect.
    case 'error': {
      const msg =
        event.error?.message ||
        event.message ||
        'Upstream stream dropped'
      const errType = event.error?.type || 'stream_error'
      return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        error: { type: errType, message: msg },
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      }
    }

    default:
      return null
  }
}

/**
 * Proxy a non-streaming request to Anthropic.
 */
export async function proxyAnthropicNonStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig,
  signal?: AbortSignal,
) {
  const body = convertToAnthropicFormat({
    ...request,
    model: modelConfig.apiModel,
    stream: false,
  })
  applyDefaultCacheBreakpoints(body)

  logCacheControlIfEnabled(body, 'nonstream')

  const response = await fetchAnthropicWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    },
    { label: 'anthropic', signal },
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`)
  }

  const anthropicResponse = await response.json()
  return convertAnthropicResponseToOpenAI(anthropicResponse, request.model)
}

// =============================================================================
// OpenAI Proxy (pass-through)
// =============================================================================

function getOpenAICompatibleBaseUrl(modelConfig: ModelConfig): string {
  if (modelConfig.provider === 'local' && process.env.LOCAL_LLM_BASE_URL) {
    return `${process.env.LOCAL_LLM_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`
  }
  if (modelConfig.provider === 'openrouter') {
    const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    return `${base}/chat/completions`
  }
  // Custom OpenAI-compatible providers (e.g. MiMo): the admin-configured
  // base URL already includes the version path (e.g. .../v1), so we just
  // append the chat-completions route.
  if (modelConfig.provider === 'custom' && modelConfig.baseUrl) {
    return `${modelConfig.baseUrl.replace(/\/$/, '')}/chat/completions`
  }
  return 'https://api.openai.com/v1/chat/completions'
}

function isOpenRouterHost(modelConfig: ModelConfig): boolean {
  return modelConfig.provider === 'openrouter' || modelConfig.baseUrl?.includes('openrouter.ai') === true
}

/** Hoshi stays DeepSeek-shaped for the runtime. BYOK `openrouter:` models keep OpenRouter's native payload. */
function shouldRewriteOpenRouterReasoning(modelConfig: ModelConfig): boolean {
  return modelConfig.upstream === 'deepseek' && isOpenRouterHost(modelConfig)
}

function getOpenAICompatibleHeaders(apiKey: string, modelConfig: ModelConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Custom providers can authenticate via `api-key` header instead of a
  // Bearer token (MiMo accepts either); honor the configured auth style.
  if (modelConfig.provider === 'custom' && modelConfig.authStyle === 'api-key-header') {
    headers['api-key'] = apiKey
  } else if (modelConfig.provider !== 'local') {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  if (isOpenRouterHost(modelConfig)) {
    // Attribution headers — OpenRouter surfaces these in their dashboard
    // and uses them for app-level moderation. Both are optional but
    // recommended; users can override either via env if they prefer
    // their own attribution. Custom providers whose base URL is OpenRouter
    // (Hoshi 2.0) need them too; the native `openrouter:` provider is BYOK.
    headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER || 'https://shogo.ai'
    headers['X-Title'] = process.env.OPENROUTER_X_TITLE || 'Shogo'
  }
  return headers
}

/**
 * Build the JSON body sent to an OpenAI-compatible endpoint, translating the
 * client-facing `max_tokens` field to whatever the upstream provider expects.
 *
 * OpenAI's GPT-5+ generation (gpt-5-mini, gpt-5.4-mini/nano, gpt-5.5,
 * gpt-5.6-sol/terra/luna, gpt-6-astra, o1/o3/o4, ...) rejects `max_tokens`
 * with a 400 ("Unsupported parameter: 'max_tokens' is not supported with
 * this model. Use 'max_completion_tokens' instead"). `max_completion_tokens`
 * is accepted by every current OpenAI model — including the legacy
 * gpt-4/gpt-4o/gpt-4-turbo family that still accepts `max_tokens` too — so
 * it's safe to always rewrite the field when calling native OpenAI. Other
 * OpenAI-*compatible* backends routed through this same function (local
 * runtimes, OpenRouter, admin-configured custom providers) generally only
 * understand `max_tokens`, so leave those untouched.
 */
/**
 * Remove the runtime's `<|CACHE_BOUNDARY|>` canary from wire text.
 *
 * The canary exists so the Anthropic request builder can split the system
 * prompt into a cached stable block and an uncached dynamic block. Every other
 * provider caches implicitly (OpenAI and DeepSeek by prefix, Gemini implicitly)
 * so there is no breakpoint to place — the marker would just ride along inside
 * the system message as literal prompt text, costing tokens and making the
 * boundary useless as a canary. Stripping it here, at the proxy boundary, keeps
 * that decision in one place instead of in every converter.
 */
const CACHE_BOUNDARY_RE = /\s*<\|CACHE_BOUNDARY\|>\s*/g

export function stripCacheBoundaryText(text: string): string {
  return text.includes(CACHE_BOUNDARY) ? text.replace(CACHE_BOUNDARY_RE, '\n\n') : text
}

/**
 * Drop cache hints a chat-completions upstream has no use for: the Anthropic
 * `cache_control` markers pi-ai's compat layer adds, and the
 * `<|CACHE_BOUNDARY|>` canary described above. Collapses a single marked text
 * part back to a plain string so strict upstreams see plain content.
 */
function stripCacheMarkersFromMessage(
  message: ChatCompletionRequest['messages'][number],
): ChatCompletionRequest['messages'][number] {
  if (typeof message.content === 'string') {
    if (!message.content.includes(CACHE_BOUNDARY)) return message
    return { ...message, content: stripCacheBoundaryText(message.content) }
  }
  if (!Array.isArray(message.content)) return message
  const hasCacheControl = message.content.some(p => p.cache_control)
  const hasBoundary = message.content.some(
    p => typeof (p as { text?: string }).text === 'string' && (p as { text: string }).text.includes(CACHE_BOUNDARY),
  )
  if (!hasCacheControl && !hasBoundary) return message
  const parts = message.content.map(({ cache_control: _cc, ...part }) => (
    part.type === 'text' && typeof part.text === 'string'
      ? { ...part, text: stripCacheBoundaryText(part.text) }
      : part
  ))
  const only = parts.length === 1 ? parts[0] : undefined
  const content = only?.type === 'text' && Object.keys(only).length === 2 && typeof only.text === 'string'
    ? only.text
    : parts
  return { ...message, content }
}

function buildOpenAICompatibleBody(
  request: ChatCompletionRequest,
  modelConfig: ModelConfig,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const { max_tokens, ...rest } = request
  const body: Record<string, unknown> = { ...rest, model: modelConfig.apiModel, ...extra }
  // OpenRouter honors Anthropic-style markers for the models that cache;
  // other OpenAI-compatible upstreams get the payload shape they always had.
  if (!isOpenRouterHost(modelConfig)) {
    body.messages = request.messages.map(stripCacheMarkersFromMessage)
    if (request.tools) body.tools = request.tools.map(({ cache_control: _cc, ...tool }) => tool)
  }
  if (max_tokens !== undefined) {
    if (modelConfig.provider === 'openai') body.max_completion_tokens = max_tokens
    else body.max_tokens = max_tokens
  }

  // Chat Completions is the compatibility fallback for native OpenAI models.
  // OpenAI rejects reasoning_effort on older GPT models outright and rejects
  // it on GPT-5+ whenever function tools are present. Reasoning-capable
  // runtime turns should use /v1/responses; if a caller still reaches this
  // endpoint, omitting the field preserves tool calling instead of failing
  // before the first tool invocation.
  if (modelConfig.provider === 'openai') {
    delete body.reasoning_effort
  }

  const isDeepSeek =
    modelConfig.upstream === 'deepseek' ||
    (modelConfig.provider === 'custom' && modelConfig.baseUrl?.includes('api.deepseek.com') === true)
  if (!isDeepSeek) return body

  // DeepSeek's OpenAI-compatible endpoint uses the legacy max_tokens field,
  // even when the caller/runtime emitted OpenAI's max_completion_tokens.
  // OpenRouter's chat completions endpoint accepts the same field.
  if (body.max_completion_tokens !== undefined && body.max_tokens === undefined) {
    body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
  }

  // DeepSeek rejects OpenAI-only request fields and requires developer prompts
  // to use the system role. The proxy is the compatibility boundary, so keep
  // this normalization here rather than making every client know the
  // upstream-specific wire format.
  delete body.store
  const providerOptions = body.providerOptions as ProviderOptionsField | undefined
  const shogoOptions = providerOptions?.shogo
  delete body.providerOptions

  const explicitThinking = request.thinking ?? shogoOptions?.thinking
  const thinking = (explicitThinking ?? { type: 'enabled' }) as { type?: 'enabled' | 'disabled' }
  const reasoningEffort =
    shogoOptions?.reasoning_effort ??
    modelConfig.reasoningEffort ??
    request.reasoning_effort

  // OpenRouter does not speak DeepSeek's `thinking` / `reasoning_content`
  // fields. Hoshi stays a DeepSeek-shaped model to the runtime; only the
  // upstream body changes. `reasoning_details` is what OpenRouter asks callers
  // to replay so a tool-call turn can continue the same reasoning trace.
  if (isOpenRouterHost(modelConfig)) {
    delete body.thinking
    delete body.reasoning_effort
    body.reasoning = thinking.type === 'disabled'
      ? { enabled: false }
      : reasoningEffort
        ? { effort: reasoningEffort }
        : { enabled: true }
    if (modelConfig.openrouterProvider) {
      body.provider = modelConfig.openrouterProvider
    }
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map((message: any) => {
        const normalized: any = { ...stripCacheMarkersFromMessage(message) }
        if (normalized.role === 'developer') normalized.role = 'system'
        if (normalized.role === 'assistant') {
          const text = typeof normalized.reasoning === 'string'
            ? normalized.reasoning
            : typeof normalized.reasoning_content === 'string'
              ? normalized.reasoning_content
              : ''
          normalized.reasoning = text
          delete normalized.reasoning_content
          if (text && normalized.reasoning_details === undefined) {
            normalized.reasoning_details = [{ type: 'reasoning.text', text }]
          }
        }
        return normalized
      })
    }
    return body
  }

  body.thinking = thinking
  if (reasoningEffort && thinking.type !== 'disabled') {
    body.reasoning_effort = reasoningEffort
  } else if (thinking.type === 'disabled') {
    delete body.reasoning_effort
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message: any) => {
      const normalized = { ...message }
      if (normalized.role === 'developer') normalized.role = 'system'
      if (normalized.role === 'assistant' && normalized.reasoning_content === undefined) {
        // With tools present, DeepSeek requires reasoning_content on every
        // replayed assistant message, including messages from before the
        // thinking-enabled model was introduced.
        normalized.reasoning_content = ''
      }
      return normalized
    })
  }

  return body
}

const aiProxyMeter = metrics.getMeter('shogo-ai-proxy')
const upstreamFailoverCounter = aiProxyMeter.createCounter('ai_proxy.upstream_failovers', {
  description: 'Chat completions retried on a configured fallback upstream before any response bytes were sent',
})

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && err.name === 'AbortError'
}

const OPENAI_TOOLS_NEED_NO_REASONING = /function tools with reasoning_effort are not supported/i
const reasoningNoneRetryCounter = aiProxyMeter.createCounter('ai_proxy.reasoning_none_retries', {
  description: 'OpenAI Chat Completions tool calls sent with reasoning_effort=none, by whether the model was already known to need it',
})
/**
 * OpenAI models that rejected tools with default reasoning on Chat
 * Completions. Remembered per process so only the first call pays the 400.
 */
const modelsNeedingReasoningNone = new Set<string>()

export function __resetReasoningNoneCacheForTests(): void {
  modelsNeedingReasoningNone.clear()
}

function isFailoverStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Fallback is a different upstream. Retrying the same host and model only
 * doubles latency during an outage, and it would change behavior for a
 * DeepSeek-direct row whose capabilities still name that same provider.
 */
function fallbackModelConfig(modelConfig: ModelConfig): ModelConfig | null {
  const fallback = modelConfig.fallback
  if (!fallback?.apiKey || !fallback.baseUrl || !fallback.apiModel) return null
  const norm = (url: string) => url.replace(/\/$/, '')
  if (norm(fallback.baseUrl) === norm(modelConfig.baseUrl || '') && fallback.apiModel === modelConfig.apiModel) {
    return null
  }
  return {
    provider: 'custom',
    apiModel: fallback.apiModel,
    displayName: modelConfig.displayName,
    baseUrl: fallback.baseUrl,
    apiKey: fallback.apiKey,
    authStyle: fallback.authStyle,
    reasoningEffort: modelConfig.reasoningEffort,
    upstream: modelConfig.upstream,
  }
}

function recordUpstreamFailover(reason: string, from: ModelConfig, to: ModelConfig): void {
  upstreamFailoverCounter.add(1, { reason })
  console.warn(
    `[AI Proxy] failover ${from.apiModel} @ ${from.baseUrl ?? from.provider} → ${to.apiModel} @ ${to.baseUrl} (${reason})`,
  )
}

async function fetchOpenAICompatible(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig,
  extra: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ response: Response; served: ModelConfig }> {
  const attempt = (config: ModelConfig, key: string, overrides?: Record<string, unknown>) => fetch(getOpenAICompatibleBaseUrl(config), {
    method: 'POST',
    headers: getOpenAICompatibleHeaders(key, config),
    body: JSON.stringify({ ...buildOpenAICompatibleBody(request, config, extra), ...overrides }),
    signal,
  })

  const fallback = fallbackModelConfig(modelConfig)
  try {
    const knownNeedsNone =
      modelConfig.provider === 'openai' && !!request.tools?.length && modelsNeedingReasoningNone.has(modelConfig.apiModel)
    if (knownNeedsNone) {
      reasoningNoneRetryCounter.add(1, { model: modelConfig.apiModel, provider: modelConfig.provider, known: 'true' })
    }
    let response = await attempt(modelConfig, apiKey, knownNeedsNone ? { reasoning_effort: 'none' } : undefined)
    if (
      !knownNeedsNone &&
      response.status === 400 &&
      modelConfig.provider === 'openai' &&
      request.tools?.length &&
      OPENAI_TOOLS_NEED_NO_REASONING.test(await response.clone().text().catch(() => ''))
    ) {
      // Some OpenAI reasoning models (gpt-6-*) reason by default, so omitting
      // reasoning_effort isn't enough to allow function tools on Chat
      // Completions — they must be told to skip reasoning explicitly.
      await response.text().catch(() => {})
      modelsNeedingReasoningNone.add(modelConfig.apiModel)
      reasoningNoneRetryCounter.add(1, { model: modelConfig.apiModel, provider: modelConfig.provider, known: 'false' })
      console.warn(`[AI Proxy] ${modelConfig.apiModel} rejected tools with default reasoning on chat completions; retrying with reasoning_effort=none`)
      response = await attempt(modelConfig, apiKey, { reasoning_effort: 'none' })
    }
    if (response.ok || !fallback || !isFailoverStatus(response.status)) {
      return { response, served: modelConfig }
    }
    await response.text().catch(() => {})
    const reason = response.status === 429 ? 'http_429' : 'http_5xx'
    recordUpstreamFailover(reason, modelConfig, fallback)
    return { response: await attempt(fallback, fallback.apiKey!), served: fallback }
  } catch (err) {
    if (!fallback || isAbortError(err, signal)) throw err
    recordUpstreamFailover('network', modelConfig, fallback)
    return { response: await attempt(fallback, fallback.apiKey!), served: fallback }
  }
}

function openAIProxyHeaders(modelConfig: ModelConfig): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Proxy-Provider': modelConfig.provider,
    'X-Proxy-Model': modelConfig.apiModel,
  }
}

/** Copy OpenRouter's `reasoning` / `reasoning_details` onto DeepSeek's `reasoning_content`. */
function rewriteOpenRouterReasoningPayload(payload: any): boolean {
  const choices = payload?.choices
  if (!Array.isArray(choices)) return false
  let changed = false
  for (const choice of choices) {
    for (const field of ['delta', 'message'] as const) {
      const part = choice?.[field]
      if (!part || typeof part !== 'object' || typeof part.reasoning_content === 'string') continue
      const fromDetails = Array.isArray(part.reasoning_details)
        ? part.reasoning_details
            .map((detail: any) => (typeof detail?.text === 'string' ? detail.text : ''))
            .join('')
        : ''
      const text = typeof part.reasoning === 'string' ? part.reasoning : fromDetails
      if (!text && typeof part.reasoning !== 'string') continue
      part.reasoning_content = text
      if (typeof part.reasoning === 'string') delete part.reasoning
      changed = true
    }
  }
  return changed
}

function rewriteOpenRouterSseLine(line: string): string {
  if (!line.startsWith('data: ')) return line
  const data = line.slice(6).trim()
  if (!data || data === '[DONE]') return line
  try {
    const parsed = JSON.parse(data)
    if (!rewriteOpenRouterReasoningPayload(parsed)) return line
    return `data: ${JSON.stringify(parsed)}`
  } catch {
    return line
  }
}

/**
 * Split an OpenAI-format `usage` object into non-cached input, cache-read and
 * cache-write tokens so each is billed at its own rate.
 *
 * Cache writes follow OpenRouter's convention (also emitted by
 * `anthropicUsageToOpenAI`): `prompt_tokens_details.cache_write_tokens` is
 * counted inside both `prompt_tokens` and `cached_tokens`. This must parse
 * the same way as the runtime's pi-ai OpenAI-completions parser so billing
 * and the runtime's reported turn usage agree.
 */
export function splitOpenAIPromptUsage(usage: any): {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
} {
  const totalPrompt = usage?.prompt_tokens || 0
  const reportedCached =
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.prompt_cache_hit_tokens ??
    0
  const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens || 0
  const cachedInputTokens = Math.max(0, reportedCached - cacheWriteTokens)
  const inputTokens =
    usage?.prompt_cache_miss_tokens ??
    Math.max(0, totalPrompt - cachedInputTokens - cacheWriteTokens)
  return { inputTokens, cachedInputTokens, cacheWriteTokens }
}

/**
 * Proxy a streaming request to an OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio).
 */
export async function proxyOpenAIStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig,
  onComplete?: (
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
    reasoningTokens: number,
    cacheWriteTokens: number,
  ) => void,
  signal?: AbortSignal,
): Promise<Response> {
  const { response, served } = await fetchOpenAICompatible(request, apiKey, modelConfig, {
    stream: true,
    stream_options: { include_usage: true },
  }, signal)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`${served.provider} API error (${response.status}): ${errorText}`)
  }

  const rewriteReasoning = shouldRewriteOpenRouterReasoning(served)

  if (!onComplete && !rewriteReasoning) {
    return new Response(response.body, {
      headers: openAIProxyHeaders(served),
    })
  }

  // Parse SSE to extract usage from the final chunk, then call onComplete.
  // OpenRouter streams are re-chunked by line so `reasoning` can be rewritten
  // to `reasoning_content` before the client (and the capture pipeline) see it.
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let loggedOpenRouterCost = false
  let sseBuffer = ''

  const noteUsage = (parsed: any) => {
    if (!parsed?.usage) return
    const usage = parsed.usage
    ;({ inputTokens, cachedInputTokens, cacheWriteTokens } = splitOpenAIPromptUsage(usage))
    outputTokens = usage.completion_tokens || 0
    reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0
    if (rewriteReasoning && typeof usage.cost === 'number' && !loggedOpenRouterCost) {
      loggedOpenRouterCost = true
      console.log(`[AI Proxy] OpenRouter usage cost $${usage.cost} model=${served.apiModel}`)
    }
  }

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!rewriteReasoning) {
        controller.enqueue(chunk)
        sseBuffer += decoder.decode(chunk, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            noteUsage(JSON.parse(data))
          } catch {
            // Skip unparseable lines
          }
        }
        return
      }

      sseBuffer += decoder.decode(chunk, { stream: true })
      const lines = sseBuffer.split('\n')
      sseBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const rewritten = rewriteOpenRouterSseLine(line)
        if (rewritten.startsWith('data: ')) {
          const data = rewritten.slice(6).trim()
          if (data && data !== '[DONE]') {
            try {
              noteUsage(JSON.parse(data))
            } catch {
              // Skip unparseable lines
            }
          }
        }
        controller.enqueue(encoder.encode(`${rewritten}\n`))
      }
    },
    flush(controller) {
      if (rewriteReasoning && sseBuffer) {
        const rewritten = rewriteOpenRouterSseLine(sseBuffer)
        if (rewritten.startsWith('data: ')) {
          const data = rewritten.slice(6).trim()
          if (data && data !== '[DONE]') {
            try {
              noteUsage(JSON.parse(data))
            } catch {
              // Skip unparseable lines
            }
          }
        }
        controller.enqueue(encoder.encode(`${rewritten}\n`))
      }
      onComplete?.(inputTokens, outputTokens, cachedInputTokens, reasoningTokens, cacheWriteTokens)
    },
  })

  const reader = response.body!.getReader()
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
  })

  const transformed = readable.pipeThrough(transformStream)

  return new Response(transformed, {
    headers: openAIProxyHeaders(served),
  })
}

/**
 * Proxy a non-streaming request to an OpenAI-compatible endpoint.
 */
export async function proxyOpenAINonStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig,
  signal?: AbortSignal,
) {
  const { response, served } = await fetchOpenAICompatible(
    request,
    apiKey,
    modelConfig,
    { stream: false },
    signal,
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`${served.provider} API error (${response.status}): ${errorText}`)
  }

  const result = await response.json()
  if (shouldRewriteOpenRouterReasoning(served)) {
    rewriteOpenRouterReasoningPayload(result)
    if (typeof result?.usage?.cost === 'number') {
      console.log(`[AI Proxy] OpenRouter usage cost $${result.usage.cost} model=${served.apiModel}`)
    }
  }
  return result
}

// =============================================================================
// Prompt Cache Boundary Splitting
// =============================================================================

const CACHE_BOUNDARY = '<|CACHE_BOUNDARY|>'

/**
 * Split system prompt blocks at the CACHE_BOUNDARY marker so that the stable
 * prefix gets `cache_control` (enabling Anthropic prompt caching) while the
 * dynamic suffix does not. Without this, the entire system prompt is one block
 * whose cache is invalidated every turn because the dynamic content changes.
 *
 * Mutates `parsed.system` in place.
 */
function splitSystemBlocksForCaching(parsed: any): void {
  if (!parsed.system || !Array.isArray(parsed.system)) return
  const newSystem: any[] = []
  for (const block of parsed.system) {
    if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.includes(CACHE_BOUNDARY)) {
      newSystem.push(block)
      continue
    }
    const idx = block.text.indexOf(CACHE_BOUNDARY)
    const stableText = block.text.slice(0, idx).trimEnd()
    const dynamicText = block.text.slice(idx + CACHE_BOUNDARY.length).trimStart()
    if (stableText) {
      newSystem.push({ type: 'text', text: stableText, cache_control: block.cache_control || { type: 'ephemeral' } })
    }
    if (dynamicText) {
      newSystem.push({ type: 'text', text: dynamicText })
    }
  }
  parsed.system = newSystem
}

/** Map a budget-based thinking allocation to an adaptive effort bucket. */
function budgetTokensToEffort(budgetTokens: number | undefined): 'low' | 'medium' | 'high' {
  if (!budgetTokens || budgetTokens < 4096) return 'low'
  if (budgetTokens < 16000) return 'medium'
  return 'high'
}

/**
 * Normalize the thinking config for the resolved upstream model.
 *
 * Two distinct problems, both rooted in the agent-runtime addressing DB-defined
 * models by an opaque UUID (so pi-ai can't substring-match the id against its
 * adaptive-thinking allowlist):
 *
 *  1. Legacy shape rejected. When pi-ai treats the model as non-adaptive it
 *     emits the budget-based `thinking.type: "enabled"` block, which Opus
 *     4.6+/Sonnet 4.6 reject with a 400 ("thinking.type.enabled is not
 *     supported for this model"). We rewrite it to `type: "adaptive"` +
 *     `output_config.effort`.
 *
 *  2. Thinking invisible. When an adaptive block arrives *without* a `display`
 *     field, Opus 4.7/4.8 (and Mythos) default `display` to `"omitted"` — the
 *     model still thinks (and bills) but returns empty thinking blocks, so the
 *     client shows no reasoning. Opus 4.6 / Sonnet 4.6 default to `"summarized"`
 *     so they look fine, which is why the symptom is Opus-only. We default the
 *     display to `"summarized"` so reasoning is surfaced, matching the product's
 *     pre-adaptive behavior. An explicit `display` (incl. `"omitted"`) is
 *     respected.
 *
 * Since the proxy is the boundary that knows the real `apiModel`, both fixes
 * live here. Idempotent. Mutates `parsed` in place.
 */
function normalizeThinkingForModel(parsed: any, apiModel: string): void {
  const thinking = parsed?.thinking
  if (!thinking || typeof thinking !== 'object') return
  if (!supportsAdaptiveThinking(apiModel)) return

  if (thinking.type === 'enabled') {
    const effort = budgetTokensToEffort(thinking.budget_tokens)
    parsed.thinking = {
      type: 'adaptive',
      display: thinking.display ?? 'summarized',
    }
    parsed.output_config = { ...(parsed.output_config ?? {}), effort }
    return
  }

  if (thinking.type === 'adaptive') {
    // Surface summarized reasoning unless the caller explicitly chose a mode.
    // Without this, Opus 4.7/4.8 omit thinking content by default.
    if (thinking.display === undefined) {
      parsed.thinking = { ...thinking, display: 'summarized' }
    }
  }
}

// =============================================================================
// Billing
// =============================================================================

import { calculateUsageCost, proxyModelToBillingModel, getModelTier } from '../lib/usage-cost'
import * as billingService from '../services/billing-runtime'
import { getProjectUser } from '../lib/project-user-context'
import { accumulateUsage, accumulateImageUsage, accumulateVideoUsage, accumulate3dUsage, hasActiveSession } from '../lib/proxy-billing-session-runtime'
import { isShogoCloudForwarding } from '../lib/cloud-forwarding'
import { buildUsageLimitInfo } from '../lib/usage-limit-info'
import { invalidateAnalyticsCache } from '../lib/analytics-cache'
export { buildUsageLimitInfo }

/**
 * Record token usage for billing.
 *
 * If there's an active billing session for this project (opened by
 * project-chat or /api/chat), tokens are accumulated and charged once
 * when the session closes. Otherwise, charge immediately per-call.
 *
 * `chatSessionId` should be the value of the `X-Chat-Session-Id` header
 * the runtime forwards on each outbound call. It scopes the session
 * lookup to `(projectId, chatSessionId)` so concurrent turns on the
 * same project bill independently. When omitted the legacy
 * projectId-only key is used (back-compat with older runtimes).
 */
/**
 * Header a server-initiated request sets to mark a completion as internal +
 * non-billable (recorded for admin cost-tracking only). See `resolveInternalUsage`.
 */
const INTERNAL_USAGE_TAG_HEADER = 'x-shogo-usage-tag'
/** Allowlisted internal usage tags the server may request via the header. */
const INTERNAL_USAGE_TAGS = new Set<string>(['title_generation', 'analytics_digest'])

/**
 * Sentinel `projectId` values that never correspond to a real `Project` row:
 * - `'api-key'` — workspace-scoped Shogo API key auth (no single project).
 * - `'system'` — the API server's own internal proxy token.
 * - `'workspace'` — a workspace runtime with zero attached projects (e.g. a
 *   brand-new personal companion); see build-workspace-env.ts's fallback
 *   AI_PROXY_TOKEN mint.
 *
 * Billing/attribution code throughout this file treats all three the same
 * way: fall back to workspace-level attribution instead of a Project FK.
 */
function isNonProjectSentinel(projectId: string | undefined | null): boolean {
  return projectId === 'api-key' || projectId === 'system' || projectId === 'workspace'
}

/**
 * Runtime keys whose idle clocks a model call from this token should reset.
 * Workspace runtimes are keyed `ws:<workspaceId>` and carry either the
 * 'workspace' sentinel or their first attached project's token, so the
 * project key alone never reaches them.
 */
export function runtimeTouchKeys(payload: ProxyTokenPayload | null): string[] {
  if (!payload?.projectId || payload.projectId === 'api-key' || payload.projectId === 'system') return []
  const keys: string[] = []
  if (payload.workspaceId) keys.push(`ws:${payload.workspaceId}`)
  if (!isNonProjectSentinel(payload.projectId)) keys.push(payload.projectId)
  return keys
}

/**
 * Resolve the internal (non-billable) usage tag for a request, if any.
 *
 * Security: only the server's own proxy-JWT (`authKind === 'proxy-jwt'`) is
 * trusted to mark a completion non-billable. Workspace API keys (`api-key`) and
 * per-project pod runtime tokens (`runtime`) MUST NOT be able to dodge billing
 * by setting this header, so they're rejected here.
 */
function resolveInternalUsage(c: any, tokenPayload: ProxyTokenPayload): { actionType: string } | null {
  if (tokenPayload.authKind !== 'proxy-jwt') return null
  const tag = c.req.header(INTERNAL_USAGE_TAG_HEADER)
  if (tag && INTERNAL_USAGE_TAGS.has(tag)) return { actionType: tag }
  return null
}

/**
 * Whether this proxied call belongs to an already-admitted chat turn that is
 * still in flight (a billing session is open for it).
 *
 * A chat turn is gated for usage exactly once, at turn start
 * (project-chat / workspace-chat). It then makes up to AGENT_MAX_ITERATIONS
 * proxied LLM/image calls. Re-running the 402 usage pre-flight on every one of
 * those would drop a long build halfway ("model did not produce a final answer
 * after tool execution"). When a session is open the turn already passed the
 * start gate, so the per-call pre-flight is skipped and the message is allowed
 * to finish; the overage is billed at session close and gates the NEXT turn.
 *
 * Resolves the billing project id the same way `recordUsage` does (the
 * `'api-key'` / `'system'` / `'workspace'` sentinels are not real projects
 * and never carry a chat billing session), and keys the lookup on the forwarded
 * `x-chat-session-id` header when present.
 */
async function isTurnInFlight(c: any, tokenPayload: ProxyTokenPayload): Promise<boolean> {
  const billingProjectId = isNonProjectSentinel(tokenPayload.projectId)
    ? null
    : (tokenPayload.projectId || null)
  if (!billingProjectId) return false
  return hasActiveSession(billingProjectId, c.req.header('x-chat-session-id') || null)
}

export async function recordUsage(
  tokenPayload: ProxyTokenPayload,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
  chatSessionId?: string | null,
  internalUsage?: { actionType: string } | null,
  reasoningTokens: number = 0,
) {
  // For API-key auth the projectId is a sentinel ('api-key'), the API
  // server's own internal proxy token uses 'system', and a project-less
  // workspace runtime's fallback token uses 'workspace' — none of these are
  // a real Project row. Pass null so the UsageEvent projectId FK is satisfied.
  const billingProjectId = isNonProjectSentinel(tokenPayload.projectId)
    ? null
    : (tokenPayload.projectId || null)

  // Internal, non-billable completion (e.g. server-initiated title generation):
  // record the real cost for ADMIN cost-tracking only — never debit a wallet,
  // never accumulate into a billing session. The dedicated `actionType` keeps it
  // out of the user-facing usage log/summary (which whitelist only
  // `ai_proxy_completion` / `chat_message` / `voice_*`), while admin analytics
  // (`getUsageAnalytics`, scoped by action type) still see it.
  if (internalUsage) {
    const totalTokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
    if (totalTokens === 0) return
    try {
      // The server's internal token attributes usage to the `system` sentinel
      // workspace, which must exist as a real row for this UsageEvent to satisfy
      // its workspaceId FK. Ensure it (idempotent, memoized) before recording.
      if (tokenPayload.workspaceId === billingService.SYSTEM_WORKSPACE_ID) {
        await billingService.ensureSystemWorkspace()
      }
      const billingModel = proxyModelToBillingModel(model)
      const { rawUsd, pricingUnknown } = calculateUsageCost(inputTokens, outputTokens, model, cachedInputTokens, cacheWriteTokens)
      const billingUserId = getProjectUser(tokenPayload.projectId) || tokenPayload.userId || 'system'
      await prisma.usageEvent.create({
        data: {
          workspaceId: tokenPayload.workspaceId,
          projectId: billingProjectId,
          memberId: billingUserId,
          actionType: internalUsage.actionType,
          rawUsd,
          billedUsd: 0,
          source: 'daily',
          balanceBefore: 0,
          balanceAfter: 0,
          actionMetadata: { model, billingModel, rawUsd, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens, totalTokens, internal: true, billable: false, ...(pricingUnknown ? { pricingUnknown } : {}) },
        },
      })
      console.log(`[AI Proxy] 🗒️ Recorded internal '${internalUsage.actionType}' usage (raw $${rawUsd.toFixed(4)}, ${totalTokens} tokens, model: ${billingModel}) — not billed`)
      invalidateAnalyticsCache({ workspaceId: tokenPayload.workspaceId, projectId: billingProjectId ?? undefined })
    } catch (err) {
      console.error('[AI Proxy] Failed to record internal usage:', err)
    }
    return
  }

  // If a billing session is open, accumulate — the session closer will charge
  if (billingProjectId && await accumulateUsage(billingProjectId, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, chatSessionId, reasoningTokens)) {
    const totalTokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
    // Per-request cache breakdown — same gate as the agent-runtime cache-debug
    // logs so a single env flag turns the whole picture on. This is the
    // authoritative signal for cache health; the agent-runtime fingerprint
    // tells us WHAT the prefix looked like, this tells us whether Anthropic
    // actually read the cache for that prefix.
    console.log(`[AI Proxy] 📊 Accumulated ${totalTokens} tokens for session (project: ${billingProjectId}${chatSessionId ? `, chat: ${chatSessionId}` : ''})`)
    return
  }

  // No billing session — charge immediately (direct proxy usage)
  const totalTokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
  if (totalTokens === 0) return

  try {
    const billingModel = proxyModelToBillingModel(model)
    // Bill on the real model id so `calculateUsageCost` can apply a DB-defined
    // model's own per-token pricing (custom providers / admin-added models).
    // Passing the collapsed `billingModel` bucket here billed every DB model at
    // the `sonnet` fallback rate. `billingModel` is kept only for display.
    const { rawUsd, billedUsd, pricingUnknown } = calculateUsageCost(inputTokens, outputTokens, model, cachedInputTokens, cacheWriteTokens)
    const billingUserId = getProjectUser(tokenPayload.projectId) || tokenPayload.userId || 'system'
    if (billingUserId === 'system') {
      console.warn(`[AI Proxy] ⚠️ No real userId for project ${tokenPayload.projectId} — billing as 'system'. Token userId: ${tokenPayload.userId}`)
    }

    const result = await billingService.consumeUsage({
      workspaceId: tokenPayload.workspaceId,
      projectId: billingProjectId,
      memberId: billingUserId,
      actionType: 'ai_proxy_completion',
      rawUsd,
      billedUsd,
      actionMetadata: { model, billingModel, rawUsd, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens, totalTokens, ...(pricingUnknown ? { pricingUnknown } : {}) },
    })

    if (result.success) {
      console.log(`[AI Proxy] 💰 Charged $${billedUsd.toFixed(4)} (raw $${rawUsd.toFixed(4)}) — ${inputTokens} in, ${cacheWriteTokens} cache-write, ${cachedInputTokens} cache-read, ${outputTokens} out (${totalTokens} total, model: ${billingModel}) — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`)
    } else {
      console.warn(`[AI Proxy] ⚠️ Could not charge usage: ${result.error}`)
    }
  } catch (err) {
    console.error('[AI Proxy] Failed to charge usage:', err)
  }
}

// =============================================================================
// Image Generation
// =============================================================================

interface ImageModelConfig {
  provider: ImageProvider
  apiModel: string
  displayName: string
  /** Catalog entry; absent for the env-configured local model. */
  entry?: ImageModelEntry
}

interface ImageGenerationResponse {
  created: number
  data: Array<{ b64_json?: string; url?: string; revised_prompt?: string; content_type?: string }>
}

const IMAGE_MODEL_REGISTRY: Record<string, ImageModelConfig> = {}

for (const entry of Object.values(IMAGE_MODEL_CATALOG) as ImageModelEntry[]) {
  IMAGE_MODEL_REGISTRY[entry.id] = {
    provider: entry.provider,
    apiModel: entry.apiModel,
    displayName: entry.displayName,
    entry,
  }
}

function resolveImageModel(model: string): ImageModelConfig | null {
  if (IMAGE_MODEL_REGISTRY[model]) return IMAGE_MODEL_REGISTRY[model]

  for (const [key, config] of Object.entries(IMAGE_MODEL_REGISTRY)) {
    if (key.startsWith(model) || config.apiModel.startsWith(model)) return config
  }

  const localBaseUrl = process.env.LOCAL_IMAGE_GEN_BASE_URL
  if (localBaseUrl && (model === 'local' || model === process.env.LOCAL_IMAGE_GEN_MODEL)) {
    return { provider: 'local', apiModel: model, displayName: 'Local Image Model' }
  }

  return null
}

function getImageProviderApiKey(provider: ImageProvider): string | null {
  switch (provider) {
    case 'openai': return getNativeProviderApiKeySync('openai')
    case 'google': return getNativeProviderApiKeySync('google')
    case 'higgsfield': return getNativeProviderApiKeySync('higgsfield')
    case 'local': return 'local'
    default: return null
  }
}

/**
 * `quality` is a shared tool-level param ("standard" | "hd") modeled on
 * dall-e-3, but GPT image models (gpt-image-1, gpt-image-1.5, ...) only
 * accept "low" | "medium" | "high" | "auto" and 400 on "standard"/"hd" with
 * `Invalid value: 'standard'. Supported values are: 'low', 'medium', 'high', and 'auto'.`
 * Map the dall-e-3 vocabulary onto the nearest GPT image equivalent instead
 * of forwarding it verbatim.
 */
export function normalizeQualityForModel(model: string, quality?: string): string | undefined {
  if (!quality) return undefined
  if (!model.startsWith('gpt-image')) return quality
  if (quality === 'standard') return 'medium'
  if (quality === 'hd') return 'high'
  return quality
}

/**
 * dall-e-3's portrait/landscape sizes ("1024x1792" / "1792x1024" — the ones
 * our `generate_image` tool schema documents) aren't valid for GPT image
 * models, which use "1024x1536" / "1536x1024" instead. Map onto the nearest
 * equivalent rather than forwarding a size the model will reject.
 */
export function normalizeSizeForModel(model: string, size: string): string {
  if (!model.startsWith('gpt-image')) return size
  if (size === '1024x1792') return '1024x1536'
  if (size === '1792x1024') return '1536x1024'
  return size
}

const HIGGSFIELD_IMAGE_POLL_DEADLINE_MS = 5 * 60_000

/**
 * Charge for one Higgsfield request: the estimate captured at submit, marked
 * up. Returns `null` when no estimate came back — the caller then refuses the
 * request instead of running it unpriced, because a catalog guess is off by up
 * to 23× and "no price" must never mean "free".
 */
function higgsfieldCharge(
  estimateRawUsd: number | null,
): { rawUsd: number; billedUsd: number } | null {
  if (estimateRawUsd === null) return null
  return calculateHiggsfieldUsageCost({ rawUsd: estimateRawUsd })
}

function recordHiggsfieldImageUsage(
  tokenPayload: ProxyTokenPayload,
  entry: ImageModelEntry,
  charge: { rawUsd: number; billedUsd: number },
  n: number,
  chatSessionId?: string | null,
) {
  return recordMediaUsage(tokenPayload, {
    kind: 'image',
    model: entry.id,
    rawUsd: charge.rawUsd,
    billedUsd: charge.billedUsd,
    actionType: 'ai_image_generation',
    metadata: { n, provider: 'higgsfield', priceSource: 'estimate' },
  }, chatSessionId)
}

/**
 * Run a Higgsfield image model: price it, submit one request per output image,
 * poll each to a terminal state, then download the outputs. Pricing happens
 * *before* submitting, so a model whose price we cannot get never runs. A
 * `failed`, `nsfw` or `canceled` request surfaces a readable error and is never
 * billed.
 */
async function generateImageHiggsfield(
  apiKey: string,
  entry: ImageModelEntry,
  params: {
    prompt: string
    size?: string
    quality?: string
    n?: number
    referenceImages?: string[]
    options?: Record<string, unknown>
  },
  signal?: AbortSignal,
): Promise<{ result: ImageGenerationResponse; charge: { rawUsd: number; billedUsd: number } }> {
  const n = Math.max(1, Math.min(4, params.n || 1))
  const referenceUrls = await Promise.all(
    (params.referenceImages ?? []).map((ref) => higgsfieldEnsurePublicUrl(apiKey, ref, signal)),
  )
  const request = buildHiggsfieldImageRequest(entry, {
    prompt: params.prompt,
    size: params.size,
    quality: params.quality,
    referenceUrls,
    options: params.options,
  })

  const estimate = await higgsfieldEstimate(apiKey, request.endpoint, request.input, signal).catch((err) => {
    throw new HiggsfieldError(
      `Could not get a price for this image (${err?.message ?? 'no estimate'}). Nothing was generated or charged; try again.`,
      'unavailable',
    )
  })
  const charge = higgsfieldCharge(estimate.rawUsd * n)
  if (!charge) {
    throw new HiggsfieldError('Higgsfield returned no price for this image. Nothing was generated or charged; try again.', 'unavailable')
  }

  const submissions = await Promise.all(
    Array.from({ length: n }, () =>
      higgsfieldSubmit(apiKey, request.endpoint, request.input, {
        idempotencyKey: `img_${randomUUID()}`,
        signal,
      }),
    ),
  )

  let settled: Awaited<ReturnType<typeof pollHiggsfieldRequest>>[]
  try {
    settled = await Promise.all(
      submissions.map((submission) =>
        pollHiggsfieldRequest(apiKey, submission.statusUrl, {
          deadlineMs: Date.now() + HIGGSFIELD_IMAGE_POLL_DEADLINE_MS,
          signal,
        }),
      ),
    )
  } catch (err) {
    // The caller went away mid-render: cancel upstream so we don't pay for an
    // image nobody is waiting for. Best effort — a started request may refuse.
    if (signal?.aborted) {
      await Promise.allSettled(submissions.map((submission) => higgsfieldCancel(apiKey, submission.requestId)))
    }
    throw err
  }

  const failed = settled.find((outcome) => outcome.status !== 'completed')
  if (failed) {
    const reason = failed.error ?? `the request ended ${failed.status}`
    throw new HiggsfieldError(`Image generation failed: ${reason}`, 'validation')
  }

  const urls = settled.flatMap((outcome) => outcome.imageUrls)
  if (urls.length === 0) throw new HiggsfieldError('Higgsfield returned no images', 'http')

  const data = await Promise.all(
    urls.map(async (url) => {
      const { b64, contentType } = await fetchAsBase64(url, signal)
      return { b64_json: b64, revised_prompt: params.prompt, content_type: contentType }
    }),
  )

  return {
    result: { created: Math.floor(Date.now() / 1000), data },
    charge,
  }
}

async function generateImageOpenAI(
  apiKey: string,
  model: string,
  params: { prompt: string; size?: string; quality?: string; n?: number },
  signal?: AbortSignal,
): Promise<ImageGenerationResponse> {
  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    size: normalizeSizeForModel(model, params.size || '1024x1024'),
    n: params.n || 1,
  }
  // GPT image models (gpt-image-1, gpt-image-1.5, ...) always return
  // base64-encoded images and reject `response_format` outright with
  // "Unknown parameter: 'response_format'" (400). Only dall-e-2/dall-e-3
  // support (and need) this parameter to get b64_json instead of a URL.
  if (!model.startsWith('gpt-image')) body.response_format = 'b64_json'
  const quality = normalizeQualityForModel(model, params.quality)
  if (quality) body.quality = quality

  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI image generation error (${response.status}): ${errorText}`)
  }

  return await response.json() as ImageGenerationResponse
}

async function generateImageGoogle(
  apiKey: string,
  model: string,
  params: { prompt: string; size?: string; n?: number },
  signal?: AbortSignal,
): Promise<ImageGenerationResponse> {
  const sizeToAspect: Record<string, string> = {
    '1024x1024': '1:1',
    '1024x1792': '9:16',
    '1792x1024': '16:9',
    '1536x1024': '3:2',
    '1024x1536': '2:3',
  }

  const body = {
    instances: [{ prompt: params.prompt }],
    parameters: {
      sampleCount: params.n || 1,
      aspectRatio: sizeToAspect[params.size || '1024x1024'] || '1:1',
    },
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal,
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Google Imagen error (${response.status}): ${errorText}`)
  }

  const googleResult = await response.json() as {
    predictions?: Array<{ bytesBase64Encoded: string; mimeType?: string }>
  }

  return {
    created: Math.floor(Date.now() / 1000),
    data: (googleResult.predictions || []).map(p => ({
      b64_json: p.bytesBase64Encoded,
      revised_prompt: params.prompt,
    })),
  }
}

async function generateImageLocal(
  _model: string,
  params: { prompt: string; size?: string; quality?: string; n?: number },
  signal?: AbortSignal,
): Promise<ImageGenerationResponse> {
  const baseUrl = process.env.LOCAL_IMAGE_GEN_BASE_URL
  if (!baseUrl) throw new Error('LOCAL_IMAGE_GEN_BASE_URL is not configured')

  const localModel = process.env.LOCAL_IMAGE_GEN_MODEL || _model
  const body: Record<string, unknown> = {
    model: localModel,
    prompt: params.prompt,
    size: params.size || '1024x1024',
    n: params.n || 1,
    response_format: 'b64_json',
  }
  if (params.quality) body.quality = params.quality

  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Local image generation error (${response.status}): ${errorText}`)
  }

  return await response.json() as ImageGenerationResponse
}

import {
  calculateGenjutsuUsageCost,
  calculateHiggsfieldUsageCost,
  calculateImageUsageCost,
  calculateTranscriptionUsageCost,
  calculate3dUsageCost,
  estimateTripoTaskCost,
  TRIPO_USD_PER_CREDIT,
} from '../lib/usage-cost'
import {
  HiggsfieldError,
  HIGGSFIELD_UPLOAD_CONTENT_TYPES,
  buildHiggsfieldEstimateBody,
  buildHiggsfieldImageRequest,
  buildHiggsfieldVideoRequest,
  fetchAsBase64,
  higgsfieldEnsurePublicUrl,
  higgsfieldEstimate,
  higgsfieldCancel,
  higgsfieldPresets,
  higgsfieldStatus,
  higgsfieldSubmit,
  higgsfieldUpload,
  pollHiggsfieldRequest,
  parseHiggsfieldEstimate,
  type HiggsfieldEstimate,
} from '../lib/higgsfield-media'

/**
 * One billable media output. Images fold into the open billing session's image
 * totals; video folds into its video totals; 3D folds into its own. With no
 * session open, it is charged as its own usage event.
 */
interface MediaCharge {
  kind: 'image' | 'video' | '3d'
  model: string
  rawUsd: number
  billedUsd: number
  /** Output seconds (video only). */
  seconds?: number
  actionType: 'ai_image_generation' | 'ai_video_generation' | 'ai_3d_generation'
  metadata: Record<string, unknown>
}

async function recordMediaUsage(tokenPayload: ProxyTokenPayload, charge: MediaCharge, chatSessionId?: string | null) {
  const { kind, model, rawUsd, billedUsd } = charge
  try {
    if (billedUsd === 0) return

    const billingProjectId = isNonProjectSentinel(tokenPayload.projectId)
      ? null
      : (tokenPayload.projectId || null)
    const billingUserId = getProjectUser(tokenPayload.projectId) || tokenPayload.userId || 'system'

    // If a billing session is open for this project, fold the USD into the
    // session so the chat turn produces a single `chat_message` wallet debit
    // instead of an extra per-media row.
    if (billingProjectId) {
      const accumulated = kind === 'video'
        ? await accumulateVideoUsage(billingProjectId, charge.seconds ?? 0, rawUsd, billedUsd, chatSessionId)
        : kind === '3d'
          ? await accumulate3dUsage(billingProjectId, rawUsd, billedUsd, chatSessionId)
          : await accumulateImageUsage(billingProjectId, model, rawUsd, billedUsd, chatSessionId)
      if (accumulated) {
        console.log(`[AI Proxy] 🎨 Accumulated ${charge.actionType} for session ($${billedUsd.toFixed(4)}, model: ${model}, project: ${billingProjectId}${chatSessionId ? `, chat: ${chatSessionId}` : ''})`)
        return
      }
    }

    const result = await billingService.consumeUsage({
      workspaceId: tokenPayload.workspaceId,
      projectId: billingProjectId,
      memberId: billingUserId,
      actionType: charge.actionType,
      rawUsd,
      billedUsd,
      actionMetadata: { model, ...charge.metadata, rawUsd },
    })

    if (result.success) {
      console.log(`[AI Proxy] 🎨 Charged $${billedUsd.toFixed(4)} (${charge.actionType}, model: ${model}) — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`)
    } else {
      console.warn(`[AI Proxy] ⚠️ Could not charge ${kind} usage: ${result.error}`)
    }
  } catch (err) {
    console.error(`[AI Proxy] Failed to charge ${kind} usage:`, err)
  }
}

function recordImageUsage(
  tokenPayload: ProxyTokenPayload,
  model: string,
  quality: string,
  size: string,
  n: number,
  chatSessionId?: string | null,
) {
  const single = calculateImageUsageCost(model, quality, size)
  return recordMediaUsage(tokenPayload, {
    kind: 'image',
    model,
    rawUsd: single.rawUsd * n,
    billedUsd: single.billedUsd * n,
    actionType: 'ai_image_generation',
    metadata: { quality, size, n },
  }, chatSessionId)
}

const DEFAULT_VIDEO_MODEL = 'hf-hailuo-2.3'

/** Video is Higgsfield-only; a server without its key answers 503 provider_not_configured. */
function defaultVideoModel(): string {
  return DEFAULT_VIDEO_MODEL
}

const DEFAULT_IMAGE_MODEL = 'hf-soul-v2'
const FALLBACK_IMAGE_MODEL = 'gpt-image-2.5-flare'

/** Higgsfield when its key is configured (the product default), else OpenAI. */
function defaultImageModel(): string {
  return getImageProviderApiKey('higgsfield') ? DEFAULT_IMAGE_MODEL : FALLBACK_IMAGE_MODEL
}

/** `genjutsu` workflow → model, so a caller can name the edit instead of the model id. */
const GENJUTSU_MODEL_BY_WORKFLOW: Record<string, string> = {
  motion_transfer: 'hf-genjutsu-motion-transfer',
  object_swap: 'hf-genjutsu-object-swap',
  restyle: 'hf-genjutsu-restyle',
}

function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000
}

/** HTTP status for a media failure: Higgsfield's own semantics first, then the legacy string match. */
type MediaErrorStatus = 400 | 402 | 429 | 502 | 503 | 504

function mediaErrorStatus(error: any): MediaErrorStatus | 0 {
  if (error instanceof HiggsfieldError) {
    switch (error.code) {
      case 'provider_busy': return 429
      case 'credits': return 402
      case 'validation':
      case 'invalid_option':
      case 'option_unsupported':
      case 'invalid_duration':
      case 'invalid_resolution':
      case 'invalid_aspect_ratio':
      case 'audio_not_supported':
      case 'image_to_video_unsupported':
      case 'text_to_video_unsupported':
      case 'reference_images_unsupported':
        return 400
      case 'auth': case 'blocked': case 'unavailable': return 503
      case 'timeout': return 504
      default: return 502
    }
  }
  if (error?.message?.includes('429')) return 429
  if (error?.message?.includes('503')) return 503
  return 0
}

/**
 * `3–15` for a contiguous range, `6, 10` for a menu. Kling 3.0 documents 3–15 s
 * as thirteen values, and listing them all reads worse than the range.
 */
function describeDurationMenu(durations: readonly number[]): string {
  if (durations.length === 0) return '(none)'
  const contiguous = durations.every((value, index) => index === 0 || value === durations[index - 1] + 1)
  return contiguous && durations.length > 2
    ? `${durations[0]}–${durations[durations.length - 1]}`
    : durations.join(', ')
}

/** Error code for the OpenAI-shaped error body. */
function mediaErrorCode(error: any, fallback: string): string {
  return error instanceof HiggsfieldError ? error.code : fallback
}

/**
 * Free `/estimate` lookups backing the listing's per-clip prices. Higgsfield
 * prices per request and the amount depends on parameters, so the catalog's
 * list price is only a fallback; the estimates are cached (they cost nothing
 * but are still a round trip) and a failure degrades to the catalog value.
 */
const higgsfieldEstimateCache = new Map<string, { value: HiggsfieldEstimate | null; expiresAt: number }>()
const HIGGSFIELD_LIST_ESTIMATE_TTL_MS = 10 * 60_000

async function cachedHiggsfieldEstimate(
  apiKey: string,
  entry: ImageModelEntry | VideoModelEntry,
  request: { endpoint: string; input: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<HiggsfieldEstimate | null> {
  const key = `${entry.id}:${JSON.stringify(request.input)}`
  const hit = higgsfieldEstimateCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const body = buildHiggsfieldEstimateBody(entry, request.input)
  if (!body) return null
  let value: HiggsfieldEstimate | null = null
  try {
    value = await higgsfieldEstimate(apiKey, request.endpoint, body, signal)
  } catch {
    value = null
  }
  higgsfieldEstimateCache.set(key, { value, expiresAt: Date.now() + HIGGSFIELD_LIST_ESTIMATE_TTL_MS })
  return value
}

/** Test seam — drops cached estimates between cases. */
export const _resetHiggsfieldEstimateCache = () => higgsfieldEstimateCache.clear()

/** JSON view of one documented option field, as `list_media_models` shows it. */
function publicOption(field: ModelOptionField): Record<string, unknown> {
  return {
    name: field.name,
    type: field.type,
    ...(field.required ? { required: true } : {}),
    ...(field.enum ? { values: field.enum } : {}),
    ...(field.minimum !== undefined ? { min: field.minimum } : {}),
    ...(field.maximum !== undefined ? { max: field.maximum } : {}),
    ...(field.multipleOf !== undefined ? { multiple_of: field.multipleOf } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
    ...(field.title ? { title: field.title } : {}),
    ...(field.items ? { items: field.items } : {}),
    ...(field.minItems !== undefined ? { min_items: field.minItems } : {}),
    ...(field.maxItems !== undefined ? { max_items: field.maxItems } : {}),
    ...(field.maxLength !== undefined ? { max_length: field.maxLength } : {}),
    ...(field.itemFields
      ? { item_fields: Object.values(field.itemFields).map((nested) => publicOption(nested)) }
      : {}),
    ...(field.endpoints ? { endpoints: field.endpoints } : {}),
  }
}

/**
 * Response body of `GET /ai/v1/media/models`. Exported for tests.
 *
 * `model` narrows the answer to one model's full option list, which is what an
 * agent needs before filling in a call; without it every model is listed with
 * its options, endpoints and price.
 */
export async function listMediaModels(
  signal?: AbortSignal,
  filter: { model?: string; kind?: 'image' | 'video' } = {},
) {
  const higgsfieldKey = getImageProviderApiKey('higgsfield')
  const wanted = filter.model ? resolveMediaModelId(filter.model) : undefined

  const images = filter.kind === 'video'
    ? []
    : await mapWithLimit(
        (Object.values(IMAGE_MODEL_CATALOG) as ImageModelEntry[])
          .filter((entry) => !entry.retired && !!getImageProviderApiKey(entry.provider))
          .filter((entry) => !wanted || entry.id === wanted),
        4,
        async (entry) => {
          const options = mergeModelOptions(entry)
          const base = {
            id: entry.id,
            name: entry.displayName,
            provider: entry.provider,
            best_for: entry.bestFor,
            text_to_image: entry.capabilities.textToImage,
            image_to_image: entry.capabilities.imageToImage,
            max_reference_images: entry.capabilities.maxReferenceImages,
            endpoints: endpointsOf(entry),
            ...(entry.referenceField ? { reference_field: entry.referenceField.name } : {}),
            options: options.map(publicOption),
            parameters: {
              size: entry.provider === 'openai'
                ? '1024x1024, 1024x1792, 1792x1024'
                : 'any WxH; mapped to the closest supported aspect ratio',
              quality: ['standard', 'hd'],
              options: '1-4',
            },
            ...(entry.deprecated ? { deprecated: true, replacement: entry.replacement } : {}),
          }
          if (entry.provider === 'higgsfield' && higgsfieldKey) {
            // A catalog entry whose request shape is unknown (or whose estimate
            // throws) must never blank the whole listing: one bad model falls back
            // to its catalog price and the other seventeen still list.
            let request: { endpoint: string; input: Record<string, unknown> } | null = null
            try {
              request = buildHiggsfieldImageRequest(entry, { prompt: 'a product photo on a plain background', size: '1024x1024', quality: 'standard' })
            } catch (error) {
              console.warn(`[AI Proxy] No image request shape for ${entry.id}; listing it from its catalog price only:`, error)
            }
            const estimate = request
              ? await cachedHiggsfieldEstimate(higgsfieldKey, entry, request, signal)
              : null
            const rawUsd = estimate?.rawUsd ?? entry.usdPerRequest
            return {
              ...base,
              price: {
                unit: 'image',
                usd: rawUsd !== undefined ? roundUsd(calculateHiggsfieldUsageCost({ rawUsd }).billedUsd) : null,
                source: estimate?.rawUsd !== undefined ? 'estimate' : rawUsd !== undefined ? 'catalog' : 'unknown',
              },
            }
          }
          // The price ladder is model × quality × size, so publish the marked-up
          // numbers an agent needs to budget: `usd`/`hd_usd`/`low_usd` at 1024²
          // (the keys agents already read) plus the standard price per size.
          const priceAt = (quality: string, size: string) =>
            roundUsd(calculateImageUsageCost(entry.id, quality, size).billedUsd)
          return {
            ...base,
            price: {
              unit: 'image',
              usd: priceAt('standard', '1024x1024'),
              hd_usd: priceAt('hd', '1024x1024'),
              low_usd: priceAt('low', '1024x1024'),
              usd_by_size: {
                '1024x1024': priceAt('standard', '1024x1024'),
                '1024x1536': priceAt('standard', '1024x1536'),
                '1536x1024': priceAt('standard', '1536x1024'),
              },
            },
          }
        },
      )

  const videoEntries = (Object.values(VIDEO_MODEL_CATALOG) as VideoModelEntry[])
    .filter((entry) => !!getImageProviderApiKey(entry.provider))
    .filter((entry) => !wanted || entry.id === wanted)
  const videos = filter.kind === 'image'
    ? []
    : await mapWithLimit(videoEntries, 4, async (entry) => {
      const base = {
        id: entry.id,
        name: entry.displayName,
        provider: entry.provider,
        best_for: entry.bestFor,
        text_to_video: !!entry.textToVideoApiModel,
        image_to_video: !!entry.imageToVideoApiModel,
        source_video: !!entry.sourceVideo,
        max_reference_images: entry.maxReferenceImages,
        audio: !!entry.audio,
        endpoints: endpointsOf(entry),
        options: mergeModelOptions(entry).map(publicOption),
        parameters: {
          durations: entry.durations,
          default_duration: entry.defaultDuration,
          aspect_ratios: entry.aspectRatios,
          ...(entry.resolutions ? { resolutions: entry.resolutions, default_resolution: entry.defaultResolution } : {}),
          ...(entry.sourceVideo
            ? { source_video: `workspace .mp4, ${entry.minSourceSeconds ?? 4}–${entry.maxSourceSeconds ?? 30} s` }
            : {}),
          ...(entry.genjutsu === 'restyle' ? { preset_id: 'required (see presets)' } : {}),
        },
        ...(entry.deprecated ? { deprecated: true, replacement: entry.replacement } : {}),
      }
      if (entry.provider === 'higgsfield' && higgsfieldKey) {
        // Genjutsu bills per source second, so its price is a rate, not a clip
        // total: show the marked-up per-second rate for each resolution.
        if (entry.usdPerSecondByResolution) {
          const byResolution: Record<string, number> = {}
          for (const resolution of Object.keys(entry.usdPerSecondByResolution).sort()) {
            const rate = calculateGenjutsuUsageCost(entry.usdPerSecondByResolution, resolution, 1)
            if (rate) byResolution[resolution] = roundUsd(rate.billedUsd)
          }
          const at = entry.defaultResolution ?? Object.keys(byResolution)[0]
          return {
            ...base,
            price: {
              unit: 'second',
              usd: byResolution[at] ?? null,
              by_resolution: byResolution,
              source: 'rate_card',
            },
          }
        }
        let request: { endpoint: string; input: Record<string, unknown> } | null = null
        // An image-to-video-only family has no text-to-video request to quote;
        // its price comes from the catalog rather than a made-up start image.
        if (entry.textToVideoApiModel) {
          try {
            request = buildHiggsfieldVideoRequest(entry, {
              prompt: 'a product rotating on a table, soft studio light',
              duration: entry.defaultDuration,
              resolution: entry.defaultResolution,
            })
          } catch (error) {
            console.warn(`[AI Proxy] No video request shape for ${entry.id}; listing it from its catalog price only:`, error)
          }
        }
        const estimate = request
          ? await cachedHiggsfieldEstimate(higgsfieldKey, entry, request, signal)
          : null
        const rawUsd = estimate?.rawUsd ?? entry.usdPerRequest
        return {
          ...base,
          price: {
            unit: 'clip',
            usd: rawUsd !== undefined ? roundUsd(calculateHiggsfieldUsageCost({ rawUsd }).billedUsd) : null,
            ...(estimate?.rawUsd !== undefined ? { default_clip_usd: roundUsd(calculateHiggsfieldUsageCost({ rawUsd: estimate.rawUsd }).billedUsd), default_duration: entry.defaultDuration } : {}),
            source: estimate ? 'estimate' : rawUsd !== undefined ? 'catalog' : 'unknown',
          },
        }
      }
      if (entry.usdPerRequest !== undefined) {
        return {
          ...base,
          price: { unit: 'clip', usd: roundUsd(calculateHiggsfieldUsageCost({ rawUsd: entry.usdPerRequest }).billedUsd) },
        }
      }
      return { ...base, price: { unit: 'clip', usd: null, source: 'unknown' } }
    })

  return {
    images,
    videos,
    currency: 'USD',
    default_image_model: defaultImageModel(),
    default_video_model: defaultVideoModel(),
    note: 'Prices include the Shogo markup and are what the workspace is charged. Higgsfield prices are quoted by its free /estimate for the default parameters; a `null` price means the vendor must be asked at submit time (Genjutsu prices depend on the source clip). Every model lists its documented options: pass model-specific ones as `options` on generate_image / generate_video.',
  }
}

/** Run `fn` over `items` with at most `limit` in flight (the vendor rate-limits bursts). */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Bill a completed Higgsfield video job exactly once, at the estimate captured
 * when it was submitted. `failed` / `nsfw` / `canceled` never reach here — the
 * provider refunds them.
 */
function recordHiggsfieldVideoUsage(
  tokenPayload: ProxyTokenPayload,
  job: VideoJobRecord,
  chatSessionId?: string | null,
) {
  const estimate = job.estimate
  if (!estimate || estimate.billedUsd === 0) {
    console.warn(`[AI Proxy] ⚠️ Higgsfield job ${job.id} completed without a captured price — not charged`)
    return
  }
  return recordMediaUsage(tokenPayload, {
    kind: 'video',
    model: job.model,
    rawUsd: estimate.rawUsd,
    billedUsd: estimate.billedUsd,
    seconds: job.duration,
    actionType: 'ai_video_generation',
    metadata: {
      jobId: job.id,
      endpoint: job.endpoint,
      provider: 'higgsfield',
      ...(job.requestId ? { requestId: job.requestId } : {}),
      ...(job.resolution ? { resolution: job.resolution } : {}),
      ...(job.sourceVideo ? { sourceVideo: true } : {}),
      imageToVideo: job.imageToVideo,
      priceSource: 'estimate',
    },
  }, chatSessionId)
}

/**
 * Record billing for a finished Tripo3D task. Charged from the task's own
 * `credits_consumed` (never the estimate), so a model with a different credit
 * cost than the published table still bills correctly.
 */
function record3dUsage(
  tokenPayload: ProxyTokenPayload,
  params: { model: string; op: string; taskId: string; creditsConsumed: number; input: string },
  chatSessionId?: string | null,
) {
  const cost = calculate3dUsageCost(params.creditsConsumed)
  return recordMediaUsage(tokenPayload, {
    kind: '3d',
    model: params.model,
    rawUsd: cost.rawUsd,
    billedUsd: cost.billedUsd,
    actionType: 'ai_3d_generation',
    metadata: {
      model: params.model,
      op: params.op,
      taskId: params.taskId,
      creditsConsumed: params.creditsConsumed,
      input: params.input,
    },
  }, chatSessionId)
}

/**
 * Record billing for a Whisper transcription call. Priced per-second of
 * audio duration (see `calculateTranscriptionUsageCost`), independent of the
 * chat-turn billing session — transcription is usually a standalone tool
 * call (`transcribe_audio`) or attachment-processing step, not part of the
 * per-message LLM cost accumulator used by `recordUsage`/`accumulateImageUsage`.
 */
export async function recordTranscriptionUsage(
  tokenPayload: ProxyTokenPayload,
  model: string,
  durationSeconds: number | undefined,
) {
  try {
    const { rawUsd, billedUsd } = calculateTranscriptionUsageCost(durationSeconds)
    if (billedUsd === 0) return

    const billingProjectId = isNonProjectSentinel(tokenPayload.projectId)
      ? null
      : (tokenPayload.projectId || null)
    const billingUserId = getProjectUser(tokenPayload.projectId) || tokenPayload.userId || 'system'

    const result = await billingService.consumeUsage({
      workspaceId: tokenPayload.workspaceId,
      projectId: billingProjectId,
      memberId: billingUserId,
      actionType: 'ai_audio_transcription',
      rawUsd,
      billedUsd,
      actionMetadata: { model, durationSeconds, rawUsd },
    })

    if (result.success) {
      console.log(`[AI Proxy] 🎙️ Charged $${billedUsd.toFixed(4)} (transcription, model: ${model}, ${durationSeconds?.toFixed(1) ?? '?'}s) — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`)
    } else {
      console.warn(`[AI Proxy] ⚠️ Could not charge transcription usage: ${result.error}`)
    }
  } catch (err) {
    console.error('[AI Proxy] Failed to charge transcription usage:', err)
  }
}

// =============================================================================
// Routes
// =============================================================================

const isLocalDev = process.env.SHOGO_LOCAL_MODE === 'true'

/**
 * `/ai/v1` prefixes whose handlers only ever talk to a *local* provider key:
 * images (OpenAI / Google / Higgsfield), the media catalogue + uploads, video,
 * 3D and audio transcription. On a cloud-authed desktop those keys do not exist
 * locally — they live in Shogo Cloud — so before this forwarder every one of
 * these answered `provider_not_configured` (or an empty catalogue) even though
 * the cloud held the key. That is SHO-74: *"3D provider 'tripo' is not
 * configured"* on a machine whose Tripo key is saved in cloud admin.
 *
 * One forwarder covers all five instead of a branch per handler, because they
 * are a family of routes that were added one at a time and the next one must
 * not be local-only by accident (see the route-parity guard test). It is
 * prefix-wide rather than per-route on purpose: a job created in cloud
 * (`videos/generations`, `3d/files` → `3d/generations`) is polled in cloud
 * (`videos/:id`, `3d/:id`), so handling the poll locally would orphan the job.
 */
export const CLOUD_FORWARDED_AI_PREFIXES = [
  '/ai/v1/images/',
  '/ai/v1/media/',
  '/ai/v1/videos/',
  '/ai/v1/3d/',
  '/ai/v1/audio/',
] as const

/**
 * Strip the mount base (`/api`) off a request pathname so it can be matched
 * against the prefixes above and appended to `${cloud}/api`. The router is
 * mounted at `/api` in `server.ts`, so `c.req.path` is `/api/ai/v1/…`.
 */
export function aiRelativePath(pathname: string): string {
  const idx = pathname.indexOf('/ai/')
  return idx >= 0 ? pathname.slice(idx) : pathname
}

/** True when a request belongs to a family the local proxy never serves. */
export function isCloudForwardedAiPath(pathname: string): boolean {
  const relative = aiRelativePath(pathname)
  return CLOUD_FORWARDED_AI_PREFIXES.some((prefix) => relative.startsWith(prefix))
}

export function aiProxyRoutes() {
  const router = new Hono()

  /**
   * Resolve a v1 runtime token (`rt_v1_<projectId>_<hmac>`) to a synthetic
   * `ProxyTokenPayload`. Mirrors the runtime-token branch in
   * `../middleware/auth.ts` (project-scoped owner Member, falling back to
   * workspace-scoped owner). Returns `null` if the token is malformed,
   * the HMAC is bad, the project does not exist, or no owner is
   * resolvable. Kept inline (not shared with the middleware) because the
   * middleware sets a Hono context whereas this synthesizes an
   * `ai-proxy` payload — TODO: factor a shared resolver if a third
   * caller appears.
   */
  async function resolveRuntimeToken(token: string): Promise<ProxyTokenPayload | null> {
    const verified = verifyRuntimeToken(token)
    if (!verified.ok) return null
    const project = await prisma.project.findUnique({
      where: { id: verified.projectId },
      select: {
        workspaceId: true,
        members: {
          where: { role: 'owner' },
          orderBy: { createdAt: 'asc' },
          select: { userId: true },
          take: 1,
        },
        workspace: {
          select: {
            members: {
              where: { role: 'owner' },
              orderBy: { createdAt: 'asc' },
              select: { userId: true },
              take: 1,
            },
          },
        },
      },
    })
    const ownerUserId =
      project?.members[0]?.userId ?? project?.workspace.members[0]?.userId
    if (!project || !ownerUserId) return null
    const now = Math.floor(Date.now() / 1000)
    return {
      projectId: verified.projectId,
      workspaceId: project.workspaceId,
      userId: ownerUserId,
      type: 'ai-proxy',
      iat: now,
      exp: now + 3600,
    }
  }

  /**
   * Refresh the agent-runtime idle window for a successful proxy auth.
   *
   * Every successful `/ai/v1/*` or `/ai/anthropic/v1/*` request is the
   * agent inside that project actively making a model call (tool use,
   * streaming completion, embeddings) — that is the strongest possible
   * signal that the runtime is alive and being used. Touching here
   * means a long Opus turn whose only outbound traffic is one big
   * model call still resets the 15-min reaper, even though the user's
   * agent-proxy connection is silent during that span.
   *
   * `'api-key'` payloads come from workspace-scoped Shogo API keys, and
   * `'workspace'` payloads come from a project-less workspace runtime's
   * fallback token (see build-workspace-env.ts) — neither is a real project
   * id, so there's no project-keyed local runtime to touch here. Skip.
   */
  function touchRuntimeFor(payload: ProxyTokenPayload | null): void {
    const keys = runtimeTouchKeys(payload)
    if (keys.length === 0) return
    try {
      const manager = getRuntimeManager()
      for (const key of keys) manager.touch(key)
    } catch {
      // RuntimeManager isn't local, isn't constructed yet, or threw —
      // never block an auth on the touch hook.
    }
  }

  /**
   * Middleware: Validate proxy token on all /ai/v1/* routes.
   * Accepts:
   *   - Shogo API keys (`shogo_sk_*`, workspace-scoped),
   *   - per-project runtime tokens (`rt_v1_*`, pod-native), and
   *   - signed project-scoped proxy JWTs (legacy / browser previews).
   */
  async function validateProxyAuth(c: any): Promise<ProxyTokenPayload | null> {
    const payload = await validateProxyAuthImpl(c)
    touchRuntimeFor(payload)
    return payload
  }

  async function validateProxyAuthImpl(c: any): Promise<ProxyTokenPayload | null> {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return null
    }
    const token = authHeader.slice(7)

    if (token.startsWith('shogo_sk_')) {
      // Opportunistically refresh the stored device app version from the
      // caller's header so the cloud Devices UI reflects upgrades without a
      // dedicated heartbeat round-trip.
      const deviceAppVersion = c.req.header('X-Shogo-Device-App-Version')
      const resolved = await resolveApiKey(
        token,
        deviceAppVersion ? { deviceAppVersion } : undefined,
      )
      if (!resolved) return null
      return {
        projectId: 'api-key',
        workspaceId: resolved.workspaceId,
        userId: resolved.userId,
        type: 'ai-proxy',
        authKind: 'api-key',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
    }

    if (token.startsWith('rt_v1_')) {
      const rt = await resolveRuntimeToken(token)
      return rt ? { ...rt, authKind: 'runtime' } : null
    }

    const jwt = await verifyProxyToken(token)
    return jwt ? { ...jwt, authKind: 'proxy-jwt' } : null
  }

  /**
   * Forward an OpenAI-compatible chat completions request to the Shogo Cloud proxy.
   */
  async function forwardChatCompletionsToCloud(c: any, request: ChatCompletionRequest, signal?: AbortSignal): Promise<Response> {
    const cloudUrl = getShogoCloudUrl()
    const shogoKey = process.env.SHOGO_API_KEY!

    const response = await fetch(`${cloudUrl}/api/ai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...cloudPassthroughHeaders(c),
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${shogoKey}`,
        'x-shogo-client': 'desktop',
      },
      body: JSON.stringify(request),
      signal,
    })

    // Self-heal on revoked / superseded device key.
    if (response.status === 401) {
      void wipeCloudKeyIfRejected('AI proxy chat-completions got 401 from Shogo Cloud')
    }

    if (request.stream) {
      if (!response.body) {
        return c.json({ error: { message: 'Cloud proxy returned no stream body', type: 'server_error' } }, 502)
      }
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Proxy-Provider': 'shogo-cloud',
        },
      })
    }

    const data = await response.json()
    return c.json(data, response.status as any)
  }

  /**
   * Forward an OpenAI Responses-API request to the Shogo Cloud proxy.
   *
   * GPT-5.x reasoning models route through the Responses API (pi-ai sets
   * `api: 'openai-responses'`), and reasoning summaries only stream over this
   * endpoint. In cloud-proxy mode the local instance has no provider key, so —
   * exactly like chat-completions and anthropic-messages — the request must be
   * forwarded to the cloud, which holds the OpenAI key and resolves the model
   * id. Without this the Responses path 503s (or bypasses the cloud), and GPT
   * reasoning never reaches the client.
   */
  async function forwardResponsesToCloud(c: any, request: any, signal?: AbortSignal): Promise<Response> {
    const cloudUrl = getShogoCloudUrl()
    const shogoKey = process.env.SHOGO_API_KEY!

    const response = await fetch(`${cloudUrl}/api/ai/v1/responses`, {
      method: 'POST',
      headers: {
        ...cloudPassthroughHeaders(c),
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${shogoKey}`,
        'x-shogo-client': 'desktop',
      },
      body: JSON.stringify(request),
      signal,
    })

    // Self-heal on revoked / superseded device key.
    if (response.status === 401) {
      void wipeCloudKeyIfRejected('AI proxy responses got 401 from Shogo Cloud')
    }

    if (request?.stream) {
      if (!response.body) {
        return c.json({ error: { message: 'Cloud proxy returned no stream body', type: 'server_error' } }, 502)
      }
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Proxy-Provider': 'shogo-cloud',
        },
      })
    }

    const data = await response.json()
    return c.json(data, response.status as any)
  }

  /**
   * Forward an Anthropic-native request to the Shogo Cloud proxy.
   */
  async function forwardAnthropicToCloud(c: any, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    const cloudUrl = getShogoCloudUrl()
    const shogoKey = process.env.SHOGO_API_KEY!
    const parsed = JSON.parse(body)
    const isStream = !!parsed.stream

    splitSystemBlocksForCaching(parsed)

    const forwardHeaders: Record<string, string> = {
      ...cloudPassthroughHeaders(c),
      'Content-Type': 'application/json',
      'x-api-key': shogoKey,
      'x-shogo-client': 'desktop',
    }
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase().startsWith('anthropic-')) {
        forwardHeaders[key] = value
      }
    }

    const response = await fetchAnthropicWithRetry(
      `${cloudUrl}/api/ai/anthropic/v1/messages`,
      {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify(parsed),
        signal,
      },
      { label: 'shogo-cloud', signal },
    )

    // Self-heal on revoked / superseded device key.
    if (response.status === 401) {
      void wipeCloudKeyIfRejected('AI proxy Anthropic messages got 401 from Shogo Cloud')
    }

    // Hard errors (billing, auth, invalid request, etc.) come back from Shogo
    // Cloud as a single plain-JSON body, NOT an SSE stream — even when the
    // client asked for `stream: true`. Must be handled BEFORE the `isStream`
    // branch below, mirroring the direct-Anthropic path (`forwardAnthropicNative`).
    // Feeding this body into `wrapSseForErrorVisibility` would never observe a
    // `data: ...message_stop|error` terminal line, so the wrapper concludes the
    // stream was truncated mid-flight and injects a *retryable*
    // `upstream_truncated` marker — masking a permanent error (e.g. a 403
    // billing_error) as a transient connectivity blip. The agent loop trusts
    // that marker as authoritative and retries forever, which surfaces to the
    // user as an endless "Back online — resuming…" loop that never completes.
    if (!response.ok) {
      const errorBody = await response.text()
      logUpstreamError('Shogo Cloud (anthropic)', response.status, parsed.model, errorBody)
      return new Response(errorBody, {
        status: response.status,
        headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
      })
    }

    if (isStream) {
      if (!response.body) {
        return c.json({ type: 'error', error: { type: 'api_error', message: 'Cloud proxy returned no stream body' } }, 502)
      }
      return new Response(
        wrapSseForErrorVisibility(response.body, 'shogo-cloud'),
        {
          status: response.status,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Proxy-Provider': 'shogo-cloud',
          },
        },
      )
    }

    const data = await response.json()
    return c.json(data, response.status as any)
  }

  /**
   * Forward a media / 3D / audio request to the Shogo Cloud AI proxy.
   *
   * `lib/cloud-request-forward.ts` owns the credential, the header set, the
   * body streaming and the 401 self-heal — the same ones chat uses. The only
   * thing this wrapper adds is where the request lands: everything after the
   * `/api` mount, plus the query string.
   */
  async function forwardMediaToCloud(c: any): Promise<Response> {
    const originalUrl = new URL(c.req.url)
    return forwardToShogoCloud(c, {
      pathname: aiRelativePath(originalUrl.pathname),
      search: originalUrl.search,
    })
  }

  /**
   * Route-level cloud forwarding for the media / 3D / audio families, ahead of
   * every handler that would otherwise resolve a local provider key.
   *
   * Precedence matches chat exactly: once the gate is on, the request goes to
   * cloud and a local BYOK key is never consulted (BYOK-only setups run
   * `AI_MODE=api-keys`, which turns the gate off for everything). Returning
   * here is also what keeps a forwarded call from opening a local
   * `BillingSession` — cloud bills it, and a local capture would charge the
   * same generation twice.
   */
  router.use('*', async (c, next) => {
    if (!isCloudForwardedAiPath(new URL(c.req.url).pathname)) return next()
    if (!isShogoCloudForwarding()) return next()

    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        {
          error: {
            message: 'Invalid or missing proxy token. Use Authorization: Bearer <token>',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        },
        401,
      )
    }

    return forwardMediaToCloud(c)
  })

  // =========================================================================
  // POST /ai/v1/chat/completions - OpenAI-compatible chat completions proxy
  // =========================================================================
  router.post('/ai/v1/chat/completions', async (c) => {
    // Authenticate
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        {
          error: {
            message: 'Invalid or missing proxy token. Use Authorization: Bearer <token>',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        },
        401
      )
    }

    // When Shogo Cloud key is configured, forward everything to the cloud
    if (isShogoCloudForwarding()) {
      try {
        const request: ChatCompletionRequest = await c.req.json()
        if (!(await isModelVisibleForWorkspace(tokenPayload.workspaceId, request.model))) {
          return modelNotVisibleResponse(c, request.model)
        }
        console.log(`[AI Proxy] Forwarding to Shogo Cloud: ${request.model} (stream: ${!!request.stream})`)
        return await forwardChatCompletionsToCloud(c, request, c.req.raw.signal)
      } catch (error: any) {
        console.error('[AI Proxy] Cloud forwarding error:', error.message)
        return c.json({ error: { message: `Cloud proxy error: ${error.message}`, type: 'server_error', code: 'cloud_proxy_error' } }, 502)
      }
    }

    // Internal, non-billable completions (e.g. server-initiated title
    // generation) must NOT be balance-gated: the preflight allocates a free
    // wallet for the token's workspace, and the server's own proxy token uses a
    // synthetic workspace that has no Workspace row, so `allocateFreeWallet`
    // would throw on the credit-ledger FK. Resolve the tag before the preflight
    // and skip it for internal usage.
    const internalUsage = resolveInternalUsage(c, tokenPayload)

    // Pre-check: reject if workspace has no included USD left (skip in local dev
    // and for internal, non-billable completions). An already-admitted chat turn
    // that is still in flight is never re-gated mid-message (see isTurnInFlight).
    if (!isLocalDev && !internalUsage && !(await isTurnInFlight(c, tokenPayload))) {
      const balanceCheck = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
        return c.json(
          {
            error: {
              message,
              type: 'billing_error',
              code,
              ...usageLimit,
            },
          },
          402
        )
      }
    }

    let capture: Awaited<ReturnType<typeof beginCapture>> = null
    try {
      const request: ChatCompletionRequest = await c.req.json()
      // Forwarded by the chat-stream entry points (project-chat / agent-proxy
      // / instance-tunnel) so accumulateUsage can route to the right
      // `(projectId, chatSessionId)` billing-session slot.
      const chatSessionId = c.req.header('x-chat-session-id') || null

      // Resolve agent-mode aliases (basic/advanced) to real model names
      if (request.model) {
        const { resolvedModel } = resolveAgentModel(request.model)
        if (resolvedModel !== request.model) {
          request.model = resolvedModel
        }
      }

      // Validate model
      if (!request.model) {
        return c.json(
          {
            error: {
              message: 'model is required',
              type: 'invalid_request_error',
              code: 'model_required',
            },
          },
          400
        )
      }

      const modelConfig = resolveModel(request.model)
      if (!modelConfig) {
        return c.json(
          {
            error: {
              message: `Model '${request.model}' is not supported. Use GET /ai/v1/models to see available models.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          },
          400
        )
      }

      const modelEntry = getMergedModelEntrySync(request.model)
      if (isLiveModel(request.model) || modelEntry?.kind === 'live') {
        return c.json(
          {
            error: {
              message: `Model '${request.model}' is a Live Sessions model. Use /ai/v1/live/sessions instead of chat completions.`,
              type: 'invalid_request_error',
              code: 'model_not_supported_on_endpoint',
            },
          },
          400,
        )
      }

      // Reject `input_audio` content blocks up front with a clear, actionable
      // error instead of letting them reach OpenAI/Anthropic and bounce back
      // with a generic "content blocks are expected to be text or image_url"
      // message. Only audio-native models (capabilities.supportsAudioInput —
      // e.g. `gpt-audio`, or a DB-defined custom model like `mimo-v2.5`)
      // accept input_audio blocks; see `resolveModelSupportsAudioInput`.
      if (!resolveModelSupportsAudioInput(request.model)) {
        const hasAudioBlock = request.messages.some(
          (msg) =>
            Array.isArray(msg.content) &&
            msg.content.some((block) => block.type === 'input_audio')
        )
        if (hasAudioBlock) {
          return c.json(
            {
              error: {
                message: `Model '${request.model}' does not accept audio input. Use an audio-native model (e.g. 'gpt-audio' or 'mimo-v2.5') for input_audio content blocks, or transcribe the audio to text first.`,
                type: 'invalid_request_error',
                code: 'audio_input_not_supported',
              },
            },
            400
          )
        }
      }

      // Enforce workspace model visibility: a workspace admin may restrict the
      // team to a subset of platform-visible models. Hidden models are blocked
      // here too, so a member can't bypass the picker via a direct API call.
      if (!(await isModelVisibleForWorkspace(tokenPayload.workspaceId, request.model))) {
        return modelNotVisibleResponse(c, request.model)
      }

      // Enforce model tier: free/basic users can only use economy-tier models.
      // Local LLMs and BYOK OpenRouter calls are user-paid, so no tier check
      // applies — the user is paying their own provider directly. Internal,
      // non-billable completions (e.g. server-initiated title generation) also
      // bypass tier gating: the admin picks the title model and it is never
      // billed to or restricted by the end user's plan.
      //
      // The `'workspace'` sentinel identifies a project-less workspace
      // runtime — in practice, exclusively the free personal-companion chat
      // (see build-workspace-env.ts). Its model is never end-user-chosen: the
      // client's `agentMode` is force-overridden server-side in
      // workspace-chat.ts to the super-admin-configured personal companion
      // model (default `hoshi-2-0`, an intentionally low-cost model picked
      // *because* personal spaces are free). Gating it on the workspace's
      // own Stripe plan made the free personal companion 403 for every
      // non-economy-tier admin choice — surfaced to users as "The model
      // provider rejected the request" (403 classifies as `auth` in
      // retry-classifier.ts) even though DeepSeek/the provider never saw the
      // call. Bypass tier gating here the same way `internalUsage` does,
      // rather than requiring every free personal space to carry a Pro plan.
      const isPersonalCompanionRuntime = tokenPayload.projectId === 'workspace'
      if (
        modelConfig.provider !== 'local' &&
        modelConfig.provider !== 'openrouter' &&
        !isLocalDev &&
        !internalUsage &&
        !isPersonalCompanionRuntime
      ) {
        const tier = resolveModelTier(request.model)
        if (tier !== 'economy') {
          const hasAdvanced = await billingService.hasAdvancedModelAccess(tokenPayload.workspaceId)
          if (!hasAdvanced) {
            return c.json(
              {
                error: {
                  message: `Model '${request.model}' requires a Pro or higher subscription. Free and Basic plan users can use economy-tier models (e.g. claude-haiku-4-5, gpt-5.4-nano).`,
                  type: 'billing_error',
                  code: 'model_tier_restricted',
                },
              },
              403
            )
          }
        }
      }

      // Get provider API key (custom providers carry a decrypted key on the
      // resolved config; native providers read their server-side env var).
      const apiKey = resolveModelApiKey(modelConfig)
      if (!apiKey) {
        return c.json(
          {
            error: {
              message: `Provider '${modelConfig.provider}' is not configured on this server.`,
              type: 'server_error',
              code: 'provider_not_configured',
            },
          },
          503
        )
      }

      console.log(
        `[AI Proxy] ${tokenPayload.projectId} → ${modelConfig.provider}/${modelConfig.apiModel} (stream: ${!!request.stream})`
      )

      capture = await beginCapture({
        tokenPayload,
        endpoint: 'chat.completions',
        requestBody: request,
        requestedModel: request.model,
        resolvedModel: modelConfig.apiModel,
        provider: modelConfig.provider,
        stream: Boolean(request.stream),
        chatSessionId,
        internal: Boolean(internalUsage),
        client: c.req.header('x-shogo-client'),
        requestHeaders: c.req.raw.headers,
      })

      // BYOK paths bypass cloud usage tracking — user pays the provider
      // directly (no Shogo Cloud middleman to bill against).
      const isByokOpenRouter = modelConfig.provider === 'openrouter'

      // Route to provider
      if (request.stream) {
        if (modelConfig.provider === 'anthropic') {
          const upstream = await proxyAnthropicStream(request, apiKey, modelConfig, (inTok, outTok, cachedTok, cacheWriteTok) => {
            recordUsage(tokenPayload, request.model, inTok, outTok, cachedTok, cacheWriteTok, chatSessionId, internalUsage)
          }, c.req.raw.signal)
          return capture?.wrapStream(upstream, 'openai-chat') || upstream
        } else {
          const upstream = await proxyOpenAIStream(request, apiKey, modelConfig, isByokOpenRouter ? undefined : (inTok, outTok, cachedTok, reasoningTok, cacheWriteTok) => {
            recordUsage(tokenPayload, request.model, inTok, outTok, cachedTok, cacheWriteTok, chatSessionId, internalUsage, reasoningTok)
          }, c.req.raw.signal)
          return capture?.wrapStream(upstream, 'openai-chat') || upstream
        }
      } else {
        let result: any
        if (modelConfig.provider === 'anthropic') {
          result = await proxyAnthropicNonStream(request, apiKey, modelConfig, c.req.raw.signal)
        } else {
          result = await proxyOpenAINonStream(request, apiKey, modelConfig, c.req.raw.signal)
        }

        if (!isByokOpenRouter) {
          const usage = result.usage || {}
          const prompt = splitOpenAIPromptUsage(usage)
          recordUsage(
            tokenPayload,
            request.model,
            prompt.inputTokens,
            usage.completion_tokens || 0,
            prompt.cachedInputTokens,
            prompt.cacheWriteTokens,
            chatSessionId,
            internalUsage,
            usage.completion_tokens_details?.reasoning_tokens || 0,
          )
        }

        capture?.recordResponse({
          status: 200,
          body: result,
          format: 'json',
          usage: {
            inputTokens: result.usage?.prompt_tokens ?? result.usage?.input_tokens,
            outputTokens: result.usage?.completion_tokens ?? result.usage?.output_tokens,
            cachedInputTokens: result.usage?.prompt_tokens_details?.cached_tokens ?? result.usage?.cache_read_input_tokens,
            reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens ?? result.usage?.reasoning_tokens,
          },
        })
        return c.json(result)
      }
    } catch (error: any) {
      capture?.finish({ errorType: 'proxy_error' })
      console.error('[AI Proxy] Error:', error.message)

      // Return OpenAI-compatible error format
      const statusCode = error.message?.includes('429') ? 429 : error.message?.includes('503') ? 503 : 500
      return c.json(
        {
          error: {
            message: error.message || 'Internal proxy error',
            type: 'server_error',
            code: 'proxy_error',
          },
        },
        statusCode
      )
    }
  })

  // =========================================================================
  // POST /ai/v1/responses - OpenAI Responses API proxy (pass-through)
  //
  // pi-ai routes reasoning models (gpt-5.4-mini etc.) through the Responses
  // API which supports reasoning_effort + tools. This endpoint resolves the
  // model alias, swaps in the real model name, and forwards the full body
  // to OpenAI's /v1/responses endpoint.
  // =========================================================================
  router.post('/ai/v1/responses', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    // When a Shogo Cloud key is configured, forward to the cloud — the local
    // instance has no OpenAI key and the cloud resolves the model id. Mirrors
    // the chat-completions / anthropic-messages cloud paths; required for GPT
    // reasoning (Responses API) to work in cloud-proxy mode.
    if (isShogoCloudForwarding()) {
      try {
        const request = await c.req.json()
        if (!(await isModelVisibleForWorkspace(tokenPayload.workspaceId, request?.model))) {
          return modelNotVisibleResponse(c, request?.model)
        }
        console.log(`[AI Proxy] Forwarding Responses API to Shogo Cloud: ${request?.model} (stream: ${!!request?.stream})`)
        return await forwardResponsesToCloud(c, request, c.req.raw.signal)
      } catch (error: any) {
        console.error('[AI Proxy] Cloud forwarding error (responses):', error.message)
        return c.json({ error: { message: `Cloud proxy error: ${error.message}`, type: 'server_error', code: 'cloud_proxy_error' } }, 502)
      }
    }

    // Internal, non-billable completions skip the balance preflight (see
    // chat/completions for the credit-ledger FK rationale).
    const internalUsage = resolveInternalUsage(c, tokenPayload)

    if (!isLocalDev && !internalUsage && !(await isTurnInFlight(c, tokenPayload))) {
      const balanceCheck = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
        return c.json(
          { error: { message, type: 'billing_error', code, ...usageLimit } },
          402
        )
      }
    }

    let capture: Awaited<ReturnType<typeof beginCapture>> = null
    try {
      const body = await c.req.json()
      const requestedModel = body.model
      if (!requestedModel) {
        return c.json({ error: { message: 'model is required', type: 'invalid_request_error' } }, 400)
      }
      const chatSessionId = c.req.header('x-chat-session-id') || null

      const { resolvedModel } = resolveAgentModel(requestedModel)
      const modelConfig = resolveModel(resolvedModel)
      if (!modelConfig) {
        return c.json({ error: { message: `Model '${requestedModel}' is not supported.`, type: 'invalid_request_error' } }, 400)
      }

      const modelEntry = getMergedModelEntrySync(resolvedModel)
      if (isLiveModel(resolvedModel) || modelEntry?.kind === 'live') {
        return c.json(
          {
            error: {
              message: `Model '${requestedModel}' is a Live Sessions model. Use /ai/v1/live/sessions instead of the Responses API.`,
              type: 'invalid_request_error',
              code: 'model_not_supported_on_endpoint',
            },
          },
          400,
        )
      }

      // This handler only forwards to OpenAI; another provider's model would be
      // sent there with that provider's key.
      if (modelConfig.provider !== 'openai') {
        return c.json(
          {
            error: {
              message: `Model '${requestedModel}' (provider '${modelConfig.provider}') is not supported on the Responses API. Use /ai/v1/chat/completions or /ai/anthropic/v1/messages.`,
              type: 'invalid_request_error',
              code: 'model_not_supported_on_endpoint',
            },
          },
          400,
        )
      }

      if (!(await isModelVisibleForWorkspace(tokenPayload.workspaceId, resolvedModel))) {
        return modelNotVisibleResponse(c, requestedModel)
      }

      const apiKey = getProviderApiKey(modelConfig.provider)
      if (!apiKey) {
        return c.json({ error: { message: `Provider '${modelConfig.provider}' is not configured.`, type: 'server_error' } }, 503)
      }

      const isStream = !!body.stream
      console.log(`[AI Proxy] Responses API: ${tokenPayload.projectId} → ${modelConfig.provider}/${modelConfig.apiModel} (stream: ${isStream})`)

      capture = await beginCapture({
        tokenPayload,
        endpoint: 'responses',
        requestBody: body,
        requestedModel,
        resolvedModel: modelConfig.apiModel,
        provider: modelConfig.provider,
        stream: isStream,
        chatSessionId,
        internal: Boolean(internalUsage),
        client: c.req.header('x-shogo-client'),
        requestHeaders: c.req.raw.headers,
      })

      const forwardBody = { ...body, model: modelConfig.apiModel }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(forwardBody),
        signal: c.req.raw.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[AI Proxy] Responses API error (${response.status}): ${errorText.slice(0, 300)}`)
        return new Response(errorText, { status: relayStatusForProviderError(response.status), headers: { 'Content-Type': 'application/json' } })
      }

      if (isStream) {
        // SSE pass-through with usage extraction
        const decoder = new TextDecoder()
        let inputTokens = 0
        let outputTokens = 0
        let cachedInputTokens = 0
        let sseBuffer = ''

        const transformStream = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk)
            sseBuffer += decoder.decode(chunk, { stream: true })
            const lines = sseBuffer.split('\n')
            sseBuffer = lines.pop() || ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              if (data === '[DONE]') continue
              try {
                const parsed = JSON.parse(data)
                if (parsed.type === 'response.completed' && parsed.response?.usage) {
                  const usage = parsed.response.usage
                  const totalInput = usage.input_tokens || 0
                  cachedInputTokens =
                    usage.input_tokens_details?.cached_tokens ??
                    usage.prompt_cache_hit_tokens ??
                    0
                  inputTokens =
                    usage.prompt_cache_miss_tokens ??
                    Math.max(0, totalInput - cachedInputTokens)
                  outputTokens = usage.output_tokens || 0
                }
              } catch {}
            }
          },
          flush() {
            if (inputTokens || outputTokens || cachedInputTokens) {
              recordUsage(tokenPayload, requestedModel, inputTokens, outputTokens, cachedInputTokens, 0, chatSessionId, internalUsage)
            }
          },
        })

        const reader = response.body!.getReader()
        const readable = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read()
            if (done) { controller.close(); return }
            controller.enqueue(value)
          },
        })

        const streamedResponse = new Response(readable.pipeThrough(transformStream), {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        })
        return capture?.wrapStream(streamedResponse, 'openai-responses') || streamedResponse
      } else {
        const result = await response.json() as any
        if (result.usage) {
          const usage = result.usage
          const totalInput = usage.input_tokens || 0
          const cachedInput =
            usage.input_tokens_details?.cached_tokens ??
            usage.prompt_cache_hit_tokens ??
            0
          recordUsage(
            tokenPayload,
            requestedModel,
            usage.prompt_cache_miss_tokens ?? Math.max(0, totalInput - cachedInput),
            usage.output_tokens || 0,
            cachedInput,
            0,
            chatSessionId,
            internalUsage,
            usage.output_tokens_details?.reasoning_tokens ||
              usage.completion_tokens_details?.reasoning_tokens ||
              0,
          )
        }
        capture?.recordResponse({
          status: 200,
          body: result,
          format: 'json',
          usage: {
            inputTokens: result.usage?.input_tokens,
            outputTokens: result.usage?.output_tokens,
            cachedInputTokens: result.usage?.input_tokens_details?.cached_tokens,
            reasoningTokens: result.usage?.output_tokens_details?.reasoning_tokens ??
              result.usage?.completion_tokens_details?.reasoning_tokens,
          },
        })
        return c.json(result)
      }
    } catch (error: any) {
      capture?.finish({ errorType: 'proxy_error' })
      console.error('[AI Proxy] Responses API error:', error.message)
      return c.json({ error: { message: error.message || 'Internal proxy error', type: 'server_error' } }, 500)
    }
  })

  // =========================================================================
  // GET /ai/v1/models - List available models
  // =========================================================================
  // Reflects the same admin-curated, workspace-visible set the chat picker
  // uses (`resolveVisibleModelsForWorkspace`) rather than the full static
  // catalog — a model an admin hasn't enabled (or a workspace has hidden)
  // won't be listed here, even though the static catalog fallback still
  // covers a fresh/unseeded instance. See `services/visible-models.service.ts`.
  router.get('/ai/v1/models', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        {
          error: {
            message: 'Invalid or missing proxy token.',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        },
        401
      )
    }

    const created = Math.floor(Date.now() / 1000)
    const visible = await resolveVisibleModelsForWorkspace(tokenPayload.workspaceId, { includeLive: true })

    // A listed model must be one this plan can actually run, not just one whose
    // provider is reachable. Without this a caller (the agent runtime, a tool
    // such as `project_configure`) happily picks a model the chat routes would
    // silently swap for Auto at request time (SHO-145) — better to report it
    // `available:false` here so the tool refuses it up front with
    // `model_unavailable`.
    //
    // One entitlement resolution per request, and only for a model that needs
    // it: `hasAdvancedModelAccess` is workspace-wide, so it is memoised here
    // rather than consulted once per model id.
    let advancedAccess: boolean | undefined
    const isAccessible = (id: string): Promise<boolean> =>
      isModelAccessibleForWorkspace(tokenPayload.workspaceId, id, {
        advancedAccess,
        resolveAdvancedAccess: async () => {
          advancedAccess ??= await billingService.hasAdvancedModelAccess(tokenPayload.workspaceId)
          return advancedAccess
        },
      })

    const models = [
      ...(await Promise.all(visible.catalogModels.map(async (entry) => ({
        id: entry.id,
        object: 'model',
        created,
        owned_by: entry.provider,
        display_name: entry.displayName,
        ...(entry.kind ? { kind: entry.kind } : {}),
        ...(typeof entry.usdPerMinute === 'number' ? { usd_per_minute: entry.usdPerMinute } : {}),
        // Indicate if the provider is actually configured
        available: isModelProviderConfigured(entry.provider) && (await isAccessible(entry.id)),
      })))),
      ...(await Promise.all(visible.openrouterModels.map(async (entry) => ({
        id: entry.id,
        object: 'model',
        created,
        owned_by: 'openrouter',
        display_name: entry.displayName,
        available: isModelProviderConfigured('openrouter') && (await isAccessible(entry.id)),
      })))),
    ]

    return c.json({
      object: 'list',
      data: models,
    })
  })

  // =========================================================================
  // POST /ai/proxy/tokens - Generate a proxy token for a project
  // =========================================================================
  router.post('/ai/proxy/tokens', async (c) => {
    try {
      const body = await c.req.json()
      const { projectId, workspaceId, userId, expiryHours } = body

      if (!projectId || !workspaceId) {
        return c.json(
          { error: { code: 'invalid_request', message: 'projectId and workspaceId are required' } },
          400
        )
      }

      // Validate project exists and belongs to workspace
      const project = await prisma.project.findFirst({
        where: { id: projectId, workspaceId },
        select: { id: true, name: true },
      })

      if (!project) {
        return c.json(
          { error: { code: 'not_found', message: 'Project not found in workspace' } },
          404
        )
      }

      // Generate token
      const expiryMs = expiryHours
        ? expiryHours * 60 * 60 * 1000
        : undefined // Default: 24 hours

      const token = await generateProxyToken(projectId, workspaceId, userId, expiryMs)

      return c.json({
        token,
        projectId,
        workspaceId,
        expiresIn: expiryHours ? `${expiryHours}h` : '24h',
      })
    } catch (error: any) {
      console.error('[AI Proxy] Token generation error:', error)
      return c.json(
        { error: { code: 'token_error', message: error.message || 'Failed to generate token' } },
        500
      )
    }
  })

  // =========================================================================
  // Anthropic-Native Pass-Through Endpoints
  // =========================================================================
  // These endpoints accept requests in Anthropic's native API format and
  // forward them directly to api.anthropic.com. This allows the agent-runtime
  // to use the proxy via ANTHROPIC_BASE_URL without any format conversion.
  //
  // Auth: The proxy token is sent via the `x-api-key` header (same header
  // used for ANTHROPIC_API_KEY).

  /**
   * Validate Anthropic-style auth (x-api-key header contains proxy token).
   * Accepts:
   *   - Shogo API keys (`shogo_sk_*`),
   *   - per-project runtime tokens (`rt_v1_*`), and
   *   - signed project-scoped proxy JWTs.
   */
  async function validateAnthropicAuth(c: any): Promise<ProxyTokenPayload | null> {
    const payload = await validateAnthropicAuthImpl(c)
    touchRuntimeFor(payload)
    return payload
  }

  async function validateAnthropicAuthImpl(c: any): Promise<ProxyTokenPayload | null> {
    const apiKey = c.req.header('x-api-key')
    if (!apiKey) {
      return null
    }

    if (apiKey.startsWith('shogo_sk_')) {
      const deviceAppVersion = c.req.header('X-Shogo-Device-App-Version')
      const resolved = await resolveApiKey(
        apiKey,
        deviceAppVersion ? { deviceAppVersion } : undefined,
      )
      if (!resolved) return null
      return {
        projectId: 'api-key',
        workspaceId: resolved.workspaceId,
        userId: resolved.userId,
        type: 'ai-proxy',
        authKind: 'api-key',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
    }

    if (apiKey.startsWith('rt_v1_')) {
      const rt = await resolveRuntimeToken(apiKey)
      return rt ? { ...rt, authKind: 'runtime' } : null
    }

    const jwt = await verifyProxyToken(apiKey)
    return jwt ? { ...jwt, authKind: 'proxy-jwt' } : null
  }

  /**
   * POST /ai/anthropic/v1/messages - Anthropic Messages API pass-through
   *
   * The agent-runtime sets ANTHROPIC_BASE_URL to our proxy and sends requests
   * here. We validate the proxy token (sent as x-api-key), then forward the
   * request to the real Anthropic API with our server-side API key.
   */
  router.post('/ai/anthropic/v1/messages', async (c) => {
    // Authenticate via x-api-key (proxy token)
    const tokenPayload = await validateAnthropicAuth(c)
    if (!tokenPayload) {
      return c.json(
        { type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing proxy token in x-api-key header.' } },
        401
      )
    }

    // When Shogo Cloud key is configured, forward everything to the cloud
    if (isShogoCloudForwarding()) {
      try {
        const body = await c.req.text()
        // Same allowlist check as the local path below, using the same model
        // resolution, before the request leaves this machine.
        let forwardedModel: string | undefined
        try { forwardedModel = JSON.parse(body)?.model } catch { /* cloud reports malformed bodies */ }
        const { resolvedModel: forwardedResolved, isLocal: forwardedIsLocal } = resolveAgentModel(forwardedModel || 'advanced')
        if (!forwardedIsLocal && !(await isModelVisibleForWorkspace(tokenPayload.workspaceId, forwardedResolved))) {
          return c.json(
            { type: 'error', error: { type: 'invalid_request_error', message: `Model '${forwardedResolved}' is not available for this workspace. A workspace admin has restricted the available models.` } },
            403
          )
        }
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(c.req.header())) {
          if (value) headers[key] = value as string
        }
        const parsed = JSON.parse(body)
        console.log(`[AI Proxy] Forwarding Anthropic to Shogo Cloud: ${parsed.model || 'unknown'} (stream: ${!!parsed.stream})`)
        return await forwardAnthropicToCloud(c, body, headers, c.req.raw.signal)
      } catch (error: any) {
        console.error('[AI Proxy] Cloud forwarding error:', error.message)
        return c.json({ type: 'error', error: { type: 'api_error', message: `Cloud proxy error: ${error.message}` } }, 502)
      }
    }

    // Internal, non-billable completions skip the balance preflight (see
    // chat/completions for the credit-ledger FK rationale).
    const internalUsage = resolveInternalUsage(c, tokenPayload)

    // Pre-check usage balance (skip in local dev and for internal usage). An
    // already-admitted chat turn still in flight is never re-gated mid-message.
    if (!isLocalDev && !internalUsage && !(await isTurnInFlight(c, tokenPayload))) {
      const balanceCheck = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
        return c.json(
          { type: 'error', error: { type: 'billing_error', code, message, ...usageLimit } },
          402
        )
      }
    }

    let capture: Awaited<ReturnType<typeof beginCapture>> = null
    try {
      const body = await c.req.text()
      let parsed: any = {}
      try { parsed = JSON.parse(body) } catch { /* ok */ }
      const requestModel = parsed.model || 'advanced'
      const isStream = !!parsed.stream
      const chatSessionId = c.req.header('x-chat-session-id') || null

      const { resolvedModel, isLocal } = resolveAgentModel(requestModel)
      console.log(`[AI Proxy] Anthropic pass-through: ${tokenPayload.projectId} → ${resolvedModel} (local: ${isLocal}, stream: ${isStream})`)
      const resolvedModelConfig = resolveModel(resolvedModel)

      // Enforce workspace model visibility (see chat/completions for rationale).
      if (!isLocal && !(await isModelVisibleForWorkspace(tokenPayload.workspaceId, resolvedModel))) {
        return c.json(
          { type: 'error', error: { type: 'invalid_request_error', message: `Model '${resolvedModel}' is not available for this workspace. A workspace admin has restricted the available models.` } },
          403
        )
      }

      // Enforce model tier: free/basic users can only use economy-tier models.
      // Internal, non-billable completions and the free personal-companion
      // runtime bypass tier gating (see chat/completions for rationale).
      if (!isLocal && !isLocalDev && !internalUsage && tokenPayload.projectId !== 'workspace') {
        const tier = resolveModelTier(resolvedModel)
        if (tier !== 'economy') {
          const hasAdvanced = await billingService.hasAdvancedModelAccess(tokenPayload.workspaceId)
          if (!hasAdvanced) {
            return c.json(
              { type: 'error', error: { type: 'billing_error', message: `Model '${resolvedModel}' requires a Pro or higher subscription. Free and Basic plan users can use economy-tier models (e.g. claude-haiku-4-5, gpt-5.4-nano).` } },
              403
            )
          }
        }
      }

      capture = await beginCapture({
        tokenPayload,
        endpoint: 'anthropic.messages',
        requestBody: parsed,
        requestedModel: requestModel,
        resolvedModel: resolvedModelConfig?.apiModel || resolvedModel,
        provider: isLocal ? 'local' : resolvedModelConfig?.provider || 'anthropic',
        stream: isStream,
        chatSessionId,
        internal: Boolean(internalUsage),
        client: c.req.header('x-shogo-client'),
        requestHeaders: c.req.raw.headers,
      })

      // ── Local LLM routing: convert Anthropic → OpenAI format ──
      if (isLocal) {
        const localBase = process.env.LOCAL_LLM_BASE_URL!.replace(/\/$/, '')
        const openaiMessages = convertAnthropicRequestToOpenAIMessages(parsed)
        const openaiBody: any = {
          model: resolvedModel,
          messages: openaiMessages,
          stream: isStream,
        }
        if (parsed.max_tokens) openaiBody.max_tokens = parsed.max_tokens
        if (parsed.temperature !== undefined) openaiBody.temperature = parsed.temperature
        if (parsed.tools) {
          openaiBody.tools = parsed.tools.map((t: any) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        }

        const response = await fetch(`${localBase}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(openaiBody),
          signal: c.req.raw.signal,
        })
        if (!response.ok) {
          const errorText = await response.text()
          logUpstreamError('Local LLM', response.status, resolvedModel, errorText)
          capture?.recordResponse({ status: response.status, body: { error: errorText }, format: 'json', errorType: 'upstream_error' })
          return c.json(
            { type: 'error', error: { type: 'api_error', message: `Local LLM error (${response.status}): ${errorText}` } },
            response.status as any
          )
        }

        if (isStream) {
          const anthropicStream = convertOpenAIStreamToAnthropicStream(response.body!, resolvedModel)
          const streamedResponse = new Response(anthropicStream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Proxy-Provider': 'local',
              'X-Proxy-Model': resolvedModel,
            },
          })
          return capture?.wrapStream(streamedResponse, 'anthropic') || streamedResponse
        } else {
          const openaiResult = await response.json() as any
          const anthropicResult = convertOpenAIResponseToAnthropic(openaiResult, resolvedModel)
          capture?.recordResponse({
            status: 200,
            body: anthropicResult,
            format: 'json',
            usage: {
              inputTokens: openaiResult.usage?.prompt_tokens,
              outputTokens: openaiResult.usage?.completion_tokens,
              cachedInputTokens: openaiResult.usage?.prompt_tokens_details?.cached_tokens,
              reasoningTokens: openaiResult.usage?.completion_tokens_details?.reasoning_tokens,
            },
          })
          return c.json(anthropicResult)
        }
      }

      // ── Cloud routing: OpenAI models (convert Anthropic → OpenAI format) ──
      if (resolvedModelConfig && resolvedModelConfig.provider === 'openai') {
        const openaiApiKey = process.env.OPENAI_API_KEY
        if (!openaiApiKey) {
          capture?.recordResponse({
            status: 503,
            body: { error: 'OpenAI provider is not configured' },
            format: 'json',
            errorType: 'provider_not_configured',
          })
          return c.json(
            { type: 'error', error: { type: 'api_error', message: 'OpenAI provider is not configured on this server.' } },
            503
          )
        }

        const openaiMessages = convertAnthropicRequestToOpenAIMessages(parsed)
        const openaiBody: any = {
          model: resolvedModel,
          messages: openaiMessages,
          stream: isStream,
        }
        if (parsed.max_tokens) openaiBody.max_completion_tokens = parsed.max_tokens
        if (parsed.temperature !== undefined) openaiBody.temperature = parsed.temperature
        if (parsed.tools) {
          openaiBody.tools = parsed.tools.map((t: any) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiApiKey}`,
          },
          body: JSON.stringify(openaiBody),
          signal: c.req.raw.signal,
        })
        if (!response.ok) {
          const errorText = await response.text()
          logUpstreamError('OpenAI', response.status, resolvedModel, errorText)
          capture?.recordResponse({ status: response.status, body: { error: errorText }, format: 'json', errorType: 'upstream_error' })
          return c.json(
            { type: 'error', error: { type: 'api_error', message: `OpenAI error (${response.status}): ${errorText}` } },
            relayStatusForProviderError(response.status) as any
          )
        }

        if (isStream) {
          const anthropicStream = convertOpenAIStreamToAnthropicStream(response.body!, resolvedModel)
          const streamedResponse = new Response(anthropicStream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Proxy-Provider': 'openai',
              'X-Proxy-Model': resolvedModel,
            },
          })
          return capture?.wrapStream(streamedResponse, 'anthropic') || streamedResponse
        } else {
          const openaiResult = await response.json() as any
          const oaiPrompt = splitOpenAIPromptUsage(openaiResult.usage)
          recordUsage(tokenPayload, resolvedModel, oaiPrompt.inputTokens, openaiResult.usage?.completion_tokens || 0, oaiPrompt.cachedInputTokens, oaiPrompt.cacheWriteTokens, chatSessionId, internalUsage)
          const anthropicResult = convertOpenAIResponseToAnthropic(openaiResult, resolvedModel)
          capture?.recordResponse({
            status: 200,
            body: anthropicResult,
            format: 'json',
            usage: {
              inputTokens: oaiPrompt.inputTokens,
              outputTokens: openaiResult.usage?.completion_tokens,
              cachedInputTokens: oaiPrompt.cachedInputTokens,
              reasoningTokens: openaiResult.usage?.completion_tokens_details?.reasoning_tokens,
            },
          })
          return c.json(anthropicResult)
        }
      }

      // ── Cloud routing: forward to Anthropic API ──
      const anthropicApiKey = process.env.ANTHROPIC_API_KEY
      if (!anthropicApiKey) {
        capture?.recordResponse({
          status: 503,
          body: { error: 'Anthropic provider is not configured' },
          format: 'json',
          errorType: 'provider_not_configured',
        })
        return c.json(
          { type: 'error', error: { type: 'api_error', message: 'Anthropic provider is not configured on this server.' } },
          503
        )
      }

      // Replace the model name with the resolved upstream name before
      // forwarding. DB-defined models are addressed by an opaque id (a UUID),
      // and Anthropic 404s on that id — so prefer the resolved `apiModel`
      // (e.g. `claude-opus-4-8`). Falls back to `resolvedModel` when the id
      // isn't catalog-resolvable, preserving the prior behavior for everything
      // already addressed by a real Anthropic model name.
      parsed.model = resolvedModelConfig?.apiModel ?? resolvedModel

      // Rewrite the thinking config to the adaptive shape when the resolved
      // upstream model requires it. DB models reach pi-ai as an opaque UUID, so
      // it can't detect adaptive thinking and emits the legacy budget-based
      // `thinking.type: "enabled"` block, which Opus 4.6+/Sonnet 4.6 reject.
      normalizeThinkingForModel(parsed, parsed.model)

      // Split system prompt at CACHE_BOUNDARY so Anthropic can cache the stable
      // prefix independently. The agent-runtime embeds <|CACHE_BOUNDARY|> between
      // the stable and dynamic zones of the system prompt.
      splitSystemBlocksForCaching(parsed)

      const forwardBody = JSON.stringify(parsed)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
      }
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key.toLowerCase().startsWith('anthropic-') && value) {
          headers[key] = value as string
        }
      }
      if (!headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01'
      }

      const response = await fetchAnthropicWithRetry(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers,
          body: forwardBody,
          signal: c.req.raw.signal,
        },
        { label: 'anthropic', signal: c.req.raw.signal },
      )

      if (!response.ok) {
        const errorBody = await response.text()
        logUpstreamError('Anthropic', response.status, parsed.model, errorBody)
        capture?.recordResponse({ status: response.status, body: { error: errorBody }, format: 'json', errorType: 'upstream_error' })
        return new Response(errorBody, {
          status: relayStatusForProviderError(response.status),
          headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
        })
      }

      if (!isStream) {
        const responseBody = await response.json() as any
        const inTok = responseBody.usage?.input_tokens || 0
        const cacheWriteTok = responseBody.usage?.cache_creation_input_tokens || 0
        const cachedTok = responseBody.usage?.cache_read_input_tokens || 0
        const outTok = responseBody.usage?.output_tokens || 0
        recordUsage(tokenPayload, resolvedModel, inTok, outTok, cachedTok, cacheWriteTok, chatSessionId, internalUsage)
        capture?.recordResponse({
          status: 200,
          body: responseBody,
          format: 'json',
          usage: {
            inputTokens: inTok,
            outputTokens: outTok,
            cachedInputTokens: cachedTok,
            cacheWriteTokens: cacheWriteTok,
          },
        })
        return c.json(responseBody)
      }

      // Streaming: pass through with token tracking
      const responseHeaders = new Headers()
      const contentType = response.headers.get('Content-Type')
      if (contentType) responseHeaders.set('Content-Type', contentType)
      const requestId = response.headers.get('request-id')
      if (requestId) responseHeaders.set('request-id', requestId)
      responseHeaders.set('X-Proxy-Provider', 'anthropic')
      responseHeaders.set('X-Proxy-Project', tokenPayload.projectId)

      let streamInputTokens = 0
      let streamCachedInputTokens = 0
      let streamCacheWriteTokens = 0
      let streamOutputTokens = 0
      const sseDecoder = new TextDecoder()
      let sseBuffer = ''

      const tokenTrackingTransform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          sseBuffer += sseDecoder.decode(chunk, { stream: true })
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue
            try {
              const event = JSON.parse(data)
              if (event.type === 'message_start' && event.message?.usage) {
                const usage = event.message.usage
                streamInputTokens = usage.input_tokens || 0
                streamCacheWriteTokens = usage.cache_creation_input_tokens || 0
                streamCachedInputTokens = usage.cache_read_input_tokens || 0
              }
              if (event.type === 'message_delta' && event.usage) {
                streamOutputTokens = event.usage.output_tokens || 0
              }
            } catch {}
          }
        },
        flush() {
          recordUsage(tokenPayload, resolvedModel, streamInputTokens, streamOutputTokens, streamCachedInputTokens, streamCacheWriteTokens, chatSessionId, internalUsage)
        },
      })

      // Wrap with keepalive + mid-stream error visibility *before* token
      // tracking, so synthetic error frames are also scanned for usage fields
      // (they have none — harmless) but kept in the stream for downstream.
      const wrapped = wrapSseForErrorVisibility(response.body!, 'anthropic')
      const trackedBody = wrapped.pipeThrough(tokenTrackingTransform)
      const streamedResponse = new Response(trackedBody, {
        status: response.status,
        headers: responseHeaders,
      })
      return capture?.wrapStream(streamedResponse, 'anthropic') || streamedResponse
    } catch (error: any) {
      // Client cancelled — surface 499 silently, don't log as a server error.
      if (error?.name === 'AbortError') {
        return new Response(null, { status: 499 })
      }
      capture?.finish({ errorType: 'proxy_error' })
      console.error('[AI Proxy] Anthropic pass-through error:', error.message)
      return c.json(
        { type: 'error', error: { type: 'api_error', message: error.message || 'Proxy error' } },
        500
      )
    }
  })

  /**
   * POST /ai/anthropic/v1/messages/count_tokens - Token counting pass-through
   */
  router.post('/ai/anthropic/v1/messages/count_tokens', async (c) => {
    const tokenPayload = await validateAnthropicAuth(c)
    if (!tokenPayload) {
      return c.json(
        { type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy token.' } },
        401
      )
    }

    // Forward to Shogo Cloud when configured
    if (isShogoCloudForwarding()) {
      const cloudUrl = getShogoCloudUrl()
      const body = await c.req.text()
      const response = await fetchAnthropicWithRetry(
        `${cloudUrl}/api/ai/anthropic/v1/messages/count_tokens`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.SHOGO_API_KEY!,
            'anthropic-version': c.req.header('anthropic-version') || '2023-06-01',
            'x-shogo-client': 'desktop',
          },
          body,
          signal: c.req.raw.signal,
        },
        { label: 'shogo-cloud', signal: c.req.raw.signal },
      )
      // Self-heal on revoked / superseded device key.
      if (response.status === 401) {
        void wipeCloudKeyIfRejected('AI proxy count_tokens got 401 from Shogo Cloud')
      }
      const responseBody = await response.text()
      return new Response(responseBody, {
        status: response.status,
        headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
      })
    }

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicApiKey) {
      return c.json(
        { type: 'error', error: { type: 'api_error', message: 'Anthropic not configured.' } },
        503
      )
    }

    const body = await c.req.text()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': c.req.header('anthropic-version') || '2023-06-01',
    }

    const response = await fetchAnthropicWithRetry(
      'https://api.anthropic.com/v1/messages/count_tokens',
      {
        method: 'POST',
        headers,
        body,
        signal: c.req.raw.signal,
      },
      { label: 'anthropic', signal: c.req.raw.signal },
    )

    const responseBody = await response.text()
    return new Response(responseBody, {
      status: relayStatusForProviderError(response.status),
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
    })
  })

  /**
   * GET /ai/anthropic/v1/models - Models listing pass-through
   */
  router.get('/ai/anthropic/v1/models', async (c) => {
    const tokenPayload = await validateAnthropicAuth(c)
    if (!tokenPayload) {
      return c.json(
        { type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy token.' } },
        401
      )
    }

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicApiKey) {
      return c.json(
        { type: 'error', error: { type: 'api_error', message: 'Anthropic not configured.' } },
        503
      )
    }

    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': c.req.header('anthropic-version') || '2023-06-01',
      },
      signal: c.req.raw.signal,
    })

    const responseBody = await response.text()
    return new Response(responseBody, {
      status: relayStatusForProviderError(response.status),
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
    })
  })

  // =========================================================================
  // Image Generation Endpoints
  // =========================================================================

  /**
   * POST /ai/v1/images/generations - Text-to-image generation proxy
   *
   * Routes to OpenAI DALL-E, Google Imagen, or a local provider based on the
   * requested model. Always returns base64 JSON regardless of provider.
   */
  router.post('/ai/v1/images/generations', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    // An already-admitted chat turn still in flight is never re-gated
    // mid-message — a build that generates images mid-turn isn't interrupted.
    if (!(await isTurnInFlight(c, tokenPayload))) {
      const balanceCheck = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
        return c.json(
          { error: { message, type: 'billing_error', code, ...usageLimit } },
          402
        )
      }
    }

    let capture: Awaited<ReturnType<typeof beginCapture>> = null
    try {
      const body = await c.req.json() as {
        prompt: string
        model?: string
        size?: string
        quality?: string
        n?: number
        response_format?: string
        /** Model-specific documented fields (see list_media_models). */
        options?: Record<string, unknown>
      }

      if (!body.prompt) {
        return c.json(
          { error: { message: 'prompt is required', type: 'invalid_request_error', code: 'missing_prompt' } },
          400
        )
      }

      // dall-e-3 is retired (OpenAI, 2026-09) — "The model 'dall-e-3' does
      // not exist." Higgsfield's SOUL V2 is the default; without a Higgsfield
      // key the route falls back to gpt-image-2.5-flare.
      const model = body.model || defaultImageModel()
      const imageModel = resolveImageModel(model)
      if (!imageModel) {
        return c.json(
          { error: { message: `Image model '${model}' is not supported.`, type: 'invalid_request_error', code: 'model_not_found' } },
          400
        )
      }

      const apiKey = getImageProviderApiKey(imageModel.provider)
      if (!apiKey) {
        return c.json(
          { error: { message: `Image provider '${imageModel.provider}' is not configured on this server.`, type: 'server_error', code: 'provider_not_configured' } },
          503
        )
      }

      console.log(`[AI Proxy] 🎨 Image generation: ${tokenPayload.projectId} → ${imageModel.provider}/${imageModel.apiModel}`)

      capture = await beginCapture({
        tokenPayload,
        endpoint: 'images.generations',
        requestBody: body,
        requestedModel: model,
        resolvedModel: imageModel.apiModel,
        provider: imageModel.provider,
        stream: false,
        chatSessionId: c.req.header('x-chat-session-id') || null,
        client: c.req.header('x-shogo-client'),
        requestHeaders: c.req.raw.headers,
      })

      const signal = c.req.raw.signal
      let result: ImageGenerationResponse
      let billed = false
      if (imageModel.provider === 'openai') {
        result = await generateImageOpenAI(apiKey, imageModel.apiModel, body, signal)
      } else if (imageModel.provider === 'google') {
        result = await generateImageGoogle(apiKey, imageModel.apiModel, body, signal)
      } else if (imageModel.provider === 'local') {
        result = await generateImageLocal(imageModel.apiModel, body, signal)
      } else if (imageModel.provider === 'higgsfield' && imageModel.entry) {
        const generated = await generateImageHiggsfield(apiKey, imageModel.entry, body, signal)
        result = generated.result
        recordHiggsfieldImageUsage(
          tokenPayload,
          imageModel.entry,
          generated.charge,
          body.n || 1,
          c.req.header('x-chat-session-id') || null,
        )
        billed = true
      } else {
        return c.json(
          { error: { message: `Unsupported image provider: ${imageModel.provider}`, type: 'server_error', code: 'unsupported_provider' } },
          500
        )
      }

      if (!billed) {
        recordImageUsage(
          tokenPayload,
          imageModel.entry?.id ?? model,
          body.quality || 'standard',
          body.size || '1024x1024',
          body.n || 1,
          c.req.header('x-chat-session-id') || null,
        )
      }

      capture?.recordResponse({ status: 200, body: result, format: 'json' })
      // `model` is the catalog id that actually ran: a retired id forwarded by a
      // caller is reported as the model that replaced it.
      return c.json({ ...result, model: imageModel.entry?.id ?? model })
    } catch (error: any) {
      capture?.finish({ errorType: 'generation_error' })
      console.error('[AI Proxy] Image generation error:', error.message)
      const statusCode = mediaErrorStatus(error) || 500
      return c.json(
        { error: { message: error.message || 'Image generation failed', type: 'server_error', code: mediaErrorCode(error, 'generation_error') } },
        statusCode
      )
    }
  })

  /**
   * POST /ai/v1/images/edits - Image editing proxy (reference images + prompt)
   *
   * Accepts multipart/form-data with one or more `image` files and a prompt.
   * GPT image models go to OpenAI's /v1/images/edits; Higgsfield models upload
   * the references and send them on whichever endpoint documents a reference
   * field. The number of images is checked against the model's catalog
   * `capabilities`.
   */
  router.post('/ai/v1/images/edits', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    // An already-admitted chat turn still in flight is never re-gated
    // mid-message — a build that edits images mid-turn isn't interrupted.
    if (!(await isTurnInFlight(c, tokenPayload))) {
      const balanceCheck = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
        return c.json(
          { error: { message, type: 'billing_error', code, ...usageLimit } },
          402
        )
      }
    }

    let capture: Awaited<ReturnType<typeof beginCapture>> = null
    try {
      const formData = await c.req.formData()
      const prompt = formData.get('prompt') as string
      const imageFiles = formData.getAll('image').filter((v): v is File => typeof v !== 'string')
      const model = (formData.get('model') as string) || 'gpt-image-2.5-flare'
      const size = (formData.get('size') as string) || '1024x1024'
      const n = parseInt((formData.get('n') as string) || '1', 10)
      const quality = (formData.get('quality') as string) || 'standard'
      const rawOptions = formData.get('options')
      let options: Record<string, unknown> | undefined
      if (typeof rawOptions === 'string' && rawOptions.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawOptions)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
          options = parsed as Record<string, unknown>
        } catch {
          return c.json(
            { error: { message: 'options must be a JSON object of model-specific fields.', type: 'invalid_request_error', code: 'invalid_options' } },
            400
          )
        }
      }

      if (!prompt) {
        return c.json(
          { error: { message: 'prompt is required', type: 'invalid_request_error', code: 'missing_prompt' } },
          400
        )
      }
      if (imageFiles.length === 0) {
        return c.json(
          { error: { message: 'image file is required for edits', type: 'invalid_request_error', code: 'missing_image' } },
          400
        )
      }

      const imageModel = resolveImageModel(model)
      if (!imageModel) {
        return c.json(
          { error: { message: `Image model '${model}' is not supported.`, type: 'invalid_request_error', code: 'model_not_found' } },
          400
        )
      }
      const maxRefs = imageModel.entry?.capabilities.imageToImage ? imageModel.entry.capabilities.maxReferenceImages : 0
      if (maxRefs === 0 || (imageModel.provider !== 'openai' && imageModel.provider !== 'higgsfield')) {
        return c.json(
          { error: { message: `Image model '${model}' does not accept reference images. Call list_media_models to find one that does.`, type: 'invalid_request_error', code: 'reference_images_unsupported' } },
          400
        )
      }
      if (imageFiles.length > maxRefs) {
        return c.json(
          { error: { message: `Image model '${model}' accepts at most ${maxRefs} reference image(s); got ${imageFiles.length}.`, type: 'invalid_request_error', code: 'too_many_reference_images' } },
          400
        )
      }

      const apiKey = getImageProviderApiKey(imageModel.provider)
      if (!apiKey) {
        return c.json(
          { error: { message: `Image provider '${imageModel.provider}' is not configured on this server.`, type: 'server_error', code: 'provider_not_configured' } },
          503
        )
      }

      console.log(`[AI Proxy] 🎨 Image edit: ${tokenPayload.projectId} → ${imageModel.provider}/${imageModel.apiModel} (${imageFiles.length} reference image(s))`)

      const imageDataUris = await Promise.all(imageFiles.map(async (file) => {
        const bytes = Buffer.from(await file.arrayBuffer())
        return `data:${file.type || 'image/png'};base64,${bytes.toString('base64')}`
      }))
      capture = await beginCapture({
        tokenPayload,
        endpoint: 'images.edits',
        requestBody: { prompt, model, size, n, quality, images: imageDataUris },
        requestedModel: model,
        resolvedModel: imageModel.apiModel,
        provider: imageModel.provider,
        stream: false,
        chatSessionId: c.req.header('x-chat-session-id') || null,
        client: c.req.header('x-shogo-client'),
        requestHeaders: c.req.raw.headers,
      })

      let result: ImageGenerationResponse
      let billed = false
      if (imageModel.provider === 'higgsfield') {
        const generated = await generateImageHiggsfield(
          apiKey,
          imageModel.entry!,
          { prompt, size, quality, n, referenceImages: imageDataUris, options },
          c.req.raw.signal,
        )
        result = generated.result
        recordHiggsfieldImageUsage(
          tokenPayload,
          imageModel.entry!,
          generated.charge,
          n,
          c.req.header('x-chat-session-id') || null,
        )
        billed = true
      } else {
        // gpt-image models reject `response_format` (400 unknown_parameter)
        // and use different size tokens, same as the generations path above.
        const editModel = imageModel.apiModel
        const forwardForm = new FormData()
        if (imageFiles.length === 1) {
          forwardForm.append('image', imageFiles[0])
        } else {
          for (const file of imageFiles) forwardForm.append('image[]', file)
        }
        forwardForm.append('prompt', prompt)
        forwardForm.append('model', editModel)
        forwardForm.append('size', normalizeSizeForModel(editModel, size))
        forwardForm.append('n', String(n))
        const editQuality = normalizeQualityForModel(editModel, quality)
        if (editQuality) forwardForm.append('quality', editQuality)
        if (!editModel.startsWith('gpt-image')) forwardForm.append('response_format', 'b64_json')

        const response = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: forwardForm,
          signal: c.req.raw.signal,
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`OpenAI image edit error (${response.status}): ${errorText}`)
        }

        result = await response.json() as ImageGenerationResponse
      }

      if (!billed) {
        recordImageUsage(tokenPayload, imageModel.entry?.id ?? model, quality, size, n, c.req.header('x-chat-session-id') || null)
      }

      capture?.recordResponse({ status: 200, body: result, format: 'json' })
      return c.json({ ...result, model: imageModel.entry?.id ?? imageModel.apiModel })
    } catch (error: any) {
      capture?.finish({ errorType: 'edit_error' })
      console.error('[AI Proxy] Image edit error:', error.message)
      const statusCode = mediaErrorStatus(error) || 500
      return c.json(
        { error: { message: error.message || 'Image edit failed', type: 'server_error', code: mediaErrorCode(error, 'edit_error') } },
        statusCode
      )
    }
  })

  /**
   * GET /ai/v1/media/models - Image and video models this server can run,
   * with their endpoints, every documented option and a Shogo (marked-up)
   * price. Backs the `list_media_models` tool so agents can pick a model and
   * budget a batch before generating. Models whose provider has no key are
   * omitted. `?model=` narrows to one model, `?kind=image|video` to one kind.
   */
  router.get('/ai/v1/media/models', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }
    const kind = c.req.query('kind')
    if (kind !== undefined && kind !== 'image' && kind !== 'video') {
      return c.json(
        { error: { message: "kind must be 'image' or 'video'.", type: 'invalid_request_error', code: 'invalid_kind' } },
        400
      )
    }
    return c.json(await listMediaModels(c.req.raw.signal, { model: c.req.query('model'), kind }))
  })

  /**
   * GET /ai/v1/media/presets - Genjutsu Restyle style presets (id, name,
   * preview). Restyle requires one of these ids as `preset_id`; they are
   * fetched live because the catalog changes.
   */
  router.get('/ai/v1/media/presets', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }
    const apiKey = getImageProviderApiKey('higgsfield')
    if (!apiKey) {
      return c.json(
        { error: { message: "Media provider 'higgsfield' is not configured on this server.", type: 'server_error', code: 'provider_not_configured' } },
        503
      )
    }
    try {
      return c.json({ presets: await higgsfieldPresets(apiKey, c.req.raw.signal) })
    } catch (error: any) {
      console.error('[AI Proxy] Preset listing error:', error.message)
      return c.json(
        { error: { message: error.message || 'Listing presets failed', type: 'server_error', code: mediaErrorCode(error, 'presets_error') } },
        mediaErrorStatus(error) || 502
      )
    }
  })

  /**
   * POST /ai/v1/media/estimate - What a generation would cost, without
   * generating it. Free (Higgsfield's `/estimate` is free), and never creates a
   * job or a charge. Agents and the live tests use this to budget before
   * spending.
   */
  router.post('/ai/v1/media/estimate', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }
    const invalid = (message: string, code: string) =>
      c.json({ error: { message, type: 'invalid_request_error', code } }, 400)
    try {
      const body = await c.req.json() as {
        model?: string
        kind?: 'image' | 'video'
        duration?: number
        resolution?: string
        aspect_ratio?: string
        size?: string
        quality?: string
        prompt?: string
        audio?: boolean
        source_video_url?: string
        source_duration_seconds?: number
        preset_id?: string
        options?: Record<string, unknown>
      }
      const videoEntry = body.kind !== 'image' && body.model ? getVideoModelEntry(body.model) : undefined
      const imageEntry = body.kind !== 'video' && body.model ? resolveImageModel(body.model)?.entry : undefined
      if (!body.model) return invalid('model is required', 'missing_model')
      if (!videoEntry && !imageEntry) return invalid(`Unknown or retired model '${body.model}'.`, 'model_not_found')

      if (videoEntry) {
        const apiKey = getImageProviderApiKey(videoEntry.provider)
        if (!apiKey) {
          return c.json({ error: { message: `Video provider '${videoEntry.provider}' is not configured on this server.`, type: 'server_error', code: 'provider_not_configured' } }, 503)
        }
        const duration = body.duration ?? videoEntry.defaultDuration
        if (videoEntry.durations.length > 0 && !videoEntry.durations.includes(duration)) {
          return invalid(
            `${videoEntry.displayName} supports durations ${describeDurationMenu(videoEntry.durations)} seconds; got ${duration}.`,
            'invalid_duration',
          )
        }
        if (videoEntry.sourceVideo) {
          // Genjutsu quotes a prose rate card rather than a `usd` figure, so
          // price it from the vendor's per-second table times the clip length.
          const seconds = body.source_duration_seconds
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
            return invalid(
              `${videoEntry.displayName} is billed per source second: pass source_duration_seconds (the clip's length).`,
              'missing_source_duration',
            )
          }
          const resolution = body.resolution ?? videoEntry.defaultResolution ?? '720p'
          const billedSeconds = Math.min(seconds, videoEntry.maxSourceSeconds ?? 30)
          const charge = calculateGenjutsuUsageCost(videoEntry.usdPerSecondByResolution, resolution, billedSeconds)
          if (!charge) {
            return invalid(`Cannot price ${videoEntry.displayName} at ${resolution}.`, 'estimate_unavailable')
          }
          return c.json({
            model: videoEntry.id,
            provider: 'higgsfield',
            unit: 'second',
            duration: billedSeconds,
            resolution,
            raw_usd: roundUsd(charge.rawUsd),
            usd: roundUsd(charge.billedUsd),
            source: 'rate_card',
          })
        }
        // The vendor's schema requires a prompt even to quote a price; its
        // content does not change the number.
        const request = buildHiggsfieldVideoRequest(videoEntry, {
          prompt: body.prompt || 'a product rotating on a table, studio light',
          duration,
          resolution: body.resolution,
          aspectRatio: body.aspect_ratio,
          audio: body.audio,
          options: body.options,
        })
        const estimate = await higgsfieldEstimate(apiKey, request.endpoint, request.input, c.req.raw.signal)
        const charge = higgsfieldCharge(estimate.rawUsd)
        if (!charge) {
          return c.json({ error: { message: 'Higgsfield returned no price for this request.', type: 'server_error', code: 'estimate_unavailable' } }, 503)
        }
        return c.json({ model: videoEntry.id, provider: 'higgsfield', unit: 'clip', duration, raw_usd: roundUsd(charge.rawUsd), usd: roundUsd(charge.billedUsd), credits: estimate.credits, source: 'estimate' })
      }

      const entry = imageEntry!
      const apiKey = getImageProviderApiKey(entry.provider)
      if (!apiKey) {
        return c.json({ error: { message: `Image provider '${entry.provider}' is not configured on this server.`, type: 'server_error', code: 'provider_not_configured' } }, 503)
      }
      if (entry.provider === 'higgsfield') {
        const request = buildHiggsfieldImageRequest(entry, {
          prompt: 'a product photo',
          size: body.size,
          quality: body.quality,
          options: body.options,
        })
        const estimate = await higgsfieldEstimate(apiKey, request.endpoint, request.input, c.req.raw.signal)
        const charge = higgsfieldCharge(estimate.rawUsd)
        if (!charge) {
          return c.json({ error: { message: 'Higgsfield returned no price for this image.', type: 'server_error', code: 'estimate_unavailable' } }, 503)
        }
        return c.json({ model: entry.id, provider: 'higgsfield', unit: 'image', raw_usd: roundUsd(charge.rawUsd), usd: roundUsd(charge.billedUsd), credits: estimate.credits, source: 'estimate' })
      }
      const charge = calculateImageUsageCost(entry.id, body.quality || 'standard', body.size || '1024x1024')
      return c.json({ model: entry.id, provider: entry.provider, unit: 'image', raw_usd: roundUsd(charge.rawUsd), usd: roundUsd(charge.billedUsd), source: 'catalog' })
    } catch (error: any) {
      console.error('[AI Proxy] Media estimate error:', error.message)
      return c.json(
        { error: { message: error.message || 'Estimate failed', type: 'server_error', code: mediaErrorCode(error, 'estimate_error') } },
        mediaErrorStatus(error) || 502
      )
    }
  })

  /**
   * POST /ai/v1/media/uploads - Put bytes on the media provider's storage and
   * return the public URL the generation endpoints require. Raw body (not
   * multipart) with the real `Content-Type`; cap is the provider's 200 MiB
   * input limit. Used for Genjutsu source clips, which are too large to base64
   * through the JSON routes.
   */
  router.post('/ai/v1/media/uploads', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }
    const apiKey = getImageProviderApiKey('higgsfield')
    if (!apiKey) {
      return c.json(
        { error: { message: "Media provider 'higgsfield' is not configured on this server.", type: 'server_error', code: 'provider_not_configured' } },
        503
      )
    }
    const contentType = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!HIGGSFIELD_UPLOAD_CONTENT_TYPES.has(contentType)) {
      return c.json(
        { error: { message: `Unsupported upload type '${contentType || 'unknown'}'. Use one of: ${[...HIGGSFIELD_UPLOAD_CONTENT_TYPES].join(', ')}.`, type: 'invalid_request_error', code: 'unsupported_content_type' } },
        400
      )
    }
    try {
      // The provider caps input media at 200 MiB; refuse before buffering a
      // larger body, and never let an unbounded upload into memory.
      const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
      const declaredLength = Number(c.req.header('content-length') || 0)
      if (declaredLength > MAX_UPLOAD_BYTES) {
        return c.json(
          { error: { message: `Upload is ${(declaredLength / (1024 * 1024)).toFixed(1)} MB; the limit is 200 MB.`, type: 'invalid_request_error', code: 'upload_too_large' } },
          413
        )
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (bytes.byteLength === 0) {
        return c.json({ error: { message: 'Upload body is empty.', type: 'invalid_request_error', code: 'empty_body' } }, 400)
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return c.json(
          { error: { message: `Upload is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; the limit is 200 MB.`, type: 'invalid_request_error', code: 'upload_too_large' } },
          413
        )
      }
      const { publicUrl } = await higgsfieldUpload(apiKey, bytes, contentType, c.req.raw.signal)
      return c.json({ url: publicUrl, content_type: contentType, bytes: bytes.byteLength })
    } catch (error: any) {
      console.error('[AI Proxy] Media upload error:', error.message)
      return c.json(
        { error: { message: error.message || 'Upload failed', type: 'server_error', code: mediaErrorCode(error, 'upload_error') } },
        mediaErrorStatus(error) || 502
      )
    }
  })

  // =========================================================================
  // Video Generation Endpoints (Higgsfield)
  // =========================================================================

  /**
   * POST /ai/v1/videos/generations - Submit a video job.
   *
   * Body: `{ prompt, model, duration?, aspect_ratio?, resolution?, audio?,
   * start_image?, reference_images?, source_video_url?, preset_id?, options? }`
   * with images as data URIs (or public URLs). `options` carries model-specific
   * fields (`cfg_scale`, `multi_shots`, `multi_prompt`, `seed`, …) — the proxy
   * validates each against the endpoint's documented schema. Returns `{ id }`
   * right away; poll `GET /ai/v1/videos/:id`. Nothing is charged until the job
   * completes, and a failed / NSFW / canceled job is never charged.
   */
  router.post('/ai/v1/videos/generations', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    if (!(await isTurnInFlight(c, tokenPayload))) {
      const balanceCheck = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
        return c.json({ error: { message, type: 'billing_error', code, ...usageLimit } }, 402)
      }
    }

    const invalid = (message: string, code: string) =>
      c.json({ error: { message, type: 'invalid_request_error', code } }, 400)

    try {
      const body = await c.req.json() as {
        prompt?: string
        model?: string
        duration?: number
        aspect_ratio?: string
        resolution?: string
        audio?: boolean
        start_image?: string
        reference_images?: string[]
        source_video_url?: string
        source_duration_seconds?: number
        preset_id?: string
        genjutsu?: string
        /** Model-specific documented fields (see list_media_models). */
        options?: Record<string, unknown>
      }
      if (body.genjutsu && !GENJUTSU_MODEL_BY_WORKFLOW[body.genjutsu]) {
        return invalid(`genjutsu must be one of ${Object.keys(GENJUTSU_MODEL_BY_WORKFLOW).join(', ')}; got '${body.genjutsu}'.`, 'invalid_genjutsu')
      }
      const modelId = body.model || (body.genjutsu ? GENJUTSU_MODEL_BY_WORKFLOW[body.genjutsu] : defaultVideoModel())
      const entry = getVideoModelEntry(modelId)
      if (!entry) return invalid(`Video model '${modelId}' is not supported. Call list_media_models for the list.`, 'model_not_found')
      if (body.genjutsu && entry.genjutsu !== body.genjutsu) {
        return invalid(
          `${entry.displayName} is not the '${body.genjutsu}' workflow${entry.genjutsu ? ` (it is '${entry.genjutsu}')` : ''}.`,
          'genjutsu_model_mismatch',
        )
      }

      const prompt = (body.prompt ?? '').trim()
      if (!prompt && !entry.sourceVideo) return invalid('prompt is required', 'missing_prompt')

      // A Genjutsu edit's length is the source clip's; everything else has a
      // duration menu the model documents. The list is a range for the newer
      // families (Kling 3.0 documents 3–15 s), so it reads as one number.
      const duration = entry.sourceVideo ? 0 : body.duration ?? entry.defaultDuration
      /** Billed length of a Genjutsu source clip, in seconds. */
      let sourceSeconds: number | undefined
      if (!entry.sourceVideo && !entry.durations.includes(duration)) {
        return invalid(
          `${entry.displayName} supports durations ${describeDurationMenu(entry.durations)} seconds; got ${duration}.`,
          'invalid_duration',
        )
      }
      if (entry.sourceVideo) {
        if (!body.source_video_url) {
          return invalid(`${entry.displayName} edits a clip: pass source_video (a workspace video) or source_video_url.`, 'missing_source_video')
        }
        if (!/^https:\/\//i.test(body.source_video_url)) {
          return invalid('source_video_url must be a public https URL.', 'invalid_source_video')
        }
        if (entry.genjutsu === 'restyle' && !body.preset_id) {
          return invalid('Genjutsu Restyle needs a preset_id from GET /ai/v1/media/presets.', 'missing_preset_id')
        }
        // These workflows are billed per source second, and the vendor quotes
        // no usable number up front, so the length has to come from the caller.
        // Without it we would bill zero — refuse instead.
        const declared = body.source_duration_seconds
        if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) {
          return invalid(
            `${entry.displayName} is billed per source second: pass source_duration_seconds (the clip's length).`,
            'missing_source_duration',
          )
        }
        const minSeconds = entry.minSourceSeconds ?? 4
        if (declared < minSeconds) {
          return invalid(`The source clip is ${declared.toFixed(1)} s; ${entry.displayName} needs at least ${minSeconds} s.`, 'source_too_short')
        }
        // The provider trims anything longer than its max, so bill the trimmed length.
        sourceSeconds = Math.min(declared, entry.maxSourceSeconds ?? 30)
      }
      if (body.start_image !== undefined) {
        const acceptable = typeof body.start_image === 'string'
          && (body.start_image.startsWith('data:image/') || /^https:\/\//i.test(body.start_image))
        if (!acceptable) return invalid('start_image must be an image data URI or an https URL', 'invalid_start_image')
        if (!entry.imageToVideoApiModel) return invalid(`${entry.displayName} does not support image-to-video.`, 'image_to_video_unsupported')
      }
      const refs = body.reference_images ?? []
      if (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string' || !(r.startsWith('data:image/') || /^https:\/\//i.test(r)))) {
        return invalid('reference_images must be image data URIs or https URLs', 'invalid_reference_images')
      }
      if (refs.length > entry.maxReferenceImages) {
        return invalid(
          entry.maxReferenceImages === 0
            ? `${entry.displayName} does not accept reference images.`
            : `${entry.displayName} accepts at most ${entry.maxReferenceImages} reference image(s); got ${refs.length}.`,
          'too_many_reference_images',
        )
      }
      if (entry.sourceVideo && entry.genjutsu !== 'restyle' && refs.length === 0) {
        return invalid(`${entry.displayName} needs at least 1 reference image (the subject to drive or swap in).`, 'missing_reference_images')
      }

      const apiKey = getImageProviderApiKey(entry.provider)
      if (!apiKey) {
        return c.json(
          { error: { message: `Video provider '${entry.provider}' is not configured on this server.`, type: 'server_error', code: 'provider_not_configured' } },
          503
        )
      }

      const signal = c.req.raw.signal
      const id = `vid_${randomUUID()}`
      const audio = body.audio === true

      // Higgsfield: input media must be public URLs, so data URIs are uploaded
      // first (the API key stays server-side). The price is settled before we
      // submit: a job we cannot price is refused, never run for free.
      const referenceUrls = await Promise.all(refs.map((ref) => higgsfieldEnsurePublicUrl(apiKey, ref, signal)))
      const startImageUrl = body.start_image
        ? await higgsfieldEnsurePublicUrl(apiKey, body.start_image, signal)
        : undefined
      const request = buildHiggsfieldVideoRequest(entry, {
        prompt: prompt || undefined,
        duration: entry.sourceVideo ? undefined : duration,
        aspectRatio: body.aspect_ratio,
        resolution: body.resolution,
        audio: body.audio,
        startImageUrl,
        referenceUrls,
        sourceVideoUrl: body.source_video_url,
        presetId: body.preset_id,
        options: body.options,
      })
      // What the request actually carries, not what was asked for: a model whose
      // audio field is absent reports false even if `audio` was sent.
      const sentResolution = (request.input.resolution as string | undefined) ?? entry.defaultResolution ?? '720p'

      let charge: { rawUsd: number; billedUsd: number } | null
      let credits: number | undefined
      if (entry.genjutsu) {
        // Genjutsu answers `/estimate` with a prose rate card, not a `usd`
        // figure, so price it from the vendor's per-second table instead.
        charge = calculateGenjutsuUsageCost(entry.usdPerSecondByResolution, sentResolution, sourceSeconds!)
        if (!charge) {
          return invalid(
            `Cannot price ${entry.displayName} at ${sentResolution}; supported resolutions are ${(entry.resolutions ?? []).join(', ')}.`,
            'estimate_unavailable',
          )
        }
      } else {
        const estimate = await higgsfieldEstimate(apiKey, request.endpoint, request.input, signal).catch(() => null)
        charge = higgsfieldCharge(estimate?.rawUsd ?? null)
        credits = estimate?.credits
        if (!charge) {
          return c.json(
            { error: { message: 'Higgsfield did not return a price for this request. Nothing was submitted or charged; try again.', type: 'server_error', code: 'estimate_unavailable' } },
            503,
          )
        }
      }

      const submission = await higgsfieldSubmit(apiKey, request.endpoint, request.input, { idempotencyKey: id, signal })
      const billedDuration = entry.sourceVideo ? sourceSeconds! : duration

      await putVideoJob({
        id,
        provider: 'higgsfield',
        workspaceId: tokenPayload.workspaceId,
        projectId: tokenPayload.projectId,
        userId: tokenPayload.userId,
        chatSessionId: c.req.header('x-chat-session-id') || null,
        model: entry.id,
        endpoint: request.endpoint,
        statusUrl: submission.statusUrl,
        requestId: submission.requestId,
        estimate: { rawUsd: charge.rawUsd, billedUsd: charge.billedUsd, ...(credits !== undefined ? { credits } : {}) },
        duration: billedDuration,
        audio: audio && !!entry.audio,
        aspectRatio: body.aspect_ratio,
        resolution: sentResolution,
        ...(entry.sourceVideo ? { sourceVideo: true } : {}),
        imageToVideo: !!body.start_image,
        createdAt: Date.now(),
      })
      console.log(`[AI Proxy] 🎬 Video job ${id}: ${tokenPayload.projectId} → ${request.endpoint} (${billedDuration}s${audio && entry.audio ? ', audio' : ''}${entry.sourceVideo ? ', source clip' : ''}, $${charge.billedUsd.toFixed(3)})`)

      return c.json({
        id,
        status: 'queued',
        model: entry.id,
        duration: billedDuration,
        audio: audio && !!entry.audio,
        provider: 'higgsfield',
        estimated_usd: roundUsd(charge.billedUsd),
        price_source: entry.genjutsu ? 'rate_card' : 'estimate',
      })
    } catch (error: any) {
      console.error('[AI Proxy] Video submit error:', error.message)
      const statusCode = mediaErrorStatus(error) || (error.message?.includes('422') ? 400 : 502)
      return c.json(
        { error: { message: error.message || 'Video submission failed', type: 'server_error', code: mediaErrorCode(error, 'video_submit_error') } },
        statusCode
      )
    }
  })

  /**
   * GET /ai/v1/videos/:id - Status of a video job. When it has completed,
   * returns the video URL and charges for it, exactly once per job id no
   * matter how many times (or on how many pods) it is polled.
   */
  router.get('/ai/v1/videos/:id', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    const id = c.req.param('id')
    const job = await getVideoJob(id)
    if (!job || job.workspaceId !== tokenPayload.workspaceId) {
      return c.json({ error: { message: `Video job '${id}' not found.`, type: 'invalid_request_error', code: 'job_not_found' } }, 404)
    }
    const entry = getVideoModelEntry(job.model)
    const apiKey = getImageProviderApiKey(entry?.provider ?? job.provider)
    if (!entry || !apiKey) {
      return c.json(
        { error: { message: `Video provider '${job.provider}' is not configured on this server.`, type: 'server_error', code: 'provider_not_configured' } },
        503
      )
    }

    const base = { id, model: job.model, duration: job.duration, audio: job.audio, created_at: job.createdAt }

    if (job.provider === 'higgsfield') {
      try {
        const status = await higgsfieldStatus(apiKey, job.statusUrl, c.req.raw.signal)
        if (status.status === 'completed') {
          if (!status.videoUrl) {
            return c.json({ ...base, status: 'failed', error: 'The provider finished without returning a video.' })
          }
          if (await claimVideoCharge(id)) {
            recordHiggsfieldVideoUsage(
              tokenPayload,
              job,
              c.req.header('x-chat-session-id') || job.chatSessionId || null,
            )
          }
          return c.json({
            ...base,
            status: 'completed',
            video: { url: status.videoUrl, content_type: 'video/mp4' },
          })
        }
        if (status.status === 'failed' || status.status === 'nsfw' || status.status === 'canceled') {
          // Not charged: the provider refunds these, so billing them would overcharge.
          const reason = status.error
            ?? (status.status === 'nsfw' ? 'The provider blocked this clip (content policy).' : `The provider ${status.status} the request.`)
          return c.json({ ...base, status: 'failed', error: reason })
        }
        return c.json({ ...base, status: status.status === 'queued' ? 'queued' : 'in_progress' })
      } catch (error: any) {
        const message: string = error.message || 'Video status check failed'
        if (error instanceof HiggsfieldError && (error.code === 'validation' || error.code === 'timeout')) {
          return c.json({ ...base, status: 'failed', error: message })
        }
        console.error(`[AI Proxy] Video status error for ${id}:`, message)
        return c.json({ error: { message, type: 'server_error', code: mediaErrorCode(error, 'video_status_error') } }, mediaErrorStatus(error) || 502)
      }
    }

    return c.json(
      { error: { message: `Video job '${id}' has no provider.`, type: 'server_error', code: 'provider_not_configured' } },
      503
    )
  })

  // =========================================================================
  // 3D Endpoints (Tripo3D V3) — generation, post-processing, rigging
  // =========================================================================

  /** Texture quality levels the texture-bearing ops accept. */
  const TRIPO_TEXTURE_QUALITIES = new Set(['fast', 'standard', 'detailed', 'extreme'])
  /** Generation ops resolve `model` through Shogo's catalog; the rest pass a vendor version through. */
  const TRIPO_GENERATION_OPS = new Set<string>(['text_to_model', 'image_to_model', 'multiview_to_model'])
  /** Body keys that are the route's own, not op parameters. */
  const TRIPO_CORE_FIELDS = new Set(['op', 'prompt', 'image', 'images', 'input', 'model'])
  /** JSON upload cap for `POST /ai/v1/3d/files` (Tripo's own image limit). */
  const TRIPO_FILE_MAX_BYTES = 25 * 1024 * 1024

  const tripoOpList = Object.keys(TRIPO_OPS).join(', ')

  /**
   * `input` for a post-process op: a task id, a file token or an https URL
   * forwards untouched; anything else (a data URI or raw base64) is uploaded
   * and replaced by its `file_token`.
   */
  /** A `gen3d_…` job id from this proxy → the vendor task it wraps. */
  async function resolve3dJobRef(
    value: string,
    workspaceId: string,
  ): Promise<string | undefined> {
    if (!value.startsWith('gen3d_')) return undefined
    const job = await get3dJob(value)
    return job && job.workspaceId === workspaceId ? job.taskId : undefined
  }

  async function resolveTripoModelInput(
    apiKey: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<{ input: string } | { error: string; code: string }> {
    if (isTaskId(value) || isFileToken(value) || isHttpsUrl(value)) return { input: value }
    if (!value.startsWith('data:')) {
      return { error: 'input must be a task id, a file_token, an https URL or a data URI', code: 'invalid_input' }
    }
    const { bytes, contentType } = parseDataUri(value)
    try {
      return { input: await tripoUploadFile(apiKey, bytes, contentType, undefined, signal) }
    } catch (err: any) {
      return { error: err.message || 'Upload failed', code: 'upload_failed' }
    }
  }

  /** Same, for a single image (image-to-model, texture style image). */
  async function resolveTripoImageInput(
    apiKey: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<{ input: string } | { error: string; code: string }> {
    if (isFileToken(value) || isHttpsUrl(value)) return { input: value }
    if (!value.startsWith('data:')) {
      return { error: 'image must be an image data URI, a file_token or an https URL', code: 'invalid_image' }
    }
    const { bytes, contentType } = parseDataUri(value)
    if (!/^image\/(png|jpeg|webp)$/.test(contentType)) {
      return { error: 'image data URI must be PNG, JPEG or WebP', code: 'invalid_image' }
    }
    try {
      return { input: await tripoUploadFile(apiKey, bytes, contentType, undefined, signal) }
    } catch (err: any) {
      return { error: err.message || 'Upload failed', code: 'upload_failed' }
    }
  }

  /**
   * GET /ai/v1/3d/models - 3D models this server can run, with capabilities
   * and Shogo (marked-up) price, plus the operations and their credit
   * estimates so a caller can budget before spending. Empty when no Tripo key
   * is configured.
   */
  router.get('/ai/v1/3d/models', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    const configured = !!getNativeProviderApiKeySync('tripo')
    const models = configured
      ? Object.values(TRIPO_MODELS).map((entry) => {
          const text = estimateTripoTaskCost({ op: 'text_to_model', model: entry.id, textureQuality: 'standard' })
          const bare = estimateTripoTaskCost({ op: 'text_to_model', model: entry.id, texture: false })
          return {
            id: entry.id,
            name: entry.name,
            text_to_model: entry.textToModel,
            image_to_model: entry.imageToModel,
            multiview_to_model: true,
            price: {
              unit: 'model',
              usd: roundUsd(text.billedUsd),
              untextured_usd: roundUsd(bare.billedUsd),
            },
          }
        })
      : []

    const operations = configured
      ? (Object.entries(TRIPO_OPS) as Array<[TripoOp, (typeof TRIPO_OPS)[TripoOp]]>).map(([op, spec]) => ({
          op,
          input: spec.input === 'prompt' ? 'text' : spec.input,
          produces: spec.produces,
          estimated_credits: estimateTripoCredits(op, {}),
        }))
      : []

    return c.json({
      models,
      operations,
      currency: 'USD',
      note: 'Prices include the Shogo markup and are what the workspace is charged. Billing follows the credits each finished task reports; a free task (rig check) costs nothing.',
    })
  })

  /**
   * POST /ai/v1/3d/files - Upload an image or model for a later op.
   *
   * Body `{ filename, contentType, data_base64 }` → `{ file_token }`. JSON
   * base64 keeps this a single-request hop for runtimes; anything over 25 MB
   * gets a 413 with the limit spelled out (Tripo wants its large-file flow).
   */
  router.post('/ai/v1/3d/files', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    const apiKey = getNativeProviderApiKeySync('tripo')
    if (!apiKey) {
      return c.json(
        { error: { message: "3D provider 'tripo' is not configured on this server.", type: 'server_error', code: 'provider_not_configured' } },
        503
      )
    }

    try {
      const body = await c.req.json() as { filename?: string; contentType?: string; data_base64?: string }
      if (typeof body.data_base64 !== 'string' || !body.data_base64) {
        return c.json(
          { error: { message: 'data_base64 is required', type: 'invalid_request_error', code: 'missing_file' } },
          400
        )
      }
      const bytes = Buffer.from(body.data_base64, 'base64')
      if (bytes.length > TRIPO_FILE_MAX_BYTES) {
        return c.json(
          {
            error: {
              message: `File is ${(bytes.length / 1024 / 1024).toFixed(1)}MB; this route accepts ${TRIPO_FILE_MAX_BYTES / 1024 / 1024}MB.`,
              type: 'invalid_request_error',
              code: 'file_too_large',
            },
          },
          413
        )
      }
      const contentType = body.contentType || 'application/octet-stream'
      const fileToken = await tripoUploadFile(apiKey, bytes, contentType, body.filename, c.req.raw.signal)
      return c.json({ file_token: fileToken, bytes: bytes.length, content_type: contentType })
    } catch (error: any) {
      console.error('[AI Proxy] 3D upload error:', error.message)
      const upstream: number | undefined = error instanceof TripoApiError ? error.status : undefined
      const statusCode = upstream !== undefined && upstream >= 400 && upstream < 500 ? 400 : 502
      return c.json(
        { error: { message: error.message || 'Upload failed', type: 'server_error', code: '3d_upload_error' } },
        statusCode
      )
    }
  })

  /**
   * POST /ai/v1/3d/generations - Submit a Tripo3D task.
   *
   * Body `{ op?, prompt?, image?, images?, input?, model?, ...opParams }`.
   * `op` defaults from the input shape (prompt → text_to_model, image →
   * image_to_model); every other op must be explicit. Each op accepts only
   * the fields in `TRIPO_OPS[op].fields` — anything else is a 400, so a typo
   * never becomes a silent extra charge.
   */
  router.post('/ai/v1/3d/generations', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    if (!(await isTurnInFlight(c, tokenPayload))) {
      const balanceCheck = await billingService.checkUsageBalance(tokenPayload.workspaceId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
        return c.json({ error: { message, type: 'billing_error', code, ...usageLimit } }, 402)
      }
    }

    const invalid = (message: string, code: string) =>
      c.json({ error: { message, type: 'invalid_request_error', code } }, 400)

    try {
      const body = await c.req.json() as Record<string, unknown>
      const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
      const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined
      const image = str(body.image)
      const images = Array.isArray(body.images) ? body.images as unknown[] : undefined
      const input = str(body.input)

      if (prompt && image) return invalid('Send either prompt or image, not both.', 'prompt_and_image')

      let op = str(body.op) as TripoOp | undefined
      if (!op) {
        if (prompt && !image && !images && !input) op = 'text_to_model'
        else if (image && !prompt && !images && !input) op = 'image_to_model'
        else return invalid(`op is required here. Supported ops: ${tripoOpList}.`, 'missing_op')
      }
      const spec = TRIPO_OPS[op]
      if (!spec) return invalid(`Unknown op '${op}'. Supported ops: ${tripoOpList}.`, 'unknown_op')

      const unknown = Object.keys(body).filter((key) => !TRIPO_CORE_FIELDS.has(key) && !spec.fields.includes(key))
      if (unknown.length > 0) {
        return invalid(`Unsupported field(s) for ${op}: ${unknown.join(', ')}.`, 'unsupported_field')
      }

      if (body.texture_quality !== undefined && !TRIPO_TEXTURE_QUALITIES.has(String(body.texture_quality))) {
        return invalid(`texture_quality must be one of ${[...TRIPO_TEXTURE_QUALITIES].join(', ')}.`, 'invalid_texture_quality')
      }
      if (body.face_limit !== undefined && (!Number.isInteger(body.face_limit) || (body.face_limit as number) <= 0)) {
        return invalid('face_limit must be a positive integer', 'invalid_face_limit')
      }

      // Per-op required input.
      if (spec.input === 'prompt' && !prompt) return invalid('prompt is required for text_to_model', 'missing_prompt')
      if (spec.input === 'image' && !image) return invalid('image is required for image_to_model', 'missing_image')
      if (spec.input === 'images') {
        if (!images || images.length !== 4) {
          return invalid(
            'multiview_to_model needs exactly 4 images in the order front, left, back, right.',
            'invalid_images',
          )
        }
        if (images.some((img) => typeof img !== 'string' || !img)) return invalid('images must be strings', 'invalid_images')
      }
      if (spec.input === 'model' && !input) return invalid(`input is required for ${op} (task id, file_token, URL or data URI)`, 'missing_input')

      if (op === 'convert') {
        const format = str(body.format)?.toUpperCase()
        if (!format) return invalid('format is required for convert', 'missing_format')
        if (!(TRIPO_CONVERT_FORMATS as readonly string[]).includes(format)) {
          return invalid(`format must be one of ${TRIPO_CONVERT_FORMATS.join(', ')}.`, 'unsupported_format')
        }
        body.format = format
      }
      if (op === 'retarget') {
        const animation = str(body.animation)
        const list = Array.isArray(body.animations) ? body.animations as unknown[] : undefined
        if (animation && list) return invalid('Send either animation or animations, not both.', 'invalid_animation')
        if (!animation && !list) return invalid('animation or animations is required for retarget', 'missing_animation')
        if (list && (list.length === 0 || list.length > TRIPO_MAX_ANIMATIONS || list.some((a) => typeof a !== 'string'))) {
          return invalid(`animations takes 1-${TRIPO_MAX_ANIMATIONS} preset ids.`, 'too_many_animations')
        }
      }

      // Generation ops price and name a model from Shogo's catalog; every
      // other op forwards its own vendor version through `fields`.
      const isGeneration = TRIPO_GENERATION_OPS.has(op)
      let jobModel = ''
      let wireModel: string | undefined
      if (isGeneration) {
        const modelId = str(body.model) || DEFAULT_TRIPO_MODEL
        const entry = getTripoModel(modelId)
        if (!entry) return invalid(`3D model '${modelId}' is not supported.`, 'model_not_found')
        jobModel = entry.id
        wireModel = entry.apiModel
      } else if (body.model !== undefined) {
        jobModel = String(body.model)
      }

      const apiKey = getNativeProviderApiKeySync('tripo')
      if (!apiKey) {
        return c.json(
          { error: { message: "3D provider 'tripo' is not configured on this server.", type: 'server_error', code: 'provider_not_configured' } },
          503
        )
      }

      // Forward only what the caller set: Tripo's own defaults are the right
      // ones when a field is absent.
      const wire: Record<string, unknown> = {}
      for (const field of spec.fields) {
        if (body[field] !== undefined) wire[field] = body[field]
      }
      if (wireModel) wire.model = wireModel
      // The animations endpoints have no usable default rig model: omitting it
      // makes Tripo fall back to a retired version and reject the task.
      if (op === 'rig' && wire.model === undefined) wire.model = DEFAULT_TRIPO_RIG_MODEL

      if (spec.input === 'prompt') {
        wire.prompt = prompt
      } else if (spec.input === 'image') {
        const resolved = await resolveTripoImageInput(apiKey, image!, c.req.raw.signal)
        if ('error' in resolved) return invalid(resolved.error, resolved.code)
        wire.input = resolved.input
      } else if (spec.input === 'images') {
        const resolvedImages: string[] = []
        for (const img of images!) {
          const resolved = await resolveTripoImageInput(apiKey, String(img), c.req.raw.signal)
          if ('error' in resolved) return invalid(resolved.error, resolved.code)
          resolvedImages.push(resolved.input)
        }
        wire.inputs = resolvedImages
      } else {
        // A job id from a previous call is the natural handle for edit ops.
        const priorTask = await resolve3dJobRef(input!, tokenPayload.workspaceId)
        if (input!.startsWith('gen3d_') && !priorTask) {
          return invalid(`3D job '${input}' was not found in this workspace.`, 'input_not_found')
        }
        const resolved = await resolveTripoModelInput(apiKey, priorTask ?? input!, c.req.raw.signal)
        if ('error' in resolved) return invalid(resolved.error, resolved.code)
        wire.input = resolved.input
      }

      const taskId = await tripoCreateTask(apiKey, spec.path, wire, c.req.raw.signal)
      // The registry's estimate reads the same body shape the caller sent.
      const estimatedCredits = estimateTripoCredits(op, { ...body, model: jobModel || body.model })

      const id = `gen3d_${randomUUID()}`
      await put3dJob({
        id,
        workspaceId: tokenPayload.workspaceId,
        projectId: tokenPayload.projectId,
        userId: tokenPayload.userId,
        chatSessionId: c.req.header('x-chat-session-id') || null,
        model: jobModel,
        op,
        taskId,
        input: spec.input === 'prompt' ? 'text' : spec.input,
        texture: body.pbr === true ? true : body.texture !== false,
        textureQuality: str(body.texture_quality),
        estimatedCredits,
        createdAt: Date.now(),
      })
      console.log(`[AI Proxy] 🧊 3D ${op} ${id}: ${tokenPayload.projectId} → tripo${spec.path} (task ${taskId}, ~${estimatedCredits} credits)`)

      return c.json({
        id,
        op,
        status: 'queued',
        model: jobModel || undefined,
        estimated_credits: estimatedCredits,
        estimated_usd: roundUsd(estimatedCredits * TRIPO_USD_PER_CREDIT * 1.2),
      })
    } catch (error: any) {
      console.error('[AI Proxy] 3D submit error:', error.message)
      // A rejected request (bad prompt/params) is the caller's, not ours: pass
      // Tripo's 4xx through so the runtime sees 400 rather than 502.
      const upstream: number | undefined = error instanceof TripoApiError ? error.status : undefined
      const statusCode = upstream === 429 ? 429 : upstream !== undefined && upstream >= 400 && upstream < 500 ? 400 : 502
      return c.json(
        { error: { message: error.message || '3D submission failed', type: 'server_error', code: '3d_submit_error' } },
        statusCode
      )
    }
  })

  /**
   * GET /ai/v1/3d/:id - Status of a 3D task.
   *
   * `model_url` on success is a signed Tripo URL that expires after ~5
   * minutes; the caller downloads it immediately. Charged exactly once per
   * job id, on any pod, and only when Tripo reports credits consumed — a free
   * task (`rig_check`) never writes a wallet row.
   */
  router.get('/ai/v1/3d/:id', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    const id = c.req.param('id')
    const job = await get3dJob(id)
    if (!job || job.workspaceId !== tokenPayload.workspaceId) {
      return c.json({ error: { message: `3D job '${id}' not found.`, type: 'invalid_request_error', code: 'job_not_found' } }, 404)
    }

    const apiKey = getNativeProviderApiKeySync('tripo')
    if (!apiKey) {
      return c.json(
        { error: { message: "3D provider 'tripo' is not configured on this server.", type: 'server_error', code: 'provider_not_configured' } },
        503
      )
    }

    const base = { id, op: job.op, model: job.model || undefined, created_at: job.createdAt }

    try {
      const task = await tripoGetTask(apiKey, job.taskId, c.req.raw.signal)

      if (task.status === 'queued' || task.status === 'running') {
        return c.json({
          ...base,
          status: task.status,
          ...(task.progress !== undefined ? { progress: task.progress } : {}),
        })
      }

      if (task.status === 'failed') {
        const detail = task.errorMessage || (task.errorCode !== undefined ? `Tripo error ${task.errorCode}` : 'Task failed')
        return c.json({ ...base, status: 'failed', error: detail })
      }

      const modelUrl = task.output?.model_url
      const modelUrls = Array.isArray(task.output?.model_urls) ? task.output!.model_urls : undefined
      // `segment` and `rig_check` answer without a model file.
      const parts = Array.isArray(task.output?.part_names)
        ? task.output!.part_names
        : Array.isArray(task.output?.parts)
          ? (task.output!.parts as string[])
          : undefined

      if (!modelUrl && !modelUrls && !parts && task.riggable === undefined) {
        return c.json({ ...base, status: 'failed', error: 'Tripo reported success without an output' })
      }

      const creditsConsumed = task.creditsConsumed ?? 0
      const billedUsd = roundUsd(calculate3dUsageCost(creditsConsumed).billedUsd)

      // A free task (rig check, import) never touches the wallet — and the
      // charge-once claim is skipped so no later poll can bill it either.
      if (creditsConsumed > 0 && await claim3dCharge(id)) {
        record3dUsage(
          tokenPayload,
          {
            model: job.model || job.op,
            op: job.op,
            taskId: job.taskId,
            creditsConsumed,
            input: job.input,
          },
          c.req.header('x-chat-session-id') || job.chatSessionId || null,
        )
      }

      return c.json({
        ...base,
        status: 'success',
        progress: 100,
        ...(modelUrl ? { model_url: modelUrl } : {}),
        ...(modelUrls ? { model_urls: modelUrls } : {}),
        ...(parts ? { parts } : {}),
        ...(task.riggable !== undefined ? { riggable: task.riggable } : {}),
        ...(task.rigType ? { rig_type: task.rigType } : {}),
        credits_consumed: creditsConsumed,
        billed_usd: billedUsd,
      })
    } catch (error: any) {
      console.error(`[AI Proxy] 3D status error for ${id}:`, error.message)
      return c.json(
        { error: { message: error.message || '3D status check failed', type: 'server_error', code: '3d_status_error' } },
        502
      )
    }
  })

  /**
   * POST /ai/v1/audio/transcriptions - Whisper transcription proxy
   *
   * Accepts multipart/form-data with an audio `file` (+ optional `model`,
   * `language`, `prompt` fields) and forwards it to OpenAI's Whisper API
   * using this server's own OPENAI_API_KEY, so transcription goes through
   * the same auth/billing path as every other `/ai/v1/*` route instead of
   * requiring callers to hold a raw OpenAI key.
   *
   * Internal callers (the `transcribe_audio` agent tool and the meetings
   * transcription service) hit this route rather than OpenAI directly —
   * see `packages/agent-runtime/src/gateway-tools.ts` and
   * `apps/api/src/services/transcription.service.ts`.
   *
   * Always requests `verbose_json` from upstream (regardless of what the
   * caller asked for) so the response includes `duration`, which is
   * required to bill the call — both current callers already expect this
   * shape.
   */
  const WHISPER_MAX_FILE_BYTES = 25 * 1024 * 1024 // OpenAI's documented Whisper upload cap

  router.post('/ai/v1/audio/transcriptions', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    // An already-admitted chat turn still in flight is never re-gated
    // mid-message — e.g. the transcribe_audio tool running inside a turn.
    if (!(await isTurnInFlight(c, tokenPayload)) && !await billingService.hasBalance(tokenPayload.workspaceId)) {
      const usageLimit = await buildUsageLimitInfo(tokenPayload.workspaceId)
      return c.json(
        { error: { message: 'Usage limit reached. Enable usage-based pricing or upgrade your plan.', type: 'billing_error', code: 'usage_limit_reached', ...usageLimit } },
        402
      )
    }

    let capture: Awaited<ReturnType<typeof beginCapture>> = null
    try {
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null
      const model = (formData.get('model') as string) || 'whisper-1'
      const language = formData.get('language') as string | null
      const prompt = formData.get('prompt') as string | null

      if (!file) {
        return c.json(
          { error: { message: 'file is required', type: 'invalid_request_error', code: 'missing_file' } },
          400
        )
      }

      if (file.size > WHISPER_MAX_FILE_BYTES) {
        return c.json(
          {
            error: {
              message: `Audio file is ${(file.size / (1024 * 1024)).toFixed(1)}MB, which exceeds the ${WHISPER_MAX_FILE_BYTES / (1024 * 1024)}MB Whisper upload limit.`,
              type: 'invalid_request_error',
              code: 'file_too_large',
            },
          },
          400
        )
      }

      const openaiKey = process.env.OPENAI_API_KEY
      if (!openaiKey) {
        return c.json(
          { error: { message: 'OpenAI is not configured on this server (required for audio transcription).', type: 'server_error', code: 'provider_not_configured' } },
          503
        )
      }

      console.log(`[AI Proxy] 🎙️ Transcription: ${tokenPayload.projectId} → openai/${model}`)

      const fileBytes = Buffer.from(await file.arrayBuffer())
      capture = await beginCapture({
        tokenPayload,
        endpoint: 'audio.transcriptions',
        requestBody: {
          model,
          language,
          prompt,
          file: `data:${file.type || 'application/octet-stream'};base64,${fileBytes.toString('base64')}`,
        },
        requestedModel: model,
        resolvedModel: model,
        provider: 'openai',
        stream: false,
        chatSessionId: c.req.header('x-chat-session-id') || null,
        client: c.req.header('x-shogo-client'),
        requestHeaders: c.req.raw.headers,
      })

      const forwardForm = new FormData()
      forwardForm.append('file', file, file.name || 'audio')
      forwardForm.append('model', model)
      forwardForm.append('response_format', 'verbose_json')
      if (language) forwardForm.append('language', language)
      if (prompt) forwardForm.append('prompt', prompt)

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: forwardForm,
        signal: c.req.raw.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`OpenAI transcription error (${response.status}): ${errorText}`)
      }

      const result = await response.json() as {
        text: string
        language?: string
        duration?: number
        segments?: Array<{ start: number; end: number; text: string }>
      }

      recordTranscriptionUsage(tokenPayload, model, result.duration)

      capture?.recordResponse({ status: 200, body: result, format: 'json' })
      return c.json(result)
    } catch (error: any) {
      capture?.finish({ errorType: 'transcription_error' })
      console.error('[AI Proxy] Transcription error:', error.message)
      const statusCode = error.message?.includes('429') ? 429 : error.message?.includes('503') ? 503 : 500
      return c.json(
        { error: { message: error.message || 'Audio transcription failed', type: 'server_error', code: 'transcription_error' } },
        statusCode
      )
    }
  })

  // =========================================================================
  // GET /ai/v1/access - Check model tier access for the authenticated workspace
  // =========================================================================
  router.get('/ai/v1/access', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json({ error: { message: 'Invalid or missing proxy token', code: 'auth_error' } }, 401)
    }

    const hasAdvanced = isLocalDev || await billingService.hasAdvancedModelAccess(tokenPayload.workspaceId)

    return c.json({
      hasAdvancedModelAccess: hasAdvanced,
    })
  })

  // =========================================================================
  // GET /ai/v1/subscription - Debug: check subscription status for the key's workspace
  // =========================================================================
  router.get('/ai/v1/subscription', async (c) => {
    const tokenPayload = await validateProxyAuth(c) || await validateAnthropicAuth(c)
    if (!tokenPayload) {
      return c.json({ error: { message: 'Invalid or missing API key', code: 'auth_error' } }, 401)
    }

    const sub = await billingService.getSubscription(tokenPayload.workspaceId)
    const wallet = await billingService.getUsageWallet(tokenPayload.workspaceId)

    return c.json({
      workspaceId: tokenPayload.workspaceId,
      subscription: sub ? {
        planId: sub.planId,
        status: sub.status,
        billingInterval: sub.billingInterval,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      } : null,
      usage: wallet ? {
        monthlyIncludedUsd: wallet.monthlyIncludedUsd,
        dailyIncludedUsd: wallet.dailyIncludedUsd,
        overageEnabled: wallet.overageEnabled,
        overageHardLimitUsd: wallet.overageHardLimitUsd,
        overageAccumulatedUsd: wallet.overageAccumulatedUsd,
      } : null,
      hasAdvancedModelAccess: isLocalDev || await billingService.hasAdvancedModelAccess(tokenPayload.workspaceId),
    })
  })

  // =========================================================================
  // PUT /ai/v1/subscription - Debug: provision/update subscription for staging/testing
  // =========================================================================
  router.put('/ai/v1/subscription', async (c) => {
    const tokenPayload = await validateProxyAuth(c) || await validateAnthropicAuth(c)
    if (!tokenPayload) {
      return c.json({ error: { message: 'Invalid or missing API key', code: 'auth_error' } }, 401)
    }

    const body = await c.req.json<{ planId?: string }>()
    const planId = body.planId || 'pro'

    const now = new Date()
    const periodEnd = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)

    await billingService.syncFromStripe({
      stripeSubscriptionId: `debug_${tokenPayload.workspaceId}`,
      stripeCustomerId: `debug_cus_${tokenPayload.workspaceId}`,
      workspaceId: tokenPayload.workspaceId,
      planId: planId as any,
      status: 'active',
      billingInterval: 'monthly',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    })

    await billingService.allocateMonthlyIncluded(tokenPayload.workspaceId, planId)

    const hasAdvanced = await billingService.hasAdvancedModelAccess(tokenPayload.workspaceId)
    return c.json({
      ok: true,
      workspaceId: tokenPayload.workspaceId,
      planId,
      hasAdvancedModelAccess: hasAdvanced,
    })
  })

  // =========================================================================
  // GET /ai/proxy/health - Health check for the AI proxy
  // =========================================================================
  router.get('/ai/proxy/health', (c) => {
    // Read through the credential resolver, not raw env: an admin-stored key
    // (cloud) or a desktop BYOK file also counts as configured.
    const providers: Record<string, boolean> = {
      anthropic: !!getNativeProviderApiKeySync('anthropic'),
      openai: !!getNativeProviderApiKeySync('openai'),
      google: !!getNativeProviderApiKeySync('google'),
      higgsfield: !!getNativeProviderApiKeySync('higgsfield'),
      tripo: !!getNativeProviderApiKeySync('tripo'),
    }

    return c.json({
      status: 'ok',
      providers,
      defaultImageModel: defaultImageModel(),
      defaultVideoModel: defaultVideoModel(),
      modelCount: Object.keys(MODEL_REGISTRY).length,
      imageModelCount: Object.keys(IMAGE_MODEL_REGISTRY).length,
      videoModelCount: Object.keys(VIDEO_MODEL_CATALOG).length,
    })
  })

  // ---------------------------------------------------------------------
  // Upstream connectivity probe
  //
  // Used by the agent loop's "park" tier (see `packages/agent/src/
  // connectivity.ts`) to tell "no internet" apart from "provider is having
  // an issue" once the fast pre-stream retries in `fetchAnthropicWithRetry`
  // are exhausted. Any HTTP response — even a 4xx/5xx — means the network
  // path to the target is up (DNS resolved, TCP/TLS connected); we only
  // report `reachable: false` when the request never gets a response at all
  // (DNS failure, connection refused/reset, timeout). Only a coarse `target`
  // label is returned (never the resolved URL) since this route is mounted
  // before the general auth middleware and callable without a proxy token.
  // ---------------------------------------------------------------------
  type UpstreamHealthTarget = 'cloud' | 'direct' | 'local-llm'

  function resolveUpstreamHealthTarget(): { mode: UpstreamHealthTarget; url: string } {
    const localBase = process.env.LOCAL_LLM_BASE_URL
    if (process.env.AI_MODE === 'local-llm' && localBase) {
      return { mode: 'local-llm', url: localBase.replace(/\/$/, '') }
    }
    if (isShogoCloudForwarding()) {
      return { mode: 'cloud', url: `${getShogoCloudUrl()}/api/health` }
    }
    return { mode: 'direct', url: 'https://api.anthropic.com' }
  }

  const UPSTREAM_HEALTH_CACHE_MS = 2_000
  const UPSTREAM_HEALTH_TIMEOUT_MS = 3_000
  let upstreamHealthCache: { mode: UpstreamHealthTarget; reachable: boolean; checkedAt: number } | null = null

  async function probeUpstreamReachable(url: string, timeoutMs: number): Promise<boolean> {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
      return true
    } catch {
      return false
    }
  }

  router.get('/ai/upstream-health', async (c) => {
    const target = resolveUpstreamHealthTarget()
    const now = Date.now()
    if (
      upstreamHealthCache &&
      upstreamHealthCache.mode === target.mode &&
      now - upstreamHealthCache.checkedAt < UPSTREAM_HEALTH_CACHE_MS
    ) {
      return c.json({
        reachable: upstreamHealthCache.reachable,
        target: target.mode,
        checkedAt: upstreamHealthCache.checkedAt,
        cached: true,
      })
    }

    const reachable = await probeUpstreamReachable(target.url, UPSTREAM_HEALTH_TIMEOUT_MS)
    upstreamHealthCache = { mode: target.mode, reachable, checkedAt: now }
    return c.json({ reachable, target: target.mode, checkedAt: now, cached: false })
  })

  return router
}

export default aiProxyRoutes
