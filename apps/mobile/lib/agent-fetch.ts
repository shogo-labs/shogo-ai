// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { authClient } from './auth-client'

/**
 * The headers a native request to an authenticated URL needs, for a caller that
 * cannot use `fetch` — a download streamed to disk by `expo-file-system`, which
 * takes headers but no request init. Web needs none: the browser sends the
 * session cookie itself.
 */
export function nativeAuthHeaders(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

/**
 * Statuses that can mean "the desktop hosting this workspace is waking": the
 * cloud answers `503 host_connecting` / `504 host_runtime_starting` itself rather
 * than holding the request until the edge gives up (SHO-538).
 */
const WAKE_STATUSES = new Set([503, 504])

/** How long a retried GET may keep trying, all waits included. */
const WAKE_RETRY_TOTAL_MS = 60_000

/** Longest single wait, whatever the host asks for. */
const WAKE_RETRY_MAX_WAIT_MS = 15_000

/** When a refusal names no delay at all. */
const WAKE_RETRY_DEFAULT_WAIT_MS = 5_000

/** Only a request that changes nothing may be sent twice. */
function isRetryableMethod(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

/** `Retry-After` is seconds (or an HTTP date); the body may carry the same number. */
function declaredWaitMs(retryAfter: string | null, retryAfterSeconds: unknown): number {
  const seconds = Number((retryAfter ?? '').trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const fromDate = retryAfter ? Date.parse(retryAfter) : NaN
  if (Number.isFinite(fromDate)) return Math.max(0, fromDate - Date.now())
  const bodySeconds = Number(retryAfterSeconds)
  if (Number.isFinite(bodySeconds) && bodySeconds >= 0) return bodySeconds * 1000
  return WAKE_RETRY_DEFAULT_WAIT_MS
}

/**
 * A body already read, handed back as the response the caller asked for. A
 * refusal is JSON, so nothing is lost by buffering it — and it is the only way
 * to read `retryable` before deciding whether to send the request again.
 */
function buffered(res: Response, text: string): Response {
  const headers = new Headers(res.headers)
  for (const stale of ['content-encoding', 'content-length', 'transfer-encoding']) headers.delete(stale)
  return new Response(text, { status: res.status, statusText: res.statusText, headers })
}

/**
 * How long to wait before asking again, or `null` for a response the caller must
 * see as-is. `text` is the body it was decided from — `null` when the body was
 * never read, so the response is still the caller's to consume.
 */
async function wakeWaitMs(res: Response): Promise<{ waitMs: number | null; text: string | null }> {
  if (!WAKE_STATUSES.has(res.status)) return { waitMs: null, text: null }
  const text = await res.text().catch(() => '')
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    // Not ours (an edge's HTML error page, say) — nothing to retry on.
    return { waitMs: null, text }
  }
  const refusal = body?.error
  if (refusal?.retryable !== true) return { waitMs: null, text }
  return { waitMs: declaredWaitMs(res.headers.get('retry-after'), refusal.retryAfterSeconds), text }
}

/**
 * Send a request that changes nothing, and try it once more if the answer says
 * the host is still coming up (SHO-538).
 *
 * A hosted workspace's runtime call can arrive while its desktop's tunnel is
 * opening; the cloud says so (`503`/`504` with `retryable: true`) instead of
 * holding the request past Cloudflare's edge. Waiting the few seconds the host
 * asks for turns that into the answer the caller wanted, without a refresh.
 * Nothing else is retried, and the last response is returned once the total cap
 * is spent so the caller still sees the real error.
 */
export async function fetchWithWakeRetry(
  send: () => Promise<Response>,
  opts: { totalMs?: number; maxWaitMs?: number } = {},
): Promise<Response> {
  const totalMs = opts.totalMs ?? WAKE_RETRY_TOTAL_MS
  const maxWaitMs = opts.maxWaitMs ?? WAKE_RETRY_MAX_WAIT_MS
  const deadline = Date.now() + totalMs

  let res = await send()
  for (;;) {
    const { waitMs, text } = await wakeWaitMs(res)
    if (waitMs === null) return text === null ? res : buffered(res, text)

    const wait = Math.min(waitMs, maxWaitMs)
    if (Date.now() + wait > deadline) return buffered(res, text ?? '')
    await new Promise((resolve) => setTimeout(resolve, wait))
    res = await send()
  }
}

/**
 * The message inside a failed agent call.
 *
 * `AgentClient` throws `Agent API <status>: <body>`, where the body is the
 * cloud's JSON refusal — "Studio Mac is online (seen 20s ago) but its connection
 * is still opening". Showing that beats a generic failure, and a non-JSON body
 * (an edge's HTML page) is never shown at all: the caller's own wording is better
 * than a wall of markup.
 */
export function agentErrorMessage(err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : null
  if (!text) return null
  const jsonAt = text.indexOf('{')
  if (jsonAt === -1) return null
  try {
    const body = JSON.parse(text.slice(jsonAt))
    const message = body?.error?.message ?? body?.message
    return typeof message === 'string' && message.trim() ? message : null
  } catch {
    return null
  }
}

/**
 * Wraps `fetch` with the correct auth credentials for agent-proxy requests.
 *
 * On web: adds `credentials: 'include'` so the browser sends session cookies
 * cross-origin (web app :8081 -> API :8002).
 *
 * On native: reads the session cookie from Expo SecureStore via Better Auth's
 * `getCookie()` and passes it as a `Cookie` header (native `fetch` doesn't
 * send cookies automatically).
 *
 * A GET or HEAD that arrives while a hosted workspace's desktop is still waking
 * is retried once the host says it is up (SHO-538) — this is the one place every
 * agent-proxy loader goes through, so no caller has to know about the wake.
 */
export function agentFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const isWeb = Platform.OS === 'web'
  const extraHeaders: Record<string, string> = {}

  if (!isWeb) {
    const cookie = (authClient as any).getCookie?.()
    if (cookie) extraHeaders['Cookie'] = cookie
  }

  const send = () =>
    fetch(input, {
      ...init,
      headers: { ...extraHeaders, ...(init?.headers as Record<string, string>) },
      credentials: isWeb ? 'include' : 'omit',
    })

  return isRetryableMethod(init) ? fetchWithWakeRetry(send) : send()
}
