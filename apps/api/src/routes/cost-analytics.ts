// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cost Analytics Routes — Agent Cost Optimizer API
 *
 * Workspace-scoped endpoints for agent cost breakdown, AI recommendations,
 * budget alerts, historical trends, and A/B model experiments.
 *
 * Mounted at /api/*
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireAuth } from '../middleware/auth'
import * as costAnalytics from '../services/cost-analytics.service'
import type { CostPeriod } from '../services/cost-analytics.service'

// ============================================================================
// Helpers
// ============================================================================

async function checkWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { userId, workspaceId },
  })
  return !!member
}

async function checkWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { userId, workspaceId, role: { in: ['owner', 'admin'] } },
  })
  return !!member
}

// ============================================================================
// Routes
// ============================================================================

export function costAnalyticsRoutes(): Hono {
  const router = new Hono()

  router.use('*', authMiddleware)
  router.use('*', requireAuth)

  // --------------------------------------------------------------------------
  // Agent Cost Breakdown
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/cost-analytics/agent-breakdown', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as CostPeriod
      const projectId = url.searchParams.get('projectId') || undefined

      const data = await costAnalytics.getAgentCostBreakdown(workspaceId, period, projectId)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // AI Recommendations
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/cost-analytics/recommendations', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as CostPeriod
      const data = await costAnalytics.getCostRecommendations(workspaceId, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Cost Trends & Forecast
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/cost-analytics/trends', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as CostPeriod
      const projectId = url.searchParams.get('projectId') || undefined

      const data = await costAnalytics.getCostTrends(workspaceId, period, projectId)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Budget Alerts (CRUD) — admin only for create/update/delete
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/cost-analytics/budget-alerts', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await costAnalytics.getBudgetAlerts(workspaceId)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.post('/workspaces/:workspaceId/cost-analytics/budget-alerts', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }

      const body = await c.req.json()
      if (!body.name || typeof body.creditLimit !== 'number') {
        return c.json({ error: { code: 'bad_request', message: 'name and creditLimit are required' } }, 400)
      }

      const data = await costAnalytics.createBudgetAlert(workspaceId, body)
      return c.json({ ok: true, data }, 201)
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.patch('/workspaces/:workspaceId/cost-analytics/budget-alerts/:alertId', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const alertId = c.req.param('alertId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }

      const body = await c.req.json()
      const data = await costAnalytics.updateBudgetAlert(alertId, workspaceId, body)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.delete('/workspaces/:workspaceId/cost-analytics/budget-alerts/:alertId', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const alertId = c.req.param('alertId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }

      await costAnalytics.deleteBudgetAlert(alertId, workspaceId)
      return c.json({ ok: true })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  // Budget alert status check (includes auto-throttle state)
  router.get('/workspaces/:workspaceId/cost-analytics/budget-status', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const [breached, throttleModel] = await Promise.all([
        costAnalytics.checkBudgetAlerts(workspaceId),
        costAnalytics.getActiveThrottleModel(workspaceId),
      ])

      return c.json({ ok: true, data: { breached, throttleModel } })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // A/B Model Experiments
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/cost-analytics/experiments', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await costAnalytics.getExperiments(workspaceId)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.post('/workspaces/:workspaceId/cost-analytics/experiments', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }

      const body = await c.req.json()
      if (!body.name || !body.agentType || !body.modelA || !body.modelB) {
        return c.json({
          error: { code: 'bad_request', message: 'name, agentType, modelA, and modelB are required' },
        }, 400)
      }

      const data = await costAnalytics.createExperiment(workspaceId, body)
      return c.json({ ok: true, data }, 201)
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/cost-analytics/experiments/:experimentId', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const experimentId = c.req.param('experimentId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await costAnalytics.getExperiment(experimentId, workspaceId)
      if (!data) {
        return c.json({ error: { code: 'not_found', message: 'Experiment not found' } }, 404)
      }
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.post('/workspaces/:workspaceId/cost-analytics/experiments/:experimentId/stop', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const experimentId = c.req.param('experimentId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }

      const data = await costAnalytics.stopExperiment(experimentId, workspaceId)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  return router
}
