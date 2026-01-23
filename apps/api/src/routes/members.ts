/**
 * Member API Routes
 *
 * Authenticated endpoints for member operations.
 * Uses Prisma-based member service.
 */

import { Hono } from "hono"
import * as memberService from "../services/member.service"

/**
 * Auth context expected from authentication middleware
 */
interface AuthContext {
  userId: string
  email?: string
}

/**
 * Create member routes
 */
export function memberRoutes() {
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
      const member = await memberService.getMember(memberId)

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
      await memberService.leaveWorkspace(memberId, auth.userId)

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

  /**
   * GET /members/workspace/:workspaceId - Get members of a workspace
   */
  router.get("/workspace/:workspaceId", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const workspaceId = c.req.param("workspaceId")

      // Check user has access to workspace
      const userMember = await memberService.getMemberByUserAndWorkspace(auth.userId, workspaceId)
      if (!userMember) {
        return c.json(
          { error: { code: "forbidden", message: "You do not have access to this workspace" } },
          403
        )
      }

      const members = await memberService.getWorkspaceMembers(workspaceId)

      return c.json({ members }, 200)
    } catch (error: any) {
      console.error("[members] GET /workspace/:workspaceId error:", error)
      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to get members" } },
        500
      )
    }
  })

  /**
   * PATCH /members/:id/role - Update member role
   */
  router.patch("/:id/role", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const memberId = c.req.param("id")
      const body = await c.req.json<{ role: string }>()

      if (!body.role) {
        return c.json(
          { error: { code: "invalid_request", message: "role is required" } },
          400
        )
      }

      // Get the member to update
      const member = await memberService.getMember(memberId)
      if (!member) {
        return c.json({ error: { code: "not_found", message: "Member not found" } }, 404)
      }

      if (!member.workspaceId) {
        return c.json(
          { error: { code: "invalid_state", message: "Member is not a workspace member" } },
          400
        )
      }

      // Check user has permission (must be owner or admin)
      const userMember = await memberService.getMemberByUserAndWorkspace(auth.userId, member.workspaceId)
      if (!userMember || (userMember.role !== "owner" && userMember.role !== "admin")) {
        return c.json(
          { error: { code: "forbidden", message: "Only owners and admins can change member roles" } },
          403
        )
      }

      // Update the role
      const updated = await memberService.updateMemberRole(memberId, body.role as any)

      return c.json({ member: updated }, 200)
    } catch (error: any) {
      console.error("[members] PATCH /:id/role error:", error)
      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to update role" } },
        500
      )
    }
  })

  /**
   * DELETE /members/:id - Remove a member from workspace
   */
  router.delete("/:id", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const memberId = c.req.param("id")

      // Get the member to remove
      const member = await memberService.getMember(memberId)
      if (!member) {
        return c.json({ error: { code: "not_found", message: "Member not found" } }, 404)
      }

      if (!member.workspaceId) {
        return c.json(
          { error: { code: "invalid_state", message: "Member is not a workspace member" } },
          400
        )
      }

      // Check user has permission (must be owner or admin)
      const userMember = await memberService.getMemberByUserAndWorkspace(auth.userId, member.workspaceId)
      if (!userMember || (userMember.role !== "owner" && userMember.role !== "admin")) {
        return c.json(
          { error: { code: "forbidden", message: "Only owners and admins can remove members" } },
          403
        )
      }

      // Cannot remove yourself this way - use leave endpoint
      if (member.userId === auth.userId) {
        return c.json(
          { error: { code: "invalid_request", message: "Use the leave endpoint to remove yourself" } },
          400
        )
      }

      await memberService.removeMember(memberId)

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[members] DELETE /:id error:", error)
      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to remove member" } },
        500
      )
    }
  })

  return router
}

export default memberRoutes
