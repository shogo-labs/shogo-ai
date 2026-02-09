/**
 * Project Hooks
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
 * Hooks for Project routes
 */
export interface ProjectHooks {
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
 * Check if the current user is a super admin.
 */
async function isSuperAdmin(ctx: HookContext): Promise<boolean> {
  if (!ctx.userId) return false
  const user = await ctx.prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { role: true },
  })
  return user?.role === 'super_admin'
}

/**
 * Default Project hooks (customize as needed)
 */
export const projectHooks: ProjectHooks = {
  /**
   * Filter projects to only those the user has access to via workspace membership.
   * Super admins can see all projects.
   * Include workspace and folder in list responses.
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Super admins can see all projects
    if (await isSuperAdmin(ctx)) {
      const workspaceId = ctx.query.workspaceId
      return {
        ok: true,
        data: {
          where: workspaceId ? { workspaceId } : {},
          include: { workspace: true, folder: true },
        },
      }
    }

    // Filter by workspaceId if provided, otherwise show all accessible projects
    const workspaceId = ctx.query.workspaceId

    if (workspaceId) {
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
          include: { workspace: true, folder: true },
        },
      }
    }

    // No workspaceId provided - return projects from all workspaces user is a member of
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
        include: { workspace: true, folder: true },
      },
    }
  },

  /**
   * Verify user has access to the project's workspace before returning.
   * Super admins can access any project.
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Super admins can access any project
    if (await isSuperAdmin(ctx)) {
      return { ok: true }
    }

    // Get project and check workspace membership
    const project = await ctx.prisma.project.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })

    if (!project) {
      return {
        ok: false,
        error: { code: "not_found", message: "Project not found" },
      }
    }

    const hasAccess = project.workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this project" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user can create projects in the target workspace
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

    // Verify user has access to create in this workspace (member or higher)
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (!membership) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    // Normalize tier and status to lowercase, set defaults if missing
    if (input.tier) {
      input.tier = input.tier.toLowerCase()
    } else {
      input.tier = 'starter'
    }
    
    if (input.status) {
      input.status = input.status.toLowerCase()
    } else {
      input.status = 'draft'
    }
    
    if (!input.createdBy && userId) input.createdBy = userId

    return { ok: true, data: input }
  },

  /**
   * Verify user has access to update the project
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const project = await ctx.prisma.project.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })

    if (!project) {
      return {
        ok: false,
        error: { code: "not_found", message: "Project not found" },
      }
    }

    const hasAccess = project.workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this project" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the project
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const project = await ctx.prisma.project.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })

    if (!project) {
      return {
        ok: false,
        error: { code: "not_found", message: "Project not found" },
      }
    }

    const hasAccess = project.workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this project" },
      }
    }

    return { ok: true }
  },
}
