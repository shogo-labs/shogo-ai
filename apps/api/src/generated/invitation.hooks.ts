// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invitation Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import { sendInvitationEmail, sendProjectInviteEmail, sendInviteAcceptedEmail } from "../services/email.service"

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

async function getUserEmail(prisma: any, userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  })
  return user?.email?.toLowerCase() ?? null
}

/**
 * Check if user has admin/owner access to a workspace or project.
 * Returns the membership if found, null otherwise.
 */
async function getAdminAccess(prisma: any, userId: string, opts: { workspaceId?: string; projectId?: string }) {
  if (opts.projectId) {
    // For project invitations, check project-level membership first, then workspace-level
    const projectMember = await prisma.member.findFirst({
      where: { userId, projectId: opts.projectId },
    })
    if (projectMember && (projectMember.role === 'owner' || projectMember.role === 'admin')) {
      return projectMember
    }
    // Fall back to workspace membership via project
    const project = await prisma.project.findUnique({
      where: { id: opts.projectId },
      select: { workspaceId: true },
    })
    if (project) {
      const wsMember = await prisma.member.findFirst({
        where: { userId, workspaceId: project.workspaceId },
      })
      if (wsMember && (wsMember.role === 'owner' || wsMember.role === 'admin')) {
        return wsMember
      }
    }
    return null
  }
  if (opts.workspaceId) {
    const member = await prisma.member.findFirst({
      where: { userId, workspaceId: opts.workspaceId },
    })
    if (member && (member.role === 'owner' || member.role === 'admin')) {
      return member
    }
    return null
  }
  return null
}

