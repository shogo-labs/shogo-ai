// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Long-running JSON responses that survive proxy idle timeouts.
 *
 * Cloudflare answers 524 when an origin sends nothing for ~100s. This sends
 * the 200 headers straight away, writes a single space every `intervalMs`
 * while `work` is pending, then the final JSON. JSON parsers skip leading
 * whitespace, so clients just `res.json()` the body. The real status can't
 * go in the status line any more (it is already sent), so it is carried in
 * the body as `httpStatus`.
 *
 * Only for clients that opt in with `X-Shogo-Keepalive: 1`; others would
 * read a 200 for a failed call.
 */

export const KEEPALIVE_HEADER = 'x-shogo-keepalive'

export function wantsKeepAlive(header: string | undefined | null): boolean {
  return header === '1' || header?.toLowerCase() === 'true'
}

export interface KeepAliveOutcome {
  status: number
  body: unknown
}

export function keepAliveJson(
  work: Promise<KeepAliveOutcome>,
  opts: { intervalMs?: number } = {},
): Response {
  const intervalMs = opts.intervalMs ?? 15_000
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          closed = true
        }
      }
      // One byte right away so the proxy sees the response start immediately.
      write(' ')
      timer = setInterval(() => write(' '), intervalMs)
      work
        .then(
          (outcome) => {
            const body = outcome.body && typeof outcome.body === 'object' && !Array.isArray(outcome.body)
              ? { httpStatus: outcome.status, ...(outcome.body as Record<string, unknown>) }
              : { httpStatus: outcome.status, body: outcome.body }
            write(JSON.stringify(body))
          },
          (err: any) => {
            write(JSON.stringify({
              httpStatus: 500,
              error: { code: 'internal_error', message: err?.message ?? String(err) },
            }))
          },
        )
        .finally(() => {
          if (timer) clearInterval(timer)
          if (!closed) {
            closed = true
            try { controller.close() } catch { /* already closed */ }
          }
        })
    },
    cancel() {
      closed = true
      if (timer) clearInterval(timer)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
