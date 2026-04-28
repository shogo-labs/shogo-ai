// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cost Analytics Routes — Agent Cost Optimizer API
 *
 * Workspace-scoped endpoints for agent cost breakdown, AI recommendations,
 * budget alerts, historical trends, A/B model experiments, and the new
 * sub-agent model override system that lets users actually accept the
 * recommendations the optimizer generates.
 *
 * Mounted at /api/*
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireAuth } from '../middleware/auth'
import * as costAnalytics from '../services/cost-analytics.service'
import { isCostPeriod, type CostPeriod } from '../services/cost-analytics.service'

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

/**
 * Parse the `period` query param against the explicit allowlist
 * (Phase 4.2 fix — invalid values used to silently return all data).
 */
function parsePeriod(c: Context): { period: CostPeriod } | { error: Response } {
  const raw = new URL(c.req.url).searchParams.get('period') || '30d'
  if (!isCostPeriod(raw)) {
    return {
      error: c.json({
        error: {
          code: 'bad_request',
          message: `Invalid period '${raw}'. Allowed values: 7d, 30d, 90d, 1y.`,
        },
      }, 400),
    }
  }
  return { period: raw }
}

function isExperimentInputError(error: unknown): boolean {
  const message = String((error as any)?.message ?? '')
  return message.startsWith('Unsupported experiment agentType') ||
    message === 'modelA and modelB must be different models.'
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

      const parsed = parsePeriod(c)
      if ('error' in parsed) return parsed.error
      const projectId = new URL(c.req.url).searchParams.get('projectId') || undefined

      const data = await costAnalytics.getAgentCostBreakdown(workspaceId, parsed.period, projectId)
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

      const parsed = parsePeriod(c)
      if ('error' in parsed) return parsed.error
      const data = await costAnalytics.getCostRecommendations(workspaceId, parsed.period)
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

      const parsed = parsePeriod(c)
      if ('error' in parsed) return parsed.error
      const projectId = new URL(c.req.url).searchParams.get('projectId') || undefined

      const data = await costAnalytics.getCostTrends(workspaceId, parsed.period, projectId)
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

  // Budget alert status check (includes auto-throttle state).
  // Single `checkBudgetAlerts` call, derive throttle model from the result —
  // Phase 4.2 fix for the previous double-aggregation bug.
  router.get('/workspaces/:workspaceId/cost-analytics/budget-status', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const usage = await costAnalytics.getBudgetAlertUsage(workspaceId)
      const breached = usage.filter(item => item.percentUsed >= 80)
      const throttleModel = costAnalytics.deriveActiveThrottleModel(breached)

      return c.json({ ok: true, data: { usage, breached, throttleModel } })
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
      const badRequest = isExperimentInputError(error)
      return c.json({
        error: { code: badRequest ? 'bad_request' : 'cost_analytics_failed', message: error.message },
      }, badRequest ? 400 : 500)
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

  // Phase 3.2 — convenience endpoint for the two-week shadow A/B (defaulting to
  // explore haiku-vs-sonnet but accepting any pair). Different from POST
  // /experiments because it forces status='shadow' and computes expectedEndAt.
  router.post('/workspaces/:workspaceId/cost-analytics/experiments/shadow', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }

      const body = await c.req.json().catch(() => ({}))
      if (!body.agentType || !body.modelA || !body.modelB) {
        return c.json({
          error: { code: 'bad_request', message: 'agentType, modelA, modelB required' },
        }, 400)
      }

      const data = await costAnalytics.createShadowExperiment(workspaceId, body)
      return c.json({ ok: true, data }, 201)
    } catch (error: any) {
      const badRequest = isExperimentInputError(error)
      return c.json({
        error: { code: badRequest ? 'bad_request' : 'cost_analytics_failed', message: error.message },
      }, badRequest ? 400 : 500)
    }
  })

  // Phase 3.2 — multi-signal verdict for a running / completed experiment.
  router.get('/workspaces/:workspaceId/cost-analytics/experiments/:experimentId/summary', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const experimentId = c.req.param('experimentId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await costAnalytics.summarizeExperiment(experimentId, workspaceId)
      if (!data) return c.json({ error: { code: 'not_found', message: 'Experiment not found' } }, 404)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Optimizer in Action — Phase 3.3
  //
  // Single endpoint that returns everything the "Optimizer in Action" report
  // needs: applied overrides + 30-day before/after windows, eval scores per
  // (agent, model), active shadow A/Bs, and aggregate $ savings. The boss
  // wanted a screenshotable artifact — this is the data behind it.
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/cost-analytics/optimizer-in-action', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')
      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }
      const data = await costAnalytics.getOptimizerInActionReport(workspaceId)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Subagent Model Overrides — Phase 1 (boss concern #2)
  //
  // Read-access for any workspace member, write-access for admins only. The
  // override is keyed on (workspaceId, projectId?, agentType). projectId=null
  // means "applies to all projects in this workspace by default".
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/cost-analytics/subagent-overrides', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')
      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }
      const data = await costAnalytics.listSubagentOverrides(workspaceId)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.post('/workspaces/:workspaceId/cost-analytics/subagent-overrides', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')
      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }
      const body = await c.req.json().catch(() => null) as {
        agentType?: string
        model?: string
        provider?: string | null
        projectId?: string | null
      } | null
      if (!body || !body.agentType || !body.model) {
        return c.json({
          error: { code: 'bad_request', message: 'agentType and model are required' },
        }, 400)
      }
      const data = await costAnalytics.upsertSubagentOverride(workspaceId, {
        agentType: body.agentType,
        model: body.model,
        provider: body.provider ?? null,
        projectId: body.projectId ?? null,
        updatedBy: auth.userId ?? null,
      })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  router.delete('/workspaces/:workspaceId/cost-analytics/subagent-overrides/:agentType', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const agentType = c.req.param('agentType')
      const auth = c.get('auth')
      if (!await checkWorkspaceAdmin(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Admin access required' } }, 403)
      }
      const projectId = new URL(c.req.url).searchParams.get('projectId') || null
      await costAnalytics.deleteSubagentOverride(workspaceId, agentType, projectId)
      return c.json({ ok: true })
    } catch (error: any) {
      return c.json({ error: { code: 'cost_analytics_failed', message: error.message } }, 500)
    }
  })

  return router
}
