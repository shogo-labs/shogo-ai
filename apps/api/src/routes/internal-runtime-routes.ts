// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime-facing `/api/internal/*` routes: the endpoints an agent-runtime
 * calls back into the API with (trust, checkpoints, heartbeat, plans,
 * history, workspace agent, workspace members, project lifecycle,
 * agent-call).
 *
 * Mounted by the cloud internal router (SA token OR runtime token) and by the
 * slim desktop composer (runtime token only). Keep this module free of the
 * cluster stack (`@kubernetes/client-node`, Redis, metal placement): anything
 * cloud-only is injected through `RuntimeInternalRoutesOptions` so the
 * desktop bundle does not pull it in. Routes whose capability is not provided
 * answer 501 instead of disappearing into a 404.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { join, resolve } from 'path'
import {
  recordCheckpointForCommit,
  listCheckpoints as listCheckpointsSvc,
  getCheckpoint as getCheckpointSvc,
  rollback as rollbackSvc,
  getDiff as getDiffSvc,
} from '../services/checkpoint.service'
import { prisma } from '../lib/prisma'
import { hydrateRepo } from '../services/git-repo-store'
import { trackEvent } from '../services/loops.service'
import {
  attachProject,
  detachProject,
  getAttachedProjects,
} from '../services/workspace-session.service'
import { resolveWorkspaceRuntimeUrl } from '../lib/resolve-workspace-runtime-url'
import { deriveWorkspaceRuntimeToken } from '../lib/workspace-runtime-token'
import { getRuntimeManager } from '../lib/runtime/manager'
import { resolve as resolvePath } from 'path'
import { searchWorkspaceHistory, renderWorkspaceTranscript, readWorkspacePlan } from '../lib/history-search'
import {
  workspaceAgentRoutes,
  type WorkspaceAgentAuthContext,
  type WorkspaceAgentRoutesConfig,
} from './workspace-agent'
import {
  createInternalAuthorizers,
  logAuthReject,
  type InternalAuthenticate,
  type InternalIdentity,
} from './internal-runtime-auth'
import { projectTrustRoutes } from './internal-project-trust'
import { withShogoPrFooter } from '@shogo/shared-runtime/agent-attribution'

type ProjectLifecycleService = typeof import('../services/project-lifecycle.service')
type AgentCallService = typeof import('../services/agent-call.service')
type GitHubService = typeof import('../services/github.service')

export interface RuntimeInternalRoutesOptions {
  authenticate: InternalAuthenticate
  /** Cloud avatar storage; the workspace-agent router falls back to local disk. */
  saveAgentAvatar?: WorkspaceAgentRoutesConfig['saveAgentAvatar']
  /** Live mount/unmount on a metal workspace runtime (cloud only). */
  metalWorkspaceMember?: (
    workspaceId: string,
    op: 'mount' | 'unmount',
    projectId: string,
    realPath: string,
  ) => Promise<unknown>
  /** Backs the `project_*` / `system_apply` tools. */
  loadProjectLifecycle?: () => Promise<ProjectLifecycleService>
  /** Backs `project_call`. */
  loadAgentCall?: () => Promise<AgentCallService>
  /** Cloud-only GitHub App operations; omitted from the slim desktop bundle. */
  loadGitHub?: () => Promise<GitHubService>
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function unavailable(c: Context, capability: string) {
  return c.json(
    { error: { code: 'not_available', message: `${capability} is not available on this API` } },
    501,
  )
}

// Resolve the workspaces root the same way server.ts does so the internal
// checkpoint routes operate on the same on-disk repos as the public ones.
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(process.cwd(), 'workspaces')

function internalWorkspacePath(projectId: string): string {
  return join(WORKSPACES_DIR, projectId)
}

/** Folder-linked projects have no Shogo-managed git → typed 409 (mirrors public route). */
function externalModeResponse(c: Context) {
  return c.json(
    {
      error: {
        code: 'checkpoints_disabled_in_external_mode',
        message:
          "Checkpoints are disabled for folder-linked projects. Use your own git workflow — Shogo doesn't manage the repo.",
      },
    },
    409,
  )
}

async function loadProjectForCheckpoints(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workingMode: true } as any,
  })
}


