// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Small crypto helpers shared across the API.
 *
 * Consolidated here so there's a single, reviewable implementation of
 * constant-time string comparison. Previously copy-pasted in:
 *   - middleware/auth.ts (runtime-token validation)
 *   - lib/twilio.ts      (Twilio webhook signature)
 *   - lib/voice-meter.ts (ElevenLabs webhook signature)
 *
 * Keeping one source of truth means every new token/signature check we
 * add inherits the same side-channel properties and we don't have to
 * audit three variants whenever requirements shift.
 *
 * See: apps/api/src/lib/runtime-token.md §6 "Timing-safe comparison is
 * mandatory" for why this matters.
 */

import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time string equality for secrets (tokens, HMAC digests).
 *
 * - Returns `false` when the lengths differ. This is NOT a side-channel
 *   leak: the valid secret's length is either a well-known constant
 *   (HMAC-SHA256 hex = 64 chars, SHA1 base64 = 28 chars, etc.) or the
 *   caller has already normalized lengths upstream. Letting the length
 *   check return early keeps `timingSafeEqual` happy (it throws on
 *   unequal-length buffers) without leaking anything an attacker didn't
 *   already know.
 * - Compares byte buffers, not strings, so UTF-8 encoding is explicit.
 *
 * Never replace with `===`, `Buffer.compare`, or a bare
 * `timingSafeEqual` without the length guard — any of those will either
 * leak a prefix of the valid secret or throw.
 */
export function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Constant-time buffer equality. Use when you already have `Buffer`s
 * in hand (e.g. webhook signature verification that decodes base64
 * into bytes before comparing).
 */
export function safeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Redact a set of sensitive headers for logging.
 *
 * Pass a Headers object or a plain `{[k]: string}` — returns a shallow
 * copy with the named headers replaced by a short fingerprint
 * (`"<length>c:<first4>…"`) instead of the full value. The fingerprint
 * is still useful for "did the token change between requests?" debugging
 * without putting the bearer capability into log storage.
 *
 * Default sensitive list covers the headers that appear in this
 * codebase's auth paths: runtime-token, session cookies, the two
 * tunnel-auth headers, and the stock `Authorization`. Extend via
 * `extraSensitive` when adding new credential headers.
 *
 * See: apps/api/src/lib/runtime-token.md §§4, 6, and "Log redaction"
 * for the rationale — pod log pipelines are NOT a place to ship
 * runtime tokens.
 */
const DEFAULT_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-runtime-token',
  'x-tunnel-auth-user-id',
  'x-tunnel-auth-email',
  'x-tunnel-auth-name',
  'x-api-key',
  'x-shogo-api-key',
])

export function redactSensitiveHeaders(
  headers: Record<string, string | undefined> | Headers | undefined,
  extraSensitive: readonly string[] = [],
): Record<string, string> {
  if (!headers) return {}
  const sensitive = new Set(
    [...DEFAULT_SENSITIVE_HEADERS, ...extraSensitive.map((h) => h.toLowerCase())],
  )
  const out: Record<string, string> = {}
  const write = (rawKey: string, value: string | undefined) => {
    if (value === undefined || value === null) return
    const key = rawKey.toLowerCase()
    if (sensitive.has(key)) {
      out[key] = fingerprintSecret(value)
    } else {
      out[key] = value
    }
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => write(key, value))
  } else {
    for (const [k, v] of Object.entries(headers)) write(k, v)
  }
  return out
}

/**
 * Turn a secret into a non-reversible fingerprint for log lines.
 * Format: `"<len>c:<first4>…"`. Avoids printing any substring that
 * would help an attacker brute-force the remainder.
 */
export function fingerprintSecret(value: string): string {
  if (!value) return '(empty)'
  const len = value.length
  const head = value.slice(0, 4)
  return `${len}c:${head}…`
}
