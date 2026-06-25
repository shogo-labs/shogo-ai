// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolve the *user* an identity-scoped write acts on, so the home-region write
 * router can pin it to that user's home region (`users.homeRegion`).
 *
 * This is the identity counterpart to `resolve-workspace-id.ts`. It is only
 * consulted for mutations that did NOT resolve to a workspace and are NOT
 * platform-global — i.e. writes to the user's own identity rows (the `users`
 * row itself, notifications, affiliate enrollment, etc.).
 *
 * Resolution order:
 *   1. Self routes (`/api/onboarding/complete`, `/api/users/me/attribution`,
 *      `/api/affiliates/me/*`) — always the session user.
 *   2. `/api/users/:id` — the id *is* the user id (`/api/users/me` and the bare
 *      collection fall back to the session user).
 *   3. A user-owned resource by id (`/api/notifications/:id` → that row's
 *      `userId`); collection-level creates fall back to the session user.
 *
 * Returns the owning user id, or null when the request isn't identity-scoped
 * (in which case the router handles it locally).
 *
 * Deliberately does NOT read the request body (the router streams it when
 * proxying; re-reading a consumed body is fragile).
 */

import type { Context } from 'hono'
import { prisma } from './prisma'

const db = prisma as any

/** `/api/foo/bar` → `['foo', 'bar']`; tolerant of a missing `/api` prefix. */
function apiSegments(pathname: string): string[] {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'api') parts.shift()
  return parts
}

/** Path segments that look like an id but are reserved keywords, not row ids. */
const RESERVED_RESOURCE_IDS = new Set(['me', 'import', 'validate', 'heartbeat'])

/**
 * Paths that always act on the *session* user, regardless of any id in the URL.
 * Matched as prefixes against the full pathname.
 */
const SELF_ROUTE_PREFIXES = [
  '/api/onboarding/complete',
  '/api/users/me/attribution',
  '/api/affiliates/me/',
]

type Lookup = (id: string) => Promise<string | null>

/**
 * Prisma client accessor names of every model this resolver routes by user
 * identity. `user` is handled by the `/api/users/:id` path rather than a lookup.
 * Consumed by the resolver-coverage CI guard.
 */
const userResolvedModels = new Set<string>(['user'])

/** A user-owned resource whose row carries a direct `userId`. */
const directUser = (model: string): Lookup => {
  userResolvedModels.add(model)
  return async (id) => {
    const row = await db[model].findUnique({ where: { id }, select: { userId: true } })
    return row?.userId ?? null
  }
}

/**
 * Map of `/api/<segment>/:id` → how to find that row's owning user. Only
 * identity-owned resources are listed; workspace-scoped resources are resolved
 * by `resolve-workspace-id.ts` (consulted first by the router).
 */
const USER_RESOURCE_LOOKUPS: Record<string, Lookup> = {
  notifications: directUser('notification'),
}

/** @see userResolvedModels */
export const USER_RESOLVED_MODELS: ReadonlySet<string> = userResolvedModels

export async function resolveUserHomeRegionUserId(c: Context): Promise<string | null> {
  const pathname = new URL(c.req.url).pathname
  const seg = apiSegments(pathname)
  const auth = c.get('auth') as { userId?: string } | undefined
  const sessionUser = auth?.userId ?? null

  // 1. Self routes — always the session user.
  if (SELF_ROUTE_PREFIXES.some((p) => pathname.startsWith(p))) {
    return sessionUser
  }

  if (seg.length === 0) return null

  // 2. /api/users/:id — the id is the user. `me` / bare collection → session.
  if (seg[0] === 'users') {
    if (seg[1] && !RESERVED_RESOURCE_IDS.has(seg[1])) return seg[1]
    return sessionUser
  }

  // 3. User-owned resource by id; collection-level create → session user.
  const lookup = USER_RESOURCE_LOOKUPS[seg[0]]
  if (lookup) {
    if (seg[1] && !RESERVED_RESOURCE_IDS.has(seg[1])) {
      const uid = await lookup(seg[1])
      if (uid) return uid
    }
    return sessionUser
  }

  return null
}
