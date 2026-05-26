// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI_PROXY_TOKEN auto-rotation for long-lived runtime pods.
 *
 * Why this exists
 * ===============
 * `apps/api/src/lib/runtime/build-project-env.ts` generates `AI_PROXY_TOKEN`
 * as a 7-day HMAC-signed JWT. The token is injected into the runtime pod
 * once — at `/pool/assign` (warm-pool promotion) or at boot via
 * `checkSelfAssign()`. After injection it lives in `process.env` for the
 * lifetime of the process and is never refreshed.
 *
 * Knative warm-pool pods routinely outlive the token. A pod that was
 * promoted to a real project on day 0 and has not been evicted by day 8
 * will still hold the day-0 token, which expired on day 7. Every chat
 * request from then on fails with:
 *
 *   Provider error: 401 Invalid or missing proxy token.
 *
 * Restarting the pod clears the symptom — `checkSelfAssign()` on boot
 * fetches a fresh token — but it returns on day 15 unless the pod has
 * been restarted in the meantime. The token's TTL becomes a hidden
 * load-bearing operational constant.
 *
 * What this module does
 * =====================
 * After a pod has been assigned to a project (either via boot self-assign
 * or via `/pool/assign`), `startTokenRefreshLoop()` is invoked with a
 * `getProjectId()` closure. The loop:
 *
 *   1. Wakes up every REFRESH_INTERVAL_MS (12h) ± REFRESH_JITTER_MS (±1h),
 *      so a fleet of promoted pods doesn't stampede the API.
 *   2. Re-hits the same endpoint `checkSelfAssign` uses on boot —
 *      `${apiUrl}/api/internal/pod-config/<projectId>` — using the same
 *      ServiceAccount-token auth.
 *   3. Applies the response's env to `process.env`. Any short-lived
 *      credential the API mints (AI_PROXY_TOKEN, RUNTIME_AUTH_SECRET,
 *      WEBHOOK_TOKEN, COMPOSIO_API_KEY) rotates transparently.
 *   4. Calls back into the runtime's `onTokenRotate` hook (if provided),
 *      so the runtime can rebuild model clients that captured the old
 *      token at construction time. Most LLM SDKs read env at request
 *      time IF constructed without an explicit apiKey, so the hook is
 *      optional belt-and-suspenders.
 *   5. ALSO inspects the new `AI_PROXY_TOKEN`'s JWT `exp` claim. If exp
 *      minus 24h is sooner than the next scheduled tick, schedules an
 *      earlier refresh. Adapts to whatever TTL the API decides to mint
 *      (today 7d, tomorrow possibly shorter or longer) without code
 *      changes here.
 *
 * Failure mode is silent retry: a 5xx or network error logs and waits
 * for the next tick. The current token is valid for days, so a transient
 * upstream blip does not cause an outage.
 *
 * What this module does NOT do
 * ============================
 * - Active-session rotation. A WebSocket chat session that started
 *   moments before rotation finishes the turn with whichever token
 *   it captured. The API's verifier checks `exp` strictly — no
 *   leeway, no grace window — so a session that captured a token
 *   within milliseconds of its expiry could 401 mid-turn. In
 *   practice this is fine because refresh happens ≥24h before
 *   expiry: the worst-case live session has hours of headroom on
 *   the OLD token, and any session constructed after rotation uses
 *   the NEW token. If the API ever adds verifier leeway, the
 *   already-large headroom only widens.
 * - HMAC secret rotation. If `AI_PROXY_SECRET` on the API is rotated,
 *   every existing token becomes invalid instantly. The next refresh
 *   tick recovers the runtime, but a brief outage is unavoidable
 *   unless the API does dual-signing during rotation. Out of scope
 *   for this fix.
 *
 * See also
 * ========
 * - apps/api/src/lib/ai-proxy-token.ts        — token generation / verification
 * - apps/api/src/lib/runtime/build-project-env.ts — token TTL choice
 * - packages/shared-runtime/src/self-assign.ts — boot-time fetch (same API)
 * - apps/api/src/routes/internal/pod-config.ts — refresh endpoint
 */

