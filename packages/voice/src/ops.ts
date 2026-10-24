// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The voice op registry.
 *
 * Every ElevenLabs media endpoint we expose is one row here: its upstream
 * path, its transport, who may call it, how big a body it may take, and what
 * it costs. Route handlers, proxy handlers and the SDK all read this table
 * instead of being hand-written per endpoint — adding an op is a row and a
 * test, never a new route file.
 *
 * Three consumers:
 *   - `@shogo-ai/sdk/voice/server` (`handlers.op`) — BYO mode + proxy mode
 *   - `@shogo-ai/sdk/voice/route/op` — the drop-in route modules
 *   - `apps/api/src/routes/voice-media.ts` — the hosted `/api/voice/op/:opId`
 *
 * Deliberately free of Node and DOM-only APIs: this module is imported by
 * the browser-safe entry point.
 */

import {
  CONVAI_TTS_MODEL_FALLBACK,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_SOUND_GENERATION_MODEL,
  DEFAULT_SPEECH_TO_TEXT_MODEL,
  DEFAULT_STS_MODEL,
  VOICE_SOUND_GENERATION_MODEL_IDS,
  VOICE_SPEECH_TO_TEXT_MODEL_IDS,
  VOICE_STS_MODEL_IDS,
  VOICE_TTS_MODEL_IDS,
} from './elevenlabs.js'

/**
 * How a request body travels in and a response body travels out:
 *   - `json-binary`      JSON in, audio bytes out (TTS, music, sound effects)
 *   - `json-json`        JSON in, JSON out (TTS with timestamps, listings)
 *   - `multipart-binary` multipart in, audio bytes out (speech-to-speech)
 *   - `multipart-json`   multipart in, JSON out (speech-to-text)
 *
 * The adapters live next to the executor; a row only names its transport.
 */
export type VoiceOpTransport = 'json-binary' | 'json-json' | 'multipart-binary' | 'multipart-json'

/**
 * Project permission the caller needs. Kept as a literal union rather than an
 * import from `@shogo/authz` so this package stays free of server deps; the
 * hosted route widens it to `Permission` where it authorizes.
 */
export type VoiceOpPermission = 'project:read' | 'project:update'

/** What one unit of an op's cost is measured in. */
export type VoiceOpCostUnit = 'character' | 'second' | 'request'

export interface VoiceOpCost {
  /** Metering unit. */
  unit: VoiceOpCostUnit
  /** How many units one `character` / `second` / `request` is worth. */
  per: number
}

