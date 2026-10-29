// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hosted voice media routes — `/api/voice/op/:opId` plus the `/api/voice/tts`
 * and `/api/voice/music` aliases.
 *
 * Every media op ElevenLabs exposes is a row in `VOICE_OPS`
 * (`@shogo-ai/sdk/voice`). This module is the single executor for those rows:
 * project resolution, runtime-token scope, authorization, body limits,
 * pooled-key resolution, cloud forwarding, the upstream call and the usage
 * meter all live in {@link executeVoiceOp}. A new op is a registry row — no
 * handler, no route and no test file of its own.
 *
 * The two legacy paths keep their original bodies and error contracts, so
 * `/voice/tts` and `/voice/music` are thin aliases: they parse their own
 * (unchanged) request body, then hand it to the same executor.
 *
 * This module is deliberately free of billing, Twilio and `server-cloud-deps`
 * imports: it is mounted unconditionally in `apps/api/src/server.ts`, so it
 * has to be safe to load in `LOCAL_MODE` (desktop) as well as in cloud.
 *
 * Behaviour contract:
 *   - unknown `opId` → 404 listing the valid ids
 *   - unknown `modelId` → 400 with the allowed list (never a silent clamp)
 *   - body over the row's `maxBodyBytes` → 413 with the limit
 *   - a required field/part that is missing or not a file → 400
 *   - `byoOnly` row on the pooled key → 403 (never a silent charge to Shogo)
 *   - no `ELEVENLABS_API_KEY` → 503 with a specific message, unless this is a
 *     cloud-authed desktop (`isShogoCloudForwarding()`), where the request is
 *     forwarded to the cloud's own `/api/voice/*` handler and its audio (or
 *     error) is passed straight back
 *   - upstream ElevenLabs failure → 502 `{ error, detail, elBody }`
 *   - responses carry the row's `responseHeaders` (both TTS model headers and
 *     the `Warning: 199 …` fallback notice)
 */

import { Hono, type Context } from 'hono'
import {
  CONVAI_TTS_MODEL_FALLBACK,
  ElevenLabsClient,
  VOICE_OP_IDS,
  buildPreviewLine,
  getVoiceOp,
  getVoiceTtsModel,
  normalizeAudioTags,
  normalizeVoiceSettings,
  parseVoiceOpForm,
  parseVoiceOpJsonBody,
  voiceOpCredentialError,
  voiceOpForwardPath,
  voiceOpPathParams,
  voiceOpReturnsAudio,
  voiceOpUpstreamBody,
  voiceOpUpstreamPath,
  type VoiceOp,
  type VoiceOpPermission,
  type VoiceSettings,
} from '@shogo-ai/sdk/voice'
import { prisma } from '../lib/prisma'
import { generateLyriaMusic, LyriaError } from '../lib/lyria'
import { getMusicModelEntry, MUSIC_MODEL_CATALOG, type MusicModelEntry } from '@shogo/model-catalog'
import { getNativeProviderApiKeySync } from '../services/provider-credentials.service'
import { forwardToShogoCloud } from '../lib/cloud-request-forward'
import { isShogoCloudForwarding } from '../lib/cloud-forwarding'
import { apiKeyOrSession, authorizeProject } from '../middleware/auth'
import { consumeUsage } from '../services/billing.service'

/** ElevenLabs voice used when a project has no `default` agent voice. */
export const DEFAULT_PROJECT_AGENT_VOICE_ID =
  process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'

/**
 * Default model for hosted TTS. `eleven_v4_turbo` is the realtime v4 variant
 * (~100 ms) and is accepted by convai, so one default serves narration and
 * agent-adjacent use. Override per request with `modelId`.
 *
 * The registry row also declares this as its `defaultModel`, so both paths —
 * `/voice/tts` and `/voice/op/text-to-speech` — resolve it here.
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
        'ELEVENLABS_API_KEY is not configured. Voice mode is unavailable until the server sets this env var (hosted /api/voice/op/* and /api/voice/tts include it).',
    }
  }
  return { client: new ElevenLabsClient({ apiKey }) }
}

/**
 * A cloud-authed desktop has no local `ELEVENLABS_API_KEY`: the pooled key, the
 * project's voice library and the billing all live in Shogo Cloud, so the
 * request goes to the cloud's own `/api/voice/*` handler. Precedence matches
 * the AI proxy — once the gate is on, a local key is never consulted (BYOK
 * setups run `AI_MODE=api-keys`, which turns the gate off for everything).
 *
 * `body` is passed explicitly when the handler has already read and validated
 * the JSON (the request stream is single-use); omitted, the caller's body —
 * multipart boundary included — is streamed through untouched.
 */
