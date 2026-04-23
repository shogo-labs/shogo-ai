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
import { apiKeyOrSession, authorizeProject } from '../middleware/auth'
import { resolveShogoTwilioClient, verifyTwilioSignature } from '../lib/twilio'
import {
  getCreditBalance,
  resolvePlanIdForWorkspace,
  resolveVoiceRate,
} from '../lib/voice-cost'
import { consumeCredits } from '../services/billing.service'
import {
  recordCallUsage,
  verifyElevenLabsSignature,
} from '../lib/voice-meter'
import type { Context as HonoContext } from 'hono'

/**
 * Normalize a Date to the first UTC instant of its month — the
 * watermark written to `VoiceProjectConfig.monthlyRateDebitedFor` so
 * the monthly rebiller can tell whether the current period is already
 * paid for.
 */
function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

/**
 * Resolve an auth context member id for metering. We use the user id
 * as the member id for API-key callers (their member row may not
 * match 1:1 with the workspace the key is scoped to, so user id is
 * the most stable key). For session callers we also use user id for
 * consistency. `consumeCredits` doesn't care about the shape of this
 * string beyond it being stable.
 */
function auditMemberId(c: HonoContext): string {
  const auth = c.get('auth')
  return auth?.userId ?? 'voice-system'
}

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

/**
 * Resolve Shogo's pooled ElevenLabs client for Mode B agent + phone
 * operations. Unlike `resolveElevenLabsClient` this does NOT require a
 * shared-agent id — per-project agents are lazily provisioned.
 *
 * Exported so Phase 3/4/5 handlers (provision-number, outbound,
 * webhooks) can reuse the same construction.
 */
export function resolveShogoElevenLabsClient():
  | { client: ElevenLabsClient }
  | { error: string } {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return {
      error:
        'ELEVENLABS_API_KEY is not configured. Voice mode is unavailable until the server sets this env var.',
    }
  }
  return { client: new ElevenLabsClient({ apiKey }) }
}

// Voice id used by the auto-provisioned per-project agent. Matches the
// existing shared translator agent's default. Can be made per-project
// configurable via VoiceProjectConfig.settings in a future iteration.
const DEFAULT_PROJECT_AGENT_VOICE_ID =
  process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'

// ElevenLabs rejects `eleven_turbo_v2_5` (SDK fallback) for English-only
// convai agents on most plans with "English Agents must use turbo or
// flash v2". `eleven_turbo_v2` is accepted everywhere. Override via
// `ELEVENLABS_DEFAULT_TTS_MODEL` if your plan supports a different one.
const DEFAULT_PROJECT_AGENT_TTS_MODEL =
  process.env.ELEVENLABS_DEFAULT_TTS_MODEL || 'eleven_turbo_v2'

const DEFAULT_PROJECT_AGENT_SYSTEM_PROMPT = `You are the Shogo Voice assistant for this project. You help the user by speaking conversationally, answering questions about the project, and relaying requests to the technical agent via tool calls. Be concise — voice output is slow, so prefer short sentences and avoid reading long lists aloud.`

const DEFAULT_PROJECT_AGENT_FIRST_MESSAGE =
  "Hey, I'm your project voice agent. How can I help?"

/**
 * Lazily provision (or return) the ElevenLabs agent bound to `projectId`.
 * Writes the resulting agent id to `VoiceProjectConfig.elevenlabsAgentId`
 * so subsequent calls reuse the same agent without hitting EL's
 * agent-create endpoint.
 *
 * Safe under races: a second caller that lands between the first
 * caller's `findUnique` and `upsert` will simply overwrite the agent
 * id with its own newly-created agent id, leaking at most one EL agent
 * per collision (acceptable trade-off — agents are cheap to create).
 */
export async function ensureProjectElevenLabsAgent(params: {
  projectId: string
  workspaceId: string
  client: ElevenLabsClient
}): Promise<string> {
  const existing = await prisma.voiceProjectConfig.findUnique({
    where: { projectId: params.projectId },
    select: { elevenlabsAgentId: true },
  })
  if (existing?.elevenlabsAgentId) return existing.elevenlabsAgentId

  const agentId = await params.client.createAgent({
    displayName: `shogo-project-${params.projectId.slice(0, 8)}`,
    characterName: 'Shogo',
    voiceId: DEFAULT_PROJECT_AGENT_VOICE_ID,
    ttsModelId: DEFAULT_PROJECT_AGENT_TTS_MODEL,
    systemPrompt: DEFAULT_PROJECT_AGENT_SYSTEM_PROMPT,
    firstMessage: DEFAULT_PROJECT_AGENT_FIRST_MESSAGE,
    memoryBlock: null,
    language: 'en',
  })

  await prisma.voiceProjectConfig.upsert({
    where: { projectId: params.projectId },
    create: {
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      elevenlabsAgentId: agentId,
    },
    update: { elevenlabsAgentId: agentId },
  })

  return agentId
}

/**
 * Handler for `GET /api/voice/signed-url?projectId=...`.
 *
 * Lazily provisions a per-project EL agent (Mode B) if one doesn't
 * already exist, then mints a signed URL for that agent using Shogo's
 * pooled EL API key. The browser connects directly to EL via the
 * signed URL — Shogo never proxies convai media.
 */