export function runtimeInternalRoutes(opts: RuntimeInternalRoutesOptions): Hono {
  const {
    authenticate,
    saveAgentAvatar,
    metalWorkspaceMember,
    loadProjectLifecycle,
    loadAgentCall,
    loadGitHub,
  } = opts
  const { validateAuth, authorizeWorkspaceScope, authorizeWorkspaceRuntimeRequest } =
    createInternalAuthorizers(authenticate)
  const app = new Hono()

  /**
   * POST /api/internal/heartbeat/complete
   *
   * Called by the agent pod after a heartbeat tick finishes.
   * Updates lastHeartbeatAt in the DB. Authenticated via K8s SA token.
   */
  app.post('/heartbeat/complete', async (c) => {
    // Parse body first so we have projectId for runtime-token validation
    const body = await c.req.json()
    const projectId = body.projectId as string

    if (!projectId || typeof projectId !== 'string') {
      return c.json({ error: 'projectId is required' }, 400)
    }

    if (!(await validateAuth(c, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      const { prisma } = await import('../lib/prisma')
      await prisma.agentConfig.updateMany({
        where: { projectId },
        data: { lastHeartbeatAt: new Date() },
      })

      return c.json({ ok: true })
    } catch (err: any) {
      console.error(`[Internal] Failed to update heartbeat completion for ${projectId}:`, err.message)
      return c.json({ error: 'Failed to update heartbeat completion' }, 500)
    }
  })

  /**
   * PUT /api/internal/heartbeat/config/:projectId
   *
   * Update heartbeat scheduling config for an agent. Manages nextHeartbeatAt
   * based on enabled/disabled state and interval changes.
   */
  app.put('/heartbeat/config/:projectId', async (c) => {
    const projectId = c.req.param('projectId')

    if (!(await validateAuth(c, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const body = await c.req.json()

    try {
      const { prisma } = await import('../lib/prisma')
      const data: Record<string, any> = {}

      if (typeof body.heartbeatEnabled === 'boolean') {
        data.heartbeatEnabled = body.heartbeatEnabled
      }
      if (typeof body.heartbeatInterval === 'number' && body.heartbeatInterval >= 60) {
        data.heartbeatInterval = body.heartbeatInterval
      }
      if (body.quietHoursStart !== undefined) data.quietHoursStart = body.quietHoursStart || null
      if (body.quietHoursEnd !== undefined) data.quietHoursEnd = body.quietHoursEnd || null
      if (body.quietHoursTimezone !== undefined) data.quietHoursTimezone = body.quietHoursTimezone || null

      const existing = await prisma.agentConfig.findUnique({ where: { projectId } })
      if (!existing) {
        return c.json({ error: 'Agent config not found' }, 404)
      }

      const enabled = data.heartbeatEnabled ?? existing.heartbeatEnabled
      const interval = data.heartbeatInterval ?? existing.heartbeatInterval

      if (enabled) {
        const jitter = Math.floor(Math.random() * interval * 0.1) * 1000
        data.nextHeartbeatAt = new Date(Date.now() + interval * 1000 + jitter)
      } else {
        data.nextHeartbeatAt = null
      }

      await prisma.agentConfig.update({
        where: { projectId },
        data,
      })

      // FIRE-AND-FORGET: track first heartbeat scheduled when enabling for the first time
      if (enabled && !existing.heartbeatEnabled) {
        // Look up the project owner to identify the user
        prisma.project.findUnique({
          where: { id: projectId },
          select: { createdBy: true },
        }).then((proj) => {
          if (proj?.createdBy) {
            trackEvent(proj.createdBy, 'first_heartbeat_scheduled', { project_id: projectId }).catch(() => {})
          }
        }).catch(() => {})
      }

      return c.json({ ok: true, nextHeartbeatAt: data.nextHeartbeatAt })
    } catch (err: any) {
      console.error(`[Internal] Failed to update heartbeat config for ${projectId}:`, err.message)
      return c.json({ error: 'Failed to update heartbeat config' }, 500)
    }
  })

  /**
   * GET /api/internal/subagent-overrides/resolve
   *   ?workspaceId=...&projectId=...&agentType=...
   *
   * Called by agent-runtime spawning a sub-agent to learn whether the user has
   * overridden the built-in default model for this agent type. Authenticated
   * via K8s SA token or HMAC-signed `x-runtime-token`.
   *
   * Returns 200 { override: { model, provider, source } | null }.
   */
  app.get('/subagent-overrides/resolve', async (c) => {
    const workspaceId = c.req.query('workspaceId')
    const projectId = c.req.query('projectId') || undefined
    const agentType = c.req.query('agentType')
    // Phase 3.2 — optional bucket key so the experiment assignment is stable
    // for repeated calls with the same agentRunId (no double-assignment within
    // a single chat turn).
    const bucketKey = c.req.query('bucketKey') || undefined

    if (!workspaceId || !agentType) {
      return c.json({ error: 'workspaceId and agentType are required' }, 400)
    }

    if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      const { resolveSubagentModelOverride, pickExperimentModel } = await import(
        '../services/cost-analytics.service'
      )
      const override = await resolveSubagentModelOverride(workspaceId, agentType, projectId)
      if (override) return c.json({ override, experiment: null })

      // No explicit override — fall back to the active experiment, if any.
      const exp = await pickExperimentModel(workspaceId, agentType, bucketKey)
      return c.json({ override: null, experiment: exp })
    } catch (err: any) {
      console.error(`[Internal] Failed to resolve subagent override for ${workspaceId}/${agentType}:`, err.message)
      return c.json({ error: 'Failed to resolve override' }, 500)
    }
  })

  /**
   * POST /api/internal/agent-cost-metrics
   *   body: { workspaceId, projectId?, agentRunId?, agentType, model,
   *           inputTokens, outputTokens, cachedInputTokens?, toolCalls,
   *           creditCost, wallTimeMs, success, hitMaxTurns?, loopDetected?,
   *           escalated?, responseEmpty? }
   *
   * Called by agent-runtime when a sub-agent run completes (Phase 2.1). The
   * runtime emits the legacy `success` flag plus the multi-signal quality
   * fields; the API server persists them so the recommendation gate can score
   * runs on real quality instead of "didn't throw".
   *
   * Authenticated like the override endpoint above.
   */
  app.post('/agent-cost-metrics', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const projectId = typeof body.projectId === 'string' ? body.projectId : undefined
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null
    // The target workspace comes from the body, so a project/workspace runtime
    // token must be checked against it — otherwise any pod could write metrics
    // (and skew model-quality analytics) for a workspace it doesn't belong to.
    if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const agentType = typeof body.agentType === 'string' ? body.agentType : null
    const model = typeof body.model === 'string' ? body.model : null
    if (!workspaceId || !agentType || !model) {
      return c.json({ error: 'workspaceId, agentType, and model are required' }, 400)
    }

    try {
      const { recordAgentCostMetric } = await import('../services/cost-analytics.service')
      await recordAgentCostMetric({
        workspaceId,
        projectId,
        agentRunId: typeof body.agentRunId === 'string' ? body.agentRunId : undefined,
        agentType,
        model,
        inputTokens: numberOr(body.inputTokens, 0),
        outputTokens: numberOr(body.outputTokens, 0),
        cachedInputTokens: numberOr(body.cachedInputTokens, 0),
        toolCalls: numberOr(body.toolCalls, 0),
        creditCost: numberOr(body.creditCost, 0),
        wallTimeMs: numberOr(body.wallTimeMs, 0),
        success: body.success !== false,
        hitMaxTurns: body.hitMaxTurns === true,
        loopDetected: body.loopDetected === true,
        escalated: body.escalated === true,
        responseEmpty: body.responseEmpty === true,
        // Free-form correlation (e.g. `pipelineRunId` from `project_call`).
        // Bounded so a runtime can't stuff arbitrary payloads into analytics.
        metadata:
          body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            && JSON.stringify(body.metadata).length <= 4_096
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      })
      return c.json({ ok: true })
    } catch (err: any) {
      console.error('[Internal] Failed to record agent cost metric:', err.message)
      return c.json({ error: 'Failed to record metric' }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // Workspace agent profile and goals (universal workspace primitives; see
  // routes/workspace-agent.ts). Mounted here with the runtime-pod / SA
  // authorization strategy — the handler implementation is shared with the
  // session-authenticated mount in server.ts so the two surfaces can't drift.
  // ---------------------------------------------------------------------------

  app.route(
    '/',
    workspaceAgentRoutes({
      saveAgentAvatar,
      authorize: async (c): Promise<WorkspaceAgentAuthContext | Response> => {
        const workspaceId = c.req.param('workspaceId')
        if (!(await authorizeWorkspaceScope(c, workspaceId))) {
          return c.json({ error: 'Unauthorized' }, 401)
        }
        return { workspaceId }
      },
    }),
  )

  // ---------------------------------------------------------------------------
  // Workspace meta-agent membership
  // ---------------------------------------------------------------------------

  /**
   * User-facing project catalog for this workspace: what `list_projects`
   * returns to the agent for chat display, and what the mount/unmount member
   * endpoints below use to authorize attaching a project to a session.
   * Excludes `hidden` projects (personal-companion builder delegates, or any
   * workspace's explicitly-hidden projects) — those are resolved by id only
   * (`project_call`), never surfaced in a list a user or chat transcript can
   * read. `list_projects`/`mount_project`/`unmount_project` are themselves
   * disabled for the `personal` capability profile (see
   * `capability-profiles.ts`), so this only affects team workspaces today.
   */
  async function accessibleWorkspaceProjects(workspaceId: string, userId: string) {
    const workspaceMember = await prisma.member.findFirst({
      where: { workspaceId, userId },
      select: { id: true },
    })
    return prisma.project.findMany({
      where: {
        workspaceId,
        hidden: false,
        ...(workspaceMember ? {} : { members: { some: { userId } } }),
      },
      select: { id: true, name: true, description: true, createdBy: true },
      orderBy: { name: 'asc' },
    })
  }

  async function workspaceRuntimeMemberCall(
    workspaceId: string,
    attachedProjectIds: string[],
    path: string,
    init: RequestInit,
    opts: { readonlyProjectIds?: string[]; hostRealPath?: string } = {},
  ) {
    const resolved = await resolveWorkspaceRuntimeUrl(workspaceId, {
      attachedProjectIds,
      runtimeManager: getRuntimeManager(),
      alwaysEnabled: true,
      logTag: 'WorkspaceMembers',
    })
    const requestJson =
      typeof init.body === 'string' ? JSON.parse(init.body) : {}
    if (resolved.mode === 'metal' && path.startsWith('/internal/workspace/members')) {
      const projectId =
        typeof requestJson?.id === 'string'
          ? requestJson.id
          : decodeURIComponent(path.split('/').pop() || '')
      if (!metalWorkspaceMember) throw new Error('metal workspace runtimes are not available on this API')
      const result = await metalWorkspaceMember(
        workspaceId,
        path.endsWith('/members') ? 'mount' : 'unmount',
        projectId,
        `/app/workspace/${projectId}`,
      )
      return { resolved, body: result }
    }
    if (resolved.mode === 'host') {
      await getRuntimeManager().refreshWorkspaceMergedRoot(
        workspaceId,
        attachedProjectIds,
        opts.readonlyProjectIds ?? [],
      )
    }
    let requestBody = init.body
    if (resolved.mode === 'host' && opts.hostRealPath && typeof requestBody === 'string') {
      const parsed = JSON.parse(requestBody)
      parsed.realPath = opts.hostRealPath
      requestBody = JSON.stringify(parsed)
    }
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    headers.set('x-runtime-token', deriveWorkspaceRuntimeToken(workspaceId))
    const response = await fetch(`${resolved.url}${path}`, { ...init, headers, ...(requestBody ? { body: requestBody } : {}) })
    const responseBody = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(responseBody?.error?.message || responseBody?.error || `workspace runtime HTTP ${response.status}`)
    }
    return { resolved, body: responseBody }
  }

  app.get('/workspaces/:workspaceId/projects', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const identity = await authorizeWorkspaceRuntimeRequest(c, workspaceId)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const userId = c.req.query('userId')
    const sessionId = c.req.query('sessionId')
    if (!userId) return c.json({ error: 'userId is required' }, 400)
    const projects = await accessibleWorkspaceProjects(workspaceId, userId)
    const attached = sessionId ? await getAttachedProjects(sessionId) : []
    const attachedIds = new Set(attached.map((row) => row.projectId))
    return c.json({
      projects: projects.map((project) => ({
        ...project,
        mounted: attachedIds.has(project.id),
        attachMode: attached.find((row) => row.projectId === project.id)?.attachMode ?? null,
      })),
    })
  })

  app.get('/workspaces/:workspaceId/history/search', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    if (!(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
    const rawKind = c.req.query('kind')
    const kind = rawKind === 'chat' || rawKind === 'plan' ? rawKind : 'all'
    return c.json({
      workspaceId,
      kind,
      ...(await searchWorkspaceHistory({
        workspaceId,
        query: c.req.query('q') || c.req.query('query') || '',
        kind,
        limit: Number(c.req.query('limit') || 8),
        excludeSessionId: c.req.query('exclude') || undefined,
      })),
    })
  })

  app.get('/workspaces/:workspaceId/history/read', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    if (!(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
    const kind = c.req.query('kind')
    const id = c.req.query('id')
    if ((kind !== 'chat' && kind !== 'plan') || !id) return c.json({ error: 'kind and id are required' }, 400)
    if (kind === 'plan') {
      const plan = await readWorkspacePlan(id, { workspaceId })
      return plan ? c.json(plan) : c.json({ error: 'Not found' }, 404)
    }
    const transcript = await renderWorkspaceTranscript(id, {
      workspaceId,
      from: Number(c.req.query('from') || 0),
      limit: Number(c.req.query('limit') || 100),
    })
    return transcript ? c.json(transcript) : c.json({ error: 'Not found' }, 404)
  })

  app.get('/chat-sessions/:chatSessionId/transcript', async (c) => {
    const chatSessionId = c.req.param('chatSessionId')
    const workspaceId = c.req.query('workspaceId')
    if (!workspaceId || !(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
    const transcript = await renderWorkspaceTranscript(chatSessionId, {
      workspaceId,
      from: Number(c.req.query('from') || 0),
      limit: Number(c.req.query('limit') || 100),
    })
    return transcript ? c.json(transcript) : c.json({ error: 'Not found' }, 404)
  })

  app.post('/plans', async (c) => {
    // `workspaceId`/`projectId` are read from the QUERY string (not just the
    // body) so `resolveWorkspaceIdForRequest` can home-region-route this write
    // via its normal path/query resolution (steps 2/5b) *before* the body is
    // read/proxied. The router deliberately never reads the body — a body-only
    // workspaceId falls through to "handle locally", which is wrong here since
    // this route can UPDATE an existing row (upsert-by-filename), not just
    // create one. Callers (see `postPlanMirror`) must send both as query params.
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.filename !== 'string' || typeof body.content !== 'string') return c.json({ error: 'filename and content are required' }, 400)
    const projectId = c.req.query('projectId') || (typeof body.projectId === 'string' ? body.projectId : undefined)
    const workspaceId = c.req.query('workspaceId') || (typeof body.workspaceId === 'string'
      ? body.workspaceId
      : projectId
        ? (await (prisma as any).project.findUnique({ where: { id: projectId }, select: { workspaceId: true } }))?.workspaceId ?? null
        : null)
    if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const where = { projectId: projectId ?? null, filename: body.filename }
    const existing = await (prisma as any).plan.findFirst({ where })
    const data = {
      workspaceId,
      projectId: projectId ?? null,
      chatSessionId: typeof body.chatSessionId === 'string' ? body.chatSessionId : null,
      runtimeKey: typeof body.runtimeKey === 'string' ? body.runtimeKey : null,
      filename: body.filename,
      name: typeof body.name === 'string' ? body.name : body.filename,
      overview: typeof body.overview === 'string' ? body.overview : '',
      status: typeof body.status === 'string' ? body.status : 'pending',
      content: body.content,
      ...(body.createdAt ? { createdAt: new Date(String(body.createdAt)) } : {}),
    }
    const plan = existing
      ? await (prisma as any).plan.update({ where: { id: existing.id }, data })
      : await (prisma as any).plan.create({ data })
    return c.json(plan)
  })

  app.delete('/plans', async (c) => {
    // See the POST /plans comment above: workspaceId/projectId must come from
    // the query string for the home-region router to resolve this write.
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.filename !== 'string') return c.json({ error: 'filename is required' }, 400)
    const projectId = c.req.query('projectId') || (typeof body.projectId === 'string' ? body.projectId : undefined)
    const workspaceId = c.req.query('workspaceId') || (typeof body.workspaceId === 'string'
      ? body.workspaceId
      : projectId
        ? (await (prisma as any).project.findUnique({ where: { id: projectId }, select: { workspaceId: true } }))?.workspaceId ?? null
        : null)
    if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const existing = await (prisma as any).plan.findFirst({ where: { projectId: projectId ?? null, filename: body.filename } })
    if (existing) await (prisma as any).plan.delete({ where: { id: existing.id } })
    return c.json({ deleted: Boolean(existing) })
  })

  app.post('/workspaces/:workspaceId/sessions/:sessionId/members', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const sessionId = c.req.param('sessionId')
    const identity = await authorizeWorkspaceRuntimeRequest(c, workspaceId)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const body = await c.req.json().catch(() => ({}))
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    const projectId = typeof body?.projectId === 'string' ? body.projectId : ''
    if (!userId || !projectId) return c.json({ error: 'userId and projectId are required' }, 400)
    const projects = await accessibleWorkspaceProjects(workspaceId, userId)
    const project = projects.find((row) => row.id === projectId)
    if (!project) return c.json({ error: 'Project is not accessible in this workspace' }, 403)

    try {
      const attachedRow = await attachProject(
        sessionId,
        projectId,
        body?.attachMode === 'readonly' ? 'readonly' : 'readwrite',
      )
      const attached = await getAttachedProjects(sessionId)
      const attachedIds = attached.map((row) => row.projectId)
      const readonlyIds = attached.filter((row) => row.attachMode === 'readonly').map((row) => row.projectId)
      const hostPath = resolvePath(process.env.WORKSPACES_DIR || resolvePath(process.cwd(), 'workspaces'), projectId)
      const { body: runtimeBody } = await workspaceRuntimeMemberCall(
        workspaceId,
        attachedIds,
        '/internal/workspace/members',
        {
          method: 'POST',
          body: JSON.stringify({
            id: project.id,
            name: project.name,
            description: project.description,
            readonly: attachedRow.attachMode === 'readonly',
          }),
        },
        {
          readonlyProjectIds: readonlyIds,
          hostRealPath: hostPath,
        },
      )
      return c.json({ ok: true, attached: attachedRow, project, runtime: runtimeBody })
    } catch (error: any) {
      return c.json({ error: error?.message ?? 'mount failed' }, 502)
    }
  })

  app.delete('/workspaces/:workspaceId/sessions/:sessionId/members/:projectId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const sessionId = c.req.param('sessionId')
    const projectId = c.req.param('projectId')
    const identity = await authorizeWorkspaceRuntimeRequest(c, workspaceId)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    const body = await c.req.json().catch(() => ({}))
    const userId = typeof body?.userId === 'string' ? body.userId : ''
    if (!userId) return c.json({ error: 'userId is required' }, 400)
    const accessible = await accessibleWorkspaceProjects(workspaceId, userId)
    if (!accessible.some((project) => project.id === projectId)) {
      return c.json({ error: 'Project is not accessible in this workspace' }, 403)
    }
    try {
      const removed = await detachProject(sessionId, projectId)
      const attached = await getAttachedProjects(sessionId)
      const attachedIds = attached.map((row) => row.projectId)
      const readonlyIds = attached.filter((row) => row.attachMode === 'readonly').map((row) => row.projectId)
      const { body: runtimeBody } = await workspaceRuntimeMemberCall(
        workspaceId,
        attachedIds,
        `/internal/workspace/members/${encodeURIComponent(projectId)}`,
        { method: 'DELETE', body: JSON.stringify({}) },
      )
      return c.json({ ok: true, removed, runtime: runtimeBody })
    } catch (error: any) {
      return c.json({ error: error?.message ?? 'unmount failed' }, 502)
    }
  })

  // GET /projects/:projectId/trust — see ./internal-project-trust.ts
  app.route('/', projectTrustRoutes({ authorize: validateAuth }))

  /**
   * POST /api/internal/projects/:projectId/checkpoints/record
   *   body: { commitSha, commitMessage, branch, filesChanged, additions,
   *           deletions, isAutomatic? }
   *
   * Called by the agent-runtime pod after each local commit in the pod-owned
   * `git_only` model. The pod owns the durable repo (it persists `.git` to
   * object storage) and no longer pushes to an API origin, so the legacy
   * post-receive hook can't write the `ProjectCheckpoint` row. The pod
   * computes the commit metadata locally and hands it to us; we insert the
   * row, idempotent on `commitSha`.
   *
   * Auth: K8s SA token (cluster) OR `x-runtime-token` (local desktop).
   */
  app.post('/projects/:projectId/checkpoints/record', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) return c.json({ error: 'Missing projectId' }, 400)

    if (!(await validateAuth(c, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const commitSha = typeof body.commitSha === 'string' ? body.commitSha : null
    if (!commitSha || !/^[0-9a-f]{7,64}$/i.test(commitSha)) {
      return c.json({ error: 'Valid commitSha is required' }, 400)
    }

    try {
      // Idempotent on (projectId, commitSha) — a re-delivered record (pod retry,
      // warm-pool race) must not create a duplicate row. Shared with the publish
      // flow via checkpoint.service so both paths dedupe identically.
      const result = await recordCheckpointForCommit(projectId, commitSha, {
        commitMessage: typeof body.commitMessage === 'string' ? body.commitMessage : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        filesChanged: numberOr(body.filesChanged, 0),
        additions: numberOr(body.additions, 0),
        deletions: numberOr(body.deletions, 0),
        isAutomatic: body.isAutomatic !== false,
      })
      if (!result) {
        return c.json({ error: 'Valid commitSha is required' }, 400)
      }
      return c.json({ ok: true, id: result.id, ...(result.deduped && { deduped: true }) })
    } catch (err: any) {
      console.error(`[Internal] Failed to record checkpoint for ${projectId}:`, err.message)
      return c.json({ error: 'Failed to record checkpoint' }, 500)
    }
  })

  /**
   * GET /api/internal/projects/:projectId/github/cli-credentials
   *
   * Mints a short-lived installation token so the project runtime can run
   * `gh` and `git commit` as the GitHub App bot. The token is returned to
   * the runtime only — never written to the workspace or logs.
   */
  app.get('/projects/:projectId/github/cli-credentials', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) return c.json({ error: 'Missing projectId' }, 400)
    if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    try {
      if (!loadGitHub) {
        return c.json(
          {
            error: {
              code: 'github_app_not_installed',
              message: 'GitHub App credentials are not available on this runtime.',
            },
          },
          409,
        )
      }
      const github = await loadGitHub()
      const credentials = await github.getProjectGitHubCliCredentials(projectId)
      if (!credentials) {
        return c.json(
          {
            error: {
              code: 'github_app_not_installed',
              message: 'This project has no GitHub App connection.',
            },
          },
          409,
        )
      }
      return c.json({ ok: true, ...credentials })
    } catch (err: any) {
      console.error(`[Internal] GitHub CLI credentials for ${projectId} failed:`, err?.message ?? err)
      return c.json({ error: 'Failed to mint GitHub App credentials' }, 502)
    }
  })

  /**
   * POST /api/internal/projects/:projectId/github/pull-request
   *   body: { title, head, base?, body?, draft?, runId? }
   *
   * Creates a PR with the Shogo GitHub App installation token. GitHub then
   * attributes the PR to the App's bot account instead of the user's token.
   * The project connection is used as the authoritative repository target.
   */
  app.post('/projects/:projectId/github/pull-request', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) return c.json({ error: 'Missing projectId' }, 400)
    if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const head = typeof body?.head === 'string' ? body.head.trim() : ''
    const base = typeof body?.base === 'string' ? body.base.trim() : ''
    const prBody = typeof body?.body === 'string' ? body.body : ''
    const runId = typeof body?.runId === 'string' ? body.runId.trim() : ''
    if (!title || !head) {
      return c.json({ error: 'title and head are required' }, 400)
    }
    if (runId && !/^[a-zA-Z0-9_-]+$/.test(runId)) {
      return c.json({ error: 'runId contains invalid characters' }, 400)
    }

    try {
      if (!loadGitHub) {
        return c.json(
          {
            error: {
              code: 'github_app_not_installed',
              message: 'GitHub App PR creation is not available on this runtime.',
            },
          },
          409,
        )
      }
      const github = await loadGitHub()
      const connection = await github.getConnection(projectId)
      const installationId = connection?.installationId
      if (!connection || typeof installationId !== 'number' || !Number.isInteger(installationId)) {
        return c.json(
          {
            error: {
              code: 'github_app_not_installed',
              message: 'This project has no GitHub App connection for bot-authored PRs.',
            },
          },
          409,
        )
      }

      const markedBody = runId && !github.extractRunId(prBody)
        ? `${withShogoPrFooter(prBody)}\n\n${github.runIdMarker(runId)}`
        : withShogoPrFooter(prBody)
      const result = await github.createPullRequest({
        installationId,
        repoOwner: connection.repoOwner,
        repoName: connection.repoName,
        head,
        base: base || connection.defaultBranch || 'main',
        title,
        body: markedBody,
        draft: body?.draft === true,
      })
      return c.json({
        ok: true,
        number: result.number,
        url: result.html_url,
        htmlUrl: result.html_url,
        author: `${process.env.GH_APP_SLUG || 'shogo-ai'}[bot]`,
      })
    } catch (err: any) {
      console.error(`[Internal] GitHub PR creation for ${projectId} failed:`, err?.message ?? err)
      return c.json({ error: 'Failed to create pull request' }, 502)
    }
  })

  /**
   * GET  /api/internal/projects/:projectId/checkpoints                  — list
   * GET  /api/internal/projects/:projectId/checkpoints/:checkpointId    — detail
   * GET  /api/internal/projects/:projectId/checkpoints/:checkpointId/diff — diff vs HEAD
   * POST /api/internal/projects/:projectId/checkpoints/:checkpointId/rollback
   *
   * Cluster-internal mirror of the public checkpoint routes so the agent-runtime
   * pod can let the agent SEE and USE the existing auto-checkpoint/rollback
   * system (fixes the "no git history" lie + hand-reverts). Auth: K8s SA token
   * (cluster) OR `x-runtime-token` (local desktop). Folder-linked (external)
   * projects return a typed 409 the agent surfaces gracefully.
   */
  app.get('/projects/:projectId/checkpoints', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) return c.json({ error: 'Missing projectId' }, 400)
    if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    try {
      const project = await loadProjectForCheckpoints(projectId)
      if (!project) return c.json({ error: 'Project not found' }, 404)
      if ((project as any).workingMode === 'external') return externalModeResponse(c)

      const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100)
      const checkpoints = await listCheckpointsSvc(projectId, { limit })
      return c.json({ ok: true, checkpoints })
    } catch (err: any) {
      console.error(`[Internal] checkpoint list for ${projectId} failed:`, err.message)
      return c.json({ error: 'Failed to list checkpoints' }, 500)
    }
  })

  app.get('/projects/:projectId/checkpoints/:checkpointId', async (c) => {
    const projectId = c.req.param('projectId')
    const checkpointId = c.req.param('checkpointId')
    if (!projectId || !checkpointId) return c.json({ error: 'Missing params' }, 400)
    if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    try {
      const project = await loadProjectForCheckpoints(projectId)
      if (!project) return c.json({ error: 'Project not found' }, 404)
      if ((project as any).workingMode === 'external') return externalModeResponse(c)

      const checkpoint = await getCheckpointSvc(checkpointId)
      if (!checkpoint) return c.json({ error: 'Checkpoint not found' }, 404)
      return c.json({ ok: true, checkpoint })
    } catch (err: any) {
      console.error(`[Internal] checkpoint get for ${projectId} failed:`, err.message)
      return c.json({ error: 'Failed to get checkpoint' }, 500)
    }
  })

  app.get('/projects/:projectId/checkpoints/:checkpointId/diff', async (c) => {
    const projectId = c.req.param('projectId')
    const checkpointId = c.req.param('checkpointId')
    if (!projectId || !checkpointId) return c.json({ error: 'Missing params' }, 400)
    if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    try {
      const project = await loadProjectForCheckpoints(projectId)
      if (!project) return c.json({ error: 'Project not found' }, 404)
      if ((project as any).workingMode === 'external') return externalModeResponse(c)

      const workspacePath = internalWorkspacePath(projectId)
      await hydrateRepo(projectId, workspacePath).catch((err) =>
        console.warn(`[Internal] hydrate for ${projectId} failed:`, err?.message ?? err),
      )
      const diff = await getDiffSvc(workspacePath, checkpointId, c.req.query('to'))
      if (!diff) return c.json({ error: 'Checkpoint not found' }, 404)
      return c.json({ ok: true, diff })
    } catch (err: any) {
      console.error(`[Internal] checkpoint diff for ${projectId} failed:`, err.message)
      return c.json({ error: 'Failed to get diff' }, 500)
    }
  })

  app.post('/projects/:projectId/checkpoints/:checkpointId/rollback', async (c) => {
    const projectId = c.req.param('projectId')
    const checkpointId = c.req.param('checkpointId')
    if (!projectId || !checkpointId) return c.json({ error: 'Missing params' }, 400)
    if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

    try {
      const project = await loadProjectForCheckpoints(projectId)
      if (!project) return c.json({ error: 'Project not found' }, 404)
      if ((project as any).workingMode === 'external') return externalModeResponse(c)

      const body = (await c.req.json().catch(() => ({}))) as { includeDatabase?: boolean }
      const workspacePath = internalWorkspacePath(projectId)
      await hydrateRepo(projectId, workspacePath).catch((err) =>
        console.warn(`[Internal] hydrate for ${projectId} failed:`, err?.message ?? err),
      )
      const result = await rollbackSvc({
        projectId,
        workspacePath,
        checkpointId,
        includeDatabase: body.includeDatabase === true,
        createdBy: 'agent',
      })
      if (!result.success) {
        return c.json({ error: result.error || 'Rollback failed' }, 400)
      }
      return c.json({
        ok: true,
        rolledBackTo: result.previousCheckpoint,
        newCheckpoint: result.newCheckpoint,
      })
    } catch (err: any) {
      console.error(`[Internal] checkpoint rollback for ${projectId} failed:`, err.message)
      return c.json({ error: 'Failed to rollback' }, 500)
    }
  })

  /**
   * POST /api/internal/chat-sessions/:chatSessionId/worktree
   *   body: { worktreeBranch?, worktreeStatus?, worktreePath? }
   *
   * BETA: per-chat git worktrees. Called by the agent-runtime pod to mirror a
   * chat's worktree lifecycle (active / merging / merged) into the product DB so
   * the UI can render the branch chip and merge state across reloads. Auth is
   * validated against the chat session's owning project.
   *
   * Auth: K8s SA token (cluster) OR `x-runtime-token` (local desktop).
   */
  app.post('/chat-sessions/:chatSessionId/worktree', async (c) => {
    const chatSessionId = c.req.param('chatSessionId')
    if (!chatSessionId) return c.json({ error: 'Missing chatSessionId' }, 400)

    const { prisma } = await import('../lib/prisma')
    const session = await prisma.chatSession.findUnique({
      where: { id: chatSessionId },
      select: { id: true, contextId: true, contextType: true },
    })
    if (!session) return c.json({ error: 'Chat session not found' }, 404)

    // Project-scoped chats carry the project id on contextId; validate against it.
    const projectId = session.contextType === 'project' ? session.contextId ?? undefined : undefined
    if (!(await validateAuth(c, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const data: Record<string, string | null> = {}
    if ('worktreeBranch' in body) data.worktreeBranch = typeof body.worktreeBranch === 'string' ? body.worktreeBranch : null
    if ('worktreePath' in body) data.worktreePath = typeof body.worktreePath === 'string' ? body.worktreePath : null
    if ('worktreeStatus' in body) {
      const s = body.worktreeStatus
      data.worktreeStatus = (s === 'active' || s === 'merging' || s === 'merged') ? s : null
    }

    try {
      await prisma.chatSession.update({ where: { id: chatSessionId }, data: data as any })
      return c.json({ ok: true })
    } catch (err: any) {
      console.error(`[Internal] Failed to update worktree status for ${chatSessionId}:`, err.message)
      return c.json({ error: 'Failed to update worktree status' }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // Project lifecycle — create / attach / configure / call
  //
  // Backs the agent runtime's `project_*` and `system_apply` tools
  // (packages/agent-runtime/src/project-tools.ts). A runtime token is a
  // project- or workspace-scoped capability, so every route below resolves the
  // caller's workspace from its identity and refuses to touch projects outside
  // it. Cluster SA callers are unrestricted but must name the acting user.
  // ---------------------------------------------------------------------------

  /** Workspace the authenticated identity is allowed to act in (null for SA). */
  async function identityWorkspaceId(identity: InternalIdentity): Promise<string | null> {
    if (identity.kind === 'workspace') return identity.workspaceId
    if (identity.kind === 'project') {
      const { resolveProjectWorkspaceId } = await import('../lib/project-runtime-token')
      return (await resolveProjectWorkspaceId(identity.projectId)) ?? null
    }
    return null
  }

  /**
   * Authorize a project-scoped lifecycle call: SA passes; a runtime token must
   * belong to the same workspace as `projectId`. Returns the project's
   * workspace id so the handler can reuse it.
   */
  async function authorizeLifecycleProject(
    c: Context,
    projectId: string,
  ): Promise<{ identity: InternalIdentity; workspaceId: string } | null> {
    const identity = await authenticate(c)
    if (!identity) return null
    const project = (await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })) as { workspaceId: string } | null
    if (!project) return null
    if (identity.kind === 'sa') return { identity, workspaceId: project.workspaceId }
    const scope = await identityWorkspaceId(identity)
    if (scope !== project.workspaceId) {
      logAuthReject(`lifecycle_workspace_mismatch tokenWorkspace=${scope ?? 'none'}`, projectId)
      return null
    }
    return { identity, workspaceId: project.workspaceId }
  }

  /**
   * Resolve the user a lifecycle write is attributed to. Prefer the explicit
   * `userId` the runtime forwards from the chat request; fall back to the
   * calling project's creator for heartbeat-triggered turns that have no user.
   *
   * A merged-root (universal workspace) runtime authenticates with a workspace
   * token, so there is no calling project to inherit from — attribute the write
   * to the workspace's owner instead. Without this every `system_apply` /
   * `project_create` from such a runtime 400s with `userId is required`, which
   * breaks the `harness` anchor and any other multi-project assembly.
   */
  async function resolveActingUserId(identity: InternalIdentity, requested: unknown): Promise<string | null> {
    if (typeof requested === 'string' && requested.length > 0) return requested
    if (identity.kind === 'project') {
      const row = (await prisma.project.findUnique({
        where: { id: identity.projectId },
        select: { createdBy: true },
      })) as { createdBy: string | null } | null
      return row?.createdBy ?? null
    }
    if (identity.kind === 'workspace') {
      const owner = await prisma.member.findFirst({
        where: { workspaceId: identity.workspaceId, role: 'owner' },
        select: { userId: true },
        orderBy: { createdAt: 'asc' },
      })
      return owner?.userId ?? null
    }
    return null
  }

  function lifecycleErrorResponse(c: Context, err: unknown): Response {
    const anyErr = err as { name?: string; code?: string; message?: string }
    if (anyErr?.name === 'ProjectLifecycleError') {
      const status =
        anyErr.code === 'unauthorized' ? 401
        : anyErr.code === 'forbidden' ? 403
        : anyErr.code === 'not_found' ? 404
        : anyErr.code === 'instance_too_small' ? 402
        : anyErr.code === 'paywall' ? 402
        : 400
      return c.json({ error: { code: anyErr.code, message: anyErr.message } }, status)
    }
    if (anyErr?.name === 'ProjectAttachmentError') {
      const status =
        anyErr.code === 'project_not_found' ? 404 : anyErr.code === 'self_attach' ? 400 : 409
      return c.json({ error: { code: anyErr.code, message: anyErr.message } }, status)
    }
    console.error('[Internal] project lifecycle error:', anyErr?.message ?? err)
    return c.json({ error: { code: 'internal_error', message: 'Project lifecycle operation failed' } }, 500)
  }

  /**
   * GET /api/internal/workspaces/:workspaceId/projects/graph
   *
   * Every project in the workspace with its attachment edges and agent config —
   * the live state `system_apply` diffs a manifest against.
   */
  app.get('/workspaces/:workspaceId/projects/graph', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    if (!(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
    const lifecycleSvc = await loadProjectLifecycle?.()
    if (!lifecycleSvc) return unavailable(c, 'Project lifecycle')
    const { listWorkspaceProjectsWithAttachments } = lifecycleSvc
    return c.json({ workspaceId, projects: await listWorkspaceProjectsWithAttachments(workspaceId) })
  })

  /**
   * POST /api/internal/workspaces/:workspaceId/projects
   *   body: { name, description?, techStackId?, workingMode?, templateId?, settings?, hidden?, userId? }
   *
   * Create a project on behalf of a user. Goes through the same hooks as the
   * public generated route, so membership, tier normalization and AgentConfig
   * seeding are identical.
   */
  app.post('/workspaces/:workspaceId/projects', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const identity = await authenticate(c)
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    if (identity.kind !== 'sa') {
      const scope = await identityWorkspaceId(identity)
      if (scope !== workspaceId) {
        logAuthReject(`lifecycle_workspace_mismatch tokenWorkspace=${scope ?? 'none'} path=${workspaceId}`)
        return c.json({ error: 'Unauthorized' }, 401)
      }
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.name !== 'string') {
      return c.json({ error: { code: 'bad_request', message: 'name is required' } }, 400)
    }
    const actingUserId = await resolveActingUserId(identity, body.userId)
    if (!actingUserId) {
      return c.json({ error: { code: 'bad_request', message: 'userId is required' } }, 400)
    }

    try {
      const lifecycleSvc = await loadProjectLifecycle?.()
      if (!lifecycleSvc) return unavailable(c, 'Project lifecycle')
      const { createProjectInWorkspace } = lifecycleSvc
      const project = await createProjectInWorkspace({
        workspaceId,
        actingUserId,
        name: body.name,
        description: typeof body.description === 'string' ? body.description : undefined,
        techStackId: typeof body.techStackId === 'string' ? body.techStackId : undefined,
        workingMode: body.workingMode === 'external' ? 'external' : body.workingMode === 'managed' ? 'managed' : undefined,
        templateId: typeof body.templateId === 'string' ? body.templateId : undefined,
        hidden: body.hidden === true,
        settings: body.settings && typeof body.settings === 'object' ? (body.settings as Record<string, unknown>) : undefined,
      })
      return c.json({ ok: true, project }, 201)
    } catch (err) {
      return lifecycleErrorResponse(c, err)
    }
  })

  /** GET /api/internal/projects/:projectId/attachments — durable anchor → attached edges. */
  app.get('/projects/:projectId/attachments', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const { listAttachments } = await import('../services/project-attachment.service')
    return c.json({ projectId, attachments: await listAttachments(projectId) })
  })

  /**
   * POST /api/internal/projects/:projectId/attachments
   *   body: { attachedProjectId, attachMode?: 'readwrite' | 'readonly' }
   *
   * Record a durable `ProjectAttachment` and re-sync the anchor's pinned
   * workspace session. Unlike the public route this never restarts the anchor
   * runtime — the caller usually IS the anchor runtime. It attempts a live
   * mount through the workspace-runtime member path and reports `mounted`;
   * when that isn't possible the attachment takes effect on the next start.
   */
  app.post('/projects/:projectId/attachments', async (c) => {
    const projectId = c.req.param('projectId')
    const authz = await authorizeLifecycleProject(c, projectId)
    if (!authz) return c.json({ error: 'Unauthorized' }, 401)

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.attachedProjectId !== 'string') {
      return c.json({ error: { code: 'bad_request', message: 'attachedProjectId is required' } }, 400)
    }
    const attachMode = body.attachMode === 'readonly' ? 'readonly' : 'readwrite'

    try {
      const svc = await import('../services/project-attachment.service')
      const attachment = await svc.attachProjectToProject(projectId, body.attachedProjectId, attachMode)

      let mounted = false
      try {
        const pinned = await svc.getOrCreatePinnedWorkspaceSession(projectId)
        const attached = await getAttachedProjects(pinned.id)
        const attachedIds = attached.map((row) => row.projectId)
        const readonlyIds = attached.filter((row) => row.attachMode === 'readonly').map((row) => row.projectId)
        const target = (await prisma.project.findUnique({
          where: { id: body.attachedProjectId },
          select: { id: true, name: true, description: true },
        })) as { id: string; name: string; description: string | null } | null
        if (target) {
          await workspaceRuntimeMemberCall(
            authz.workspaceId,
            attachedIds,
            '/internal/workspace/members',
            {
              method: 'POST',
              body: JSON.stringify({
                id: target.id,
                name: target.name,
                description: target.description ?? undefined,
                readonly: attachMode === 'readonly',
              }),
            },
            {
              readonlyProjectIds: readonlyIds,
              hostRealPath: resolvePath(process.env.WORKSPACES_DIR || resolvePath(process.cwd(), 'workspaces'), target.id),
            },
          )
          mounted = true
        }
      } catch (mountErr: any) {
        console.warn(`[Internal] live mount of ${body.attachedProjectId} into ${projectId} skipped: ${mountErr?.message ?? mountErr}`)
      }

      return c.json({ ok: true, attachment, mounted }, 201)
    } catch (err) {
      return lifecycleErrorResponse(c, err)
    }
  })

  /** DELETE /api/internal/projects/:projectId/attachments/:attachedProjectId */
  app.delete('/projects/:projectId/attachments/:attachedProjectId', async (c) => {
    const projectId = c.req.param('projectId')
    const attachedProjectId = c.req.param('attachedProjectId')
    if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const { detachProjectFromProject } = await import('../services/project-attachment.service')
      const removed = await detachProjectFromProject(projectId, attachedProjectId)
      return c.json({ ok: true, removed })
    } catch (err) {
      return lifecycleErrorResponse(c, err)
    }
  })

  /** GET /api/internal/projects/:projectId/config — agent-facing config snapshot. */
  app.get('/projects/:projectId/config', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const lifecycleSvc = await loadProjectLifecycle?.()
      if (!lifecycleSvc) return unavailable(c, 'Project lifecycle')
      const { readProjectConfig } = lifecycleSvc
      return c.json({ ok: true, project: await readProjectConfig(projectId) })
    } catch (err) {
      return lifecycleErrorResponse(c, err)
    }
  })

  /**
   * PATCH /api/internal/projects/:projectId/config
   *   body: { name?, description?, settings?, slackEnabled?, agent?: { heartbeat*, model*, quietHours* } }
   */
  app.patch('/projects/:projectId/config', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
    try {
      const lifecycleSvc = await loadProjectLifecycle?.()
      if (!lifecycleSvc) return unavailable(c, 'Project lifecycle')
      const { configureProject } = lifecycleSvc
      const project = await configureProject(projectId, {
        name: typeof body.name === 'string' ? body.name : undefined,
        description: typeof body.description === 'string' || body.description === null ? (body.description as string | null) : undefined,
        settings: body.settings && typeof body.settings === 'object' ? (body.settings as Record<string, unknown>) : undefined,
        slackEnabled: typeof body.slackEnabled === 'boolean' ? body.slackEnabled : undefined,
        agent: body.agent && typeof body.agent === 'object' ? (body.agent as any) : undefined,
      })
      return c.json({ ok: true, project })
    } catch (err) {
      return lifecycleErrorResponse(c, err)
    }
  })

  /**
   * POST /api/internal/projects/:projectId/agent-call
   *   body: { message, runId?, sessionId?, wait?, timeoutMs?, callerProjectId? }
   *
   * Invoke another project's agent from a runtime. Resolves the target the same
   * way the public agent-proxy does (pinned Instance tunnel first, then cloud
   * pod / host runtime) and forwards to the runtime's `/agent/pipeline/call`,
   * which is guarded by the runtime token alone — workspace runtimes are never
   * given a `WEBHOOK_TOKEN`, so the external `/agent/hooks/*` path can't be
   * reused here. `wait=true` blocks for the reply (bounded by `timeoutMs`,
   * default 5 min, max 20 min); otherwise the runtime acks with 202.
   */
  app.post('/projects/:projectId/agent-call', async (c) => {
    const projectId = c.req.param('projectId')
    const authz = await authorizeLifecycleProject(c, projectId)
    if (!authz) return c.json({ error: 'Unauthorized' }, 401)

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: { code: 'bad_request', message: 'message is required' } }, 400)
    }
    const callerProjectId =
      typeof body.callerProjectId === 'string'
        ? body.callerProjectId
        : authz.identity.kind === 'project' ? authz.identity.projectId : undefined

    const agentCallSvc = await loadAgentCall?.()
    if (!agentCallSvc) return unavailable(c, 'Cross-project agent calls')
    const { callProjectAgent } = agentCallSvc
    const outcome = await callProjectAgent(c, projectId, authz.workspaceId, {
      message: body.message,
      runId: typeof body.runId === 'string' ? body.runId : undefined,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      wait: body.wait !== false,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      callerProjectId,
    })
    return c.json(outcome.body, outcome.status as any)
  })

  /**
   * GET /api/internal/projects/:projectId/agent-call/:callId
   *
   * Poll an asynchronously accepted cross-project agent call. `waitMs` is
   * bounded by the service so callers can reconnect frequently without
   * holding an edge request open for the entire agent turn.
   */
  app.get('/projects/:projectId/agent-call/:callId', async (c) => {
    const projectId = c.req.param('projectId')
    const callId = c.req.param('callId')
    const authz = await authorizeLifecycleProject(c, projectId)
    if (!authz) return c.json({ error: 'Unauthorized' }, 401)

    const waitMsRaw = Number(c.req.query('waitMs') ?? 0)
    const waitMs = Number.isFinite(waitMsRaw) ? waitMsRaw : 0
    const agentCallSvc = await loadAgentCall?.()
    if (!agentCallSvc) return unavailable(c, 'Cross-project agent calls')
    const outcome = await agentCallSvc.getProjectAgentCall(
      c,
      projectId,
      authz.workspaceId,
      callId,
      waitMs,
    )
    return c.json(outcome.body, outcome.status as any)
  })
  return app
}
