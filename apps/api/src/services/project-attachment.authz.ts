// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Authorization policy for project→project attachments.
 *
 * The Folders panel reaches attachments from three surfaces: the cloud/public
 * session API (`/api/projects/:id/attachments`), the desktop-only local router
 * (`/api/local/projects/:id/attachments`) and the cluster-internal runtime API
 * (`/api/internal/projects/:projectId/attachments`). Before this module the
 * local router only checked that *someone* was signed in, so any signed-in user
 * could attach any project; the internal routes had the correct rules but they
 * lived inline and the cloud route did not exist at all.
 *
 * The rules therefore live here once and each surface supplies an
 * `AttachmentAuthorizer` adapter for its own identity model and error envelope:
 *
 *   GET                  → `project:read` on the anchor
 *   POST / DELETE        → `project:update` on the anchor
 *   POST target          → `project:read` for a `readonly` attach,
 *                          `project:update` for a `readwrite` attach
 *   GET listing          → only targets the caller can read
 *   any action           → anchor and target must share a workspace
 *
 * Cross-workspace is checked here *and* enforced authoritatively by
 * `attachProjectToProject` (`cross_workspace` → 409); this pre-check just
 * refuses before any row is written.
 */

import type { Permission } from '@shogo/authz'
import type { ProjectAttachmentRow } from './project-attachment.service'

/** One adapter per surface; the policy below is shared. */
export interface AttachmentAuthorizer {
  /**
   * Enforce `permission` on `projectId`. Resolves the project's workspace when
   * allowed, or the surface's own denial Response when not.
   */
  requireProject(
    projectId: string,
    permission: Permission,
  ): Promise<{ workspaceId: string } | Response>
  /** Prisma filter for the projects this caller may read, or `null` when unscoped. */
  readableProjectsWhere(
    workspaceId: string,
  ): Promise<Record<string, unknown> | null | Response>
  /** The surface's 409 for a target outside the anchor's workspace. */
  crossWorkspace(targetProjectId: string): Response
}

export type AttachmentAction = 'list' | 'attach' | 'detach'

/** The permission a caller needs on the ANCHOR for each action. */
export function anchorPermission(action: AttachmentAction): Permission {
  return action === 'list' ? 'project:read' : 'project:update'
}

/** The permission a caller needs on the TARGET project for a given attach mode. */
export function targetPermission(attachMode: string | undefined | null): Permission {
  return attachMode === 'readonly' ? 'project:read' : 'project:update'
}

/**
 * Authorize a Folders-panel action. Returns `null` when allowed, otherwise the
 * Response to send. `target` is only meaningful for `attach`.
 */
export async function authorizeAttachmentAction(
  authz: AttachmentAuthorizer,
  action: AttachmentAction,
  anchorProjectId: string,
  target?: { projectId: string; attachMode?: string | null },
): Promise<Response | null> {
  const anchor = await authz.requireProject(anchorProjectId, anchorPermission(action))
  if (anchor instanceof Response) return anchor
  if (action !== 'attach' || !target) return null

  const resolved = await authz.requireProject(target.projectId, targetPermission(target.attachMode))
  if (resolved instanceof Response) return resolved
  if (resolved.workspaceId !== anchor.workspaceId) return authz.crossWorkspace(target.projectId)
  return null
}

/**
 * Keep only the attachments whose target the caller can read, so the Folders
 * panel never lists a project it cannot open. Unscoped callers (service
 * accounts) see everything.
 */
export async function filterReadableAttachments(
  authz: AttachmentAuthorizer,
  anchorWorkspaceId: string,
  rows: ProjectAttachmentRow[],
  findReadable: (ids: string[], where: Record<string, unknown>) => Promise<string[]>,
): Promise<ProjectAttachmentRow[] | Response> {
  if (rows.length === 0) return rows
  const where = await authz.readableProjectsWhere(anchorWorkspaceId)
  if (where instanceof Response) return where
  if (!where) return rows
  const readable = new Set(await findReadable(rows.map((r) => r.attachedProjectId), where))
  return rows.filter((r) => readable.has(r.attachedProjectId))
}
