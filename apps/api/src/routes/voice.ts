// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice / Shogo Mode Routes
 *
 * Endpoints that back the "Shogo Mode" overlay (voice + text
 * translator). Mounted under `/api`:
 *
 *   - GET  /api/voice/signed-url
 *       → short-lived ElevenLabs signed URL for the browser convai
 *         session (voice modality).
 *
 *   - POST /api/voice/translator/chat/:chatSessionId
 *       → streaming AI SDK chat route that serves the same translator
 *         persona for the text modality AND persists every user /
 *         assistant UIMessage as a `ChatMessage` row tagged
 *         `agent="voice"`. Rows are keyed by `UIMessage.id` so retries
 *         / resumes upsert cleanly.
 *
 *   - POST /api/voice/transcript/:chatSessionId
 *       → records a single voice-mode transcript entry (user speech,
 *         agent speech, or agent-activity narration) as a `ChatMessage`
 *         row with `agent="voice"`. Called by the client whenever the
 *         voice SDK / ChatBridge surfaces an event.
 *
 * All endpoints require an authenticated user. Session-scoped endpoints
 * additionally verify that the user is a member of the workspace that
 * owns the `ChatSession`. `ELEVENLABS_API_KEY` never leaves the server;
 * the browser only ever sees a short-lived signed URL.
 *
 * Persistence rationale
 * ---------------------
 * Shogo Mode's thread is stored in the same `chat_messages` table as
 * the technical agent's thread, discriminated by a `agent` column
 * (`"technical"` | `"voice"`). The two threads share one `ChatSession`
 * per chat tab but never leak into each other's reads:
 *
 *   - Tech-thread callers filter `agent: 'technical'`.
 *   - Shogo Mode filters `agent: 'voice'`.
 *
 * The `parts` column on voice rows carries a tiny JSON envelope that
 * discriminates sub-kinds and preserves AI-SDK UIMessage parts for text
 * messages:
 *
 *   { kind: 'shogo-text',      uiParts: [...] }   // AI-SDK text turn
 *   { kind: 'voice' }                              // spoken turn (user/agent)
 *   { kind: 'agent-activity' }                     // narration mirror
 *
 * The client is read-only on `chat_messages` — it hydrates via the
 * generated `/api/chat-messages` route (filtered to
 * `agent=voice&sessionId=...`) and relies on these endpoints for all
 * writes.
 */

import { Hono } from 'hono'
import { streamText, convertToModelMessages, type UIMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { ElevenLabsClient } from '@shogo-ai/sdk/voice'
import {
  TRANSLATOR_SYSTEM_PROMPT,
  TRANSLATOR_AI_SDK_TOOLS,
} from '@shogo/agent-runtime/src/voice-mode/translator-persona'
import { prisma } from '../lib/prisma'

const TRANSLATOR_MODEL_ID =
  process.env.SHOGO_VOICE_TRANSLATOR_MODEL || 'claude-haiku-4-5'

/**
 * Resolve the translator LLM. Mirrors the two-tier pattern used by the
 * AI-chat example and the rest of the API server:
 *   1. Shogo AI Proxy (AI_PROXY_URL + AI_PROXY_TOKEN) — preferred.
 *   2. Direct ANTHROPIC_API_KEY — fallback for local dev.
 */
function resolveTranslatorModel() {
  const proxyUrl = process.env.AI_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  if (proxyUrl && proxyToken) {
    const anthropicProxyUrl = proxyUrl.replace('/ai/v1', '/ai/anthropic/v1')
    const anthropic = createAnthropic({
      baseURL: anthropicProxyUrl,
      apiKey: proxyToken,
    })
    return anthropic(TRANSLATOR_MODEL_ID)
  }

  const directKey = process.env.ANTHROPIC_API_KEY
  if (directKey) {
    const anthropic = createAnthropic({ apiKey: directKey })
    return anthropic(TRANSLATOR_MODEL_ID)
  }

  return null
}

function resolveElevenLabsClient(): { client: ElevenLabsClient; agentId: string } | { error: string } {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return {
      error:
        'ELEVENLABS_API_KEY is not configured. Voice mode is unavailable until the server sets this env var.',
    }
  }
  const agentId = process.env.ELEVENLABS_VOICE_MODE_AGENT_ID
  if (!agentId) {
    return {
      error:
        'ELEVENLABS_VOICE_MODE_AGENT_ID is not configured. Run the create-voice-mode-agent script and set this env var.',
    }
  }
  return { client: new ElevenLabsClient({ apiKey }), agentId }
}

