// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Built-in roles as named bundles of permissions.
 *
 * Workspace roles reuse the Prisma `MemberRole` enum. Project roles live
 * on project-scoped `Member` rows and only use `admin | member | viewer`
 * (legacy project-level `owner` rows are treated as `admin`).
 */

import {
  PROJECT_PERMISSIONS,
  WORKSPACE_PERMISSIONS,
  isAbilityPermission,
  type AbilityPermission,
  type ProjectPermission,
  type WorkspacePermission,
} from './permissions'

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const PROJECT_ROLES = ['admin', 'member', 'viewer'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

/** Human-facing labels. `member` is presented as "Editor". */
export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Editor',
  viewer: 'Viewer',
}

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
}

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  admin: 3,
  member: 2,
  viewer: 1,
}

export function workspaceRoleRank(role: WorkspaceRole | null | undefined): number {
  return role ? WORKSPACE_ROLE_RANK[role] : 0
}

export function projectRoleRank(role: ProjectRole | null | undefined): number {
  return role ? PROJECT_ROLE_RANK[role] : 0
}

/** Workspace owners and admins see and administer every project, restricted or not. */
export function governsAllProjects(role: WorkspaceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value)
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value)
}

/** Normalize a stored project-scoped `Member.role` (legacy `owner` -> `admin`). */
export function toProjectRole(value: unknown): ProjectRole | null {
  if (value === 'owner') return 'admin'
  return isProjectRole(value) ? value : null
}

const ALL_WORKSPACE = [...WORKSPACE_PERMISSIONS]
const ALL_PROJECT = [...PROJECT_PERMISSIONS]

/**
 * Abilities an Editor (workspace `member`) has today. A **new** ability added
 * later starts denied for Editor and Viewer unless its card says otherwise —
 * add it here only when the card grants it.
 *
 * `boards:manage` and `instance.commands:run` are here because board admin and
 * paired-desktop commands are open to every member today; the rest is the
 * card's list (agent abilities, unattended work, integrations, public links,
 * private channels).
 */
const EDITOR_ABILITIES: readonly WorkspacePermission[] = [
  'agent.exec:use',
  'agent.browser:use',
  'agent.media:generate',
  'agent.channels:send',
  'agent.social:post',
  'agent:create',
  'schedule:manage',
  'trigger:manage',
  'integrations:connect',
  'project.files:share_public',
  'channels.private:create',
  'boards:manage',
  'instance.commands:run',
]

/** Workspace-scoped permissions granted by a workspace role. */
export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  owner: ALL_WORKSPACE,
  admin: ALL_WORKSPACE.filter(
    (p) => p !== 'workspace:delete' && p !== 'workspace.owners:manage' && p !== 'workspace.billing:manage',
  ),
  member: ['workspace:read', 'workspace.members:read', 'project:create', ...EDITOR_ABILITIES],
  viewer: ['workspace:read', 'workspace.members:read'],
}

/**
 * The part of a role's bundle an admin cannot edit: the pre-RBAC permissions
 * that keep the app usable. A role policy row narrows only the abilities
 * (`ABILITY_PERMISSIONS`), never these.
 */
export const WORKSPACE_ROLE_BASE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  owner: WORKSPACE_ROLE_PERMISSIONS.owner.filter((p) => !isAbilityPermission(p)),
  admin: WORKSPACE_ROLE_PERMISSIONS.admin.filter((p) => !isAbilityPermission(p)),
  member: WORKSPACE_ROLE_PERMISSIONS.member.filter((p) => !isAbilityPermission(p)),
  viewer: WORKSPACE_ROLE_PERMISSIONS.viewer.filter((p) => !isAbilityPermission(p)),
}

/**
 * The abilities a role has when it has no policy row — today's behaviour, so
 * an existing workspace sees no change on rollout.
 */
export const WORKSPACE_ROLE_DEFAULT_ABILITIES: Record<WorkspaceRole, readonly AbilityPermission[]> = {
  owner: WORKSPACE_ROLE_PERMISSIONS.owner.filter(isAbilityPermission),
  admin: WORKSPACE_ROLE_PERMISSIONS.admin.filter(isAbilityPermission),
  member: WORKSPACE_ROLE_PERMISSIONS.member.filter(isAbilityPermission),
  viewer: WORKSPACE_ROLE_PERMISSIONS.viewer.filter(isAbilityPermission),
}

/** Extra workspace permissions for `Member.isBillingAdmin`. */
export const BILLING_ADMIN_PERMISSIONS: readonly WorkspacePermission[] = [
  'workspace:read',
  'workspace.billing:manage',
]

const EDITOR_PROJECT: readonly ProjectPermission[] = [
  'project:read',
  'project:update',
  'project:publish',
  'project:export',
]

/** Project permissions granted by a project role. */
export const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, readonly ProjectPermission[]> = {
  admin: ALL_PROJECT,
  member: EDITOR_PROJECT,
  viewer: ['project:read'],
}

/**
 * The project role a workspace role confers on projects it can see
 * (owners and admins see restricted projects too).
 */
export const WORKSPACE_TO_PROJECT_ROLE: Record<WorkspaceRole, ProjectRole> = {
  owner: 'admin',
  admin: 'admin',
  member: 'member',
  viewer: 'viewer',
}