import { configureAIProxy } from './ai-proxy'
import { deriveApiUrl, readSAToken } from './self-assign'

/** Default cadence: 12 hours. Well under the 7-day token TTL. */
const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

/** Jitter window: ±1 hour, so fleet-wide refreshes don't stampede. */
const DEFAULT_JITTER_MS = 60 * 60 * 1000

/** How early before `exp` to refresh, when JWT exp is parseable. */
const DEFAULT_REFRESH_BEFORE_EXP_MS = 24 * 60 * 60 * 1000

/** Network timeout for the refresh fetch. Matches self-assign on boot. */
const FETCH_TIMEOUT_MS = 30_000

export interface TokenRefreshOptions {
  /** Read the project ID at refresh time — must reflect the latest assignment. */
  getProjectId: () => string | null | undefined
  /** Display name used in log prefixes. */
  logPrefix?: string
  /** Override the refresh cadence. Useful in tests. */
  intervalMs?: number
  /** Override the jitter window. Set to 0 to disable. */
  jitterMs?: number
  /** Override "how early before token exp to refresh." */
  refreshBeforeExpMs?: number
  /**
   * Optional callback invoked after process.env has been updated with the
   * fresh env. Runtimes can use this to rebuild model clients that captured
   * the old token at construction. Errors thrown here are caught and logged
   * — they never abort the refresh loop.
   */
  onTokenRotate?: (env: Record<string, string>) => void | Promise<void>
}

export interface TokenRefreshHandle {
  /** Stop the loop. Safe to call multiple times. */
  stop: () => void
  /**
   * Force an immediate refresh (in addition to the scheduled cadence).
   * Returns the new env on success, or null on failure.
   * Exposed primarily for tests.
   */
  refreshNow: () => Promise<Record<string, string> | null>
}

/**
 * Start the AI_PROXY_TOKEN refresh loop. Idempotent per-process — callers
 * should not start two loops; if you need to restart with new options,
 * `stop()` the existing handle first.
 */
