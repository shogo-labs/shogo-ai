// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signed state for the "authorize the Shogo GitHub App" round-trip.
 *
 * The flow crosses two GitHub pages (App install/configure, then OAuth
 * authorize) and lands on a public callback with no Shogo session, so the
 * target project and repository travel in an HMAC-signed, expiring state
 * instead of server-side storage. The callback still proves the GitHub user
 * can access the installation it connects (see routes/github.ts).
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const STATE_TTL_MS = 30 * 60 * 1000

export interface GitHubAuthorizeState {
  projectId: string
  repoOwner: string
  repoName: string
  /** Shogo user who started the flow (Studio); absent when the agent made the link. */
  userId?: string
  /** Installation GitHub reported on the install/configure redirect. */
  installationId?: number
  /** Times the user was sent back to the install page to grant this repo. */
  installAttempts?: number
  nonce: string
  expiresAt: number
}

export function githubStateSecret(): string {
  return process.env.BETTER_AUTH_SECRET || process.env.GH_APP_WEBHOOK_SECRET || ''
}

export function createGitHubAuthorizeState(
  value: Omit<GitHubAuthorizeState, 'nonce' | 'expiresAt'>,
  secret = githubStateSecret(),
  nowMs = Date.now(),
): string {
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to sign GitHub authorization state')
  const payload: GitHubAuthorizeState = { ...value, nonce: randomUUID(), expiresAt: nowMs + STATE_TTL_MS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function verifyGitHubAuthorizeState(
  state: string,
  secret = githubStateSecret(),
  nowMs = Date.now(),
): GitHubAuthorizeState | null {
  const [encoded, signature] = state.split('.')
  if (!encoded || !signature || !secret) return null
  const expected = Buffer.from(createHmac('sha256', secret).update(encoded).digest('base64url'))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as GitHubAuthorizeState
    if (typeof parsed?.projectId !== 'string' || !parsed.projectId) return null
    if (typeof parsed.repoOwner !== 'string' || typeof parsed.repoName !== 'string') return null
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt < nowMs) return null
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length < 10) return null
    return parsed
  } catch {
    return null
  }
}

/** Re-sign a verified state with new fields for the next leg of the flow. */
export function advanceGitHubAuthorizeState(
  state: GitHubAuthorizeState,
  changes: Partial<Pick<GitHubAuthorizeState, 'installationId' | 'installAttempts'>>,
  secret = githubStateSecret(),
): string {
  const { nonce: _nonce, expiresAt: _expiresAt, ...rest } = state
  return createGitHubAuthorizeState({ ...rest, ...changes }, secret)
}
