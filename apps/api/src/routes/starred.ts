/**
 * Starred Projects API Routes
 *
 * REST endpoints for starred project data access.
 * Used by the frontend APIPersistence layer.
 */

import { Hono } from "hono"
import { prisma } from "../lib/prisma"

/**
 * Create starred project routes.
 */
export function starredRoutes() {
  const router = new Hono()

  /**
   * GET /starred - List starred projects for user
   */
  router.get("/", async (c) => {
    try {
      const userId = c.req.query("userId")
      if (!userId) {
        return c.json({ error: { code: "missing_user_id", message: "userId query param required" } }, 400)
      }

      const starred = await prisma.starredProject.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      })

      // Return starred projects directly
      const items = starred.map((s) => ({
        id: s.id,
        userId: s.userId,
        projectId: s.projectId,
        workspaceId: s.workspaceId,
        createdAt: s.createdAt,
      }))

      return c.json({ ok: true, items })
    } catch (error: any) {
      console.error("[Starred] List error:", error)
      return c.json({ error: { code: "list_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /starred - Star a project
   */
  router.post("/", async (c) => {
    try {
      const body = await c.req.json<{
        userId: string
        projectId: string
        workspaceId: string
      }>()

      // Check if already starred
      const existing = await prisma.starredProject.findFirst({
        where: {
          userId: body.userId,
          projectId: body.projectId,
        },
      })

      if (existing) {
        return c.json({ ok: true, data: existing, alreadyStarred: true })
      }

      const starred = await prisma.starredProject.create({
        data: {
          userId: body.userId,
          projectId: body.projectId,
          workspaceId: body.workspaceId,
        },
      })

      return c.json({ ok: true, data: starred }, 201)
    } catch (error: any) {
      console.error("[Starred] Create error:", error)
      return c.json({ error: { code: "create_failed", message: error.message } }, 500)
    }
  })

  /**
   * DELETE /starred/:id - Unstar a project by starred record ID
   */
  router.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      await prisma.starredProject.delete({
        where: { id },
      })
      return c.json({ ok: true })
    } catch (error: any) {
      console.error("[Starred] Delete error:", error)
      return c.json({ error: { code: "delete_failed", message: error.message } }, 500)
    }
  })

  /**
   * DELETE /starred/project/:projectId - Unstar by project ID
   */
  router.delete("/project/:projectId", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const userId = c.req.query("userId")

      if (!userId) {
        return c.json({ error: { code: "missing_user_id", message: "userId query param required" } }, 400)
      }

      await prisma.starredProject.deleteMany({
        where: {
          userId,
          projectId,
        },
      })

      return c.json({ ok: true })
    } catch (error: any) {
      console.error("[Starred] Delete by project error:", error)
      return c.json({ error: { code: "delete_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /starred/toggle - Toggle star status
   */
  router.post("/toggle", async (c) => {
    try {
      const body = await c.req.json<{
        userId: string
        projectId: string
        workspaceId: string
      }>()

      // Check if already starred
      const existing = await prisma.starredProject.findFirst({
        where: {
          userId: body.userId,
          projectId: body.projectId,
        },
      })

      if (existing) {
        // Unstar
        await prisma.starredProject.delete({
          where: { id: existing.id },
        })
        return c.json({ ok: true, starred: false })
      } else {
        // Star
        await prisma.starredProject.create({
          data: {
            userId: body.userId,
            projectId: body.projectId,
            workspaceId: body.workspaceId,
          },
        })
        return c.json({ ok: true, starred: true })
      }
    } catch (error: any) {
      console.error("[Starred] Toggle error:", error)
      return c.json({ error: { code: "toggle_failed", message: error.message } }, 500)
    }
  })

  return router
}

export default starredRoutes
