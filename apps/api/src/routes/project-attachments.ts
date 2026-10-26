// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project→project attachment routes.
 *
 * `GET/POST/DELETE /api/projects/:id/attachments[/:attachedProjectId]` — the
 * Folders panel's attach / list / detach surface. Mounted unconditionally in
 * both cloud and local mode (the Folders panel exists on both), unlike
 * `/api/local/projects`, which is desktop-only.
 *
 * The desktop-only router (`routes/local-projects.ts`) delegates its
 * `POST`/`DELETE /:id/attachments` handlers here too, so one authz policy and
 * one set of handlers serve web, desktop and cloud. Before this, the cloud
 * panel called a route that only existed under `SHOGO_LOCAL_MODE=true` (404 on
 * staging) and the local router only checked that *someone* was signed in.
 */

import { Hono, type Context } from 'hono'
import type { Permission } from '@shogo/authz'
import { accessibleProjectsWhere, authorize, denialResponse, principalOf } from '../lib/authz'
import { prisma } from '../lib/prisma'
import {
  attachmentsMount,
  restartAnchorRuntimeBackground,
} from '../lib/project-attachment-runtime'
import { authMiddleware, requireAuth } from '../middleware/auth'
import {
  attachProjectToProject,
  detachProjectFromProject,
  listAttachments,
  ProjectAttachmentError,
  type ProjectAttachmentRow,
} from '../services/project-attachment.service'
import {
  authorizeAttachmentAction,
  filterReadableAttachments,
  type AttachmentAuthorizer,
} from '../services/project-attachment.authz'

/** Map a ProjectAttachmentError to an HTTP response. */
export function mapAttachmentError(c: Context, err: unknown): Response {
  if (err instanceof ProjectAttachmentError) {
    const status =
      err.code === 'project_not_found' ? 404 : err.code === 'self_attach' ? 400 : 409
    return c.json({ error: err.code, message: err.message }, status)
  }
  console.error('[project-attachments] attachment error:', err)
  return c.json({ error: 'internal_error' }, 500)
}

/**
 * Authorizer for a session-authenticated (web / desktop / cloud) request.
 * Identity comes from the `auth` context var that `authMiddleware` sets.
 */
export function sessionAttachmentAuthorizer(c: Context): AttachmentAuthorizer {
  return {
    async requireProject(projectId: string, permission: Permission) {
      const decision = await authorize(c, permission, { projectId })
      if (!decision.ok) return denialResponse(c, decision)
      return { workspaceId: decision.access.workspaceId ?? '' }
    },
    async readableProjectsWhere(workspaceId: string) {
      return accessibleProjectsWhere(principalOf(c), workspaceId)
    },
    crossWorkspace(targetProjectId: string) {
      return c.json(
        {
          error: 'cross_workspace',
          message: `Project ${targetProjectId} is not in the same workspace as the anchor project`,
        },
        409,
      )
    },
  }
}

/** `GET /:id/attachments` — list the anchor's attachments the caller can read. */
export async function listProjectAttachmentsHandler(c: Context): Promise<Response> {
  const projectId = c.req.param('id')!
  const authz = sessionAttachmentAuthorizer(c)
  const denied = await authorizeAttachmentAction(authz, 'list', projectId)
  if (denied) return denied

  const rows = await listAttachments(projectId)
  const anchor = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })) as { workspaceId: string } | null
  const visible = await filterReadableAttachments(
    authz,
    anchor?.workspaceId ?? '',
    rows,
    async (ids, where) => {
      const readable = (await prisma.project.findMany({
        where: { AND: [{ id: { in: ids } }, where] },
        select: { id: true },
      })) as Array<{ id: string }>
      return readable.map((r) => r.id)
    },
  )
  if (visible instanceof Response) return visible
  return c.json({ projectId, attachments: visible })
}

/**
 * `POST /:id/attachments { attachedProjectId, attachMode? }` — attach another
 * project (same workspace) to this anchor. Idempotent.
 *
 * Off metal a change restarts the anchor runtime so the new member is mounted;
 * on metal the attachment is a durable record only.
 */
export async function attachProjectHandler(c: Context): Promise<Response> {
  const projectId = c.req.param('id')!

  let body: { attachedProjectId?: string; attachMode?: string }
  try {
    body = (await c.req.json()) as { attachedProjectId?: string; attachMode?: string }
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const attachedProjectId = body.attachedProjectId
  if (!attachedProjectId || typeof attachedProjectId !== 'string') {
    return c.json({ error: 'attachedProjectId_required' }, 400)
  }
  const attachMode = body.attachMode === 'readonly' ? 'readonly' : 'readwrite'

  const denied = await authorizeAttachmentAction(sessionAttachmentAuthorizer(c), 'attach', projectId, {
    projectId: attachedProjectId,
    attachMode,
  })
  if (denied) return denied

  try {
    const attachment = await attachProjectToProject(projectId, attachedProjectId, attachMode)
    if (!attachmentsMount()) return c.json({ attachment, mounted: false }, 201)
    restartAnchorRuntimeBackground(projectId, 'attach')
    return c.json({ attachment }, 201)
  } catch (err) {
    return mapAttachmentError(c, err)
  }
}

/** `DELETE /:id/attachments/:attachedProjectId` — detach. No-op if absent. */
export async function detachProjectHandler(c: Context): Promise<Response> {
  const projectId = c.req.param('id')!
  const attachedProjectId = c.req.param('attachedProjectId')!

  const denied = await authorizeAttachmentAction(
    sessionAttachmentAuthorizer(c),
    'detach',
    projectId,
  )
  if (denied) return denied

  try {
    const removed = await detachProjectFromProject(projectId, attachedProjectId)
    if (removed && attachmentsMount()) restartAnchorRuntimeBackground(projectId, 'detach')
    return c.json({ ok: true, removed })
  } catch (err) {
    return mapAttachmentError(c, err)
  }
}

export type { ProjectAttachmentRow }

/** Mounted at `/api/projects` in both cloud and local mode. */
export function projectAttachmentRoutes(): Hono {
  const router = new Hono()
  router.use('*', authMiddleware)
  router.use('*', requireAuth)

  router.get('/:id/attachments', listProjectAttachmentsHandler)
  router.post('/:id/attachments', attachProjectHandler)
  router.delete('/:id/attachments/:attachedProjectId', detachProjectHandler)

  return router
}
