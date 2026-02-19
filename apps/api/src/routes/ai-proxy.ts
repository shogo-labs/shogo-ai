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
 * - POST /ai/anthropic/v1/messages     - Anthropic-native pass-through (for Claude Code CLI)
 * - POST /ai/anthropic/v1/messages/count_tokens - Token counting pass-through
 * - GET  /ai/anthropic/v1/models       - Anthropic models pass-through  
 * - POST /ai/proxy/tokens              - Generate a proxy token for a project
 *
 * Authentication:
 * - OpenAI-compatible: `Authorization: Bearer <proxy-token>`
 * - Anthropic-native: `x-api-key: <proxy-token>` (Claude Code CLI sends this)
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

/** Supported model providers */
type Provider = 'anthropic' | 'openai'

/** Model routing configuration */
interface ModelConfig {
  provider: Provider
  apiModel: string
  displayName: string
}

// =============================================================================
// Model Registry
// =============================================================================

const MODEL_REGISTRY: Record<string, ModelConfig> = {
  // ---------------------------------------------------------------------------
  // Anthropic models — Current generation
  // ---------------------------------------------------------------------------
  'claude-opus-4-6': {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
  },
  'claude-sonnet-4-5-20250929': {
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-5-20250929',
    displayName: 'Claude Sonnet 4.5',
  },
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
  },

  // ---------------------------------------------------------------------------
  // Anthropic models — Legacy (still available)
  // ---------------------------------------------------------------------------
  'claude-opus-4-5-20251101': {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-5-20251101',
    displayName: 'Claude Opus 4.5',
  },
  'claude-opus-4-1-20250805': {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-1-20250805',
    displayName: 'Claude Opus 4.1',
  },
  'claude-sonnet-4-20250514': {
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
  },
  'claude-3-7-sonnet-20250219': {
    provider: 'anthropic',
    apiModel: 'claude-3-7-sonnet-20250219',
    displayName: 'Claude 3.7 Sonnet',
  },
  'claude-opus-4-20250514': {
    provider: 'anthropic',
    apiModel: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
  },
  'claude-3-haiku-20240307': {
    provider: 'anthropic',
    apiModel: 'claude-3-haiku-20240307',
    displayName: 'Claude 3 Haiku',
  },

  // ---------------------------------------------------------------------------
  // OpenAI models
  // ---------------------------------------------------------------------------
  'gpt-4o': {
    provider: 'openai',
    apiModel: 'gpt-4o',
    displayName: 'GPT-4o',
  },
  'gpt-4o-mini': {
    provider: 'openai',
    apiModel: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
  },
  'gpt-4-turbo': {
    provider: 'openai',
    apiModel: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
  },
  'o1': {
    provider: 'openai',
    apiModel: 'o1',
    displayName: 'o1',
  },
  'o1-mini': {
    provider: 'openai',
    apiModel: 'o1-mini',
    displayName: 'o1 Mini',
  },
  'o3-mini': {
    provider: 'openai',
    apiModel: 'o3-mini',
    displayName: 'o3 Mini',
  },
}

// Convenience aliases — current generation
MODEL_REGISTRY['claude-opus-4-6'] = MODEL_REGISTRY['claude-opus-4-6']
MODEL_REGISTRY['claude-sonnet-4-5'] = MODEL_REGISTRY['claude-sonnet-4-5-20250929']
MODEL_REGISTRY['claude-haiku-4-5'] = MODEL_REGISTRY['claude-haiku-4-5-20251001']

// Convenience aliases — legacy
MODEL_REGISTRY['claude-opus-4-5'] = MODEL_REGISTRY['claude-opus-4-5-20251101']
MODEL_REGISTRY['claude-opus-4-1'] = MODEL_REGISTRY['claude-opus-4-1-20250805']
MODEL_REGISTRY['claude-sonnet-4-0'] = MODEL_REGISTRY['claude-sonnet-4-20250514']
MODEL_REGISTRY['claude-3-7-sonnet-latest'] = MODEL_REGISTRY['claude-3-7-sonnet-20250219']
MODEL_REGISTRY['claude-opus-4-0'] = MODEL_REGISTRY['claude-opus-4-20250514']

// Short convenience aliases
MODEL_REGISTRY['claude-opus'] = MODEL_REGISTRY['claude-opus-4-6']
MODEL_REGISTRY['claude-sonnet'] = MODEL_REGISTRY['claude-sonnet-4-5-20250929']
MODEL_REGISTRY['claude-haiku'] = MODEL_REGISTRY['claude-haiku-4-5-20251001']

// =============================================================================
// Provider Routing
// =============================================================================

/**
 * Resolve a model name to its configuration.
 * Supports exact matches and prefix matching (e.g., "claude-3" matches the first claude-3.x model).
 */
