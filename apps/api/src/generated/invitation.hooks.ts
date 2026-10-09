// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invitation Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import { sendInvitationEmail, sendProjectInviteEmail, sendInviteAcceptedEmail } from "../services/email.service"
import { getFrontendUrl } from "../lib/cloud-urls"
import { canAssignProjectRole, canAssignWorkspaceRole, isWorkspaceRole, toProjectRole } from "@shogo/authz"
import type { Principal } from "../lib/authz"
import { hookAccess, hookCan, hookRequire } from "../lib/authz/hooks"

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
  tunnelAuthenticated?: boolean
  auth?: Principal
  prisma: any
}

/**
 * Hooks for Invitation routes
 */
export interface InvitationHooks {
  /** Called before listing records. Can modify where/include. */
  beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any; orderBy?: any }> | void>
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
 * Whether the caller may invite (or manage invitations) at this scope, and,
 * when `role` is given, grant that role without escalating past their own.
 */
async function canManageInvite(
  ctx: HookContext,
  opts: { workspaceId?: string | null; projectId?: string | null },
  role?: string,
): Promise<boolean> {
  if (opts.projectId) {
    const access = await hookAccess(ctx, { projectId: opts.projectId })
    if (role === undefined) return access.permissions.has('project.members:manage')
    const projectRole = toProjectRole(role)
    return !!projectRole && canAssignProjectRole(access, projectRole)
  }
  if (opts.workspaceId) {
    const access = await hookAccess(ctx, { workspaceId: opts.workspaceId })
    if (role === undefined) return access.permissions.has('workspace.members:manage')
    return isWorkspaceRole(role) && canAssignWorkspaceRole(access, role)
  }
  return false
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
      const denied = await hookRequire(ctx, "project:read", { projectId })
      if (denied) return denied
      return { ok: true, data: { where: { projectId }, include: { workspace: true } } }
    }

    if (workspaceId) {
      const denied = await hookRequire(ctx, "workspace.members:read", { workspaceId })
      if (denied) return denied
      return { ok: true, data: { where: { workspaceId }, include: { workspace: true } } }
    }

    // No filter: return invitations from all accessible workspaces
    return {
      ok: true,
      data: {
        where: {
          workspace: { members: { some: { userId, projectId: null } } },
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
      select: { email: true, workspaceId: true, projectId: true },
    })
    if (!invitation) {
      return { ok: false, error: { code: "not_found", message: "Invitation not found" } }
    }

    const userEmail = await getUserEmail(ctx.prisma, userId)
    if (userEmail && userEmail === invitation.email.toLowerCase()) return { ok: true }

    if (invitation.projectId && (await hookCan(ctx, "project:read", { projectId: invitation.projectId }))) {
      return { ok: true }
    }
    if (invitation.workspaceId && (await hookCan(ctx, "workspace.members:read", { workspaceId: invitation.workspaceId }))) {
      return { ok: true }
    }
    return { ok: false, error: { code: "forbidden", message: "Access denied" } }
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

    // For project invitations, the workspace always comes from the project.
    if (projectId) {
      const project = await ctx.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
      if (!project) {
        return { ok: false, error: { code: "not_found", message: "Project not found" } }
      }
      input.workspaceId = project.workspaceId
      if (input.role === 'owner') input.role = 'admin'
    }
    if (!input.role) input.role = 'member'

    if (!(await canManageInvite(ctx, { workspaceId: input.workspaceId, projectId }, input.role))) {
      return { ok: false, error: { code: "forbidden", message: "You cannot invite with this role" } }
    }

    if (!input.expiresAt) {
      input.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    } else if (typeof input.expiresAt === 'number') {
      input.expiresAt = new Date(input.expiresAt)
    }

    if (!input.status) input.status = "pending"
    if (!input.invitedBy && userId) input.invitedBy = userId

    if (input.email) input.email = input.email.toLowerCase()

    // Duplicate check. Only an active (non-expired) pending invite blocks a
    // re-invite; a pending row whose expiresAt is in the past is treated as
    // expired (consistent with the UI and project-auth allowlist).
    const now = new Date()
    const scopeWhere: any = { email: input.email }
    if (projectId) {
      scopeWhere.projectId = projectId
    } else {
      scopeWhere.workspaceId = input.workspaceId
    }

    const existing = await ctx.prisma.invitation.findFirst({
      where: { ...scopeWhere, status: "pending", expiresAt: { gt: now } },
    })
    if (existing) {
      return { ok: false, error: { code: "invitation_exists", message: "An invitation for this email is already pending" } }
    }

    // Clean up stale pending-but-expired rows for this email + scope so we
    // don't accumulate duplicate invitations (no DB unique constraint exists).
    await ctx.prisma.invitation.deleteMany({
      where: { ...scopeWhere, status: "pending", expiresAt: { lte: now } },
    })

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

    const baseUrl = getFrontendUrl()
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

      const baseUrl = getFrontendUrl()
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
    })
    if (!invitation) {
      return { ok: false, error: { code: "not_found", message: "Invitation not found" } }
    }

    // Invitees can accept or decline
    const userEmail = await getUserEmail(ctx.prisma, userId)
    if (userEmail && userEmail === invitation.email.toLowerCase()) {
      if (input.status === 'declined') {
        if (invitation.status === 'accepted') {
          return { ok: false, error: { code: "bad_request", message: "Accepted invitations cannot be declined" } }
        }
        if (['pending', 'expired', 'declined'].includes(invitation.status)) {
          return { ok: true, data: { status: 'declined' } }
        }
        return { ok: false, error: { code: "bad_request", message: "Invitation can no longer be modified" } }
      }

      if (input.status === 'accepted') {
        if (invitation.status !== 'pending') {
          return { ok: false, error: { code: "bad_request", message: "Invitation can no longer be accepted" } }
        }
        if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
          return { ok: false, error: { code: "expired", message: "Invitation has expired" } }
        }
        return { ok: true, data: { status: 'accepted' } }
      }

      return { ok: false, error: { code: "bad_request", message: "Unsupported invitation update" } }
    }

    // Admin operations: never let a role change escalate past the caller.
    const scope = { workspaceId: invitation.workspaceId, projectId: invitation.projectId }
    if (!(await canManageInvite(ctx, scope, invitation.role))) {
      return { ok: false, error: { code: "forbidden", message: "Access denied" } }
    }
    if (input.role !== undefined && !(await canManageInvite(ctx, scope, input.role))) {
      return { ok: false, error: { code: "forbidden", message: "You cannot grant this role" } }
    }

    const data: Record<string, unknown> = {}
    for (const key of ['role', 'status', 'expiresAt'] as const) {
      if (input[key] !== undefined) data[key] = input[key]
    }
    if (data.status !== undefined && data.status !== 'cancelled' && data.status !== 'pending') {
      return { ok: false, error: { code: "bad_request", message: "Admins can only cancel or reopen invitations" } }
    }
    return { ok: true, data }
  },

  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const invitation = await ctx.prisma.invitation.findUnique({
      where: { id },
    })
    if (!invitation) {
      return { ok: false, error: { code: "not_found", message: "Invitation not found" } }
    }

    if (!(await canManageInvite(ctx, { workspaceId: invitation.workspaceId, projectId: invitation.projectId }))) {
      return { ok: false, error: { code: "forbidden", message: "Only admins and owners can delete invitations" } }
    }

    return { ok: true }
  },
}
