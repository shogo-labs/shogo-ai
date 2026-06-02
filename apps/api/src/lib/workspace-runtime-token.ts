// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-Workspace Runtime Token Derivation & Verification
 *
 * The workspace-scoped sibling of `runtime-token.ts`. A workspace
 * runtime serves a merged tree of several attached projects, so its
 * pod<->API capability is keyed by `workspaceId` rather than a single
 * `projectId`. The token is derived deterministically from the platform
 * signing secret + workspaceId, so the API can recompute it without
 * storage and a leaked token only authenticates to its own workspace.
 *
 * ─── Token format (v1) ────────────────────────────────────────────
 *
 *   wrt_v1_<workspaceId>_<hmac-hex>
 *     where hmac-hex = HMAC-SHA256(secret, "workspace-runtime-auth:" + workspaceId)
 *
 * Like the project runtime token it is self-identifying: the verifier
 * recovers the workspace scope from the bearer alone, so workspace
 * endpoints don't have to re-thread `workspaceId` through auth.
 *
 * The prefix is deliberately distinct from `rt_v1_` so a workspace
 * token can never be mistaken for (or replayed as) a project token —
 * `verifyRuntimeToken` rejects `wrt_v1_*` as malformed and vice versa.
 */

import { createHmac } from 'crypto'
import { safeTokenEqual } from './crypto-util'

function getSigningSecret(): string {
  const secret =
    process.env.AI_PROXY_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[WorkspaceRuntimeToken] FATAL: No signing secret configured. ' +
        'Set AI_PROXY_SECRET or BETTER_AUTH_SECRET.',
    )
  }

  return 'shogo-dev-only-runtime-token-secret'
}

/** Prefix marker for v1 self-identifying workspace runtime tokens. */
export const WORKSPACE_RUNTIME_TOKEN_V1_PREFIX = 'wrt_v1_'

/** 64 hex chars = 32 bytes = SHA256 digest, hex-encoded. */
const HMAC_HEX_LEN = 64
const HMAC_HEX_RE = /^[0-9a-f]{64}$/

function deriveWorkspaceRuntimeTokenHmac(workspaceId: string): string {
  return createHmac('sha256', getSigningSecret())
    .update(`workspace-runtime-auth:${workspaceId}`)
    .digest('hex')
}

/**
 * Derive a per-workspace runtime-auth token in v1 self-identifying
 * format. Injected into the workspace runtime as `RUNTIME_AUTH_SECRET`
 * (see `build-workspace-env.ts`) and sent back to the API as
 * `x-runtime-token` on workspace-scoped RPC.
 */
export function deriveWorkspaceRuntimeToken(workspaceId: string): string {
  if (!workspaceId) {
    throw new Error('[WorkspaceRuntimeToken] deriveWorkspaceRuntimeToken: workspaceId is required')
  }
  return `${WORKSPACE_RUNTIME_TOKEN_V1_PREFIX}${workspaceId}_${deriveWorkspaceRuntimeTokenHmac(workspaceId)}`
}

export type ParsedWorkspaceRuntimeToken = { format: 'v1'; workspaceId: string; hmac: string }

/**
 * Parse a workspace runtime token into its components without any HMAC
 * comparison. Returns `null` for anything that doesn't structurally
 * look like a `wrt_v1_*` token (including project `rt_v1_*` tokens).
 */
export function parseWorkspaceRuntimeToken(token: string): ParsedWorkspaceRuntimeToken | null {
  if (!token) return null
  if (!token.startsWith(WORKSPACE_RUNTIME_TOKEN_V1_PREFIX)) return null

  const rest = token.slice(WORKSPACE_RUNTIME_TOKEN_V1_PREFIX.length)
  // Must be at minimum "<1+char workspaceId>_<64 hex hmac>" ⇒ ≥ 66 chars.
  if (rest.length < HMAC_HEX_LEN + 2) return null
  const hmac = rest.slice(-HMAC_HEX_LEN)
  if (!HMAC_HEX_RE.test(hmac)) return null
  const sepIdx = rest.length - HMAC_HEX_LEN - 1
  if (rest.charAt(sepIdx) !== '_') return null
  const workspaceId = rest.slice(0, sepIdx)
  if (!workspaceId) return null
  return { format: 'v1', workspaceId, hmac }
}

export type VerifyWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: 'malformed' | 'bad_hmac' }

/**
 * Verify a workspace runtime token and recover its workspace scope.
 * Always uses the timing-safe comparator from `crypto-util.ts`.
 */
export function verifyWorkspaceRuntimeToken(
  token: string | undefined | null,
): VerifyWorkspaceResult {
  if (!token) return { ok: false, reason: 'malformed' }

  const parsed = parseWorkspaceRuntimeToken(token)
  if (!parsed) return { ok: false, reason: 'malformed' }

  const expected = deriveWorkspaceRuntimeTokenHmac(parsed.workspaceId)
  if (!safeTokenEqual(parsed.hmac, expected)) {
    return { ok: false, reason: 'bad_hmac' }
  }

  return { ok: true, workspaceId: parsed.workspaceId }
}
