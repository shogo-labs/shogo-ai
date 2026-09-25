// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /api/internal/projects/:projectId/trust
 *
 * Authoritative read of a project's trust + folder configuration.
 * Called by the agent-runtime at the start of every chat turn (and on
 * demand via /internal/refresh-trust IPC) so it never relies on the
 * spawn-time `TRUST_LEVEL` env snapshot — which can't be updated for
 * a running process and was the root cause of the
 * "Trust folder still shows restricted" bug.
 *
 * Returns the same shape the runtime's TrustResolver consumes:
 *   { trustLevel, workingMode, linkedFolders }
 *
 * Mounted by both the cloud internal router (SA token OR runtime token) and
 * the desktop composer (runtime token only). The desktop mount is what makes
 * "Trust folder" reach a running agent — the runtime fails closed to
 * `restricted` when this read 404s.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { prisma } from '../lib/prisma'

export interface ProjectTrustRoutesOptions {
  authorize: (c: Context, projectId: string) => Promise<boolean>
}

export function projectTrustRoutes({ authorize }: ProjectTrustRoutesOptions): Hono {
  const app = new Hono()

  app.get('/projects/:projectId/trust', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) return c.json({ error: 'Missing projectId' }, 400)

    if (!(await authorize(c, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          trustLevel: true,
          workingMode: true,
          projectFolders: {
            select: { path: true, isPrimary: true, lastOpenedAt: true },
          },
        },
      })
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }

      // Same ordering the runtime spawn path uses (manager.ts): primary
      // folder first, then the rest by most-recently-opened. Keeping the
      // contract identical means the resolver and the spawn env agree on
      // "what is the primary workspace dir".
      const folders = [...project.projectFolders]
        .sort((a, b) => {
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
          const at = a.lastOpenedAt?.getTime() ?? 0
          const bt = b.lastOpenedAt?.getTime() ?? 0
          return bt - at
        })
        .map((f) => f.path)

      const trustLevel: 'trusted' | 'restricted' =
        project.trustLevel === 'restricted' ? 'restricted' : 'trusted'
      const workingMode: 'managed' | 'external' =
        project.workingMode === 'external' ? 'external' : 'managed'

      return c.json({ trustLevel, workingMode, linkedFolders: folders })
    } catch (err: any) {
      console.error(`[Internal] trust read for ${projectId} failed:`, err.message)
      return c.json({ error: 'Failed to read project trust' }, 500)
    }
  })

  return app
}
