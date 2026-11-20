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
 * `WORKSPACE_LIMITS` in config/workspace-limits.ts; changing that map is the
 * only config needed to adjust any tier.
 */

import { WORKSPACE_LIMITS, nextWorkspaceTier } from '../config/workspace-limits'
import type { PlanId } from '../config/workspace-limits'
import { getUserOwnedWorkspaceCount } from './workspace.service'
import { prisma } from '../lib/prisma'

export type OwnedWorkspaceKind = 'personal' | 'team'

export interface WorkspaceCreateRefusal {
  ok: false
  error: { code: string; message: string; planId?: PlanId; limit?: number | null; used?: number; nextPlanId?: PlanId | null }
}

export interface IncludedWorkspaceAllowance {
  ok: true
  planId: PlanId
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
 *
 * The refusal message names the next tier from `nextWorkspaceTier`, so it
 * stays correct when the limits map changes (AC6).
 */
export async function checkWorkspaceCreateAllowance(
  userId: string,
  kind: OwnedWorkspaceKind,
): Promise<{ ok: true } | WorkspaceCreateRefusal> {
  const limit = WORKSPACE_LIMITS.free ?? 1
  if ((await getUserOwnedWorkspaceCount(userId, kind)) < limit) return { ok: true }
  if (kind === 'personal') {
    return { ok: false, error: { code: 'workspace_limit_reached', message: 'You already have a personal workspace.' } }
  }
  // Build the message from the map so it tracks any limit change (AC6).
  const next = nextWorkspaceTier('free')
  const nextName = next ? next.planId.charAt(0).toUpperCase() + next.planId.slice(1) : null
  const nextLimit = next ? (next.limit === null ? 'unlimited' : String(next.limit)) : null
  const tierAfter = nextWorkspaceTier(next?.planId ?? 'basic')
  const tierAfterName = tierAfter ? tierAfter.planId.charAt(0).toUpperCase() + tierAfter.planId.slice(1) : null
  const tierAfterLimit = tierAfter ? (tierAfter.limit === null ? 'unlimited' : String(tierAfter.limit)) : null
  const nextPart = nextName && nextLimit ? `${nextName} includes ${nextLimit} workspaces` : null
  const tierPart = tierAfterName && tierAfterLimit ? `${tierAfterName} includes ${tierAfterLimit}` : null
  const messageParts = [nextPart, tierPart].filter(Boolean)
  const message = `You've used your free workspace. ${messageParts.join(' and ')}.`
  return { ok: false, error: { code: 'workspace_limit_reached', message } }
}

/**
 * Whether the parent workspace has room for one more included child.
 *
 * `effectivePlan` must be the already-normalized result of
 * `getEffectivePlanId(parentWorkspaceId)` from billing.service — no further
 * normalization is done here. Keeping billing.service out of this module
 * preserves testability; the hook already imports and mocks it.
 *
 * Returns `{ ok, planId, limit, used }` on success so the caller can forward
 * it to the client for the used/limit display.
 *
 * Rejects with:
 *   - `plan_required` when the parent is free (included workspaces start on Basic).
 *   - `workspace_limit_reached` when at or over the cap. The error carries
 *     `{ planId, limit, used, nextPlanId }` for upgrade CTAs. When `used > limit`
 *     (downgrade: children were created on a higher tier), the message says
 *     "is using N" rather than "all N", so it reads correctly when N > limit.
 */
export async function checkIncludedWorkspaceAllowance(
  parentWorkspaceId: string,
  effectivePlan: PlanId,
): Promise<IncludedWorkspaceAllowance | WorkspaceCreateRefusal> {
  if (effectivePlan === 'free') {
    const next = nextWorkspaceTier('free')
    const nextName = next ? next.planId.charAt(0).toUpperCase() + next.planId.slice(1) : 'Basic'
    const nextLimit = next?.limit ?? WORKSPACE_LIMITS.basic
    return {
      ok: false,
      error: {
        code: 'plan_required',
        message: `Included workspaces start on ${nextName} (${nextLimit} workspaces).`,
      },
    }
  }

  const limit = WORKSPACE_LIMITS[effectivePlan]
  const childCount = await prisma.workspace.count({ where: { parentWorkspaceId } })
  const used = 1 + childCount // 1 = the parent itself

  if (limit === null) {
    // Unlimited — always OK.
    return { ok: true, planId: effectivePlan, limit: null, used }
  }

  if (used >= limit) {
    const next = nextWorkspaceTier(effectivePlan)
    const planName = effectivePlan.charAt(0).toUpperCase() + effectivePlan.slice(1)
    const nextName = next ? next.planId.charAt(0).toUpperCase() + next.planId.slice(1) : null
    // When used === limit: "is using all N". When used > limit (downgrade): "is using N".
    const usageClause = used === limit ? `is using all ${used}` : `is using ${used}`
    const message = next
      ? `Your ${planName} plan includes ${limit} workspaces and ${usageClause}. Upgrade to ${nextName} for ${next.limit === null ? 'unlimited' : next.limit} workspaces.`
      : `Your ${planName} plan includes ${limit} workspaces and ${usageClause}.`
    return {
      ok: false,
      error: {
        code: 'workspace_limit_reached',
        message,
        planId: effectivePlan,
        limit,
        used,
        nextPlanId: next?.planId ?? null,
      },
    }
  }

  return { ok: true, planId: effectivePlan, limit, used }
}
