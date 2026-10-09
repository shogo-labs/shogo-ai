// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The permission catalog. Code authorizes against these strings, never
 * against role names, so custom roles and groups can later be added as
 * data without touching call sites.
 *
 * Format: `<resource>[.<sub-resource>]:<action>`.
 */

export const WORKSPACE_PERMISSIONS = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'workspace.members:read',
  'workspace.members:manage',
  /** Grant, revoke, or transfer the `owner` role. */
  'workspace.owners:manage',
  'workspace.billing:manage',
  /** Models, Slack, chat providers, integration policy, invite links. */
  'workspace.settings:manage',
  /** List and revoke other members' API keys. Managing your own keys only needs `workspace:read`. */
  'workspace.api_keys:manage',
  'workspace.analytics:read',
  'project:create',
] as const

export const PROJECT_PERMISSIONS = [
  'project:read',
  /** Chat, agent, code, files, git, checkpoints, folders. */
  'project:update',
  'project:delete',
  /** Project members and visibility. */
  'project.members:manage',
  'project:publish',
  'project.settings:manage',
  'project.credentials:manage',
  'project:export',
] as const

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number]
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number]
export type Permission = WorkspacePermission | ProjectPermission

export const ALL_PERMISSIONS: readonly Permission[] = [
  ...WORKSPACE_PERMISSIONS,
  ...PROJECT_PERMISSIONS,
]

const PROJECT_PERMISSION_SET: ReadonlySet<string> = new Set(PROJECT_PERMISSIONS)

/** True for permissions that are evaluated against a specific project. */
export function isProjectPermission(p: Permission): p is ProjectPermission {
  return PROJECT_PERMISSION_SET.has(p)
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value)
}