export interface VoiceOp {
  id: string
  method: 'GET' | 'POST'
  /** Canonical hosted path: `/voice/op/<id>`. */
  hostedPath: `/voice/${string}`
  /**
   * A path a shipped client already calls. Proxy mode forwards here instead
   * of {@link hostedPath} so an SDK upgrade never breaks a running pod.
   */
  legacyHostedPath?: `/voice/${string}`
  /** Upstream ElevenLabs path, `{name}` filled from {@link pathParams}. */
  upstreamPath: string
  /** Path params the caller supplies (body field or query param). */
  pathParams?: readonly string[]
  transport: VoiceOpTransport
  permission: VoiceOpPermission
  /** Plan gate name, when the op is not on every plan. */
  planGate?: string
  /** Request body cap; larger → 413. */
  maxBodyBytes: number
  /**
   * Metering unit. A row without `cost` must be `byoOnly` — you cannot add an
   * op without deciding who pays for it.
   */
  cost?: VoiceOpCost
  /**
   * Never runs on Shogo's pooled key (cloning, dubbing — they write state onto
   * the account and need a per-project voice registry).
   */
  byoOnly?: boolean
  /**
   * Use a typed {@link ElevenLabsClient} method instead of the generic
   * `request()` passthrough. Only the ops that need model fallback (TTS) or
   * body composition (music) set this.
   */
  call?: 'textToSpeech' | 'composeMusic'
  /** Accepted model ids; an unknown one is a 400, never a silent clamp. */
  models?: readonly string[]
  /** Model used for the upstream call when the caller sends none. */
  defaultModel?: string
  /** Fall back to the project's default agent voice when none is given. */
  defaultVoiceId?: boolean
  /** Caller field → upstream field. Anything absent here is not forwarded. */
  forward?: Readonly<Record<string, string>>
  /** Caller fields that must be present (before mapping). */
  required?: readonly string[]
  /** Query params forwarded upstream. */
  queryForward?: readonly string[]
  /** Upstream response headers worth passing through. */
  responseHeaders?: readonly string[]
  /** `Accept` sent upstream (and used when ElevenLabs sends no content-type). */
  accept?: string
  /** Error label for an upstream failure; defaults to `${id} failed`. */
  errorLabel?: string
  /**
   * Extra body check the declarative fields cannot express (e.g. music's
   * prompt XOR compositionPlan). Returns an error message or `null`.
   */
  validate?: (fields: Record<string, unknown>) => string | null
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024
const MAX_TEXT_BYTES = 256 * 1024

/**
 * The registry. Order is the order unknown-op errors list ids in.
 *
 * `as const satisfies` is what makes an op cost exactly one row: the ids are
 * derived from the table ({@link VoiceOpId}, {@link VOICE_OP_IDS}) instead of
 * being listed a second time, while `satisfies` still type-checks every field.
 */
export const VOICE_OPS = [
  {
    id: 'text-to-speech',
    method: 'POST',
    hostedPath: '/voice/op/text-to-speech',
    legacyHostedPath: '/voice/tts',
    upstreamPath: '/v1/text-to-speech/{voiceId}',
    pathParams: ['voiceId'],
    transport: 'json-binary',
    call: 'textToSpeech',
    permission: 'project:read',
    maxBodyBytes: MAX_TEXT_BYTES,
    cost: { unit: 'character', per: 1 },
    models: VOICE_TTS_MODEL_IDS,
    defaultModel: CONVAI_TTS_MODEL_FALLBACK,
    defaultVoiceId: true,
    forward: {
      text: 'text',
      voiceId: 'voice_id',
      modelId: 'model_id',
      voiceSettings: 'voice_settings',
    },
    required: ['text'],
    responseHeaders: ['x-tts-model-used', 'x-tts-model-requested', 'warning'],
    accept: 'audio/mpeg',
    errorLabel: 'TTS failed',
  },
  {
    id: 'text-to-speech-with-timestamps',
    method: 'POST',
    hostedPath: '/voice/op/text-to-speech-with-timestamps',
    upstreamPath: '/v1/text-to-speech/{voiceId}/with-timestamps',
    pathParams: ['voiceId'],
    transport: 'json-json',
    permission: 'project:read',
    maxBodyBytes: MAX_TEXT_BYTES,
    cost: { unit: 'character', per: 1 },
    models: VOICE_TTS_MODEL_IDS,
    defaultModel: CONVAI_TTS_MODEL_FALLBACK,
    defaultVoiceId: true,
    forward: {
      text: 'text',
      voiceId: 'voice_id',
      modelId: 'model_id',
      voiceSettings: 'voice_settings',
      outputFormat: 'output_format',
    },
    required: ['text'],
    accept: 'application/json',
  },
  {
    id: 'speech-to-speech',
    method: 'POST',
    hostedPath: '/voice/op/speech-to-speech',
    upstreamPath: '/v1/speech-to-speech/{voiceId}',
    pathParams: ['voiceId'],
    transport: 'multipart-binary',
    permission: 'project:read',
    maxBodyBytes: MAX_AUDIO_BYTES,
    cost: { unit: 'second', per: 1 },
    models: VOICE_STS_MODEL_IDS,
    defaultModel: DEFAULT_STS_MODEL,
    defaultVoiceId: true,
    forward: {
      audio: 'audio',
      voiceId: 'voice_id',
      modelId: 'model_id',
      voiceSettings: 'voice_settings',
      outputFormat: 'output_format',
      fileFormat: 'file_format',
      seed: 'seed',
      removeBackgroundNoise: 'remove_background_noise',
    },
    required: ['audio'],
    accept: 'audio/mpeg',
  },
  {
    id: 'speech-to-text',
    method: 'POST',
    hostedPath: '/voice/op/speech-to-text',
    upstreamPath: '/v1/speech-to-text',
    transport: 'multipart-json',
    permission: 'project:read',
    maxBodyBytes: MAX_AUDIO_BYTES,
    cost: { unit: 'second', per: 1 },
    models: VOICE_SPEECH_TO_TEXT_MODEL_IDS,
    defaultModel: DEFAULT_SPEECH_TO_TEXT_MODEL,
    forward: {
      file: 'file',
      modelId: 'model_id',
      languageCode: 'language_code',
      diarize: 'diarize',
      tagAudioEvents: 'tag_audio_events',
      numSpeakers: 'num_speakers',
    },
    required: ['file'],
    accept: 'application/json',
  },
  {
    id: 'sound-generation',
    method: 'POST',
    hostedPath: '/voice/op/sound-generation',
    upstreamPath: '/v1/sound-generation',
    transport: 'json-binary',
    permission: 'project:read',
    maxBodyBytes: MAX_JSON_BYTES,
    cost: { unit: 'second', per: 1 },
    models: VOICE_SOUND_GENERATION_MODEL_IDS,
    defaultModel: DEFAULT_SOUND_GENERATION_MODEL,
    forward: {
      text: 'text',
      durationSeconds: 'duration_seconds',
      promptInfluence: 'prompt_influence',
      loop: 'loop',
      modelId: 'model_id',
    },
    // `output_format` is a query param on this endpoint, not a body field — the
    // typed `soundEffects()` client sends it there, and a body field is
    // silently ignored upstream.
    queryForward: ['output_format'],
    required: ['text'],
    accept: 'audio/mpeg',
  },
  {
    id: 'music',
    method: 'POST',
    hostedPath: '/voice/op/music',
    legacyHostedPath: '/voice/music',
    upstreamPath: '/v1/music',
    transport: 'json-binary',
    call: 'composeMusic',
    permission: 'project:read',
    maxBodyBytes: MAX_JSON_BYTES,
    cost: { unit: 'second', per: 1 },
    models: [DEFAULT_MUSIC_MODEL],
    defaultModel: DEFAULT_MUSIC_MODEL,
    forward: {
      prompt: 'prompt',
      compositionPlan: 'composition_plan',
      musicLengthMs: 'music_length_ms',
      modelId: 'model_id',
      forceInstrumental: 'force_instrumental',
      outputFormat: 'output_format',
    },
    accept: 'audio/mpeg',
    errorLabel: 'Music generation failed',
    validate: (fields) => {
      const hasPrompt = typeof fields.prompt === 'string' && fields.prompt.trim().length > 0
      const hasPlan = fields.compositionPlan != null && typeof fields.compositionPlan === 'object'
      return hasPrompt === hasPlan ? 'Provide exactly one of `prompt` or `compositionPlan`' : null
    },
  },
  {
    id: 'voices',
    method: 'GET',
    hostedPath: '/voice/op/voices',
    upstreamPath: '/v1/voices',
    transport: 'json-json',
    permission: 'project:read',
    maxBodyBytes: 0,
    cost: { unit: 'request', per: 1 },
    queryForward: ['page_size', 'search', 'voice_type', 'category', 'next_page_token'],
    accept: 'application/json',
  },
  {
    id: 'models',
    method: 'GET',
    hostedPath: '/voice/op/models',
    upstreamPath: '/v1/models',
    transport: 'json-json',
    permission: 'project:read',
    maxBodyBytes: 0,
    cost: { unit: 'request', per: 1 },
    accept: 'application/json',
  },
] as const satisfies readonly VoiceOp[]

/** Every op id, in registry order. */
export const VOICE_OP_IDS: readonly string[] = VOICE_OPS.map((op) => op.id)

/** The literal union of registry ids. */
export type VoiceOpId = (typeof VOICE_OPS)[number]['id']

/** Look up a row by id. */
export function getVoiceOp(id: string | null | undefined): VoiceOp | undefined {
  if (!id) return undefined
  return VOICE_OPS.find((op) => op.id === id)
}

/**
 * The hosted path a client should call for this op. Proxy mode uses
 * {@link VoiceOp.legacyHostedPath} when a client may already be pinned to it.
 */
export function voiceOpForwardPath(op: VoiceOp): string {
  return op.legacyHostedPath ?? op.hostedPath
}

/** Which body adapter a row uses. */
export function voiceOpIsMultipart(op: VoiceOp): boolean {
  return op.transport === 'multipart-binary' || op.transport === 'multipart-json'
}

/** Whether the op's response is audio bytes. */
export function voiceOpReturnsAudio(op: VoiceOp): boolean {
  return op.transport === 'json-binary' || op.transport === 'multipart-binary'
}

/** Fill `{param}` placeholders in {@link VoiceOp.upstreamPath}. */
export function voiceOpUpstreamPath(
  op: VoiceOp,
  params: Readonly<Record<string, string>>,
): string | { error: string } {
  let path = op.upstreamPath
  for (const name of op.pathParams ?? []) {
    const value = params[name]
    if (!value) {
      return { error: `Missing \`${name}\` (required path parameter for ${op.id})` }
    }
    path = path.split(`{${name}}`).join(encodeURIComponent(value))
  }
  return path
}

/**
 * Reject a caller who has no key for this op. A `byoOnly` row never runs on
 * the pooled key; `credential` says which key the request would have used.
 */
export function voiceOpCredentialError(
  op: VoiceOp,
  credential: 'pooled' | 'byo',
): { status: number; error: string; detail: string } | null {
  if (op.byoOnly && credential === 'pooled') {
    return {
      status: 403,
      error: 'byo_key_required',
      detail: `${op.id} runs on your own ElevenLabs key, not Shogo's pooled key — pass it to ElevenLabsClient and call request() directly`,
    }
  }
  return null
}

/** The caller field that carries the model id. */
const MODEL_FIELD = 'modelId'

/**
 * Validate + normalize a JSON body against a row: whitelist `forward`, check
 * `required`, resolve the model, run the row's own `validate`.
 *
 * Returns the **caller-shaped** fields (camelCase), not the upstream body —
 * mapping happens in {@link voiceOpUpstreamBody}.
 */
export function parseVoiceOpJsonBody(
  op: VoiceOp,
  raw: unknown,
): { ok: true; fields: Record<string, unknown> } | { ok: false; status: number; error: string; detail?: string; allowed?: readonly string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'Invalid JSON body' }
  }
  const body = raw as Record<string, unknown>
  const fields: Record<string, unknown> = {}
  for (const [callerField, upstreamField] of Object.entries(op.forward ?? {})) {
    if (upstreamField && body[callerField] !== undefined) fields[callerField] = body[callerField]
  }
  for (const name of op.required ?? []) {
    const value = fields[name]
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      return { ok: false, status: 400, error: `Missing \`${name}\`` }
    }
  }
  const modelCheck = checkVoiceOpModel(op, fields)
  if ('error' in modelCheck) return { ok: false, status: 400, ...modelCheck }
  if (op.validate) {
    const message = op.validate(fields)
    if (message) return { ok: false, status: 400, error: message }
  }
  return { ok: true, fields }
}

