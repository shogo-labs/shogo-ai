// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pi Agent Core Adapter
 *
 * Bridges between Shogo's internal types and Pi Agent Core / Pi AI types.
 * Provides:
 * - Model resolution (provider + modelId -> Pi Model object)
 * - Message type conversion (Pi Message <-> legacy AnthropicMessage)
 * - API key resolution from environment
 * - Mock stream function for tests
 */

import {
  type Model,
  type Api,
  type Message,
  type UserMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ImageContent,
  type ToolCall,
  type Usage,
  EventStream,
  createAssistantMessageEventStream,
  getModel,
  getModels,
  getProviders,
} from '@mariozechner/pi-ai'
import type { AgentMessage, StreamFn } from '@mariozechner/pi-agent-core'

// ---------------------------------------------------------------------------
// Model Resolution
// ---------------------------------------------------------------------------

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  'google-vertex': 'GOOGLE_VERTEX_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
}

const PROVIDER_BASE_URL_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  google: 'GOOGLE_BASE_URL',
  xai: 'XAI_BASE_URL',
  groq: 'GROQ_BASE_URL',
  cerebras: 'CEREBRAS_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  mistral: 'MISTRAL_BASE_URL',
}

/**
 * Resolve a Pi Model object from a provider + modelId string.
 * Respects *_BASE_URL env vars (set by configureAIProxy) to route through
 * the API server's AI proxy instead of hitting provider APIs directly.
 */
export function resolveModel(provider: string, modelId: string): Model<Api> {
  let model: Model<Api> | undefined
  try {
    model = getModel(provider as any, modelId as any) ?? undefined
  } catch {
    // Model not in registry
  }

  if (!model) {
    model = {
      id: modelId,
      name: modelId,
      api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      provider,
      baseUrl: getDefaultBaseUrl(provider),
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } as Model<Api>
  }

  const envBaseUrl = resolveBaseUrl(provider)
  if (envBaseUrl) {
    return { ...model, baseUrl: envBaseUrl }
  }

  return model
}

/**
 * Check for a provider-specific *_BASE_URL override in the environment.
 * Used by configureAIProxy to route requests through the API server's proxy.
 */
function resolveBaseUrl(provider: string): string | undefined {
  const envVar = PROVIDER_BASE_URL_ENV[provider]
  if (envVar) return process.env[envVar]
  const genericKey = `${provider.toUpperCase().replace(/-/g, '_')}_BASE_URL`
  return process.env[genericKey]
}

function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com'
    case 'openai': return 'https://api.openai.com'
    case 'google': return 'https://generativelanguage.googleapis.com'
    case 'xai': return 'https://api.x.ai'
    case 'groq': return 'https://api.groq.com/openai'
    case 'cerebras': return 'https://api.cerebras.ai'
    default: return ''
  }
}

/**
 * Resolve API key for a provider from environment variables.
 */
export function resolveApiKey(provider: string): string | undefined {
  const envVar = PROVIDER_API_KEY_ENV[provider]
  if (envVar) return process.env[envVar]
  // Generic fallback: TRY_PROVIDER_API_KEY
  const genericKey = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
  return process.env[genericKey]
}

// ---------------------------------------------------------------------------
// Message Type Helpers
// ---------------------------------------------------------------------------

/**
 * Create a Pi UserMessage from a text string.
 * Uses the string format for content (Pi accepts both string and array formats).
 */
export function userMessage(text: string): UserMessage {
  return {
    role: 'user',
    content: text,
    timestamp: Date.now(),
  }
}

/**
 * Create a Pi UserMessage with text and optional image content.
 * Falls back to simple string content when no images are provided.
 */
export function userMessageWithImages(text: string, images: ImageContent[]): UserMessage {
  if (images.length === 0) return userMessage(text)
  const content: (TextContent | ImageContent)[] = []
  if (text) content.push({ type: 'text', text })
  content.push(...images)
  return { role: 'user', content, timestamp: Date.now() }
}

/**
 * Extract text from a UserMessage's content (handles both string and array formats).
 */
export function extractUserText(msg: UserMessage): string {
  if (typeof msg.content === 'string') return msg.content
  return (msg.content as any[])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('')
}

/**
 * Extract text content from a Pi AssistantMessage.
 */
export function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

/**
 * Extract text from a sequence of Pi Messages, taking the last assistant text.
 */
export function extractFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant') {
      return extractAssistantText(msg)
    }
  }
  return ''
}

/**
 * Count tool calls across a sequence of messages.
 */
export function countToolCalls(messages: Message[]): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      count += msg.content.filter((c) => c.type === 'toolCall').length
    }
  }
  return count
}

/**
 * Sum token usage across a sequence of messages.
 */
export function sumUsage(messages: Message[]): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      input += msg.usage.input
      output += msg.usage.output
      cacheRead += msg.usage.cacheRead ?? 0
      cacheWrite += msg.usage.cacheWrite ?? 0
    }
  }
  return { input, output, cacheRead, cacheWrite }
}

// ---------------------------------------------------------------------------
// Default convertToLlm
// ---------------------------------------------------------------------------

/**
 * Default message converter: keeps only LLM-compatible messages.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
  )
}

// ---------------------------------------------------------------------------
// Mock StreamFn for Testing
// ---------------------------------------------------------------------------

const EMPTY_USAGE: Usage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Build a Pi AssistantMessage with text-only content.
 */
export function buildTextResponse(text: string, usage?: Partial<Usage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock-model',
    usage: { ...EMPTY_USAGE, ...usage },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

/**
 * Build a Pi AssistantMessage with one or more tool calls.
 */
export function buildToolUseResponse(
  toolCalls: Array<{ name: string; arguments: Record<string, any>; id?: string }>,
  usage?: Partial<Usage>,
): AssistantMessage {
  return {
    role: 'assistant',
    content: toolCalls.map((tc, i) => ({
      type: 'toolCall' as const,
      id: tc.id || `toolu_${i}`,
      name: tc.name,
      arguments: tc.arguments,
    })),
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock-model',
    usage: { ...EMPTY_USAGE, ...usage },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  }
}

/**
 * Create a mock StreamFn that returns pre-configured responses in sequence.
 *
 * Usage in tests:
 * ```
 * const mockStream = createMockStreamFn([
 *   buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' } }]),
 *   buildTextResponse('Done reading.'),
 * ])
 * const agent = new Agent({ streamFn: mockStream })
 * ```
 */
export function createMockStreamFn(
  responses: AssistantMessage[],
  onCall?: (index: number, messages: Message[]) => void,
): StreamFn {
  let idx = 0

  return (_model, context, options) => {
    const signal = (options as any)?.signal as AbortSignal | undefined

    // If already aborted, return an aborted response
    if (signal?.aborted) {
      const abortedMsg: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: '[aborted]' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'mock-model',
        usage: { ...EMPTY_USAGE },
        stopReason: 'aborted',
        timestamp: Date.now(),
      }
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: abortedMsg })
        stream.push({ type: 'done', reason: 'stop', message: abortedMsg })
        stream.end(abortedMsg)
      })
      return stream as any
    }

    const responseIdx = Math.min(idx, responses.length - 1)
    const msg = responses[responseIdx]
    idx++

    onCall?.(responseIdx, context.messages)

    const stream = createAssistantMessageEventStream()

    queueMicrotask(() => {
      stream.push({ type: 'start', partial: msg })

      if (msg.stopReason === 'error') {
        stream.push({ type: 'error', reason: 'error', error: msg })
      } else {
        const reason = msg.content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop'
        stream.push({ type: 'done', reason, message: msg })
      }

      stream.end(msg)
    })

    return stream as any
  }
}
