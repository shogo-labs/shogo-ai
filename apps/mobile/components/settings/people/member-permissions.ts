// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure permission rules for workspace member management.
 *
 * These mirror the server rules in `apps/api/src/generated/member.hooks.ts`
 * (`beforeUpdate` / `beforeDelete`) and `POST /api/workspaces/:id/leave`, so the
 * UI can disable (and explain) actions the server would reject. The menu, the
 * member detail sheet, and the tests all read from here.
 */

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface Permission {
  allowed: boolean;
  /** Short, user-facing explanation. Set whenever `allowed` is false. */
  reason?: string;
}

export const ROLE_DISPLAY: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Editor",
  viewer: "Viewer",
};

export const ROLE_COLORS: Record<string, string> = {
  owner: "bg-amber-500",
  admin: "bg-blue-500",
  member: "bg-emerald-500",
  viewer: "bg-slate-400",
};

/** Lower is more privileged. Used for sorting and for de-duplicating members. */
export const ROLE_PRIORITY: Record<string, number> = {
  owner: 0,
  admin: 1,
  member: 2,
  viewer: 3,
};

const ALLOWED: Permission = { allowed: true };
const deny = (reason: string): Permission => ({ allowed: false, reason });

/** Owners and admins manage the workspace's members. */
export function canManageMembers(viewerRole?: string | null): boolean {
  return viewerRole === "owner" || viewerRole === "admin";
}

/** Roles the viewer may assign. Only owners can hand out the owner role. */
export function assignableRoles(viewerRole?: string | null): WorkspaceRole[] {
  if (viewerRole === "owner") return ["owner", "admin", "member", "viewer"];
  if (viewerRole === "admin") return ["admin", "member", "viewer"];
  return [];
}

export function canChangeRole(args: {
  viewerRole?: string | null;
  targetRole?: string | null;
  isSelf: boolean;
}): Permission {
  const { viewerRole, targetRole, isSelf } = args;
  if (!canManageMembers(viewerRole)) {
    return deny("Only owners and admins can change roles");
  }
  if (isSelf) return deny("You can't change your own role");
  if (targetRole === "owner" && viewerRole !== "owner") {
    return deny("Only owners can change an owner's role");
  }
  return ALLOWED;
}

/** Removing someone else. For your own row use {@link canLeave}. */
export function canRemove(args: {
  viewerRole?: string | null;
  targetRole?: string | null;
  isSelf: boolean;
}): Permission {
  const { viewerRole, targetRole, isSelf } = args;
  if (isSelf) return deny("Use Leave workspace to remove yourself");
  if (!canManageMembers(viewerRole)) {
    return deny("Only owners and admins can remove members");
  }
  if (targetRole === "owner" && viewerRole !== "owner") {
    return deny("Only owners can remove owners");
  }
  return ALLOWED;
}

export function canLeave(args: {
  viewerRole?: string | null;
  /** How many workspaces the current user belongs to. */
  workspaceCount: number;
  /** Owners in this workspace other than the current user. */
  otherOwnerCount: number;
}): Permission {
  const { viewerRole, workspaceCount, otherOwnerCount } = args;
  if (workspaceCount <= 1) {
    return deny("You can't leave your only workspace");
  }
  if (viewerRole === "owner" && otherOwnerCount === 0) {
    return deny("You're the last owner. Promote someone else first.");
  }
  return ALLOWED;
}

/** Pulls a human-readable message out of the various error shapes the API client throws. */
export function getErrorMessage(error: unknown, fallback: string): string {
  const e = error as any;
  const message =
    e?.details?.error?.message ||
    e?.response?.data?.error?.message ||
    e?.data?.error?.message ||
    e?.error?.message ||
    (typeof e?.message === "string" ? e.message : "");
  return message || fallback;
}
