// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scoped Analytics Routes
 *
 * Workspace-level and project-level analytics endpoints that reuse
 * the same analytics service as the admin routes. These require
 * workspace/project membership, not super admin.
 *
 * Mounted at /api/*
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authMiddleware, requireAuth } from '../middleware/auth'
import { isBusinessOrHigherPlan } from '../services/billing.service'
import * as analytics from '../services/analytics.service'
import type { AnalyticsPeriod } from '../services/analytics.service'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if user has access to a workspace (is a member).
 */
async function checkWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { userId, workspaceId },
  })
  return !!member
}

/**
 * Check if user has access to a project (via workspace membership).
 */
async function checkProjectAccess(userId: string, projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  if (!project) return null

  const member = await prisma.member.findFirst({
    where: { userId, workspaceId: project.workspaceId },
  })
  return member ? project.workspaceId : null
}

// ============================================================================
// Routes
// ============================================================================

export function scopedAnalyticsRoutes(): Hono {
  const router = new Hono()

  // All scoped analytics routes require auth
  router.use('*', authMiddleware)
  router.use('*', requireAuth)

  // --------------------------------------------------------------------------
  // Workspace Analytics — Basic (all workspace members)
  // --------------------------------------------------------------------------

  router.get('/workspaces/:workspaceId/analytics/overview', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await analytics.getOverviewStats({ workspaceId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/usage-log', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const userId = url.searchParams.get('userId') || undefined
      const model = url.searchParams.get('model') || undefined

      const data = await analytics.getUsageLog({ workspaceId }, period, { page, limit, userId, model })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/usage-summary', async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod
      const data = await analytics.getUsageSummary({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Workspace Analytics — Advanced (Business plan or higher required)
  // --------------------------------------------------------------------------

  const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

  const requireBusinessPlan = async (c: any, next: any) => {
    if (isLocalMode) return next()
    const workspaceId = c.req.param('workspaceId')
    if (!await isBusinessOrHigherPlan(workspaceId)) {
      return c.json({
        error: {
          code: 'plan_required',
          message: 'Advanced workspace analytics require a Business plan or higher.',
        },
      }, 403)
    }
    await next()
  }

  router.get('/workspaces/:workspaceId/analytics/growth', requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await analytics.getGrowthTimeSeries({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/usage', requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await analytics.getUsageAnalytics({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/chat', requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await analytics.getChatAnalytics({ workspaceId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/projects', requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await analytics.getProjectAnalytics({ workspaceId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/workspaces/:workspaceId/analytics/billing', requireBusinessPlan, async (c) => {
    try {
      const workspaceId = c.req.param('workspaceId')
      const auth = c.get('auth')

      if (!await checkWorkspaceAccess(auth.userId!, workspaceId)) {
        return c.json({ error: { code: 'forbidden', message: 'Not a member of this workspace' } }, 403)
      }

      const data = await analytics.getBillingAnalytics({ workspaceId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // Project Analytics
  // --------------------------------------------------------------------------

  router.get('/projects/:projectId/analytics/overview', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const auth = c.get('auth')

      const workspaceId = await checkProjectAccess(auth.userId!, projectId)
      if (!workspaceId) {
        return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
      }

      const data = await analytics.getOverviewStats({ workspaceId, projectId })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/projects/:projectId/analytics/chat', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const auth = c.get('auth')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const workspaceId = await checkProjectAccess(auth.userId!, projectId)
      if (!workspaceId) {
        return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
      }

      const data = await analytics.getChatAnalytics({ workspaceId, projectId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/projects/:projectId/analytics/usage', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const auth = c.get('auth')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const workspaceId = await checkProjectAccess(auth.userId!, projectId)
      if (!workspaceId) {
        return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
      }

      const data = await analytics.getUsageAnalytics({ workspaceId, projectId }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  // --------------------------------------------------------------------------
  // User (Me) Analytics
  // --------------------------------------------------------------------------

  router.get('/me/analytics/overview', async (c) => {
    try {
      const auth = c.get('auth')
      const data = await analytics.getOverviewStats({ userId: auth.userId! })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/me/analytics/usage-log', async (c) => {
    try {
      const auth = c.get('auth')
      const url = new URL(c.req.url)
      const period = (url.searchParams.get('period') || '30d') as AnalyticsPeriod
      const page = parseInt(url.searchParams.get('page') || '1', 10)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const model = url.searchParams.get('model') || undefined

      const data = await analytics.getUsageLog({ userId: auth.userId! }, period, { page, limit, model })
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  router.get('/me/analytics/usage-summary', async (c) => {
    try {
      const auth = c.get('auth')
      const period = (new URL(c.req.url).searchParams.get('period') || '30d') as AnalyticsPeriod

      const data = await analytics.getUsageSummary({ userId: auth.userId! }, period)
      return c.json({ ok: true, data })
    } catch (error: any) {
      return c.json({ error: { code: 'analytics_failed', message: error.message } }, 500)
    }
  })

  return router
}
