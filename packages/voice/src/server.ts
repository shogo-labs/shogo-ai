// SPDX-License-Identifier: MIT
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
 *
 * Drop-in route handlers
 * ----------------------
 * For Web-Standard routers that dispatch by HTTP method export
 * (Expo Router `+api.ts`, Next.js App Router `route.ts`, Cloudflare
 * Workers, Bun.serve), use the `@shogo-ai/sdk/voice/route/*`
 * sub-modules instead — they re-export pre-instantiated `GET`/
 * `POST`/`PATCH`/`DELETE` so each route file is a one-line
 * re-export. See {@link ./route/index.ts}.
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
  DEFAULT_TTS_MODEL,
  ElevenLabsApiError,
  ElevenLabsClient,
  MEMORY_CLIENT_TOOLS,
  resolveConvaiTtsModel,
  type ComposeMusicParams,
  type ConvaiClientTool,
  type ElevenLabsClientConfig,
  type SoundEffectsParams,
  type SpeechToSpeechParams,
  type TextToSpeechParams,
  type TextToSpeechResult,
  type TranscribeParams,
  type TranscriptionResult,
} from './elevenlabs.js'
import {
  VOICE_OP_IDS,
  getVoiceOp,
  parseVoiceOpForm,
  parseVoiceOpJsonBody,
  voiceOpCredentialError,
  voiceOpForwardPath,
  voiceOpPathParams,
  voiceOpReturnsAudio,
  voiceOpUpstreamBody,
  voiceOpUpstreamPath,
  type VoiceOp,
} from './ops.js'
import { extractBasePrompt } from './prompt.js'
import { readRuntimeAuthSecret } from './runtime-token.js'
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

/**
 * Runtime-token proxy options. When `createVoiceHandlers()` detects
 * these (either passed explicitly or auto-detected from env), the
 * returned handlers become a thin pass-through to the Shogo API and do
 * NOT require `apiKey` / `getUser` / `companionStore`.
 *
 * Auto-detection looks for:
 *   - `process.env.RUNTIME_AUTH_SECRET` (pod-injected runtime token)
 *   - `process.env.PROJECT_ID` (pod-injected project scope)
 *   - `process.env.SHOGO_API_URL` (falls back to `SHOGO_CLOUD_URL`)
 *
 * The API host is resolved per request, not at construction, so a pod
 * that sets the token without a host still gets every local-only
 * handler (body validation, 405s, the static audio-tags catalog) and
 * only the call that actually leaves the process refuses to guess.
 */
export interface VoiceProxyOptions {
  runtimeToken: string
  projectId: string
  /**
   * Base URL of the Shogo API. Empty string when the proxy was derived
   * from env: the host is then re-read from `SHOGO_API_URL` /
   * `SHOGO_CLOUD_URL` on each proxied call.
   */
  apiUrl: string
  /** Custom fetch impl (forwarded to the proxy fetches). */
  fetch?: typeof fetch
}

/**
 * How the handlers should reach ElevenLabs:
 *   - `'byo'`   — always use the supplied `apiKey`, even inside a pod
 *   - `'proxy'` — always go through the Shogo API with the runtime token
 *   - `'auto'`  — (default) an explicit `apiKey` wins, otherwise use the
 *                 ambient pod runtime token when present
 */
export type VoiceHandlerMode = 'proxy' | 'byo' | 'auto'

export interface VoiceHandlersConfig {
  /**
   * 11Labs API key. Required in BYO-EL mode; ignored / optional when
   * runtime-token proxy mode is active (explicit `proxy` or env detection).
   */
  apiKey?: string
  /**
   * Resolve the authenticated user from a request, or `null` for
   * unauthenticated. Required for the user-scoped handlers (`signedUrl`,
   * `agent.*`); optional for `tts` / `music`, which are project-scoped and
   * work without a user context.
   */
  getUser?: GetVoiceUser
  /**
   * Consumer-owned persistence layer for Companion records. Required for
   * the user-scoped handlers (`signedUrl`, `agent.*`); unused by `tts` /
   * `music` and by proxy mode.
   */
  companionStore?: CompanionStore
  /**
   * Force a transport: `'byo'` always uses `apiKey`, `'proxy'` always uses
   * the runtime token, `'auto'` (default) prefers an explicit `apiKey` and
   * falls back to the ambient pod runtime token.
   */
  mode?: VoiceHandlerMode
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
  /**
   * Explicitly opt into runtime-token proxy mode with the given options.
   * If omitted, `createVoiceHandlers()` will auto-detect proxy mode from
   * process env (`RUNTIME_AUTH_SECRET` + `PROJECT_ID`). Passing `proxy`
   * overrides env detection.
   */
  proxy?: VoiceProxyOptions
}

