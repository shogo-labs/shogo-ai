// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace creation limits — one source of truth for every path that mints
 * a new workspace on the cloud.
 *
 * Two paths create a top-level workspace: `POST /api/workspaces` (through
 * `workspaceHooks.beforeCreate`) and `initTargetWorkspace` (the receive side
 * of a workspace move). Both call `checkWorkspaceCreateAllowance`. Two copies
 * of the rule is how one of them drifts (SHO-256).
 *
 * Included (child) workspaces are counted against the parent's plan limit by
 * `checkIncludedWorkspaceAllowance` (SHO-474). The limit is read from
 * `WORKSPACE_LIMITS` in config/usage-plans.ts; changing that map is the only
 * config needed to adjust the numbers.
 */

import { WORKSPACE_LIMITS, nextWorkspaceTier, normalizePlanId } from '../config/workspace-limits'
import type { WorkspaceLimitPlanId } from '../config/workspace-limits'
import { getUserOwnedWorkspaceCount } from './workspace.service'
import { prisma } from '../lib/prisma'

export type OwnedWorkspaceKind = 'personal' | 'team'

export interface WorkspaceCreateRefusal {
  ok: false
  error: { code: string; message: string; planId?: WorkspaceLimitPlanId; limit?: number | null; used?: number; nextPlanId?: WorkspaceLimitPlanId | null }
}

export interface IncludedWorkspaceAllowance {
  ok: true
  planId: WorkspaceLimitPlanId
  limit: number | null
  used: number
}

/** `kind` as the create flow reads it: anything that is not `personal` is `team`. */
export function normaliseWorkspaceKind(kind: unknown): OwnedWorkspaceKind {
  return kind === 'personal' ? 'personal' : 'team'
}

/**
 * Whether `userId` may create one more top-level workspace of `kind`.
 *
 * Every account gets one free workspace of EACH kind (read from
 * `WORKSPACE_LIMITS.free`). Children are excluded from this count — a child
 * workspace does not spend the owner's free top-level slot (SHO-474). A second
 * workspace of the same kind requires a paid subscription, or is created as a
 * child under a qualifying parent.
 */
export async function checkWorkspaceCreateAllowance(
  userId: string,
  kind: OwnedWorkspaceKind,
): Promise<{ ok: true } | WorkspaceCreateRefusal> {
  const limit = WORKSPACE_LIMITS.free ?? 1
  if ((await getUserOwnedWorkspaceCount(userId, kind)) < limit) return { ok: true }
  return {
    ok: false,
    error: {
      code: 'workspace_limit_reached',
      message:
        kind === 'personal'
          ? 'You already have a personal workspace.'
          : `You've used your free workspace. Basic includes 3 workspaces and Business includes unlimited.`,
    },
  }
}

/**
 * Whether the parent workspace has room for one more included child.
 *
 * Returns the allowance shape `{ ok, planId, limit, used }` on success so
 * the caller can forward it to the client for the used/limit display.
 *
 * Rejects with:
 *   - `plan_required` when the parent is free (included workspaces start on Basic).
 *   - `workspace_limit_reached` when the parent is at its plan cap. The error
 *     carries `{ planId, limit, used, nextPlanId }` so the UI shows a specific
 *     upgrade CTA rather than parsing message text.
 *
 * The caller is responsible for resolving `effectivePlan` (via
 * `getEffectivePlanId(parentWorkspaceId)` from billing.service) before calling
 * this. Keeping billing.service out of this module preserves testability — the
 * hook already imports and mocks billing.service.
 */
export async function checkIncludedWorkspaceAllowance(
  parentWorkspaceId: string,
  effectivePlan: string,
): Promise<IncludedWorkspaceAllowance | WorkspaceCreateRefusal> {
  const planId = normalizePlanId(effectivePlan) ?? 'free'

  if (planId === 'free') {
    return {
      ok: false,
      error: {
        code: 'plan_required',
        message: 'Included workspaces start on Basic (3 workspaces).',
      },
    }
  }

  const limit = WORKSPACE_LIMITS[planId]
  if (limit === null) {
    // Unlimited — always OK.
    const childCount = await prisma.workspace.count({ where: { parentWorkspaceId } })
    return { ok: true, planId, limit: null, used: 1 + childCount }
  }

  const childCount = await prisma.workspace.count({ where: { parentWorkspaceId } })
  const used = 1 + childCount // 1 = the parent itself

  if (used >= limit) {
    const next = nextWorkspaceTier(planId)
    const planName = planId.charAt(0).toUpperCase() + planId.slice(1)
    return {
      ok: false,
      error: {
        code: 'workspace_limit_reached',
        message: next
          ? `Your ${planName} plan includes ${limit} workspaces and is using all ${used}. Upgrade to ${next.planId.charAt(0).toUpperCase() + next.planId.slice(1)} for ${next.limit === null ? 'unlimited' : next.limit} workspaces.`
          : `Your ${planName} plan includes ${limit} workspaces and is using all ${used}.`,
        planId,
        limit,
        used,
        nextPlanId: next?.planId ?? null,
      },
    }
  }

  return { ok: true, planId, limit, used }
}
