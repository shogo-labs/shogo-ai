// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who may manage a workspace member's role, mirroring the API's rules.
 *
 * The owner role is peer-managed: only a workspace owner can grant it, change
 * an owner's role, or remove an owner. `workspace.members:manage` covers every
 * other role, and nobody manages their own row from here. Holding
 * `workspace.owners:manage` is not equivalent to being an owner — a super
 * admin viewing a workspace they don't own has the permission but not the seat.
 */

export type WorkspaceRoleOption = 'owner' | 'admin' | 'member' | 'viewer'

const NON_OWNER_ROLES: readonly WorkspaceRoleOption[] = ['admin', 'member', 'viewer']

export interface MemberRoleViewer {
  /** Viewer holds `workspace.members:manage`. */
  canManageMembers: boolean
  /** The viewer's own workspace role is `owner`. */
  isOwner: boolean
  /** The row being rendered belongs to the viewer. */
  isSelf: boolean
}

/** Whether the viewer may change this member's role or remove them. */
export function canManageMemberRow(
  viewer: MemberRoleViewer,
  targetRole: string | null | undefined,
): boolean {
  if (viewer.isSelf || !viewer.canManageMembers) return false
  return targetRole === 'owner' ? viewer.isOwner : true
}

/** The roles the viewer may assign to another member. */
export function roleOptionsFor(
  viewer: Pick<MemberRoleViewer, 'isOwner'>,
): readonly WorkspaceRoleOption[] {
  return viewer.isOwner ? ['owner', ...NON_OWNER_ROLES] : NON_OWNER_ROLES
}
