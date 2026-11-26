// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gemini's *native* `generateContent` wire format, for video turns only.
 *
 * Google's OpenAI-compatible endpoint has no way to say how densely a clip
 * should be sampled: it decodes any `data:video/*` block at **1 frame per
 * second of duration** and ignores every spelling of the setting we tried
 * (`video_metadata` as a sibling block, `extra_body.google.video_metadata` →
 * `400 Unknown name "video_metadata"`). A 33 s / 20 fps clip therefore reached
 * the model as 33 frames, and a QA agent signed off a clip with a 10.7 s
 * frozen tail (#2268).
 *
 * The native API does expose it: `videoMetadata {fps, startOffset, endOffset}`
 * on the video part. So a Gemini request that carries video is translated to
 * the native body, sent to `:generateContent` / `:streamGenerateContent`, and
 * translated *back* into exactly the OpenAI chunks/objects our compat path
 * already produces — pi-ai, the capture pipeline and the billing code cannot
 * tell the two apart. Turns without video keep using the compat endpoint,
 * unchanged.
 *
 * Everything in this file is pure: no fetch, no clock, no ids from outside.
 * The transport lives in `ai-proxy.ts`.
 */

import {
  clampVideoFps,
  parseVideoMimeType,
  toGeminiVideoMetadata,
} from '@shogo/model-catalog'

/** The subset of the OpenAI chat-completions request this translator reads. */
export interface NativeContentBlock {
  type: string
  text?: string
  image_url?: { url: string }
  video_url?: { url: string }
}

export interface NativeChatMessage {
  role: string
  content: string | NativeContentBlock[]
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type?: 'function'
    function: { name: string; arguments: string }
  }>
  reasoning_details?: Array<{ type?: string; id?: string; data?: string; text?: string }>
  reasoning_content?: string
  reasoning?: string
}

export interface NativeTranslationRequest {
  messages: NativeChatMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
}

/** Google's documented escape hatch for a replayed call we hold no signature for. */
const GOOGLE_SKIP_SIGNATURE = 'skip_thought_signature_validator'

/**
 * Schema keys Gemini's `functionDeclarations` accepts. Anything else — and
 * our tool schemas are full of `additionalProperties`, `$schema` and
 * `exclusiveMinimum` — is rejected outright with a 400, so the translator
 * sends the allowlisted subset rather than the schema as written.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'anyOf',
  'default',
  'propertyOrdering',
])

/** Gemini's type names for the JSON-schema types our tools actually use. */
const GEMINI_TYPES: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
  null: 'NULL',
}

function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const source = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue
    if (key === 'type') {
      if (typeof value !== 'string') continue
      const mapped = GEMINI_TYPES[value.toLowerCase()]
      if (mapped) out.type = mapped
      continue
    }
    if (key === 'properties') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const properties: Record<string, unknown> = {}
      for (const [name, propertySchema] of Object.entries(value as Record<string, unknown>)) {
        const translated = toGeminiSchema(propertySchema)
        if (translated) properties[name] = translated
      }
      if (Object.keys(properties).length > 0) out.properties = properties
      continue
    }
    if (key === 'items') {
      const translated = toGeminiSchema(value)
      if (translated) out.items = translated
      continue
    }
    if (key === 'anyOf') {
      if (!Array.isArray(value)) continue
      const branches = value.map(toGeminiSchema).filter((branch): branch is Record<string, unknown> => !!branch)
      if (branches.length > 0) out.anyOf = branches
      continue
    }
    if (key === 'required') {
      if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
        out.required = value
      }
      continue
    }
    out[key] = value
  }
  return out
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Tool-call arguments: parsed when they are an object, `{}` when we can't read them. */
function parseJsonArguments(raw: string | undefined): Record<string, unknown> {
  return parseJsonObject(raw) ?? {}
}

/** A `data:` URL split into its media type and payload, or null for anything else. */
export function splitDataUrl(url: string): { mimeType: string; data: string } | null {
  if (!url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma === -1) return null
  const meta = url.slice('data:'.length, comma)
  if (!meta.endsWith(';base64')) return null
  const mimeType = meta.slice(0, -';base64'.length)
  const data = url.slice(comma + 1)
  if (!mimeType || !data) return null
  return { mimeType, data }
}

/**
 * Whether this request must take the native route: Gemini is serving it and
 * at least one block in the conversation is video. False keeps every other
 * turn — image, text, tool-only — on the byte-identical compat path.
 */
