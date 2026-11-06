// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one place a request to Expo leaves this process.
 *
 * Native release has three modes (`NATIVE_RELEASE_MODE`), the same split social
 * uses for Zernio:
 *
 *   cloud  the Shogo cloud API holds `EXPO_ACCOUNT_TOKEN` — a robot on the
 *          Shogo Expo account — and makes every EAS call itself.
 *   relay  a desktop forwards each operation to the cloud relay
 *          (`/api/native-release-relay`, `SHOGO_API_KEY`). The desktop never
 *          receives an Expo token, which is the whole point of the design.
 *   byok   the workspace's own `EXPO_TOKEN`: the same code path, a different
 *          token, and nobody meters it.
 *
 * The token is resolved per call, never cached in a module-level variable: a
 * robot token on the cloud and a user token on a BYOK workspace can be in flight
 * in the same process, and a cached value is how one tenant's build ends up
 * charged to another. `getEasClient` is the seam tests replace.
 */

export const EXPO_GRAPHQL_URL = 'https://api.expo.dev/graphql'
export const NATIVE_RELEASE_RELAY_PATH = '/api/native-release-relay'
export const DEFAULT_EAS_TIMEOUT_MS = 30_000

export type NativeReleaseMode = 'cloud' | 'relay' | 'byok'

/**
 * Resolve how this process talks to Expo.
 *
 * Defaults to `byok` everywhere — including the cloud — until Russell flips
 * `NATIVE_RELEASE_MODE` after Expo answers the resale and project-cap questions.
 * A desktop with `SHOGO_LOCAL_MODE`/`SHOGO_API_KEY` and no explicit mode relays,
 * matching `resolveSocialClientConfig`.
 */
export function nativeReleaseMode(env: NodeJS.ProcessEnv = process.env): NativeReleaseMode {
  const explicit = env.NATIVE_RELEASE_MODE?.trim().toLowerCase()
  if (explicit === 'cloud' || explicit === 'relay' || explicit === 'byok') return explicit
  if (env.SHOGO_LOCAL_MODE || env.SHOGO_API_KEY) return 'relay'
  return 'byok'
}

/** The cloud account a release is billed and built on. */
export interface EasCredentials {
  mode: NativeReleaseMode
  token: string
  /** The Expo account id owning `createApp`; null in byok until `meActor` runs. */
  accountId: string | null
}

export class NativeReleaseError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'NativeReleaseError'
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.details } }
  }
}

export interface EasClient {
  /** The token this client authenticated with. Never logged, never returned. */
  readonly token: string
  request<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>
}

let clientOverride: EasClient | null = null

/**
 * Test seam. Mirrors `setSocialClient`: no test talks to Expo, and nothing else
 * in this tree constructs an `EasClient` for itself.
 */
export function setEasClient(client: EasClient | null): void {
  clientOverride = client
}

export function easClientFor(credentials: EasCredentials): EasClient {
  if (clientOverride) return clientOverride
  return createHttpEasClient(credentials.token)
}

export function createHttpEasClient(token: string, endpoint = process.env.EXPO_GRAPHQL_URL || EXPO_GRAPHQL_URL): EasClient {
  return {
    token,
    async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(DEFAULT_EAS_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => ({}))) as {
        data?: T
        errors?: { message: string; extensions?: { code?: string } }[]
      }
      if (body.errors?.length) {
        // Expo answers 200 with `errors` for most failures, so status alone is
        // not enough to decide whether the call worked.
        const message = body.errors.map((e) => e.message).join('; ')
        const code = body.errors[0]?.extensions?.code ?? 'eas_error'
        throw new NativeReleaseError(502, code, message)
      }
      if (!res.ok) {
        throw new NativeReleaseError(502, 'eas_http_error', `Expo answered ${res.status}`)
      }
      if (body.data === undefined) {
        throw new NativeReleaseError(502, 'eas_empty_response', 'Expo returned no data')
      }
      return body.data
    },
  }
}

/**
 * Resolve the token a release runs with.
 *
 * `cloud` reads the process env only. `byok` prefers the workspace's encrypted
 * `expo_token` credential and falls back to `EXPO_TOKEN` in the process env,
 * which is how a desktop project `.env` reaches us. `relay` never resolves a
 * token here — the cloud does, on the far side of the relay.
 */
export async function resolveEasCredentials(opts: {
  workspaceId: string
  env?: NodeJS.ProcessEnv
  /** Returns the decrypted `expo_token` credential for a workspace, if any. */
  readByokToken?: (workspaceId: string) => Promise<string | null>
}): Promise<EasCredentials> {
  const env = opts.env ?? process.env
  const mode = nativeReleaseMode(env)

  if (mode === 'relay') {
    throw new NativeReleaseError(
      400,
      'relay_has_no_token',
      'A relay instance never holds an Expo token; the cloud resolves it for this release.',
    )
  }

  if (mode === 'cloud') {
    const token = env.EXPO_ACCOUNT_TOKEN?.trim()
    if (!token) {
      throw new NativeReleaseError(
        503,
        'native_not_configured',
        'Native release is not configured on this deployment (EXPO_ACCOUNT_TOKEN is unset).',
      )
    }
    return { mode, token, accountId: env.EXPO_ACCOUNT_ID?.trim() || null }
  }

  const stored = opts.readByokToken ? await opts.readByokToken(opts.workspaceId) : null
  const token = stored?.trim() || env.EXPO_TOKEN?.trim()
  if (!token) {
    throw new NativeReleaseError(
      412,
      'expo_token_required',
      'Connect your own Expo account in Project → App stores, or set EXPO_TOKEN, to publish a native app.',
    )
  }
  return { mode, token, accountId: null }
}
