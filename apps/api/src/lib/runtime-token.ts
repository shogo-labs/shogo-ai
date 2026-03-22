// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-Project Runtime Token Derivation
 *
 * Derives deterministic, project-scoped tokens for authenticating
 * API→runtime and external→runtime requests using HMAC-SHA256.
 *
 * Tokens are derived from the platform signing secret + projectId,
 * so the API can recompute them at any time without storage.
 * Each project gets unique tokens — if an agent reads its own token
 * via `env`, it can only authenticate to itself (zero blast radius).
 *
 * Two token types:
 *   - runtime-auth: API server → agent/project runtime (internal RPC)
 *   - webhook: external services → agent runtime webhook endpoints
 */

import { createHmac } from 'crypto'

function getSigningSecret(): string {
  const secret =
    process.env.AI_PROXY_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[RuntimeToken] FATAL: No signing secret configured. ' +
        'Set AI_PROXY_SECRET or BETTER_AUTH_SECRET.'
    )
  }

  return 'shogo-dev-only-runtime-token-secret'
}

/**
 * Derive a per-project runtime auth token.
 * Used by the API when proxying requests to a specific project's runtime pod.
 */
export function deriveRuntimeToken(projectId: string): string {
  return createHmac('sha256', getSigningSecret())
    .update(`runtime-auth:${projectId}`)
    .digest('hex')
}

/**
 * Derive a per-project webhook token.
 * Given to external integrations that need to call a specific agent's webhook endpoints.
 */
export function deriveWebhookToken(projectId: string): string {
  return createHmac('sha256', getSigningSecret())
    .update(`webhook:${projectId}`)
    .digest('hex')
}
