// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Public OpenAI-compatible API (`/v1/*`).
 *
 * The external developer surface: point any OpenAI client at
 * `https://<host>/v1` with a Shogo API key (`shogo_sk_*`) and call the
 * Shogo-branded model ids (the first is `hoshi-1.0`).
 *
 * This is intentionally a *separate*, narrower surface than the internal
 * `/api/ai/*` proxy:
 *   - Auth accepts ONLY `Authorization: Bearer shogo_sk_*` (no runtime tokens
 *     or project JWTs — those are internal-only credentials).
 *   - Only super-admin-curated public model aliases are accepted; everything
 *     else returns `model_not_found`.
 *   - The upstream provider / real model id is masked: `/v1/models` reports
 *     `owned_by: "shogo"`, and every response's `model` field is rewritten
 *     back to the public id.
 *
 * Routing and billing reuse the AI proxy internals: a public id is translated
 * to its backing model id up front, then `resolveModel` + the `proxy*`
 * helpers + `recordUsage` run exactly as they do for `/api/ai/*`, so usage is
 * metered to the API key's workspace at the backing model's pricing.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ProxyTokenPayload } from '../lib/ai-proxy-token'
import { resolveApiKey } from './api-keys'
import * as billingService from '../services/billing.service'
import {
  getPublicModelsSync,
  resolvePublicModelSync,
} from '../services/public-models.service'
import {
  resolveModel,
  resolveModelTier,
  resolveModelApiKey,
  recordUsage,
  buildUsageLimitInfo,
  proxyOpenAIStream,
  proxyOpenAINonStream,
  proxyAnthropicStream,
  proxyAnthropicNonStream,
  type ChatCompletionRequest,
  type ModelConfig,
} from './ai-proxy'

const isLocalDev = process.env.SHOGO_LOCAL_MODE === 'true'

// ---------------------------------------------------------------------------
// Auth — Shogo API keys only
// ---------------------------------------------------------------------------

/**
 * Resolve a `shogo_sk_*` key from the `Authorization: Bearer` header to a
 * synthetic, workspace-scoped `ProxyTokenPayload`. Unlike the internal proxy,
 * runtime tokens (`rt_v1_*`) and signed project JWTs are NOT accepted here.
 */
async function authenticate(c: Context): Promise<ProxyTokenPayload | null> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  if (!token.startsWith('shogo_sk_')) return null

  const deviceAppVersion = c.req.header('X-Shogo-Device-App-Version')
  const resolved = await resolveApiKey(
    token,
    deviceAppVersion ? { deviceAppVersion } : undefined,
  )
  if (!resolved) return null

  const now = Math.floor(Date.now() / 1000)
  return {
    projectId: 'api-key',
    workspaceId: resolved.workspaceId,
    userId: resolved.userId,
    type: 'ai-proxy',
    iat: now,
    exp: now + 3600,
  }
}

// ---------------------------------------------------------------------------
// OpenAI-shaped error helpers
// ---------------------------------------------------------------------------

function unauthorized(c: Context) {
  return c.json(
    {
      error: {
        message:
          'Invalid or missing API key. Use Authorization: Bearer <shogo_sk_… key>.',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    },
    401,
  )
}

function modelRequired(c: Context) {
  return c.json(
    {
      error: {
        message: 'model is required',
        type: 'invalid_request_error',
        code: 'model_required',
      },
    },
    400,
  )
}

function modelNotFound(c: Context, model: string) {
  return c.json(
    {
      error: {
        message: `The model '${model}' does not exist or you do not have access to it. Use GET /v1/models to list available models.`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    },
    404,
  )
}

// ---------------------------------------------------------------------------
// Response model masking
// ---------------------------------------------------------------------------

/**
 * Rewrite the `model` field of a single SSE line (and the nested
 * `response.model` used by the Responses API) to the public id, so streamed
 * chunks never disclose the backing model. Non-`data:` lines, `[DONE]`, and
 * unparseable payloads pass through untouched.
 */
function rewriteModelInLine(line: string, publicId: string): string {
  if (!line.startsWith('data: ')) return line
  const data = line.slice(6)
  const trimmed = data.trim()
  if (!trimmed || trimmed === '[DONE]') return line
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      let changed = false
      if (typeof parsed.model === 'string') {
        parsed.model = publicId
        changed = true
      }
      if (parsed.response && typeof parsed.response.model === 'string') {
        parsed.response.model = publicId
        changed = true
      }
      if (changed) return `data: ${JSON.stringify(parsed)}`
    }
  } catch {
    // Leave unparseable lines as-is.
  }
  return line
}