function resolveModel(model: string): ModelConfig | null {
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
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) {
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
    default:
      return null
  }
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
    max_tokens: request.max_tokens || 4096,
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
function convertAnthropicToOpenAI(anthropicResponse: any, model: string) {
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

/**
 * Proxy a streaming request to Anthropic and convert SSE to OpenAI format.
 */
async function proxyAnthropicStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig
): Promise<Response> {
  const body = convertToAnthropicFormat({
    ...request,
    model: modelConfig.apiModel,
    stream: true,
  })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`)
  }

  // Transform Anthropic SSE stream to OpenAI SSE format
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const completionId = `chatcmpl-${Date.now()}`
  let inputTokens = 0
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

          // Track usage
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0
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
      // Send [DONE] marker
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
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
  modelConfig: ModelConfig
) {
  const body = convertToAnthropicFormat({
    ...request,
    model: modelConfig.apiModel,
    stream: false,
  })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`)
  }

  const anthropicResponse = await response.json()
  return convertAnthropicToOpenAI(anthropicResponse, request.model)
}

// =============================================================================
// OpenAI Proxy (pass-through)
// =============================================================================

/**
 * Proxy a streaming request to OpenAI (pass-through, already OpenAI format).
 */
async function proxyOpenAIStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig
): Promise<Response> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      ...request,
      model: modelConfig.apiModel,
      stream: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`)
  }

  return new Response(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Proxy-Provider': 'openai',
      'X-Proxy-Model': modelConfig.apiModel,
    },
  })
}

/**
 * Proxy a non-streaming request to OpenAI (pass-through).
 */
async function proxyOpenAINonStream(
  request: ChatCompletionRequest,
  apiKey: string,
  modelConfig: ModelConfig
) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      ...request,
      model: modelConfig.apiModel,
      stream: false,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`)
  }

  return response.json()
}

// =============================================================================
// Usage Logging
// =============================================================================

import { calculateCreditCost, proxyModelToBillingModel } from '../lib/credit-cost'
import * as billingService from '../services/billing.service'
import { getProjectUser } from '../lib/project-user-context'

/**
 * Charge credits and log usage event (fire-and-forget).
 * If totalTokens is 0 (streaming), charges the model's minimum cost.
 */
async function chargeAndLogUsage(
  tokenPayload: ProxyTokenPayload,
  model: string,
  provider: Provider,
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
  success: boolean,
  errorMessage?: string
) {
  try {
    const totalTokens = inputTokens + outputTokens
    const billingModel = proxyModelToBillingModel(model)
    // For streaming with unknown tokens, charge minimum cost for the model
    const creditCost = success
      ? (totalTokens > 0 ? calculateCreditCost(totalTokens, billingModel) : calculateCreditCost(0, billingModel))
      : 0

    const actionMetadata = {
      model, provider, inputTokens, outputTokens, totalTokens,
      durationMs, success, errorMessage,
      stream: totalTokens === 0,
    }

    if (creditCost > 0) {
      // Prefer the real user from the per-project context (set by project-chat)
      // over the token's userId which is typically 'system' for runtime tokens
      const billingUserId = getProjectUser(tokenPayload.projectId) || tokenPayload.userId || 'system'
      const result = await billingService.consumeCredits(
        tokenPayload.workspaceId,
        tokenPayload.projectId || null,
        billingUserId,
        'ai_proxy_completion',
        creditCost,
        actionMetadata
      )
      if (result.success) {
        console.log(`[AI Proxy] 💰 Charged ${creditCost} credits (${totalTokens} tokens, model: ${billingModel}) — remaining: ${result.remainingCredits}`)
      } else {
        console.warn(`[AI Proxy] ⚠️ Could not charge credits: ${result.error}`)
      }
    }
  } catch (err) {
    console.error('[AI Proxy] Failed to log usage event:', err)
  }
}

// =============================================================================
// Routes
// =============================================================================

