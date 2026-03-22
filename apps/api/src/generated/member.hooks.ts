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
  prisma: any
}

/**
 * Hooks for Member routes
 */
export interface MemberHooks {
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

import { sendMemberJoinedEmail, sendMemberRemovedEmail } from "../services/email.service"

const userInclude = {
  user: {
    select: { id: true, name: true, email: true, image: true },
  },
}

export const memberHooks: MemberHooks = {
  /**
   * Filter members:
   * - ?workspaceId=X  → workspace members
   * - ?projectId=X    → project-level members
   * - (neither)       → members from all accessible workspaces
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const workspaceId = ctx.query.workspaceId
    const projectId = ctx.query.projectId

    if (projectId) {
      // Verify user has access (project member or workspace member)
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
      return { ok: true, data: { where: { projectId }, include: userInclude } }
    }

    if (workspaceId) {
      const membership = await ctx.prisma.member.findFirst({ where: { userId, workspaceId } })
      if (!membership) {
        return { ok: false, error: { code: "forbidden", message: "Access denied to this workspace" } }
      }
      return { ok: true, data: { where: { workspaceId }, include: userInclude } }
    }

    return {
      ok: true,
      data: {
        where: { workspace: { members: { some: { userId } } } },
        include: userInclude,
      },
    }
  },

  afterCreate: async (record, ctx) => {
    if (!record.workspaceId || record.projectId) return

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
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const member = await ctx.prisma.member.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })
    if (!member) {
      return { ok: false, error: { code: "not_found", message: "Member not found" } }
    }

    // Check project-level access
    if (member.projectId) {
      const projectMember = await ctx.prisma.member.findFirst({ where: { userId, projectId: member.projectId } })
      if (projectMember) return { ok: true }
    }

    const hasAccess = member.workspace?.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return { ok: false, error: { code: "forbidden", message: "Access denied" } }
    }
    return { ok: true }
  },

  /**
   * Add members to workspace or project.
   * - Admin/owner can add anyone
   * - Users can add themselves if they have an accepted invitation
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const projectId = input.projectId
    let workspaceId = input.workspaceId

    if (!workspaceId && !projectId) {
      return { ok: false, error: { code: "bad_request", message: "workspaceId or projectId is required" } }
    }

    // For project members, resolve workspace from project if not provided
    if (projectId && !workspaceId) {
      const project = await ctx.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })
      if (!project) {
        return { ok: false, error: { code: "not_found", message: "Project not found" } }
      }
      workspaceId = project.workspaceId
      input.workspaceId = workspaceId
    }

    // Check if requesting user has admin access at the target scope
    const targetScope = projectId ? { projectId } : { workspaceId }
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, ...targetScope },
    })

    if (membership && (membership.role === 'owner' || membership.role === 'admin')) {
      return { ok: true }
    }

    // Also check workspace-level admin for project operations
    if (projectId && workspaceId) {
      const wsMembership = await ctx.prisma.member.findFirst({ where: { userId, workspaceId } })
      if (wsMembership && (wsMembership.role === 'owner' || wsMembership.role === 'admin')) {
        return { ok: true }
      }
    }

    // Allow self-join via accepted invitation
    if (input.userId === userId) {
      const user = await ctx.prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
      if (user) {
        const invitationWhere: any = {
          email: user.email.toLowerCase(),
          status: 'accepted',
        }
        if (projectId) {
          invitationWhere.projectId = projectId
        } else {
          invitationWhere.workspaceId = workspaceId
        }
        const invitation = await ctx.prisma.invitation.findFirst({ where: invitationWhere })
        if (invitation) return { ok: true }
      }
    }

    return { ok: false, error: { code: "forbidden", message: "Access denied" } }
  },

  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const targetMember = await ctx.prisma.member.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })
    if (!targetMember) {
      return { ok: false, error: { code: "not_found", message: "Member not found" } }
    }

    // Check project-level admin access
    if (targetMember.projectId) {
      const projectMember = await ctx.prisma.member.findFirst({ where: { userId, projectId: targetMember.projectId } })
      if (projectMember && (projectMember.role === 'owner' || projectMember.role === 'admin')) {
        return { ok: true }
      }
    }

    const currentUserMember = targetMember.workspace?.members.find((m: any) => m.userId === userId)
    if (!currentUserMember) {
      return { ok: false, error: { code: "forbidden", message: "Access denied" } }
    }

    if (currentUserMember.role !== 'owner' && currentUserMember.role !== 'admin') {
      return { ok: false, error: { code: "forbidden", message: "Only owners and admins can update members" } }
    }

    if (input.role === 'owner' || targetMember.role === 'owner') {
      if (currentUserMember.role !== 'owner') {
        return { ok: false, error: { code: "forbidden", message: "Only owners can manage owner role" } }
      }
    }

    return { ok: true }
  },

  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }

    const member = await ctx.prisma.member.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } }, user: { select: { email: true, name: true } } },
    })

    // Stash for afterDelete email
    if (member) (ctx as any)._deletedMember = member
    if (!member) {
      return { ok: false, error: { code: "not_found", message: "Member not found" } }
    }

    // Users can remove themselves
    if (member.userId === userId) {
      // Prevent removing last owner of a workspace
      if (member.role === 'owner' && member.workspaceId && !member.projectId) {
        const otherOwners = await ctx.prisma.member.count({
          where: { workspaceId: member.workspaceId, role: "owner", id: { not: id }, projectId: null },
        })
        if (otherOwners === 0) {
          return { ok: false, error: { code: "last_owner", message: "Cannot remove the last owner" } }
        }
      }
      return { ok: true }
    }

    // Check project-level admin access
    if (member.projectId) {
      const projectMember = await ctx.prisma.member.findFirst({ where: { userId, projectId: member.projectId } })
      if (projectMember && (projectMember.role === 'owner' || projectMember.role === 'admin')) {
        return { ok: true }
      }
    }

    const currentUserMember = member.workspace?.members.find((m: any) => m.userId === userId)
    if (!currentUserMember) {
      return { ok: false, error: { code: "forbidden", message: "Access denied" } }
    }

    if (currentUserMember.role !== 'owner' && currentUserMember.role !== 'admin') {
      return { ok: false, error: { code: "forbidden", message: "Only owners and admins can remove members" } }
    }

    return { ok: true }
  },

  afterDelete: async (id, ctx) => {
    const member = (ctx as any)._deletedMember
    if (!member?.user?.email || !member.workspaceId || member.projectId) return

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
