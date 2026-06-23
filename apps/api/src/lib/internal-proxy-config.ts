// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Self-provision in-process AI proxy credentials for the API server.
 *
 * The AI proxy (`routes/ai-proxy.ts`) is mounted on the same API server, but
 * the server-initiated LLM surfaces — title generation
 * (`/api/generate-project-name`), the in-app assistant (`routes/chat.ts`), and
 * the voice translator (`routes/voice.ts`) — reach it through
 * `resolveLanguageModel`, which requires `AI_PROXY_URL` + `AI_PROXY_TOKEN`.
 *
 * Those env vars are only ever provisioned for pod/runtime containers
 * (`lib/runtime/build-project-env.ts`), never for the API server's own process.
 * Without them `resolveLanguageModel` returns `null` for custom providers (the
 * default `hoshi-1.0` title model) and every title-generation request falls
 * back to a code-generated heuristic name.
 *
 * This helper points `AI_PROXY_URL` at the in-process proxy and mints a
 * server-scoped proxy JWT. Crucially that JWT resolves as `authKind ===
 * 'proxy-jwt'` (see `routes/ai-proxy.ts` `validateProxyAuthImpl`) — the only
 * auth kind trusted to honor the `x-shogo-usage-tag: title_generation` header,
 * which records title usage as $0 / non-billable. A refresh timer re-mints the
 * token before it expires so the long-lived server never serves an expired one.
 *
 * Any pre-set env value (e.g. an externally-managed proxy) is always respected.
 */
import { generateProxyToken } from './ai-proxy-token'

/**
 * Sentinel ids embedded in the server's own proxy token. Title generation is
 * tagged internal + non-billable, so these never debit a wallet or accumulate
 * into a billing session regardless of whether they map to real rows.
 */
const SYSTEM_PROJECT_ID = 'system'
const SYSTEM_WORKSPACE_ID = 'system'

/** Token lifetime and refresh cadence (refresh comfortably before expiry). */
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const REFRESH_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000 // 6 days

let refreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * Derive the base URL of the in-process API (which hosts the AI proxy),
 * mirroring `lib/runtime/build-project-env.ts` so pod and server agree:
 *   - K8s (SYSTEM_NAMESPACE set): the Knative service DNS on port 80.
 *   - Otherwise: `http://${API_HOST||localhost}:${API_PORT||8002}`.
 */
function resolveApiBaseUrl(): string {
  const ns = process.env.SYSTEM_NAMESPACE
  if (ns) return `http://api.${ns}.svc.cluster.local`
  const apiPort = process.env.API_PORT || '8002'
  const apiHost = process.env.API_HOST || 'localhost'
  return `http://${apiHost}:${apiPort}`
}

async function mintToken(): Promise<string> {
  return generateProxyToken(
    SYSTEM_PROJECT_ID,
    SYSTEM_WORKSPACE_ID,
    undefined,
    TOKEN_EXPIRY_MS,
  )
}

function startRefreshTimer(): void {
  if (refreshTimer) return
  refreshTimer = setInterval(async () => {
    try {
      process.env.AI_PROXY_TOKEN = await mintToken()
      console.log('[InternalProxy] Refreshed server proxy token')
    } catch (err: any) {
      console.error(
        '[InternalProxy] Failed to refresh server proxy token:',
        err?.message ?? err,
      )
    }
  }, REFRESH_INTERVAL_MS)
  // Don't keep the event loop alive solely for the refresh timer.
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref()
}

/**
 * Ensure `AI_PROXY_URL` + `AI_PROXY_TOKEN` are set so the API server can call
 * its own in-process AI proxy for server-initiated LLM surfaces. No-op for any
 * value already configured. Safe to call once at boot.
 */
export async function ensureInternalProxyConfig(): Promise<void> {
  if (!process.env.AI_PROXY_URL) {
    process.env.AI_PROXY_URL = `${resolveApiBaseUrl()}/api/ai/v1`
    console.log('[InternalProxy] Set AI_PROXY_URL ->', process.env.AI_PROXY_URL)
  }

  if (!process.env.AI_PROXY_TOKEN) {
    try {
      process.env.AI_PROXY_TOKEN = await mintToken()
      console.log(
        '[InternalProxy] Minted server proxy token (proxy-jwt) for internal LLM surfaces',
      )
      startRefreshTimer()
    } catch (err: any) {
      // generateProxyToken throws in production when no signing secret is
      // configured. Surface loudly; title generation will fall back to a
      // heuristic name until an operator sets a signing secret.
      console.error(
        '[InternalProxy] Could not mint server proxy token — server-initiated LLM surfaces will fall back:',
        err?.message ?? err,
      )
    }
  }
}

/** Test-only: stop the refresh timer so it does not leak across test runs. */
export function __stopInternalProxyRefreshForTests(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
