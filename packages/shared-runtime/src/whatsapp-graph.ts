// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared WhatsApp Graph API constants and utilities used by both
 * packages/agent-runtime (per-project adapter) and apps/api (platform webhook).
 * Keeping them here ensures one Graph version and one signature-check
 * implementation across the whole codebase.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** WhatsApp Cloud API Graph version used for all calls. */
export const WHATSAPP_GRAPH_VERSION = 'v22.0'

/** Base URL for the WhatsApp Graph API. */
export const WHATSAPP_API_BASE = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`

/**
 * Verify a Meta `x-hub-signature-256` HMAC-SHA256 header.
 *
 * @param rawBody   Raw request body bytes (before JSON.parse).
 * @param header    Value of the `x-hub-signature-256` header (e.g. `sha256=abc123`).
 * @param appSecret App secret from Meta App → Basic Settings.
 * @returns `true` if the signature is valid, `false` otherwise.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyMetaSignature(rawBody: string, header: string, appSecret: string): boolean {
  if (!header || !appSecret) return false
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
  const receivedBuf = Buffer.from(header)
  const expectedBuf = Buffer.from(expected)
  if (receivedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(receivedBuf, expectedBuf)
}
