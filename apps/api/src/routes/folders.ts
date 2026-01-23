/**
 * Folder API Routes
 *
 * REST endpoints for folder data access.
 * Used by the frontend APIPersistence layer.
 */

import { Hono } from "hono"
import { prisma } from "../lib/prisma"
import type { Folder } from "@prisma/client"

/**
 * Create folder routes.
 */
export function folderRoutes() {
  const router = new Hono()

  /**
   * GET /folders - List all folders (optionally filtered by workspaceId)
   */
  router.get("/", async (c) => {
    try {
      const workspaceId = c.req.query("workspaceId")

      const folders = await prisma.folder.findMany({
        where: workspaceId ? { workspaceId } : undefined,
        include: {
          parent: true,
          workspace: true,
        },
      })

      return c.json({ ok: true, items: folders })
    } catch (error: any) {
      console.error("[Folders] List error:", error)
      return c.json({ error: { code: "list_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /folders/:id - Get folder by ID
   */
  router.get("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const folder = await prisma.folder.findUnique({
        where: { id },
        include: {
          parent: true,
          workspace: true,
        },
      })

      if (!folder) {
        return c.json({ error: { code: "not_found", message: "Folder not found" } }, 404)
      }

      return c.json({ ok: true, data: folder })
    } catch (error: any) {
      console.error("[Folders] Get error:", error)
      return c.json({ error: { code: "get_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /folders - Create folder
   */
  router.post("/", async (c) => {
    try {
      const body = await c.req.json<{
        name: string
        workspaceId: string
        parentId?: string
      }>()

      const folder = await prisma.folder.create({
        data: {
          name: body.name,
          workspaceId: body.workspaceId,
          parentId: body.parentId,
        },
        include: {
          parent: true,
          workspace: true,
        },
      })

      return c.json({ ok: true, data: folder }, 201)
    } catch (error: any) {
      console.error("[Folders] Create error:", error)
      return c.json({ error: { code: "create_failed", message: error.message } }, 500)
    }
  })

  /**
   * PATCH /folders/:id - Update folder
   */
  router.patch("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const body = await c.req.json<{
        name?: string
        parentId?: string | null
      }>()

      const folder = await prisma.folder.update({
        where: { id },
        data: body,
        include: {
          parent: true,
          workspace: true,
        },
      })

      return c.json({ ok: true, data: folder })
    } catch (error: any) {
      console.error("[Folders] Update error:", error)
      return c.json({ error: { code: "update_failed", message: error.message } }, 500)
    }
  })

  /**
   * DELETE /folders/:id - Delete folder
   */
  router.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      await prisma.folder.delete({
        where: { id },
      })
      return c.json({ ok: true })
    } catch (error: any) {
      console.error("[Folders] Delete error:", error)
      return c.json({ error: { code: "delete_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /folders/:id/ancestors - Get ancestor chain for folder
   */
  router.get("/:id/ancestors", async (c) => {
    try {
      const id = c.req.param("id")
      const ancestors: Array<Folder & { parent: Folder | null }> = []
      let currentId: string | null = id

      // Fetch ancestors iteratively
      async function fetchFolder(folderId: string) {
        return prisma.folder.findUnique({
          where: { id: folderId },
          include: { parent: true },
        })
      }

      while (currentId) {
        const folder = await fetchFolder(currentId)
        if (!folder) break
        ancestors.unshift(folder)
        currentId = folder.parentId
      }

      return c.json({ ok: true, items: ancestors })
    } catch (error: any) {
      console.error("[Folders] Get ancestors error:", error)
      return c.json({ error: { code: "get_failed", message: error.message } }, 500)
    }
  })

  return router
}

export default folderRoutes
