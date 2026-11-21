// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which native callback schemes Better Auth trusts, and where the Expo
 * authorization proxy may redirect (SEC-33).
 *
 * `@better-auth/expo` appends the session cookie (`?cookie=<Set-Cookie>`) to
 * any trusted non-http callback. `exp://` is a prefix, so trusting it means
 * trusting `exp://<any host>`: an attacker sends a victim a sign-in link with
 * `callbackURL=exp://attacker.example/x`, and after Google consent the API
 * redirects to the attacker's host with the session token in the query. Expo
 * Go then fetches that URL. Upstream trusts `exp://` only in development, and
 * so do we now. The app's own `shogo://` scheme stays trusted everywhere.
 */

import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

/** True only for a local developer API (NODE_ENV unset, development or test). */
export function isLocalDevelopmentEnv(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return !nodeEnv || nodeEnv === 'development' || nodeEnv === 'test'
}

export function nativeTrustedOrigins(nodeEnv: string | undefined = process.env.NODE_ENV): string[] {
  return isLocalDevelopmentEnv(nodeEnv) ? ['shogo://', 'exp://'] : ['shogo://']
}

/**
 * Authorize endpoints of the social providers configured in auth.ts. The
 * `/expo-authorization-proxy` endpoint redirects to whatever URL it is given
 * (only requiring a `state` param), which made it an open redirect on the
 * Studio origin.
 */
export const OAUTH_AUTHORIZE_HOSTS: ReadonlySet<string> = new Set([
  'accounts.google.com',
  'appleid.apple.com',
])

export function isAllowedAuthorizationURL(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.port && url.port !== '443') return false
  return OAUTH_AUTHORIZE_HOSTS.has(url.hostname.toLowerCase())
}

/** Refuses `/expo-authorization-proxy` to anything but a provider's authorize URL. */
export const expoAuthorizationProxyGuard: BetterAuthPlugin = {
  id: 'shogo-expo-authorization-proxy-guard',
  hooks: {
    before: [
      {
        matcher(ctx) {
          return ctx.path === '/expo-authorization-proxy'
        },
        handler: createAuthMiddleware(async (ctx) => {
          const target = (ctx.query as { authorizationURL?: unknown } | undefined)?.authorizationURL
          if (isAllowedAuthorizationURL(target)) return
          throw new APIError('BAD_REQUEST', { message: 'authorizationURL is not an allowed provider' })
        }),
      },
    ],
  },
}