export const invitationHooks: InvitationHooks = {
  /**
   * Filter invitations based on context:
   * - ?email=X        → invitees see their own invitations
   * - ?workspaceId=X  → workspace members see workspace invitations
   * - ?projectId=X    → project/workspace members see project invitations
   * - (neither)       → invitations from all accessible workspaces
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const emailFilter = ctx.query.email
    const workspaceId = ctx.query.workspaceId
    const projectId = ctx.query.projectId

    if (emailFilter) {
      const userEmail = await getUserEmail(ctx.prisma, userId)
      if (userEmail && userEmail === emailFilter.toLowerCase()) {
        return {
          ok: true,
          data: {
            where: { email: userEmail },
            include: { workspace: true },
          },
        }
      }
      return { ok: false, error: { code: "forbidden", message: "Cannot view invitations for other users" } }
    }

    if (projectId) {
      // Verify user has access to this project (project member or workspace member)
      const projectMember = await ctx.prisma.member.findFirst({ where: { userId, projectId } })
      if (!projectMember) {
        const project = await ctx.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
        if (project) {
          const wsMember = await ctx.prisma.member.findFirst({ where: { userId, workspaceId: project.workspaceId } })
          if (!wsMember) {
            return { ok: false, error: { code: "forbidden", message: "Access denied to this project" } }
          }
        } else {
          return { ok: false, error: { code: "not_found", message: "Project not found" } }
        }
      }
      return { ok: true, data: { where: { projectId }, include: { workspace: true } } }
    }

    if (workspaceId) {
      const membership = await ctx.prisma.member.findFirst({ where: { userId, workspaceId } })
      if (!membership) {
        return { ok: false, error: { code: "forbidden", message: "Access denied to this workspace" } }
      }
      return { ok: true, data: { where: { workspaceId }, include: { workspace: true } } }
    }

    // No filter: return invitations from all accessible workspaces
    return {
      ok: true,
      data: {
        where: {
          workspace: { members: { some: { userId } } },
        },
        include: { workspace: true },
      },
    }
  },

  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const invitation = await ctx.prisma.invitation.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })
    if (!invitation) {
      return { ok: false, error: { code: "not_found", message: "Invitation not found" } }
    }

    const userEmail = await getUserEmail(ctx.prisma, userId)
    if (userEmail && userEmail === invitation.email.toLowerCase()) return { ok: true }

    // Check project-level access
    if (invitation.projectId) {
      const projectMember = await ctx.prisma.member.findFirst({ where: { userId, projectId: invitation.projectId } })
      if (projectMember) return { ok: true }
    }

    const hasAccess = invitation.workspace?.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return { ok: false, error: { code: "forbidden", message: "Access denied" } }
    }
    return { ok: true }
  },

  /**
   * Create invitation for workspace or project.
   * Requires workspaceId OR projectId (or both).
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const workspaceId = input.workspaceId
    const projectId = input.projectId

    if (!workspaceId && !projectId) {
      return { ok: false, error: { code: "bad_request", message: "workspaceId or projectId is required" } }
    }

    // For project invitations, resolve workspace from project
    if (projectId && !workspaceId) {
      const project = await ctx.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
      if (!project) {
        return { ok: false, error: { code: "not_found", message: "Project not found" } }
      }
      input.workspaceId = project.workspaceId
    }

    const adminAccess = await getAdminAccess(ctx.prisma, userId, { workspaceId: input.workspaceId, projectId })
    if (!adminAccess) {
      return { ok: false, error: { code: "forbidden", message: "Only admins and owners can send invitations" } }
    }

    if (!input.expiresAt) {
      input.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    } else if (typeof input.expiresAt === 'number') {
      input.expiresAt = new Date(input.expiresAt)
    }

    if (!input.status) input.status = "pending"
    if (!input.invitedBy && userId) input.invitedBy = userId

    // Duplicate check
    const existingWhere: any = {
      email: input.email?.toLowerCase(),
      status: "pending",
    }
    if (projectId) {
      existingWhere.projectId = projectId
    } else {
      existingWhere.workspaceId = input.workspaceId
    }
    const existing = await ctx.prisma.invitation.findFirst({ where: existingWhere })
    if (existing) {
      return { ok: false, error: { code: "invitation_exists", message: "An invitation for this email is already pending" } }
    }

    if (input.email) input.email = input.email.toLowerCase()

    return { ok: true, data: input }
  },

  afterCreate: async (invitation, ctx) => {
    const [workspace, project, inviter] = await Promise.all([
      invitation.workspaceId
        ? ctx.prisma.workspace.findUnique({ where: { id: invitation.workspaceId }, select: { name: true } })
        : null,
      invitation.projectId
        ? ctx.prisma.project.findUnique({ where: { id: invitation.projectId }, select: { name: true } })
        : null,
      invitation.invitedBy
        ? ctx.prisma.user.findUnique({ where: { id: invitation.invitedBy }, select: { name: true, email: true } })
        : null,
    ])

    const resourceName = project?.name || workspace?.name
    if (!resourceName) return

    const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
    const acceptUrl = `${baseUrl}/invitations/${invitation.id}/accept`

    const inviterName = inviter?.name || inviter?.email || 'A team member'

    const emailResult = invitation.projectId && project?.name
      ? await sendProjectInviteEmail({
          to: invitation.email,
          inviterName,
          projectName: project.name,
          workspaceName: workspace?.name,
          role: invitation.role,
          acceptUrl,
        })
      : await sendInvitationEmail({
          to: invitation.email,
          inviterName,
          workspaceName: workspace?.name || resourceName,
          role: invitation.role,
          acceptUrl,
        })

    await ctx.prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        emailStatus: emailResult.success ? 'sent' : 'failed',
        emailSentAt: emailResult.success ? new Date() : null,
        emailError: emailResult.error || null,
      },
    })
  },

  afterUpdate: async (record, ctx) => {
    if (record.status !== 'accepted' || !record.invitedBy) return

    try {
      const [inviter, invitee, workspace, project] = await Promise.all([
        ctx.prisma.user.findUnique({ where: { id: record.invitedBy }, select: { email: true } }),
        ctx.prisma.user.findFirst({ where: { email: record.email.toLowerCase() }, select: { name: true } }),
        record.workspaceId ? ctx.prisma.workspace.findUnique({ where: { id: record.workspaceId }, select: { name: true } }) : null,
        record.projectId ? ctx.prisma.project.findUnique({ where: { id: record.projectId }, select: { name: true } }) : null,
      ])
      if (!inviter?.email) return

      const resourceName = project?.name || workspace?.name
      if (!resourceName) return

      const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
      sendInviteAcceptedEmail({
        to: inviter.email,
        inviteeName: invitee?.name || record.email,
        inviteeEmail: record.email,
        resourceName,
        resourceType: project ? 'project' : 'workspace',
        dashboardUrl: `${baseUrl}/settings?tab=people`,
      }).catch((err) => console.error('[Email] invite-accepted failed:', err))
    } catch (err) {
      console.error('[Email] afterUpdate hook error:', err)
    }
  },

  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const invitation = await ctx.prisma.invitation.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })
    if (!invitation) {
      return { ok: false, error: { code: "not_found", message: "Invitation not found" } }
    }

    // Invitees can accept or decline
    const userEmail = await getUserEmail(ctx.prisma, userId)
    if (userEmail && userEmail === invitation.email.toLowerCase()) {
      const actionableStatuses = ['pending', 'accepted']
      if (!actionableStatuses.includes(invitation.status)) {
        return { ok: false, error: { code: "bad_request", message: "Invitation can no longer be modified" } }
      }
      if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
        return { ok: false, error: { code: "expired", message: "Invitation has expired" } }
      }
      const allowedStatuses = ['accepted', 'declined']
      if (input.status && allowedStatuses.includes(input.status)) {
        return { ok: true, data: { status: input.status } }
      }
    }

    // Admin/owner operations
    const adminAccess = await getAdminAccess(ctx.prisma, userId, {
      workspaceId: invitation.workspaceId,
      projectId: invitation.projectId,
    })
    if (!adminAccess) {
      return { ok: false, error: { code: "forbidden", message: "Access denied" } }
    }

    return { ok: true }
  },

  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const invitation = await ctx.prisma.invitation.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })
    if (!invitation) {
      return { ok: false, error: { code: "not_found", message: "Invitation not found" } }
    }

    const adminAccess = await getAdminAccess(ctx.prisma, userId, {
      workspaceId: invitation.workspaceId,
      projectId: invitation.projectId,
    })
    if (!adminAccess) {
      return { ok: false, error: { code: "forbidden", message: "Only admins and owners can delete invitations" } }
    }

    return { ok: true }
  },
}
