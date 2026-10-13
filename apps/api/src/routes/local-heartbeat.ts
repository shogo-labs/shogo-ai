// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { authenticateRuntimeToken } from './internal-runtime-auth'
import { HeartbeatConfigError, updateHeartbeatConfig } from '../services/heartbeat-config.service'

function userId(c: any): string | null {
  const auth = c.get('auth') as { userId?: string; isAuthenticated?: boolean } | undefined
  return auth?.isAuthenticated && auth.userId ? auth.userId : null
}

async function canAccess(user: string | null, projectId: string): Promise<boolean> {
  if (!user) return false
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: { members: { some: { userId: user, projectId: null } } } },
    select: { id: true },
  })
  return !!project
}

function configShape(config: any) {
  return {
    ...config,
    modelLabel: null,
  }
}

export function localHeartbeatRoutes(): Hono {
  const router = new Hono()

  router.get('/projects/:projectId/heartbeat', async (c) => {
    const projectId = c.req.param('projectId')
    if (!await canAccess(userId(c), projectId)) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
    }
    const config = await prisma.agentConfig.findUnique({
      where: { projectId },
      select: {
        heartbeatEnabled: true,
        heartbeatInterval: true,
        nextHeartbeatAt: true,
        lastHeartbeatAt: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        quietHoursTimezone: true,
        modelName: true,
      },
    })
    if (!config) return c.json({ error: 'Agent config not found' }, 404)
    return c.json(configShape(config))
  })

  router.patch('/projects/:projectId/heartbeat', async (c) => {
    const projectId = c.req.param('projectId')
    if (!await canAccess(userId(c), projectId)) {
      return c.json({ error: { code: 'forbidden', message: 'No access to this project' } }, 403)
    }
    const body = await c.req.json().catch(() => ({} as any))
    try {
      const { config: updated } = await updateHeartbeatConfig(
        projectId,
        {
          heartbeatEnabled: typeof body.heartbeatEnabled === 'boolean' ? body.heartbeatEnabled : undefined,
          heartbeatInterval: typeof body.heartbeatInterval === 'number' ? body.heartbeatInterval : undefined,
          quietHoursStart: body.quietHoursStart,
          quietHoursEnd: body.quietHoursEnd,
          quietHoursTimezone: body.quietHoursTimezone,
        },
        { enforcePaywall: false, alwaysReschedule: true, createIfMissing: true },
      )
      return c.json(
        configShape({
          heartbeatEnabled: updated.heartbeatEnabled,
          heartbeatInterval: updated.heartbeatInterval,
          nextHeartbeatAt: updated.nextHeartbeatAt,
          lastHeartbeatAt: updated.lastHeartbeatAt,
          quietHoursStart: updated.quietHoursStart,
          quietHoursEnd: updated.quietHoursEnd,
          quietHoursTimezone: updated.quietHoursTimezone,
          modelName: updated.modelName,
        }),
      )
    } catch (err) {
      if (err instanceof HeartbeatConfigError && err.code === 'not_found') {
        return c.json({ error: 'Agent config not found' }, 404)
      }
      throw err
    }
  })

  // DEPRECATED: heartbeat settings live only in the database now. Kept for
  // one release for runtimes that still push config.json heartbeat fields.
  router.put('/projects/:projectId/heartbeat/sync', async (c) => {
    const projectId = c.req.param('projectId')
    if (!(await authenticateRuntimeToken(c, projectId))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const body = await c.req.json().catch(() => ({} as any))
    await updateHeartbeatConfig(
      projectId,
      {
        heartbeatEnabled: typeof body.heartbeatEnabled === 'boolean' ? body.heartbeatEnabled : undefined,
        heartbeatInterval: typeof body.heartbeatInterval === 'number' ? body.heartbeatInterval : undefined,
      },
      { enforcePaywall: false, createIfMissing: true, alwaysReschedule: true },
    )
    return c.json({ ok: true })
  })

  return router
}
