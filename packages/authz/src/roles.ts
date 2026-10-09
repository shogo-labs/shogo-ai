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

/** Workspace-scoped permissions granted by a workspace role. */
export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  owner: ALL_WORKSPACE,
  admin: ALL_WORKSPACE.filter(
    (p) => p !== 'workspace:delete' && p !== 'workspace.owners:manage' && p !== 'workspace.billing:manage',
  ),
  member: ['workspace:read', 'workspace.members:read', 'project:create'],
  viewer: ['workspace:read', 'workspace.members:read'],
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
