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

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import {
  generateProxyToken,
  verifyProxyToken,
  type ProxyTokenPayload,
} from '../lib/ai-proxy-token'
import { resolveApiKey } from './api-keys'
import {
  MODEL_CATALOG,
  MODEL_ALIASES,
  IMAGE_MODEL_CATALOG,
  AGENT_MODE_DEFAULTS,
  resolveAgentModeDefault,
  getMaxOutputTokens,
  type Provider,
  type ImageProvider,
  type AgentMode,
} from '@shogo/model-catalog'

// =============================================================================
// Types
// =============================================================================

/** OpenAI-compatible chat completion request */
interface ChatCompletionRequest {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
    name?: string
    tool_call_id?: string
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
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
  }>
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
}

/** Model routing configuration (derived from the shared catalog) */
interface ModelConfig {
  provider: Provider
  apiModel: string
  displayName: string
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
function resolveModel(model: string): ModelConfig | null {
  // Agent mode aliases — resolve via resolveAgentModel (handles local vs cloud)
  if (model === 'basic' || model === 'advanced') {
    const { resolvedModel, isLocal } = resolveAgentModel(model)
    if (isLocal) {
      return { provider: 'local', apiModel: resolvedModel, displayName: model }
    }
    return resolveModel(resolvedModel)
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
 * Get the API key for a provider.
 */
function getProviderApiKey(provider: Provider): string | null {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || null
    case 'openai':
      return process.env.OPENAI_API_KEY || null
    case 'local':
      return 'local'
    default:
      return null
  }
}

/**
 * Resolve 'basic' / 'advanced' agent modes to actual model names.
 *
 * When LOCAL_LLM_BASE_URL is set: use admin-configured local models.
 * Otherwise: use defaults from the shared model catalog.
 */
function resolveAgentModel(model: string): { resolvedModel: string; isLocal: boolean } {
  const localBaseUrl = process.env.LOCAL_LLM_BASE_URL
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
    return {
      type: 'error',
      error: {
        type: 'stream_error',
        code,
        retryable: code !== 'upstream_error',
        message,
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
 * Convert OpenAI-format messages to Anthropic format.
 * Anthropic uses a separate `system` parameter and has different message structure.
 */
function convertToAnthropicFormat(request: ChatCompletionRequest) {
  let systemPrompt: string | undefined
  const messages: Array<{ role: string; content: string | Array<any> }> = []

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      // Anthropic takes system as a separate parameter
      systemPrompt = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(p => p.text || '').join('\n')
      continue
    }

    messages.push({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: msg.content,
    })
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens || getMaxOutputTokens(request.model),
  }

  if (systemPrompt) body.system = systemPrompt
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.top_p !== undefined) body.top_p = request.top_p
  if (request.stop) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop]
  if (request.stream) body.stream = true

  // Convert tools to Anthropic format
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    }))
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
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens || 0) +
        (anthropicResponse.usage?.output_tokens || 0),
    },
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

