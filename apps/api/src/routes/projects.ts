/**
 * Project API Routes
 *
 * REST endpoints for project data access.
 * Used by the frontend APIPersistence layer.
 */

import { Hono } from "hono"
import { prisma } from "../lib/prisma"

/**
 * Create project routes.
 */
export function projectRoutes() {
  const router = new Hono()

  /**
   * GET /projects - List all projects (optionally filtered by workspaceId)
   */
  router.get("/", async (c) => {
    try {
      const workspaceId = c.req.query("workspaceId")

      const projects = await prisma.project.findMany({
        where: workspaceId ? { workspaceId } : undefined,
        include: {
          workspace: true,
          folder: true,
        },
      })

      return c.json({ ok: true, items: projects })
    } catch (error: any) {
      console.error("[Projects] List error:", error)
      return c.json({ error: { code: "list_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /projects/:id - Get project by ID
   */
  router.get("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          workspace: true,
          folder: true,
        },
      })

      if (!project) {
        return c.json({ error: { code: "not_found", message: "Project not found" } }, 404)
      }

      return c.json({ ok: true, data: project })
    } catch (error: any) {
      console.error("[Projects] Get error:", error)
      return c.json({ error: { code: "get_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects - Create project
   */
  router.post("/", async (c) => {
    try {
      const body = await c.req.json<{
        name: string
        workspaceId: string
        folderId?: string
        tier?: string
        status?: string
        createdBy?: string
      }>()

      const project = await prisma.project.create({
        data: {
          name: body.name,
          workspaceId: body.workspaceId,
          folderId: body.folderId,
          tier: (body.tier as any) || "starter",
          status: (body.status as any) || "draft",
          createdBy: body.createdBy,
        },
        include: {
          workspace: true,
          folder: true,
        },
      })

      return c.json({ ok: true, data: project }, 201)
    } catch (error: any) {
      console.error("[Projects] Create error:", error)
      return c.json({ error: { code: "create_failed", message: error.message } }, 500)
    }
  })

  /**
   * PATCH /projects/:id - Update project
   */
  router.patch("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const body = await c.req.json<{
        name?: string
        folderId?: string | null
        tier?: string
        status?: string
      }>()

      const project = await prisma.project.update({
        where: { id },
        data: body as any,
        include: {
          workspace: true,
          folder: true,
        },
      })

      return c.json({ ok: true, data: project })
    } catch (error: any) {
      console.error("[Projects] Update error:", error)
      return c.json({ error: { code: "update_failed", message: error.message } }, 500)
    }
  })

  /**
   * DELETE /projects/:id - Delete project
   */
  router.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      await prisma.project.delete({
        where: { id },
      })
      return c.json({ ok: true })
    } catch (error: any) {
      console.error("[Projects] Delete error:", error)
      return c.json({ error: { code: "delete_failed", message: error.message } }, 500)
    }
  })

  return router
}

export default projectRoutes
