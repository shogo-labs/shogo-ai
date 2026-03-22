// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Folder Hooks
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
 * Hooks for Folder routes
 */
export interface FolderHooks {
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
 * Default Folder hooks (customize as needed)
 */
export const folderHooks: FolderHooks = {
  /**
   * Filter folders to only those in workspaces the user has access to.
   * Include parent and workspace in list responses.
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
          include: { parent: true, workspace: true },
        },
      }
    }

    // No workspaceId - return folders from all accessible workspaces
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
        include: { parent: true, workspace: true },
      },
    }
  },

  /**
   * Verify user has access to the folder via workspace membership
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const folder = await ctx.prisma.folder.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!folder) {
      return {
        ok: false,
        error: { code: "not_found", message: "Folder not found" },
      }
    }

    const hasAccess = folder.workspace?.members?.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this folder" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user can create folders in the target workspace
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

    return { ok: true }
  },

  /**
   * Verify user has access to update the folder
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const folder = await ctx.prisma.folder.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!folder) {
      return {
        ok: false,
        error: { code: "not_found", message: "Folder not found" },
      }
    }

    const hasAccess = folder.workspace?.members?.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this folder" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the folder
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const folder = await ctx.prisma.folder.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!folder) {
      return {
        ok: false,
        error: { code: "not_found", message: "Folder not found" },
      }
    }

    const hasAccess = folder.workspace?.members?.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this folder" },
      }
    }

    return { ok: true }
  },
}
