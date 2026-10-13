// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */
import { getAgentTemplateById } from '../../../../packages/agent-runtime/src/agent-templates'
import * as billingService from '../services/billing-runtime'
import { getModelTier } from '@shogo/model-catalog'
import { getMinimumInstanceSize } from '@shogo/shared-runtime'
import { dockerClassBlockedMessage } from '../lib/runtime-class-setting'
import { getRuntimeManager } from '../lib/runtime/manager'
import { normalizeProjectSettings, parseProjectSettings } from '../lib/project-settings'
import { deleteChatAttachmentPrefix } from '../lib/chat-attachments'
import { accessibleProjects, projectScopeWhere, type Principal } from '../lib/authz'
import { withProjectPermissions } from '../lib/authz/project-permissions'
import { setProjectVisibility } from '../lib/authz/project-access'
import { hookAccess, hookAuthorize, hookPrincipal, hookRequire } from '../lib/authz/hooks'

/** projectId -> workspaceId, recorded in beforeDelete for use in afterDelete. */
const deletingProjectWorkspaces = new Map<string, string>()

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
  auth?: Principal
  prisma: any
}

/**
 * Hooks for Project routes
 */
export interface ProjectHooks {
  /** Called before listing records. Can modify where/include. */
  beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any; orderBy?: any }> | void>
  /** Called with listed records before they are returned. Can reshape them. */
  afterList?: (items: any[], ctx: HookContext) => Promise<any[] | void>
  /** Called before getting a single record. Can reject access. */
  beforeGet?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  /** Called with a fetched record before it is returned. Can reshape it. */
  afterGet?: (item: any, ctx: HookContext) => Promise<any | void>
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

