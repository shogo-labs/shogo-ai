// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud Projects Routes (Shogo Desktop / `SHOGO_LOCAL_MODE=true` only).
 *
 * Lets a cloud-signed-in desktop browse the cloud projects its stored
 * `SHOGO_API_KEY` can see and "open" one locally. Opening links a local
 * `Project` row keyed by the **cloud** project id (1:1) and flags it
 * cloud-linked; the runtime adapter then auto-pulls its workspace files on
 * first start and watches for local edits to push back (see
 * `lib/runtime/cloud-content-sync.ts`).
 *
 * Mounted in `apps/api/src/server.ts` at `/api/local/cloud-projects`, only
 * when `SHOGO_LOCAL_MODE=true` — the cloud build doesn't expose this.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { isFederatedEnabled, listCloudProjectsForWorkspace } from '../lib/federated-upstream'
import {
  getCloudLinkedProjectIds,
  getCloudSyncStatus,
  isProjectCloudLinked,
  markProjectCloudLinked,
  unmarkProjectCloudLinked,
} from '../lib/runtime/cloud-content-sync'

export function cloudProjectsRoutes(): Hono {
  const router = new Hono()

  /**
   * GET / — list the cloud projects the signed-in desktop can see, tagged
   * with whether each is already linked locally. Empty list (not an error)
   * when the desktop isn't cloud-signed-in, so the picker degrades cleanly.
   */
  router.get('/', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)

    if (!(await isFederatedEnabled())) {
      return c.json({ projects: [], linked: [], signedIn: false })
    }

    const [projects, linkedIds] = await Promise.all([
      listCloudProjectsForWorkspace(),
      getCloudLinkedProjectIds(),
    ])
    const linked = new Set(linkedIds)
    return c.json({
      signedIn: true,
      linked: linkedIds,
      projects: projects.map((p) => ({ ...p, cloudLinked: linked.has(p.id) })),
    })
  })

  /**
   * POST /:id/open — link a cloud project locally and ensure a `Project`
   * row exists keyed by the cloud project id. Idempotent: re-opening an
   * already-linked project just refreshes the flag and returns the row.
   * The actual workspace pull happens on the next runtime start.
   */
  router.post('/:id/open', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) return c.json({ error: 'unauthenticated' }, 401)
    if (!(await isFederatedEnabled())) return c.json({ error: 'not_signed_in_to_cloud' }, 400)

    const cloudProjectId = c.req.param('id')
    if (!cloudProjectId) return c.json({ error: 'missing_project_id' }, 400)

    const body = (await c.req.json().catch(() => ({}))) as { name?: string }

    // Resolve a display name: caller-supplied first, else the cloud listing.
    let name = (body.name && body.name.trim()) || ''
    if (!name) {
      const cloudProjects = await listCloudProjectsForWorkspace()
      name = cloudProjects.find((p) => p.id === cloudProjectId)?.name?.trim() || 'Cloud project'
    }

    try {
      const existing = await prisma.project.findUnique({ where: { id: cloudProjectId } })
      let project = existing
      if (!project) {
        // Personal workspace for the single local user (mirrors local-projects).
        const personal = await prisma.workspace.findFirst({
          where: { members: { some: { userId } } },
          orderBy: { createdAt: 'asc' },
        })
        if (!personal) return c.json({ error: 'no_workspace_for_user' }, 400)

        project = await prisma.project.create({
          data: {
            // Key the local row by the CLOUD project id so the workspace dir
            // (`<workspacesDir>/<cloudProjectId>/`) and the cloud Files/git
            // endpoints (`/api/projects/:cloudProjectId/...`) line up 1:1.
            id: cloudProjectId,
            name,
            workspaceId: personal.id,
            createdBy: userId,
            // Managed (not 'external'): the workspace lives under the app's
            // data dir and is materialized from cloud by the runtime adapter.
            workingMode: 'managed',
            runtimeEnabled: true,
            trustLevel: 'trusted',
            status: 'active',
            tier: 'starter',
            accessLevel: 'private',
          },
        })
      }

      await markProjectCloudLinked(cloudProjectId)

      return c.json({ project, cloudLinked: true, created: !existing })
    } catch (err: any) {
      console.error('[cloud-projects] open failed:', err)
      return c.json({ error: 'open_failed', message: err?.message ?? String(err) }, 500)
    }
  })

  /**
   * DELETE /:id/link — stop syncing a project's contents with cloud. The
   * local `Project` row and its already-pulled files are left untouched;
   * only the cloud-linked flag is cleared (so the watcher won't restart on
   * the next open).
   */
  router.delete('/:id/link', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    await unmarkProjectCloudLinked(id)
    return c.json({ ok: true, cloudLinked: false })
  })

  /**
   * GET /:id/sync-status — current content-sync state for the project IDE
   * chrome (pulling / watching / pushing / error / offline + last push +
   * one-writer warning).
   */
  router.get('/:id/sync-status', async (c) => {
    const auth = c.get('auth' as never) as { userId?: string } | undefined
    if (!auth?.userId) return c.json({ error: 'unauthenticated' }, 401)
    const id = c.req.param('id')
    const [status, cloudLinked] = await Promise.all([
      Promise.resolve(getCloudSyncStatus(id)),
      isProjectCloudLinked(id),
    ])
    return c.json({ cloudLinked, status })
  })

  return router
}
