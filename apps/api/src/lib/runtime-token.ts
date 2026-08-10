// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-Project Runtime Token Derivation & Verification
 *
 * Derives deterministic, project-scoped bearer tokens used for
 * pod↔API and API↔pod RPC. Tokens are derived from the platform
 * signing secret + projectId, so the API can recompute them at any
 * time without storage. Each project gets unique tokens — if an
 * agent reads its own token via `env`, it can only authenticate to
 * itself (zero blast radius).
 *
 * ─── Token format (v1) ────────────────────────────────────────────
 *
 *   rt_v1_<projectId>_<hmac-hex>
 *     where hmac-hex = HMAC-SHA256(signingSecret, "runtime-auth:" + projectId)
 *
 * The token is **self-identifying**: the projectId is embedded
 * verbatim (non-secret — it already appears in URLs, logs, and DB
 * rows). This lets the verifier recover the scope from the bearer
 * alone, with no need to also know `projectId` via query string,
 * path param, or request body. Adding new project-scoped endpoints
 * therefore doesn't risk forgetting to wire projectId through auth
 * middleware.
 *
 * The `v1` version tag reserves space for format changes (JWT-style
 * kid, short-lived nonces, rotation markers) without another
 * migration — bump to `rt_v2_*` and dual-accept during rollout.
 *
 * ─── Legacy format (pre-v1, accepted during rollout) ───────────────
 *
 * Older pods were booted with a bare 64-char hex HMAC (no prefix,
 * no embedded projectId). For those tokens the verifier falls back
 * to the caller-supplied `fallbackProjectId` (query param / path
 * param). Once all live pods have been restarted post-deploy, the
 * legacy path can be removed — but it's cheap to keep as long as
 * any long-running pod might still be holding a pre-v1 token.
 *
 * ─── Token types ──────────────────────────────────────────────────
 *
 *   - runtime-auth: API server ↔ project runtime (internal RPC),
 *                   and pod → API via `x-runtime-token` for
 *                   project-scoped capabilities. See
 *                   `middleware/auth.ts` runtime-token branch and
 *                   `runtime-token.md` for operator gotchas.
 *   - webhook:      external services → agent runtime webhook
 *                   endpoints. Still emitted as bare hex for now —
 *                   webhook URLs always include the projectId, so
 *                   self-identification would be pure cosmetics.
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
      '[RuntimeToken] FATAL: No signing secret configured. ' +
        'Set AI_PROXY_SECRET or BETTER_AUTH_SECRET.'
    )
  }

  return 'shogo-dev-only-runtime-token-secret'
}

/**
 * Prefix marker for v1 self-identifying runtime tokens.
 *
 * Exported so log pipelines / scrubbers / downstream tooling can
 * classify a string without pulling in the full verifier.
 */
export const RUNTIME_TOKEN_V1_PREFIX = 'rt_v1_'

/** 64 hex chars = 32 bytes = SHA256 digest, hex-encoded. */
const HMAC_HEX_LEN = 64
const HMAC_HEX_RE = /^[0-9a-f]{64}$/

/**
 * Compute the bare 64-char hex HMAC for a projectId.
 *
 * This is the raw signing primitive — exported for internal verifier
 * code only. External callers should use `deriveRuntimeToken` (v1
 * format) or `verifyRuntimeToken` (format-agnostic).
 */
function deriveRuntimeTokenHmac(projectId: string): string {
  return createHmac('sha256', getSigningSecret())
    .update(`runtime-auth:${projectId}`)
    .digest('hex')
}

/**
 * Derive a per-project runtime-auth token in v1 self-identifying
 * format.
 *
 * Used wherever Shogo mints a runtime-token for a specific project:
 *   - pod env injection (`build-project-env.ts`, `manager.ts`,
 *     `knative-project-manager.ts`) as `RUNTIME_AUTH_SECRET`
 *   - API→pod proxy calls (`server.ts`, `project-chat.ts`,
 *     `warm-pool-controller.ts`) as `x-runtime-token`
 *
 * Pods treat the string as an opaque bearer value and forward it
 * unchanged, so the format bump is transparent to pod code.
 */
export function deriveRuntimeToken(projectId: string): string {
  if (!projectId) {
    throw new Error('[RuntimeToken] deriveRuntimeToken: projectId is required')
  }
  return `${RUNTIME_TOKEN_V1_PREFIX}${projectId}_${deriveRuntimeTokenHmac(projectId)}`
}

/**
 * Derive a per-project webhook token.
 *
 * Given to external integrations that need to call a specific
 * agent's webhook endpoints. Intentionally still bare-hex: webhook
 * URLs always already include `projectId` in the path, so adding a
 * self-identifying prefix would be pure cosmetics.
 */