function forwardVoiceToCloud(
  c: Context,
  pathname: string,
  body?: unknown,
): Promise<Response> {
  return forwardToShogoCloud(c, {
    pathname,
    search: new URL(c.req.url).search,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

interface ProjectAuthz {
  ok: boolean
  status: number
  message?: string
  /** Needed to meter the call; absent in tests and older call sites. */
  workspaceId?: string
}

/**
 * Test seam: the handlers read the project's authorization and default voice
 * through these so route tests do not need a seeded database.
 */
export interface VoiceMediaDeps {
  /** Authorize the caller against `projectId`. Defaults to `authorizeProject`. */
  authorize?: (
    c: Context,
    projectId: string,
    permission: VoiceOpPermission,
  ) => Promise<ProjectAuthz>
  /** Resolve the project's default voice id. Defaults to ProjectAgent → env. */
  resolveVoiceId?: (projectId: string) => Promise<string>
  /**
   * Plan gate seam. Called with a row's `planGate`; returning `false` is a
   * 402. Unset means every row is available on every plan, which matches
   * today's behaviour — no row declares a gate yet.
   */
  planGate?: (c: Context, gate: string) => Promise<boolean>
  /**
   * Usage meter seam. Defaults to `consumeUsage` with a zero price — the row
   * records `{ opId, unit, units }`, so pricing an op later is a price lookup,
   * not a new route.
   */
  recordUsage?: (params: {
    c: Context
    projectId: string
    workspaceId?: string
    op: VoiceOp
    units: number
    /** Extra fields for the usage row (e.g. which provider rendered it). */
    metadata?: Record<string, unknown>
  }) => Promise<void>
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

async function defaultAuthorize(
  c: Context,
  projectId: string,
  permission: VoiceOpPermission,
): Promise<ProjectAuthz> {
  const result = await authorizeProject(c, projectId, permission)
  if (result.ok) return { ok: true, status: 200, workspaceId: result.workspaceId }
  return { ok: false, status: result.status, message: result.message }
}

/** Best-effort usage row. Never fails the request. */
async function defaultRecordUsage(params: {
  c: Context
  projectId: string
  workspaceId?: string
  op: VoiceOp
  units: number
  metadata?: Record<string, unknown>
}): Promise<void> {
  const { op, units, workspaceId, projectId, metadata } = params
  if (!workspaceId) return
  try {
    await consumeUsage({
      workspaceId,
      projectId,
      memberId: 'voice-media',
      actionType: 'voice_media_usage',
      // Priced at zero until an op has a per-unit price: the row exists so
      // pooled-key consumption is visible, not so it is charged twice.
      billedUsd: 0,
      rawUsd: 0,
      actionMetadata: {
        opId: op.id,
        unit: op.cost?.unit ?? 'request',
        units,
        ...(metadata ?? {}),
      },
    })
  } catch (e) {
    console.warn('[Voice] failed to record usage:', e instanceof Error ? e.message : e)
  }
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

/** A request body handed to the executor. */
interface VoiceOpInvocation {
  /** The caller's validated fields — exactly what a cloud forward should see. */
  fields: Record<string, unknown>
  /** A rebuilt multipart body, when the row's transport is multipart. */
  form?: FormData
  /**
   * Fields used for the upstream call when they differ from the caller's
   * (TTS preview text, resolved default voice). Never forwarded to cloud.
   */
  resolved?: Record<string, unknown>
  /**
   * `POST /voice/music` has always worked without `projectId` for
   * session-authenticated callers (Shogo's key pays either way); every other
   * hosted call must name its project.
   */
  allowUnscoped?: boolean
}

/**
 * The one executor. Every row goes through here; the only per-op decisions
 * left are the three rungs of {@link VoiceOp.call} (`textToSpeech`,
 * `composeMusic`, or the generic `request()` passthrough).
 */
async function executeVoiceOp(
  c: Context,
  op: VoiceOp,
  invocation: VoiceOpInvocation,
  deps: VoiceMediaDeps,
): Promise<Response> {
  const projectId = resolveProjectId(c)
  const scopeViolation = runtimeScopeViolation(c, projectId)
  if (scopeViolation) return scopeViolation
  if (!projectId && !invocation.allowUnscoped) {
    return c.json(
      {
        error: 'bad_request',
        detail: 'projectId is required (query param) for hosted voice media',
      },
      400,
    )
  }

  let authz: ProjectAuthz = { ok: true, status: 200 }
  if (projectId) {
    const authorize = deps.authorize ?? defaultAuthorize
    authz = await authorize(c, projectId, op.permission)
    if (!authz.ok) {
      return c.json({ error: 'forbidden', detail: authz.message }, authz.status as 400 | 401 | 403 | 404)
    }
  }

  if (op.planGate && deps.planGate) {
    const allowed = await deps.planGate(c, op.planGate)
    if (!allowed) {
      return c.json(
        { error: 'plan_required', detail: `${op.id} needs the ${op.planGate} plan feature` },
        402,
      )
    }
  }

  // A row that may never run on the pooled key stops here — before any spend.
  const credentialError = voiceOpCredentialError(op, 'pooled')
  if (credentialError) {
    return c.json({ error: credentialError.error, detail: credentialError.detail }, 403)
  }

  const callFields = { ...invocation.fields, ...(invocation.resolved ?? {}) }

  // Music is the one op with a second provider. `provider: 'google'` asks for
  // Lyria, which rides the Google key instead of the pooled ElevenLabs one.
  const music = resolveMusicRequest(op, callFields)
  if ('error' in music) {
    return c.json(
      {
        error: music.error,
        detail: music.detail,
        ...(music.allowed ? { allowed: music.allowed } : {}),
      },
      400,
    )
  }

  if (isShogoCloudForwarding()) {
    // JSON bodies were already validated above, so re-serialize them; a
    // multipart body is streamed through untouched (it is single-use).
    return forwardVoiceToCloud(
      c,
      voiceOpForwardPath(op),
      invocation.form ? undefined : invocation.fields,
    )
  }

  // A requested-but-missing Google key is a fallback, not a failure: the
  // caller still gets music, and the response says which provider rendered it.
  let provider: 'elevenlabs' | 'google' = 'elevenlabs'
  let googleModel: MusicModelEntry | undefined
  let fallbackReason: string | undefined
  if (music.google) {
    if (getNativeProviderApiKeySync('google')) {
      provider = 'google'
      googleModel = music.entry
    } else {
      fallbackReason =
        'no Google API key is configured on this server, so provider google fell back to ElevenLabs Music'
    }
  }

  let elevenLabs: { client: ElevenLabsClient } | undefined
  if (provider === 'elevenlabs') {
    const resolved = resolveShogoElevenLabsClient()
    if ('error' in resolved) {
      return c.json({ error: 'voice_unavailable', detail: resolved.error }, 503)
    }
    elevenLabs = resolved
  }

  const pathParams = voiceOpPathParams(
    op,
    callFields,
    new URL(c.req.url).searchParams,
  )
  if (op.defaultVoiceId && !pathParams.voiceId) {
    pathParams.voiceId = projectId
      ? await (deps.resolveVoiceId ?? defaultResolveVoiceId)(projectId)
      : DEFAULT_PROJECT_AGENT_VOICE_ID
  }
  const upstreamPath = voiceOpUpstreamPath(op, pathParams)
  if (typeof upstreamPath !== 'string') {
    return c.json({ error: 'bad_request', detail: upstreamPath.error }, 400)
  }

  const errorLabel = op.errorLabel ?? `${op.id} failed`
  const recordUsage = deps.recordUsage ?? defaultRecordUsage
  const lyriaMeter = provider === 'google' && googleModel ? lyriaUnits(op, googleModel) : undefined
  const units = lyriaMeter
    ? lyriaMeter.units
    : op.cost
      ? measureUnits(op, callFields, invocation.form)
      : 0

  try {
    let response: Response

    if (provider === 'google' && googleModel) {
      response = await renderLyria(googleModel, callFields)
    } else if (op.call === 'textToSpeech') {
      const modelId =
        typeof callFields.modelId === 'string'
          ? callFields.modelId
          : (op.defaultModel ?? DEFAULT_HOSTED_TTS_MODEL)
      const model = getVoiceTtsModel(modelId)
      const text = typeof callFields.text === 'string' ? callFields.text : ''
      if (model && text.length > model.maxChars) {
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
      const voiceSettings =
        normalizeVoiceSettings(callFields.voiceSettings) ?? {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0,
        }
      const result = await elevenLabs!.client.textToSpeech({
        voiceId: pathParams.voiceId ?? '',
        text,
        modelId,
        voiceSettings,
      })
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
      response = new Response(result.audio, { status: 200, headers })
    } else if (op.call === 'composeMusic') {
      const { audio, contentType } = await elevenLabs!.client.composeMusic({
        ...(typeof callFields.prompt === 'string' ? { prompt: callFields.prompt } : {}),
        ...(callFields.compositionPlan
          ? { compositionPlan: callFields.compositionPlan as Record<string, unknown> }
          : {}),
        ...(typeof callFields.musicLengthMs === 'number'
          ? { musicLengthMs: callFields.musicLengthMs }
          : {}),
        ...(typeof callFields.modelId === 'string' ? { modelId: callFields.modelId } : {}),
        ...(typeof callFields.forceInstrumental === 'boolean'
          ? { forceInstrumental: callFields.forceInstrumental }
          : {}),
        ...(typeof callFields.outputFormat === 'string'
          ? { outputFormat: callFields.outputFormat }
          : {}),
      })
      response = new Response(audio, {
        status: 200,
        headers: {
          'content-type': contentType,
          'cache-control': 'private, max-age=3600',
          'x-music-provider': 'elevenlabs',
          ...(fallbackReason ? { warning: `199 - "${fallbackReason}"` } : {}),
        },
      })
    } else {
      const query: Record<string, string> = {}
      for (const key of op.queryForward ?? []) {
        const value = c.req.query(key)
        if (value) query[key] = value
      }
      const upstreamBody = voiceOpUpstreamBody(op, callFields)
      if (op.defaultModel && upstreamBody.model_id === undefined) {
        upstreamBody.model_id = op.defaultModel
      }
      const forwarded = await elevenLabs!.client.request({
        method: op.method,
        path: upstreamPath,
        ...(invocation.form
          ? { body: invocation.form }
          : op.method === 'GET'
            ? {}
            : { body: upstreamBody }),
        ...(Object.keys(query).length ? { query } : {}),
        ...(op.accept ? { accept: op.accept } : {}),
      })
      const headers: Record<string, string> = { 'content-type': forwarded.contentType }
      if (voiceOpReturnsAudio(op)) headers['cache-control'] = 'private, max-age=3600'
      response = new Response(forwarded.audio ?? JSON.stringify(forwarded.json ?? {}), {
        status: forwarded.status,
        headers,
      })
    }

    if (units > 0 && projectId) {
      await recordUsage({
        c,
        projectId,
        ...(authz.workspaceId ? { workspaceId: authz.workspaceId } : {}),
        op,
        units,
        ...(provider === 'google' && googleModel
          ? {
              metadata: {
                provider: 'google',
                model: googleModel.id,
                ...(lyriaMeter?.estimated ? { unitsEstimated: true } : {}),
              },
            }
          : {}),
      })
    }
    return response
  } catch (err: any) {
    console.error(`[Voice] ${errorLabel}:`, err?.message || err)
    const lyria = err instanceof LyriaError
    return c.json(
      {
        error: errorLabel,
        detail: err?.message ?? errorJson(err),
        ...(lyria ? { provider: 'google', googleStatus: err.status } : { elBody: err?.body ?? undefined }),
      },
      502,
    )
  }
}

/**
 * The units one request consumes, in the row's own unit. Characters for TTS,
 * seconds for generated audio, one per call for listings.
 */
function measureUnits(
  op: VoiceOp,
  fields: Record<string, unknown>,
  form: FormData | undefined,
): number {
  const unit = op.cost?.unit ?? 'request'
  if (unit === 'character') {
    return typeof fields.text === 'string' ? fields.text.length : 0
  }
  if (unit === 'second') {
    const seconds =
      typeof fields.durationSeconds === 'number'
        ? fields.durationSeconds
        : typeof fields.musicLengthMs === 'number'
          ? fields.musicLengthMs / 1000
          : undefined
    if (seconds !== undefined) return Math.max(1, Math.round(seconds))
    // Uploaded audio: estimate from the byte count at 128 kbps, which is
    // what the STS/Scribe models stream in.
    const bytes = form
      ? formByteSize(form)
      : 0
    return bytes > 0 ? Math.max(1, Math.round((bytes * 8) / 128_000)) : 0
  }
  return 1
}

/** The cheapest Lyria track; a full song is an explicit choice. */
const DEFAULT_LYRIA_MODEL = 'lyria-3-clip'
/** Metered seconds for a Lyria model whose track length the prompt controls. */
const ASSUMED_LYRIA_SECONDS = 30
const MUSIC_MODEL_IDS: readonly string[] = Object.keys(MUSIC_MODEL_CATALOG)

/**
 * Which provider renders this request. Music is the only op with a second one:
 * `provider: 'google'` means Lyria, anything else (including absent) stays on
 * ElevenLabs, so an existing caller's behaviour never changes by accident.
 */
function resolveMusicRequest(
  op: VoiceOp,
  fields: Record<string, unknown>,
):
  | { google: false }
  | { google: true; entry: MusicModelEntry }
  | { error: string; detail: string; allowed?: readonly string[] } {
  if (op.id !== 'music' || fields.provider !== 'google') return { google: false }
  const requested =
    typeof fields.model === 'string' && fields.model.trim() ? fields.model.trim() : DEFAULT_LYRIA_MODEL
  const entry = getMusicModelEntry(requested)
  if (!entry) {
    return {
      error: 'unknown_model',
      detail: `Unknown music model '${requested}'`,
      allowed: MUSIC_MODEL_IDS,
    }
  }
  return { google: true, entry }
}

/**
 * Lyria bills per track, not per requested length, so the metered seconds come
 * from the model itself — a clip is a fixed 30 s, a full song is whatever the
 * prompt produced. That is why `musicLengthMs` is rejected for this provider:
 * metering a length Lyria never received would be a usage row lying about what
 * was rendered. A model with no fixed duration meters an assumed track and says
 * so, rather than passing the assumption off as measured.
 */
function lyriaUnits(op: VoiceOp, entry: MusicModelEntry): { units: number; estimated: boolean } {
  if (!op.cost) return { units: 0, estimated: false }
  if (op.cost.unit !== 'second') return { units: 1, estimated: false }
  return entry.durationSeconds
    ? { units: Math.max(1, Math.round(entry.durationSeconds)), estimated: false }
    : { units: ASSUMED_LYRIA_SECONDS, estimated: true }
}

/**
 * Render one Lyria track and hand it back in the shape `/voice/music` has
 * always returned — raw audio bytes — so the app's player needs no change.
 */
async function renderLyria(entry: MusicModelEntry, fields: Record<string, unknown>): Promise<Response> {
  const apiKey = getNativeProviderApiKeySync('google')
  if (!apiKey) throw new Error('Google API key is no longer configured')
  const prompt = typeof fields.prompt === 'string' ? fields.prompt.trim() : ''
  const lyrics = typeof fields.lyrics === 'string' ? fields.lyrics.trim() : ''
  const { audio } = await generateLyriaMusic({
    apiKey,
    apiModel: entry.apiModel,
    prompt,
    ...(lyrics ? { lyrics } : {}),
    ...(fields.instrumental === true ? { instrumental: true } : {}),
  })
  if (!audio) throw new Error('Google returned no audio for this prompt.')
  return new Response(Buffer.from(audio.data, 'base64'), {
    status: 200,
    headers: {
      'content-type': audio.mimeType,
      'cache-control': 'private, max-age=3600',
      'x-music-provider': 'google',
      'x-music-model': entry.id,
    },
  })
}

/** Reject a body whose declared or actual size exceeds the row's limit. */
function tooLarge(c: Context, op: VoiceOp, size: number): Response {
  return c.json(
    {
      error: 'payload_too_large',
      detail: `${op.id} accepts at most ${op.maxBodyBytes} bytes; got ${size}`,
      maxBytes: op.maxBodyBytes,
      length: size,
    },
    413,
  )
}

/** The shape every registry parser returns when it is unhappy. */
interface VoiceOpRejection {
  status: number
  error: string
  detail?: string
  allowed?: readonly string[]
}

/** One error body for every media route: `{ error, detail?, allowed? }`. */
function rejectVoiceOp(c: Context, rejection: VoiceOpRejection): Response {
  return c.json(
    {
      error: rejection.error,
      ...(rejection.detail ? { detail: rejection.detail } : {}),
      ...(rejection.allowed ? { allowed: rejection.allowed } : {}),
    },
    rejection.status as 400 | 401 | 402 | 403 | 404 | 405 | 409 | 413 | 422,
  )
}

/** Bytes in a multipart body, without assuming which `FormData` impl we got. */
function formByteSize(form: FormData): number {
  let total = 0
  for (const value of form.values() as unknown as Iterable<unknown>) {
    if (typeof value === 'string') total += value.length
    else if (value && typeof (value as { size?: unknown }).size === 'number') {
      total += (value as { size: number }).size
    }
  }
  return total
}

/** Content-length gate, so an oversize upload is refused before it is read. */
function declaredTooLarge(c: Context, op: VoiceOp): Response | null {
  const raw = c.req.header('content-length')
  if (!raw) return null
  const size = Number(raw)
  if (Number.isFinite(size) && size > op.maxBodyBytes) return tooLarge(c, op, size)
  return null
}

/**
 * `GET|POST /api/voice/op/:opId` — any registry op. The registry supplies the
 * transport, the permission, the limits and the upstream path.
 */
export async function handleVoiceOp(
  c: Context,
  deps: VoiceMediaDeps = {},
): Promise<Response> {
  const opId = c.req.param('opId')
  const op = getVoiceOp(opId)
  if (!op) {
    return c.json(
      { error: 'unknown_op', detail: `Unknown voice op '${opId ?? ''}'`, allowed: VOICE_OP_IDS },
      404,
    )
  }
  if (c.req.method !== op.method) {
    return c.json({ error: 'Method Not Allowed', detail: `${op.id} is ${op.method}` }, 405)
  }

  const oversized = declaredTooLarge(c, op)
  if (oversized) return oversized

  if (op.method === 'GET') {
    return executeVoiceOp(c, op, { fields: {} }, deps)
  }

  if (op.transport === 'multipart-binary' || op.transport === 'multipart-json') {
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return c.json(
        { error: 'bad_request', detail: 'send a multipart/form-data body' },
        400,
      )
    }
    const parsed = parseVoiceOpForm(op, form)
    if (!parsed.ok) {
      return rejectVoiceOp(c, parsed)
    }
    const size = formByteSize(parsed.form)
    if (size > op.maxBodyBytes) return tooLarge(c, op, size)
    // `fields` carries the path params (`voiceId` on speech-to-speech), which
    // the rebuilt form deliberately drops — without them the request silently
    // converts to the project default voice.
    return executeVoiceOp(c, op, { fields: parsed.fields, form: parsed.form }, deps)
  }

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = parseVoiceOpJsonBody(op, raw)
  if (!parsed.ok) {
    return rejectVoiceOp(c, parsed)
  }
  const size = JSON.stringify(parsed.fields).length
  if (size > op.maxBodyBytes) return tooLarge(c, op, size)
  return executeVoiceOp(c, op, { fields: parsed.fields }, deps)
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
 * {@link DEFAULT_HOSTED_TTS_MODEL}. When `text` is empty a short preview line
 * is built from `audioTags` (same helper the SDK's tts-preview uses).
 *
 * A thin alias: the body keeps its original shape and errors, then the shared
 * {@link executeVoiceOp} does auth, limits, credentials, metering and the call.
 */
export async function handleVoiceTts(
  c: Context,
  deps: VoiceMediaDeps = {},
): Promise<Response> {
  const op = getVoiceOp('text-to-speech')!
  const oversized = declaredTooLarge(c, op)
  if (oversized) return oversized

  let body: VoiceTtsBody
  try {
    body = (await c.req.json()) as VoiceTtsBody
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // The alias's own nicety runs *before* the row's required-field check: a
  // body of only `audioTags` is a preview request, and the line it builds is
  // the `text` the row requires. `/voice/op/text-to-speech` itself has no
  // audioTags handling, so it keeps requiring `text`.
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

  const requestedModel =
    typeof body.modelId === 'string' && body.modelId.length > 0 ? body.modelId : undefined
  const parsed = parseVoiceOpJsonBody(op, {
    text,
    ...(typeof body.voiceId === 'string' ? { voiceId: body.voiceId } : {}),
    ...(requestedModel ? { modelId: requestedModel } : {}),
    ...(body.voiceSettings ? { voiceSettings: body.voiceSettings } : {}),
  })
  if (!parsed.ok) {
    return rejectVoiceOp(c, parsed)
  }

  return executeVoiceOp(
    c,
    op,
    { fields: parsed.fields, resolved: { text } },
    deps,
  )
}

/** Body shape for `POST /voice/music`. */
export interface VoiceMusicBody {
  prompt?: string
  compositionPlan?: Record<string, unknown>
  musicLengthMs?: number
  modelId?: string
  forceInstrumental?: boolean
  outputFormat?: string
  /** Music provider; ElevenLabs unless `google` (Lyria) is asked for. */
  provider?: string
  /** Lyria catalog id (`lyria-3-clip`, `lyria-3.5`); Google only. */
  model?: string
  /** Custom lyrics read by Lyria; Google only. */
  lyrics?: string
  /** Instrumental-only track; Google only. */
  instrumental?: boolean
}

/**
 * `POST /api/voice/music` — music generation, ElevenLabs Music by default and
 * Google's Lyria when the caller asks for `provider: 'google'`.
 *
 * `projectId` is optional for back-compat with session callers, but when it
 * is present the caller is authorized against it (runtime tokens must match).
 * A thin alias onto the `music` registry row, like {@link handleVoiceTts}.
 */
export async function handleVoiceMusic(
  c: Context,
  deps: VoiceMediaDeps = {},
): Promise<Response> {
  const op = getVoiceOp('music')!
  const oversized = declaredTooLarge(c, op)
  if (oversized) return oversized

  let body: VoiceMusicBody
  try {
    body = (await c.req.json()) as VoiceMusicBody
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = parseVoiceOpJsonBody(op, {
    ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
    ...(body.compositionPlan != null ? { compositionPlan: body.compositionPlan } : {}),
    ...(typeof body.musicLengthMs === 'number' ? { musicLengthMs: body.musicLengthMs } : {}),
    ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
    ...(typeof body.forceInstrumental === 'boolean'
      ? { forceInstrumental: body.forceInstrumental }
      : {}),
    ...(typeof body.outputFormat === 'string' ? { outputFormat: body.outputFormat } : {}),
    ...(body.provider !== undefined ? { provider: body.provider } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.lyrics !== undefined ? { lyrics: body.lyrics } : {}),
    ...(body.instrumental !== undefined ? { instrumental: body.instrumental } : {}),
  })
  if (!parsed.ok) {
    return rejectVoiceOp(c, parsed)
  }

  return executeVoiceOp(c, op, { fields: parsed.fields, allowUnscoped: true }, deps)
}

/**
 * Hono router for the hosted media endpoints. Mount it unconditionally in
 * `apps/api/src/server.ts` so `/api/voice/op/*` exists in cloud *and* desktop.
 */
export function voiceMediaRoutes(deps: VoiceMediaDeps = {}) {
  const router = new Hono()
  router.use('/voice/*', apiKeyOrSession)
  router.post('/voice/tts', (c) => handleVoiceTts(c, deps))
  router.post('/voice/music', (c) => handleVoiceMusic(c, deps))
  router.get('/voice/op/:opId', (c) => handleVoiceOp(c, deps))
  router.post('/voice/op/:opId', (c) => handleVoiceOp(c, deps))
  return router
}
