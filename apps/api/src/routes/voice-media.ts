// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hosted voice media routes — `POST /api/voice/tts` and `POST /api/voice/music`.
 *
 * These are the endpoints the SDK's runtime-token proxy mode
 * (`@shogo-ai/sdk/voice/server` → `SHOGO_API_URL`) calls from inside a pod,
 * and the ones a pod app hits directly when it wants hosted narration with
 * Shogo's pooled ElevenLabs key. They are project-scoped, not per-end-user.
 *
 * This module is deliberately free of billing, Twilio and `server-cloud-deps`
 * imports: it is mounted unconditionally in `apps/api/src/server.ts`, so it
 * has to be safe to load in `LOCAL_MODE` (desktop) as well as in cloud. The
 * cloud-only `voice.ts` router keeps its other endpoints and delegates its
 * `/voice/music` handler here so there is exactly one implementation.
 *
 * Behaviour contract:
 *   - unknown `modelId` → 400 with the allowed list (never a silent clamp)
 *   - text over the model's character cap → 413 with the limit
 *   - upstream ElevenLabs failure → 502 `{ error, detail, elBody }`
 *   - no `ELEVENLABS_API_KEY` → 503 with a specific message
 *   - responses carry `x-tts-model-used` + `x-tts-model-requested`, and a
 *     `Warning: 199 …` header when ElevenLabs made us fall back
 */

import { Hono, type Context } from 'hono'
import {
  CONVAI_TTS_MODEL_FALLBACK,
  ElevenLabsClient,
  VOICE_TTS_MODEL_IDS,
  buildPreviewLine,
  getVoiceTtsModel,
  normalizeAudioTags,
  normalizeVoiceSettings,
  type VoiceSettings,
} from '@shogo-ai/sdk/voice'
import { prisma } from '../lib/prisma'
import { apiKeyOrSession, authorizeProject } from '../middleware/auth'

/** ElevenLabs voice used when a project has no `default` agent voice. */
export const DEFAULT_PROJECT_AGENT_VOICE_ID =
  process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'

/**
 * Default model for hosted TTS. `eleven_v4_turbo` is the realtime v4 variant
 * (~100 ms) and is accepted by convai, so one default serves narration and
 * agent-adjacent use. Override per request with `modelId`.
 */
export const DEFAULT_HOSTED_TTS_MODEL = CONVAI_TTS_MODEL_FALLBACK

/**
 * Resolve Shogo's pooled ElevenLabs client for project-scoped media
 * operations. The key never leaves the server.
 */
export function resolveShogoElevenLabsClient():
  | { client: ElevenLabsClient }
  | { error: string } {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return {
      error:
        'ELEVENLABS_API_KEY is not configured. Voice mode is unavailable until the server sets this env var (hosted /api/voice/tts and /api/voice/music included).',
    }
  }
  return { client: new ElevenLabsClient({ apiKey }) }
}

interface ProjectAuthz {
  ok: boolean
  status: number
  message?: string
}

/**
 * Test seam: the handlers read the project's authorization and default voice
 * through these so route tests do not need a seeded database.
 */
export interface VoiceMediaDeps {
  /** Authorize the caller against `projectId`. Defaults to `authorizeProject`. */
  authorize?: (c: Context, projectId: string) => Promise<ProjectAuthz>
  /** Resolve the project's default voice id. Defaults to ProjectAgent → env. */
  resolveVoiceId?: (projectId: string) => Promise<string>
}

async function defaultResolveVoiceId(projectId: string): Promise<string> {
  try {
    const agent = await prisma.projectAgent.findUnique({
      where: { projectId_name: { projectId, name: 'default' } },
      select: { voiceId: true },
    })
    if (agent?.voiceId) return agent.voiceId
  } catch {
    // No project_agents row (pre-migration project) — fall through to env.
  }
  return DEFAULT_PROJECT_AGENT_VOICE_ID
}

async function defaultAuthorize(c: Context, projectId: string): Promise<ProjectAuthz> {
  const result = await authorizeProject(c, projectId, 'project:read')
  if (result.ok) return { ok: true, status: 200 }
  return { ok: false, status: result.status, message: result.message }
}