export interface VoiceHandlers {
  /** `GET /voice/signed-url` — returns `{ signedUrl, agentId, userContext }`. */
  signedUrl: (req: Request) => Promise<Response>
  /** `POST /voice/tts-preview` — returns raw audio bytes. Expects {@link TtsPreviewBody}. */
  tts: (req: Request) => Promise<Response>
  /**
   * `POST /voice/music` — generate music via the ElevenLabs Music API.
   * Returns raw audio bytes. Body mirrors {@link ComposeMusicParams}
   * (`prompt` XOR `compositionPlan`, `musicLengthMs`, `modelId`, …).
   */
  music: (req: Request) => Promise<Response>
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
   * Any op in the {@link VOICE_OPS} registry — `handlers.op(req, 'speech-to-speech')`.
   * `opId` may be omitted when the request URL carries it (last path segment,
   * e.g. `/api/voice/op/speech-to-speech`). Adding a registry row makes it
   * callable here with no other change.
   */
  op: (req: Request, opId?: string) => Promise<Response>
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

/**
 * Validate + normalize a raw music request body into {@link ComposeMusicParams}.
 * Returns a `{ error }` describing the first validation failure, or
 * `{ params }` on success. Enforces the EL contract that exactly one of
 * `prompt` / `compositionPlan` is supplied.
 */
function parseMusicBody(raw: unknown): { params: ComposeMusicParams } | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: 'Invalid JSON body' }
  const b = raw as Record<string, unknown>

  const hasPrompt = typeof b.prompt === 'string' && b.prompt.trim().length > 0
  const hasPlan = b.compositionPlan != null && typeof b.compositionPlan === 'object'
  if (hasPrompt === hasPlan) {
    return { error: 'Provide exactly one of `prompt` or `compositionPlan`' }
  }

  const params: ComposeMusicParams = {}
  if (hasPrompt) {
    params.prompt = (b.prompt as string).trim()
    if (typeof b.musicLengthMs === 'number') params.musicLengthMs = b.musicLengthMs
    if (typeof b.forceInstrumental === 'boolean') params.forceInstrumental = b.forceInstrumental
  } else {
    params.compositionPlan = b.compositionPlan as Record<string, unknown>
  }
  if (typeof b.modelId === 'string' && b.modelId.length > 0) params.modelId = b.modelId
  if (typeof b.outputFormat === 'string' && b.outputFormat.length > 0) {
    params.outputFormat = b.outputFormat
  }
  return { params }
}

/**
 * Resolve the runtime-token proxy options — explicit `config.proxy` wins,
 * else read from env vars that every Shogo-managed pod has injected.
 *
 * `config.mode` gates auto-detection: `'byo'` never proxies, and an
 * explicit `apiKey` in `'auto'` mode wins over the ambient runtime token
 * so BYO keeps working inside a pod.
 */
const MISSING_API_HOST_MESSAGE =
  'createVoiceHandlers: runtime-token proxy mode needs SHOGO_API_URL (or SHOGO_CLOUD_URL) in env; refusing to guess an API host'

/** The Shogo API host from pod env, if the pod injected one. */
function envApiUrl(): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined
  return process.env.SHOGO_API_URL ?? process.env.SHOGO_CLOUD_URL
}

function resolveProxyOptions(
  config: VoiceHandlersConfig,
): VoiceProxyOptions | null {
  if (config.mode === 'byo') {
    if (config.proxy) {
      throw new Error(
        "createVoiceHandlers: mode 'byo' cannot be combined with an explicit proxy",
      )
    }
    return null
  }
  const envProxy = () => {
    if (config.mode === 'proxy' && config.apiKey) {
      // Explicit proxy mode: the key really is unused; say so once.
      LOG_WARN_CACHE.apiKeyIgnored(config.logger)
    }
    if (typeof process === 'undefined' || !process.env) return null
    const runtimeToken = readRuntimeAuthSecret()
    const projectId = process.env.PROJECT_ID
    if (!runtimeToken || !projectId) return null
    return {
      runtimeToken,
      projectId,
      // Deliberately not required here: see `resolveApiBase`. Throwing at
      // construction made every local-only handler (400 validation, 405s,
      // the static audio-tags catalog) unusable on a host with a token but
      // no URL — which is exactly CI's env.
      apiUrl: envApiUrl() ?? '',
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }
  }
  if (config.proxy) {
    if (!config.proxy.runtimeToken || !config.proxy.projectId || !config.proxy.apiUrl) {
      throw new Error(
        'createVoiceHandlers: proxy requires runtimeToken, projectId, and apiUrl',
      )
    }
    if (config.apiKey) LOG_WARN_CACHE.apiKeyIgnored(config.logger)
    return config.proxy
  }
  if (config.mode === 'proxy') return envProxy()
  // 'auto': an explicit apiKey means the caller brought their own key.
  if (config.apiKey) return null
  return envProxy()
}

