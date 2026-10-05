// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo outbound webhook signatures. Every delivery carries
 *
 *   Shogo-Event-Id:   evt id (stable across retries; dedupe on it)
 *   Shogo-Timestamp:  unix seconds when this attempt was signed
 *   Shogo-Signature:  v1=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
 *
 * Uses Web Crypto so it runs in Node 18+, Bun, Deno, workers and browsers.
 */

export const SHOGO_SIGNATURE_HEADER = 'shogo-signature'
export const SHOGO_TIMESTAMP_HEADER = 'shogo-timestamp'
export const SHOGO_EVENT_ID_HEADER = 'shogo-event-id'

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function signShogoWebhook(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)): Promise<{
  timestamp: string
  signature: string
}> {
  const ts = String(timestamp)
  return { timestamp: ts, signature: `v1=${await hmacHex(secret, `${ts}.${body}`)}` }
}

export interface VerifyShogoSignatureInput {
  /** The raw request body, exactly as received. */
  body: string
  /** `Shogo-Signature` header. Several space-separated `v1=` values are accepted during secret rotation. */
  signature: string | null | undefined
  /** `Shogo-Timestamp` header. */
  timestamp: string | null | undefined
  secret: string
  /** Max age in seconds (default 300). 0 disables the check. */
  toleranceSeconds?: number
  now?: number
}

/** True when the request was signed with `secret` within the tolerance window. */
export async function verifyShogoSignature(input: VerifyShogoSignatureInput): Promise<boolean> {
  if (!input.signature || !input.timestamp || !input.secret) return false
  const ts = Number(input.timestamp)
  if (!Number.isFinite(ts)) return false
  const tolerance = input.toleranceSeconds ?? 300
  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (tolerance > 0 && Math.abs(now - ts) > tolerance) return false
  const expected = `v1=${await hmacHex(input.secret, `${input.timestamp}.${input.body}`)}`
  return input.signature.split(' ').some((candidate) => timingSafeEqual(candidate.trim(), expected))
}
