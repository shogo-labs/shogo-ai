// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */
import { getAgentTemplateById } from '../../../../packages/agent-runtime/src/agent-templates'
import * as billingService from '../services/billing.service'
import { getModelTier } from '../../../../packages/model-catalog/src/helpers'

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
  /** True when authenticated via cloud tunnel — local DB membership checks can be skipped. */
  tunnelAuthenticated?: boolean
  prisma: any
}

/**
 * Hooks for Project routes
 */
export interface ProjectHooks {
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
 * Default Project hooks (customize as needed)
 */
export const projectHooks: ProjectHooks = {
  /**
   * Filter projects to only those the user has access to via workspace membership.
   * Super admins can view any specific workspace's projects, but unscoped lists
   * still filter by their own memberships so the app remains usable.
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

    const superAdmin = await isSuperAdmin(ctx)
    let workspaceId = ctx.query.workspaceId

    // Remap cloud workspaceId to local workspace for tunnel-authenticated requests
    if (ctx.tunnelAuthenticated && workspaceId) {
      const localWs = await ctx.prisma.workspace.findFirst({ select: { id: true } })
      if (localWs) workspaceId = localWs.id
    }

    if (workspaceId) {
      if (!superAdmin && !ctx.tunnelAuthenticated) {
        const membership = await ctx.prisma.member.findFirst({
          where: { userId, workspaceId },
        })

        if (!membership) {
          return {
            ok: false,
            error: { code: "forbidden", message: "Access denied to this workspace" },
          }
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

    // Tunnel-authenticated: return all local projects (no membership filter)
    if (ctx.tunnelAuthenticated) {
      return {
        ok: true,
        data: {
          where: {},
          include: { workspace: true, folder: true },
        },
      }
    }

    // No workspaceId — scope to the user's own memberships (even for super admins)
    return {
      ok: true,
      data: {
        where: {
          OR: [
            { workspace: { members: { some: { userId } } } },
            { members: { some: { userId } } },
          ],
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

    // Super admins and tunnel-authenticated users bypass local membership checks
    if (await isSuperAdmin(ctx)) return { ok: true }
    if (ctx.tunnelAuthenticated) return { ok: true }

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

    // Check workspace membership
    const hasWorkspaceAccess = project.workspace.members.some((m: any) => m.userId === userId)
    if (hasWorkspaceAccess) return { ok: true }

    // Check direct project membership
    const projectMember = await ctx.prisma.member.findFirst({
      where: { userId, projectId: id },
    })
    if (projectMember) return { ok: true }

    return {
      ok: false,
      error: { code: "forbidden", message: "Access denied to this project" },
    }
  },

  /**
   * Verify user can create projects in the target workspace.
   * Super admins can create in any workspace.
   */
  beforeCreate: async (input, ctx) => {
    // Never allow client-supplied id — always let Prisma generate a UUID.
    // A crafted id could trigger SQL injection downstream (e.g. database provisioning).
    delete input.id

    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Tunnel-authenticated requests carry the cloud workspaceId which doesn't
    // exist in the local SQLite DB. Remap to the local workspace so the FK
    // constraint is satisfied. The desktop only has one workspace.
    if (ctx.tunnelAuthenticated) {
      const localWs = await ctx.prisma.workspace.findFirst({ select: { id: true } })
      if (localWs) {
        input.workspaceId = localWs.id
      }
    }

    const workspaceId = input.workspaceId
    if (!workspaceId) {
      return {
        ok: false,
        error: { code: "bad_request", message: "workspaceId is required" },
      }
    }

    // Super admins can create in any workspace.
    // Tunnel-authenticated requests already had membership verified by the cloud proxy.
    if (!(await isSuperAdmin(ctx)) && !ctx.tunnelAuthenticated) {
      const membership = await ctx.prisma.member.findFirst({
        where: { userId, workspaceId },
      })

      if (!membership) {
        return {
          ok: false,
          error: { code: "forbidden", message: "Access denied to this workspace" },
        }
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

    if (!input.settings) {
      input.settings = JSON.stringify({
        activeMode: 'none',
        canvasMode: 'code',
        canvasEnabled: false,
      })
    }

    return { ok: true, data: input }
  },

  /**
   * Auto-create an AgentConfig row for every new project so the heartbeat
   * scheduler can manage it. When a templateId is present the row is
   * populated from the template's settings; otherwise sensible defaults
   * (heartbeat disabled, economy model) are used.
   */
  afterCreate: async (record, ctx) => {
    const existing = await ctx.prisma.agentConfig.findUnique({
      where: { projectId: record.id },
    })
    if (existing) return

    let heartbeatEnabled = false
    let heartbeatInterval = 1800
    let modelProvider = 'anthropic'
    let modelName = 'claude-sonnet-4-6'

    if (record.templateId) {
      const template = getAgentTemplateById(record.templateId)
      if (template) {
        heartbeatEnabled = template.settings.heartbeatEnabled
        heartbeatInterval = template.settings.heartbeatInterval
        modelProvider = template.settings.modelProvider
        modelName = template.settings.modelName
      }
    }

    const jitter = Math.floor(Math.random() * heartbeatInterval * 0.1) * 1000

    // Downgrade to economy-tier model if workspace lacks advanced access
    if (record.workspaceId && getModelTier(modelName) !== 'economy') {
      try {
        const hasAdvanced = await billingService.hasAdvancedModelAccess(record.workspaceId)
        if (!hasAdvanced) {
          modelProvider = 'anthropic'
          modelName = 'claude-haiku-4-5'
        }
      } catch {
        // On billing check failure, fall back to economy to avoid broken first-run
        modelProvider = 'anthropic'
        modelName = 'claude-haiku-4-5'
      }
    }

    await ctx.prisma.agentConfig.create({
      data: {
        projectId: record.id,
        heartbeatInterval,
        heartbeatEnabled,
        modelProvider,
        modelName,
        channels: [],
        nextHeartbeatAt: heartbeatEnabled
          ? new Date(Date.now() + heartbeatInterval * 1000 + jitter)
          : null,
      },
    })
  },

  /**
   * Verify user has access to update the project (workspace member or project editor+).
   * Super admins can update any project.
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    if (await isSuperAdmin(ctx)) return { ok: true }
    if (ctx.tunnelAuthenticated) return { ok: true }

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

    const hasWorkspaceAccess = project.workspace.members.some((m: any) => m.userId === userId)
    if (hasWorkspaceAccess) return { ok: true }

    const projectMember = await ctx.prisma.member.findFirst({
      where: { userId, projectId: id },
    })
    if (projectMember && projectMember.role !== 'viewer') return { ok: true }

    return {
      ok: false,
      error: { code: "forbidden", message: "Access denied to this project" },
    }
  },

  /**
   * Verify user has access to delete the project (workspace admin+ or project admin+).
   * Super admins can delete any project.
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    if (await isSuperAdmin(ctx)) return { ok: true }
    if (ctx.tunnelAuthenticated) return { ok: true }

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

    const wsMember = project.workspace.members.find((m: any) => m.userId === userId)
    if (wsMember && (wsMember.role === 'owner' || wsMember.role === 'admin')) {
      return { ok: true }
    }

    const projectMember = await ctx.prisma.member.findFirst({
      where: { userId, projectId: id },
    })
    if (projectMember && (projectMember.role === 'owner' || projectMember.role === 'admin')) {
      return { ok: true }
    }

    return {
      ok: false,
      error: { code: "forbidden", message: "Only admins and owners can delete projects" },
    }
  },
}