function errorJson(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * A runtime token is scoped to one project; asking for another project's
 * media is a scope violation (403), not a missing project (404).
 */
function runtimeScopeViolation(c: Context, projectId: string | undefined): Response | null {
  const auth = c.get('auth')
  if (auth?.via !== 'runtimeToken') return null
  if (projectId && auth.projectId === projectId) return null
  return c.json(
    {
      error: 'forbidden',
      detail: projectId
        ? 'Runtime token scope mismatch'
        : 'Runtime-token callers must pass ?projectId=',
    },
    403,
  )
}

function resolveProjectId(c: Context): string | undefined {
  return c.req.query('projectId')?.trim() || undefined
}

/** Body shape for `POST /voice/tts`. */
export interface VoiceTtsBody {
  text?: string
  voiceId?: string
  modelId?: string
  voiceSettings?: VoiceSettings
  audioTags?: string[]
  characterName?: string
}

/**
 * `POST /api/voice/tts` — one-shot hosted TTS.
 *
 * Body: `{ text, voiceId?, modelId?, voiceSettings?, audioTags? }`.
 * `voiceId` defaults to the project's default agent voice, `modelId` to
 * {@link DEFAULT_HOSTED_TTS_MODEL}. When `text` is empty a short preview
 * line is built from `audioTags` (same helper the SDK's tts-preview uses).
 */
export async function handleVoiceTts(
  c: Context,
  deps: VoiceMediaDeps = {},
): Promise<Response> {
  const projectId = resolveProjectId(c)
  if (!projectId) {
    return c.json(
      {
        error: 'bad_request',
        detail: 'projectId is required (query param) for hosted TTS',
      },
      400,
    )
  }

  const scopeViolation = runtimeScopeViolation(c, projectId)
  if (scopeViolation) return scopeViolation

  const authorize = deps.authorize ?? defaultAuthorize
  const authz = await authorize(c, projectId)
  if (!authz.ok) {
    return c.json({ error: 'forbidden', detail: authz.message }, authz.status as 400 | 401 | 403 | 404)
  }

  let body: VoiceTtsBody
  try {
    body = (await c.req.json()) as VoiceTtsBody
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const modelId =
    typeof body.modelId === 'string' && body.modelId.length > 0
      ? body.modelId
      : DEFAULT_HOSTED_TTS_MODEL
  const model = getVoiceTtsModel(modelId)
  if (!model) {
    return c.json(
      {
        error: 'unknown_model',
        detail: `Unknown TTS model '${modelId}'`,
        allowed: VOICE_TTS_MODEL_IDS,
      },
      400,
    )
  }

  const tags = normalizeAudioTags(body.audioTags) ?? []
  const text =
    typeof body.text === 'string' && body.text.trim().length > 0
      ? body.text
      : buildPreviewLine(tags, body.characterName ?? 'your companion')

  if (!text.trim()) {
    return c.json(
      { error: 'bad_request', detail: 'text is required (or pass audioTags to build a preview line)' },
      400,
    )
  }
  if (text.length > model.maxChars) {
    return c.json(
      {
        error: 'text_too_long',
        detail: `${model.id} accepts at most ${model.maxChars} characters per request; got ${text.length}`,
        modelId: model.id,
        maxChars: model.maxChars,
        length: text.length,
      },
      413,
    )
  }

  // Request validation happens before the server-key check: a bad model id
  // is the caller's bug and must read as 400 even on a host without a key.
  const resolved = resolveShogoElevenLabsClient()
  if ('error' in resolved) {
    return c.json({ error: 'voice_unavailable', detail: resolved.error }, 503)
  }

  const resolveVoiceId = deps.resolveVoiceId ?? defaultResolveVoiceId
  const voiceId =
    typeof body.voiceId === 'string' && body.voiceId.trim().length > 0
      ? body.voiceId.trim()
      : await resolveVoiceId(projectId)

  const voiceSettings =
    normalizeVoiceSettings(body.voiceSettings) ?? {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0,
    }

  try {
    const result = await resolved.client.textToSpeech({ voiceId, text, modelId, voiceSettings })
    const headers: Record<string, string> = {
      'content-type': result.contentType,
      'cache-control': 'private, max-age=3600',
      'x-tts-model-used': result.modelId,
      'x-tts-model-requested': result.requestedModel,
    }
    if (result.fellBack) {
      headers.warning = `199 - "model ${result.requestedModel} not available, used ${result.modelId}"`
      console.warn(
        `[Voice] tts fell back: requested ${result.requestedModel}, used ${result.modelId} (${result.fallbackReason ?? 'no reason reported'})`,
      )
    }
    return new Response(result.audio, { status: 200, headers })
  } catch (err: any) {
    console.error('[Voice] tts failed:', err?.message || err)
    return c.json(
      {
        error: 'TTS failed',
        detail: err?.message ?? errorJson(err),
        elBody: err?.body ?? undefined,
      },
      502,
    )
  }
}

/** Body shape for `POST /voice/music`. */
export interface VoiceMusicBody {
  prompt?: string
  compositionPlan?: Record<string, unknown>
  musicLengthMs?: number
  modelId?: string
  forceInstrumental?: boolean
  outputFormat?: string
}

/**
 * `POST /api/voice/music` — ElevenLabs Music with the pooled key.
 *
 * `projectId` is optional for back-compat with session callers, but when it
 * is present the caller is authorized against it (runtime tokens must match).
 */
export async function handleVoiceMusic(
  c: Context,
  deps: VoiceMediaDeps = {},
): Promise<Response> {
  const projectId = c.req.query('projectId')?.trim() || undefined
  const scopeViolation = runtimeScopeViolation(c, projectId)
  if (scopeViolation) return scopeViolation
  if (projectId) {
    const authorize = deps.authorize ?? defaultAuthorize
    const authz = await authorize(c, projectId)
    if (!authz.ok) {
      return c.json({ error: 'forbidden', detail: authz.message }, authz.status as 400 | 401 | 403 | 404)
    }
  }

  const resolved = resolveShogoElevenLabsClient()
  if ('error' in resolved) {
    return c.json({ error: 'voice_unavailable', detail: resolved.error }, 503)
  }

  let body: VoiceMusicBody
  try {
    body = (await c.req.json()) as VoiceMusicBody
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const hasPrompt = typeof body.prompt === 'string' && body.prompt.trim().length > 0
  const hasPlan = body.compositionPlan != null && typeof body.compositionPlan === 'object'
  if (hasPrompt === hasPlan) {
    return c.json({ error: 'Provide exactly one of `prompt` or `compositionPlan`' }, 400)
  }

  try {
    const { audio, contentType } = await resolved.client.composeMusic({
      ...(hasPrompt ? { prompt: body.prompt!.trim() } : {}),
      ...(hasPlan ? { compositionPlan: body.compositionPlan } : {}),
      ...(typeof body.musicLengthMs === 'number' ? { musicLengthMs: body.musicLengthMs } : {}),
      ...(typeof body.modelId === 'string' && body.modelId ? { modelId: body.modelId } : {}),
      ...(typeof body.forceInstrumental === 'boolean'
        ? { forceInstrumental: body.forceInstrumental }
        : {}),
      ...(typeof body.outputFormat === 'string' && body.outputFormat
        ? { outputFormat: body.outputFormat }
        : {}),
    })
    return new Response(audio, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'private, max-age=3600',
      },
    })
  } catch (err: any) {
    console.error('[Voice] music generation failed:', err?.message || err)
    return c.json(
      {
        error: 'Music generation failed',
        detail: err?.message ?? errorJson(err),
        elBody: err?.body ?? undefined,
      },
      502,
    )
  }
}

/**
 * Hono router for the hosted media endpoints. Mount it unconditionally in
 * `apps/api/src/server.ts` so `/api/voice/tts` exists in cloud *and* desktop.
 */
export function voiceMediaRoutes(deps: VoiceMediaDeps = {}) {
  const router = new Hono()
  router.use('/voice/*', apiKeyOrSession)
  router.post('/voice/tts', (c) => handleVoiceTts(c, deps))
  router.post('/voice/music', (c) => handleVoiceMusic(c, deps))
  return router
}
