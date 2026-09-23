// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Workspace agent profile, goals, and activity routes.
 *
 * These are UNIVERSAL workspace primitives (not personal-only): any
 * workspace runtime can read/update its agent profile and log/query goals.
 * Personal workspaces are simply the first (and currently only) product
 * surface that renders them.
 *
 * This single router implementation is mounted TWICE with different
 * authorization strategies, so the request contract (validation, status
 * codes, response shape) cannot drift between the two callers:
 *   - `server.ts`, under `/api`, for the authenticated web/mobile client
 *     (`sessionAuthorize`: session/API-key user + workspace membership).
 *   - `internal.ts`, under `/api/internal`, for the agent runtime pod
 *     (`authorizeWorkspaceScope`: pod token or workspace/SA identity).
 */

import { Hono } from 'hono'
import { hasWorkspaceAccess } from '../services/workspace.service'
import {
  AgentScheduleError,
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
} from '../services/agent-schedule.service'
import {
  createGoal,
  createGoalEvent,
  getGoal,
  getOrCreateAgentProfile,
  isGoalEventKind,
  isGoalStatus,
  listGoalEvents,
  listGoals,
  listWorkspaceActivity,
  resolveGoalEventApproval,
  saveAgentAvatar as saveLocalAgentAvatar,
  updateAgentProfile,
  updateGoal,
  type GoalApprovalDecision,
} from '../services/workspace-agent.service'

export interface WorkspaceAgentAuthContext {
  workspaceId: string
  userId?: string
}

/**
 * Resolves + authorizes access to `:workspaceId` for the current request.
 * Returns the auth context to proceed, or a `Response` (401/403) to return
 * directly to the caller.
 */
export type WorkspaceAgentAuthorize = (
  c: any,
) => Promise<WorkspaceAgentAuthContext | Response>

export interface WorkspaceAgentRoutesConfig {
  authorize: WorkspaceAgentAuthorize
  saveAgentAvatar?: (workspaceId: string, imageBuffer: Buffer) => Promise<string>
}

/** Session-authenticated strategy: requires login + workspace membership. */
export function sessionAuthorize(
  resolveUserId: (c: any) => Promise<string | null>,
): WorkspaceAgentAuthorize {
  return async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await resolveUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    if (!(await hasWorkspaceAccess(workspaceId, userId))) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    }
    return { workspaceId, userId }
  }
}

