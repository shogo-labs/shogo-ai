/**
 * Invitation API Routes
 *
 * Authenticated endpoints for invitation operations.
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
 * Invitation route configuration
 */
export interface InvitationRoutesConfig {
  /** Studio core domain store for invitation operations */
  studioCore: {
    invitationCollection: {
      query: () => {
        where: (filter: Record<string, any>) => {
          first: () => Promise<any>
          toArray: () => Promise<any[]>
        }
      }
      insertOne: (data: any) => Promise<any>
      updateOne: (id: string, changes: any) => Promise<void>
    }
    memberCollection: {
      loadAll: () => Promise<void>
      findForResource: (type: "workspace" | "project", id: string) => any[]
    }
    workspaceCollection: {
      get: (id: string) => any
    }
    sendInvitationEmail: (invitationId: string) => Promise<{ success: boolean; error?: string }>
    resendInvitation: (invitationId: string) => Promise<{ success: boolean; error?: string }>
    acceptInvitation: (invitationId: string, userId: string) => Promise<void>
    declineInvitation: (invitationId: string) => Promise<void>
    createNotification: (params: any) => Promise<any>
    resolvePermissions: (userId: string, resourceType: "workspace" | "project", resourceId: string) => string | null
  }
}

/**
 * Create invitation routes
 *
 * @param config - Route configuration
 * @returns Hono router with invitation endpoints
 */
