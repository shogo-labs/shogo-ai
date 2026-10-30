// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one place a Zernio call leaves this process.
 *
 * Everything social goes through `getSocialClient().request(...)`, so the
 * routing decision — cloud relay, BYOK direct, or direct from the cloud that
 * holds the master key — is made once and nowhere else. New routes, services
 * and agent actions call this module and never `fetch` Zernio themselves.
 *
 * Modes (`SOCIAL_MODE`):
 *   cloud  the Shogo cloud API: holds `ZERNIO_API_KEY`, calls Zernio directly.
 *   relay  a desktop / self-hosted instance: forwards the operation to the
 *          cloud relay (`SHOGO_API_KEY`), which holds the key and meters it.
 *   byok   the user's own Zernio key (`ZERNIO_USER_API_KEY`): direct, no relay,
 *          no metering, no markup. Mirrors the `AI_MODE=api-keys` precedent.
 *
 * Tests inject a fake through `setSocialClient`, the same seam
 * `setComposioTriggersClient` gives the trigger code — no test talks to Zernio.
 */

import { getShogoCloudUrl } from '../../lib/cloud-urls'

export const ZERNIO_API_BASE = 'https://zernio.com/api/v1'
export const SOCIAL_RELAY_PATH = '/api/social-relay'
/**
 * The scope a relayed call belongs to. The desktop sends it so the cloud keeps
 * one Zernio profile per local workspace; absent/empty for the cloud scope.
 */
export const LOCAL_SCOPE_HEADER = 'x-shogo-local-workspace'
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/**
 * A create-post carries the media and waits for the platform to accept it, so it
 * gets a budget of its own: 15 s is enough for a read, not for a 34 MB reel.
 */
export const CREATE_POST_TIMEOUT_MS = 120_000
const MAX_RETRY_AFTER_MS = 5_000

export type SocialMode = 'cloud' | 'relay' | 'byok'

export interface ZernioRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Path under the Zernio base, e.g. `/profiles` or `/accounts/acc_1`. */
  path: string
  /** The workspace the call belongs to; scopes the relay and derives routing ids. */
  workspaceId?: string
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  /** Sent as `Idempotency-Key`; Zernio dedupes same-key writes. */
  idempotencyKey?: string
  /**
   * How long to wait for the provider. Defaults to
   * `DEFAULT_REQUEST_TIMEOUT_MS`; a publish passes `CREATE_POST_TIMEOUT_MS`
   * because it uploads media before the platform answers.
   */
  timeoutMs?: number
}

export interface SocialClient {
  mode: SocialMode
  request<T = unknown>(req: ZernioRequest): Promise<T>
}

export interface SocialErrorBody {
  error?: string
  type?: string
  platform?: string
  platformError?: string
  docUrl?: string
  [key: string]: unknown
}

/** A provider failure, normalised to the shape Zernio documents. */
export class SocialError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'SocialError'
  }

  /** The API's error shape: `{ error: { code, message, ...details } }`. */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...this.details,
      },
    }
  }
}

export interface SocialClientConfig {
  mode: SocialMode
  baseUrl: string
  apiKey: string
}

/**
 * Resolve how this process talks to Zernio.
 *
 * A desktop sets `SHOGO_API_KEY` (it is how every other forwarded provider
 * call reaches the cloud), so its presence — or `SHOGO_LOCAL_MODE` — means
 * "relay". BYOK wins over both when the user supplied their own key.
 *
 * A desktop whose key lives only in `localConfig` (the env var was cleared on
 * restart) still resolves to relay with an empty key: `relayCredential()` reads
 * the signed-in session at request time, which is the only place it can be
 * awaited.
 */
export function resolveSocialClientConfig(env: NodeJS.ProcessEnv = process.env): SocialClientConfig {
  const base = (env.ZERNIO_API_BASE || ZERNIO_API_BASE).replace(/\/$/, '')
  const byokKey = env.ZERNIO_USER_API_KEY?.trim()

  if (env.SOCIAL_MODE === 'byok' && byokKey) {
    return { mode: 'byok', baseUrl: base, apiKey: byokKey }
  }

  const isDesktop = env.SHOGO_LOCAL_MODE === 'true' || !!env.SHOGO_API_KEY
  if (isDesktop) {
    return {
      mode: 'relay',
      baseUrl: `${getShogoCloudUrl()}${SOCIAL_RELAY_PATH}`,
      apiKey: env.SHOGO_API_KEY?.trim() ?? '',
    }
  }

  const masterKey = env.ZERNIO_API_KEY?.trim()
  if (!masterKey) {
    throw new SocialError(503, 'social_not_configured', 'ZERNIO_API_KEY is not configured on the server.')
  }
  return { mode: 'cloud', baseUrl: base, apiKey: masterKey }
}

/**
 * The Shogo Cloud credential a relay call needs: the env var when it is set,
 * otherwise the key a signed-in desktop persisted to `localConfig`. Same two
 * sources `federated-upstream` already reads, so social never disagrees with
 * the rest of the desktop about whether it is signed in.
 */
export async function relayCredential(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = env.SHOGO_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const { getUpstreamCredential } = await import('../../lib/federated-upstream')
    return (await getUpstreamCredential()) ?? null
  } catch {
    return null
  }
}

