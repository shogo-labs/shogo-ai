// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Effective-access resolution. Pure: callers load the membership facts
 * and this decides what they add up to.
 *
 *   super_admin                         -> everything
 *   workspace owner / admin             -> every project, restricted or not
 *   workspace member / viewer, open P   -> max(workspace role, project role)
 *   workspace member / viewer, restr. P -> project role only
 *   guest (project rows only)           -> project role on that project only
 *   anyone else                         -> nothing
 */

import { ALL_PERMISSIONS, type Permission } from './permissions'
import {
  BILLING_ADMIN_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
  WORKSPACE_TO_PROJECT_ROLE,
  governsAllProjects,
  projectRoleRank,
  workspaceRoleRank,
  type ProjectRole,
  type WorkspaceRole,
} from './roles'

export type ProjectVisibility = 'workspace' | 'restricted'

export interface AccessFacts {
  isSuperAdmin?: boolean
  /** Role from the workspace-scoped Member row (`projectId IS NULL`), if any. */
  workspaceRole?: WorkspaceRole | null
  isBillingAdmin?: boolean
  /** Present when resolving access to a specific project. */
  project?: {
    visibility: ProjectVisibility
    /** Role from the caller's project-scoped Member row on this project, if any. */
    projectRole?: ProjectRole | null
  } | null
}

export interface EffectiveAccess {
  permissions: ReadonlySet<Permission>
  workspaceRole: WorkspaceRole | null
  /** Effective role on the project in scope (null when no project or no access). */
  projectRole: ProjectRole | null
  /** Caller has project access only through project-scoped rows. */
  isGuest: boolean
  isSuperAdmin: boolean
}

const EMPTY: ReadonlySet<Permission> = new Set()

export function resolveAccess(facts: AccessFacts): EffectiveAccess {
  const workspaceRole = facts.workspaceRole ?? null
  const explicitProjectRole = facts.project?.projectRole ?? null

  if (facts.isSuperAdmin) {
    return {
      permissions: new Set(ALL_PERMISSIONS),
      workspaceRole,
      projectRole: facts.project ? 'admin' : null,
      isGuest: false,
      isSuperAdmin: true,
    }
  }

  const permissions = new Set<Permission>()
  if (workspaceRole) {
    for (const p of WORKSPACE_ROLE_PERMISSIONS[workspaceRole]) permissions.add(p)
    if (facts.isBillingAdmin) for (const p of BILLING_ADMIN_PERMISSIONS) permissions.add(p)
  }

  let projectRole: ProjectRole | null = null
  if (facts.project) {
    const inherited =
      workspaceRole && (governsAllProjects(workspaceRole) || facts.project.visibility === 'workspace')
        ? WORKSPACE_TO_PROJECT_ROLE[workspaceRole]
        : null
    projectRole =
      projectRoleRank(explicitProjectRole) > projectRoleRank(inherited) ? explicitProjectRole : inherited

    if (projectRole) for (const p of PROJECT_ROLE_PERMISSIONS[projectRole]) permissions.add(p)
  }

  return {
    permissions: permissions.size ? permissions : EMPTY,
    workspaceRole,
    projectRole,
    isGuest: !workspaceRole && !!explicitProjectRole,
    isSuperAdmin: false,
  }
}

export function hasPermission(access: EffectiveAccess, permission: Permission): boolean {
  return access.permissions.has(permission)
}

/** Sorted permission list, for API payloads. */
export function permissionList(access: EffectiveAccess): Permission[] {
  return ALL_PERMISSIONS.filter((p) => access.permissions.has(p))
}

/**
 * No-escalation rule for workspace roles: an actor may grant (or revoke) a
 * role only when they hold `workspace.members:manage` and the role is at or
 * below their own. Granting or touching `owner` additionally requires
 * `workspace.owners:manage`.
 */
export function canAssignWorkspaceRole(
  actor: EffectiveAccess,
  role: WorkspaceRole,
): boolean {
  if (actor.isSuperAdmin) return true
  if (!actor.permissions.has('workspace.members:manage')) return false
  if (role === 'owner') return actor.permissions.has('workspace.owners:manage')
  return workspaceRoleRank(role) <= workspaceRoleRank(actor.workspaceRole)
}

/** No-escalation rule for project roles on the project in scope. */
export function canAssignProjectRole(actor: EffectiveAccess, role: ProjectRole): boolean {
  if (actor.isSuperAdmin) return true
  if (!actor.permissions.has('project.members:manage')) return false
  return projectRoleRank(role) <= projectRoleRank(actor.projectRole)
}

/**
 * Whether `actor` may change or remove an existing workspace member holding
 * `targetRole`: the same rule as granting that role. Rows with an unknown
 * role only need `workspace.members:manage`.
 */
export function canManageWorkspaceMember(actor: EffectiveAccess, targetRole: WorkspaceRole | null): boolean {
  if (targetRole) return canAssignWorkspaceRole(actor, targetRole)
  return actor.isSuperAdmin || actor.permissions.has('workspace.members:manage')
}

/** Whether `actor` may change or remove an existing project member holding `targetRole`. */
export function canManageProjectMember(actor: EffectiveAccess, targetRole: ProjectRole | null): boolean {
  if (targetRole) return canAssignProjectRole(actor, targetRole)
  return actor.isSuperAdmin || actor.permissions.has('project.members:manage')
}