export function aiProxyRoutes() {
  const router = new Hono()

  /**
   * Middleware: Validate proxy token on all /ai/v1/* routes.
   */
  async function validateProxyAuth(c: any): Promise<ProxyTokenPayload | null> {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return null
    }
    const token = authHeader.slice(7)
    return verifyProxyToken(token)
  }

  // =========================================================================
  // POST /ai/v1/chat/completions - OpenAI-compatible chat completions proxy
  // =========================================================================
  router.post('/ai/v1/chat/completions', async (c) => {
    const startTime = Date.now()

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

    // Pre-check: reject if workspace has no credits
    if (!await billingService.hasCredits(tokenPayload.workspaceId)) {
      return c.json(
        {
          error: {
            message: 'Insufficient credits. Please upgrade your plan.',
            type: 'billing_error',
            code: 'insufficient_credits',
          },
        },
        402
      )
    }

    try {
      const request: ChatCompletionRequest = await c.req.json()

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
        let response: Response
        if (modelConfig.provider === 'anthropic') {
          response = await proxyAnthropicStream(request, apiKey, modelConfig)
        } else {
          response = await proxyOpenAIStream(request, apiKey, modelConfig)
        }

        // Charge minimum credits for streaming (exact tokens unknown)
        const durationMs = Date.now() - startTime
        chargeAndLogUsage(tokenPayload, request.model, modelConfig.provider, 0, 0, durationMs, true)

        return response
      } else {
        let result: any
        if (modelConfig.provider === 'anthropic') {
          result = await proxyAnthropicNonStream(request, apiKey, modelConfig)
        } else {
          result = await proxyOpenAINonStream(request, apiKey, modelConfig)
        }

        // Charge credits with actual token counts
        const durationMs = Date.now() - startTime
        chargeAndLogUsage(
          tokenPayload,
          request.model,
          modelConfig.provider,
          result.usage?.prompt_tokens || 0,
          result.usage?.completion_tokens || 0,
          durationMs,
          true
        )

        return c.json(result)
      }
    } catch (error: any) {
      const durationMs = Date.now() - startTime
      console.error('[AI Proxy] Error:', error.message)

      chargeAndLogUsage(tokenPayload, 'unknown', 'anthropic', 0, 0, durationMs, false, error.message)

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
  // forward them directly to api.anthropic.com. This allows the Claude Code
  // CLI to use the proxy via ANTHROPIC_BASE_URL without any format conversion.
  //
  // Auth: The proxy token is sent via the `x-api-key` header (same header
  // that Claude Code CLI uses for ANTHROPIC_API_KEY).

  /**
   * Validate Anthropic-style auth (x-api-key header contains proxy token).
   */
  async function validateAnthropicAuth(c: any): Promise<ProxyTokenPayload | null> {
    const apiKey = c.req.header('x-api-key')
    if (!apiKey) {
      return null
    }
    return verifyProxyToken(apiKey)
  }

  /**
   * POST /ai/anthropic/v1/messages - Anthropic Messages API pass-through
   *
   * Claude Code CLI sets ANTHROPIC_BASE_URL to our proxy and sends requests
   * here. We validate the proxy token (sent as x-api-key), then forward the
   * request to the real Anthropic API with our server-side API key.
   */
  router.post('/ai/anthropic/v1/messages', async (c) => {
    const startTime = Date.now()

    // Authenticate via x-api-key (proxy token)
    const tokenPayload = await validateAnthropicAuth(c)
    if (!tokenPayload) {
      return c.json(
        { type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing proxy token in x-api-key header.' } },
        401
      )
    }

    // Pre-check credits
    if (!await billingService.hasCredits(tokenPayload.workspaceId)) {
      return c.json(
        { type: 'error', error: { type: 'billing_error', message: 'Insufficient credits. Please upgrade your plan.' } },
        402
      )
    }

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicApiKey) {
      return c.json(
        { type: 'error', error: { type: 'api_error', message: 'Anthropic provider is not configured on this server.' } },
        503
      )
    }

    try {
      const body = await c.req.text()

      let model = 'unknown'
      let isStream = false
      try {
        const parsed = JSON.parse(body)
        model = parsed.model || 'unknown'
        isStream = !!parsed.stream
      } catch { /* ok */ }

      console.log(`[AI Proxy] Anthropic pass-through: ${tokenPayload.projectId} → ${model} (stream: ${isStream})`)

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

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body,
      })

      if (!response.ok) {
        const durationMs = Date.now() - startTime
        chargeAndLogUsage(tokenPayload, model, 'anthropic', 0, 0, durationMs, false, `HTTP ${response.status}`)
        const errorBody = await response.text()
        return new Response(errorBody, {
          status: response.status,
          headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
        })
      }

      if (!isStream) {
        // Non-streaming: parse response to extract token usage, then charge accurately
        const responseBody = await response.json() as any
        const durationMs = Date.now() - startTime
        const inputTokens = responseBody.usage?.input_tokens || 0
        const outputTokens = responseBody.usage?.output_tokens || 0
        chargeAndLogUsage(tokenPayload, model, 'anthropic', inputTokens, outputTokens, durationMs, true)
        return c.json(responseBody)
      }

      // Streaming: copy relevant response headers and forward body as-is
      const responseHeaders = new Headers()
      const contentType = response.headers.get('Content-Type')
      if (contentType) responseHeaders.set('Content-Type', contentType)
      const requestId = response.headers.get('request-id')
      if (requestId) responseHeaders.set('request-id', requestId)
      responseHeaders.set('X-Proxy-Provider', 'anthropic')
      responseHeaders.set('X-Proxy-Project', tokenPayload.projectId)

      const durationMs = Date.now() - startTime
      chargeAndLogUsage(tokenPayload, model, 'anthropic', 0, 0, durationMs, true)

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    } catch (error: any) {
      const durationMs = Date.now() - startTime
      console.error('[AI Proxy] Anthropic pass-through error:', error.message)
      chargeAndLogUsage(tokenPayload, 'unknown', 'anthropic', 0, 0, durationMs, false, error.message)
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

    const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers,
      body,
    })

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
    })

    const responseBody = await response.text()
    return new Response(responseBody, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
    })
  })

  // =========================================================================
  // GET /ai/proxy/health - Health check for the AI proxy
  // =========================================================================
  router.get('/ai/proxy/health', (c) => {
    const providers: Record<string, boolean> = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
    }

    return c.json({
      status: 'ok',
      providers,
      modelCount: Object.keys(MODEL_REGISTRY).length,
    })
  })

  return router
}

export default aiProxyRoutes
