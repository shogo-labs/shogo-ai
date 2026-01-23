/**
 * Invitation API Routes
 *
 * Authenticated endpoints for invitation operations.
 * Uses Prisma-based member service.
 */

import { Hono } from "hono"
import * as memberService from "../services/member.service"
import { prisma, MemberRole } from "../lib/prisma"

/**
 * Auth context expected from authentication middleware
 */
interface AuthContext {
  userId: string
  email?: string
}

/**
 * Create invitation routes
 */
export function invitationRoutes() {
  const router = new Hono()

  /**
   * POST /invitations - Create invitation
   *
   * Request body:
   * - email: string (recipient email)
   * - workspaceId: string (workspace to invite to)
   * - role: 'owner' | 'admin' | 'member' | 'viewer'
   */
  router.post("/", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const body = await c.req.json<{
        email: string
        workspaceId: string
        role: MemberRole
      }>()
      const { email, workspaceId, role } = body

      if (!email || !workspaceId || !role) {
        return c.json(
          { error: { code: "invalid_request", message: "email, workspaceId, and role required" } },
          400
        )
      }

      // Check user has permission to invite (admin or owner)
      const userMember = await memberService.getMemberByUserAndWorkspace(auth.userId, workspaceId)
      if (!userMember || (userMember.role !== "owner" && userMember.role !== "admin")) {
        return c.json(
          { error: { code: "forbidden", message: "Only owners and admins can invite members" } },
          403
        )
      }

      // Check if user is already a member
      const existingUser = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      })
      if (existingUser) {
        const existingMember = await memberService.getMemberByUserAndWorkspace(existingUser.id, workspaceId)
        if (existingMember) {
          return c.json(
            { error: { code: "already_member", message: "User is already a member of this workspace" } },
            400
          )
        }
      }

      // Check for existing pending invitation
      const existingInvitations = await memberService.getInvitationsForEmail(email)
      const existingInvitation = existingInvitations.find(
        (inv) => inv.workspaceId === workspaceId && inv.status === "pending"
      )
      if (existingInvitation) {
        return c.json(
          { error: { code: "invitation_exists", message: "An invitation for this email is already pending" } },
          400
        )
      }

      // Create the invitation
      const invitation = await memberService.createInvitation({
        email,
        workspaceId,
        role,
        invitedBy: auth.userId,
      })

      return c.json({ invitation }, 201)
    } catch (error) {
      console.error("[Invitations API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  /**
   * GET /invitations - Get invitations for current user's email
   */
  router.get("/", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      // Get user's email
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { email: true },
      })

      if (!user?.email) {
        return c.json({ invitations: [] }, 200)
      }

      const invitations = await memberService.getInvitationsForEmail(user.email)

      return c.json({ invitations }, 200)
    } catch (error) {
      console.error("[Invitations API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  /**
   * GET /invitations/workspace/:workspaceId - Get pending invitations for a workspace
   */
  router.get("/workspace/:workspaceId", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const workspaceId = c.req.param("workspaceId")

      // Check user has permission to view invitations
      const userMember = await memberService.getMemberByUserAndWorkspace(auth.userId, workspaceId)
      if (!userMember || (userMember.role !== "owner" && userMember.role !== "admin")) {
        return c.json(
          { error: { code: "forbidden", message: "Only owners and admins can view invitations" } },
          403
        )
      }

      const invitations = await memberService.getWorkspaceInvitations(workspaceId)

      return c.json({ invitations }, 200)
    } catch (error) {
      console.error("[Invitations API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  /**
   * POST /invitations/:invitationId/accept - Accept an invitation
   */
  router.post("/:invitationId/accept", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const invitationId = c.req.param("invitationId")

      // Get user's email to verify invitation is for them
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { email: true },
      })

      // Get the invitation
      const invitation = await prisma.invitation.findUnique({
        where: { id: invitationId },
      })

      if (!invitation) {
        return c.json({ error: { code: "not_found", message: "Invitation not found" } }, 404)
      }

      // Verify invitation is for this user's email
      if (invitation.email.toLowerCase() !== user?.email?.toLowerCase()) {
        return c.json(
          { error: { code: "forbidden", message: "This invitation is not for your email address" } },
          403
        )
      }

      const result = await memberService.acceptInvitation(invitationId, auth.userId)

      return c.json({ success: true, member: result.member }, 200)
    } catch (error) {
      console.error("[Invitations API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  /**
   * POST /invitations/:invitationId/decline - Decline an invitation
   */
  router.post("/:invitationId/decline", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const invitationId = c.req.param("invitationId")

      await memberService.declineInvitation(invitationId)

      return c.json({ success: true }, 200)
    } catch (error) {
      console.error("[Invitations API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  /**
   * DELETE /invitations/:invitationId - Cancel an invitation (admin only)
   */
  router.delete("/:invitationId", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const invitationId = c.req.param("invitationId")

      // Get the invitation to check permissions
      const invitation = await prisma.invitation.findUnique({
        where: { id: invitationId },
      })

      if (!invitation) {
        return c.json({ error: { code: "not_found", message: "Invitation not found" } }, 404)
      }

      // Check user has permission to cancel (admin or owner of workspace)
      if (invitation.workspaceId) {
        const userMember = await memberService.getMemberByUserAndWorkspace(auth.userId, invitation.workspaceId)
        if (!userMember || (userMember.role !== "owner" && userMember.role !== "admin")) {
          return c.json(
            { error: { code: "forbidden", message: "Only owners and admins can cancel invitations" } },
            403
          )
        }
      }

      await memberService.cancelInvitation(invitationId)

      return c.json({ success: true }, 200)
    } catch (error) {
      console.error("[Invitations API] Error:", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: { code: "internal_error", message } }, 500)
    }
  })

  return router
}

export default invitationRoutes