/** Emit the "apiKey is ignored" warning at most once per process. */
const LOG_WARN_CACHE = {
  warned: false,
  apiKeyIgnored(logger: VoiceHandlersConfig['logger']) {
    if (LOG_WARN_CACHE.warned) return
    LOG_WARN_CACHE.warned = true
    ;(logger ?? NOOP_LOGGER)(
      'warn',
      'createVoiceHandlers: apiKey provided but runtime-token proxy mode is active; apiKey is ignored (pass mode: "byo" to use it)',
    )
  },
}

/**
 * The op id for a request: an explicit argument wins, then `?op=`, then the
 * last path segment (`/api/voice/op/speech-to-speech`).
 */
function resolveOpId(req: Request, opId?: string): string | undefined {
  if (opId) return opId
  try {
    const url = new URL(req.url)
    const fromQuery = url.searchParams.get('op')
    if (fromQuery) return fromQuery
    const segments = url.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    // `/voice/op/speech-to-speech` → `speech-to-speech`; `/voice/audio-tags`
    // and friends fall through to `undefined` (an unknown op, reported by the
    // caller) rather than being mistaken for an id.
    if (last && segments[segments.length - 2] === 'op') return last
    return undefined
  } catch {
    return undefined
  }
}

/** Parsed request body for an op, or the 400 Response to send instead. */
type ParsedOpBody =
  | { kind: 'none' }
  | { kind: 'json'; fields: Record<string, unknown> }
  | { kind: 'form'; form: FormData; fields: Record<string, unknown> }

/**
 * Read + validate an op request against its registry row. The caller's body is
 * forwarded exactly as sent — defaults are applied at the upstream call, not
 * by rewriting the request.
 */
