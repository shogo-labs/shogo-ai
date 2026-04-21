// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Framework-agnostic voice server handlers. Mirrors the shape of
 * `@shogo-ai/sdk/memory/server`: each handler is a `(Request) => Promise<Response>`
 * you can drop into any Web-standard router (Hono, Next.js route handlers,
 * Bun.serve, Deno, etc.) or adapt with {@link toNodeListener}.
 *
 * @example Hono
 * ```ts
 * import { Hono } from 'hono'
 * import { createVoiceHandlers } from '@shogo-ai/sdk/voice/server'
 *
 * const voice = createVoiceHandlers({
 *   apiKey: process.env.ELEVENLABS_API_KEY!,
 *   getUser: async (req) => authenticate(req),
 *   companionStore: new PrismaCompanionStore(prisma),
 *   memoryStore: (userId) => memoryStoreFor(userId),
 * })
 *
 * const app = new Hono()
 * app.get('/voice/signed-url',   (c) => voice.signedUrl(c.req.raw))
 * app.post('/voice/tts-preview', (c) => voice.tts(c.req.raw))
 * app.post('/voice/agent',       (c) => voice.agent.create(c.req.raw))
 * app.patch('/voice/agent',      (c) => voice.agent.patch(c.req.raw))
 * app.delete('/voice/agent',     (c) => voice.agent.delete(c.req.raw))
 * app.get('/voice/audio-tags',   (c) => voice.audioTags(c.req.raw))
 * ```
 */

import {
  AUDIO_TAGS,
  AUDIO_TAG_GROUPS,
  DEFAULT_ALLOWED_TAGS,
  DEFAULT_VOICE_SETTINGS,
  EXPRESSIVITY_OPTIONS,
  buildPreviewLine,
  normalizeAudioTags,
  normalizeExpressivity,
  normalizeVoiceSettings,
  readAudioTags,
  readExpressivity,
  readVoiceSettings,
  type Expressivity,
  type VoiceSettings,
} from './audioTags.js'
import {
  CONVAI_TTS_MODEL_FALLBACK,
  ElevenLabsApiError,
  ElevenLabsClient,
  MEMORY_CLIENT_TOOLS,
  resolveConvaiTtsModel,
  type ConvaiClientTool,
  type ElevenLabsClientConfig,
} from './elevenlabs.js'
import { extractBasePrompt } from './prompt.js'
import type {
  Companion,
  CompanionStore,
  CreateCompanionBody,
  PatchCompanionBody,
  TtsPreviewBody,
  VoiceMemoryStore,
  VoiceUser,
} from './types.js'

export type GetVoiceUser = (req: Request) => Promise<VoiceUser | null> | VoiceUser | null

export interface VoiceHandlersConfig {
  /** 11Labs API key. */
  apiKey: string
  /** Resolve the authenticated user from a request, or `null` for unauthenticated. */
  getUser: GetVoiceUser
  /** Consumer-owned persistence layer for Companion records. */
  companionStore: CompanionStore
  /** Optional memory store — when present, `signedUrl` preloads context bullets. */
  memoryStore?: (userId: string) => VoiceMemoryStore
  /**
   * When `true` (default), the `add_memory` tool is attached to every new or
   * patched agent and the memory block is appended to the system prompt.
   */
  includeMemoryTools?: boolean
  /** Override the ElevenLabs base URL (useful for tests / self-hosted proxies). */
  elevenLabsBaseUrl?: string
  /** Custom fetch impl (forwarded to {@link ElevenLabsClient}). */
  fetch?: typeof fetch
  /** Optional structured logger. */
  logger?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void
}

