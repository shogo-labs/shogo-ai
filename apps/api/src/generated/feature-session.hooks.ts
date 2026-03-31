// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FeatureSession Hooks
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
 * Hooks for FeatureSession routes
 */
export interface FeatureSessionHooks {
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

/**
 * Default FeatureSession hooks (customize as needed)
 */
export const featureSessionHooks: FeatureSessionHooks = {
  /**
   * Filter feature sessions to only accessible projects via workspace membership
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const projectId = ctx.query.projectId
    const where: Record<string, any> = {}

    if (projectId) {
      // Verify user has access to this specific project
      const project = await ctx.prisma.project.findUnique({
        where: { id: projectId },
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

      where.projectId = projectId
    } else {
      // Filter to only accessible projects
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
        include: { project: true },
        orderBy: { createdAt: 'desc' },
      },
    }
  },

  /**
   * Verify user has access to the feature session via project workspace
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const session = await ctx.prisma.featureSession.findUnique({
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
        error: { code: "not_found", message: "Feature session not found" },
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
   * Verify user can create feature sessions in the target project
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const projectId = input.projectId
    if (!projectId) {
      return {
        ok: false,
        error: { code: "bad_request", message: "projectId is required" },
      }
    }

    // Verify user has access to create in this project
    const project = await ctx.prisma.project.findUnique({
      where: { id: projectId },
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

    return { ok: true }
  },

  /**
   * Verify user has access to update the feature session
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const session = await ctx.prisma.featureSession.findUnique({
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
        error: { code: "not_found", message: "Feature session not found" },
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
   * Verify user has access to delete the feature session
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const session = await ctx.prisma.featureSession.findUnique({
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
        error: { code: "not_found", message: "Feature session not found" },
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
