// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Centralized URL resolution for the api app.
 *
 * Two URLs the rest of the codebase keeps re-deriving on its own:
 *
 * 1. **Shogo Cloud URL** — the upstream cloud node a *desktop* (or
 *    self-hosted) instance proxies LLM/integration/marketplace traffic
 *    to. Sourced ONLY from `process.env.SHOGO_CLOUD_URL`, defaulting
 *    to the production cloud. Never read from request bodies, persisted
 *    localConfig rows, or UI inputs — to target staging or self-hosted,
 *    set the env var on the API process. (See the long comment in
 *    `apps/api/src/routes/local-auth.ts` for the security rationale.)
 *
 * 2. **Frontend URL** — the user-browser-reachable URL of this API's
 *    own UI (used to build redirect URLs for Stripe checkout, the
 *    device-login bridge page, etc.). Resolved from APP_URL → first
 *    ALLOWED_ORIGINS entry → localhost VITE_PORT.
 *
 * Before this module the same expressions were inlined in 8+ files
 * (server.ts, cli-auth.ts, local-auth.ts, ai-proxy.ts, integrations.ts,
 * marketplace.ts, tools-proxy.ts, instance-tunnel.ts,
 * lib/runtime/manager.ts), each with a hardcoded
 * 'https://studio.shogo.ai' fallback that drifted independently.
 */

/**
 * Single source of truth for the production Shogo Cloud endpoint.
 * Override per-deploy via `SHOGO_CLOUD_URL` (no trailing slash needed
 * — `getShogoCloudUrl()` trims it).
 */
export const SHOGO_CLOUD_URL_DEFAULT = 'https://studio.shogo.ai'

/**
 * Returns the Shogo Cloud endpoint that this api process talks to
 * upstream. Trailing slash trimmed so callers can safely concat
 * `${cloudUrl}/api/...` without doubling.
 */
export function getShogoCloudUrl(): string {
  return (process.env.SHOGO_CLOUD_URL || SHOGO_CLOUD_URL_DEFAULT).replace(/\/$/, '')
}

/**
 * Returns the user-browser-reachable URL of this API's frontend.
 * Resolution priority:
 *   1. `process.env.APP_URL`
 *   2. First entry of `process.env.ALLOWED_ORIGINS` (comma-separated)
 *   3. `http://localhost:${VITE_PORT}` (default 3000)
 */
export function getFrontendUrl(): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL
  }
  const allowedOrigins = process.env.ALLOWED_ORIGINS
  if (allowedOrigins) {
    const firstOrigin = allowedOrigins.split(',')[0]?.trim()
    if (firstOrigin) {
      return firstOrigin
    }
  }
  const vitePort = parseInt(process.env.VITE_PORT || '3000', 10)
  return `http://localhost:${vitePort}`
}
