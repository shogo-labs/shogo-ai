/**
 * Workspace API Routes
 *
 * REST endpoints for workspace data access.
 * Used by the frontend APIPersistence layer.
 */

import { Hono } from "hono"
import { prisma } from "../lib/prisma"

/**
 * Create workspace routes.
 */
export function workspaceRoutes() {
  const router = new Hono()

  /**
   * GET /workspaces - List workspaces for current user
   * Requires userId query param or auth header
   */
  router.get("/", async (c) => {
    try {
      const userId = c.req.query("userId")
      if (!userId) {
        return c.json({ error: { code: "missing_user_id", message: "userId query param required" } }, 400)
      }

      // Get workspaces where user is a member
      const members = await prisma.member.findMany({
        where: { userId },
        include: {
          workspace: true,
        },
      })

      const workspaces = members.map((m) => ({
        ...m.workspace,
        _memberRole: m.role,
      }))

      return c.json({ ok: true, items: workspaces })
    } catch (error: any) {
      console.error("[Workspaces] List error:", error)
      return c.json({ error: { code: "list_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /workspaces/:id - Get workspace by ID
   */
  router.get("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const workspace = await prisma.workspace.findUnique({
        where: { id },
      })

      if (!workspace) {
        return c.json({ error: { code: "not_found", message: "Workspace not found" } }, 404)
      }

      return c.json({ ok: true, data: workspace })
    } catch (error: any) {
      console.error("[Workspaces] Get error:", error)
      return c.json({ error: { code: "get_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /workspaces - Create workspace
   */
  router.post("/", async (c) => {
    try {
      const body = await c.req.json<{
        name: string
        slug: string
        ownerId: string
      }>()

      const workspace = await prisma.workspace.create({
        data: {
          name: body.name,
          slug: body.slug,
        },
      })

      // Create owner membership
      await prisma.member.create({
        data: {
          userId: body.ownerId,
          workspaceId: workspace.id,
          role: "owner",
        },
      })

      return c.json({ ok: true, data: workspace }, 201)
    } catch (error: any) {
      console.error("[Workspaces] Create error:", error)
      return c.json({ error: { code: "create_failed", message: error.message } }, 500)
    }
  })

  /**
   * PATCH /workspaces/:id - Update workspace
   */
  router.patch("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const body = await c.req.json<{
        name?: string
        slug?: string
      }>()

      const workspace = await prisma.workspace.update({
        where: { id },
        data: body,
      })

      return c.json({ ok: true, data: workspace })
    } catch (error: any) {
      console.error("[Workspaces] Update error:", error)
      return c.json({ error: { code: "update_failed", message: error.message } }, 500)
    }
  })

  /**
   * DELETE /workspaces/:id - Delete workspace
   */
  router.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      await prisma.workspace.delete({
        where: { id },
      })
      return c.json({ ok: true })
    } catch (error: any) {
      console.error("[Workspaces] Delete error:", error)
      return c.json({ error: { code: "delete_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /workspaces/:id/members - List members of workspace
   */
  router.get("/:id/members", async (c) => {
    try {
      const workspaceId = c.req.param("id")
      const members = await prisma.member.findMany({
        where: { workspaceId },
        include: {
          workspace: true,
        },
      })

      // Transform to match domain store format
      const items = members.map((m) => ({
        id: m.id,
        userId: m.userId,
        workspaceId: m.workspaceId,
        role: m.role,
        createdAt: m.createdAt,
        workspace: m.workspace,
      }))

      return c.json({ ok: true, items })
    } catch (error: any) {
      console.error("[Workspaces] List members error:", error)
      return c.json({ error: { code: "list_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /workspaces/:id/projects - List projects in workspace
   */
  router.get("/:id/projects", async (c) => {
    try {
      const workspaceId = c.req.param("id")
      const projects = await prisma.project.findMany({
        where: { workspaceId },
        include: {
          workspace: true,
          folder: true,
        },
      })

      return c.json({ ok: true, items: projects })
    } catch (error: any) {
      console.error("[Workspaces] List projects error:", error)
      return c.json({ error: { code: "list_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /workspaces/:id/folders - List folders in workspace
   */
  router.get("/:id/folders", async (c) => {
    try {
      const workspaceId = c.req.param("id")
      const folders = await prisma.folder.findMany({
        where: { workspaceId },
        include: {
          parent: true,
        },
      })

      return c.json({ ok: true, items: folders })
    } catch (error: any) {
      console.error("[Workspaces] List folders error:", error)
      return c.json({ error: { code: "list_failed", message: error.message } }, 500)
    }
  })

  return router
}

export default workspaceRoutes
