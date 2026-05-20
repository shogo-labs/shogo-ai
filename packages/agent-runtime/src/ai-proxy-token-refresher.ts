// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AI Proxy Token Refresher
 *
 * Rotates `process.env.AI_PROXY_TOKEN` in place inside a long-lived runtime
 * pod before the JWT exp elapses.
 *
 * Why this exists
 * ---------------
 * `AI_PROXY_TOKEN` is a short-lived HS256 JWT (default 24h, currently
 * provisioned with 7d at the call sites in `apps/api/src/lib/knative-
 * project-manager.ts` and `build-project-env.ts`). It's minted exactly
 * once per pod, at revision-creation time, and injected as a Knative env
 * var. Because Knative revision env is immutable, and project pods run
 * with `min-scale: 1` so they never recycle while heartbeat / Slack
 * traffic flows, the pod can outlive the credential it was issued with.
 * Once exp elapses every LLM call 401s and the agent silently no-ops.
 *
 * This module is the runtime-side half of the fix: it decodes the JWT
 * sitting in `process.env.AI_PROXY_TOKEN`, schedules a refresh well
 * before `exp`, calls `POST /api/internal/refresh-ai-proxy-token/:projectId`
 * with the pod's existing long-lived identity (K8s SA token or
 * `RUNTIME_AUTH_SECRET`, both already wired through `getInternalHeaders`),
 * and mutates `process.env.AI_PROXY_TOKEN` so every existing consumer
 * that reads from process.env naturally picks up the fresh value.
 *
 * Failure modes
 * -------------
 *  - Network blip / API down: exponential backoff, never gives up.
 *  - Token already expired at boot: refresh immediately.
 *  - PROJECT_ID / AI_PROXY_TOKEN not set: this is non-cloud runtime
 *    (e.g. external mode, headless eval). Module is a no-op.
 *  - Malformed JWT: log once, schedule a single-shot refresh attempt
 *    in 60s. After that we assume the API will keep it healthy.
 *
 * Public surface
 * --------------
 *  - `startAiProxyTokenRefresher()` — idempotent; safe to call from
 *    `initializeEssentials()`.
 *  - `forceRefreshAiProxyToken(reason?)` — trigger an immediate refresh
 *    (e.g. after observing a 401 from the AI proxy). Returns the new
 *    token on success, null on failure.
 *  - `stopAiProxyTokenRefresher()` — cancel the scheduled timer (for
 *    graceful shutdown and tests).
 */

import { deriveApiUrl, getInternalHeaders } from './internal-api'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Refresh this far ahead of `exp`. Picked to comfortably cover the
 *  pre-Knative-default 24h TTL: with a 1h margin we still rotate ~23h
 *  before the token would have failed. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000 // 1 hour

/** Floor on the scheduled delay — don't hot-loop if a token somehow has
 *  exp very close to now. */
const MIN_SCHEDULE_MS = 30 * 1000 // 30 seconds

/** Ceiling on the scheduled delay — even if the API ever issued an
 *  absurdly long token, we still re-check at most every 6h so a
 *  signing-secret rotation isn't blind for long. */
const MAX_SCHEDULE_MS = 6 * 60 * 60 * 1000 // 6 hours

/** Backoff schedule on transient refresh failures. After the last entry
 *  we stay at MAX_BACKOFF until success. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000]
const MAX_BACKOFF_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null
let started = false
let consecutiveFailures = 0
let inFlight: Promise<string | null> | null = null

// ---------------------------------------------------------------------------
// JWT decoding (no signature check — we don't have the secret in the pod;
// we just need to read `exp` to schedule ourselves).
// ---------------------------------------------------------------------------

interface DecodedExp { exp: number | null; valid: boolean }

function decodeExp(token: string | undefined): DecodedExp {
  if (!token) return { exp: null, valid: false }
  const parts = token.split('.')
  if (parts.length !== 3) return { exp: null, valid: false }
  try {
    // base64url → base64 → JSON
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf-8')
    const payload = JSON.parse(json) as { exp?: number }
    if (typeof payload.exp !== 'number') return { exp: null, valid: true }
    return { exp: payload.exp, valid: true }
  } catch {
    return { exp: null, valid: false }
  }
}

// ---------------------------------------------------------------------------
// Refresh + schedule
// ---------------------------------------------------------------------------

function scheduleNextRefresh(reason: string): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const projectId = process.env.PROJECT_ID
  if (!projectId) return

  const { exp, valid } = decodeExp(process.env.AI_PROXY_TOKEN)
  let delayMs: number

  if (consecutiveFailures > 0) {
    // We've been failing — ignore the schedule and use backoff.
    const idx = Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)
    delayMs = idx < 0 ? BACKOFF_MS[0] : BACKOFF_MS[idx]
    if (consecutiveFailures > BACKOFF_MS.length) delayMs = MAX_BACKOFF_MS
  } else if (!valid) {
    // Malformed token — try once in a minute.
    delayMs = 60_000
  } else if (exp === null) {
    // Valid JWT shape but no exp field. Re-check at the ceiling.
    delayMs = MAX_SCHEDULE_MS
  } else {
    const nowMs = Date.now()
    const expMs = exp * 1000
    delayMs = expMs - REFRESH_MARGIN_MS - nowMs
    if (delayMs < MIN_SCHEDULE_MS) delayMs = MIN_SCHEDULE_MS
    if (delayMs > MAX_SCHEDULE_MS) delayMs = MAX_SCHEDULE_MS
  }

  timer = setTimeout(() => {
    timer = null
    refreshOnce(`scheduled (${reason})`).catch(() => { /* logged inside */ })
  }, delayMs)
  // Don't block process exit on this timer.
  if (typeof (timer as any).unref === 'function') (timer as any).unref()

  const human = Math.round(delayMs / 1000)
  console.log(`[ai-proxy-token-refresher] next refresh in ${human}s (reason: ${reason}, failures: ${consecutiveFailures})`)
}