export function workspaceAgentRoutes(config: WorkspaceAgentRoutesConfig): Hono {
  const router = new Hono()
  const { authorize } = config
  const saveAvatar = config.saveAgentAvatar ?? saveLocalAgentAvatar

  function scheduleError(c: any, error: unknown) {
    if (!(error instanceof AgentScheduleError)) throw error
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }

  router.get('/workspaces/:workspaceId/agent-profile', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({ profile: await getOrCreateAgentProfile(auth.workspaceId) })
  })

  router.patch('/workspaces/:workspaceId/agent-profile', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'invalid_body', message: 'Request body must be an object' } }, 400)
    }

    const changes: Parameters<typeof updateAgentProfile>[1] = {}
    for (const key of ['name', 'avatarUrl', 'tagline', 'personality', 'statusText'] as const) {
      if (!(key in body)) continue
      const value = body[key]
      if (value !== null && typeof value !== 'string') {
        return c.json({ error: { code: 'invalid_field', message: `${key} must be a string or null` } }, 400)
      }
      if (key === 'name' && typeof value !== 'string') {
        return c.json({ error: { code: 'invalid_field', message: 'name must be a string' } }, 400)
      }
      changes[key] = value as never
    }

    return c.json({ profile: await updateAgentProfile(auth.workspaceId, changes) })
  })

  /**
   * Upload a new agent avatar image (raw PNG/JPEG bytes) and set it as the
   * profile's `avatarUrl` in one call. Mirrors `POST /projects/:id/thumbnail`
   * in `routes/thumbnail.ts`. The agent runtime hits this via
   * `uploadAgentAvatar` in `internal-api.ts` when `agent_profile_set` is
   * called with `avatarImagePath` instead of a raw `avatarUrl`.
   */
  router.post('/workspaces/:workspaceId/agent-avatar', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth

    const body = await c.req.arrayBuffer()
    if (!body || body.byteLength === 0) {
      return c.json({ error: { code: 'empty_body', message: 'No image data' } }, 400)
    }

    const avatarUrl = await saveAvatar(auth.workspaceId, Buffer.from(body))
    return c.json({ profile: await updateAgentProfile(auth.workspaceId, { avatarUrl }) })
  })

  router.get('/workspaces/:workspaceId/goals', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const rawStatus = c.req.query('status')
    if (rawStatus !== undefined && !isGoalStatus(rawStatus)) {
      return c.json({ error: { code: 'invalid_status', message: 'Unknown goal status' } }, 400)
    }
    return c.json({ goals: await listGoals(auth.workspaceId, rawStatus as any) })
  })

  router.get('/workspaces/:workspaceId/goals/:goalId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const goal = await getGoal(auth.workspaceId, c.req.param('goalId'))
    if (!goal) return c.json({ error: { code: 'not_found', message: 'Goal not found' } }, 404)
    return c.json({ goal })
  })

  router.get('/workspaces/:workspaceId/goals/:goalId/events', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const goal = await getGoal(auth.workspaceId, c.req.param('goalId'))
    if (!goal) return c.json({ error: { code: 'not_found', message: 'Goal not found' } }, 404)
    return c.json({ events: await listGoalEvents(auth.workspaceId, goal.id) })
  })

  router.post('/workspaces/:workspaceId/goals', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ error: { code: 'invalid_body', message: 'title is required' } }, 400)
    }
    if (body.status !== undefined && !isGoalStatus(body.status)) {
      return c.json({ error: { code: 'invalid_status', message: 'Unknown goal status' } }, 400)
    }

    const goal = await createGoal(auth.workspaceId, {
      title: body.title.trim(),
      why: typeof body.why === 'string' ? body.why : null,
      status: body.status as any,
      plan: body.plan,
      deliverables: body.deliverables,
      nextCheckInAt: typeof body.nextCheckInAt === 'string' ? new Date(body.nextCheckInAt) : null,
    })
    return c.json({ goal }, 201)
  })

  router.patch('/workspaces/:workspaceId/goals/:goalId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'invalid_body', message: 'Request body must be an object' } }, 400)
    }
    if (body.status !== undefined && !isGoalStatus(body.status)) {
      return c.json({ error: { code: 'invalid_status', message: 'Unknown goal status' } }, 400)
    }

    const goal = await updateGoal(auth.workspaceId, c.req.param('goalId'), {
      title: typeof body.title === 'string' ? body.title.trim() : undefined,
      why: typeof body.why === 'string' || body.why === null ? body.why : undefined,
      status: body.status as any,
      plan: body.plan,
      deliverables: body.deliverables,
      nextCheckInAt: typeof body.nextCheckInAt === 'string' ? new Date(body.nextCheckInAt) : undefined,
      lastProgressAt: typeof body.lastProgressAt === 'string' ? new Date(body.lastProgressAt) : undefined,
    })
    if (!goal) return c.json({ error: { code: 'not_found', message: 'Goal not found' } }, 404)
    return c.json({ goal })
  })

  router.get('/workspaces/:workspaceId/schedules', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const goalId = c.req.query('goalId') || undefined
    return c.json({ schedules: await listSchedules(auth.workspaceId, goalId) })
  })

  router.post('/workspaces/:workspaceId/schedules', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const userId =
      auth.userId ||
      (typeof body?.userId === 'string' && body.userId.trim() ? body.userId.trim() : null)
    if (!userId) {
      return c.json({
        error: { code: 'invalid_body', message: 'userId is required for an internal schedule request' },
      }, 400)
    }
    if (!auth.userId && !(await hasWorkspaceAccess(auth.workspaceId, userId))) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    }
    if (
      !body ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      typeof body.prompt !== 'string' ||
      !body.prompt.trim() ||
      typeof body.cronExpression !== 'string' ||
      !body.cronExpression.trim()
    ) {
      return c.json({
        error: { code: 'invalid_body', message: 'name, prompt, and cronExpression are required' },
      }, 400)
    }
    if (body.goalId !== undefined && body.goalId !== null && typeof body.goalId !== 'string') {
      return c.json({ error: { code: 'invalid_field', message: 'goalId must be a string or null' } }, 400)
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'invalid_field', message: 'enabled must be a boolean' } }, 400)
    }
    try {
      const schedule = await createSchedule({
        workspaceId: auth.workspaceId,
        userId,
        goalId: body.goalId as string | null | undefined,
        name: body.name.trim().slice(0, 200),
        prompt: body.prompt.trim().slice(0, 10_000),
        cronExpression: body.cronExpression.trim(),
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        enabled: body.enabled as boolean | undefined,
      })
      return c.json({ schedule }, 201)
    } catch (error) {
      return scheduleError(c, error)
    }
  })

  router.patch('/workspaces/:workspaceId/schedules/:scheduleId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'invalid_body', message: 'Request body must be an object' } }, 400)
    }
    if (body.goalId !== undefined && body.goalId !== null && typeof body.goalId !== 'string') {
      return c.json({ error: { code: 'invalid_field', message: 'goalId must be a string or null' } }, 400)
    }
    for (const key of ['name', 'prompt', 'cronExpression', 'timezone'] as const) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || !body[key].trim())) {
        return c.json({ error: { code: 'invalid_field', message: `${key} must be a non-empty string` } }, 400)
      }
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'invalid_field', message: 'enabled must be a boolean' } }, 400)
    }
    try {
      const schedule = await updateSchedule(auth.workspaceId, c.req.param('scheduleId'), {
        goalId: body.goalId as string | null | undefined,
        name: typeof body.name === 'string' ? body.name.trim().slice(0, 200) : undefined,
        prompt: typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 10_000) : undefined,
        cronExpression: typeof body.cronExpression === 'string' ? body.cronExpression.trim() : undefined,
        timezone: typeof body.timezone === 'string' ? body.timezone.trim() : undefined,
        enabled: body.enabled as boolean | undefined,
      })
      if (!schedule) return c.json({ error: { code: 'not_found', message: 'Schedule not found' } }, 404)
      return c.json({ schedule })
    } catch (error) {
      return scheduleError(c, error)
    }
  })

  router.delete('/workspaces/:workspaceId/schedules/:scheduleId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const deleted = await deleteSchedule(auth.workspaceId, c.req.param('scheduleId'))
    if (!deleted) return c.json({ error: { code: 'not_found', message: 'Schedule not found' } }, 404)
    return c.json({ ok: true })
  })

  router.post('/workspaces/:workspaceId/goals/:goalId/events', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !isGoalEventKind(body.kind) || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({
        error: { code: 'invalid_body', message: 'kind and message are required' },
      }, 400)
    }

    const event = await createGoalEvent(auth.workspaceId, c.req.param('goalId'), {
      kind: body.kind,
      message: body.message.trim(),
      metadata: body.metadata,
    })
    if (!event) return c.json({ error: { code: 'not_found', message: 'Goal not found' } }, 404)
    return c.json({ event }, 201)
  })

  // Record the user's decision on a pending "Needs your OK" approval event.
  // Only meaningful for `kind: 'approval'` events — see
  // `resolveGoalEventApproval`'s doc comment for why this is a metadata
  // stamp rather than a dedicated column.
  router.post('/workspaces/:workspaceId/goals/:goalId/events/:eventId/resolve', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const decision = body?.decision
    if (decision !== 'approved' && decision !== 'declined') {
      return c.json({
        error: { code: 'invalid_body', message: "decision must be 'approved' or 'declined'" },
      }, 400)
    }
    const event = await resolveGoalEventApproval(
      auth.workspaceId,
      c.req.param('goalId'),
      c.req.param('eventId'),
      decision as GoalApprovalDecision,
    )
    if (!event) {
      return c.json({ error: { code: 'not_found', message: 'Pending approval not found' } }, 404)
    }
    return c.json({ event })
  })

  router.get('/workspaces/:workspaceId/activity', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const parsedLimit = Number(c.req.query('limit') || 100)
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200) : 100
    return c.json({ activity: await listWorkspaceActivity(auth.workspaceId, limit) })
  })

  return router
}