/**
 * Validate + normalize a multipart body: the same whitelist/required rules,
 * plus a `File` check on every required part (an `audio` part that is really
 * a text field is the caller's bug, not ElevenLabs').
 *
 * `fields` carries the caller-shaped values the parser read — the path params
 * among them. They are dropped from the rebuilt form (repeating them makes
 * ElevenLabs reject the upload), so this is the only way a `voiceId` form part
 * reaches {@link voiceOpPathParams}; ignoring it would send the request to
 * the project default voice and come back 200 with the wrong voice.
 */
export function parseVoiceOpForm(
  op: VoiceOp,
  form: FormData,
): { ok: true; form: FormData; fields: Record<string, unknown> } | { ok: false; status: number; error: string; detail?: string; allowed?: readonly string[] } {
  const fields: Record<string, unknown> = {}
  for (const callerField of Object.keys(op.forward ?? {})) {
    const value = form.get(callerField)
    if (value !== null) fields[callerField] = value
  }
  for (const name of op.required ?? []) {
    const value = fields[name]
    if (!(value instanceof Blob)) {
      return {
        ok: false,
        status: 400,
        error: `Missing \`${name}\` file part`,
        detail:
          value === undefined
            ? `send a multipart body with a \`${name}\` file part`
            : `\`${name}\` must be a file part, not a text field`,
      }
    }
    if (value.size === 0) {
      return { ok: false, status: 400, error: `Empty \`${name}\` file part` }
    }
  }
  const modelCheck = checkVoiceOpModel(op, fields)
  if ('error' in modelCheck) return { ok: false, status: 400, ...modelCheck }

  const forward = op.forward ?? {}
  const pathParams = new Set(op.pathParams ?? [])
  const out = new FormData()
  for (const [callerField, upstreamField] of Object.entries(forward)) {
    // Path params travel in the URL; repeating them as multipart parts makes
    // ElevenLabs reject the upload as a schema mismatch.
    if (pathParams.has(callerField)) continue
    const value = fields[callerField]
    if (value === undefined || value === null || value === '') continue
    if (value instanceof Blob) {
      const name = value instanceof File ? value.name : callerField
      out.set(upstreamField, value, name)
    } else if (typeof value === 'string') {
      out.set(upstreamField, value)
    } else {
      out.set(upstreamField, JSON.stringify(value))
    }
  }
  // Multipart ops need their model as a form part, not just a default at the
  // call site: the upload is the body, so there is nowhere else to put it.
  const modelField = forward[MODEL_FIELD]
  if (op.defaultModel && modelField && out.get(modelField) === null) {
    out.set(modelField, op.defaultModel)
  }
  return { ok: true, form: out, fields }
}