// ---------------------------------------------------------------------
// Shogo persistence helpers
// ---------------------------------------------------------------------

type ShogoPartsEnvelope =
  | { kind: 'shogo-text'; uiParts: unknown[] }
  | { kind: 'voice' }
  | { kind: 'agent-activity' }

type AuthzResult =
  | { ok: true }
  | { ok: false; status: 404 | 403; message: string }

/**
 * Verify the authenticated user has access to the chat session via
 * workspace membership on the owning project. Returns `{ok:true}` or
 * an error response payload.
 */
async function authorizeChatSession(
  chatSessionId: string,
  userId: string,
): Promise<AuthzResult> {
  const session = await prisma.chatSession.findUnique({
    where: { id: chatSessionId },
    select: {
      id: true,
      project: { select: { id: true, workspaceId: true } },
    },
  })
  if (!session) {
    return { ok: false, status: 404, message: 'Chat session not found' }
  }
  const workspaceId = session.project?.workspaceId
  if (!workspaceId) {
    return {
      ok: false,
      status: 403,
      message: 'Chat session is not accessible to this user',
    }
  }
  const member = await prisma.member.findFirst({
    where: { userId, workspaceId },
    select: { id: true },
  })
  if (!member) {
    return {
      ok: false,
      status: 403,
      message: 'Chat session is not accessible to this user',
    }
  }
  return { ok: true }
}

/** Extract the plain-text content of a UIMessage by concatenating its `text` parts. */
function uiMessageText(m: UIMessage): string {
  const parts = (m as any).parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p: any) => p && p.type === 'text')
    .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
}

/**
 * Upsert a Shogo text (AI-SDK) turn as a `ChatMessage` row. Keyed by
 * `UIMessage.id` so a retry of the same stream is idempotent.
 */
async function upsertShogoTextMessage(params: {
  chatSessionId: string
  uiMessage: UIMessage
}): Promise<void> {
  const { chatSessionId, uiMessage } = params
  const content = uiMessageText(uiMessage)
  const envelope: ShogoPartsEnvelope = {
    kind: 'shogo-text',
    uiParts: (uiMessage as any).parts ?? [],
  }
  const partsJson = JSON.stringify(envelope)
  const role = (uiMessage.role === 'assistant' ? 'assistant' : 'user') as
    | 'assistant'
    | 'user'
  const id =
    typeof uiMessage.id === 'string' && uiMessage.id
      ? uiMessage.id
      : undefined

  try {
    if (id) {
      await prisma.chatMessage.upsert({
        where: { id },
        create: {
          id,
          sessionId: chatSessionId,
          role,
          content,
          parts: partsJson,
          agent: 'voice',
        },
        update: {
          content,
          parts: partsJson,
        },
      })
    } else {
      await prisma.chatMessage.create({
        data: {
          sessionId: chatSessionId,
          role,
          content,
          parts: partsJson,
          agent: 'voice',
        },
      })
    }
  } catch (err: any) {
    console.error(
      '[Voice] failed to persist Shogo text message:',
      err?.message || err,
    )
  }
}

