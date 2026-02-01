/**
 * Invitation Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import { sendInvitationEmail } from "../services/email.service"

/**
 * Result from a hook that can modify or reject the operation
 */
export interface HookResult<T = any> {
  ok: boolean
  error?: { code: string; message: string }
  data?: T
}

/**
 * Hook context with Prisma client
 */
export interface HookContext {
  body: any
  params: Record<string, string>
  query: Record<string, string>
  userId?: string
  prisma: any
}

/**
 * Hooks for Invitation routes
 */
export interface InvitationHooks {
  /** Called before listing records. Can modify where/include. */
  beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any }> | void>
  /** Called before getting a single record. Can reject access. */
  beforeGet?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  /** Called before creating a record. Can modify input or reject. */
  beforeCreate?: (input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  /** Called after creating a record. Can perform side effects. */
  afterCreate?: (record: any, ctx: HookContext) => Promise<void>
  /** Called before updating a record. Can modify input or reject. */
  beforeUpdate?: (id: string, input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  /** Called after updating a record. Can perform side effects. */
  afterUpdate?: (record: any, ctx: HookContext) => Promise<void>
  /** Called before deleting a record. Can reject deletion. */
  beforeDelete?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  /** Called after deleting a record. Can perform cleanup. */
  afterDelete?: (id: string, ctx: HookContext) => Promise<void>
}

/**
 * Default Invitation hooks (customize as needed)
 */
export const invitationHooks: InvitationHooks = {
  /**
   * Filter invitations to only workspaces the user has access to
   * Include workspace info in list responses
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const workspaceId = ctx.query.workspaceId
    if (!workspaceId) {
      // Return invitations from all accessible workspaces
      return {
        ok: true,
        data: {
          where: {
            workspace: {
              members: {
                some: { userId },
              },
            },
          },
          include: {
            workspace: true,
          },
        },
      }
    }

    // Verify user has access to this workspace
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (!membership) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    return {
      ok: true,
      data: {
        where: { workspaceId },
        include: {
          workspace: true,
        },
      },
    }
  },

  /**
   * Verify user has access to view the invitation
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const invitation = await ctx.prisma.invitation.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!invitation) {
      return {
        ok: false,
        error: { code: "not_found", message: "Invitation not found" },
      }
    }

    const hasAccess = invitation.workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Set default expiration and status for new invitations, verify workspace access
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const workspaceId = input.workspaceId
    if (!workspaceId) {
      return {
        ok: false,
        error: { code: "bad_request", message: "workspaceId is required" },
      }
    }

    // Verify user has admin access to this workspace
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (!membership) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can send invitations" },
      }
    }

    // Set default expiration (7 days)
    if (!input.expiresAt) {
      input.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }

    // Set default status
    if (!input.status) {
      input.status = "pending"
    }

    // Set invitedBy if not provided
    if (!input.invitedBy && userId) {
      input.invitedBy = userId
    }

    // Check for existing pending invitation
    const existing = await ctx.prisma.invitation.findFirst({
      where: {
        email: input.email?.toLowerCase(),
        workspaceId: input.workspaceId,
        status: "pending",
      },
    })

    if (existing) {
      return {
        ok: false,
        error: {
          code: "invitation_exists",
          message: "An invitation for this email is already pending",
        },
      }
    }

    // Normalize email
    if (input.email) {
      input.email = input.email.toLowerCase()
    }

    return { ok: true, data: input }
  },

  /**
   * Send invitation email after creating
   */
  afterCreate: async (invitation, ctx) => {
    // Get workspace and inviter details
    const [workspace, inviter] = await Promise.all([
      ctx.prisma.workspace.findUnique({
        where: { id: invitation.workspaceId },
        select: { name: true },
      }),
      invitation.invitedBy
        ? ctx.prisma.user.findUnique({
            where: { id: invitation.invitedBy },
            select: { name: true, email: true },
          })
        : null,
    ])

    if (!workspace) {
      console.warn(`[Invitation] Workspace ${invitation.workspaceId} not found, skipping email`)
      return
    }

    // Build accept URL
    const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
    const acceptUrl = `${baseUrl}/invitations/${invitation.id}/accept`

    // Send the email (non-blocking - don't fail the invitation if email fails)
    const emailResult = await sendInvitationEmail({
      to: invitation.email,
      inviterName: inviter?.name || inviter?.email || 'A team member',
      workspaceName: workspace.name,
      role: invitation.role,
      acceptUrl,
    })

    // Update invitation with email status
    await ctx.prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        emailStatus: emailResult.success ? 'sent' : 'failed',
        emailSentAt: emailResult.success ? new Date() : null,
        emailError: emailResult.error || null,
      },
    })
  },

  /**
   * Verify user has access to update the invitation (admin/owner only)
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const invitation = await ctx.prisma.invitation.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!invitation) {
      return {
        ok: false,
        error: { code: "not_found", message: "Invitation not found" },
      }
    }

    const member = invitation.workspace.members.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can update invitations" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the invitation (admin/owner only)
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const invitation = await ctx.prisma.invitation.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!invitation) {
      return {
        ok: false,
        error: { code: "not_found", message: "Invitation not found" },
      }
    }

    const member = invitation.workspace.members.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can delete invitations" },
      }
    }

    return { ok: true }
  },
}
