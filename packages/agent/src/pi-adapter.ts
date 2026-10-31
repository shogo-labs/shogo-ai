// SPDX-License-Identifier: MIT
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
import {
  getDynamicModel,
  getMaxOutputTokens,
  isAnthropicBacked,
  OPENROUTER_MODEL_PREFIX,
  stripOpenRouterPrefix,
} from './model-catalog'

const DEFAULT_CONTEXT_WINDOW = 200_000

// ---------------------------------------------------------------------------
// Model Resolution
// ---------------------------------------------------------------------------

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  // Local models still use the runtime's proxy token when requests are sent
  // through the API's OpenAI-compatible proxy endpoint.
  local: 'OPENAI_API_KEY',
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
  local: 'OPENAI_BASE_URL',
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
  // DB-defined custom OpenAI-compatible models (e.g. MiMo) are not in pi-ai's
  // static registry and must not be mis-inferred as native Anthropic/OpenAI
  // models. Route them through the AI proxy's OpenAI *chat-completions*
  // endpoint, which resolves the DB model id to its real upstream provider
  // and preserves tool calls / streaming (the Anthropic conversion path is
  // text-only). Tag the pi model's provider as 'openai' so the proxy token
  // and base URL injected by configureAIProxy (OPENAI_API_KEY /
  // OPENAI_BASE_URL) are used for auth and routing.
  const dynamic = getDynamicModel(modelId)
  const contextWindow = dynamic?.contextWindow ?? DEFAULT_CONTEXT_WINDOW

  // A 'custom' id the API registry knows is Anthropic-backed (e.g. Opus 5.5
  // addressed by UUID) goes through the native Anthropic path, where pi-ai
  // places prompt-cache breakpoints. The proxy maps the id to its apiModel.
  if (provider === 'custom' && isAnthropicBacked(dynamic)) {
    return resolveModel('anthropic', modelId)
  }

  // A DB-defined Google model (Gemini) is addressed by an opaque UUID the
  // runtime can't classify, and the proxy is the only place that holds the
  // Google key — so route it through the proxy's OpenAI-compatible
  // chat-completions endpoint exactly like a custom provider. Gemini's
  // upstream is reached from the API server (`provider: 'google'`).
  if (provider === 'custom' || provider === 'google') {
    const baseUrl = resolveBaseUrl('openai') ?? getDefaultBaseUrl('openai')
    const deepSeek = provider === 'custom' && isDeepSeekModel(modelId)
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'openai',
      baseUrl,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: getMaxOutputTokens(modelId),
      // Anthropic-style cache markers survive the proxy's chat-completions →
      // Anthropic conversion, and the proxy drops them for other upstreams.
      compat: {
        cacheControlFormat: 'anthropic',
        ...(deepSeek
          ? {
              thinkingFormat: 'deepseek',
              requiresReasoningContentOnAssistantMessages: true,
              supportsStore: false,
              supportsDeveloperRole: false,
            }
          : {}),
      },
    } as Model<Api>
  }

  // Strip our `openrouter:` catalog prefix before consulting pi-ai's
  // registry — pi-ai stores OpenRouter models by their bare upstream id
  // (e.g. `xiaomi/mimo-v2.5`).
  const lookupId =
    provider === 'openrouter' && modelId.startsWith(OPENROUTER_MODEL_PREFIX)
      ? stripOpenRouterPrefix(modelId)
      : modelId
  const catalogMax = getMaxOutputTokens(modelId)

  let model: Model<Api> | undefined
  try {
    model = getModel(provider as any, lookupId as any) ?? undefined
  } catch {
    // Model not in registry
  }

  if (!model) {
    // OpenRouter is OpenAI Chat Completions-compatible — use that API
    // shape and route through OpenRouter's base URL. Pi-ai's built-in
    // OpenRouter model entries follow exactly the same convention.
    const isLocal = provider === 'local'
    const isOpenRouter = provider === 'openrouter'
    model = {
      id: lookupId,
      name: lookupId,
      api: provider === 'anthropic'
        ? 'anthropic-messages'
        : isOpenRouter || isLocal
          ? 'openai-completions'
          : 'openai-responses',
      provider,
      baseUrl: getDefaultBaseUrl(provider),
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: catalogMax,
    } as Model<Api>
  } else {
    model = { ...model, maxTokens: catalogMax }
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

function isDeepSeekModel(modelId: string): boolean {
  if (modelId.startsWith('deepseek-')) return true
  const configured = (process.env.AGENT_DEEPSEEK_MODEL_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return configured.includes(modelId)
}

function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com'
    case 'openai': return 'https://api.openai.com'
    case 'google': return 'https://generativelanguage.googleapis.com'
    case 'xai': return 'https://api.x.ai'
    case 'groq': return 'https://api.groq.com/openai'
    case 'cerebras': return 'https://api.cerebras.ai'
    case 'openrouter': return 'https://openrouter.ai/api/v1'
    case 'mistral': return 'https://api.mistral.ai'
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
 * Providers only accept tool-call ids matching `^[a-zA-Z0-9_-]+$` within a
 * length cap, but an id is whatever the provider that *made* the call chose
 * (OpenAI `call_ab:c`, Gemini ids, custom gateways with dots or slashes). A
 * replayed id the next provider rejects fails the whole turn with a 400
 * (`messages.3.content.0.tool_use.id: …`), and re-sending cannot fix it — the
 * bad id is in the transcript. Normalize on the way out instead (SHO-270).
 *
 * Pure function of the original id, so a tool call and its result always map
 * to the same outbound id.
 */
export function sanitizeToolCallId(id: string): string {
  const cleaned = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!cleaned) return 'tool_call'
  if (cleaned.length <= 64) return cleaned
  // Same 64-char prefix on two ids would merge two different calls; a short
  // hash of the original keeps truncated ids distinct and still stable.
  let hash = 0x811c9dc5
  for (let i = 0; i < cleaned.length; i++) {
    hash ^= cleaned.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${cleaned.slice(0, 57)}_${hash.toString(36).slice(0, 6)}`
}

/**
 * Rewrite every tool-call id in a converted history through
 * `sanitizeToolCallId`. Returns the input array unchanged when nothing needed
 * rewriting, so callers can use reference equality.
 */
export function sanitizeToolCallIds(messages: Message[]): Message[] {
  let mutated = false
  const out = messages.map((msg) => {
    if (msg.role === 'toolResult') {
      const next = sanitizeToolCallId(msg.toolCallId)
      if (next === msg.toolCallId) return msg
      mutated = true
      return { ...msg, toolCallId: next }
    }
    if (msg.role !== 'assistant') return msg
    // Hydrated / compacted histories can carry an assistant message whose
    // content is a plain string rather than blocks.
    if (!Array.isArray(msg.content)) return msg
    let changed = false
    const content = msg.content.map((block) => {
      if (block.type !== 'toolCall') return block
      const next = sanitizeToolCallId(block.id)
      if (next === block.id) return block
      changed = true
      return { ...block, id: next }
    })
    if (!changed) return msg
    mutated = true
    return { ...msg, content }
  })
  return mutated ? out : messages
}

/**
 * Default message converter: keeps only LLM-compatible messages, with tool
 * results re-paired to their tool calls (see `repairToolResultPairing`) and
 * tool-call ids normalized to what any provider will accept.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  const llm = messages.filter(
    (m): m is Message =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
  )
  const repaired = repairToolResultPairing(llm)
  if (repaired.moved > 0 || repaired.dropped > 0) {
    console.warn(
      `[pi-adapter] Repaired tool-result pairing: moved=${repaired.moved} dropped=${repaired.dropped}`,
    )
  }
  return sanitizeToolCallIds(repaired.messages)
}

/**
 * Providers require every tool result to directly follow the assistant
 * message that made the call (OpenAI-compatible APIs reject a stray one with
 * "role 'tool' must be a response to a preceding message with 'tool_calls'").
 * A stopped turn's in-flight tools can append their results after the next
 * turn's messages, so history is not guaranteed to be in that shape.
 *
 * Moves each tool result to just after the most recent earlier assistant
 * message that called it and drops results with no such call. Errored and
 * aborted assistant messages don't count as callers: pi-ai drops them before
 * sending. Missing results are left for pi-ai, which fills them in. Returns
 * the input array unchanged when nothing needed repair.
 */
export function repairToolResultPairing(messages: Message[]): {
  messages: Message[]
  moved: number
  dropped: number
} {
  type Group = { assistant: AssistantMessage; results: ToolResultMessage[] }
  const items: Array<Message | Group> = []
  const pending = new Map<string, Group[]>()
  let dropped = 0

  for (const msg of messages) {
    if (msg.role === 'toolResult') {
      const group = pending.get(msg.toolCallId)?.pop()
      if (group) group.results.push(msg)
      else dropped++
      continue
    }
    if (msg.role !== 'assistant' || msg.stopReason === 'error' || msg.stopReason === 'aborted') {
      items.push(msg)
      continue
    }
    const group: Group = { assistant: msg, results: [] }
    items.push(group)
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== 'toolCall') continue
      const stack = pending.get(block.id) ?? []
      stack.push(group)
      pending.set(block.id, stack)
    }
  }

  const out: Message[] = []
  for (const item of items) {
    if ('assistant' in item) out.push(item.assistant, ...item.results)
    else out.push(item)
  }
  if (dropped === 0 && out.every((m, i) => m === messages[i])) {
    return { messages, moved: 0, dropped: 0 }
  }
  const index = new Map<Message, number>(messages.map((m, i) => [m, i]))
  let moved = 0
  for (let i = 1; i < out.length; i++) {
    if (out[i].role !== 'toolResult') continue
    const prev = messages[index.get(out[i])! - 1]
    if (prev !== out[i - 1] && prev?.role !== 'toolResult') moved++
  }
  return { messages: out, moved, dropped }
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
