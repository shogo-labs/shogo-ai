/**
 * ChatSession Hooks
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
 * Hooks for ChatSession routes
 */
export interface ChatSessionHooks {
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
 * Default ChatSession hooks (customize as needed)
 */
export const chatSessionHooks: ChatSessionHooks = {
  /**
   * Filter chat sessions by contextType and contextId (projectId), verify workspace access
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const { contextType, contextId, projectId } = ctx.query
    const where: Record<string, any> = {}

    if (contextType) where.contextType = contextType
    if (contextId) where.contextId = contextId
    if (projectId) where.contextId = projectId

    // If projectId is specified, verify user has access to that project
    if (projectId || contextId) {
      const targetProjectId = projectId || contextId
      const project = await ctx.prisma.project.findUnique({
        where: { id: targetProjectId },
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
    } else {
      // No specific project - filter to only accessible projects
      where.project = {
        workspace: {
          members: { some: { userId } },
        },
      }
    }

    return {
      ok: true,
      data: {
        where,
        include: {
          project: true,
        },
        orderBy: { updatedAt: 'desc' },
      },
    }
  },

  /**
   * Verify user has access to the chat session via workspace membership
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const session = await ctx.prisma.chatSession.findUnique({
      where: { id },
      include: {
        project: {
          include: {
            workspace: {
              include: { members: true },
            },
          },
        },
      },
    })

    if (!session) {
      return {
        ok: false,
        error: { code: "not_found", message: "Chat session not found" },
      }
    }

    const hasAccess = session.project?.workspace?.members?.some(
      (m: any) => m.userId === userId
    )

    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user can create chat sessions in the target project
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Set default inferred name if not provided
    if (!input.inferredName) {
      input.inferredName = input.name || 'New Chat'
    }

    // Set default context type
    if (!input.contextType) {
      input.contextType = 'general'
    }

    // If contextId (projectId) is provided, verify access
    if (input.contextId) {
      const project = await ctx.prisma.project.findUnique({
        where: { id: input.contextId },
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
          error: { code: "forbidden", message: "Cannot create sessions in this project" },
        }
      }
    }

    return { ok: true, data: input }
  },

  /**
   * Verify user has access to update the chat session
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const session = await ctx.prisma.chatSession.findUnique({
      where: { id },
      include: {
        project: {
          include: {
            workspace: {
              include: { members: true },
            },
          },
        },
      },
    })

    if (!session) {
      return {
        ok: false,
        error: { code: "not_found", message: "Chat session not found" },
      }
    }

    const hasAccess = session.project?.workspace?.members?.some(
      (m: any) => m.userId === userId
    )

    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the chat session
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const session = await ctx.prisma.chatSession.findUnique({
      where: { id },
      include: {
        project: {
          include: {
            workspace: {
              include: { members: true },
            },
          },
        },
      },
    })

    if (!session) {
      return {
        ok: false,
        error: { code: "not_found", message: "Chat session not found" },
      }
    }

    const hasAccess = session.project?.workspace?.members?.some(
      (m: any) => m.userId === userId
    )

    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },
}
