// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The permission catalog. Code authorizes against these strings, never
 * against role names, so custom roles and groups can later be added as
 * data without touching call sites.
 *
 * Format: `<resource>[.<sub-resource>]:<action>`.
 */

export const BASE_WORKSPACE_PERMISSIONS = [
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
  /** Download one archive of the whole workspace (every model + every project's files). */
  'workspace:export',
  /**
   * Move a workspace — or part of it — to another instance, and switch this
   * copy over to the target. Reads every record and file the workspace has,
   * so it sits with `workspace:export` rather than `workspace:update`.
   */
  'workspace:move',
  'project:create',
] as const

/**
 * The abilities a workspace admin can grant or revoke per role, group and
 * member (SHO-417). They are a separate list from the base permissions above
 * because a role policy narrows *these* — an admin can never edit away
 * `workspace:read` and lock a role out of the app.
 */
export const ABILITY_PERMISSIONS = [
  // --- Agent abilities ------------------------------------------------------
  // What an agent may do on a person's behalf. The runtime hides the tool and
  // the server refuses the internal route, so a denied ability is denied twice.
  /** Run shell commands (`exec`). */
  'agent.exec:use',
  /** Drive a browser (`browser` subagent). */
  'agent.browser:use',
  /** Generate images, video, music and 3D (`generate_image`, media routes). */
  'agent.media:generate',
  /** Send through a connected channel (`send_message`, `channel_connect`). */
  'agent.channels:send',
  /** Post to social accounts (`social_media` post actions). */
  'agent.social:post',

  // --- Unattended work ------------------------------------------------------
  /** Create a new agent / project agent. */
  'agent:create',
  /** Create, edit or delete a schedule. */
  'schedule:manage',
  /** Create, edit or delete a trigger. */
  'trigger:manage',
  /** Apply a `shogo-system.yaml` manifest. */
  'system:apply',

  // --- Approvals ------------------------------------------------------------
  /**
   * Decide a blocked tool call that belongs to someone else. You can always
   * decide your own, so this only widens that to other people's.
   */
  'agent.approvals:decide',

  // --- Integrations ---------------------------------------------------------
  'integrations:connect',

  // --- Data -----------------------------------------------------------------
  /**
   * Create a public `share_file` link. Workspace-scoped ability even though the
   * resource is a project file: the policy is per member, not per project.
   */
  'project.files:share_public',
  /** Read a project's stored secrets (`.env`, credentials). */
  'project.secrets:read',

  // --- Paired desktop -------------------------------------------------------
  /** Dispatch a command to a paired desktop instance. */
  'instance.commands:run',

  // --- Team chat and boards -------------------------------------------------
  'channels.private:create',
  'boards:manage',
  /** Read another member's activity summary (`member_activity`). */
  'members.activity:read',

  // --- Models ---------------------------------------------------------------
  /**
   * Use every model under the workspace ceiling, ignoring the role/group model
   * grant. Never widens the ceiling itself. Owner/admin only by default.
   */
  'models:use_all',
] as const

export const WORKSPACE_PERMISSIONS = [
  ...BASE_WORKSPACE_PERMISSIONS,
  ...ABILITY_PERMISSIONS,
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
export type AbilityPermission = (typeof ABILITY_PERMISSIONS)[number]
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number]
export type Permission = WorkspacePermission | ProjectPermission

export const ALL_PERMISSIONS: readonly Permission[] = [
  ...WORKSPACE_PERMISSIONS,
  ...PROJECT_PERMISSIONS,
]

const PROJECT_PERMISSION_SET: ReadonlySet<string> = new Set(PROJECT_PERMISSIONS)
const ABILITY_PERMISSION_SET: ReadonlySet<string> = new Set(ABILITY_PERMISSIONS)

/** True for permissions that are evaluated against a specific project. */
export function isProjectPermission(p: Permission): p is ProjectPermission {
  return PROJECT_PERMISSION_SET.has(p)
}

/** True for the per-member abilities an admin can grant or revoke (SHO-417). */
export function isAbilityPermission(p: Permission): p is AbilityPermission {
  return ABILITY_PERMISSION_SET.has(p)
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value)
}

/** True for a string that names a grantable ability (used to validate policy writes). */
export function isAbilityPermissionName(value: unknown): value is AbilityPermission {
  return typeof value === 'string' && ABILITY_PERMISSION_SET.has(value)
}