export function deriveWebhookToken(projectId: string): string {
  return createHmac('sha256', getSigningSecret())
    .update(`webhook:${projectId}`)
    .digest('hex')
}

/**
 * Derive a per-project thumbnail token.
 *
 * Gates `GET /api/projects/:projectId/thumbnail.png`, which serves a stored
 * thumbnail as image bytes so the projects list can hand out a short URL
 * instead of inlining a base64 data URI.
 *
 * The token in the query string IS the credential, because the consumer is an
 * `<img>` / React Native `<Image>`: those requests carry no Authorization
 * header, and on native no session cookie either (the Expo auth client adds
 * `Cookie` from its own fetch, which the image loader doesn't use). That's the
 * same capability-URL shape as the presigned S3 links this route stands in for.
 *
 * Bare hex for the same reason as `deriveWebhookToken`: the projectId is
 * already in the path, so self-identification would be cosmetics.
 */
export function deriveThumbnailToken(projectId: string): string {
  return createHmac('sha256', getSigningSecret())
    .update(`thumbnail:${projectId}`)
    .digest('hex')
}

/** Timing-safe check of a `deriveThumbnailToken` value against a projectId. */
export function verifyThumbnailToken(
  projectId: string | undefined | null,
  token: string | undefined | null,
): boolean {
  if (!projectId || !token) return false
  return safeTokenEqual(token, deriveThumbnailToken(projectId))
}

export type ParsedRuntimeToken =
  | { format: 'v1'; projectId: string; hmac: string }
  | { format: 'legacy'; hmac: string }

/**
 * Parse a runtime token into its format + components, without doing
 * any HMAC comparison. Returns `null` for anything that doesn't
 * structurally look like a runtime token — including empty strings,
 * API keys (`shogo_sk_*`), session cookies, etc.
 *
 * Callers that want to verify should use `verifyRuntimeToken` —
 * this function is only exported for tests and diagnostic logging.
 */
export function parseRuntimeToken(token: string): ParsedRuntimeToken | null {
  if (!token) return null

  if (token.startsWith(RUNTIME_TOKEN_V1_PREFIX)) {
    const rest = token.slice(RUNTIME_TOKEN_V1_PREFIX.length)
    // Must be at minimum "<1+char projectId>_<64 hex hmac>" ⇒ ≥ 66 chars.
    if (rest.length < HMAC_HEX_LEN + 2) return null
    const hmac = rest.slice(-HMAC_HEX_LEN)
    if (!HMAC_HEX_RE.test(hmac)) return null
    const sepIdx = rest.length - HMAC_HEX_LEN - 1
    if (rest.charAt(sepIdx) !== '_') return null
    const projectId = rest.slice(0, sepIdx)
    if (!projectId) return null
    return { format: 'v1', projectId, hmac }
  }

  // Legacy: bare 64-char hex (pre-v1 pods, pre-v1 tests).
  if (HMAC_HEX_RE.test(token)) {
    return { format: 'legacy', hmac: token }
  }

  return null
}

export type VerifyResult =
  | { ok: true; projectId: string; format: 'v1' | 'legacy' }
  | { ok: false; reason: 'malformed' | 'unscoped_legacy' | 'bad_hmac' }

/**
 * Verify a runtime token and recover its project scope.
 *
 * - v1 tokens (`rt_v1_<pid>_<hmac>`) are self-scoping — the caller
 *   does NOT need to pass `fallbackProjectId`; it is ignored.
 * - Legacy bare-hex tokens require `fallbackProjectId` (typically
 *   from `?projectId=` query or `:projectId` route param). If the
 *   caller can't supply one, the token is rejected with
 *   `unscoped_legacy` — we never brute-force the scope.
 *
 * Always uses the timing-safe comparator from `crypto-util.ts`.
 * See `runtime-token.md` §6.
 *
 * Never throws on signing-secret absence in non-production — falls
 * through to `getSigningSecret`'s dev-only default. In production
 * missing-secret throws, matching the documented tripwire in
 * `runtime-token.md` §8.
 */
export function verifyRuntimeToken(
  token: string | undefined | null,
  fallbackProjectId?: string | undefined | null,
): VerifyResult {
  if (!token) return { ok: false, reason: 'malformed' }

  const parsed = parseRuntimeToken(token)
  if (!parsed) return { ok: false, reason: 'malformed' }

  const scopedProjectId =
    parsed.format === 'v1' ? parsed.projectId : fallbackProjectId || undefined
  if (!scopedProjectId) return { ok: false, reason: 'unscoped_legacy' }

  const expected = deriveRuntimeTokenHmac(scopedProjectId)
  if (!safeTokenEqual(parsed.hmac, expected)) {
    return { ok: false, reason: 'bad_hmac' }
  }

  return { ok: true, projectId: scopedProjectId, format: parsed.format }
}
