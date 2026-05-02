// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Build a user-readable `Error` from a non-OK terminal-route `Response`.
 *
 * Two-step strategy that matches the original inline implementation in
 * `Terminal.tsx`:
 *
 *   1. JSON bodies: pull `error.message` (object) or `error` (string)
 *      out of the parsed payload.
 *   2. Anything else: strip tags, collapse whitespace, prepend the
 *      caller-supplied `fallback`, cap at 160 chars.
 *
 * Callers are expected to detect content-type-specific error shapes
 * (e.g. `text/html` → "Terminal endpoint returned HTML…") *before*
 * calling this helper, by passing the appropriate `fallback`. The
 * helper purposely doesn't try to be smarter than that — keeping the
 * branching at the call site keeps the contract auditable.
 *
 * The function is `async` because reading the body is — once consumed,
 * the response cannot be re-read, so callers should `throw` immediately.
 */
export async function readTerminalError(
  res: Response,
  fallback: string,
): Promise<Error> {
  const contentType = res.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string } | string
    }
    const message =
      typeof body.error === 'string' ? body.error : body.error?.message
    return new Error(message ?? fallback)
  }

  const text = await res.text().catch(() => '')
  const trimmed = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return new Error(trimmed ? `${fallback}: ${trimmed.slice(0, 160)}` : fallback)
}