function convertOpenAIStreamToAnthropicStream(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let sseBuffer = ''
  let contentIndex = 0

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`
      ))
      controller.enqueue(encoder.encode(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })}\n\n`
      ))
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
              controller.enqueue(encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`
              ))
              controller.enqueue(encoder.encode(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn' },
                  usage: { output_tokens: contentIndex },
                })}\n\n`
              ))
              controller.enqueue(encoder.encode(
                `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
              ))
              controller.close()
              return
            }
            try {
              const chunk = JSON.parse(data)
              const delta = chunk.choices?.[0]?.delta
              if (delta?.content) {
                contentIndex += delta.content.length
                controller.enqueue(encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: delta.content },
                  })}\n\n`
                ))
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
async function proxyAnthropicStream(
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
async function proxyAnthropicNonStream(
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
  return 'https://api.openai.com/v1/chat/completions'
}

function getOpenAICompatibleHeaders(apiKey: string, modelConfig: ModelConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (modelConfig.provider !== 'local') {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * Proxy a streaming request to an OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio).
 */
async function proxyOpenAIStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig,
  onComplete?: (inputTokens: number, outputTokens: number, cachedInputTokens: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  const url = getOpenAICompatibleBaseUrl(modelConfig)
  const headers = getOpenAICompatibleHeaders(apiKey, modelConfig)

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...request,
      model: modelConfig.apiModel,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`${modelConfig.provider} API error (${response.status}): ${errorText}`)
  }

  if (!onComplete) {
    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Proxy-Provider': modelConfig.provider,
        'X-Proxy-Model': modelConfig.apiModel,
      },
    })
  }

  // Parse SSE to extract usage from the final chunk, then call onComplete
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
      // Keep the last (possibly incomplete) line in the buffer
      sseBuffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            const totalPrompt = parsed.usage.prompt_tokens || 0
            cachedInputTokens = parsed.usage.prompt_tokens_details?.cached_tokens || 0
            inputTokens = totalPrompt - cachedInputTokens
            outputTokens = parsed.usage.completion_tokens || 0
          }
        } catch {
          // Skip unparseable lines
        }
      }
    },
    flush() {
      onComplete(inputTokens, outputTokens, cachedInputTokens)
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
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Proxy-Provider': modelConfig.provider,
      'X-Proxy-Model': modelConfig.apiModel,
    },
  })
}

/**
 * Proxy a non-streaming request to an OpenAI-compatible endpoint.
 */
async function proxyOpenAINonStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig,
  signal?: AbortSignal,
) {
  const url = getOpenAICompatibleBaseUrl(modelConfig)
  const headers = getOpenAICompatibleHeaders(apiKey, modelConfig)

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...request,
      model: modelConfig.apiModel,
      stream: false,
    }),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`${modelConfig.provider} API error (${response.status}): ${errorText}`)
  }

  return response.json()
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

// =============================================================================
// Billing
// =============================================================================

import { calculateUsageCost, proxyModelToBillingModel, getModelTier } from '../lib/usage-cost'
import * as billingService from '../services/billing.service'
import { getProjectUser } from '../lib/project-user-context'
import { accumulateUsage, hasSession } from '../lib/proxy-billing-session'

/**
 * Record token usage for billing.
 *
 * If there's an active billing session for this project (opened by
 * project-chat or /api/chat), tokens are accumulated and charged once
 * when the session closes. Otherwise, charge immediately per-call.
 */
