/**
 * Member API Routes
 *
 * Authenticated endpoints for member operations.
 * All routes require authentication.
 */

import { Hono } from "hono"

/**
 * Auth context expected from authentication middleware
 */
interface AuthContext {
  userId: string
  email?: string
}

/**
 * Member route configuration
 */
export interface MemberRoutesConfig {
  /** Studio core domain store for member operations */
  studioCore: {
    memberCollection: {
      query: () => {
        where: (filter: Record<string, any>) => {
          first: () => Promise<any>
          toArray: () => Promise<any[]>
        }
      }
      loadAll: () => Promise<void>
      findForResource: (type: "workspace" | "project", id: string) => any[]
    }
    workspaceCollection: {
      get: (id: string) => any
    }
    leaveWorkspace: (memberId: string, userId: string) => Promise<void>
  }
}

/**
 * Create member routes
 *
 * @param config - Route configuration
 * @returns Hono router with member endpoints
 */
export function memberRoutes(config: MemberRoutesConfig) {
  const { studioCore } = config
  const router = new Hono()

  /**
   * DELETE /members/:id/leave - Leave a workspace
   *
   * User can only leave themselves (memberId must belong to authenticated user).
   * Cannot leave if user is the last owner.
   *
   * Response:
   * - success: true
   */
  router.delete("/:id/leave", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const memberId = c.req.param("id")

      // Get the member
      const member = await studioCore.memberCollection
        .query()
        .where({ id: memberId })
        .first()

      if (!member) {
        return c.json({ error: { code: "not_found", message: "Member not found" } }, 404)
      }

      // Verify user can only leave themselves
      if (member.userId !== auth.userId) {
        return c.json(
          { error: { code: "forbidden", message: "You can only leave a workspace yourself" } },
          403
        )
      }

      // Verify member is a workspace member
      if (!member.workspaceId) {
        return c.json(
          { error: { code: "invalid_state", message: "Member is not a workspace member" } },
          400
        )
      }

      // Leave the workspace
      await studioCore.leaveWorkspace(memberId, auth.userId)

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[members] DELETE /:id/leave error:", error)

      // Handle specific error cases
      if (error.message?.includes("last owner")) {
        return c.json(
          {
            error: {
              code: "last_owner",
              message: "Cannot leave: you are the last owner of this workspace. Transfer ownership first.",
            },
          },
          400
        )
      }

      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to leave workspace" } },
        500
      )
    }
  })

  return router
}
