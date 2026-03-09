// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import { customAlphabet } from 'nanoid'
import { getUserOwnedWorkspaceCount } from '../services/workspace.service'

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6)

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
 * Hooks for Workspace routes
 */
export interface WorkspaceHooks {
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
 * Default Workspace hooks (customize as needed)
 */
export const workspaceHooks: WorkspaceHooks = {
  /**
   * Filter workspaces by user membership and enforce access control.
   * Super admins can see all workspaces.
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

    // Super admins can view any user's workspaces when an explicit userId is provided.
    // Without a filter, scope to their own memberships so the app stays usable.
    if (await isSuperAdmin(ctx)) {
      const targetUserId = requestedUserId || currentUserId
      return {
        ok: true,
        data: {
          where: {
            members: { some: { userId: targetUserId } },
          },
        },
      }
    }

    // Force filter by current user only - security check
    if (requestedUserId && requestedUserId !== currentUserId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Can only view your own workspaces" },
      }
    }

    // Filter workspaces where user has a membership
    return {
      ok: true,
      data: {
        where: {
          members: {
            some: {
              userId: currentUserId,
            },
          },
        },
      },
    }
  },

  /**
   * Verify user has access to the workspace before returning it.
   * Super admins can access any workspace.
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Super admins can access any workspace
    if (await isSuperAdmin(ctx)) {
      return { ok: true }
    }

    const workspace = await ctx.prisma.workspace.findUnique({
      where: { id },
      include: { members: true },
    })

    if (!workspace) {
      return {
        ok: false,
        error: { code: "not_found", message: "Workspace not found" },
      }
    }

    const hasAccess = workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    return { ok: true }
  },

  /**
   * Generate unique slug before creating workspace
   * Fixes: Workspace creation failures (5.9% rate) from slug collisions
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.body.ownerId || ctx.userId
    if (userId) {
      const ownedCount = await getUserOwnedWorkspaceCount(userId)
      if (ownedCount >= 1) {
        return {
          ok: false,
          error: {
            code: "workspace_limit_reached",
            message: "You already have a free workspace. Additional workspaces require a paid subscription.",
          },
        }
      }
    }

    if (!input.slug && input.name) {
      const baseSlug = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      
      // Add random suffix to avoid collisions
      input.slug = `${baseSlug}-${nanoid()}`
    }
    
    // If slug already provided, verify it's unique
    if (input.slug) {
      const existing = await ctx.prisma.workspace.findUnique({
        where: { slug: input.slug }
      })
      
      if (existing) {
        // Regenerate with random suffix
        const baseSlug = input.slug.replace(/-[a-z0-9]{6}$/, '')
        input.slug = `${baseSlug}-${nanoid()}`
      }
    }
    
    return { ok: true, data: input }
  },

  /**
   * After creating a workspace, create the owner membership
   */
  afterCreate: async (workspace, ctx) => {
    const ownerId = ctx.body.ownerId || ctx.userId
    if (!ownerId) {
      console.warn("[Workspace] No ownerId provided, skipping owner membership creation")
      return
    }

    await ctx.prisma.member.create({
      data: {
        userId: ownerId,
        workspaceId: workspace.id,
        role: "owner",
      },
    })
  },

  /**
   * Verify user has access to update the workspace.
   * Super admins can update any workspace.
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Super admins can update any workspace
    if (await isSuperAdmin(ctx)) {
      return { ok: true }
    }

    const workspace = await ctx.prisma.workspace.findUnique({
      where: { id },
      include: { members: true },
    })

    if (!workspace) {
      return {
        ok: false,
        error: { code: "not_found", message: "Workspace not found" },
      }
    }

    const member = workspace.members.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    // Only owners and admins can update workspace settings
    if (member.role !== 'owner' && member.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can update workspace settings" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the workspace (owner only).
   * Super admins can delete any workspace.
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Super admins can delete any workspace
    if (await isSuperAdmin(ctx)) {
      return { ok: true }
    }

    const workspace = await ctx.prisma.workspace.findUnique({
      where: { id },
      include: { members: true },
    })

    if (!workspace) {
      return {
        ok: false,
        error: { code: "not_found", message: "Workspace not found" },
      }
    }

    const member = workspace.members.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    // Only owners can delete workspaces
    if (member.role !== 'owner') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners can delete workspaces" },
      }
    }

    return { ok: true }
  },
}
