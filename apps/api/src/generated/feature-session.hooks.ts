// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FeatureSession Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import type { Permission } from "@shogo/authz"
import { accessibleProjectsWhere, type Principal } from "../lib/authz"
import { hookAuthorize, hookPrincipal, hookRequire } from "../lib/authz/hooks"

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
  tunnelAuthenticated?: boolean
  auth?: Principal
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
 * `permission` on `projectId`; project:read is strict, writes go through
 * the enforcement mode (`writeOp` names the operation for shadow logs).
 */
async function authorizeProject(
  ctx: HookContext,
  projectId: string | null | undefined,
  permission: Permission,
  forbiddenMessage: string,
  writeOp?: string,
): Promise<HookResult> {
  if (!projectId) {
    return { ok: false, error: { code: "forbidden", message: forbiddenMessage } }
  }
  const denied = writeOp
    ? await hookAuthorize(ctx, permission, { projectId }, writeOp)
    : await hookRequire(ctx, permission, { projectId })
  if (!denied) return { ok: true }
  return denied.error.code === "forbidden"
    ? { ok: false, error: { code: "forbidden", message: forbiddenMessage } }
    : denied
}

async function authorizeExistingSession(
  id: string,
  ctx: HookContext,
  permission: Permission,
  writeOp?: string,
): Promise<HookResult> {
  const session = await ctx.prisma.featureSession.findUnique({
    where: { id },
    select: { projectId: true },
  })

  if (!session) {
    return {
      ok: false,
      error: { code: "not_found", message: "Feature session not found" },
    }
  }

  return authorizeProject(ctx, session.projectId, permission, "Access denied", writeOp)
}

/**
 * Default FeatureSession hooks (customize as needed)
 */
export const featureSessionHooks: FeatureSessionHooks = {
  /**
   * Filter feature sessions to projects the user can read
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
      const access = await authorizeProject(ctx, projectId, "project:read", "Access denied to this project")
      if (!access.ok) return access

      where.projectId = projectId
    } else {
      where.project = await accessibleProjectsWhere(hookPrincipal(ctx))
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
   * Require project:read on the feature session's project
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    return authorizeExistingSession(id, ctx, "project:read")
  },

  /**
   * Require project:update on the target project
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

    return authorizeProject(
      ctx,
      projectId,
      "project:update",
      "Cannot create sessions in this project",
      "POST /api/feature-sessions",
    )
  },

  /**
   * Require project:update on the feature session's project
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const op = `PATCH /api/feature-sessions/${id}`
    const access = await authorizeExistingSession(id, ctx, "project:update", op)
    if (!access.ok) return access

    if (input?.projectId) {
      return authorizeProject(ctx, input.projectId, "project:update", "Access denied", op)
    }

    return { ok: true }
  },

  /**
   * Require project:update on the feature session's project
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    return authorizeExistingSession(id, ctx, "project:update", `DELETE /api/feature-sessions/${id}`)
  },
}