async function projectSignedUrlHandler(
  c: import('hono').Context,
  params: { projectId: string; workspaceId: string },
) {
  const resolved = resolveShogoElevenLabsClient()
  if ('error' in resolved) {
    return c.json({ error: resolved.error }, 503)
  }

  try {
    const agentId = await ensureProjectElevenLabsAgent({
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      client: resolved.client,
    })
    const signedUrl = await resolved.client.getSignedUrl(agentId)
    return c.json({ signedUrl, agentId })
  } catch (err: any) {
    console.error(
      '[Voice] project signed-url failed:',
      err?.message || err,
    )
    return c.json(
      {
        error: 'Failed to mint signed URL',
        detail: err?.message ?? String(err),
      },
      502,
    )
  }
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

  // Dual-mode auth on every voice/* route — accepts either a Shogo API
  // key (Authorization: Bearer shogo_sk_*) or a Better Auth session
  // cookie. Returns 401 on neither. Webhook routes (EL post-call +
  // Twilio status callback) opt out — they use their provider's
  // signature-based auth and must be reachable from the public
  // internet without a Shogo key.
  router.use('/voice/*', async (c, next) => {
    const url = new URL(c.req.url)
    const path = url.pathname
    // Strip mount prefix ("/api") if present.
    const relative = path.replace(/^\/api/, '')
    if (
      relative === '/voice/elevenlabs/webhook' ||
      relative.startsWith('/voice/twilio/status/')
    ) {
      return next()
    }
    return apiKeyOrSession(c, next)
  })

  /**
   * GET /voice/signed-url — mint a short-lived ElevenLabs signed URL.
   *
   * Optional `?projectId=<uuid>` selects a per-project EL agent
   * (auto-provisioned on first use, see Phase 2). Without `projectId`,
   * falls back to the shared Shogo-Mode translator agent identified by
   * `ELEVENLABS_VOICE_MODE_AGENT_ID` — used by the in-app overlay for
   * backwards compatibility.
   */
  router.get('/voice/signed-url', async (c) => {
    const projectId = c.req.query('projectId')

    if (projectId) {
      const authz = await authorizeProject(c, projectId)
      if (!authz.ok) {
        return c.json(
          { error: { code: authz.code, message: authz.message } },
          authz.status,
        )
      }
      // Phase 2 replaces this stub with lazy agent provisioning.
      return projectSignedUrlHandler(c, {
        projectId: authz.projectId,
        workspaceId: authz.workspaceId,
      })
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

  // -------------------------------------------------------------------
  // Twilio / ElevenLabs telephony (Mode B — Shogo-hosted)
  // -------------------------------------------------------------------

  /**
   * GET /voice/twilio/available-numbers/:projectId
   *
   * Returns a small list of purchasable Twilio numbers so the UI can
   * render a picker. Query params mirror Twilio's
   * AvailablePhoneNumbers/{country}/Local endpoint:
   *   - country (default 'US')
   *   - areaCode
   *   - contains
   *   - limit (default 10, max 30)
   *
   * Auth: standard `authorizeProject` (same as provision-number).
   * No credits are debited — this is a catalog lookup only.
   */
  router.get(
    '/voice/twilio/available-numbers/:projectId',
    async (c) => {
      const projectId = c.req.param('projectId')
      const authz = await authorizeProject(c, projectId)
      if (!authz.ok) {
        return c.json(
          { error: { code: authz.code, message: authz.message } },
          authz.status,
        )
      }

      const twResolved = resolveShogoTwilioClient()
      if ('error' in twResolved) {
        return c.json({ error: twResolved.error }, 503)
      }

      const url = new URL(c.req.url)
      const country = url.searchParams.get('country') ?? undefined
      const areaCode = url.searchParams.get('areaCode') ?? undefined
      const contains = url.searchParams.get('contains') ?? undefined
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw
        ? Math.max(1, Math.min(30, parseInt(limitRaw, 10) || 10))
        : 10

      try {
        const numbers = await twResolved.client.searchAvailable({
          ...(country ? { country } : {}),
          ...(areaCode ? { areaCode } : {}),
          ...(contains ? { contains } : {}),
          limit,
        })
        return c.json({ numbers })
      } catch (err: any) {
        console.error(
          '[Voice] available-numbers: Twilio search failed:',
          err?.message || err,
          err?.body ? `\n  body: ${err.body}` : '',
        )
        return c.json(
          {
            error: 'Twilio number search failed',
            detail: err?.message ?? String(err),
            twilioBody: err?.body ?? undefined,
          },
          502,
        )
      }
    },
  )

  /**
   * POST /voice/twilio/provision-number/:projectId
   *
   * Idempotent. If the project already has a number, returns it.
   * Otherwise:
   *   1. Chooses a number: uses `body.phoneNumber` if provided (from
   *      the picker UI), else searches Twilio for one matching
   *      `{ country?, areaCode? }` and takes the first result.
   *   2. Purchases it under Shogo's Twilio account.
   *   3. Ensures the project has an EL agent (see Phase 2).
   *   4. Registers the Twilio number with the EL agent via EL's
   *      native phone-numbers import + PATCH agent_id endpoints.
   *   5. Debits voice_number_setup + voice_number_monthly credits.
   *   6. Persists Twilio + EL handles in VoiceProjectConfig.
   *
   * Returns 402 if the workspace can't afford setup + first month.
   * On EL link failure after Twilio purchase, the Twilio number is
   * released (compensation) and 502 is returned.
   */
  router.post(
    '/voice/twilio/provision-number/:projectId',
    async (c) => {
      const projectId = c.req.param('projectId')
      const authz = await authorizeProject(c, projectId)
      if (!authz.ok) {
        return c.json(
          { error: { code: authz.code, message: authz.message } },
          authz.status,
        )
      }

      let body: { areaCode?: string; country?: string; phoneNumber?: string } = {}
      try {
        const raw = await c.req.text()
        if (raw) body = JSON.parse(raw)
      } catch {}

      // Fast path: idempotent re-provision.
      const existing = await prisma.voiceProjectConfig.findUnique({
        where: { projectId: authz.projectId },
      })
      if (existing?.twilioPhoneSid && existing.twilioPhoneNumber) {
        return c.json({
          phoneNumber: existing.twilioPhoneNumber,
          twilioPhoneSid: existing.twilioPhoneSid,
          elevenlabsPhoneId: existing.elevenlabsPhoneId,
          purchasedAt: existing.purchasedAt,
          alreadyProvisioned: true,
        })
      }

      const elResolved = resolveShogoElevenLabsClient()
      if ('error' in elResolved) {
        return c.json({ error: elResolved.error }, 503)
      }
      const twResolved = resolveShogoTwilioClient()
      if ('error' in twResolved) {
        return c.json({ error: twResolved.error }, 503)
      }

      // Pre-flight credit check.
      const planId = await resolvePlanIdForWorkspace(authz.workspaceId)
      const setupCost = resolveVoiceRate(planId, 'numberSetup')
      const monthlyCost = resolveVoiceRate(planId, 'numberMonthly')
      const balance = await getCreditBalance(authz.workspaceId)
      if (balance < setupCost + monthlyCost) {
        return c.json(
          {
            error: {
              code: 'insufficient_credits',
              message:
                'Insufficient credits to provision a number. Setup + first month exceeds available balance.',
              required: setupCost + monthlyCost,
              available: balance,
            },
          },
          402,
        )
      }

      // Ensure the project has an EL agent.
      let agentId: string
      try {
        agentId = await ensureProjectElevenLabsAgent({
          projectId: authz.projectId,
          workspaceId: authz.workspaceId,
          client: elResolved.client,
        })
      } catch (err: any) {
        console.error(
          '[Voice] provision-number: agent provisioning failed:',
          err?.message || err,
          err?.body ? `\n  body: ${err.body}` : '',
        )
        return c.json(
          {
            error: 'Failed to provision ElevenLabs agent',
            detail: err?.message ?? String(err),
            elBody: err?.body ?? undefined,
          },
          502,
        )
      }

      // 1. Choose a number. If the client supplied `phoneNumber` (picked
      // from the UI from a pre-fetched list), skip the search step and
      // buy that one directly. Otherwise fall back to searching and
      // picking the first match.
      let chosen: { phoneNumber: string; friendlyName?: string } | null = null
      if (body.phoneNumber) {
        chosen = { phoneNumber: body.phoneNumber }
      } else {
        try {
          const results = await twResolved.client.searchAvailable({
            country: body.country,
            areaCode: body.areaCode,
            limit: 5,
          })
          if (!results.length) {
            return c.json(
              {
                error: {
                  code: 'no_numbers_available',
                  message:
                    body.areaCode
                      ? `No numbers available matching areaCode=${body.areaCode}. Try a different area code.`
                      : 'No numbers available from Twilio right now.',
                },
              },
              409,
            )
          }
          chosen = results[0]
        } catch (err: any) {
          console.error(
            '[Voice] provision-number: Twilio search failed:',
            err?.message || err,
            err?.body ? `\n  body: ${err.body}` : '',
          )
          return c.json(
            {
              error: 'Twilio number search failed',
              detail: err?.message ?? String(err),
              twilioBody: err?.body ?? undefined,
            },
            502,
          )
        }
      }

      // 2. Purchase it.
      let purchased: import('../lib/twilio').IncomingNumberResult
      try {
        purchased = await twResolved.client.purchaseNumber({
          phoneNumber: chosen.phoneNumber,
          friendlyName: `Shogo project ${authz.projectId.slice(0, 8)}`,
          statusCallback: buildPublicApiUrl(
            `/api/voice/twilio/status/${encodeURIComponent(authz.projectId)}`,
          ),
          statusCallbackEvent: ['initiated', 'answered', 'completed'],
        })
      } catch (err: any) {
        console.error(
          '[Voice] provision-number: Twilio purchase failed:',
          err?.message || err,
          err?.body ? `\n  body: ${err.body}` : '',
        )
        return c.json(
          {
            error: 'Twilio number purchase failed',
            detail: err?.message ?? String(err),
            twilioBody: err?.body ?? undefined,
            phoneNumber: chosen.phoneNumber,
          },
          502,
        )
      }

      // 3. Link to EL. On failure, release the Twilio number to
      // avoid stranding a paid number that can't be used.
      let elPhoneId: string
      try {
        const created = await elResolved.client.createPhoneNumberTwilio({
          phoneNumber: purchased.phoneNumber,
          label: `shogo-${authz.projectId.slice(0, 8)}`,
          agentId,
          twilioAccountSid: twResolved.accountSid,
          twilioAuthToken: process.env.TWILIO_AUTH_TOKEN!,
        })
        elPhoneId = created.phoneNumberId
      } catch (err: any) {
        console.error(
          '[Voice] provision-number: EL link failed, releasing Twilio number:',
          err?.message || err,
        )
        try {
          await twResolved.client.releaseNumber(purchased.sid)
        } catch (releaseErr: any) {
          console.error(
            '[Voice] compensating release failed (orphaned Twilio number):',
            releaseErr?.message || releaseErr,
            'sid=',
            purchased.sid,
          )
        }
        return c.json(
          {
            error: 'Failed to link Twilio number to ElevenLabs agent',
            detail: err?.message ?? String(err),
          },
          502,
        )
      }

      // 4 + 5. Debit credits (setup then monthly). We debit BEFORE
      // persisting so that if the debit fails we haven't surfaced the
      // number as owned — the Twilio + EL resources are still live
      // and will be picked up by the manual reconciler.
      const now = new Date()
      const period = startOfMonthUtc(now)
      const memberId = auditMemberId(c)

      const setupDebit = await consumeCredits(
        authz.workspaceId,
        authz.projectId,
        memberId,
        'voice_number_setup',
        setupCost,
        {
          projectId: authz.projectId,
          twilioPhoneSid: purchased.sid,
          twilioPhoneNumber: purchased.phoneNumber,
          elevenlabsPhoneId: elPhoneId,
          elevenlabsAgentId: agentId,
          creditsForPeriod: setupCost,
        },
      )
      if (!setupDebit.success) {
        console.error(
          '[Voice] provision-number: setup debit failed after Twilio purchase:',
          setupDebit.error,
        )
        // Do NOT release — the number is already the customer's; we
        // just failed to bill. Persist anyway so the UI doesn't show
        // a ghost state.
      }

      const monthlyDebit = await consumeCredits(
        authz.workspaceId,
        authz.projectId,
        memberId,
        'voice_number_monthly',
        monthlyCost,
        {
          projectId: authz.projectId,
          twilioPhoneSid: purchased.sid,
          twilioPhoneNumber: purchased.phoneNumber,
          creditsForPeriod: monthlyCost,
          periodStart: period.toISOString(),
        },
      )
      if (!monthlyDebit.success) {
        console.error(
          '[Voice] provision-number: monthly debit failed:',
          monthlyDebit.error,
        )
      }

      // 6. Persist.
      const config = await prisma.voiceProjectConfig.upsert({
        where: { projectId: authz.projectId },
        create: {
          projectId: authz.projectId,
          workspaceId: authz.workspaceId,
          elevenlabsAgentId: agentId,
          twilioPhoneNumber: purchased.phoneNumber,
          twilioPhoneSid: purchased.sid,
          elevenlabsPhoneId: elPhoneId,
          purchasedAt: now,
          monthlyRateDebitedFor: monthlyDebit.success ? period : null,
        },
        update: {
          elevenlabsAgentId: agentId,
          twilioPhoneNumber: purchased.phoneNumber,
          twilioPhoneSid: purchased.sid,
          elevenlabsPhoneId: elPhoneId,
          purchasedAt: now,
          monthlyRateDebitedFor: monthlyDebit.success ? period : null,
        },
      })

      return c.json({
        phoneNumber: config.twilioPhoneNumber,
        twilioPhoneSid: config.twilioPhoneSid,
        elevenlabsPhoneId: config.elevenlabsPhoneId,
        purchasedAt: config.purchasedAt,
        setupCredits: setupCost,
        monthlyCredits: monthlyCost,
        creditsDebited: {
          setup: setupDebit.success,
          monthly: monthlyDebit.success,
        },
      })
    },
  )

  /**
   * POST /voice/twilio/outbound/:projectId
   *
   * Place an outbound PSTN call and bridge it to the project's EL
   * agent. Body: `{ to: string, dynamicVariables?: Record<string,string> }`.
   *
   * Requires:
   *   - `VoiceProjectConfig.elevenlabsPhoneId` (run provisionNumber first).
   *   - Workspace has >= 1 minute of outbound credits.
   *
   * Returns `{ callSid, conversationId, estimatedCredits }` on success.
   * The actual per-minute debit happens asynchronously via the EL
   * post_call webhook (or Twilio status callback) — see Phase 5b.
   */
  router.post('/voice/twilio/outbound/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const authz = await authorizeProject(c, projectId)
    if (!authz.ok) {
      return c.json(
        { error: { code: authz.code, message: authz.message } },
        authz.status,
      )
    }

    let body: { to?: string; dynamicVariables?: Record<string, string> } = {}
    try {
      const raw = await c.req.text()
      if (raw) body = JSON.parse(raw)
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const to = typeof body.to === 'string' ? body.to.trim() : ''
    if (!to || !/^\+?[0-9\-\s().]+$/.test(to) || to.replace(/\D/g, '').length < 7) {
      return c.json(
        {
          error: {
            code: 'invalid_to_number',
            message: '`to` must be a valid E.164 phone number',
          },
        },
        400,
      )
    }

    const config = await prisma.voiceProjectConfig.findUnique({
      where: { projectId: authz.projectId },
    })
    if (!config?.elevenlabsPhoneId || !config.elevenlabsAgentId) {
      return c.json(
        {
          error: {
            code: 'no_number',
            message:
              'Project has no provisioned phone number. Call POST /api/voice/twilio/provision-number first.',
          },
        },
        409,
      )
    }

    const elResolved = resolveShogoElevenLabsClient()
    if ('error' in elResolved) {
      return c.json({ error: elResolved.error }, 503)
    }

    // Pre-flight: require at least one minute of outbound credits.
    const planId = await resolvePlanIdForWorkspace(authz.workspaceId)
    const outboundRate = resolveVoiceRate(planId, 'minutesOutbound')
    const balance = await getCreditBalance(authz.workspaceId)
    if (balance < outboundRate) {
      return c.json(
        {
          error: {
            code: 'insufficient_credits',
            message:
              'Insufficient credits for outbound call. At least one minute of outbound credits is required.',
            required: outboundRate,
            available: balance,
          },
        },
        402,
      )
    }

    try {
      const result = await elResolved.client.outboundCall({
        phoneNumberId: config.elevenlabsPhoneId,
        agentId: config.elevenlabsAgentId,
        toNumber: to,
        ...(body.dynamicVariables
          ? { dynamicVariables: body.dynamicVariables }
          : {}),
      })

      // Pre-seed a VoiceCallMeter row so the webhook later can upsert
      // in by either key. This keeps outbound / inbound accounting
      // symmetric and lets the UI show "call in progress" before the
      // first webhook lands.
      try {
        await prisma.voiceCallMeter.create({
          data: {
            projectId: authz.projectId,
            workspaceId: authz.workspaceId,
            conversationId: result.conversationId,
            callSid: result.callSid,
            direction: 'outbound',
            durationSeconds: 0,
            billedMinutes: 0,
            startedAt: new Date(),
          },
        })
      } catch (err) {
        // non-fatal — the webhook will upsert later.
        console.warn('[Voice] outbound: pre-seed meter failed:', err)
      }

      return c.json({
        callSid: result.callSid,
        conversationId: result.conversationId,
        estimatedCredits: outboundRate,
        creditsPerMinute: outboundRate,
      })
    } catch (err: any) {
      console.error(
        '[Voice] outbound: ElevenLabs outbound-call failed:',
        err?.message || err,
      )
      return c.json(
        {
          error: 'Outbound call failed',
          detail: err?.message ?? String(err),
        },
        502,
      )
    }
  })

  /**
   * GET /voice/usage/:projectId?from=&to=
   *
   * Aggregated voice usage for a project. Reads `UsageEvent` filtered
   * to voice_* action types and returns totals by direction plus a
   * per-day breakdown. Used by the SDK `client.voice.telephony.getUsage`
   * helper and the Project Settings > Phone tab.
   */
  /**
   * GET /voice/config/:projectId
   *
   * Returns the project's current VoiceProjectConfig (if any). Used by
   * the PhonePanel to render the assigned number on reload — previously
   * the UI only received this data as a side-effect of provisioning.
   *
   * Returns 200 with `{ provisioned: false }` when the project has no
   * config row yet, rather than 404, so the UI can render its empty
   * state without error-handling a "not found" case.
   *
   * The `twilioAuthToken` is never returned; the response is limited to
   * the public identifiers the UI needs to display.
   */
  router.get('/voice/config/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const authz = await authorizeProject(c, projectId)
    if (!authz.ok) {
      return c.json(
        { error: { code: authz.code, message: authz.message } },
        authz.status,
      )
    }

    const row = await prisma.voiceProjectConfig.findUnique({
      where: { projectId: authz.projectId },
      select: {
        projectId: true,
        twilioPhoneNumber: true,
        twilioPhoneSid: true,
        elevenlabsPhoneId: true,
        elevenlabsAgentId: true,
        purchasedAt: true,
        monthlyRateDebitedFor: true,
      },
    })

    if (!row) {
      return c.json({ provisioned: false })
    }

    return c.json({
      provisioned: Boolean(row.twilioPhoneSid && row.twilioPhoneNumber),
      phoneNumber: row.twilioPhoneNumber,
      twilioPhoneSid: row.twilioPhoneSid,
      elevenlabsPhoneId: row.elevenlabsPhoneId,
      elevenlabsAgentId: row.elevenlabsAgentId,
      purchasedAt: row.purchasedAt,
      monthlyRateDebitedFor: row.monthlyRateDebitedFor,
    })
  })

  router.get('/voice/usage/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const authz = await authorizeProject(c, projectId)
    if (!authz.ok) {
      return c.json(
        { error: { code: authz.code, message: authz.message } },
        authz.status,
      )
    }

    const parseDate = (s: string | undefined): Date | undefined => {
      if (!s) return undefined
      const d = new Date(s)
      return isNaN(d.getTime()) ? undefined : d
    }
    const fromDate = parseDate(c.req.query('from'))
    const toDate = parseDate(c.req.query('to'))

    const where: Record<string, unknown> = {
      workspaceId: authz.workspaceId,
      projectId: authz.projectId,
      actionType: {
        in: [
          'voice_minutes_inbound',
          'voice_minutes_outbound',
          'voice_number_setup',
          'voice_number_monthly',
        ],
      },
    }
    if (fromDate || toDate) {
      (where as any).createdAt = {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate ? { lte: toDate } : {}),
      }
    }

    const events = await prisma.usageEvent.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: {
        id: true,
        actionType: true,
        actionMetadata: true,
        creditCost: true,
        createdAt: true,
      },
    })

    let minutesInbound = 0
    let minutesOutbound = 0
    let creditsInbound = 0
    let creditsOutbound = 0
    let creditsNumbers = 0
    let inboundCalls = 0
    let outboundCalls = 0

    for (const ev of events) {
      const metaRaw = ev.actionMetadata as unknown
      const meta: Record<string, unknown> =
        metaRaw && typeof metaRaw === 'object'
          ? (metaRaw as Record<string, unknown>)
          : typeof metaRaw === 'string'
            ? (() => {
                try {
                  return JSON.parse(metaRaw)
                } catch {
                  return {}
                }
              })()
            : {}
      const mins = typeof meta.billedMinutes === 'number' ? meta.billedMinutes : 0
      if (ev.actionType === 'voice_minutes_inbound') {
        minutesInbound += mins
        creditsInbound += ev.creditCost
        inboundCalls += 1
      } else if (ev.actionType === 'voice_minutes_outbound') {
        minutesOutbound += mins
        creditsOutbound += ev.creditCost
        outboundCalls += 1
      } else {
        creditsNumbers += ev.creditCost
      }
    }

    return c.json({
      projectId: authz.projectId,
      range: {
        from: fromDate?.toISOString() ?? null,
        to: toDate?.toISOString() ?? null,
      },
      totals: {
        minutesInbound,
        minutesOutbound,
        creditsInbound,
        creditsOutbound,
        creditsNumbers,
        credits: creditsInbound + creditsOutbound + creditsNumbers,
        calls: inboundCalls + outboundCalls,
        inboundCalls,
        outboundCalls,
      },
      events,
    })
  })

  /**
   * GET /voice/calls/:projectId?limit=&includeTranscript=
   *
   * Recent voice calls for a project, in reverse-chronological order.
   * Sources rows from VoiceCallMeter (one row per call), which are
   * populated by the ElevenLabs + Twilio webhooks. Transcripts from
   * EL's post_call_transcription webhook are attached inline when
   * `includeTranscript=1` is passed, otherwise only a `hasTranscript`
   * flag and the optional summary are returned (keeps the list payload
   * small for the channel-settings UI).
   */
  router.get('/voice/calls/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const authz = await authorizeProject(c, projectId)
    if (!authz.ok) {
      return c.json(
        { error: { code: authz.code, message: authz.message } },
        authz.status,
      )
    }

    const limitRaw = Number(c.req.query('limit') ?? '50')
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 200)
      : 50
    const includeTranscript =
      c.req.query('includeTranscript') === '1' ||
      c.req.query('includeTranscript') === 'true'

    const rows = await prisma.voiceCallMeter.findMany({
      where: {
        workspaceId: authz.workspaceId,
        projectId: authz.projectId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    const calls = rows.map((r) => {
      const hasTranscript =
        r.transcript != null &&
        (Array.isArray(r.transcript)
          ? r.transcript.length > 0
          : typeof r.transcript === 'string'
            ? r.transcript.length > 0
            : true)
      return {
        id: r.id,
        conversationId: r.conversationId,
        callSid: r.callSid,
        direction: r.direction,
        durationSeconds: r.durationSeconds,
        billedMinutes: r.billedMinutes,
        startedAt: r.startedAt?.toISOString() ?? null,
        endedAt: r.endedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        billed: !!r.usageEventId,
        hasTranscript,
        transcriptSummary: r.transcriptSummary ?? null,
        transcript: includeTranscript ? r.transcript ?? null : undefined,
      }
    })

    return c.json({ projectId: authz.projectId, calls })
  })

  /**
   * GET /voice/calls/:projectId/:callId
   *
   * Single call row including the full transcript. `callId` can be the
   * VoiceCallMeter id, an ElevenLabs `conversationId`, or a Twilio
   * `CallSid` — whichever the caller has on hand.
   */
  router.get('/voice/calls/:projectId/:callId', async (c) => {
    const projectId = c.req.param('projectId')
    const callId = c.req.param('callId')
    const authz = await authorizeProject(c, projectId)
    if (!authz.ok) {
      return c.json(
        { error: { code: authz.code, message: authz.message } },
        authz.status,
      )
    }

    const row = await prisma.voiceCallMeter.findFirst({
      where: {
        workspaceId: authz.workspaceId,
        projectId: authz.projectId,
        OR: [
          { id: callId },
          { conversationId: callId },
          { callSid: callId },
        ],
      },
    })
    if (!row) {
      return c.json(
        { error: { code: 'not_found', message: 'Call not found' } },
        404,
      )
    }

    return c.json({
      id: row.id,
      conversationId: row.conversationId,
      callSid: row.callSid,
      direction: row.direction,
      durationSeconds: row.durationSeconds,
      billedMinutes: row.billedMinutes,
      startedAt: row.startedAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      billed: !!row.usageEventId,
      transcriptSummary: row.transcriptSummary ?? null,
      transcript: row.transcript ?? null,
    })
  })

  /**
   * POST /voice/elevenlabs/webhook
   *
   * ElevenLabs post_call_transcription handler. HMAC-verified via
   * `ELEVENLABS_WEBHOOK_SECRET`. Idempotent on `conversation_id` —
   * re-delivery of the same event is a strict no-op once
   * `VoiceCallMeter.usageEventId` is set.
   */
  router.post('/voice/elevenlabs/webhook', async (c) => {
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET
    if (!secret) {
      console.error(
        '[Voice] elevenlabs webhook received but ELEVENLABS_WEBHOOK_SECRET is not set',
      )
      return c.json({ error: 'Webhook not configured' }, 503)
    }

    const raw = await c.req.text()
    const sig = c.req.header('elevenlabs-signature') || c.req.header('ElevenLabs-Signature')
    if (!verifyElevenLabsSignature({ secret, signatureHeader: sig ?? null, rawBody: raw })) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid ElevenLabs signature' } }, 401)
    }

    let payload: any
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    // EL post-call webhook shape — the two fields we care about:
    //   type: 'post_call_transcription'
    //   data.conversation_id: string
    //   data.agent_id: string
    //   data.metadata.call_duration_secs: number
    //   data.metadata.phone_call: { direction, external_number?, agent_number?, call_sid? }
    //
    // Some older fixtures flatten these at the top level; be lenient.
    const data = payload?.data ?? payload
    const conversationId: string | undefined =
      data?.conversation_id ?? data?.conversationId
    const agentId: string | undefined = data?.agent_id ?? data?.agentId
    const metadata = data?.metadata ?? {}
    const durationSeconds: number = Number(
      metadata?.call_duration_secs ??
        metadata?.callDurationSecs ??
        data?.duration_secs ??
        0,
    )
    const phoneCall = metadata?.phone_call ?? metadata?.phoneCall ?? {}
    const callSid: string | undefined =
      phoneCall?.call_sid ?? phoneCall?.callSid ?? data?.call_sid
    const directionRaw = String(
      phoneCall?.direction ?? data?.direction ?? '',
    ).toLowerCase()
    const direction: 'inbound' | 'outbound' =
      directionRaw === 'outbound' || directionRaw === 'outbound-api'
        ? 'outbound'
        : 'inbound'
    const fromNumber: string | undefined = phoneCall?.external_number ?? phoneCall?.from
    const toNumber: string | undefined = phoneCall?.agent_number ?? phoneCall?.to

    // Transcript — EL delivers an array of turns on `data.transcript`,
    // and a single-sentence summary on `data.analysis.transcript_summary`
    // (or `data.metadata.transcript_summary` in older fixtures). We
    // persist both on the VoiceCallMeter row so the UI can render them.
    const transcript: unknown = Array.isArray(data?.transcript)
      ? data.transcript
      : undefined
    const transcriptSummary: string | undefined =
      data?.analysis?.transcript_summary ??
      data?.analysis?.transcriptSummary ??
      metadata?.transcript_summary ??
      undefined

    if (!conversationId && !callSid) {
      return c.json({ ok: true, ignored: 'no conversation_id or call_sid' })
    }

    // Resolve the project scope. Prefer: existing VoiceCallMeter row
    // (seeded by outbound pre-seed), else VoiceProjectConfig by agentId.
    let projectId: string | undefined
    let workspaceId: string | undefined
    if (conversationId || callSid) {
      const meter = await prisma.voiceCallMeter.findFirst({
        where: {
          OR: [
            ...(conversationId ? [{ conversationId }] : []),
            ...(callSid ? [{ callSid }] : []),
          ],
        },
        select: { projectId: true, workspaceId: true },
      })
      if (meter) {
        projectId = meter.projectId
        workspaceId = meter.workspaceId
      }
    }
    if ((!projectId || !workspaceId) && agentId) {
      const cfg = await prisma.voiceProjectConfig.findFirst({
        where: { elevenlabsAgentId: agentId },
        select: { projectId: true, workspaceId: true },
      })
      if (cfg) {
        projectId = cfg.projectId
        workspaceId = cfg.workspaceId
      }
    }
    if (!projectId || !workspaceId) {
      console.warn(
        '[Voice] EL webhook: could not resolve project scope',
        { conversationId, callSid, agentId },
      )
      return c.json({ ok: true, ignored: 'no_project_scope' })
    }

    try {
      const result = await recordCallUsage({
        projectId,
        workspaceId,
        direction,
        durationSeconds,
        ...(conversationId ? { conversationId } : {}),
        ...(callSid ? { callSid } : {}),
        ...(agentId ? { agentId } : {}),
        ...(fromNumber ? { fromNumber } : {}),
        ...(toNumber ? { toNumber } : {}),
        ...(transcript ? { transcript } : {}),
        ...(transcriptSummary ? { transcriptSummary } : {}),
        endedAt: new Date(),
      })
      return c.json({
        ok: true,
        billedMinutes: result.billedMinutes,
        creditCost: result.creditCost,
        alreadyBilled: result.alreadyBilled,
      })
    } catch (err: any) {
      console.error('[Voice] EL webhook processing failed:', err?.message || err)
      return c.json(
        { error: 'metering_failed', detail: err?.message ?? String(err) },
        500,
      )
    }
  })

  /**
   * POST /voice/twilio/status/:projectId
   *
   * Twilio statusCallback handler. Signature-verified with Shogo's
   * env-configured auth token. Same `VoiceCallMeter` dedupe as the EL
   * webhook — whichever callback arrives first bills, the other is a
   * no-op.
   */
  router.post('/voice/twilio/status/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const authToken = process.env.TWILIO_AUTH_TOKEN
    if (!authToken) {
      console.error(
        '[Voice] twilio status callback received but TWILIO_AUTH_TOKEN is not set',
      )
      return c.json({ error: 'Webhook not configured' }, 503)
    }

    const raw = await c.req.text()
    const bodyParams: Record<string, string> = {}
    for (const [k, v] of new URLSearchParams(raw).entries()) {
      bodyParams[k] = v
    }

    // Reconstruct the full URL exactly as Twilio signed it. Prefer the
    // x-forwarded-proto/host pair set by the edge proxy; fall back to
    // the Hono-supplied URL.
    const xfProto = c.req.header('x-forwarded-proto')
    const xfHost = c.req.header('x-forwarded-host') ?? c.req.header('host')
    let fullUrl: string
    if (xfProto && xfHost) {
      const path = new URL(c.req.url).pathname + new URL(c.req.url).search
      fullUrl = `${xfProto}://${xfHost}${path}`
    } else {
      fullUrl = c.req.url
    }

    const sig = c.req.header('X-Twilio-Signature') || c.req.header('x-twilio-signature')
    if (
      !verifyTwilioSignature({
        authToken,
        signatureHeader: sig ?? null,
        fullUrl,
        bodyParams,
      })
    ) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Invalid Twilio signature' } },
        401,
      )
    }

    const status = bodyParams.CallStatus
    // Only bill on terminal status.
    if (status !== 'completed' && status !== 'failed' && status !== 'no-answer' && status !== 'busy' && status !== 'canceled') {
      return c.json({ ok: true, ignored: `status=${status}` })
    }

    const callSid = bodyParams.CallSid
    const durationSeconds = Number(bodyParams.CallDuration ?? '0') || 0
    const directionRaw = (bodyParams.Direction ?? '').toLowerCase()
    const direction: 'inbound' | 'outbound' = directionRaw.startsWith('outbound')
      ? 'outbound'
      : 'inbound'

    if (!callSid) {
      return c.json({ ok: true, ignored: 'no CallSid' })
    }

    // Authorize project context — we trust the :projectId segment
    // only after the signature passed. Resolve workspaceId from the
    // config (no user session on a webhook).
    const config = await prisma.voiceProjectConfig.findUnique({
      where: { projectId },
      select: { projectId: true, workspaceId: true },
    })
    if (!config) {
      return c.json({ ok: true, ignored: 'project_not_configured' })
    }

    try {
      const result = await recordCallUsage({
        projectId: config.projectId,
        workspaceId: config.workspaceId,
        direction,
        durationSeconds,
        callSid,
        fromNumber: bodyParams.From,
        toNumber: bodyParams.To,
        endedAt: new Date(),
      })
      return c.json({
        ok: true,
        billedMinutes: result.billedMinutes,
        creditCost: result.creditCost,
        alreadyBilled: result.alreadyBilled,
      })
    } catch (err: any) {
      console.error(
        '[Voice] Twilio statusCallback processing failed:',
        err?.message || err,
      )
      return c.json(
        { error: 'metering_failed', detail: err?.message ?? String(err) },
        500,
      )
    }
  })

  /**
   * DELETE /voice/twilio/number/:projectId
   *
   * Releases the Twilio number + EL phone registration, clears the
   * fields in VoiceProjectConfig. Stops recurring monthly debits.
   * Already-consumed monthly credit is not refunded (v1 behavior;
   * matches how most PSTN carriers handle mid-cycle releases).
   */
  router.delete('/voice/twilio/number/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const authz = await authorizeProject(c, projectId)
    if (!authz.ok) {
      return c.json(
        { error: { code: authz.code, message: authz.message } },
        authz.status,
      )
    }

    const config = await prisma.voiceProjectConfig.findUnique({
      where: { projectId: authz.projectId },
    })
    if (!config?.twilioPhoneSid) {
      return c.json({ released: false, reason: 'no_number' })
    }

    const twResolved = resolveShogoTwilioClient()
    const elResolved = resolveShogoElevenLabsClient()
    const errors: string[] = []

    if ('client' in twResolved) {
      try {
        await twResolved.client.releaseNumber(config.twilioPhoneSid)
      } catch (err: any) {
        errors.push(`twilio: ${err?.message ?? String(err)}`)
      }
    } else {
      errors.push(`twilio: ${twResolved.error}`)
    }

    if (config.elevenlabsPhoneId) {
      if ('client' in elResolved) {
        try {
          await elResolved.client.deletePhoneNumber(config.elevenlabsPhoneId)
        } catch (err: any) {
          errors.push(`elevenlabs: ${err?.message ?? String(err)}`)
        }
      } else {
        errors.push(`elevenlabs: ${elResolved.error}`)
      }
    }

    await prisma.voiceProjectConfig.update({
      where: { projectId: authz.projectId },
      data: {
        twilioPhoneNumber: null,
        twilioPhoneSid: null,
        elevenlabsPhoneId: null,
        purchasedAt: null,
        monthlyRateDebitedFor: null,
      },
    })

    return c.json({
      released: true,
      ...(errors.length ? { warnings: errors } : {}),
    })
  })

  return router
}

/**
 * Build a public-facing API URL. Twilio needs to reach our status
 * callback from the internet, so we prefer `SHOGO_PUBLIC_API_URL`
 * (set on every environment) over any local dev URL.
 */
function buildPublicApiUrl(path: string): string {
  const base =
    process.env.SHOGO_PUBLIC_API_URL ||
    process.env.APP_URL ||
    process.env.BETTER_AUTH_URL ||
    ''
  if (!base) return path
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : '/' + path}`
}