/**
 * Map caller fields onto the upstream JSON body (camelCase → snake_case) and
 * drop the path params, which travel in the URL.
 */
export function voiceOpUpstreamBody(
  op: VoiceOp,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const pathParams = new Set(op.pathParams ?? [])
  const body: Record<string, unknown> = {}
  for (const [callerField, upstreamField] of Object.entries(op.forward ?? {})) {
    if (pathParams.has(callerField)) continue
    const value = fields[callerField]
    if (value === undefined || value === null) continue
    body[upstreamField] = value
  }
  return body
}

/** Path params for a row, taken from the body first and the query second. */
export function voiceOpPathParams(
  op: VoiceOp,
  fields: Readonly<Record<string, unknown>>,
  query: { get(name: string): string | null },
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of op.pathParams ?? []) {
    const fromBody = fields[name]
    const value =
      typeof fromBody === 'string' && fromBody.length > 0 ? fromBody : query.get(name)
    if (value) out[name] = value
  }
  return out
}

/**
 * Resolve the model for a row: an unknown caller model is a 400 with the
 * allowed list; an absent one gets `defaultModel`.
 */
function checkVoiceOpModel(
  op: VoiceOp,
  fields: Record<string, unknown>,
): { ok: true } | { error: string; detail?: string; allowed?: readonly string[] } {
  const requested = fields[MODEL_FIELD]
  // An absent model is not rewritten here: the caller's body stays exactly
  // what they sent, and the executor applies `op.defaultModel` at the call.
  if (requested === undefined || requested === null || requested === '') return { ok: true }
  if (typeof requested !== 'string') {
    return { error: `\`${MODEL_FIELD}\` must be a string` }
  }
  if (op.models && !op.models.includes(requested)) {
    return {
      error: 'unknown_model',
      detail: `Unknown model '${requested}' for ${op.id}`,
      allowed: op.models,
    }
  }
  return { ok: true }
}