export function startTokenRefreshLoop(options: TokenRefreshOptions): TokenRefreshHandle {
  const prefix = options.logPrefix ?? 'token-refresh'
  const intervalMs = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS
  const refreshBeforeExpMs = options.refreshBeforeExpMs ?? DEFAULT_REFRESH_BEFORE_EXP_MS

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  // Single-flight guard for refresh(). Both the scheduled tick and a public
  // `refreshNow()` call route through the same refresh function; without
  // coalescing, concurrent invocations each call schedule() in their
  // `finally`, which would leak setTimeouts.
  let inflight: Promise<Record<string, string> | null> | null = null

  const computeNextDelay = (): number => {
    const jitter = jitterMs > 0
      ? Math.floor((Math.random() * 2 - 1) * jitterMs)
      : 0
    const baseDelay = Math.max(1_000, intervalMs + jitter)

    // If we can read the new token's expiry, prefer (exp - refreshBeforeExpMs)
    // when that's sooner than the scheduled tick. Adapts to API-side TTL
    // changes without code edits here.
    const token = process.env.AI_PROXY_TOKEN
    if (token) {
      const exp = readJwtExpMs(token)
      if (exp) {
        const expDriven = exp - Date.now() - refreshBeforeExpMs
        if (expDriven > 0 && expDriven < baseDelay) {
          return expDriven
        }
      }
    }
    return baseDelay
  }

  const schedule = () => {
    if (stopped) return
    // Cancel any previously-pending tick before installing a new one.
    // Required for safety under concurrent refresh(): without this, two
    // overlapping refresh() calls would each schedule a fresh setTimeout
    // in their finally, leaking timers that compound over time.
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const delay = computeNextDelay()
    timer = setTimeout(() => {
      void refresh()
    }, delay)
    // Don't keep the event loop alive for the refresh timer — if the runtime
    // is otherwise idle and Bun/Node wants to exit, we don't block it.
    // The `as any` cast bridges the Bun/Node setTimeout return-type
    // difference; both runtimes expose `.unref()` at runtime.
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref()
  }

  const refresh = (): Promise<Record<string, string> | null> => {
    // Single-flight: a concurrent caller gets the in-flight promise back
    // instead of starting a second refresh + schedule cycle.
    if (inflight) return inflight
    inflight = doRefresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  const doRefresh = async (): Promise<Record<string, string> | null> => {
    try {
      const projectId = options.getProjectId()
      if (!projectId || projectId === '__POOL__') {
        // Pod is back in the warm pool — nothing to refresh. Reschedule
        // so we pick up rotation the next time it gets promoted.
        return null
      }

      // deriveApiUrl()'s fallback chain ends at the in-cluster ClusterIP
      // (`http://api.${SYSTEM_NAMESPACE||shogo-system}.svc.cluster.local`),
      // so it never returns null. The previous `if (!apiUrl)` defensive
      // check was dead — removed in coverage cleanup.
      const apiUrl = deriveApiUrl()

      const saToken = readSAToken()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (saToken) headers['Authorization'] = `Bearer ${saToken}`

      const url = `${apiUrl}/api/internal/pod-config/${projectId}`
      const startedAt = Date.now()
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[${prefix}] refresh got ${res.status}: ${body.slice(0, 200)}`)
        return null
      }

      const data = await res.json() as { projectId: string; env: Record<string, string> }
      if (!data?.env || typeof data.env !== 'object') {
        console.warn(`[${prefix}] refresh response missing env`)
        return null
      }

      // Apply env to process.env. Note: we do NOT clear keys that the API
      // omits — the refresh endpoint is the source of truth for what's
      // *new*, not for unsetting values.
      for (const [key, value] of Object.entries(data.env)) {
        if (typeof value === 'string') process.env[key] = value
      }

      // Spread AI proxy URL/key/base-url derivatives so SDK clients that
      // read these at request time see fresh values.
      try {
        const cfg = configureAIProxy({ logPrefix: prefix })
        if (cfg.useProxy) Object.assign(process.env, cfg.env)
      } catch (err: any) {
        // configureAIProxy throws if URL is set but token is empty —
        // shouldn't happen post-refresh, but if the API returned a
        // malformed env we shouldn't bring down the loop.
        console.warn(`[${prefix}] configureAIProxy after refresh failed: ${err?.message ?? err}`)
      }

      // Notify the runtime. Errors in the hook are logged and swallowed —
      // they must not abort the refresh loop.
      if (options.onTokenRotate) {
        try {
          await options.onTokenRotate(data.env)
        } catch (hookErr: any) {
          console.warn(`[${prefix}] onTokenRotate threw: ${hookErr?.message ?? hookErr}`)
        }
      }

      const elapsed = Date.now() - startedAt
      console.log(`[${prefix}] rotated AI_PROXY_TOKEN for ${projectId} in ${elapsed}ms`)
      return data.env
    } catch (err: any) {
      console.warn(`[${prefix}] refresh error: ${err?.message ?? err}`)
      return null
    } finally {
      schedule()
    }
  }

  schedule()

  return {
    stop: () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    refreshNow: refresh,
  }
}

/**
 * Decode a JWT's `exp` claim without verifying the signature. We only use
 * the value to schedule a refresh — never for auth — so signature
 * verification isn't required and we deliberately avoid pulling in a
 * jwt-decode library for one numeric field.
 *
 * Returns the expiry as a millisecond Unix timestamp, or null if the
 * token is not a parseable JWT, has no `exp` claim, or has an exp that
 * isn't a number.
 */
export function readJwtExpMs(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payloadB64 = parts[1]
    // base64url → base64. Buffer.from handles padding tolerantly.
    const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(
      Buffer.from(normalized, 'base64').toString('utf-8'),
    )
    const exp = payload?.exp
    if (typeof exp !== 'number') return null
    return exp * 1000
  } catch {
    return null
  }
}