export function hasGeminiVideoTurn(messages: NativeChatMessage[]): boolean {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const url = block?.type === 'image_url' ? block.image_url?.url : block?.type === 'video_url' ? block.video_url?.url : undefined
      if (typeof url === 'string' && url.startsWith('data:video/')) return true
    }
  }
  return false
}

/** One media part: `inlineData`, plus `videoMetadata` when a rate was asked for. */
function mediaPart(url: string): Record<string, unknown> | null {
  const split = splitDataUrl(url)
  if (!split) {
    // A remote URL is Google's `fileData` shape. pi-ai never emits one for
    // video, but an MCP tool or a hand-built client can, and dropping it would
    // silently lose the attachment.
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return { fileData: { fileUri: url } }
    }
    return null
  }
  const part: Record<string, unknown> = {
    inlineData: { mimeType: parseVideoMimeType(split.mimeType).mimeType, data: split.data },
  }
  if (split.mimeType.startsWith('video/')) {
    const metadata = toGeminiVideoMetadata(split.mimeType)
    if (metadata) part.videoMetadata = metadata
  }
  return part
}

function textParts(content: string | NativeContentBlock[] | undefined): Record<string, unknown>[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Record<string, unknown>[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ text: block.text })
      continue
    }
    const url = block?.type === 'image_url'
      ? block.image_url?.url
      : block?.type === 'video_url'
        ? block.video_url?.url
        : undefined
    if (typeof url !== 'string') continue
    const part = mediaPart(url)
    if (part) parts.push(part)
  }
  return parts
}

/** `reasoning_details` → tool-call id → thought signature, the same map the compat path builds. */
function signaturesById(message: NativeChatMessage): Map<string, string> {
  const map = new Map<string, string>()
  for (const detail of message.reasoning_details ?? []) {
    if (detail?.type === 'reasoning.encrypted' && typeof detail.id === 'string' && typeof detail.data === 'string') {
      map.set(detail.id, detail.data)
    }
  }
  return map
}

function generationConfig(
  request: NativeTranslationRequest,
  options: { maxOutputTokens: number; thinkingLevel: string },
): Record<string, unknown> {
  // Same precedence as the compat body: the request's own limit, then the
  // catalog cap the caller resolved for us.
  const requested = request.max_tokens ?? (request as { max_completion_tokens?: number }).max_completion_tokens
  const config: Record<string, unknown> = { maxOutputTokens: requested ?? options.maxOutputTokens }
  if (typeof request.temperature === 'number') config.temperature = request.temperature
  if (typeof request.top_p === 'number') config.topP = request.top_p
  const stop = typeof request.stop === 'string' ? [request.stop] : request.stop
  if (Array.isArray(stop) && stop.length > 0 && stop.every((entry) => typeof entry === 'string')) {
    config.stopSequences = stop
  }
  // `xhigh` is a Shogo effort bucket, not a native level: the native enum stops
  // at `high`, and an unsupported value is a 400 that would fail the whole turn.
  const thinkingLevel = options.thinkingLevel === 'xhigh' ? 'high' : options.thinkingLevel
  config.thinkingConfig = { thinkingLevel, includeThoughts: true }
  return config
}

function toolChoiceConfig(choice: NativeTranslationRequest['tool_choice']): Record<string, unknown> | undefined {
  if (!choice) return undefined
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  if (typeof choice === 'object' && choice.function?.name) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } }
  }
  return undefined
}

/**
 * Translate an OpenAI-shaped chat request into a native `generateContent`
 * body.
 *
 * The one rule worth knowing: consecutive `tool` messages are folded into a
 * single `user` turn. Gemini matches a `functionResponse` to its call by name
 * inside the *turn*, so splitting parallel results across turns breaks the
 * pairing it validates (`functionResponse.name` not found in the immediately
 * preceding `functionCall` parts).
 */
