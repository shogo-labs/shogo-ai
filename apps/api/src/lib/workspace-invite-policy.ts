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
    return requested === null ? true : canAssignWorkspaceRole(access, requested)
  }

  // Editors only, and only while the workspace allows it.
  if (access.workspaceRole !== 'member') return false
  if (normalizeInvitePolicy(workspace?.invitePolicy) === 'admins') return false
  if (requested === null) return true
  return EDITOR_GRANTABLE_ROLES.includes(requested)
}
