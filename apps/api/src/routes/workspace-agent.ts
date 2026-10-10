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
import type { Permission } from '@shogo/authz'
import { decide, loadAccess, principalOf, resolveAgentActor, type AgentCaller, type Principal } from '../lib/authz'
import { ConversationError, resolveNotifyConversation, resolveNotifyThread } from '../services/conversation.service'
import { listActiveChatTurns } from '../services/chat-turn-state.service'
import {
  EventSubscriptionError,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listDeliveries,
  listSubscriptions,
  listTriggerTypes,
  redeliver,
  testSubscription,
  updateSubscription,
} from '../services/event-subscription.service'
import { findWorkspaceMember, getMemberWorkActivity } from '../services/engagement-analytics.service'
import {
  AgentScheduleError,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  runScheduleNow,
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
  /** Set by the internal mount. Session mounts identify the caller with `userId`. */
  identity?: AgentCaller
}

/**
 * Resolves + authorizes access to `:workspaceId` for the current request.
 * Returns the auth context to proceed, or a `Response` (401/403) to return
 * directly to the caller.
 */
export type WorkspaceAgentAuthorize = (
  c: any,
) => Promise<WorkspaceAgentAuthContext | Response>

/** Permission to create schedules that run as themselves (non-viewers). */
const SCHEDULE_CREATOR_PERMISSION: Permission = 'project:create'
/** Permission to manage schedules created by someone else. */
const SCHEDULE_ADMIN_PERMISSION: Permission = 'workspace.settings:manage'

/**
 * Internal (runtime) callers act on behalf of a user named in the request, so
 * their access is resolved as that user's session.
 */
function principalFor(c: any, userId: string): Principal {
  const auth = principalOf(c)
  return auth.userId === userId ? auth : { userId, via: 'session' }
}

