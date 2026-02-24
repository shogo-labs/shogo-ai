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

/**
 * Default Member hooks (customize as needed)
 */
export const memberHooks: MemberHooks = {
  /**
   * Filter members to only workspaces the user has access to
   * Include user info in list responses
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
      // If no workspaceId, return members from all accessible workspaces
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
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
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
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
      },
    }
  },

  /**
   * Verify user has access to view the member
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const member = await ctx.prisma.member.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!member) {
      return {
        ok: false,
        error: { code: "not_found", message: "Member not found" },
      }
    }

    const hasAccess = member.workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user can add members to the workspace.
   * - Admin/owner can add anyone
   * - Users can add themselves if they have an accepted invitation
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

    // Check if user is already a member with admin/owner access
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (membership) {
      if (membership.role === 'owner' || membership.role === 'admin') {
        return { ok: true }
      }
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can add members" },
      }
    }

    // Allow self-join via accepted invitation
    if (input.userId === userId) {
      const user = await ctx.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      })
      if (user) {
        const invitation = await ctx.prisma.invitation.findFirst({
          where: {
            email: user.email.toLowerCase(),
            workspaceId,
            status: 'accepted',
          },
        })
        if (invitation) {
          return { ok: true }
        }
      }
    }

    return {
      ok: false,
      error: { code: "forbidden", message: "Access denied to this workspace" },
    }
  },

  /**
   * Verify user can update the member (admin/owner only)
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const targetMember = await ctx.prisma.member.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!targetMember) {
      return {
        ok: false,
        error: { code: "not_found", message: "Member not found" },
      }
    }

    const currentUserMember = targetMember.workspace.members.find((m: any) => m.userId === userId)
    if (!currentUserMember) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (currentUserMember.role !== 'owner' && currentUserMember.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can update members" },
      }
    }

    // Additional check: only owners can change roles to/from owner
    if (input.role === 'owner' || targetMember.role === 'owner') {
      if (currentUserMember.role !== 'owner') {
        return {
          ok: false,
          error: { code: "forbidden", message: "Only workspace owners can manage owner role" },
        }
      }
    }

    return { ok: true }
  },

  /**
   * Before deleting a member, check if they're the last owner
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const member = await ctx.prisma.member.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!member) {
      return {
        ok: false,
        error: { code: "not_found", message: "Member not found" },
      }
    }

    // Verify user has access to this workspace
    const currentUserMember = member.workspace.members.find((m: any) => m.userId === userId)
    if (!currentUserMember) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    // Users can remove themselves, or admin/owner can remove others
    const isRemovingSelf = member.userId === userId
    if (!isRemovingSelf) {
      if (currentUserMember.role !== 'owner' && currentUserMember.role !== 'admin') {
        return {
          ok: false,
          error: { code: "forbidden", message: "Only workspace owners and admins can remove members" },
        }
      }
    }

    // If deleting an owner, ensure there's at least one other owner
    if (member.role === 'owner' && member.workspaceId) {
      const otherOwners = await ctx.prisma.member.count({
        where: {
          workspaceId: member.workspaceId,
          role: "owner",
          id: { not: id },
        },
      })

      if (otherOwners === 0) {
        return {
          ok: false,
          error: {
            code: "last_owner",
            message: "Cannot remove the last owner of a workspace",
          },
        }
      }
    }

    return { ok: true }
  },
}
