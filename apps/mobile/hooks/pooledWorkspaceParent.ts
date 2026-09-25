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

/**
 * Pick the workspace a new child should pool under: a top-level
 * Business/Enterprise workspace the user can manage, preferring the current
 * one. The server still enforces eligibility on create.
 */
export function selectPooledWorkspaceParent(
  workspaces: PooledWorkspaceCandidate[],
  currentWorkspaceId: string | undefined,
  plans: WorkspacePlanMap,
): PooledWorkspaceCandidate | null {
  const eligible = workspaces.filter((workspace) => {
    if (workspace.parentWorkspaceId) return false;
    const plan = plans[workspace.id];
    if (!plan?.canManageChildren) return false;
    return (
      plan.planId.startsWith("business") || plan.planId.startsWith("enterprise")
    );
  });

  return (
    eligible.find((workspace) => workspace.id === currentWorkspaceId) ??
    eligible[0] ??
    null
  );
}