async function readVoiceOpBody(
  op: VoiceOp,
  req: Request,
): Promise<ParsedOpBody | Response> {
  if (op.method === 'GET') return { kind: 'none' }
  if (op.transport === 'multipart-binary' || op.transport === 'multipart-json') {
    let form: FormData
    try {
      // `Request.formData()` is typed against Node's FormData while the
      // registry is written against the DOM one (it is browser-safe); they are
      // the same object at runtime in every host we support.
      form = (await req.formData()) as unknown as FormData
    } catch {
      return json({ error: 'Invalid multipart body', detail: 'send a multipart/form-data body' }, 400)
    }
    const parsed = parseVoiceOpForm(op, form)
    if (!parsed.ok) {
      return json(
        {
          error: parsed.error,
          ...(parsed.detail ? { detail: parsed.detail } : {}),
          ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
        parsed.status,
      )
    }
    return { kind: 'form', form: parsed.form, fields: parsed.fields }
  }
  const raw = await readJson(req)
  const parsed = parseVoiceOpJsonBody(op, raw)
  if (!parsed.ok) {
    return json(
      {
        error: parsed.error,
        ...(parsed.detail ? { detail: parsed.detail } : {}),
        ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
      },
      parsed.status,
    )
  }
  return { kind: 'json', fields: parsed.fields }
}

/**
 * Build proxy handlers that forward requests to the Shogo API using the
 * runtime token. Mirrors the shape of {@link VoiceHandlers}: the same
 * method names, so templates that mount voice routes never need to
 * branch on mode.
 *
 * Every media op in the {@link VOICE_OPS} registry is reachable through
 * `handlers.op(req, opId)`; `tts` and `music` are aliases onto the same
 * forwarder so a mounted route keeps working unchanged.
 *
 * Only endpoints that make sense for a project-scoped, user-less pod
 * context are implemented end-to-end:
 *   - `signedUrl` — proxies to `GET /api/voice/signed-url?projectId=…`
 *   - `audioTags` — static catalog; never hits the network
 *   - every registry op — proxies to its hosted path
 *
 * User-scoped companion/agent CRUD (`agent.create/patch/delete`) assume a
 * `getUser` context that doesn't exist in runtime-token mode; those
 * handlers return `501 Not Implemented` with a clear message. A pod app
 * that needs per-end-user voice should either (a) stay in BYO-EL mode, or
 * (b) wait for the hosted user-voice API.
 */
function createProxyHandlers(
  proxy: VoiceProxyOptions,
  log: NonNullable<VoiceHandlersConfig['logger']>,
): VoiceHandlers {
  const fetchImpl = proxy.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'createVoiceHandlers proxy: global fetch is unavailable; pass proxy.fetch',
    )
  }

  /**
   * The API host for one proxied call. Resolved per call, never at
   * construction: a pod may inject the runtime token before (or without)
   * a host, and the local-only handlers — body validation, 405s, the
   * static audio-tags catalog — must not depend on one. Only a request
   * that actually leaves the process gets the loud refusal.
   */
  function resolveApiBase(): string {
    const raw = proxy.apiUrl || envApiUrl()
    if (!raw) throw new Error(MISSING_API_HOST_MESSAGE)
    return raw.replace(/\/+$/, '')
  }

  /**
   * Build an upstream URL with the project id pinned by the runtime
   * token plus a conservative allowlist of forwardable client query
   * params. We deliberately do NOT pass through arbitrary query
   * strings — the runtime token is project-scoped, and forwarding
   * unknown params risks privilege confusion if the upstream API
   * grows new auth-relevant flags.
   */
  function proxyUrl(
    base: string,
    path: string,
    forward: Record<string, string | null>,
  ): string {
    const tail: string[] = [`projectId=${encodeURIComponent(proxy.projectId)}`]
    for (const [k, v] of Object.entries(forward)) {
      if (typeof v === 'string' && v.length > 0) {
        tail.push(`${k}=${encodeURIComponent(v)}`)
      }
    }
    const sep = path.includes('?') ? '&' : '?'
    return `${base}${path}${sep}${tail.join('&')}`
  }

  /** Allowlist of query params forwarded from the incoming request. */
  const FORWARDED_SIGNED_URL_PARAMS = ['agentName'] as const

  async function doSignedUrl(req: Request): Promise<Response> {
    if (req.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405)
    // Resolved before the try so a missing host surfaces as the real
    // error, not a generic 502 "signedUrl proxy failed".
    const base = resolveApiBase()
    try {
      let incomingUrl: URL | null = null
      try {
        incomingUrl = new URL(req.url)
      } catch {
        // Some test transports pass non-absolute URLs; fall back to no
        // forwarded params. The upstream API will resolve the project's
        // default agent.
      }
      const forward: Record<string, string | null> = {}
      if (incomingUrl) {
        for (const key of FORWARDED_SIGNED_URL_PARAMS) {
          const v = incomingUrl.searchParams.get(key)
          if (v != null) forward[key] = v
        }
      }
      const upstream = await fetchImpl(proxyUrl(base, '/api/voice/signed-url', forward), {
        method: 'GET',
        headers: { 'x-runtime-token': proxy.runtimeToken },
        credentials: 'omit',
      })
      const body = await upstream.text()
      // Pass through the upstream content-type (JSON expected) and status.
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const ct = upstream.headers.get('content-type')
      if (ct) headers['content-type'] = ct
      return new Response(body, { status: upstream.status, headers })
    } catch (err) {
      log('error', 'proxy signedUrl failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return json({ error: 'signedUrl proxy failed' }, 502)
    }
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

  /**
   * Forward one registry op to the Shogo API, which holds the pooled EL
   * key. The registry decides the path, the transport and what the body may
   * contain; this function only adds the runtime token + project id, maps
   * "upstream has no such route" to 501 and everything else straight
   * through. `tts` and `music` are thin aliases over it.
   */
  async function doOp(req: Request, opId?: string): Promise<Response> {
    const id = resolveOpId(req, opId)
    const op = getVoiceOp(id)
    if (!op) {
      return json(
        { error: 'unknown_op', detail: `Unknown voice op '${id ?? ''}'`, allowed: VOICE_OP_IDS },
        404,
      )
    }
    if (req.method !== op.method) return json({ error: 'Method Not Allowed' }, 405)

    // Validation runs before the host is resolved: a bad body is the
    // caller's bug and must read as 400 even on a host with no API URL.
    const parsed = await readVoiceOpBody(op, req)
    if (parsed instanceof Response) return parsed

    const base = resolveApiBase()
    const forward: Record<string, string | null> = {}
    let incomingUrl: URL | null = null
    try {
      incomingUrl = new URL(req.url)
    } catch {
      // Non-absolute request URL (some test transports): nothing to forward.
    }
    if (incomingUrl) {
      for (const key of [...(op.pathParams ?? []), ...(op.queryForward ?? [])]) {
        const value = incomingUrl.searchParams.get(key)
        if (value != null) forward[key] = value
      }
    }
    // A multipart request's path params cannot travel in the rebuilt form, so
    // they go upstream as query params; a JSON body already carries them.
    if (parsed.kind === 'form') {
      for (const name of op.pathParams ?? []) {
        const value = parsed.fields[name]
        if (typeof value === 'string' && value.length > 0) forward[name] = value
      }
    }

    const hostedPath = `/api${voiceOpForwardPath(op)}`
    const headers: Record<string, string> = { 'x-runtime-token': proxy.runtimeToken }
    let body: BodyInit | undefined
    if (parsed.kind === 'json') {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(parsed.fields)
    } else if (parsed.kind === 'form') {
      // `fetch` sets the multipart boundary for a FormData body; copying a
      // content-type here would freeze the caller's boundary instead.
      body = parsed.form
    }
    if (op.accept) headers.accept = op.accept

    try {
      const upstream = await fetchImpl(proxyUrl(base, hostedPath, forward), {
        method: op.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        credentials: 'omit',
      })
      if (upstream.status === 404) {
        return json(
          {
            error: 'Not Implemented',
            detail: `this Shogo API has no voice routes (desktop without ELEVENLABS_API_KEY?) — ${hostedPath} returned 404 upstream`,
          },
          501,
        )
      }
      const buf = await upstream.arrayBuffer()
      const responseHeaders: Record<string, string> = {}
      const ct = upstream.headers.get('content-type')
      if (ct) responseHeaders['content-type'] = ct
      for (const name of op.responseHeaders ?? []) {
        const value = upstream.headers.get(name)
        if (value) responseHeaders[name] = value
      }
      return new Response(buf, { status: upstream.status, headers: responseHeaders })
    } catch (err) {
      log('error', `proxy ${op.id} failed`, {
        error: err instanceof Error ? err.message : String(err),
      })
      return json({ error: `${op.id} proxy failed` }, 502)
    }
  }

  /** `POST /voice/music` — alias onto the `music` registry row. */
  const doMusic = (req: Request): Promise<Response> => doOp(req, 'music')

  function notImplemented(label: string): (req: Request) => Promise<Response> {
    return async () =>
      json(
        {
          error: 'Not Implemented',
          detail: `${label} is not available in runtime-token proxy mode; use BYO-EL or the hosted bearer SDK path.`,
        },
        501,
      )
  }

  /**
   * `POST /voice/tts` — alias onto the `text-to-speech` registry row, keeping
   * the alias's own nicety: a body of only `audioTags` is a preview request,
   * so the line it builds is spliced in as the `text` the row requires. The op
   * itself has no audioTags handling and still requires `text`.
   */
  async function doTts(req: Request): Promise<Response> {
    if (req.method === 'POST') {
      let raw: Record<string, unknown> | null = null
      try {
        const parsed = (await req.clone().json()) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          raw = parsed as Record<string, unknown>
        }
      } catch {
        // Malformed JSON is doOp's 400 to report; there is nothing to splice.
      }
      if (raw && (typeof raw.text !== 'string' || raw.text.trim().length === 0)) {
        // Only an audioTags body is a preview request. A body with no text and
        // no tags stays a 400, exactly as before the registry existed.
        const sentTags = Array.isArray(raw.audioTags) && raw.audioTags.length > 0
        if (sentTags) {
          const tags = normalizeAudioTags(raw.audioTags) ?? []
          const characterName = typeof raw.characterName === 'string' ? raw.characterName : undefined
          const text = buildPreviewLine(tags, characterName ?? 'your companion')
          return doOp(
            new Request(req.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...raw, text }),
            }),
            'text-to-speech',
          )
        }
      }
    }
    return doOp(req, 'text-to-speech')
  }

  /**
   * The proxy-mode `elevenLabs` client. Media methods that the Shogo API
   * serves go through it; everything else (agent provisioning, phone
   * numbers, …) needs a BYO key and throws loudly.
   */
  function createProxyElevenLabs(): ElevenLabsClient {
    const unsupported = (prop: string): never => {
      throw new Error(
        `createVoiceHandlers: elevenLabs.${prop} is not available in runtime-token proxy mode (textToSpeech, composeMusic, speechToSpeech, soundEffects and transcribe are hosted); pass mode: 'byo' with an apiKey`,
      )
    }

    const textToSpeech = async (params: TextToSpeechParams): Promise<TextToSpeechResult> => {
      const upstream = await fetchImpl(proxyUrl(resolveApiBase(), '/api/voice/tts', {}), {
        method: 'POST',
        headers: {
          'x-runtime-token': proxy.runtimeToken,
          'content-type': 'application/json',
          accept: params.accept ?? 'audio/mpeg',
        },
        body: JSON.stringify({
          text: params.text,
          voiceId: params.voiceId,
          ...(params.modelId ? { modelId: params.modelId } : {}),
          ...(params.voiceSettings ? { voiceSettings: params.voiceSettings } : {}),
        }),
        credentials: 'omit',
      })
      if (upstream.status === 404) {
        throw new Error(
          'this Shogo API has no voice routes (desktop without ELEVENLABS_API_KEY?) — /api/voice/tts returned 404 upstream',
        )
      }
      if (!upstream.ok) {
        throw new ElevenLabsApiError(
          `textToSpeech failed: ${upstream.status}`,
          upstream.status,
          await upstream.text(),
        )
      }
      const requestedModel = params.modelId ?? DEFAULT_TTS_MODEL
      const usedModel = upstream.headers.get('x-tts-model-used') ?? requestedModel
      const requestedHeader = upstream.headers.get('x-tts-model-requested') ?? requestedModel
      return {
        audio: await upstream.arrayBuffer(),
        modelId: usedModel,
        requestedModel: requestedHeader,
        fellBack: usedModel !== requestedHeader,
        contentType: upstream.headers.get('content-type') ?? params.accept ?? 'audio/mpeg',
      }
    }

    const composeMusic = async (params: ComposeMusicParams) => {
      const upstream = await fetchImpl(proxyUrl(resolveApiBase(), '/api/voice/music', {}), {
        method: 'POST',
        headers: {
          'x-runtime-token': proxy.runtimeToken,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify(params),
        credentials: 'omit',
      })
      if (upstream.status === 404) {
        throw new Error(
          'this Shogo API has no voice routes (desktop without ELEVENLABS_API_KEY?) — /api/voice/music returned 404 upstream',
        )
      }
      if (!upstream.ok) {
        throw new ElevenLabsApiError(
          `composeMusic failed: ${upstream.status}`,
          upstream.status,
          await upstream.text(),
        )
      }
      return {
        audio: await upstream.arrayBuffer(),
        contentType: upstream.headers.get('content-type') ?? 'audio/mpeg',
      }
    }

    /**
     * Run a registry op through the proxy and return its Response, throwing
     * the same errors the BYO client throws. Keeps the typed conveniences on
     * `elevenLabs` one-liners over {@link doOp} instead of a third copy of the
     * forwarding logic.
     */
    const opResponse = async (opId: string, req: Request): Promise<Response> => {
      const op = getVoiceOp(opId)!
      const res = await doOp(req, opId)
      if (res.status === 404) {
        throw new Error(
          `this Shogo API has no voice routes (desktop without ELEVENLABS_API_KEY?) — /api${voiceOpForwardPath(op)} returned 404 upstream`,
        )
      }
      if (!res.ok) {
        throw new ElevenLabsApiError(
          `${opId} failed: ${res.status}`,
          res.status,
          await res.text(),
        )
      }
      return res
    }

    const opAudio = async (
      opId: string,
      req: Request,
    ): Promise<{ audio: ArrayBuffer; contentType: string }> => {
      const res = await opResponse(opId, req)
      return {
        audio: await res.arrayBuffer(),
        contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      }
    }

    const speechToSpeech = (params: SpeechToSpeechParams) => {
      const form = new FormData()
      form.set('audio', params.audio, params.fileName ?? 'audio')
      if (params.modelId) form.set('modelId', params.modelId)
      if (params.voiceSettings) form.set('voiceSettings', JSON.stringify(params.voiceSettings))
      if (params.outputFormat) form.set('outputFormat', params.outputFormat)
      if (params.fileFormat) form.set('fileFormat', params.fileFormat)
      if (params.seed !== undefined) form.set('seed', String(params.seed))
      if (params.removeBackgroundNoise !== undefined) {
        form.set('removeBackgroundNoise', String(params.removeBackgroundNoise))
      }
      const query = `?voiceId=${encodeURIComponent(params.voiceId)}`
      return opAudio(
        'speech-to-speech',
        new Request(`http://voice.invalid/voice/op/speech-to-speech${query}`, {
          method: 'POST',
          body: form,
        }),
      )
    }

    const soundEffects = (params: SoundEffectsParams) =>
      opAudio(
        'sound-generation',
        new Request(
          // `output_format` is a query param on this endpoint (see the row's
          // `queryForward`); sending it in the body would be dropped at EL.
          `http://voice.invalid/voice/op/sound-generation${
            params.outputFormat ? `?output_format=${encodeURIComponent(params.outputFormat)}` : ''
          }`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: params.text,
              ...(params.durationSeconds !== undefined
                ? { durationSeconds: params.durationSeconds }
                : {}),
              ...(params.promptInfluence !== undefined
                ? { promptInfluence: params.promptInfluence }
                : {}),
              ...(params.loop !== undefined ? { loop: params.loop } : {}),
              ...(params.modelId ? { modelId: params.modelId } : {}),
            }),
          },
        ),
      )

    const transcribe = async (params: TranscribeParams): Promise<TranscriptionResult> => {
      const form = new FormData()
      form.set('file', params.file, params.fileName ?? 'audio')
      if (params.modelId) form.set('modelId', params.modelId)
      if (params.languageCode) form.set('languageCode', params.languageCode)
      if (params.diarize !== undefined) form.set('diarize', String(params.diarize))
      if (params.tagAudioEvents !== undefined) {
        form.set('tagAudioEvents', String(params.tagAudioEvents))
      }
      if (params.numSpeakers !== undefined) form.set('numSpeakers', String(params.numSpeakers))
      const res = await opResponse(
        'speech-to-text',
        new Request('http://voice.invalid/voice/op/speech-to-text', {
          method: 'POST',
          body: form,
        }),
      )
      return (await res.json()) as TranscriptionResult
    }

    return new Proxy({} as ElevenLabsClient, {
      get(_t, prop) {
        if (prop === 'textToSpeech') return textToSpeech
        if (prop === 'composeMusic') return composeMusic
        if (prop === 'speechToSpeech') return speechToSpeech
        if (prop === 'soundEffects') return soundEffects
        if (prop === 'transcribe') return transcribe
        return unsupported(String(prop))
      },
    })
  }

  return {
    signedUrl: doSignedUrl,
    tts: doTts,
    music: doMusic,
    agent: {
      create: notImplemented('agent.create'),
      patch: notImplemented('agent.patch'),
      delete: notImplemented('agent.delete'),
    },
    audioTags: doAudioTags,
    op: doOp,
    // In proxy mode we don't own an EL client: media calls go through the
    // Shogo API, anything else is a loud error.
    elevenLabs: createProxyElevenLabs(),
  }
}