export function voiceRoutes() {
  const router = new Hono()

  /**
   * GET /voice/signed-url — mint a short-lived ElevenLabs signed URL for
   * the shared Shogo Mode convai agent. The browser uses this URL to
   * start a convai WebSocket session; it expires in ~15 minutes.
   */
  router.get('/voice/signed-url', async (c) => {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated || !auth.userId) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const resolved = resolveElevenLabsClient()
    if ('error' in resolved) {
      return c.json({ error: resolved.error }, 503)
    }

    try {
      const signedUrl = await resolved.client.getSignedUrl(resolved.agentId)
      return c.json({ signedUrl })
    } catch (err: any) {
      console.error('[Voice] getSignedUrl failed:', err?.message || err)
      return c.json(
        { error: 'Failed to mint signed URL', detail: err?.message ?? String(err) },
        502,
      )
    }
  })

  /**
   * POST /voice/translator/chat/:chatSessionId
   *
   * Streaming translator endpoint. In addition to forwarding the AI SDK
   * UI message stream back to the browser, the server persists:
   *
   *   1. The latest user UIMessage from the incoming `messages` array
   *      (upsert by id — if it already exists from a prior retry, we
   *      only refresh content/parts).
   *   2. The final assistant UIMessage (via `toUIMessageStreamResponse`'s
   *      `onFinish` hook).
   *
   * Both are written with `agent: 'voice'` and a `parts` envelope of
   * `{ kind: 'shogo-text', uiParts: [...] }` so the Shogo overlay can
   * rehydrate its AI-SDK thread on reload.
   *
   * Request body: `{ messages: UIMessage[] }` (AI SDK v6 format).
   * Response: UI message stream.
   *
   * The two tools (`send_to_chat`, `set_mode`) are declared WITHOUT an
   * `execute` function — they are executed client-side by the overlay,
   * which supplies results via `useChat().addToolOutput` before the
   * translator's next turn.
   */
  router.post('/voice/translator/chat/:chatSessionId', async (c) => {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated || !auth.userId) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const chatSessionId = c.req.param('chatSessionId')
    if (!chatSessionId) {
      return c.json({ error: 'chatSessionId is required' }, 400)
    }

    const model = resolveTranslatorModel()
    if (!model) {
      return c.json(
        {
          error:
            'Translator model is not configured. Set AI_PROXY_URL + AI_PROXY_TOKEN or ANTHROPIC_API_KEY.',
        },
        503,
      )
    }

    let body: { messages?: UIMessage[] }
    try {
      body = (await c.req.json()) as { messages?: UIMessage[] }
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const uiMessages = Array.isArray(body.messages) ? body.messages : []
    if (uiMessages.length === 0) {
      return c.json({ error: 'messages is required' }, 400)
    }

    try {
      const authz = await authorizeChatSession(chatSessionId, auth.userId)
      if (!authz.ok) {
        return c.json({ error: authz.message }, authz.status)
      }

      // Persist the latest user turn up-front. We persist ALL trailing
      // user messages (walking back from the end until we hit an
      // assistant/tool turn) so that a chain of quick user messages
      // which didn't yet have an assistant reply all land in storage.
      // Each is keyed by UIMessage.id so re-sends upsert.
      for (let i = uiMessages.length - 1; i >= 0; i--) {
        const m = uiMessages[i]
        if (m.role !== 'user') break
        await upsertShogoTextMessage({ chatSessionId, uiMessage: m })
      }

      const modelMessages = await convertToModelMessages(uiMessages)
      const result = streamText({
        model,
        system: TRANSLATOR_SYSTEM_PROMPT,
        messages: modelMessages,
        tools: TRANSLATOR_AI_SDK_TOOLS,
      })

      return result.toUIMessageStreamResponse({
        onFinish: async ({ messages }: { messages: UIMessage[] }) => {
          // `messages` is the full resulting thread (input + newly
          // generated assistant message). Persist any assistant/tool
          // messages that weren't in the input. Keyed by id so a
          // resumed stream upserts instead of duplicating.
          const inputIds = new Set(
            uiMessages
              .map((m) => m.id)
              .filter((id): id is string => typeof id === 'string' && !!id),
          )
          for (const m of messages) {
            if (m.role === 'user') continue
            if (typeof m.id === 'string' && inputIds.has(m.id)) continue
            await upsertShogoTextMessage({
              chatSessionId,
              uiMessage: m,
            })
          }
        },
      })
    } catch (err: any) {
      console.error('[Voice] translator/chat failed:', err?.message || err)
      return c.json(
        {
          error: 'Translator chat failed',
          detail: err?.message ?? String(err),
        },
        500,
      )
    }
  })

  /**
   * POST /voice/transcript/:chatSessionId
   *
   * Record a single voice-modality transcript entry as a ChatMessage
   * row. Used by the Shogo overlay to persist:
   *
   *   - `"voice-user"`    — the human spoke (role=user).
   *   - `"voice-agent"`   — Shogo spoke back (role=assistant).
   *   - `"agent-activity"` — a narration mirror of technical-agent
   *                          activity the overlay surfaced to the user
   *                          mid-turn (role=assistant).
   *
   * Body: `{ kind, text, id?, ts? }`. `id` is optional but strongly
   * recommended — if present, the row is upserted by id so clients can
   * safely retry. `ts` (epoch ms) overrides the server clock for
   * `createdAt`, keeping the display order aligned with what the user
   * heard.
   */
  router.post('/voice/transcript/:chatSessionId', async (c) => {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated || !auth.userId) {
      return c.json({ error: 'Authentication required' }, 401)
    }
    const chatSessionId = c.req.param('chatSessionId')
    if (!chatSessionId) {
      return c.json({ error: 'chatSessionId is required' }, 400)
    }

    // Accept both `application/json` (happy path) and `text/plain` with
    // a JSON payload. The latter is what `navigator.sendBeacon` emits
    // in browsers that strip Blob content-types (Safari in particular),
    // so tolerating it makes the pagehide flush from the client land
    // cleanly instead of 400ing and getting dropped on the floor.
    //
    // We read the raw text once (body streams can only be consumed
    // once) and then try to JSON-parse it. This works regardless of
    // the declared content-type.
    let body: {
      kind?: string
      text?: string
      id?: string
      ts?: number
    }
    try {
      const raw = await c.req.text()
      if (!raw) {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }
      body = JSON.parse(raw) as typeof body
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const kind = body.kind
    if (
      kind !== 'voice-user' &&
      kind !== 'voice-agent' &&
      kind !== 'agent-activity'
    ) {
      return c.json(
        {
          error:
            "kind must be one of 'voice-user' | 'voice-agent' | 'agent-activity'",
        },
        400,
      )
    }
    if (typeof body.text !== 'string') {
      return c.json({ error: 'text must be a string' }, 400)
    }
    const MAX_TEXT_BYTES = 64_000
    if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) {
      return c.json(
        { error: `text exceeds ${MAX_TEXT_BYTES}-byte limit` },
        413,
      )
    }

    const role = kind === 'voice-user' ? 'user' : 'assistant'
    const envelopeKind: ShogoPartsEnvelope['kind'] =
      kind === 'agent-activity' ? 'agent-activity' : 'voice'
    const partsJson = JSON.stringify({ kind: envelopeKind })
    const id =
      typeof body.id === 'string' && body.id ? body.id : undefined
    const createdAt =
      typeof body.ts === 'number' && Number.isFinite(body.ts)
        ? new Date(body.ts)
        : undefined

    try {
      const authz = await authorizeChatSession(chatSessionId, auth.userId)
      if (!authz.ok) {
        return c.json({ error: authz.message }, authz.status)
      }

      const row = id
        ? await prisma.chatMessage.upsert({
            where: { id },
            create: {
              id,
              sessionId: chatSessionId,
              role,
              content: body.text,
              parts: partsJson,
              agent: 'voice',
              ...(createdAt ? { createdAt } : {}),
            },
            update: {
              content: body.text,
              parts: partsJson,
            },
          })
        : await prisma.chatMessage.create({
            data: {
              sessionId: chatSessionId,
              role,
              content: body.text,
              parts: partsJson,
              agent: 'voice',
              ...(createdAt ? { createdAt } : {}),
            },
          })

      return c.json({ ok: true, data: row }, 201)
    } catch (err: any) {
      console.error('[Voice] transcript persist failed:', err?.message || err)
      return c.json(
        {
          error: 'Failed to persist transcript entry',
          detail: err?.message ?? String(err),
        },
        500,
      )
    }
  })

  return router
}
