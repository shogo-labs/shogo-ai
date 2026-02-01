/**
 * StarredProject Hooks
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
 * Hooks for StarredProject routes
 */
export interface StarredProjectHooks {
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
 * Default StarredProject hooks (customize as needed)
 */
export const starredProjectHooks: StarredProjectHooks = {
  /**
   * Filter starred projects by current user only
   */
  beforeList: async (ctx) => {
    const requestedUserId = ctx.query.userId
    const currentUserId = ctx.userId

    if (!currentUserId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Force filter by current user only - security check
    if (requestedUserId && requestedUserId !== currentUserId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Can only view your own starred projects" },
      }
    }

    return {
      ok: true,
      data: {
        where: { userId: currentUserId },
      },
    }
  },

  /**
   * Verify user owns the starred project before returning it
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const star = await ctx.prisma.starredProject.findUnique({
      where: { id },
    })

    if (!star) {
      return {
        ok: false,
        error: { code: "not_found", message: "Starred project not found" },
      }
    }

    if (star.userId !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Before creating a star, check if it already exists
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Verify user owns the userId in the input
    if (input.userId && input.userId !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Can only star projects for yourself" },
      }
    }

    // Set userId if not provided
    if (!input.userId) {
      input.userId = userId
    }

    const existing = await ctx.prisma.starredProject.findFirst({
      where: {
        userId: input.userId,
        projectId: input.projectId,
      },
    })

    if (existing) {
      // Return the existing record instead of creating a new one
      // This is handled specially - we return ok: false but with a specific code
      return {
        ok: false,
        error: {
          code: "already_starred",
          message: "Project is already starred",
        },
      }
    }

    return { ok: true, data: input }
  },

  /**
   * Verify user owns the starred project before deleting it
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const star = await ctx.prisma.starredProject.findUnique({
      where: { id },
    })

    if (!star) {
      return {
        ok: false,
        error: { code: "not_found", message: "Starred project not found" },
      }
    }

    if (star.userId !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },
}
