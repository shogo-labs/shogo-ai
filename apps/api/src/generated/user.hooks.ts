/**
 * User Hooks
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
 * Hooks for User routes
 */
export interface UserHooks {
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
 * Default User hooks (customize as needed)
 */
export const userHooks: UserHooks = {
  /**
   * Restrict listing users - only return users in shared workspaces
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Only show users who are in the same workspaces as the current user
    return {
      ok: true,
      data: {
        where: {
          memberships: {
            some: {
              workspace: {
                members: {
                  some: { userId },
                },
              },
            },
          },
        },
      },
    }
  },

  /**
   * Users can view their own profile or profiles of users in shared workspaces
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Allow viewing own profile
    if (id === userId) {
      return { ok: true }
    }

    // Check if the target user is in any shared workspaces
    const sharedWorkspace = await ctx.prisma.workspace.findFirst({
      where: {
        members: {
          some: {
            OR: [
              { userId: userId },
              { userId: id },
            ],
          },
        },
      },
      include: {
        members: {
          where: {
            OR: [
              { userId: userId },
              { userId: id },
            ],
          },
        },
      },
    })

    if (!sharedWorkspace || sharedWorkspace.members.length < 2) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Users can only update their own profile
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    if (id !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Can only update your own profile" },
      }
    }

    return { ok: true }
  },

  /**
   * Users can only delete their own account
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    if (id !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Can only delete your own account" },
      }
    }

    // Check if user is the last owner of any workspace
    const ownedWorkspaces = await ctx.prisma.workspace.findMany({
      where: {
        members: {
          some: {
            userId,
            role: 'owner',
          },
        },
      },
      include: {
        members: {
          where: { role: 'owner' },
        },
      },
    })

    const isLastOwner = ownedWorkspaces.some(ws => ws.members.length === 1)
    if (isLastOwner) {
      return {
        ok: false,
        error: {
          code: "last_owner",
          message: "Cannot delete account while being the last owner of workspaces. Transfer ownership first.",
        },
      }
    }

    return { ok: true }
  },
}