export interface VoiceHandlers {
  /** `GET /voice/signed-url` — returns `{ signedUrl, agentId, userContext }`. */
  signedUrl: (req: Request) => Promise<Response>
  /** `POST /voice/tts-preview` — returns raw audio bytes. Expects {@link TtsPreviewBody}. */
  tts: (req: Request) => Promise<Response>
  /** Agent CRUD endpoints. */
  agent: {
    /** `POST /voice/agent` — create a companion + 11Labs agent for the authed user. */
    create: (req: Request) => Promise<Response>
    /** `PATCH /voice/agent` — patch any subset of companion fields. */
    patch: (req: Request) => Promise<Response>
    /** `DELETE /voice/agent` — delete the 11Labs agent and the companion row. */
    delete: (req: Request) => Promise<Response>
  }
  /** `GET /voice/audio-tags` — static catalog + defaults (no auth required). */
  audioTags: (req: Request) => Promise<Response>
  /**
   * The underlying ElevenLabsClient, exposed for consumers who need to build
   * additional endpoints (e.g. an agent-driven God Mode settings editor).
   */
  elevenLabs: ElevenLabsClient
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

async function readJson(req: Request): Promise<unknown> {
  try {
    const text = await req.text()
    if (!text) return {}
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const NOOP_LOGGER: NonNullable<VoiceHandlersConfig['logger']> = () => {
  /* noop */
}

export function createVoiceHandlers(config: VoiceHandlersConfig): VoiceHandlers {
  if (!config.apiKey) throw new Error('createVoiceHandlers: apiKey is required')
  if (!config.getUser) throw new Error('createVoiceHandlers: getUser is required')
  if (!config.companionStore) throw new Error('createVoiceHandlers: companionStore is required')

  const log = config.logger ?? NOOP_LOGGER
  const includeMemoryTools = config.includeMemoryTools ?? true
  const tools: ReadonlyArray<ConvaiClientTool> | undefined = includeMemoryTools
    ? MEMORY_CLIENT_TOOLS
    : undefined

  const elConfig: ElevenLabsClientConfig = {
    apiKey: config.apiKey,
    ...(config.elevenLabsBaseUrl ? { baseUrl: config.elevenLabsBaseUrl } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  }
  const el = new ElevenLabsClient(elConfig)

  async function resolveUser(req: Request): Promise<VoiceUser | Response> {
    const u = await config.getUser(req)
    if (!u) return json({ error: 'Unauthorized' }, 401)
    return u
  }

  function handleElError(e: unknown, fallbackLabel: string): Response {
    if (e instanceof ElevenLabsApiError) {
      log('warn', `${fallbackLabel}: 11Labs ${e.status}`, { body: e.body })
      return json({ error: fallbackLabel, detail: e.body }, 502)
    }
    const message = e instanceof Error ? e.message : String(e)
    log('error', `${fallbackLabel}: ${message}`)
    return json({ error: fallbackLabel, detail: message }, 500)
  }

  async function doSignedUrl(req: Request): Promise<Response> {
    if (req.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405)
    const u = await resolveUser(req)
    if (u instanceof Response) return u

    const companion = await config.companionStore.findByUserId(u.id)
    if (!companion || !companion.agentId) return json({ error: 'No companion' }, 404)

    // Keep the agent in sync with the persisted config before minting a URL.
    // This mirrors the pre-conversation patch in the workspace implementation,
    // guaranteeing the latest prompt/voice/tools land on 11Labs before the
    // browser opens its WebSocket.
    const basePrompt = extractBasePrompt(companion.systemPrompt || '')
    try {
      await el.patchAgent(companion.agentId, {
        systemPrompt: basePrompt,
        tools,
        enableUserContextOverride: includeMemoryTools,
        voiceId: companion.voiceId,
        expressivity: readExpressivity(companion.expressivity),
        audioTags: readAudioTags(companion.audioTags),
        voiceSettings: readVoiceSettings(companion.voiceSettings),
        ttsModelId: companion.ttsModelId ?? null,
        ...(includeMemoryTools ? {} : { memoryBlock: null }),
      })
      if (basePrompt !== companion.systemPrompt) {
        await config.companionStore.update(u.id, { systemPrompt: basePrompt })
      }
    } catch (e) {
      log('warn', 'signedUrl: pre-sync patch failed; continuing', {
        error: e instanceof Error ? e.message : String(e),
      })
    }

    let signedUrl: string
    try {
      signedUrl = await el.getSignedUrl(companion.agentId)
    } catch (e) {
      return handleElError(e, 'Failed to get signed url')
    }

    let userContext = ''
    if (config.memoryStore) {
      try {
        const store = config.memoryStore(u.id)
        const hits = store.search(companion.characterName || 'recent context', { limit: 5 })
        if (hits.length) {
          userContext = hits
            .map(
              (h) =>
                `- ${h.matchType ? `[${h.matchType}] ` : ''}${h.chunk.trim().replace(/\s+/g, ' ').slice(0, 220)}`,
            )
            .join('\n')
        }
      } catch (e) {
        log('warn', 'signedUrl: memory preload failed', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    return json({ signedUrl, agentId: companion.agentId, userContext })
  }

  async function doTts(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
    const u = await resolveUser(req)
    if (u instanceof Response) return u

    const raw = await readJson(req)
    if (raw === null || typeof raw !== 'object') return json({ error: 'Invalid JSON body' }, 400)
    const body = raw as Partial<TtsPreviewBody>
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : ''
    if (!voiceId) return json({ error: 'Missing voiceId' }, 400)

    const voiceSettings =
      normalizeVoiceSettings(body.voiceSettings) ?? { stability: 0.5, similarity_boost: 0.8, style: 0 }

    let text: string
    if (typeof body.text === 'string' && body.text.trim().length > 0) {
      text = body.text.slice(0, 400)
    } else {
      const tags = normalizeAudioTags(body.audioTags) ?? []
      text = buildPreviewLine(tags, body.characterName ?? 'your companion').slice(0, 400)
    }

    try {
      const { audio, modelId, contentType } = await el.textToSpeech({
        voiceId,
        text,
        ...(body.modelId ? { modelId: body.modelId } : {}),
        voiceSettings,
      })
      return new Response(audio, {
        headers: {
          'content-type': contentType,
          'cache-control': 'private, max-age=3600',
          'x-tts-model-used': modelId,
        },
      })
    } catch (e) {
      return handleElError(e, 'TTS failed')
    }
  }

  async function doAgentCreate(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
    const u = await resolveUser(req)
    if (u instanceof Response) return u

    const existing = await config.companionStore.findByUserId(u.id)
    if (existing) return json({ error: 'Companion already exists' }, 409)

    const raw = await readJson(req)
    if (raw === null || typeof raw !== 'object') return json({ error: 'Invalid JSON body' }, 400)
    const body = raw as Partial<CreateCompanionBody>
    if (
      typeof body.displayName !== 'string' ||
      typeof body.characterName !== 'string' ||
      typeof body.voiceId !== 'string' ||
      typeof body.systemPrompt !== 'string' ||
      typeof body.firstMessage !== 'string'
    ) {
      return json({ error: 'Missing required fields' }, 400)
    }

    const expressivity: Expressivity = readExpressivity(body.expressivity)
    const audioTags: string[] = readAudioTags(body.audioTags)
    const voiceSettings: VoiceSettings = readVoiceSettings(body.voiceSettings)
    const ttsModelId = resolveConvaiTtsModel(body.ttsModelId)

    let agentId: string
    try {
      agentId = await el.createAgent({
        displayName: body.displayName,
        characterName: body.characterName,
        voiceId: body.voiceId,
        systemPrompt: body.systemPrompt,
        firstMessage: body.firstMessage,
        expressivity,
        audioTags,
        voiceSettings,
        ttsModelId,
        ...(tools ? { tools } : {}),
        ...(includeMemoryTools ? {} : { memoryBlock: null }),
      })
    } catch (e) {
      return handleElError(e, 'Failed to create agent')
    }

    const cleanedPrompt = extractBasePrompt(body.systemPrompt)
    const companion = await config.companionStore.create({
      userId: u.id,
      agentId,
      displayName: body.displayName,
      characterName: body.characterName,
      voiceId: body.voiceId,
      systemPrompt: cleanedPrompt,
      firstMessage: body.firstMessage,
      expressivity,
      audioTags,
      voiceSettings,
      ttsModelId,
    })
    return json(companion)
  }

  async function doAgentPatch(req: Request): Promise<Response> {
    if (req.method !== 'PATCH') return json({ error: 'Method Not Allowed' }, 405)
    const u = await resolveUser(req)
    if (u instanceof Response) return u

    const existing = await config.companionStore.findByUserId(u.id)
    if (!existing) return json({ error: 'No companion' }, 404)

    const raw = await readJson(req)
    if (raw === null || typeof raw !== 'object') return json({ error: 'Invalid JSON body' }, 400)
    const body = raw as PatchCompanionBody

    const patch: Partial<Companion> = {}
    if (body.displayName !== undefined) patch.displayName = body.displayName
    if (body.characterName !== undefined) patch.characterName = body.characterName
    if (body.voiceId !== undefined) patch.voiceId = body.voiceId
    if (body.firstMessage !== undefined) patch.firstMessage = body.firstMessage

    const expressivity = normalizeExpressivity(body.expressivity)
    if (expressivity !== undefined) patch.expressivity = expressivity
    let audioTagsPatch: string[] | undefined
    if (body.audioTags !== undefined) {
      audioTagsPatch = normalizeAudioTags(body.audioTags) ?? []
      patch.audioTags = audioTagsPatch
    }
    if (body.voiceSettings !== undefined) {
      const vs = normalizeVoiceSettings(body.voiceSettings)
      patch.voiceSettings = vs ?? null
    }
    if (body.ttsModelId !== undefined) patch.ttsModelId = body.ttsModelId ?? null

    const cleanedPrompt =
      body.systemPrompt !== undefined ? extractBasePrompt(body.systemPrompt) : undefined
    if (cleanedPrompt !== undefined) patch.systemPrompt = cleanedPrompt

    const needs11Labs =
      body.displayName !== undefined ||
      body.characterName !== undefined ||
      body.voiceId !== undefined ||
      body.systemPrompt !== undefined ||
      body.firstMessage !== undefined ||
      body.expressivity !== undefined ||
      body.audioTags !== undefined ||
      body.voiceSettings !== undefined ||
      body.ttsModelId !== undefined

    if (existing.agentId && needs11Labs) {
      const finalExpressivity =
        (patch.expressivity as Expressivity | undefined) ?? readExpressivity(existing.expressivity)
      const finalTags =
        audioTagsPatch !== undefined ? audioTagsPatch : readAudioTags(existing.audioTags)
      const finalVoiceSettings =
        body.voiceSettings !== undefined
          ? normalizeVoiceSettings(body.voiceSettings) ?? undefined
          : readVoiceSettings(existing.voiceSettings)
      const finalTtsModelId =
        body.ttsModelId !== undefined ? body.ttsModelId ?? null : existing.ttsModelId ?? null

      try {
        await el.patchAgent(existing.agentId, {
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.characterName !== undefined ? { characterName: body.characterName } : {}),
          ...(body.voiceId !== undefined ? { voiceId: body.voiceId } : {}),
          systemPrompt:
            cleanedPrompt !== undefined
              ? cleanedPrompt
              : body.expressivity !== undefined || body.audioTags !== undefined
                ? existing.systemPrompt
                : undefined,
          ...(body.firstMessage !== undefined ? { firstMessage: body.firstMessage } : {}),
          expressivity: finalExpressivity,
          audioTags: finalTags,
          ...(finalVoiceSettings ? { voiceSettings: finalVoiceSettings } : {}),
          ttsModelId: finalTtsModelId,
          ...(includeMemoryTools ? {} : { memoryBlock: null }),
        })
      } catch (e) {
        return handleElError(e, 'Failed to patch agent')
      }
    }

    const companion = await config.companionStore.update(u.id, patch)
    return json(companion)
  }

  async function doAgentDelete(req: Request): Promise<Response> {
    if (req.method !== 'DELETE') return json({ error: 'Method Not Allowed' }, 405)
    const u = await resolveUser(req)
    if (u instanceof Response) return u

    const existing = await config.companionStore.findByUserId(u.id)
    if (!existing) return json({ ok: true })

    if (existing.agentId) await el.deleteAgent(existing.agentId)
    await config.companionStore.delete(u.id)
    return json({ ok: true })
  }

  async function doAudioTags(req: Request): Promise<Response> {
    if (req.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405)
    return json({
      tags: AUDIO_TAGS,
      groups: AUDIO_TAG_GROUPS,
      expressivity: EXPRESSIVITY_OPTIONS,
      defaults: {
        allowedTags: DEFAULT_ALLOWED_TAGS,
        voiceSettings: DEFAULT_VOICE_SETTINGS,
        ttsModelId: CONVAI_TTS_MODEL_FALLBACK,
      },
    })
  }

  return {
    signedUrl: doSignedUrl,
    tts: doTts,
    agent: {
      create: doAgentCreate,
      patch: doAgentPatch,
      delete: doAgentDelete,
    },
    audioTags: doAudioTags,
    elevenLabs: el,
  }
}

/** Wrap a handler for Node `http.createServer` style callbacks. */
export function toNodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  return (nodeReq, nodeRes) => {
    void (async () => {
      const url = `http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url ?? '/'}`
      const chunks: Buffer[] = []
      for await (const chunk of nodeReq) {
        chunks.push(chunk as Buffer)
      }
      const body = Buffer.concat(chunks)
      const init: RequestInit = {
        method: nodeReq.method,
        headers: nodeReq.headers as HeadersInit,
      }
      if (body.length > 0) {
        init.body = body
      }
      const req = new Request(url, init)
      const res = await handler(req)
      nodeRes.statusCode = res.status
      res.headers.forEach((value, key) => {
        nodeRes.setHeader(key, value)
      })
      const buf = Buffer.from(await res.arrayBuffer())
      nodeRes.end(buf)
    })().catch((err) => {
      nodeRes.statusCode = 500
      nodeRes.end(err instanceof Error ? err.message : String(err))
    })
  }
}