/** Fields only the project's publish flow may change. */
const PUBLISH_FIELDS = ['accessLevel', 'sitePasswordHash', 'publishedSubdomain', 'publishedAt', 'publishedAlwaysOn'] as const
/** Fields the generic PATCH silently drops. */
const IMMUTABLE_FIELDS = ['workspaceId', 'createdBy', 'createdAt'] as const

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

    let workspaceId = ctx.query.workspaceId

    // Remap cloud workspaceId to local workspace for tunnel-authenticated requests
    if (ctx.tunnelAuthenticated && workspaceId) {
      const localWs = await ctx.prisma.workspace.findFirst({ select: { id: true } })
      if (localWs) workspaceId = localWs.id
    }

    // Workspace members see open projects, owners/admins see all, guests see
    // only the projects they were added to; restricted projects stay hidden.
    const scope = await accessibleProjects(hookPrincipal(ctx), workspaceId || undefined)
    if (workspaceId && scope.kind === 'none') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    return {
      ok: true,
      data: {
        where: { AND: [projectScopeWhere(scope), { hidden: false }] },
        include: { workspace: true, folder: true },
      },
    }
  },

  /** Adds the caller's effective `myPermissions` to each listed project. */
  afterList: async (items, ctx) => withProjectPermissions(hookPrincipal(ctx), items),

  /** Require project:read (guests only see their own projects). */
  beforeGet: async (id, ctx) => {
    if (!ctx.userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }
    const denied = await hookRequire(ctx, 'project:read', { projectId: id })
    return denied ?? { ok: true }
  },

  /** Adds the caller's effective `myPermissions` to the project. */
  afterGet: async (item, ctx) => (await withProjectPermissions(hookPrincipal(ctx), [item]))[0],

  /** Require project:create in the target workspace. */
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

    const denied = await hookAuthorize(ctx, 'project:create', { workspaceId }, 'POST /api/projects')
    if (denied) return denied
    if (input.visibility !== undefined && input.visibility !== 'workspace' && input.visibility !== 'restricted') {
      return { ok: false, error: { code: "bad_request", message: "visibility must be workspace or restricted" } }
    }
    // Restricted projects start open and are flipped in afterCreate together
    // with their admin grants, so a failed grant never leaves them locked.
    if (input.visibility === 'restricted') {
      ;(ctx as any)._restrictAfterCreate = true
      input.visibility = 'workspace'
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
      input.settings = {
        activeMode: 'none',
        canvasEnabled: false,
      }
    } else {
      input.settings = normalizeProjectSettings(input.settings)
    }

    // Docker-class ("Tier 2") minimum compute tier. `getMinimumInstanceSize()`
    // is a free, sync lookup that returns null for every non-Docker stack
    // today, so this only reaches the DB (`canRunTechStackOnInstanceSize`)
    // for a stack that actually declares a floor — ordinary project
    // creation isn't slowed down. This is the creation-time half of the
    // gate; `build-project-env.ts` re-checks at VM-assignment time as
    // defense-in-depth in case a project's settings/workspace tier changes
    // after creation.
    const techStackId = (input.settings as Record<string, unknown> | null)?.techStackId as
      | string
      | undefined
    const dockerBlocked = dockerClassBlockedMessage(techStackId)
    if (dockerBlocked) {
      return { ok: false, error: { code: 'docker_class_disabled', message: dockerBlocked } }
    }
    if (getMinimumInstanceSize(techStackId)) {
      const { allowed, currentSize, requiredSize } = await billingService.canRunTechStackOnInstanceSize(
        workspaceId,
        techStackId,
      )
      if (!allowed) {
        return {
          ok: false,
          error: {
            code: 'instance_too_small',
            message: `This stack requires the ${requiredSize} compute tier or higher (workspace is currently on ${currentSize}). Upgrade compute in Settings > Billing to continue.`,
          },
        }
      }
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
    if ((ctx as any)._restrictAfterCreate) {
      await setProjectVisibility(ctx.prisma, record.id, 'restricted', ctx.userId)
      record.visibility = 'restricted'
    }

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
   * Require project:update (publish fields need project:publish, visibility
   * needs project.members:manage).
   */
  beforeUpdate: async (id, input, ctx) => {
    // Mutate in place: the access-control branches below don't return
    // `data`, and the route keeps its own `body` reference in that case.
    if (input?.settings !== undefined) {
      input.settings = normalizeProjectSettings(input.settings)
    }

    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    for (const field of IMMUTABLE_FIELDS) {
      if (input) delete input[field]
    }

    const access = await hookAccess(ctx, { projectId: id })
    if (!access.exists) {
      return { ok: false, error: { code: "not_found", message: "Project not found" } }
    }
    const denied = PUBLISH_FIELDS.some((f) => input?.[f] !== undefined)
      ? await hookRequire(ctx, 'project:publish', { projectId: id })
      : await hookAuthorize(ctx, 'project:update', { projectId: id }, `PATCH /api/projects/${id}`)
    if (denied) return denied
    if (input?.visibility !== undefined) {
      return {
        ok: false,
        error: {
          code: "use_visibility_endpoint",
          message: "Change visibility with PATCH /api/projects/:projectId/visibility",
        },
      }
    }

    // Docker-class ("Tier 2") minimum compute tier — same rationale as
    // `beforeCreate`'s check. Only triggers a lookup when the PATCH is
    // actually switching `techStackId` to a stack with a declared floor
    // (`getMinimumInstanceSize()` is a free, sync check), and only blocks
    // when the stack is actually CHANGING, so unrelated settings patches
    // (e.g. toggling `canvasMode`) on an existing docker-compose project
    // are never affected by this gate.
    const incomingTechStackId = (input?.settings as Record<string, unknown> | null)?.techStackId as
      | string
      | undefined
    if (
      incomingTechStackId &&
      (getMinimumInstanceSize(incomingTechStackId) || dockerClassBlockedMessage(incomingTechStackId))
    ) {
      const existing = await ctx.prisma.project.findUnique({
        where: { id },
        select: { workspaceId: true, settings: true },
      })
      if (existing) {
        const currentTechStackId = parseProjectSettings(existing.settings)?.techStackId as
          | string
          | undefined
        if (currentTechStackId !== incomingTechStackId) {
          const dockerBlocked = dockerClassBlockedMessage(incomingTechStackId)
          if (dockerBlocked) {
            return { ok: false, error: { code: 'docker_class_disabled', message: dockerBlocked } }
          }
          if (getMinimumInstanceSize(incomingTechStackId)) {
            const { allowed, currentSize, requiredSize } = await billingService.canRunTechStackOnInstanceSize(
              existing.workspaceId,
              incomingTechStackId,
            )
            if (!allowed) {
              return {
                ok: false,
                error: {
                  code: "instance_too_small",
                  message: `Switching to this stack requires the ${requiredSize} compute tier or higher (workspace is currently on ${currentSize}). Upgrade compute in Settings > Billing to continue.`,
                },
              }
            }
          }
        }
      }
    }

    return { ok: true }
  },

  /** Require project:delete (workspace owner/admin or project admin). */
  beforeDelete: async (id, ctx) => {
    // Remember the workspace so afterDelete can tell team chat the agent is gone.
    try {
      const row = await ctx.prisma.project.findUnique({ where: { id }, select: { workspaceId: true } })
      if (row?.workspaceId) deletingProjectWorkspaces.set(id, row.workspaceId)
    } catch {
      // Best-effort; afterDelete falls back to the conversations the agent was in.
    }
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const denied = await hookRequire(ctx, 'project:delete', { projectId: id })
    if (denied) {
      return denied.error.code === 'forbidden'
        ? { ok: false, error: { code: "forbidden", message: "Only admins and owners can delete projects" } }
        : denied
    }

    try {
      const sessions = await ctx.prisma.chatSession.findMany({
        where: { contextType: 'project', contextId: id },
        select: { id: true },
      })
      await Promise.all(
        sessions.map((session: { id: string }) => deleteChatAttachmentPrefix(session.id)),
      )
    } catch (error: any) {
      console.warn(`[project.beforeDelete] attachment cleanup failed for ${id}:`, error?.message || error)
    }
    return { ok: true }
  },

  /**
   * Tear down any live runtime for the project as soon as it's deleted.
   * Without this, the warm-pool VM (or host RuntimeManager runtime) stays
   * resident until the next idle-eviction sweep, which on the desktop has
   * been observed to leak 49 GB+ of QEMU memory across orphaned projects.
   * Best-effort: lazily import the VM pool so cloud (Knative) deployments
   * don't pay for the dependency.
   */
  afterDelete: async (id) => {
    // Drop the project's agent from team chat (DMs archived, channel memberships removed).
    const workspaceId = deletingProjectWorkspaces.get(id) ?? null
    deletingProjectWorkspaces.delete(id)
    try {
      const { removeProjectAgent } = await import('../services/conversation.service')
      await removeProjectAgent(id, workspaceId)
    } catch (err: any) {
      console.warn(`[project.afterDelete] team chat cleanup for ${id} failed:`, err?.message ?? err)
    }
    try {
      await getRuntimeManager().stop(id).catch(() => {})
    } catch {
      // RuntimeManager not initialized (cloud mode) — nothing to clean up.
    }
    try {
      const mod = await import('../lib/vm-warm-pool-controller')
      try {
        mod.getVMWarmPoolController().evictProject(id)
      } catch {
        // VM pool not initialized (host mode / cloud) — nothing to evict.
      }
    } catch {
      // Module not available in this build.
    }
    // Cloud (Kubernetes) teardown: previously a user delete left the project's
    // runtime infra behind — the Knative ksvc + DomainMapping, and any metal
    // snapshot on NVMe/S3 — until an admin/GC sweep. Destroy both substrates so
    // nothing leaks (covers the drain window where a project has both).
    if (process.env.SHOGO_LOCAL_MODE !== 'true') {
      try {
        const { destroyProjectRuntime } = await import('../lib/substrate')
        await destroyProjectRuntime(id)
      } catch (err: any) {
        console.warn(`[project.afterDelete] substrate teardown for ${id} failed:`, err?.message ?? err)
      }
    }
  },
}