/** Pipe an SSE body through a transform that masks the model id per line. */
function maskModelInSseStream(
  body: ReadableStream<Uint8Array>,
  publicId: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      // Keep the trailing (possibly incomplete) line buffered.
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${rewriteModelInLine(line, publicId)}\n`))
      }
    },
    flush(controller) {
      if (buffer) {
        controller.enqueue(encoder.encode(rewriteModelInLine(buffer, publicId)))
      }
    },
  })
  return body.pipeThrough(transform)
}

/** Build streaming response headers without the internal X-Proxy-* leakage. */
function publicStreamHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers)
  headers.delete('X-Proxy-Provider')
  headers.delete('X-Proxy-Model')
  headers.set('Content-Type', 'text/event-stream')
  headers.set('Cache-Control', 'no-cache')
  headers.set('Connection', 'keep-alive')
  return headers
}

// ---------------------------------------------------------------------------
// Shared per-request gating (balance + tier), returns a Response on rejection
// ---------------------------------------------------------------------------

async function checkBalance(
  c: Context,
  payload: ProxyTokenPayload,
): Promise<Response | null> {
  if (isLocalDev) return null
  if (await billingService.hasBalance(payload.workspaceId)) return null
  const usageLimit = await buildUsageLimitInfo(payload.workspaceId)
  return c.json(
    {
      error: {
        message:
          'Usage limit reached. Enable usage-based pricing or upgrade your plan.',
        type: 'billing_error',
        code: 'usage_limit_reached',
        ...usageLimit,
      },
    },
    402,
  )
}

async function checkTier(
  c: Context,
  payload: ProxyTokenPayload,
  modelConfig: ModelConfig,
  backingId: string,
  publicId: string,
): Promise<Response | null> {
  if (isLocalDev) return null
  if (modelConfig.provider === 'local' || modelConfig.provider === 'openrouter') {
    return null
  }
  const tier = resolveModelTier(backingId)
  if (tier === 'economy') return null
  if (await billingService.hasAdvancedModelAccess(payload.workspaceId)) return null
  return c.json(
    {
      error: {
        message: `The model '${publicId}' requires a Pro or higher subscription.`,
        type: 'billing_error',
        code: 'model_tier_restricted',
      },
    },
    403,
  )
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function publicApiRoutes() {
  const router = new Hono()

  // -------------------------------------------------------------------------
  // GET /v1/health — unauthenticated liveness probe
  // -------------------------------------------------------------------------
  router.get('/health', (c) =>
    c.json({ status: 'ok', service: 'shogo-public-api' }),
  )

  // -------------------------------------------------------------------------
  // GET /v1/models — list public (Shogo-branded) models only
  // -------------------------------------------------------------------------
  router.get('/models', async (c) => {
    const payload = await authenticate(c)
    if (!payload) return unauthorized(c)

    const created = Math.floor(Date.now() / 1000)
    const data = getPublicModelsSync().map((m) => ({
      id: m.publicId,
      object: 'model',
      created,
      owned_by: 'shogo',
      display_name: m.displayName,
    }))
    return c.json({ object: 'list', data })
  })

  // -------------------------------------------------------------------------
  // POST /v1/chat/completions — OpenAI-compatible chat completions
  // -------------------------------------------------------------------------
  router.post('/chat/completions', async (c) => {
    const payload = await authenticate(c)
    if (!payload) return unauthorized(c)

    let request: ChatCompletionRequest
    try {
      request = await c.req.json()
    } catch {
      return c.json(
        { error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'invalid_body' } },
        400,
      )
    }

    const publicId = request.model
    if (!publicId) return modelRequired(c)

    const publicModel = resolvePublicModelSync(publicId)
    if (!publicModel) return modelNotFound(c, publicId)

    const balanceError = await checkBalance(c, payload)
    if (balanceError) return balanceError

    const backingId = publicModel.backingModelId
    request.model = backingId

    const modelConfig = resolveModel(backingId)
    if (!modelConfig) {
      console.error(
        `[Public API] Public model '${publicId}' maps to unknown backing model '${backingId}'`,
      )
      return c.json(
        {
          error: {
            message: `The model '${publicId}' is temporarily unavailable.`,
            type: 'server_error',
            code: 'model_misconfigured',
          },
        },
        503,
      )
    }

    const tierError = await checkTier(c, payload, modelConfig, backingId, publicId)
    if (tierError) return tierError

    const apiKey = resolveModelApiKey(modelConfig)
    if (!apiKey) {
      return c.json(
        {
          error: {
            message: `The model '${publicId}' is temporarily unavailable.`,
            type: 'server_error',
            code: 'provider_not_configured',
          },
        },
        503,
      )
    }

    try {
      if (request.stream) {
        let upstream: Response
        if (modelConfig.provider === 'anthropic') {
          upstream = await proxyAnthropicStream(
            request,
            apiKey,
            modelConfig,
            (inTok, outTok, cachedTok, cacheWriteTok) =>
              recordUsage(payload, backingId, inTok, outTok, cachedTok, cacheWriteTok, null),
            c.req.raw.signal,
          )
        } else {
          upstream = await proxyOpenAIStream(
            request,
            apiKey,
            modelConfig,
            (inTok, outTok, cachedTok) =>
              recordUsage(payload, backingId, inTok, outTok, cachedTok, 0, null),
            c.req.raw.signal,
          )
        }
        const body = upstream.body
          ? maskModelInSseStream(upstream.body, publicId)
          : upstream.body
        return new Response(body, {
          status: upstream.status,
          headers: publicStreamHeaders(upstream),
        })
      }

      let result: any
      if (modelConfig.provider === 'anthropic') {
        result = await proxyAnthropicNonStream(request, apiKey, modelConfig, c.req.raw.signal)
      } else {
        result = await proxyOpenAINonStream(request, apiKey, modelConfig, c.req.raw.signal)
      }

      const totalPrompt = result?.usage?.prompt_tokens || 0
      const cachedPrompt = result?.usage?.prompt_tokens_details?.cached_tokens || 0
      recordUsage(
        payload,
        backingId,
        totalPrompt - cachedPrompt,
        result?.usage?.completion_tokens || 0,
        cachedPrompt,
        0,
        null,
      )

      if (result && typeof result === 'object') result.model = publicId
      return c.json(result)
    } catch (error: any) {
      console.error('[Public API] chat/completions error:', error?.message)
      const statusCode = error?.message?.includes('429')
        ? 429
        : error?.message?.includes('503')
          ? 503
          : 500
      return c.json(
        {
          error: {
            message: 'The upstream model is temporarily unavailable. Please retry.',
            type: 'server_error',
            code: 'upstream_error',
          },
        },
        statusCode,
      )
    }
  })

  // -------------------------------------------------------------------------
  // POST /v1/responses — OpenAI Responses API (only for OpenAI-backed models)
  // -------------------------------------------------------------------------
  router.post('/responses', async (c) => {
    const payload = await authenticate(c)
    if (!payload) return unauthorized(c)

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'invalid_body' } },
        400,
      )
    }

    const publicId = body?.model
    if (!publicId) return modelRequired(c)

    const publicModel = resolvePublicModelSync(publicId)
    if (!publicModel) return modelNotFound(c, publicId)

    const balanceError = await checkBalance(c, payload)
    if (balanceError) return balanceError

    const backingId = publicModel.backingModelId
    const modelConfig = resolveModel(backingId)
    if (!modelConfig) {
      console.error(
        `[Public API] Public model '${publicId}' maps to unknown backing model '${backingId}'`,
      )
      return c.json(
        {
          error: {
            message: `The model '${publicId}' is temporarily unavailable.`,
            type: 'server_error',
            code: 'model_misconfigured',
          },
        },
        503,
      )
    }

    // The Responses API is OpenAI-specific. Anthropic-backed public models use
    // /v1/chat/completions instead.
    if (modelConfig.provider !== 'openai') {
      return c.json(
        {
          error: {
            message: `The model '${publicId}' does not support the responses API. Use /v1/chat/completions.`,
            type: 'invalid_request_error',
            code: 'unsupported_endpoint',
          },
        },
        400,
      )
    }

    const tierError = await checkTier(c, payload, modelConfig, backingId, publicId)
    if (tierError) return tierError

    const apiKey = resolveModelApiKey(modelConfig)
    if (!apiKey) {
      return c.json(
        {
          error: {
            message: `The model '${publicId}' is temporarily unavailable.`,
            type: 'server_error',
            code: 'provider_not_configured',
          },
        },
        503,
      )
    }

    try {
      const isStream = !!body.stream
      const forwardBody = { ...body, model: modelConfig.apiModel }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(forwardBody),
        signal: c.req.raw.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(
          `[Public API] responses error (${response.status}): ${errorText.slice(0, 300)}`,
        )
        const status = response.status === 429 ? 429 : 502
        return c.json(
          {
            error: {
              message: 'The upstream model is temporarily unavailable. Please retry.',
              type: 'server_error',
              code: 'upstream_error',
            },
          },
          status,
        )
      }

      if (isStream) {
        const decoder = new TextDecoder()
        let inputTokens = 0
        let outputTokens = 0
        let cachedInputTokens = 0
        let usageBuffer = ''

        const usageTap = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk)
            usageBuffer += decoder.decode(chunk, { stream: true })
            const lines = usageBuffer.split('\n')
            usageBuffer = lines.pop() || ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              if (data === '[DONE]') continue
              try {
                const parsed = JSON.parse(data)
                if (parsed.type === 'response.completed' && parsed.response?.usage) {
                  const totalInput = parsed.response.usage.input_tokens || 0
                  cachedInputTokens =
                    parsed.response.usage.input_tokens_details?.cached_tokens || 0
                  inputTokens = totalInput - cachedInputTokens
                  outputTokens = parsed.response.usage.output_tokens || 0
                }
              } catch {
                // ignore
              }
            }
          },
          flush() {
            if (inputTokens || outputTokens || cachedInputTokens) {
              recordUsage(payload, backingId, inputTokens, outputTokens, cachedInputTokens, 0, null)
            }
          },
        })

        const masked = maskModelInSseStream(
          response.body!.pipeThrough(usageTap),
          publicId,
        )
        return new Response(masked, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      }

      const result = (await response.json()) as any
      if (result?.usage) {
        const totalInput = result.usage.input_tokens || 0
        const cachedInput = result.usage.input_tokens_details?.cached_tokens || 0
        recordUsage(
          payload,
          backingId,
          totalInput - cachedInput,
          result.usage.output_tokens || 0,
          cachedInput,
          0,
          null,
        )
      }
      if (result && typeof result === 'object' && typeof result.model === 'string') {
        result.model = publicId
      }
      return c.json(result)
    } catch (error: any) {
      console.error('[Public API] responses error:', error?.message)
      return c.json(
        {
          error: {
            message: 'The upstream model is temporarily unavailable. Please retry.',
            type: 'server_error',
            code: 'upstream_error',
          },
        },
        500,
      )
    }
  })

  return router
}