export function buildGeminiNativeBody(
  request: NativeTranslationRequest,
  options: {
    /** Google's own model name (`gemini-4-hydrogen`), not our row id. */
    apiModel: string
    /** Already resolved with `googleThinkingLevel` by the caller. */
    thinkingLevel: string
    /** Catalog cap for this model — the compat path always sends one. */
    maxOutputTokens: number
  },
): Record<string, unknown> {
  const systemParts: Record<string, unknown>[] = []
  const contents: Array<{ role: string; parts: Record<string, unknown>[] }> = []
  /** Every function name seen on a `tool_call`, so a `tool` result can name its own. */
  const callNameById = new Map<string, string>()

  for (const message of request.messages) {
    const role = message.role === 'developer' ? 'system' : message.role

    if (role === 'system') {
      systemParts.push(...textParts(message.content))
      continue
    }

    if (role === 'tool') {
      const name = (message.tool_call_id ? callNameById.get(message.tool_call_id) : undefined) ?? message.name
      const raw = typeof message.content === 'string'
        ? message.content
        : (message.content.find((block) => block.type === 'text')?.text ?? '')
      const part: Record<string, unknown> = {
        functionResponse: {
          name: name ?? 'unknown',
          // Gemini requires an object here. JSON passes through as its own
          // object; a tool that answered in prose is wrapped rather than lost.
          response: parseJsonObject(raw) ?? { result: raw },
        },
      }
      const last = contents[contents.length - 1]
      if (last && last.role === 'user' && last.parts.every((existing) => 'functionResponse' in existing)) {
        last.parts.push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
      }
      continue
    }

    if (role === 'assistant') {
      const parts = textParts(message.content)
      const signatures = signaturesById(message)
      for (const toolCall of message.tool_calls ?? []) {
        const name = toolCall?.function?.name
        if (!name) continue
        if (toolCall.id) callNameById.set(toolCall.id, name)
        const part: Record<string, unknown> = {
          functionCall: { name, args: parseJsonArguments(toolCall.function?.arguments) },
        }
        part.thoughtSignature = (toolCall.id ? signatures.get(toolCall.id) : undefined) ?? GOOGLE_SKIP_SIGNATURE
        parts.push(part)
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    const parts = textParts(message.content)
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: generationConfig(request, {
      maxOutputTokens: options.maxOutputTokens,
      thinkingLevel: options.thinkingLevel,
    }),
  }
  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts }

  const declarations = (request.tools ?? [])
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => {
      const declaration: Record<string, unknown> = { name: tool.function.name }
      if (tool.function.description) declaration.description = tool.function.description
      const parameters = toGeminiSchema(tool.function.parameters)
      if (parameters) declaration.parameters = parameters
      return declaration
    })
  if (declarations.length > 0) body.tools = [{ functionDeclarations: declarations }]

  const toolConfig = toolChoiceConfig(request.tool_choice)
  if (toolConfig) body.toolConfig = toolConfig

  return body
}

/** Native `usageMetadata` → the OpenAI `usage` object `recordUsage` already reads. */
export function geminiNativeUsage(usageMetadata: any): Record<string, unknown> | undefined {
  if (!usageMetadata || typeof usageMetadata !== 'object') return undefined
  const promptTokens = Number(usageMetadata.promptTokenCount ?? 0)
  const outputTokens = Number(usageMetadata.candidatesTokenCount ?? 0)
  const reasoningTokens = Number(usageMetadata.thoughtsTokenCount ?? 0)
  const cachedTokens = Number(usageMetadata.cachedContentTokenCount ?? 0)
  const totalTokens = Number(usageMetadata.totalTokenCount ?? promptTokens + outputTokens + reasoningTokens)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens + reasoningTokens,
    total_tokens: totalTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
  }
}

/** Native `finishReason` → OpenAI `finish_reason`. */
export function geminiNativeFinishReason(raw: string | undefined, sawToolCall: boolean): string | null {
  if (sawToolCall) return 'tool_calls'
  switch (raw) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    default:
      return raw ? 'content_filter' : null
  }
}

interface NativePart {
  text?: string
  thought?: boolean
  functionCall?: { name?: string; args?: Record<string, unknown> }
  thoughtSignature?: string
  inlineData?: unknown
}

export interface GeminiNativeStreamOptions {
  /** Model name reported on each chunk, i.e. the compat `model` field. */
  model: string
  /** Deterministic id source for tool-call deltas (tests pass a counter). */
  nextToolCallId?: () => string
}

