// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin permission scopes
 *
 * Granular, additive admin capabilities layered on top of the platform
 * `UserRole`. A `super_admin` implicitly holds *every* scope, so this list
 * only matters for non-super_admin users who have been granted partial admin
 * access (e.g. a marketing team member who may view usage + creator stats but
 * cannot touch infrastructure, users, settings, etc.).
 *
 * Scopes are persisted on `User.adminScopes` (a Postgres `String[]`, stored as
 * a JSON-encoded string in the SQLite/local schema) and validated against the
 * catalog below before being written.
 *
 * To add a new capability: add an entry to `ADMIN_SCOPES`, gate the relevant
 * route(s) with `requireAdminScope('<id>')`, and surface it in the admin user
 * detail UI. Nothing else needs to change.
 */

import { prisma } from "./prisma"

/** The catalog of assignable admin scopes. */
export const ADMIN_SCOPES = [
  {
    id: "analytics:read",
    label: "Usage analytics (all)",
    description:
      "Umbrella scope: view both Marketing and AI/engineering analytics, plus the admin dashboard (read-only). Implies marketing:read and ai:read.",
  },
  {
    id: "marketing:read",
    label: "Marketing analytics",
    description:
      "View the Marketing analytics page: signup funnel, acquisition sources, user activity, and AI insights digest (read-only).",
  },
  {
    id: "ai:read",
    label: "AI / engineering analytics",
    description:
      "View the AI/engineering analytics page: model spend, quality & efficiency, tool calls, usage logs, workspace activity, and chat metrics (read-only).",
  },
  {
    id: "creators:read",
    label: "Creator stats",
    description:
      "View marketplace creator stats and per-creator platform usage (read-only).",
  },
  {
    id: "creators:write",
    label: "Creator management",
    description:
      "Approve/reject creators and manage affiliate program actions: content-program review, rate/CPM overrides, and payouts. Implies creator viewing.",
  },
] as const

export type AdminScope = (typeof ADMIN_SCOPES)[number]["id"]

/** All known scope ids, in catalog order. */
export const ADMIN_SCOPE_IDS: readonly AdminScope[] = ADMIN_SCOPES.map(
  (s) => s.id
)

/** Type guard: is `value` a known admin scope id? */
export function isAdminScope(value: unknown): value is AdminScope {
  return (
    typeof value === "string" &&
    (ADMIN_SCOPE_IDS as readonly string[]).includes(value)
  )
}

/**
 * Normalize an `adminScopes` value into a clean, deduped list of *known*
 * scopes. Accepts either an array (Postgres / already-parsed SQLite) or a
 * JSON-encoded string (raw SQLite TEXT), tolerating malformed input.
 */
export function normalizeAdminScopes(raw: unknown): AdminScope[] {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      value = []
    }
  }
  if (!Array.isArray(value)) return []
  const seen = new Set<AdminScope>()
  for (const entry of value) {
    if (isAdminScope(entry)) seen.add(entry)
  }
  return [...seen]
}

/** Resolved admin access for a user. */
export interface AdminAccess {
  /** True if the user is a platform super_admin (implicitly holds all scopes). */
  isSuperAdmin: boolean
  /** The user's effective admin scopes (all scopes if super_admin). */
  scopes: AdminScope[]
}

/**
 * Resolve a user's admin access from the database. Super admins are reported
 * as holding every scope. Unknown users (or plain users) resolve to no access.
 */
export async function getAdminAccess(userId: string): Promise<AdminAccess> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, adminScopes: true },
  })
  if (!user) return { isSuperAdmin: false, scopes: [] }
  if (user.role === "super_admin") {
    return { isSuperAdmin: true, scopes: [...ADMIN_SCOPE_IDS] }
  }
  return { isSuperAdmin: false, scopes: normalizeAdminScopes(user.adminScopes) }
}

/** Does this resolved access include `scope` (super admins always do)? */
export function hasScope(access: AdminAccess, scope: AdminScope): boolean {
  return access.isSuperAdmin || access.scopes.includes(scope)
}