async function recordUsage(
  tokenPayload: ProxyTokenPayload,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
) {
  // For API-key auth the projectId is a sentinel ('api-key'), not a real
  // Project row. Pass null so the UsageEvent FK constraint is satisfied.
  const billingProjectId = tokenPayload.projectId === 'api-key' ? null : (tokenPayload.projectId || null)

  // If a billing session is open, accumulate — the session closer will charge
  if (billingProjectId && accumulateUsage(billingProjectId, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens)) {
    const totalTokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
    // Per-request cache breakdown — same gate as the agent-runtime cache-debug
    // logs so a single env flag turns the whole picture on. This is the
    // authoritative signal for cache health; the agent-runtime fingerprint
    // tells us WHAT the prefix looked like, this tells us whether Anthropic
    // actually read the cache for that prefix.
    console.log(`[AI Proxy] 📊 Accumulated ${totalTokens} tokens for session (project: ${billingProjectId})`)
    return
  }

  // No billing session — charge immediately (direct proxy usage)
  const totalTokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
  if (totalTokens === 0) return

  try {
    const billingModel = proxyModelToBillingModel(model)
    const { rawUsd, billedUsd } = calculateUsageCost(inputTokens, outputTokens, billingModel, cachedInputTokens, cacheWriteTokens)
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
      actionMetadata: { model, billingModel, rawUsd, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, totalTokens },
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
}

interface ImageGenerationResponse {
  created: number
  data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
}

const IMAGE_MODEL_REGISTRY: Record<string, ImageModelConfig> = {}

for (const entry of Object.values(IMAGE_MODEL_CATALOG)) {
  IMAGE_MODEL_REGISTRY[entry.id] = {
    provider: entry.provider,
    apiModel: entry.apiModel,
    displayName: entry.displayName,
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
    case 'openai': return process.env.OPENAI_API_KEY || null
    case 'google': return process.env.GOOGLE_API_KEY || null
    case 'local': return 'local'
    default: return null
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
    size: params.size || '1024x1024',
    n: params.n || 1,
    response_format: 'b64_json',
  }
  if (params.quality) body.quality = params.quality

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

import { calculateImageUsageCost } from '../lib/usage-cost'

async function recordImageUsage(
  tokenPayload: ProxyTokenPayload,
  model: string,
  quality: string,
  size: string,
  n: number,
) {
  try {
    const single = calculateImageUsageCost(model, quality, size)
    const rawUsd = single.rawUsd * n
    const billedUsd = single.billedUsd * n
    if (billedUsd === 0) return

    const billingUserId = getProjectUser(tokenPayload.projectId) || tokenPayload.userId || 'system'

    if (hasSession(tokenPayload.projectId)) {
      accumulateUsage(tokenPayload.projectId, `image:${model}`, 0, 0)
      console.log(`[AI Proxy] 🎨 Accumulated image gen for session (project: ${tokenPayload.projectId}, model: ${model})`)
    }

    const result = await billingService.consumeUsage({
      workspaceId: tokenPayload.workspaceId,
      projectId: tokenPayload.projectId || null,
      memberId: billingUserId,
      actionType: 'ai_image_generation',
      rawUsd,
      billedUsd,
      actionMetadata: { model, quality, size, n, rawUsd },
    })

    if (result.success) {
      console.log(`[AI Proxy] 🎨 Charged $${billedUsd.toFixed(4)} (image gen, model: ${model}) — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`)
    } else {
      console.warn(`[AI Proxy] ⚠️ Could not charge image usage: ${result.error}`)
    }
  } catch (err) {
    console.error('[AI Proxy] Failed to charge image usage:', err)
  }
}

// =============================================================================
// Routes
// =============================================================================

const isLocalDev = process.env.SHOGO_LOCAL_MODE === 'true'

export function aiProxyRoutes() {
  const router = new Hono()

  /**
   * Middleware: Validate proxy token on all /ai/v1/* routes.
   * Accepts both project-scoped JWTs and Shogo API keys (shogo_sk_*).
   */
  async function validateProxyAuth(c: any): Promise<ProxyTokenPayload | null> {
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
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
    }

    return verifyProxyToken(token)
  }

  /**
   * Check if Shogo Cloud forwarding is active (local mode with SHOGO_API_KEY set
   * and AI_MODE not overridden to 'api-keys' or 'local-llm').
   */
  function isShogoCloudForwarding(): boolean {
    if (process.env.SHOGO_LOCAL_MODE !== 'true' || !process.env.SHOGO_API_KEY) return false
    const aiMode = process.env.AI_MODE
    if (aiMode === 'api-keys' || aiMode === 'local-llm') return false
    return true
  }

  function getShogoCloudUrl(): string {
    return (process.env.SHOGO_CLOUD_URL || 'https://studio.shogo.ai').replace(/\/$/, '')
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
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${shogoKey}`,
      },
      body: JSON.stringify(request),
      signal,
    })

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
   * Forward an Anthropic-native request to the Shogo Cloud proxy.
   */
  async function forwardAnthropicToCloud(c: any, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    const cloudUrl = getShogoCloudUrl()
    const shogoKey = process.env.SHOGO_API_KEY!
    const parsed = JSON.parse(body)
    const isStream = !!parsed.stream

    splitSystemBlocksForCaching(parsed)

    const forwardHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': shogoKey,
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
        console.log(`[AI Proxy] Forwarding to Shogo Cloud: ${request.model} (stream: ${!!request.stream})`)
        return await forwardChatCompletionsToCloud(c, request, c.req.raw.signal)
      } catch (error: any) {
        console.error('[AI Proxy] Cloud forwarding error:', error.message)
        return c.json({ error: { message: `Cloud proxy error: ${error.message}`, type: 'server_error', code: 'cloud_proxy_error' } }, 502)
      }
    }

    // Pre-check: reject if workspace has no included USD left (skip in local dev)
    if (!isLocalDev && !await billingService.hasBalance(tokenPayload.workspaceId)) {
      return c.json(
        {
          error: {
            message: 'Usage limit reached. Enable usage-based pricing or upgrade your plan.',
            type: 'billing_error',
            code: 'usage_limit_reached',
          },
        },
        402
      )
    }

    try {
      const request: ChatCompletionRequest = await c.req.json()

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

      // Enforce model tier: free/basic users can only use economy-tier models
      if (modelConfig.provider !== 'local' && !isLocalDev) {
        const tier = getModelTier(request.model)
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

      // Get provider API key
      const apiKey = getProviderApiKey(modelConfig.provider)
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

      // Route to provider
      if (request.stream) {
        if (modelConfig.provider === 'anthropic') {
          return await proxyAnthropicStream(request, apiKey, modelConfig, (inTok, outTok, cachedTok, cacheWriteTok) => {
            recordUsage(tokenPayload, request.model, inTok, outTok, cachedTok, cacheWriteTok)
          }, c.req.raw.signal)
        } else {
          return await proxyOpenAIStream(request, apiKey, modelConfig, (inTok, outTok, cachedTok) => {
            recordUsage(tokenPayload, request.model, inTok, outTok, cachedTok)
          }, c.req.raw.signal)
        }
      } else {
        let result: any
        if (modelConfig.provider === 'anthropic') {
          result = await proxyAnthropicNonStream(request, apiKey, modelConfig, c.req.raw.signal)
        } else {
          result = await proxyOpenAINonStream(request, apiKey, modelConfig, c.req.raw.signal)
        }

        const totalPrompt = result.usage?.prompt_tokens || 0
        const cachedPrompt = result.usage?.prompt_tokens_details?.cached_tokens || 0
        recordUsage(
          tokenPayload,
          request.model,
          totalPrompt - cachedPrompt,
          result.usage?.completion_tokens || 0,
          cachedPrompt,
        )

        return c.json(result)
      }
    } catch (error: any) {
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

    if (!isLocalDev && !await billingService.hasBalance(tokenPayload.workspaceId)) {
      return c.json(
        { error: { message: 'Usage limit reached.', type: 'billing_error', code: 'usage_limit_reached' } },
        402
      )
    }

    try {
      const body = await c.req.json()
      const requestedModel = body.model
      if (!requestedModel) {
        return c.json({ error: { message: 'model is required', type: 'invalid_request_error' } }, 400)
      }

      const { resolvedModel } = resolveAgentModel(requestedModel)
      const modelConfig = resolveModel(resolvedModel)
      if (!modelConfig) {
        return c.json({ error: { message: `Model '${requestedModel}' is not supported.`, type: 'invalid_request_error' } }, 400)
      }

      const apiKey = getProviderApiKey(modelConfig.provider)
      if (!apiKey) {
        return c.json({ error: { message: `Provider '${modelConfig.provider}' is not configured.`, type: 'server_error' } }, 503)
      }

      const isStream = !!body.stream
      console.log(`[AI Proxy] Responses API: ${tokenPayload.projectId} → ${modelConfig.provider}/${modelConfig.apiModel} (stream: ${isStream})`)

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
        return new Response(errorText, { status: response.status, headers: { 'Content-Type': 'application/json' } })
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
                  const totalInput = parsed.response.usage.input_tokens || 0
                  cachedInputTokens = parsed.response.usage.input_tokens_details?.cached_tokens || 0
                  inputTokens = totalInput - cachedInputTokens
                  outputTokens = parsed.response.usage.output_tokens || 0
                }
              } catch {}
            }
          },
          flush() {
            if (inputTokens || outputTokens || cachedInputTokens) {
              recordUsage(tokenPayload, requestedModel, inputTokens, outputTokens, cachedInputTokens)
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

        return new Response(readable.pipeThrough(transformStream), {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        })
      } else {
        const result = await response.json() as any
        if (result.usage) {
          const totalInput = result.usage.input_tokens || 0
          const cachedInput = result.usage.input_tokens_details?.cached_tokens || 0
          recordUsage(tokenPayload, requestedModel, totalInput - cachedInput, result.usage.output_tokens || 0, cachedInput)
        }
        return c.json(result)
      }
    } catch (error: any) {
      console.error('[AI Proxy] Responses API error:', error.message)
      return c.json({ error: { message: error.message || 'Internal proxy error', type: 'server_error' } }, 500)
    }
  })

  // =========================================================================
  // GET /ai/v1/models - List available models
  // =========================================================================
  router.get('/ai/v1/models', async (c) => {
    // Token validation is optional for model listing (nice for discovery)
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

    const models = Object.entries(MODEL_REGISTRY)
      // Filter out aliases (entries where key !== apiModel and another entry has the same apiModel)
      .filter(([key, config]) => key === config.apiModel)
      .map(([key, config]) => ({
        id: key,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: config.provider,
        display_name: config.displayName,
        // Indicate if the provider is actually configured
        available: !!getProviderApiKey(config.provider),
      }))

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
   * Accepts both project-scoped JWTs and Shogo API keys (shogo_sk_*).
   */
  async function validateAnthropicAuth(c: any): Promise<ProxyTokenPayload | null> {
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
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
    }

    return verifyProxyToken(apiKey)
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

    // Pre-check usage balance (skip in local dev)
    if (!isLocalDev && !await billingService.hasBalance(tokenPayload.workspaceId)) {
      return c.json(
        { type: 'error', error: { type: 'billing_error', message: 'Usage limit reached. Enable usage-based pricing or upgrade your plan.' } },
        402
      )
    }

    try {
      const body = await c.req.text()
      let parsed: any = {}
      try { parsed = JSON.parse(body) } catch { /* ok */ }
      const requestModel = parsed.model || 'advanced'
      const isStream = !!parsed.stream

      const { resolvedModel, isLocal } = resolveAgentModel(requestModel)
      console.log(`[AI Proxy] Anthropic pass-through: ${tokenPayload.projectId} → ${resolvedModel} (local: ${isLocal}, stream: ${isStream})`)

      // Enforce model tier: free/basic users can only use economy-tier models
      if (!isLocal && !isLocalDev) {
        const tier = getModelTier(resolvedModel)
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
          return c.json(
            { type: 'error', error: { type: 'api_error', message: `Local LLM error (${response.status}): ${errorText}` } },
            response.status as any
          )
        }

        if (isStream) {
          const anthropicStream = convertOpenAIStreamToAnthropicStream(response.body!, resolvedModel)
          return new Response(anthropicStream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Proxy-Provider': 'local',
              'X-Proxy-Model': resolvedModel,
            },
          })
        } else {
          const openaiResult = await response.json() as any
          const anthropicResult = convertOpenAIResponseToAnthropic(openaiResult, resolvedModel)
          return c.json(anthropicResult)
        }
      }

      // ── Cloud routing: OpenAI models (convert Anthropic → OpenAI format) ──
      const resolvedModelConfig = resolveModel(resolvedModel)
      if (resolvedModelConfig && resolvedModelConfig.provider === 'openai') {
        const openaiApiKey = process.env.OPENAI_API_KEY
        if (!openaiApiKey) {
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
          return c.json(
            { type: 'error', error: { type: 'api_error', message: `OpenAI error (${response.status}): ${errorText}` } },
            response.status as any
          )
        }

        if (isStream) {
          const anthropicStream = convertOpenAIStreamToAnthropicStream(response.body!, resolvedModel)
          return new Response(anthropicStream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Proxy-Provider': 'openai',
              'X-Proxy-Model': resolvedModel,
            },
          })
        } else {
          const openaiResult = await response.json() as any
          const oaiTotalPrompt = openaiResult.usage?.prompt_tokens || 0
          const oaiCachedPrompt = openaiResult.usage?.prompt_tokens_details?.cached_tokens || 0
          recordUsage(tokenPayload, resolvedModel, oaiTotalPrompt - oaiCachedPrompt, openaiResult.usage?.completion_tokens || 0, oaiCachedPrompt)
          const anthropicResult = convertOpenAIResponseToAnthropic(openaiResult, resolvedModel)
          return c.json(anthropicResult)
        }
      }

      // ── Cloud routing: forward to Anthropic API ──
      const anthropicApiKey = process.env.ANTHROPIC_API_KEY
      if (!anthropicApiKey) {
        return c.json(
          { type: 'error', error: { type: 'api_error', message: 'Anthropic provider is not configured on this server.' } },
          503
        )
      }

      // Replace the model name with the resolved one before forwarding
      parsed.model = resolvedModel

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
        return new Response(errorBody, {
          status: response.status,
          headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
        })
      }

      if (!isStream) {
        const responseBody = await response.json() as any
        const inTok = responseBody.usage?.input_tokens || 0
        const cacheWriteTok = responseBody.usage?.cache_creation_input_tokens || 0
        const cachedTok = responseBody.usage?.cache_read_input_tokens || 0
        const outTok = responseBody.usage?.output_tokens || 0
        recordUsage(tokenPayload, resolvedModel, inTok, outTok, cachedTok, cacheWriteTok)
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
          recordUsage(tokenPayload, resolvedModel, streamInputTokens, streamOutputTokens, streamCachedInputTokens, streamCacheWriteTokens)
        },
      })

      // Wrap with keepalive + mid-stream error visibility *before* token
      // tracking, so synthetic error frames are also scanned for usage fields
      // (they have none — harmless) but kept in the stream for downstream.
      const wrapped = wrapSseForErrorVisibility(response.body!, 'anthropic')
      const trackedBody = wrapped.pipeThrough(tokenTrackingTransform)

      return new Response(trackedBody, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      // Client cancelled — surface 499 silently, don't log as a server error.
      if (error?.name === 'AbortError') {
        return new Response(null, { status: 499 })
      }
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
          },
          body,
          signal: c.req.raw.signal,
        },
        { label: 'shogo-cloud', signal: c.req.raw.signal },
      )
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
      status: response.status,
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
      status: response.status,
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

    if (!await billingService.hasBalance(tokenPayload.workspaceId)) {
      return c.json(
        { error: { message: 'Usage limit reached. Enable usage-based pricing or upgrade your plan.', type: 'billing_error', code: 'usage_limit_reached' } },
        402
      )
    }

    try {
      const body = await c.req.json() as {
        prompt: string
        model?: string
        size?: string
        quality?: string
        n?: number
        response_format?: string
      }

      if (!body.prompt) {
        return c.json(
          { error: { message: 'prompt is required', type: 'invalid_request_error', code: 'missing_prompt' } },
          400
        )
      }

      const model = body.model || 'dall-e-3'
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

      const signal = c.req.raw.signal
      let result: ImageGenerationResponse
      if (imageModel.provider === 'openai') {
        result = await generateImageOpenAI(apiKey, imageModel.apiModel, body, signal)
      } else if (imageModel.provider === 'google') {
        result = await generateImageGoogle(apiKey, imageModel.apiModel, body, signal)
      } else if (imageModel.provider === 'local') {
        result = await generateImageLocal(imageModel.apiModel, body, signal)
      } else {
        return c.json(
          { error: { message: `Unsupported image provider: ${imageModel.provider}`, type: 'server_error', code: 'unsupported_provider' } },
          500
        )
      }

      recordImageUsage(tokenPayload, model, body.quality || 'standard', body.size || '1024x1024', body.n || 1)

      return c.json(result)
    } catch (error: any) {
      console.error('[AI Proxy] Image generation error:', error.message)
      const statusCode = error.message?.includes('429') ? 429 : error.message?.includes('503') ? 503 : 500
      return c.json(
        { error: { message: error.message || 'Image generation failed', type: 'server_error', code: 'generation_error' } },
        statusCode
      )
    }
  })

  /**
   * POST /ai/v1/images/edits - Image editing proxy (reference image + prompt)
   *
   * Accepts multipart/form-data with an image file and prompt.
   * Routes to OpenAI's /v1/images/edits endpoint.
   */
  router.post('/ai/v1/images/edits', async (c) => {
    const tokenPayload = await validateProxyAuth(c)
    if (!tokenPayload) {
      return c.json(
        { error: { message: 'Invalid or missing proxy token.', type: 'authentication_error', code: 'invalid_api_key' } },
        401
      )
    }

    if (!await billingService.hasBalance(tokenPayload.workspaceId)) {
      return c.json(
        { error: { message: 'Usage limit reached. Enable usage-based pricing or upgrade your plan.', type: 'billing_error', code: 'usage_limit_reached' } },
        402
      )
    }

    try {
      const formData = await c.req.formData()
      const prompt = formData.get('prompt') as string
      const imageFile = formData.get('image') as File | null
      const model = (formData.get('model') as string) || 'dall-e-2'
      const size = (formData.get('size') as string) || '1024x1024'
      const n = parseInt((formData.get('n') as string) || '1', 10)
      const quality = (formData.get('quality') as string) || 'standard'

      if (!prompt) {
        return c.json(
          { error: { message: 'prompt is required', type: 'invalid_request_error', code: 'missing_prompt' } },
          400
        )
      }
      if (!imageFile) {
        return c.json(
          { error: { message: 'image file is required for edits', type: 'invalid_request_error', code: 'missing_image' } },
          400
        )
      }

      const openaiKey = process.env.OPENAI_API_KEY
      if (!openaiKey) {
        return c.json(
          { error: { message: 'OpenAI is not configured on this server (required for image edits).', type: 'server_error', code: 'provider_not_configured' } },
          503
        )
      }

      console.log(`[AI Proxy] 🎨 Image edit: ${tokenPayload.projectId} → openai/${model}`)

      // OpenAI edits endpoint only supports dall-e-2
      const editModel = 'dall-e-2'
      const forwardForm = new FormData()
      forwardForm.append('image', imageFile)
      forwardForm.append('prompt', prompt)
      forwardForm.append('model', editModel)
      forwardForm.append('size', size)
      forwardForm.append('n', String(n))
      forwardForm.append('response_format', 'b64_json')

      const response = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: forwardForm,
        signal: c.req.raw.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`OpenAI image edit error (${response.status}): ${errorText}`)
      }

      const result = await response.json() as ImageGenerationResponse

      recordImageUsage(tokenPayload, model, quality, size, n)

      return c.json(result)
    } catch (error: any) {
      console.error('[AI Proxy] Image edit error:', error.message)
      const statusCode = error.message?.includes('429') ? 429 : error.message?.includes('503') ? 503 : 500
      return c.json(
        { error: { message: error.message || 'Image edit failed', type: 'server_error', code: 'edit_error' } },
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
    const providers: Record<string, boolean> = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      google: !!process.env.GOOGLE_API_KEY,
    }

    return c.json({
      status: 'ok',
      providers,
      modelCount: Object.keys(MODEL_REGISTRY).length,
      imageModelCount: Object.keys(IMAGE_MODEL_REGISTRY).length,
    })
  })

  return router
}

export default aiProxyRoutes
