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
import { getEffectivePlanId } from '../services/billing.service'
import { homeRegionForNewWorkspace } from '../lib/region'

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6)

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

/**
 * Validate a request to create a "child" workspace under `parentWorkspaceId`.
 *
 * Child workspaces are free and pool the parent's plan/wallet/seats. They are
 * only allowed when:
 *   - the parent exists and is itself top-level (single-level hierarchy),
 *   - the caller is an owner/admin/billing-admin of the parent (or a super admin), and
 *   - the parent's effective plan is Business or Enterprise.
 *
 * Returns a `HookResult` error to reject, or `{ ok: true }` to allow.
 */
async function validateChildWorkspaceCreation(
  parentWorkspaceId: string,
  userId: string | undefined,
  ctx: HookContext,
): Promise<HookResult> {
  if (!userId) {
    return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
  }

  const parent = await ctx.prisma.workspace.findUnique({
    where: { id: parentWorkspaceId },
    include: { members: true },
  })
  if (!parent) {
    return { ok: false, error: { code: "not_found", message: "Parent workspace not found" } }
  }
  // Single-level hierarchy: a child cannot itself be a parent.
  if (parent.parentWorkspaceId) {
    return {
      ok: false,
      error: { code: "invalid_parent", message: "Cannot nest workspaces more than one level deep" },
    }
  }

  const superAdmin = await isSuperAdmin(ctx)
  const member = parent.members.find((m: any) => m.userId === userId)
  const isParentAdmin = !!member && (member.role === 'owner' || member.role === 'admin' || member.isBillingAdmin)
  if (!superAdmin && !isParentAdmin) {
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: "Only owners or admins of the parent workspace can create child workspaces",
      },
    }
  }

  // Local mode unlocks all plan-gated features for development.
  if (!isLocalMode) {
    const plan = await getEffectivePlanId(parentWorkspaceId)
    if (plan !== 'business' && plan !== 'enterprise') {
      return {
        ok: false,
        error: {
          code: "plan_required",
          message: "Additional workspaces are included free on Business and Enterprise plans only",
        },
      }
    }
  }

  return { ok: true }
}

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
    const parentWorkspaceId: string | null = input.parentWorkspaceId ?? ctx.body.parentWorkspaceId ?? null

    if (parentWorkspaceId) {
      // Free "child" workspace under a Business/Enterprise parent. Bypasses the
      // one-free-workspace limit; the link itself is persisted in afterCreate
      // (the generated create allowlist doesn't include parentWorkspaceId).
      const childCheck = await validateChildWorkspaceCreation(parentWorkspaceId, userId, ctx)
      if (!childCheck.ok) return childCheck
    } else if (userId) {
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

    // Pin write-ownership to the creating region unless the caller already set
    // one (e.g. a proxied write from the workspace's home region). This keeps
    // every workspace single-writer so its rows never conflict across regions.
    if (input.homeRegion == null) {
      input.homeRegion = homeRegionForNewWorkspace()
    }

    return { ok: true, data: input }
  },

  /**
   * After creating a workspace, create the owner membership
   */
  afterCreate: async (workspace, ctx) => {
    // Persist the parent link for child workspaces. beforeCreate has already
    // validated eligibility; the generated create allowlist strips
    // parentWorkspaceId, so we set it here with an explicit update.
    const parentWorkspaceId: string | null = ctx.body.parentWorkspaceId ?? null
    if (parentWorkspaceId && parentWorkspaceId !== workspace.id) {
      await ctx.prisma.workspace.update({
        where: { id: workspace.id },
        data: { parentWorkspaceId },
      })
    }

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

    const workspace = await ctx.prisma.workspace.findUnique({
      where: { id },
      include: { members: true, children: { select: { id: true } } },
    })

    if (!workspace) {
      return {
        ok: false,
        error: { code: "not_found", message: "Workspace not found" },
      }
    }

    // A parent workspace can't be deleted while it still has child workspaces
    // pooling its plan — those children would be orphaned onto the free tier.
    // This guard applies to super admins too (deletion would silently downgrade
    // every child); detach or delete the children first.
    if (workspace.children && workspace.children.length > 0) {
      return {
        ok: false,
        error: {
          code: "has_child_workspaces",
          message: "This workspace has child workspaces. Delete or detach them before deleting it.",
        },
      }
    }

    // Super admins can delete any workspace (subject to the child guard above)
    if (await isSuperAdmin(ctx)) {
      return { ok: true }
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