async function userCan(c: any, workspaceId: string, userId: string, permission: Permission): Promise<boolean> {
  return (await loadAccess(principalFor(c, userId), { workspaceId })).permissions.has(permission)
}

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
    if (!(await userCan(c, workspaceId, userId, 'workspace:read'))) {
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
    if (error instanceof ConversationError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as any)
    }
    if (!(error instanceof AgentScheduleError)) throw error
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }

  function forbidden(c: any, message = 'No access to this workspace') {
    return c.json({ error: { code: 'forbidden', message } }, 403)
  }

  /**
   * Scheduled runs execute as the schedule's user (chat identity, billing,
   * integrations), so every schedule mutation must be attributed to a real
   * workspace member. The internal mount authenticates the runtime pod, not a
   * user, so it must name the acting user in the body.
   */
  async function resolveScheduleActor(
    c: any,
    auth: WorkspaceAgentAuthContext,
    claimedUserId: unknown,
  ): Promise<string | Response> {
    if (auth.userId) return auth.userId
    const claimed = claimedUserId && typeof claimedUserId === 'object' && 'userId' in claimedUserId
      ? (claimedUserId as { userId?: unknown }).userId
      : claimedUserId
    if (!auth.identity) {
      const userId = typeof claimed === 'string' && claimed.trim() ? claimed.trim() : null
      if (!userId) {
        return c.json({
          error: { code: 'invalid_body', message: 'userId is required for an internal schedule request' },
        }, 400)
      }
      if (!(await userCan(c, auth.workspaceId, userId, 'workspace:read'))) return forbidden(c)
      return userId
    }
    const actor = await resolveAgentActor(c, auth.identity, { workspaceId: auth.workspaceId, claimedUserId: claimed })
    if (actor?.principal.userId && !actor.unscoped) return actor.principal.userId
    if (actor?.unscoped) {
      return c.json({
        error: { code: 'invalid_body', message: 'userId is required for an internal schedule request' },
      }, 400)
    }
    return c.json(
      { error: { code: 'requester_required', message: 'A signed requester is required for this action' } },
      403,
    )
  }

  /** The actor may run an agent in this project. 404 when they cannot even see it. */
  async function requireProjectUpdate(c: any, userId: string, projectId: unknown): Promise<Response | null> {
    if (typeof projectId !== 'string' || !projectId) return null
    const principal = principalFor(c, userId)
    const access = await loadAccess(principal, { projectId })
    const decision = await decide(access, 'project:update', principal, `${c.req.method} ${c.req.path}`)
    if (decision.ok) return null
    return c.json({ error: { code: decision.code, message: decision.message } }, decision.status)
  }

  /** Only the schedule's creator or a workspace owner/admin may change it. */
  async function authorizeScheduleManagement(
    c: any,
    auth: WorkspaceAgentAuthContext,
    body: Record<string, unknown> | null,
  ): Promise<Response | null> {
    const actor = await resolveScheduleActor(c, auth, body)
    if (actor instanceof Response) return actor
    const existing = await getSchedule(auth.workspaceId, c.req.param('scheduleId'))
    if (!existing) return c.json({ error: { code: 'not_found', message: 'Schedule not found' } }, 404)
    if (
      existing.userId !== actor &&
      !(await userCan(c, auth.workspaceId, actor, SCHEDULE_ADMIN_PERMISSION))
    ) {
      return forbidden(c, 'Only the schedule creator or a workspace admin can change this schedule')
    }
    return null
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
    const userId = await resolveScheduleActor(c, auth, body)
    if (userId instanceof Response) return userId
    if (!(await userCan(c, auth.workspaceId, userId, SCHEDULE_CREATOR_PERMISSION))) {
      return forbidden(c, 'Viewers cannot create schedules')
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
      const notifyConversationId = await resolveNotifyConversation(auth.workspaceId, body.notifyConversationId, userId)
      const notifyThreadRootId = await resolveNotifyThread(notifyConversationId, body.notifyThreadRootId)
      const schedule = await createSchedule({
        workspaceId: auth.workspaceId,
        userId,
        goalId: body.goalId as string | null | undefined,
        name: body.name.trim().slice(0, 200),
        prompt: body.prompt.trim().slice(0, 10_000),
        cronExpression: body.cronExpression.trim(),
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        enabled: body.enabled as boolean | undefined,
        notifyConversationId,
        notifyThreadRootId,
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
    const denied = await authorizeScheduleManagement(c, auth, body)
    if (denied) return denied
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
      const actor = body.notifyConversationId === undefined ? null : await resolveScheduleActor(c, auth, body)
      if (actor instanceof Response) return actor
      const notifyConversationId = actor
        ? await resolveNotifyConversation(auth.workspaceId, body.notifyConversationId, actor)
        : undefined
      // A thread is checked against the channel it will live in: the new one, else the current one.
      let notifyThreadRootId: string | null | undefined
      if (body.notifyThreadRootId !== undefined || notifyConversationId !== undefined) {
        const current = notifyConversationId !== undefined
          ? notifyConversationId
          : (await getSchedule(auth.workspaceId, c.req.param('scheduleId')))?.notifyConversationId
        notifyThreadRootId = body.notifyThreadRootId === undefined ? undefined : await resolveNotifyThread(current, body.notifyThreadRootId)
      }
      const schedule = await updateSchedule(auth.workspaceId, c.req.param('scheduleId'), {
        notifyConversationId,
        notifyThreadRootId,
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

  // Run now: marks the schedule due; the dispatcher's next tick runs it.
  router.post('/workspaces/:workspaceId/schedules/:scheduleId/run', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const denied = await authorizeScheduleManagement(c, auth, body)
    if (denied) return denied
    try {
      const schedule = await runScheduleNow(auth.workspaceId, c.req.param('scheduleId'))
      if (!schedule) return c.json({ error: { code: 'not_found', message: 'Schedule not found' } }, 404)
      return c.json({ schedule }, 202)
    } catch (error) {
      return scheduleError(c, error)
    }
  })

  router.delete('/workspaces/:workspaceId/schedules/:scheduleId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const denied = await authorizeScheduleManagement(c, auth, body)
    if (denied) return denied
    const deleted = await deleteSchedule(auth.workspaceId, c.req.param('scheduleId'))
    if (!deleted) return c.json({ error: { code: 'not_found', message: 'Schedule not found' } }, 404)
    return c.json({ ok: true })
  })

  // ── Triggers (event subscriptions) ────────────────────────────────────
  // Agent and project triggers run as their owner, so like schedules every
  // mutation is attributed to a member; only the owner or an admin may change one.

  function triggerError(c: any, error: unknown) {
    if (error instanceof EventSubscriptionError || error instanceof ConversationError) {
      const details = error instanceof EventSubscriptionError ? error.details : undefined
      return c.json({ error: { code: error.code, message: error.message, ...(details ?? {}) } }, error.status as any)
    }
    throw error
  }

  async function authorizeTriggerManagement(
    c: any,
    auth: WorkspaceAgentAuthContext,
    body: Record<string, unknown> | null,
  ): Promise<{ actor: string; trigger: any } | Response> {
    const actor = await resolveScheduleActor(c, auth, body)
    if (actor instanceof Response) return actor
    const trigger = await getSubscription(auth.workspaceId, c.req.param('triggerId'))
    if (!trigger) return c.json({ error: { code: 'not_found', message: 'Trigger not found' } }, 404)
    if (trigger.ownerUserId !== actor && !(await userCan(c, auth.workspaceId, actor, SCHEDULE_ADMIN_PERMISSION))) {
      return forbidden(c, 'Only the trigger creator or a workspace admin can change this trigger')
    }
    return { actor, trigger }
  }

  router.get('/workspaces/:workspaceId/trigger-types', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const userId = await resolveScheduleActor(c, auth, auth.userId || c.req.query('userId'))
    if (userId instanceof Response) return userId
    return c.json(await listTriggerTypes(auth.workspaceId, userId, {
      toolkit: c.req.query('toolkit') || null,
      projectId: c.req.query('projectId') || null,
    }))
  })

  router.get('/workspaces/:workspaceId/triggers', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({ triggers: await listSubscriptions(auth.workspaceId) })
  })

  router.post('/workspaces/:workspaceId/triggers', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, any> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'invalid_body', message: 'Request body must be an object' } }, 400)
    }
    const userId = await resolveScheduleActor(c, auth, body)
    if (userId instanceof Response) return userId
    if (!(await userCan(c, auth.workspaceId, userId, SCHEDULE_CREATOR_PERMISSION))) {
      return forbidden(c, 'Viewers cannot create triggers')
    }
    const targetDenied = await requireProjectUpdate(c, userId, body.targetProjectId)
    if (targetDenied) return targetDenied
    try {
      const notifyConversationId = await resolveNotifyConversation(auth.workspaceId, body.notifyConversationId, userId)
      const notifyThreadRootId = await resolveNotifyThread(notifyConversationId, body.notifyThreadRootId)
      const created = await createSubscription({
        workspaceId: auth.workspaceId,
        ownerUserId: userId,
        name: body.name,
        eventType: body.eventType,
        filter: body.filter,
        target: body.target,
        targetProjectId: body.targetProjectId,
        targetMode: body.targetMode,
        prompt: body.prompt,
        notifyConversationId,
        notifyThreadRootId,
        webhookUrl: body.webhookUrl,
        triggerConfig: body.triggerConfig && typeof body.triggerConfig === 'object' ? body.triggerConfig : null,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        actsAs: body.actsAs,
        actorIdPath: body.actorIdPath,
        actorEmailPath: body.actorEmailPath,
        trustActorEmail: body.trustActorEmail,
        policyEditor: auth.userId ?? null,
      })
      return c.json({ trigger: created.subscription, ...(created.webhookSecret ? { webhookSecret: created.webhookSecret } : {}) }, 201)
    } catch (error) {
      return triggerError(c, error)
    }
  })

  router.patch('/workspaces/:workspaceId/triggers/:triggerId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, any> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: { code: 'invalid_body', message: 'Request body must be an object' } }, 400)
    }
    const allowed = await authorizeTriggerManagement(c, auth, body)
    if (allowed instanceof Response) return allowed
    const targetDenied = await requireProjectUpdate(
      c,
      allowed.actor,
      body.targetProjectId ?? allowed.trigger.targetProjectId,
    )
    if (targetDenied) return targetDenied
    try {
      const notifyConversationId = body.notifyConversationId === undefined
        ? undefined
        : await resolveNotifyConversation(auth.workspaceId, body.notifyConversationId, allowed.actor)
      let notifyThreadRootId: string | null | undefined
      if (body.notifyThreadRootId !== undefined) {
        const channel = notifyConversationId !== undefined ? notifyConversationId : allowed.trigger.notifyConversationId
        notifyThreadRootId = await resolveNotifyThread(channel, body.notifyThreadRootId)
      } else if (notifyConversationId !== undefined) {
        notifyThreadRootId = null
      }
      const updated = await updateSubscription(auth.workspaceId, allowed.trigger.id, {
        name: body.name,
        enabled: body.enabled,
        filter: body.filter,
        prompt: body.prompt,
        targetMode: body.targetMode,
        notifyConversationId,
        notifyThreadRootId,
        webhookUrl: body.webhookUrl,
        rotateWebhookSecret: body.rotateWebhookSecret === true,
        actsAs: body.actsAs,
        actorIdPath: body.actorIdPath,
        actorEmailPath: body.actorEmailPath,
        trustActorEmail: body.trustActorEmail,
      }, { policyEditor: auth.userId ?? null })
      if (!updated) return c.json({ error: { code: 'not_found', message: 'Trigger not found' } }, 404)
      return c.json({ trigger: updated.subscription, ...(updated.webhookSecret ? { webhookSecret: updated.webhookSecret } : {}) })
    } catch (error) {
      return triggerError(c, error)
    }
  })

  router.delete('/workspaces/:workspaceId/triggers/:triggerId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const allowed = await authorizeTriggerManagement(c, auth, body)
    if (allowed instanceof Response) return allowed
    try {
      await deleteSubscription(auth.workspaceId, allowed.trigger.id)
    } catch (error) {
      return triggerError(c, error)
    }
    return c.json({ ok: true })
  })

  // Fires a synthetic event at this trigger only; the worker delivers it like a real one.
  router.post('/workspaces/:workspaceId/triggers/:triggerId/test', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const allowed = await authorizeTriggerManagement(c, auth, body)
    if (allowed instanceof Response) return allowed
    try {
      const result = await testSubscription(auth.workspaceId, allowed.trigger.id, body?.payload)
      if (!result) return c.json({ error: { code: 'not_found', message: 'Trigger not found' } }, 404)
      return c.json(result, 202)
    } catch (error) {
      return triggerError(c, error)
    }
  })

  router.get('/workspaces/:workspaceId/triggers/:triggerId/deliveries', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const limit = Number(c.req.query('limit') ?? 20)
    const deliveries = await listDeliveries(auth.workspaceId, c.req.param('triggerId'), Number.isFinite(limit) ? limit : 20)
    if (!deliveries) return c.json({ error: { code: 'not_found', message: 'Trigger not found' } }, 404)
    return c.json({ deliveries })
  })

  router.post('/workspaces/:workspaceId/triggers/:triggerId/deliveries/:deliveryId/redeliver', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const allowed = await authorizeTriggerManagement(c, auth, body)
    if (allowed instanceof Response) return allowed
    try {
      const delivery = await redeliver(auth.workspaceId, allowed.trigger.id, c.req.param('deliveryId'))
      if (!delivery) return c.json({ error: { code: 'not_found', message: 'Delivery not found' } }, 404)
      void import('../jobs/run-event-delivery-dispatch').then((m) => m.kickEventDeliveryWorker?.()).catch(() => {})
      return c.json({ delivery }, 202)
    } catch (error) {
      return triggerError(c, error)
    }
  })

  router.get('/workspaces/:workspaceId/app-grants', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const { listWorkspaceGrants } = await import('../services/app-install-grants.service')
    return c.json({ grants: await listWorkspaceGrants(auth.workspaceId) })
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
      auth.userId,
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

  // "What did PERSON work on today?" Owners and admins only. Backs the
  // workspace agent's `member_activity` tool. For a signed-in session the actor
  // is always the session user. Internal (runtime) callers have no session, so
  // they name the person asking in `requestedBy`; that id comes from the chat
  // request's authenticated user, never from model-supplied input.
  router.get('/workspaces/:workspaceId/member-activity', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth

    const actor = auth.userId || c.req.query('requestedBy')?.trim() || null
    if (!actor) {
      return c.json({
        error: { code: 'invalid_request', message: 'requestedBy is required for an internal request' },
      }, 400)
    }
    if (!(await userCan(c, auth.workspaceId, actor, 'workspace.analytics:read'))) {
      return forbidden(c, 'Only workspace owners and admins can look up what a teammate worked on')
    }

    const target = c.req.query('user')?.trim()
    if (!target) {
      return c.json({ error: { code: 'invalid_request', message: 'user (email or user id) is required' } }, 400)
    }
    const member = await findWorkspaceMember(auth.workspaceId, target)
    if (!member) {
      return c.json({ error: { code: 'not_found', message: `No workspace member matches "${target}"` } }, 404)
    }

    console.info(`[MemberActivity] ${actor} viewed ${member.userId} in workspace ${auth.workspaceId}`)
    const data = await getMemberWorkActivity(auth.workspaceId, member, {
      range: c.req.query('range'),
      since: c.req.query('since'),
      until: c.req.query('until'),
      tz: c.req.query('tz'),
    })
    return c.json({ activity: data })
  })

  router.get('/workspaces/:workspaceId/active-chats', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const chats = await listActiveChatTurns(auth.workspaceId)
    return c.json({ chats })
  })

  return router
}