function buildUrl(baseUrl: string, req: ZernioRequest): string {
  const url = new URL(`${baseUrl}${req.path}`)
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function retryAfterMs(header: string | null): number {
  if (!header) return 0
  const asNumber = Number(header)
  if (Number.isFinite(asNumber)) return Math.min(Math.max(asNumber, 0) * 1000, MAX_RETRY_AFTER_MS)
  const asDate = Date.parse(header)
  if (Number.isFinite(asDate)) return Math.min(Math.max(asDate - Date.now(), 0), MAX_RETRY_AFTER_MS)
  return 0
}

async function parseErrorBody(res: Response): Promise<SocialErrorBody> {
  try {
    const parsed = await res.json()
    return parsed && typeof parsed === 'object' ? (parsed as SocialErrorBody) : {}
  } catch {
    return {}
  }
}

function normalizeError(status: number, body: SocialErrorBody, mode: SocialMode): SocialError {
  const platform = typeof body.platform === 'string' ? body.platform : undefined
  const platformError = typeof body.platformError === 'string' ? body.platformError : undefined
  // Zernio answers with a string `error`; our own relay (and the rest of the
  // API) answers with `error: { code, message }`. Read both.
  const nested = body.error && typeof body.error === 'object' ? (body.error as any) : null
  const message =
    (typeof body.error === 'string' && body.error) ||
    (typeof nested?.message === 'string' && nested.message) ||
    platformError ||
    `Zernio request failed (${status})`
  const code =
    (typeof body.type === 'string' && body.type) ||
    (typeof nested?.code === 'string' && nested.code) ||
    `zernio_${status}`
  const details: Record<string, unknown> = {}
  if (platform) details.platform = platform
  if (platformError) details.platformError = platformError
  if (typeof body.docUrl === 'string') details.docUrl = body.docUrl
  // A caller on a desktop sees the cloud's failure through the relay; saying so
  // is the difference between "our key is broken" and "your sign-in expired".
  if (mode === 'relay') {
    details.via = 'relay'
    // The relay speaks this API's error shape, so anything else it put in
    // `error` (a swallowed create failure, the routing id) is the only
    // explanation the desktop's 502 will ever carry. Keep it.
    for (const [key, value] of Object.entries(nested ?? {})) {
      if (key === 'code' || key === 'message' || value === undefined) continue
      details[key] = value
    }
  }
  // `profile_external_id_conflict` names the profile that already owns the
  // routing id, so a 409 is adoptable rather than fatal.
  const existing = (body.details as any)?.existingProfileId ?? body.existingProfileId
  if (typeof existing === 'string' && existing) details.existingProfileId = existing
  return new SocialError(status, code, message, details)
}

function createHttpSocialClient(config: SocialClientConfig): SocialClient {
  return {
    mode: config.mode,
    async request<T>(req: ZernioRequest): Promise<T> {
      let apiKey = config.apiKey
      if (!apiKey) {
        if (config.mode !== 'relay') {
          throw new SocialError(503, 'social_not_configured', 'ZERNIO_API_KEY is not configured on the server.')
        }
        apiKey = (await relayCredential()) ?? ''
        if (!apiKey) {
          throw new SocialError(
            412,
            'social_relay_unavailable',
            'Social accounts on desktop go through Shogo Cloud. Sign in to Shogo Cloud in Settings first.',
          )
        }
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      }
      if (req.body !== undefined) headers['Content-Type'] = 'application/json'
      if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey
      // Only the relay has a scope to declare; BYOK and direct cloud calls go
      // straight to Zernio, and a local workspace id is not ours to send them.
      if (config.mode === 'relay' && req.workspaceId) {
        const { localScopeFor } = await import('./local-scope')
        const scope = await localScopeFor(req.workspaceId)
        if (scope) headers[LOCAL_SCOPE_HEADER] = scope
      }

      const url = buildUrl(config.baseUrl, req)

      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await fetch(url, {
            method: req.method,
            headers,
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
            signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
          })
        } catch (err) {
          const timedOut = err instanceof Error && err.name === 'TimeoutError'
          throw new SocialError(
            timedOut ? 504 : 502,
            timedOut ? 'zernio_timeout' : 'zernio_unreachable',
            timedOut ? 'Zernio did not answer in time.' : 'Could not reach Zernio.',
          )
        }

        if (res.status === 429 && attempt === 0) {
          const wait = retryAfterMs(res.headers.get('retry-after'))
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
          continue
        }

        if (!res.ok) throw normalizeError(res.status, await parseErrorBody(res), config.mode)
        if (res.status === 204) return undefined as T
        return (await res.json()) as T
      }
    },
  }
}

let override: SocialClient | null = null

/** Test seam — mirrors `setComposioTriggersClient`. */
export function setSocialClient(client: SocialClient | null): void {
  override = client
}

export function getSocialClient(): SocialClient {
  if (override) return override
  return createHttpSocialClient(resolveSocialClientConfig())
}

/** The mode this process would use, without performing a call. */
export function socialMode(): SocialMode {
  if (override) return override.mode
  return resolveSocialClientConfig().mode
}
