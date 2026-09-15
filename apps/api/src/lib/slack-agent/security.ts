// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const MAX_CLOCK_SKEW_SECONDS = 5 * 60

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Verify Slack's signed request format:
 * `v0=<hex HMAC-SHA256("v0:<timestamp>:<raw body>")>`.
 *
 * The raw request body must be passed unchanged. Parsing and re-serializing
 * JSON before verification breaks Slack's signature.
 */
export function verifySlackSignature(args: {
  rawBody: string
  timestamp: string | undefined
  signature: string | undefined
  signingSecret: string | undefined
  nowMs?: number
}): boolean {
  const { rawBody, timestamp, signature, signingSecret } = args
  if (!signingSecret || !timestamp || !signature || !/^v0=[0-9a-f]{64}$/i.test(signature)) {
    return false
  }

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) return false
  const age = Math.abs((args.nowMs ?? Date.now()) / 1000 - timestampSeconds)
  if (age > MAX_CLOCK_SKEW_SECONDS) return false

  const base = `v0:${timestamp}:${rawBody}`
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`
  return safeEqual(expected, signature)
}

export interface SlackOAuthState {
  mode: 'install' | 'link'
  workspaceId?: string
  slackTeamId?: string
  slackUserId?: string
  userId?: string
  /**
   * The Slack message that triggered account-linking (mode: 'link' only).
   * Carried through the OAuth round-trip so the callback can both confirm
   * the link *and* resume the original request instead of making the user
   * repeat themselves in Slack. `pendingText` is truncated by the caller
   * to keep the signed state well under Slack's ~3000-char button `url`
   * limit — see `sendAccountLinkPrompt` in routes/slack-agent.ts.
   */
  pendingChannel?: string
  pendingThreadTs?: string
  pendingTs?: string
  pendingText?: string
  nonce: string
  expiresAt: number
}

/**
 * A short-lived, authenticated OAuth state. This keeps the OAuth callback
 * stateless while preventing a caller from swapping the target workspace or
 * Slack identity.
 */
export function createSlackOAuthState(
  value: Omit<SlackOAuthState, 'nonce' | 'expiresAt'>,
  secret: string,
  nowMs = Date.now(),
): string {
  const payload: SlackOAuthState = {
    ...value,
    nonce: randomUUID(),
    expiresAt: nowMs + 10 * 60 * 1000,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function verifySlackOAuthState(
  state: string,
  secret: string,
  nowMs = Date.now(),
): SlackOAuthState | null {
  const [encoded, signature] = state.split('.')
  if (!encoded || !signature || !secret) return null
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url')
  if (!safeEqual(expected, signature)) return null

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SlackOAuthState
    if (!parsed || (parsed.mode !== 'install' && parsed.mode !== 'link')) return null
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt < nowMs) return null
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length < 10) return null
    return parsed
  } catch {
    return null
  }
}

export const SLACK_SIGNATURE_MAX_CLOCK_SKEW_SECONDS = MAX_CLOCK_SKEW_SECONDS
