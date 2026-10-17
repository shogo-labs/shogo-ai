// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface PooledWorkspaceCandidate {
  id: string;
  name?: string | null;
  parentWorkspaceId?: string | null;
}

export type WorkspacePlanMap = Record<
  string,
  { planId: string; canManageChildren?: boolean }
>;

export interface PooledWorkspaceParentOption extends PooledWorkspaceCandidate {
  /** Human-readable plan, e.g. "Enterprise". */
  planLabel: string;
}

function planLabel(planId: string): string {
  if (planId.startsWith("enterprise")) return "Enterprise";
  if (planId.startsWith("business")) return "Business";
  return planId;
}

/**
 * Top-level Business/Enterprise workspaces the user can manage — every
 * workspace a new child could pool under. The server still enforces
 * eligibility on create.
 */
export function eligiblePooledWorkspaceParents(
  workspaces: PooledWorkspaceCandidate[],
  plans: WorkspacePlanMap,
): PooledWorkspaceParentOption[] {
  const eligible: PooledWorkspaceParentOption[] = [];
  for (const workspace of workspaces) {
    if (workspace.parentWorkspaceId) continue;
    const plan = plans[workspace.id];
    if (!plan?.canManageChildren) continue;
    if (!plan.planId.startsWith("business") && !plan.planId.startsWith("enterprise")) {
      continue;
    }
    eligible.push({ ...workspace, planLabel: planLabel(plan.planId) });
  }
  return eligible;
}

/**
 * Pick the default parent for a new child workspace: the current workspace,
 * else the current workspace's own parent (when the user is inside a child),
 * else the first eligible one.
 */
export function selectPooledWorkspaceParent(
  workspaces: PooledWorkspaceCandidate[],
  currentWorkspaceId: string | undefined,
  plans: WorkspacePlanMap,
): PooledWorkspaceParentOption | null {
  const eligible = eligiblePooledWorkspaceParents(workspaces, plans);
  const current = workspaces.find((workspace) => workspace.id === currentWorkspaceId);
  return (
    eligible.find((workspace) => workspace.id === currentWorkspaceId) ??
    eligible.find((workspace) => workspace.id === current?.parentWorkspaceId) ??
    eligible[0] ??
    null
  );
}