export function invitationRoutes(config: InvitationRoutesConfig) {
  const { studioCore } = config
  const router = new Hono()

  /**
   * POST /invitations - Create invitation and send email
   *
   * Request body:
   * - email: string (recipient email)
   * - workspaceId: string (workspace to invite to)
   * - role: 'owner' | 'admin' | 'member' | 'viewer'
   *
   * Response:
   * - invitation: Invitation object
   * - emailStatus: 'sent' | 'failed' | 'not_sent'
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
        role: "owner" | "admin" | "member" | "viewer"
      }>()
      const { email, workspaceId, role } = body

      if (!email || !workspaceId || !role) {
        return c.json(
          { error: { code: "invalid_request", message: "email, workspaceId, and role required" } },
          400
        )
      }

      // Check user has permission to invite (admin or owner)
      await studioCore.memberCollection.query().where({ userId: auth.userId }).toArray()
      const userRole = studioCore.resolvePermissions(auth.userId, "workspace", workspaceId)
      if (!userRole || (userRole !== "owner" && userRole !== "admin")) {
        return c.json(
          { error: { code: "forbidden", message: "Only owners and admins can invite members" } },
          403
        )
      }

      // Create the invitation
      const now = Date.now()
      const invitation = await studioCore.invitationCollection.insertOne({
        id: crypto.randomUUID(),
        email,
        role,
        workspaceId,
        status: "pending",
        emailStatus: "not_sent",
        invitedBy: auth.userId,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
        createdAt: now,
      })

      // Send invitation email (gracefully handles missing SMTP config)
      const emailResult = await studioCore.sendInvitationEmail(invitation.id)

      return c.json(
        {
          invitation: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            status: invitation.status,
            emailStatus: emailResult.success ? "sent" : "not_sent",
          },
          emailSent: emailResult.success,
          emailError: emailResult.error,
        },
        201
      )
    } catch (error: any) {
      console.error("[invitations] POST / error:", error)
      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to create invitation" } },
        500
      )
    }
  })

  /**
   * POST /invitations/:id/accept - Accept an invitation
   *
   * Response:
   * - success: true
   * - member: Created member object
   */
  router.post("/:id/accept", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const invitationId = c.req.param("id")

      // Get the invitation
      const invitation = await studioCore.invitationCollection
        .query()
        .where({ id: invitationId })
        .first()

      if (!invitation) {
        return c.json({ error: { code: "not_found", message: "Invitation not found" } }, 404)
      }

      // Verify invitation is for the authenticated user's email
      if (auth.email && invitation.email.toLowerCase() !== auth.email.toLowerCase()) {
        return c.json(
          { error: { code: "forbidden", message: "This invitation is for a different email address" } },
          403
        )
      }

      // Check invitation status
      if (invitation.status !== "pending") {
        return c.json(
          { error: { code: "invalid_state", message: `Invitation is ${invitation.status}` } },
          400
        )
      }

      // Check if expired
      if (Date.now() > invitation.expiresAt) {
        return c.json({ error: { code: "expired", message: "Invitation has expired" } }, 400)
      }

      // Accept the invitation (creates Member)
      await studioCore.acceptInvitation(invitationId, auth.userId)

      // Create notification for the inviter
      if (invitation.invitedBy) {
        const workspace = studioCore.workspaceCollection.get(invitation.workspaceId)
        await studioCore.createNotification({
          userId: invitation.invitedBy,
          type: "invitation_accepted",
          title: "Invitation accepted",
          message: `${auth.email || "A user"} has joined ${workspace?.name || "the workspace"} as ${invitation.role}`,
          metadata: {
            invitationId,
            workspaceId: invitation.workspaceId,
            acceptedBy: auth.userId,
          },
        })
      }

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[invitations] POST /:id/accept error:", error)
      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to accept invitation" } },
        500
      )
    }
  })

  /**
   * POST /invitations/:id/decline - Decline an invitation
   *
   * Response:
   * - success: true
   */
  router.post("/:id/decline", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const invitationId = c.req.param("id")

      // Get the invitation
      const invitation = await studioCore.invitationCollection
        .query()
        .where({ id: invitationId })
        .first()

      if (!invitation) {
        return c.json({ error: { code: "not_found", message: "Invitation not found" } }, 404)
      }

      // Check invitation status
      if (invitation.status !== "pending") {
        return c.json(
          { error: { code: "invalid_state", message: `Invitation is ${invitation.status}` } },
          400
        )
      }

      // Decline the invitation
      await studioCore.declineInvitation(invitationId)

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[invitations] POST /:id/decline error:", error)
      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to decline invitation" } },
        500
      )
    }
  })

  /**
   * POST /invitations/:id/resend - Resend invitation email
   *
   * Response:
   * - success: true
   * - emailStatus: 'sent' | 'failed'
   */
  router.post("/:id/resend", async (c) => {
    try {
      const auth = c.get("auth" as never) as AuthContext | undefined
      if (!auth?.userId) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401)
      }

      const invitationId = c.req.param("id")

      // Get the invitation
      const invitation = await studioCore.invitationCollection
        .query()
        .where({ id: invitationId })
        .first()

      if (!invitation) {
        return c.json({ error: { code: "not_found", message: "Invitation not found" } }, 404)
      }

      // Check user has permission (admin/owner of workspace)
      await studioCore.memberCollection.query().where({ userId: auth.userId }).toArray()
      const userRole = studioCore.resolvePermissions(auth.userId, "workspace", invitation.workspaceId)
      if (!userRole || (userRole !== "owner" && userRole !== "admin")) {
        return c.json(
          { error: { code: "forbidden", message: "Only owners and admins can resend invitations" } },
          403
        )
      }

      // Check invitation is still pending
      if (invitation.status !== "pending") {
        return c.json(
          { error: { code: "invalid_state", message: "Can only resend pending invitations" } },
          400
        )
      }

      // Resend the invitation email
      const result = await studioCore.resendInvitation(invitationId)

      return c.json(
        {
          success: result.success,
          emailStatus: result.success ? "sent" : "failed",
          error: result.error,
        },
        result.success ? 200 : 500
      )
    } catch (error: any) {
      console.error("[invitations] POST /:id/resend error:", error)
      return c.json(
        { error: { code: "internal_error", message: error.message || "Failed to resend invitation" } },
        500
      )
    }
  })

  return router
}
