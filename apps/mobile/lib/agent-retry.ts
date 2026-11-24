// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Retrying a request whose host is still waking (SHO-538).
 *
 * A hosted workspace's runtime call can arrive while its desktop's tunnel is
 * opening. The cloud says so rather than holding the request past Cloudflare's
 * edge: `503 host_connecting` / `504 host_runtime_starting`, both marked
 * `retryable` with a `Retry-After`. Waiting the few seconds the host asks for
 * turns that into the answer the caller wanted, without a refresh.
 *
 * Kept apart from `agent-fetch.ts` so a test (or the app's own preload, which
 * swaps that module out wholesale) can reach these pure helpers without the
 * session-cookie path.
 */

/**
 * Statuses that can mean "the desktop hosting this workspace is waking": the
 * cloud answers these itself instead of holding the request until the edge gives
 * up (SHO-538).
 */
const WAKE_STATUSES = new Set([503, 504])

/** How long a retried GET may keep trying, all waits included. */
export const WAKE_RETRY_TOTAL_MS = 60_000

/** Longest single wait, whatever the host asks for. */
export const WAKE_RETRY_MAX_WAIT_MS = 15_000

/** When a refusal names no delay at all. */
const WAKE_RETRY_DEFAULT_WAIT_MS = 5_000

/**
 * Only a request that changes nothing may be sent twice: a `POST` that wakes a
 * host may already have run when the refusal comes back.
 */
export function isWakeRetryable(method: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase()
  return verb === 'GET' || verb === 'HEAD'
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
 * refusal is JSON, so nothing is lost by buffering it — and it is the only way to
 * read `retryable` before deciding whether to send the request again.
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
 * Send a request that changes nothing, and try it again if the answer says the
 * host is still coming up.
 *
 * Nothing else is retried, and the last response is returned once the total cap
 * is spent so the caller still sees the real error. Callers pass a `send` that
 * builds the whole request again, because a `Response` cannot be replayed.
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
 * (an edge's HTML page) is never shown at all: the caller's own wording is far
 * better than a wall of markup.
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
