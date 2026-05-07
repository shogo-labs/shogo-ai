// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Public streaming text-chat route — `POST /api/chat/turn`.
 *
 * The text-only sibling of `POST /api/voice/signed-url`. Where the
 * voice route mints a short-lived ElevenLabs Convai signed URL and
 * lets the browser stream audio frames over a websocket, this route
 * runs the same project's persona (system prompt + memory context)
 * against the AI proxy / Anthropic over a plain HTTPS POST, and
 * streams the response back as an AI-SDK UI message stream.
 *
 * Why a separate file (not folded into `voice.ts`):
 *
 *   - URL hygiene. SDK consumers shouldn't have to write `/voice/...`
 *     to drive the text path.
 *   - Auth surface. This route is the FIRST public, non-overlay-only
 *     dual-mode auth surface for an SDK consumer (bearer + project).
 *     The existing `voice/translator/chat/:chatSessionId` endpoint
 *     is product-coupled to Shogo Mode (chatSession scope, translator
 *     persona, `send_to_chat` tool). External callers wouldn't have
 *     a `chatSessionId`, and they don't want the translator persona.
 *
 * Persistence: STATELESS in V1. The client owns the thread state
 * (every request re-sends the full `messages` array). External
 * callers wanting durable memory should use the existing
 * `/api/memory/{add,retrieve,ingest}` endpoints — which are the
 * SAME endpoints the SDK voice hook uses, so memory is shared
 * across modalities for free.
 *
 * Auth modes (inherited from `apiKeyOrSession`):
 *
 *   - `Authorization: Bearer shogo_sk_*` (`via: 'apiKey'`)
 *   - Better Auth session cookie         (`via: 'session'`)
 *   - `x-tunnel-auth-user-id`            (`via: 'tunnel'`)
 *
 * Runtime-token callers are explicitly rejected (403). Runtime
 * tokens are project-scoped capabilities for pod → API; the chat
 * route is a per-end-user surface and the persona prompt may
 * embed end-user context.
 *
 * Tools: V1 ships with no built-in tools. Consumers register their
 * own client-resident tools via the `tools` field in the request
 * body — JSON Schema descriptors that the route re-declares to the
 * model on every turn (no `execute`, so each tool call streams to
 * the client and is resolved there). The SDK side handles the
 * `addToolOutput` round-trip; see `useChatConversation` in
 * `packages/sdk/src/voice/{react,native}/`.
 */

import { Hono } from 'hono'
import { streamText, convertToModelMessages, jsonSchema, tool, type UIMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { apiKeyOrSession, authorizeProject } from '../middleware/auth'
import { resolveVoiceContext } from '../lib/voice-context'

/**
 * Default persona used by the chat route when the project has not
 * configured one of its own. Mirrors the voice agent's
 * `DEFAULT_PROJECT_AGENT_SYSTEM_PROMPT` in tone but drops the
 * "voice output is slow" guidance — text bubbles can carry longer
 * answers and lists.
 *
 * Per-project override: a future `VoiceProjectConfig.systemPrompt`
 * column would slot in here without changing the wire shape. For now
 * the schema has no such field, so we always use this default.
 */
const DEFAULT_CHAT_SYSTEM_PROMPT = `You are the Shogo assistant for this project. You help the user by answering questions about the project, brainstorming, and acting on requests via tool calls when appropriate. Be conversational, warm, and concrete. Use plain language; never recite tool names, file paths, or implementation details unless the user asks for them.

{{PROJECT_CONTEXT}}`

/**
 * Marker the route replaces with the per-session project + memory
 * context block. Same shape as the voice persona's
 * `TRANSLATOR_CONTEXT_MARKER` so the two surfaces stay symmetric.
 */
const CHAT_CONTEXT_MARKER = '{{PROJECT_CONTEXT}}'

const CHAT_MODEL_ID = process.env.SHOGO_CHAT_MODEL || 'claude-haiku-4-5'

/**
 * Resolve the chat LLM. Mirrors `resolveTranslatorModel` in voice.ts:
 *   1. Shogo AI proxy (`AI_PROXY_URL` + `AI_PROXY_TOKEN`) — preferred.
 *   2. Direct `ANTHROPIC_API_KEY` — fallback for local dev.
 */
function resolveChatModel() {
  const proxyUrl = process.env.AI_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN
  if (proxyUrl && proxyToken) {
    const anthropicProxyUrl = proxyUrl.replace('/ai/v1', '/ai/anthropic/v1')
    const anthropic = createAnthropic({
      baseURL: anthropicProxyUrl,
      apiKey: proxyToken,
    })
    return anthropic(CHAT_MODEL_ID)
  }
  const directKey = process.env.ANTHROPIC_API_KEY
  if (directKey) {
    const anthropic = createAnthropic({ apiKey: directKey })
    return anthropic(CHAT_MODEL_ID)
  }
  return null
}

/** Substitute the project-context block into the persona prompt. */
function composeChatSystemPrompt(
  basePrompt: string,
  contextBlock: string | null | undefined,
): string {
  const trimmed = (contextBlock ?? '').trim()
  if (basePrompt.includes(CHAT_CONTEXT_MARKER)) {
    return basePrompt.replace(CHAT_CONTEXT_MARKER, trimmed)
  }
  return trimmed.length > 0 ? `${basePrompt}\n\n${trimmed}` : basePrompt
}

/**
 * Schema for tool descriptors supplied by the caller in the request
 * body. Kept deliberately permissive on `inputSchema` — we forward it
 * straight to `ai.jsonSchema(...)` so the model receives whatever
 * shape the consumer supplied, with the caveat that the descriptor
 * must be a serializable JSON Schema object. Pathological shapes
 * surface as a 400 here, NOT a model error mid-stream.
 */
const ChatToolDescriptorSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'tool name must be a valid identifier'),
  description: z.string().min(1).max(2_000),
  inputSchema: z.record(z.string(), z.unknown()),
})

