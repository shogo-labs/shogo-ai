// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { hasWorkspaceAccess } from '../services/workspace.service'
import {
  getGoal,
  getOrCreateAgentProfile,
  isGoalStatus,
  listGoalEvents,
  listGoals,
  listWorkspaceActivity,
  updateAgentProfile,
} from '../services/personal-workspace.service'

export interface PersonalWorkspaceRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

export function personalWorkspaceRoutes(config: PersonalWorkspaceRoutesConfig): Hono {
  const router = new Hono()

  async function authorize(c: any): Promise<{ workspaceId: string; userId: string } | Response> {
    const workspaceId = c.req.param('workspaceId')
    const userId = await config.resolveUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    if (!(await hasWorkspaceAccess(workspaceId, userId))) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403)
    }
    return { workspaceId, userId }
  }

  router.get('/workspaces/:workspaceId/agent-profile', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({ profile: await getOrCreateAgentProfile(auth.workspaceId) })
  })

  router.patch('/workspaces/:workspaceId/agent-profile', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth

    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
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

  router.get('/workspaces/:workspaceId/goals', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const rawStatus = c.req.query('status')
    if (rawStatus && !isGoalStatus(rawStatus)) {
      return c.json({ error: { code: 'invalid_status', message: 'Unknown goal status' } }, 400)
    }
    const status = rawStatus && isGoalStatus(rawStatus) ? rawStatus : undefined
    return c.json({ goals: await listGoals(auth.workspaceId, status) })
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

  router.get('/workspaces/:workspaceId/activity', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const parsedLimit = Number(c.req.query('limit') || 100)
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200) : 100
    return c.json({ activity: await listWorkspaceActivity(auth.workspaceId, limit) })
  })

  return router
}
