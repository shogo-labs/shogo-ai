// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Member Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

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
 * Hooks for Member routes
 */
export interface MemberHooks {
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
  /** Replaces the default delete when set. */
  performDelete?: (id: string, ctx: HookContext) => Promise<void>
  /** Called after deleting a record. Can perform cleanup. */
  afterDelete?: (id: string, ctx: HookContext) => Promise<void>
}

import {
  canAssignProjectRole,
  canAssignWorkspaceRole,
  canManageProjectMember,
  canManageWorkspaceMember,
  isWorkspaceRole,
  toProjectRole,
} from "@shogo/authz"
import type { Principal } from "../lib/authz"
import { hookAccess, hookRequire } from "../lib/authz/hooks"
import { sendMemberJoinedEmail, sendMemberRemovedEmail } from "../services/email.service"
import { syncSeatsFromMembership } from "../services/billing.service"
import { removeMembership } from "../services/membership.service"

const userInclude = {
  user: {
    select: { id: true, name: true, email: true, image: true },
  },
}

const unauthorized = { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
const forbidden = (message: string) => ({ ok: false, error: { code: "forbidden", message } })

async function otherWorkspaceOwners(ctx: HookContext, workspaceId: string, excludeId: string): Promise<number> {
  return ctx.prisma.member.count({
    where: { workspaceId, role: "owner", projectId: null, id: { not: excludeId } },
  })
}

export const memberHooks: MemberHooks = {
  /**
   * Filter members:
   * - ?workspaceId=X  → workspace members (and the workspace's project guests)
   * - ?projectId=X    → project-level members
   * - (neither)       → members from all workspaces the caller belongs to
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) return unauthorized

    const workspaceId = ctx.query.workspaceId
    const projectId = ctx.query.projectId

    if (projectId) {
      const denied = await hookRequire(ctx, "project:read", { projectId })
      if (denied) return denied
      return { ok: true, data: { where: { projectId }, include: userInclude } }
    }

    if (workspaceId) {
      const denied = await hookRequire(ctx, "workspace.members:read", { workspaceId })
      if (denied) return denied
      return { ok: true, data: { where: { workspaceId }, include: userInclude } }
    }

    return {
      ok: true,
      data: {
        where: { workspace: { members: { some: { userId, projectId: null } } } },
        include: userInclude,
      },
    }
  },

  afterCreate: async (record, ctx) => {
    if (!record.workspaceId || record.projectId) return

    // Cursor-style active-seat billing: when an accepted member joins the
    // workspace, bump the Stripe seat quantity (and local Subscription /
    // UsageWallet allocation). Project-only memberships don't bill seats.
    syncSeatsFromMembership(record.workspaceId).catch((err) =>
      console.error('[Billing] afterCreate seat sync failed:', err),
    )
    void import('../services/workspace-events')
      .then((m) => m.onWorkspaceMemberJoined({
        workspaceId: record.workspaceId,
        userId: record.userId,
        memberId: record.id,
        role: record.role,
        source: 'invitation',
      }))
      .catch(() => {})

    try {
      const [user, workspace, owners] = await Promise.all([
        ctx.prisma.user.findUnique({ where: { id: record.userId }, select: { name: true, email: true } }),
        ctx.prisma.workspace.findUnique({ where: { id: record.workspaceId }, select: { name: true } }),
        ctx.prisma.member.findMany({
          where: { workspaceId: record.workspaceId, role: 'owner', projectId: null, userId: { not: record.userId } },
          include: { user: { select: { email: true } } },
        }),
      ])
      if (!user || !workspace) return

      const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
      for (const owner of owners) {
        if (!owner.user?.email) continue
        sendMemberJoinedEmail({
          to: owner.user.email,
          memberName: user.name || user.email,
          memberEmail: user.email,
          workspaceName: workspace.name,
          role: record.role || 'member',
          dashboardUrl: `${baseUrl}/settings?tab=people`,
        }).catch((err) => console.error('[Email] member-joined failed:', err))
      }
    } catch (err) {
      console.error('[Email] afterCreate hook error:', err)
    }
  },

  beforeGet: async (id, ctx) => {
    if (!ctx.userId) return unauthorized

    const member = await ctx.prisma.member.findUnique({
      where: { id },
      select: { userId: true, workspaceId: true, projectId: true },
    })
    if (!member) {
      return { ok: false, error: { code: "not_found", message: "Member not found" } }
    }
    if (member.userId === ctx.userId) return { ok: true }

    if (member.projectId) {
      const access = await hookAccess(ctx, { projectId: member.projectId })
      if (access.permissions.has("project:read")) return { ok: true }
    }
    if (member.workspaceId) {
      const denied = await hookRequire(ctx, "workspace.members:read", { workspaceId: member.workspaceId })
      if (!denied) return { ok: true }
    }
    return forbidden("Access denied")
  },

  /**
   * Add members to a workspace or project.
   * - Callers with members:manage may grant roles up to their own.
   * - Users may add themselves with the role from an accepted invitation.
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) return unauthorized

    const projectId: string | undefined = input.projectId || undefined
    let workspaceId: string | undefined = input.workspaceId || undefined

    if (!workspaceId && !projectId) {
      return { ok: false, error: { code: "bad_request", message: "workspaceId or projectId is required" } }
    }
    if (!input.userId) {
      return { ok: false, error: { code: "bad_request", message: "userId is required" } }
    }

    if (projectId) {
      const project = await ctx.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
      if (!project) {
        return { ok: false, error: { code: "not_found", message: "Project not found" } }
      }
      workspaceId = project.workspaceId
    }

    const existing = await ctx.prisma.member.findFirst({
      where: projectId ? { userId: input.userId, projectId } : { userId: input.userId, workspaceId, projectId: null },
      select: { id: true },
    })
    if (existing) {
      return { ok: false, error: { code: "already_member", message: "User is already a member" } }
    }

    const data = {
      userId: input.userId,
      workspaceId,
      projectId: projectId ?? null,
      role: input.role ?? "member",
      isBillingAdmin: !!input.isBillingAdmin,
    }

    // Self-join via accepted invitation: the invitation decides the role.
    if (input.userId === userId) {
      const user = await ctx.prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
      if (user) {
        const invitation = await ctx.prisma.invitation.findFirst({
          where: {
            email: user.email.toLowerCase(),
            status: 'accepted',
            ...(projectId ? { projectId } : { workspaceId, projectId: null }),
          },
          orderBy: { updatedAt: 'desc' },
          select: { role: true },
        })
        if (invitation) {
          const role = projectId ? toProjectRole(invitation.role) : invitation.role
          if (!role) return { ok: false, error: { code: "bad_request", message: "Invalid invitation role" } }
          return { ok: true, data: { ...data, role, isBillingAdmin: false } }
        }
      }
    }

    if (projectId) {
      const role = toProjectRole(data.role)
      if (!role) return { ok: false, error: { code: "bad_request", message: "Invalid project role" } }
      const access = await hookAccess(ctx, { projectId })
      if (!canAssignProjectRole(access, role)) {
        return forbidden("You cannot grant this project role")
      }
      return { ok: true, data: { ...data, role, isBillingAdmin: false } }
    }

    if (!isWorkspaceRole(data.role)) {
      return { ok: false, error: { code: "bad_request", message: "Invalid workspace role" } }
    }
    const access = await hookAccess(ctx, { workspaceId: workspaceId! })
    if (!canAssignWorkspaceRole(access, data.role)) {
      return forbidden("You cannot grant this workspace role")
    }
    if (data.isBillingAdmin && !access.permissions.has("workspace.billing:manage")) {
      return forbidden("Only billing managers can grant billing admin")
    }
    return { ok: true, data }
  },

  /** Only `role` and `isBillingAdmin` are mutable, within the no-escalation rule. */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) return unauthorized

    const target = await ctx.prisma.member.findUnique({
      where: { id },
      select: { id: true, userId: true, role: true, workspaceId: true, projectId: true, isBillingAdmin: true },
    })
    if (!target) {
      return { ok: false, error: { code: "not_found", message: "Member not found" } }
    }

    const data: Record<string, unknown> = {}

    if (target.projectId) {
      const access = await hookAccess(ctx, { projectId: target.projectId })
      if (!access.permissions.has("project.members:manage")) {
        return forbidden("Only project admins can update project members")
      }
      if (!canManageProjectMember(access, toProjectRole(target.role))) {
        return forbidden("You cannot change a member with a higher role")
      }
      if (input.role !== undefined) {
        const role = toProjectRole(input.role)
        if (!role) return { ok: false, error: { code: "bad_request", message: "Invalid project role" } }
        if (!canAssignProjectRole(access, role)) return forbidden("You cannot grant this project role")
        data.role = role
      }
      return { ok: true, data }
    }

    const access = await hookAccess(ctx, { workspaceId: target.workspaceId })
    if (!access.permissions.has("workspace.members:manage")) {
      return forbidden("Only owners and admins can update members")
    }
    if (!canManageWorkspaceMember(access, isWorkspaceRole(target.role) ? target.role : null)) {
      return forbidden(target.role === "owner" ? "Only owners can manage owner role" : "You cannot change a member with a higher role")
    }

    if (input.role !== undefined && input.role !== target.role) {
      if (!isWorkspaceRole(input.role)) {
        return { ok: false, error: { code: "bad_request", message: "Invalid workspace role" } }
      }
      if (!canAssignWorkspaceRole(access, input.role)) {
        return forbidden(input.role === "owner" ? "Only owners can manage owner role" : "You cannot grant a role above your own")
      }
      if (target.role === "owner" && (await otherWorkspaceOwners(ctx, target.workspaceId, target.id)) === 0) {
        return { ok: false, error: { code: "last_owner", message: "A workspace must keep at least one owner" } }
      }
      data.role = input.role
    }

    if (input.isBillingAdmin !== undefined && !!input.isBillingAdmin !== target.isBillingAdmin) {
      if (!access.permissions.has("workspace.billing:manage")) {
        return forbidden("Only billing managers can change billing admin")
      }
      data.isBillingAdmin = !!input.isBillingAdmin
    }

    return { ok: true, data }
  },

  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) return unauthorized

    const member = await ctx.prisma.member.findUnique({
      where: { id },
      include: { workspace: { select: { name: true } }, user: { select: { email: true, name: true } } },
    })
    if (!member) {
      return { ok: false, error: { code: "not_found", message: "Member not found" } }
    }

    // Stash for afterDelete email
    ;(ctx as any)._deletedMember = member

    const isWorkspaceRow = !member.projectId
    if (isWorkspaceRow && member.role === "owner" && member.workspaceId) {
      if ((await otherWorkspaceOwners(ctx, member.workspaceId, id)) === 0) {
        return { ok: false, error: { code: "last_owner", message: "Cannot remove the last owner" } }
      }
    }

    // Users can always leave.
    if (member.userId === userId) return { ok: true }

    if (member.projectId) {
      const access = await hookAccess(ctx, { projectId: member.projectId })
      if (!access.permissions.has("project.members:manage")) {
        return forbidden("Only project admins can remove project members")
      }
      if (!canManageProjectMember(access, toProjectRole(member.role))) {
        return forbidden("You cannot remove a member with a higher role")
      }
      return { ok: true }
    }

    const access = await hookAccess(ctx, { workspaceId: member.workspaceId })
    if (!access.permissions.has("workspace.members:manage")) {
      return forbidden("Only owners and admins can remove members")
    }
    if (!canManageWorkspaceMember(access, isWorkspaceRole(member.role) ? member.role : null)) {
      return forbidden(member.role === "owner" ? "Only owners can remove owners" : "You cannot remove a member with a higher role")
    }
    return { ok: true }
  },

  performDelete: async (id, ctx) => {
    await removeMembership(ctx.prisma, id)
  },

  afterDelete: async (id, ctx) => {
    const member = (ctx as any)._deletedMember
    if (!member?.workspaceId || member.projectId) return

    // Active-seat billing: removing a workspace member shrinks the seat
    // quantity. Stripe credits the remaining time as account credit on the
    // next invoice via `proration_behavior: 'always_invoice'`.
    syncSeatsFromMembership(member.workspaceId).catch((err) =>
      console.error('[Billing] afterDelete seat sync failed:', err),
    )

    if (!member.user?.email) return

    // Don't email if user removed themselves (e.g. leaving workspace)
    if (member.userId === ctx.userId) return

    try {
      sendMemberRemovedEmail({
        to: member.user.email,
        workspaceName: member.workspace?.name || 'a workspace',
      }).catch((err) => console.error('[Email] member-removed failed:', err))
    } catch (err) {
      console.error('[Email] afterDelete hook error:', err)
    }
  },
}