/** One OpenAI `chat.completion.chunk` line, as the compat rewriter emits them. */
function chunkLine(model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'gemini-native',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}`
}

/**
 * Per-stream rewriter from native SSE lines to the OpenAI chunks our compat
 * path produces. Shaped like `createGoogleSseRewriter` so `proxyOpenAIStream`
 * can reuse one pipeline — including its usage extraction and `onComplete`.
 *
 * A native event carries a whole list of parts, so one line can become several
 * OpenAI chunks (thought text, reply text, tool calls, finish, usage).
 */
export function createGeminiNativeSseRewriter(options: GeminiNativeStreamOptions): {
  (line: string): string | string[]
  flush?: () => string | string[]
} {
  let counter = 0
  /** Index within the OpenAI delta stream; the id source is separate so tests
   *  can hand in deterministic ids without shifting the protocol index. */
  let toolCallIndex = 0
  const nextToolCallId = options.nextToolCallId ?? (() => `call_native_${++counter}`)
  let sawToolCall = false
  let sentRole = false
  let done = false

  const rewriter = (line: string): string | string[] => {
    if (!line.startsWith('data: ')) return line
    const raw = line.slice(6).trim()
    if (!raw) return line
    if (raw === '[DONE]') {
      done = true
      return line
    }
    let event: any
    try {
      event = JSON.parse(raw)
    } catch {
      return line
    }
    if (event?.error) {
      // Google reports a mid-stream failure as an event, not a status code.
      return line
    }
    const out: string[] = []
    const candidate = Array.isArray(event?.candidates) ? event.candidates[0] : undefined
    const parts: NativePart[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []

    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.length > 0) {
        if (part.thought === true) {
          out.push(chunkLine(options.model, {
            ...(sentRole ? {} : { role: 'assistant' }),
            reasoning_content: part.text,
          }))
        } else {
          out.push(chunkLine(options.model, {
            ...(sentRole ? {} : { role: 'assistant' }),
            content: part.text,
          }))
        }
        sentRole = true
        continue
      }
      if (part?.functionCall?.name) {
        sawToolCall = true
        const id = nextToolCallId()
        const delta: Record<string, unknown> = {
          ...(sentRole ? {} : { role: 'assistant' }),
          tool_calls: [{
            index: toolCallIndex++,
            id,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          }],
        }
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
          delta.reasoning_details = [{ type: 'reasoning.encrypted', id, data: part.thoughtSignature }]
        }
        out.push(chunkLine(options.model, delta))
        sentRole = true
      }
    }

    if (candidate?.finishReason) {
      const finishReason = geminiNativeFinishReason(candidate.finishReason, sawToolCall)
      out.push(chunkLine(options.model, {}, finishReason))
    }

    if (event?.usageMetadata) {
      out.push(`data: ${JSON.stringify({
        id: 'gemini-native',
        object: 'chat.completion.chunk',
        created: 0,
        model: options.model,
        choices: [],
        usage: geminiNativeUsage(event.usageMetadata),
      })}`)
    }

    return out.length > 0 ? out : line
  }

  rewriter.flush = () => (done ? [] : ['data: [DONE]'])
  return rewriter
}

/**
 * Native `generateContent` response → the `chat.completion` object
 * `liftGoogleThoughtSignatures` + `splitGoogleThoughtMessage` produce today.
 */
export function convertGeminiNativeResponse(payload: any, model: string): Record<string, unknown> {
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : undefined
  const parts: NativePart[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  let content = ''
  let reasoning = ''
  const toolCalls: Array<Record<string, unknown>> = []
  const reasoningDetails: Array<Record<string, unknown>> = []
  let counter = 0

  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.length > 0) {
      if (part.thought === true) reasoning += part.text
      else content += part.text
      continue
    }
    if (!part?.functionCall?.name) continue
    const id = `call_native_${++counter}`
    toolCalls.push({
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      },
    })
    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
      reasoningDetails.push({ type: 'reasoning.encrypted', id, data: part.thoughtSignature })
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content: content || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  if (reasoningDetails.length > 0) message.reasoning_details = reasoningDetails

  const result: Record<string, unknown> = {
    id: 'gemini-native',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: geminiNativeFinishReason(candidate?.finishReason, toolCalls.length > 0),
    }],
  }
  const usage = geminiNativeUsage(payload?.usageMetadata)
  if (usage) result.usage = usage
  return result
}

/** Native base URL: `GOOGLE_BASE_URL` with the compat `/openai` suffix removed. */
export function getGeminiNativeBaseUrl(): string {
  const base = (process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '')
  return base.endsWith('/openai') ? base.slice(0, -'/openai'.length) : base
}

/** Native endpoint for a model, streaming or not. */
export function geminiNativeEndpoint(apiModel: string, stream: boolean): string {
  const base = getGeminiNativeBaseUrl()
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  return `${base}/models/${apiModel}:${method}`
}

/**
 * The frame rate a video block will actually be sampled at, for logging and
 * for the error the caller sees when a 400 comes back. `undefined` means "no
 * setting was asked for", i.e. Google's own default.
 */
export function videoFpsOnRequest(messages: NativeChatMessage[]): number | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const url = block?.type === 'image_url' ? block.image_url?.url : block?.type === 'video_url' ? block.video_url?.url : undefined
      if (typeof url !== 'string' || !url.startsWith('data:video/')) continue
      const fps = clampVideoFps(parseVideoMimeType(url.slice('data:'.length, url.indexOf(','))).fps)
      if (fps !== undefined) return fps
    }
  }
  return undefined
}