export function createVoiceHandlers(config: VoiceHandlersConfig): VoiceHandlers {
  const log = config.logger ?? NOOP_LOGGER

  // Proxy mode short-circuit — skips every BYO-EL requirement. A pod
  // started with RUNTIME_AUTH_SECRET + PROJECT_ID in env just works,
  // unless the caller supplied an apiKey (auto) or asked for 'byo'.
  const proxy = resolveProxyOptions(config)
  if (proxy) {
    return createProxyHandlers(proxy, log)
  }

  if (!config.apiKey) {
    throw new Error(
      config.mode === 'proxy'
        ? 'createVoiceHandlers: mode "proxy" needs RUNTIME_AUTH_SECRET + PROJECT_ID (+ SHOGO_API_URL) in env'
        : 'createVoiceHandlers: apiKey is required (or run in a pod with RUNTIME_AUTH_SECRET + PROJECT_ID for proxy mode)',
    )
  }

  // TypeScript narrowing — alias post-guard so closures can use them.
  const getUser = config.getUser
  const companionStore = config.companionStore
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
    if (!getUser) {
      return json(
        {
          error: 'Voice handler misconfigured',
          detail:
            'signedUrl / agent.* need getUser (and companionStore); tts and music do not.',
        },
        500,
      )
    }
    const u = await getUser(req)
    if (!u) return json({ error: 'Unauthorized' }, 401)
    return u
  }

  /** 500 when a user-scoped handler ran without a companion store. */
  function missingCompanionStore(): Response {
    return json(
      {
        error: 'Voice handler misconfigured',
        detail: 'companionStore is required for signedUrl / agent.*; tts and music do not need it.',
      },
      500,
    )
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

    if (!companionStore) return missingCompanionStore()
    const companion = await companionStore.findByUserId(u.id)
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
        await companionStore.update(u.id, { systemPrompt: basePrompt })
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
    // TTS is project-scoped: only resolve a user when the consumer wired
    // one, so `createVoiceHandlers({ apiKey })` works without stores.
    if (getUser) {
      const u = await resolveUser(req)
      if (u instanceof Response) return u
    }

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
      const result = await el.textToSpeech({
        voiceId,
        text,
        ...(body.modelId ? { modelId: body.modelId } : {}),
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
        log('warn', 'tts fell back to another model', {
          requested: result.requestedModel,
          used: result.modelId,
          reason: result.fallbackReason,
        })
      }
      return new Response(result.audio, { headers })
    } catch (e) {
      return handleElError(e, 'TTS failed')
    }
  }

  async function doMusic(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
    if (getUser) {
      const u = await resolveUser(req)
      if (u instanceof Response) return u
    }

    const raw = await readJson(req)
    const parsed = parseMusicBody(raw)
    if ('error' in parsed) return json({ error: parsed.error }, 400)

    try {
      const { audio, contentType } = await el.composeMusic(parsed.params)
      return new Response(audio, {
        headers: {
          'content-type': contentType,
          'cache-control': 'private, max-age=3600',
        },
      })
    } catch (e) {
      return handleElError(e, 'Music generation failed')
    }
  }

  /**
   * Any registry op, called with the caller's own ElevenLabs key. The
   * registry supplies the path, the transport and the validation; this
   * function only turns validated fields into an ElevenLabs call.
   */
  async function doOp(req: Request, opId?: string): Promise<Response> {
    const id = resolveOpId(req, opId)
    const op = getVoiceOp(id)
    if (!op) {
      return json(
        { error: 'unknown_op', detail: `Unknown voice op '${id ?? ''}'`, allowed: VOICE_OP_IDS },
        404,
      )
    }
    if (req.method !== op.method) return json({ error: 'Method Not Allowed' }, 405)

    const parsed = await readVoiceOpBody(op, req)
    if (parsed instanceof Response) return parsed

    // A multipart request's path params live only in `fields` (the rebuilt
    // form drops them), so using `{}` for a form here would send the request
    // to the project default voice without a word.
    const fields = parsed.kind === 'none' ? {} : parsed.fields
    let query: URLSearchParams
    try {
      query = new URL(req.url).searchParams
    } catch {
      query = new URLSearchParams()
    }
    const pathParams = voiceOpPathParams(op, fields, query)
    const upstream = voiceOpUpstreamPath(op, pathParams)
    if (typeof upstream !== 'string') {
      return json({ error: upstream.error, detail: `set it in the body or as ?${op.pathParams?.[0]}=` }, 400)
    }

    const forwardedQuery: Record<string, string> = {}
    for (const key of op.queryForward ?? []) {
      const value = query.get(key)
      if (value) forwardedQuery[key] = value
    }
    if (op.defaultVoiceId && !pathParams.voiceId) {
      return json(
        {
          error: 'Missing `voiceId`',
          detail: `BYO mode has no project default voice — pass voiceId (or ?voiceId=)`,
        },
        400,
      )
    }

    try {
      if (op.call === 'textToSpeech') {
        const result = await el.textToSpeech({
          voiceId: pathParams.voiceId ?? String(fields.voiceId ?? ''),
          text: String(fields.text ?? ''),
          ...(typeof fields.modelId === 'string' ? { modelId: fields.modelId } : {}),
          ...(fields.voiceSettings
            ? { voiceSettings: fields.voiceSettings as TextToSpeechParams['voiceSettings'] }
            : {}),
          ...(op.accept ? { accept: op.accept } : {}),
        })
        const headers: Record<string, string> = {
          'content-type': result.contentType,
          'cache-control': 'private, max-age=3600',
          'x-tts-model-used': result.modelId,
          'x-tts-model-requested': result.requestedModel,
        }
        if (result.fellBack) {
          headers.warning = `199 - "model ${result.requestedModel} not available, used ${result.modelId}"`
        }
        return new Response(result.audio, { headers })
      }

      if (op.call === 'composeMusic') {
        const { audio, contentType } = await el.composeMusic({
          ...(typeof fields.prompt === 'string' ? { prompt: fields.prompt } : {}),
          ...(fields.compositionPlan
            ? { compositionPlan: fields.compositionPlan as Record<string, unknown> }
            : {}),
          ...(typeof fields.musicLengthMs === 'number' ? { musicLengthMs: fields.musicLengthMs } : {}),
          ...(typeof fields.modelId === 'string' ? { modelId: fields.modelId } : {}),
          ...(typeof fields.forceInstrumental === 'boolean'
            ? { forceInstrumental: fields.forceInstrumental }
            : {}),
          ...(typeof fields.outputFormat === 'string' ? { outputFormat: fields.outputFormat } : {}),
        })
        return new Response(audio, {
          headers: {
            'content-type': contentType,
            'cache-control': 'private, max-age=3600',
          },
        })
      }

      const upstreamBody = voiceOpUpstreamBody(op, fields)
      if (op.defaultModel && upstreamBody.model_id === undefined) {
        upstreamBody.model_id = op.defaultModel
      }
      const response = await el.request({
        method: op.method,
        path: upstream,
        ...(parsed.kind === 'form'
          ? { body: parsed.form }
          : parsed.kind === 'json'
            ? { body: upstreamBody }
            : {}),
        ...(Object.keys(forwardedQuery).length ? { query: forwardedQuery } : {}),
        ...(op.accept ? { accept: op.accept } : {}),
      })
      const headers: Record<string, string> = { 'content-type': response.contentType }
      if (voiceOpReturnsAudio(op)) headers['cache-control'] = 'private, max-age=3600'
      const body = response.audio ?? JSON.stringify(response.json ?? {})
      return new Response(body, { status: response.status, headers })
    } catch (e) {
      return handleElError(e, `${op.id} failed`)
    }
  }

  async function doAgentCreate(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
    const u = await resolveUser(req)
    if (u instanceof Response) return u

    if (!companionStore) return missingCompanionStore()
    const existing = await companionStore.findByUserId(u.id)
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
    const companion = await companionStore.create({
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

    if (!companionStore) return missingCompanionStore()
    const existing = await companionStore.findByUserId(u.id)
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

    const companion = await companionStore.update(u.id, patch)
    return json(companion)
  }

  async function doAgentDelete(req: Request): Promise<Response> {
    if (req.method !== 'DELETE') return json({ error: 'Method Not Allowed' }, 405)
    const u = await resolveUser(req)
    if (u instanceof Response) return u

    if (!companionStore) return missingCompanionStore()
    const existing = await companionStore.findByUserId(u.id)
    if (!existing) return json({ ok: true })

    if (existing.agentId) await el.deleteAgent(existing.agentId)
    await companionStore.delete(u.id)
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
    music: doMusic,
    agent: {
      create: doAgentCreate,
      patch: doAgentPatch,
      delete: doAgentDelete,
    },
    audioTags: doAudioTags,
    op: doOp,
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
