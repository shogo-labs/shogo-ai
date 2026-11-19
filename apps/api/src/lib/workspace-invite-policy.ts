// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Who may invite people to a workspace (SHO-454).
 *
 * Owners and admins keep the pre-existing rule: they invite when they can
 * grant the requested role (`canAssignWorkspaceRole`, the no-escalation rule).
 *
 * Everyone else is new. An Editor (workspace role `member`) may invite only
 * while the workspace's `invitePolicy` is not `"admins"`, and only as Editor
 * or Viewer — never as admin, and never as owner. A Viewer can never invite.
 *
 * One helper, used by both the invitation hooks and the invite-link route, so
 * the two surfaces cannot drift.
 */

import { canAssignWorkspaceRole, isWorkspaceRole, type WorkspaceRole } from '@shogo/authz'
import type { AccessContext } from './authz/access'

/** The stored policy, normalized. Null/unknown means the permissive default. */
export type WorkspaceInvitePolicy = 'members' | 'admins'

export function normalizeInvitePolicy(value: unknown): WorkspaceInvitePolicy {
  return value === 'admins' ? 'admins' : 'members'
}

/** Roles an Editor may hand out when the policy lets them invite at all. */
const EDITOR_GRANTABLE_ROLES: readonly WorkspaceRole[] = ['member', 'viewer']

export interface InvitePolicyWorkspace {
  invitePolicy?: string | null
}

/**
 * Whether `access` may grant `role` in a workspace.
 *
 * A principal that holds `workspace.members:manage` but has no workspace role
 * has no ceiling to escalate past: that is a tunnel request from the desktop
 * (the cloud proxy already authorized the caller, so `computeAccess` hands it
 * every permission) or a super admin with no membership row. Without this,
 * `canAssignWorkspaceRole` compares against a null role and refuses every
 * role, which is why creating a link or an invitation 403'd on desktop.
 *
 * `owner` stays on the unchanged rule — this card does not widen who may mint
 * an owner.
 */
export function canGrantWorkspaceRole(access: AccessContext, role: string): boolean {
  if (!isWorkspaceRole(role)) return false
  if (role !== 'owner' && access.workspaceRole === null && access.permissions.has('workspace.members:manage')) {
    return true
  }
  return canAssignWorkspaceRole(access, role)
}

/**
 * Whether `access` may invite to `workspace`, and — when `role` is given —
 * grant that role.
 *
 * `role` is the role the invite would confer. Omit it to ask only "may this
 * caller invite at all" (the UI's `canInvite`).
 */
export function canInviteToWorkspace(
  access: AccessContext,
  workspace: InvitePolicyWorkspace | null | undefined,
  role?: string | null,
): boolean {
  const requested = role ?? null
  if (requested !== null && !isWorkspaceRole(requested)) return false

  // Owners and admins: unchanged from before this card.
  if (access.permissions.has('workspace.members:manage')) {
    return requested === null ? true : canGrantWorkspaceRole(access, requested)
  }

  // Editors only, and only while the workspace allows it.
  if (access.workspaceRole !== 'member') return false
  if (normalizeInvitePolicy(workspace?.invitePolicy) === 'admins') return false
  if (requested === null) return true
  return EDITOR_GRANTABLE_ROLES.includes(requested)
}
