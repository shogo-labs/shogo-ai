// SPDX-License-Identifier: Apache-2.0
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
}

export function buildSessionPayload(
  opts: BuildSessionPayloadOptions,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    signedUrl: opts.signedUrl,
    dynamicVariables: {
      character_name: opts.characterName,
      user_context: opts.userContext,
    },
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
 */
export function withProjectId(
  signedUrlPath: string,
  projectId: string | undefined,
): string {
  if (!projectId) return signedUrlPath
  const sep = signedUrlPath.includes('?') ? '&' : '?'
  return `${signedUrlPath}${sep}projectId=${encodeURIComponent(projectId)}`
}
