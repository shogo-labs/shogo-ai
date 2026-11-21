// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface PooledWorkspaceCandidate {
  id: string;
  name?: string | null;
  parentWorkspaceId?: string | null;
}

export type WorkspacePlanMap = Record<
  string,
  { planId: string; canManageChildren?: boolean; includedWorkspaces?: { limit: number | null; used: number } }
>;

/**
 * Pick the workspace a new child should pool under: a top-level workspace the
 * user can manage AND that has room for another child (limit is null or
 * used < limit). Prefers the current workspace, then the one with the most
 * room left. The server still enforces eligibility on create (SHO-474).
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
    const ws = plan.includedWorkspaces;
    // No allowance data yet — fall back to the old business/enterprise check
    // so the UI doesn't break when talking to an older server.
    if (!ws) {
      return (
        plan.planId.startsWith("business") || plan.planId.startsWith("enterprise")
      );
    }
    return ws.limit === null || ws.used < ws.limit;
  });

  if (!eligible.length) return null;

  // Prefer the current workspace; among the rest, prefer the one with the most
  // remaining slots (nulls sort first = unlimited).
  const current = eligible.find((w) => w.id === currentWorkspaceId);
  if (current) return current;

  return eligible.sort((a, b) => {
    const pa = plans[a.id]?.includedWorkspaces;
    const pb = plans[b.id]?.includedWorkspaces;
    const roomA = pa?.limit == null ? Infinity : pa.limit - pa.used;
    const roomB = pb?.limit == null ? Infinity : pb.limit - pb.used;
    return roomB - roomA;
  })[0] ?? null;
}

/**
 * Find a workspace that is AT its plan cap (a managed paid workspace with no
 * room left). Used to show the upgrade card when the user can't create an
 * included workspace but would be able to on a higher plan.
 */
export function selectAtCapWorkspaceParent(
  workspaces: PooledWorkspaceCandidate[],
  currentWorkspaceId: string | undefined,
  plans: WorkspacePlanMap,
): PooledWorkspaceCandidate | null {
  const atCap = workspaces.filter((workspace) => {
    if (workspace.parentWorkspaceId) return false;
    const plan = plans[workspace.id];
    if (!plan?.canManageChildren) return false;
    if (plan.planId.startsWith("free")) return false; // free shows plan_required, not upgrade
    const ws = plan.includedWorkspaces;
    if (!ws) return false;
    return ws.limit !== null && ws.used >= ws.limit;
  });
  if (!atCap.length) return null;
  return (
    atCap.find((w) => w.id === currentWorkspaceId) ?? atCap[0] ?? null
  );
}