const ChatTurnBodySchema = z.object({
  messages: z.array(z.unknown()).min(1, 'messages is required'),
  projectId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  tools: z.array(ChatToolDescriptorSchema).max(32).optional(),
})

export function chatRoutes() {
  const router = new Hono()

  // Dual-mode auth on every chat/* route — bearer or session.
  router.use('/chat/*', apiKeyOrSession)

  /**
   * POST /api/chat/turn
   *
   * Streaming UI message endpoint. Body shape follows the AI SDK v6
   * convention (`{ messages: UIMessage[] }`) plus three Shogo-specific
   * fields: `projectId` (required for personalised replies),
   * `conversationId` (optional, used only for log correlation in V1),
   * and `tools` (optional, JSON Schema descriptors).
   *
   * Response: an AI-SDK UI message stream
   * (`result.toUIMessageStreamResponse()`).
   *
   * Failure modes:
   *   - 401  unauthenticated
   *   - 403  runtime-token caller (project-scoped, not user-scoped)
   *   - 400  malformed body / missing projectId / bad tool schema
   *   - 403  caller is not a member of the project's workspace
   *   - 503  no chat model configured (no AI proxy + no Anthropic key)
   *   - 500  upstream model failure
   */
  router.post('/chat/turn', async (c) => {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated || !auth.userId) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        401,
      )
    }

    // Runtime-token callers refused. Mirrors the rejection in the
    // existing translator route — `via`-based check is the canonical
    // pattern (see runtime-token.md §7); userId-shape checks would
    // silently miss because runtime callers carry a real owner userId.
    if (auth.via === 'runtimeToken') {
      return c.json(
        {
          error: {
            code: 'forbidden',
            message:
              'Chat route requires a user session or API key; runtime tokens are project-scoped',
          },
        },
        403,
      )
    }

    let parsedBody: z.infer<typeof ChatTurnBodySchema>
    try {
      const raw = await c.req.json()
      const result = ChatTurnBodySchema.safeParse(raw)
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'bad_request',
              message: 'Invalid request body',
              issues: result.error.issues,
            },
          },
          400,
        )
      }
      parsedBody = result.data
    } catch {
      return c.json(
        { error: { code: 'bad_request', message: 'Invalid JSON body' } },
        400,
      )
    }

    const { messages: rawMessages, projectId, conversationId, tools: toolDescriptors } =
      parsedBody

    if (!projectId) {
      return c.json(
        {
          error: {
            code: 'bad_request',
            message:
              'projectId is required so the persona prompt can be resolved',
          },
        },
        400,
      )
    }

    // Project authorization. `authorizeProject` handles all four
    // auth-via paths (apiKey/session/runtimeToken/tunnel) — we
    // already filtered out runtime-token above, so the remaining
    // paths just verify workspace membership.
    const authz = await authorizeProject(c, projectId)
    if (!authz.ok) {
      return c.json(
        { error: { code: authz.code, message: authz.message } },
        authz.status,
      )
    }

    const model = resolveChatModel()
    if (!model) {
      return c.json(
        {
          error: {
            code: 'service_unavailable',
            message:
              'Chat model is not configured. Set AI_PROXY_URL + AI_PROXY_TOKEN or ANTHROPIC_API_KEY.',
          },
        },
        503,
      )
    }

    // Compose the system prompt. `resolveVoiceContext` is wrapped in
    // try/catch so a slow / cold-starting pod never blocks the chat
    // reply — degraded path uses just the default persona.
    let systemPrompt = composeChatSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT, '')
    try {
      const contextBlock = await resolveVoiceContext({
        projectId,
        signal: c.req.raw.signal,
      })
      systemPrompt = composeChatSystemPrompt(
        DEFAULT_CHAT_SYSTEM_PROMPT,
        contextBlock,
      )
    } catch (err: any) {
      console.warn(
        '[Chat] resolveVoiceContext failed; falling back to bare persona:',
        err?.message || err,
      )
    }

    // Build the AI-SDK tools map from caller-supplied descriptors.
    // Each tool is declared WITHOUT an `execute` function so the
    // model produces a `tool-call` event that the client resolves
    // and routes back via `addToolOutput`.
    const toolsMap: Record<string, ReturnType<typeof tool>> = {}
    if (toolDescriptors && toolDescriptors.length > 0) {
      for (const t of toolDescriptors) {
        toolsMap[t.name] = tool({
          description: t.description,
          inputSchema: jsonSchema(t.inputSchema as never),
        })
      }
    }

    let modelMessages
    try {
      modelMessages = await convertToModelMessages(rawMessages as UIMessage[])
    } catch (err: any) {
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: 'messages array could not be converted',
            detail: err?.message ?? String(err),
          },
        },
        400,
      )
    }

    try {
      const result = streamText({
        model,
        system: systemPrompt,
        messages: modelMessages,
        tools: Object.keys(toolsMap).length > 0 ? toolsMap : undefined,
      })
      // Echo conversationId through response headers so SDK consumers
      // can confirm the server saw the same id without parsing the
      // stream. Cheap diagnostic; does not change wire semantics.
      const headers: Record<string, string> = {}
      if (conversationId) headers['x-shogo-conversation-id'] = conversationId
      headers['x-shogo-project-id'] = projectId
      return result.toUIMessageStreamResponse({ headers })
    } catch (err: any) {
      console.error('[Chat] /chat/turn streamText failed:', err?.message || err)
      return c.json(
        {
          error: {
            code: 'internal',
            message: 'Chat turn failed',
            detail: err?.message ?? String(err),
          },
        },
        500,
      )
    }
  })

  return router
}
