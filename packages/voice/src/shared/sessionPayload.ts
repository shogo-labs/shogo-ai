// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Build the payload object that gets passed to ElevenLabs'
 * `useConversation().startSession(...)`. Identical between web and
 * native, so it lives here.
 *
 * The shape mirrors what `@elevenlabs/react`'s `startSession` accepts:
 *
 *   {
 *     signedUrl,
 *     dynamicVariables: { character_name, user_context },
 *     overrides?: { agent: { firstMessage?, prompt?: { prompt } } },
 *   }
 *
 * `overrides` is built lazily so we only set the keys we actually want
 * to override — ElevenLabs treats any present key as "use this value"
 * and any missing key as "use the agent's configured default", which
 * is exactly what we want for partial overrides.
 */

export interface BuildSessionPayloadOptions {
  signedUrl: string
  characterName: string
  userContext: string
  /** Optional full prompt override (`overrides.agent.prompt.prompt`). */
  agentPromptOverride?: string
  /** When true, sets `overrides.agent.firstMessage = ''`. */
  suppressFirstMessage?: boolean
  /**
   * Stable conversation id (consumer-supplied, e.g. from a sibling
   * text hook). Forwarded as the `conversation_id` dynamic variable
   * so the agent's prompt can reference it via `{{conversation_id}}`.
   * Omitted from the payload when `undefined`, so the agent's
   * configured default (or no value at all) is used.
   */
  conversationId?: string
  /**
   * Extra dynamic variables forwarded to ElevenLabs at session start.
   * Merged with the built-in `{ character_name, user_context,
   * conversation_id? }` payload — the SDK's own keys ALWAYS win on
   * collision, so `character_name` etc. can't be accidentally
   * overridden. Non-string values are coerced to strings (EL rejects
   * anything else); `null` / `undefined` entries are dropped.
   *
   * Typical use: surface per-user fields from the consumer's own
   * `Companion` row (display name, relationship stage, custom greeting
   * tokens) to the agent's prompt via `{{var_name}}` placeholders.
   */
  dynamicVariables?: Record<string, unknown> | null
}

/**
 * Coerce a `dynamicVariables` map to the `Record<string, string>` shape
 * EL accepts. `null` / `undefined` entries are dropped; everything else
 * is `String(...)`-ified. Caller provides a plain object — never an
 * array or class instance.
 */
function sanitizeDynamicVariables(
  raw: Record<string, unknown> | null | undefined,
): Record<string, string> {
  if (raw == null) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

export function buildSessionPayload(
  opts: BuildSessionPayloadOptions,
): Record<string, unknown> {
  // Consumer-supplied vars first, then built-ins on top — the SDK's
  // keys (`character_name`, `user_context`, `conversation_id`) cannot
  // be overridden by accident.
  const dynamicVariables: Record<string, string> = {
    ...sanitizeDynamicVariables(opts.dynamicVariables),
    character_name: opts.characterName,
    user_context: opts.userContext,
  }
  if (typeof opts.conversationId === 'string' && opts.conversationId.length > 0) {
    dynamicVariables.conversation_id = opts.conversationId
  }
  const payload: Record<string, unknown> = {
    signedUrl: opts.signedUrl,
    dynamicVariables,
  }

  const agentOverrides: Record<string, unknown> = {}
  if (opts.suppressFirstMessage) {
    agentOverrides.firstMessage = ''
  }
  if (
    typeof opts.agentPromptOverride === 'string' &&
    opts.agentPromptOverride.length > 0
  ) {
    agentOverrides.prompt = { prompt: opts.agentPromptOverride }
  }
  if (Object.keys(agentOverrides).length > 0) {
    payload.overrides = { agent: agentOverrides }
  }

  return payload
}

/**
 * Shape returned by the consumer's `signedUrlPath` endpoint. Both
 * platforms parse the same shape.
 */
export interface SignedUrlResponse {
  signedUrl: string
  userContext?: string
  /**
   * Optional per-session full-prompt override. The server resolves
   * project metadata + memory and composes a complete persona +
   * context prompt; we forward it verbatim to ElevenLabs via
   * `overrides.agent.prompt.prompt`. Requires the agent to be
   * provisioned with `platform_settings.overrides.agent.prompt.prompt = true`.
   */
  agentPromptOverride?: string
}

export interface FetchSignedUrlOptions {
  /** Resolved signed-URL endpoint (already includes `?projectId=...` if needed). */
  path: string
  fetchCredentials: RequestCredentials
  authHeaders: () => Record<string, string>
}

export async function fetchSignedUrl({
  path,
  fetchCredentials,
  authHeaders,
}: FetchSignedUrlOptions): Promise<SignedUrlResponse> {
  const res = await fetch(path, {
    credentials: fetchCredentials,
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Signed URL request failed: ${res.status}`)
  return (await res.json()) as SignedUrlResponse
}

/**
 * Append `?projectId=` (or `&projectId=`) to a signed-URL path when a
 * project id is supplied. Used by the bearer-auth path so the server
 * can resolve the per-project ElevenLabs agent.
 *
 * @deprecated Use {@link withProjectQuery} for new callers — same
 * behavior plus optional `agentName`. Kept here as a thin shim so
 * existing tests and external consumers don't break.
 */
export function withProjectId(
  signedUrlPath: string,
  projectId: string | undefined,
): string {
  return withProjectQuery(signedUrlPath, { projectId })
}

/**
 * Append a stable set of query params (`projectId`, `agentName`, …)
 * to a signed-URL path. Empty / undefined values are dropped silently
 * so the helper is safe to call with the consumer's whole option bag.
 *
 * Pre-existing query strings on `signedUrlPath` are preserved:
 *
 *   withProjectQuery('/api/voice/signed-url?foo=bar', {
 *     projectId: 'p',
 *     agentName: 'architect',
 *   })
 *   // → '/api/voice/signed-url?foo=bar&projectId=p&agentName=architect'
 */
export function withProjectQuery(
  signedUrlPath: string,
  params: { projectId?: string; agentName?: string },
): string {
  const tail: string[] = []
  if (typeof params.projectId === 'string' && params.projectId.length > 0) {
    tail.push(`projectId=${encodeURIComponent(params.projectId)}`)
  }
  if (typeof params.agentName === 'string' && params.agentName.length > 0) {
    tail.push(`agentName=${encodeURIComponent(params.agentName)}`)
  }
  if (tail.length === 0) return signedUrlPath
  const sep = signedUrlPath.includes('?') ? '&' : '?'
  return `${signedUrlPath}${sep}${tail.join('&')}`
}
