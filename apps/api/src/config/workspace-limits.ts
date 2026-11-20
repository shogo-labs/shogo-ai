// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace count limits by plan (SHO-474).
 *
 * Intentionally separate from `config/usage-plans.ts` so that
 * workspace-create-limit.service.ts can import this without pulling in
 * `lib/usage-cost.ts` (which imports `@shogo/model-catalog`) and breaking the
 * workspace-hooks unit tests.
 *
 * How the limits work:
 *   - `WORKSPACE_LIMITS[plan]` = how many workspaces that plan covers, counting
 *     the paying workspace itself. `null` = unlimited.
 *   - Basic 3  = the paying workspace + 2 included children.
 *   - Pro 10   = the paying workspace + 9 included children (legacy plan).
 *   - Business and Enterprise = `null` (unlimited children).
 *   - Free 1   = no included children; a second top-level workspace needs Basic+.
 *
 * Used by:
 *   - apps/api/src/services/workspace-create-limit.service.ts (server enforcement)
 *   - apps/api/src/server.ts GET /api/billing/workspace-plan (client allowance)
 *   - apps/api/src/config/usage-plans.ts re-exports for external callers that
 *     already depend on that module.
 */

export type WorkspaceLimitPlanId = 'free' | 'basic' | 'pro' | 'business' | 'enterprise'

/**
 * Normalize an arbitrary planId string to a canonical WorkspaceLimitPlanId.
 * Handles decorated ids (`business-monthly`, `Business-Annual`, `pro_200`, etc.)
 * by prefix-matching. Returns `null` for unknown ids.
 */
export function normalizePlanId(planId: string | null | undefined): WorkspaceLimitPlanId | null {
  if (!planId) return null
  const lc = planId.toLowerCase().trim()
  if (lc.startsWith('enterprise')) return 'enterprise'
  if (lc.startsWith('business')) return 'business'
  if (lc.startsWith('pro')) return 'pro'
  if (lc.startsWith('basic')) return 'basic'
  if (lc.startsWith('free')) return 'free'
  return null
}

export const WORKSPACE_LIMITS: Record<WorkspaceLimitPlanId, number | null> = {
  free: 1,
  basic: 3,
  pro: 10,
  business: null,
  enterprise: null,
}

/**
 * The next tier a user should upgrade to when they hit the workspace cap.
 * Returns `null` for plans that are already unlimited.
 */
export function nextWorkspaceTier(
  plan: WorkspaceLimitPlanId,
): { planId: WorkspaceLimitPlanId; limit: number | null } | null {
  if (plan === 'free') return { planId: 'basic', limit: WORKSPACE_LIMITS.basic }
  if (plan === 'basic' || plan === 'pro') return { planId: 'business', limit: WORKSPACE_LIMITS.business }
  return null // business / enterprise are already unlimited
}
