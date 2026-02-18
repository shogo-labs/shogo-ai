/**
 * Thumbnail API Routes
 *
 * Endpoints:
 * - POST /projects/:projectId/thumbnail/capture - Trigger thumbnail capture
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { captureProjectThumbnail } from '../services/thumbnail.service'

/**
 * Create thumbnail routes.
 */
export function thumbnailRoutes() {
  const router = new Hono()

  /**
   * POST /projects/:projectId/thumbnail/capture
   *
   * Triggers an async screenshot capture of the project's preview.
   * Requires the sandbox URL to be provided in the request body,
   * or will attempt to resolve it from the runtime.
   *
   * Returns immediately (202 Accepted) — capture runs in background.
   */
  router.post('/projects/:projectId/thumbnail/capture', async (c) => {
    const projectId = c.req.param('projectId')

    try {
      // Validate project exists
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
      })

      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404,
        )
      }

      // Get sandbox URL from request body or resolve it
      let sandboxUrl: string | null = null

      try {
        const body = await c.req.json<{ sandboxUrl?: string }>()
        sandboxUrl = body.sandboxUrl || null
      } catch {
        // No body provided, that's fine
      }

      if (!sandboxUrl) {
        return c.json(
          { error: { code: 'missing_sandbox_url', message: 'sandboxUrl is required in request body' } },
          400,
        )
      }

      // Fire-and-forget: capture in background
      captureProjectThumbnail(projectId, sandboxUrl).catch((err) => {
        console.error(`[Thumbnail] Background capture failed for ${projectId}:`, err.message)
      })

      return c.json({ ok: true, message: 'Thumbnail capture started' }, 202)
    } catch (error: any) {
      console.error('[Thumbnail] Route error:', error)
      return c.json(
        { error: { code: 'capture_failed', message: error.message || 'Failed to start capture' } },
        500,
      )
    }
  })

  return router
}