async function refreshOnce(reason: string): Promise<string | null> {
  // De-dupe: if a refresh is already in flight, return the same promise.
  if (inFlight) return inFlight

  const projectId = process.env.PROJECT_ID
  if (!projectId) {
    // No project context — nothing to refresh, nothing to schedule.
    return null
  }

  const apiUrl = deriveApiUrl()
  if (!apiUrl) {
    console.warn('[ai-proxy-token-refresher] no API URL derivable; skipping refresh')
    consecutiveFailures++
    scheduleNextRefresh('no-api-url')
    return null
  }

  const url = `${apiUrl.replace(/\/+$/, '')}/api/internal/refresh-ai-proxy-token/${encodeURIComponent(projectId)}`

  inFlight = (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: getInternalHeaders(),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[ai-proxy-token-refresher] refresh failed (${reason}): HTTP ${res.status} ${body.slice(0, 200)}`)
        consecutiveFailures++
        scheduleNextRefresh(`http-${res.status}`)
        return null
      }

      const data = (await res.json().catch(() => null)) as { token?: string; exp?: number } | null
      if (!data?.token) {
        console.warn(`[ai-proxy-token-refresher] refresh response missing token (${reason})`)
        consecutiveFailures++
        scheduleNextRefresh('bad-response')
        return null
      }

      process.env.AI_PROXY_TOKEN = data.token
      consecutiveFailures = 0
      console.log(`[ai-proxy-token-refresher] rotated AI_PROXY_TOKEN (${reason}, exp=${data.exp ?? 'unknown'})`)
      scheduleNextRefresh('post-success')
      return data.token
    } catch (err: any) {
      console.warn(`[ai-proxy-token-refresher] refresh threw (${reason}): ${err?.message ?? err}`)
      consecutiveFailures++
      scheduleNextRefresh('threw')
      return null
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the background refresher. Idempotent — calling twice is a no-op.
 * Safe to call before AI_PROXY_TOKEN is set; it will just schedule a
 * single re-check.
 */
export function startAiProxyTokenRefresher(): void {
  if (started) return
  started = true

  const projectId = process.env.PROJECT_ID
  if (!projectId) {
    console.log('[ai-proxy-token-refresher] no PROJECT_ID; refresher will stay idle')
    return
  }

  const { exp, valid } = decodeExp(process.env.AI_PROXY_TOKEN)
  const nowS = Math.floor(Date.now() / 1000)

  if (!valid || exp === null) {
    console.log('[ai-proxy-token-refresher] no usable AI_PROXY_TOKEN at boot; scheduling re-check')
    scheduleNextRefresh('boot-no-token')
    return
  }

  if (exp - nowS <= REFRESH_MARGIN_MS / 1000) {
    // Already inside the refresh window (or past exp) — refresh now.
    console.log(`[ai-proxy-token-refresher] token is within margin at boot (exp=${exp}, now=${nowS}); refreshing immediately`)
    refreshOnce('boot-immediate').catch(() => { /* logged inside */ })
    return
  }

  scheduleNextRefresh('boot')
}

/**
 * Trigger an immediate refresh. Intended for use by callers that just saw
 * a 401 from the AI proxy and want to recover inline before retrying the
 * request. Returns the new token on success, null on failure.
 */
export function forceRefreshAiProxyToken(reason: string = 'forced'): Promise<string | null> {
  return refreshOnce(reason)
}

/** Cancel the scheduled refresh. Mostly for tests and graceful shutdown. */
export function stopAiProxyTokenRefresher(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  started = false
  consecutiveFailures = 0
}
