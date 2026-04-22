// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice / Shogo Mode Routes
 *
 * Two endpoints that back the "Shogo Mode" overlay (voice + text
 * translator). Mounted under `/api`:
 *
 *   - GET  /api/voice/signed-url       → short-lived ElevenLabs signed URL
 *                                         for the browser convai session
 *                                         (voice modality).
 *   - POST /api/voice/translator/chat  → streaming AI SDK chat route that
 *                                         serves the same translator
 *                                         persona for the text modality.
 *
 * Both endpoints require an authenticated user. The `ELEVENLABS_API_KEY`
 * never leaves the server; the browser only ever sees a short-lived
 * signed URL.
 *
 * V1 uses a single shared "Shogo Mode" convai agent referenced by
 * `ELEVENLABS_VOICE_MODE_AGENT_ID`. There is no per-user companion store
 * here by design.
 */

import { Hono } from 'hono'
import { streamText, convertToModelMessages, type UIMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { ElevenLabsClient } from '@shogo-ai/sdk/voice'
import {
  TRANSLATOR_SYSTEM_PROMPT,
  TRANSLATOR_AI_SDK_TOOLS,
} from '@shogo/agent-runtime/src/voice-mode/translator-persona'

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
   * POST /voice/translator/chat — streaming chat endpoint that serves
   * the same translator persona used by the voice agent, so the Shogo
   * Mode overlay can also be driven by text.
   *
   * Request body: `{ messages: UIMessage[] }` (AI SDK v6 format).
   * Response: UI message stream (`toUIMessageStreamResponse`).
   *
   * The two tools (`send_to_chat`, `set_mode`) are declared WITHOUT an
   * `execute` function — they are executed client-side by the overlay,
   * which supplies results via `useChat().addToolOutput` before the
   * translator's next turn.
   */
  router.post('/voice/translator/chat', async (c) => {
    const auth = c.get('auth')
    if (!auth?.isAuthenticated || !auth.userId) {
      return c.json({ error: 'Authentication required' }, 401)
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
      const modelMessages = await convertToModelMessages(uiMessages)
      const result = streamText({
        model,
        system: TRANSLATOR_SYSTEM_PROMPT,
        messages: modelMessages,
        tools: TRANSLATOR_AI_SDK_TOOLS,
      })
      return result.toUIMessageStreamResponse()
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

  return router
}
