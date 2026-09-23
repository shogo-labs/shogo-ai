// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { verifyRuntimeToken } from '../lib/runtime-token'

function userId(c: any): string | null {
  const auth = c.get('auth') as { userId?: string; isAuthenticated?: boolean } | undefined
  return auth?.isAuthenticated && auth.userId ? auth.userId : null
}

async function canAccess(user: string | null, projectId: string): Promise<boolean> {
  if (!user) return false
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: { members: { some: { userId: user } } } },
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
    const data: Record<string, unknown> = {}
    if (typeof body.heartbeatEnabled === 'boolean') data.heartbeatEnabled = body.heartbeatEnabled
    if (typeof body.heartbeatInterval === 'number' && body.heartbeatInterval >= 60) {
      data.heartbeatInterval = body.heartbeatInterval
    }
    if (body.quietHoursStart !== undefined) data.quietHoursStart = body.quietHoursStart || null
    if (body.quietHoursEnd !== undefined) data.quietHoursEnd = body.quietHoursEnd || null
    if (body.quietHoursTimezone !== undefined) data.quietHoursTimezone = body.quietHoursTimezone || null

    const existing = await prisma.agentConfig.findUnique({ where: { projectId } })
    if (!existing) return c.json({ error: 'Agent config not found' }, 404)
    const enabled = (data.heartbeatEnabled as boolean | undefined) ?? existing.heartbeatEnabled
    const interval = (data.heartbeatInterval as number | undefined) ?? existing.heartbeatInterval
    data.nextHeartbeatAt = enabled
      ? new Date(Date.now() + interval * 1000 + Math.floor(Math.random() * interval * 100))
      : null
    const updated = await prisma.agentConfig.update({
      where: { projectId },
      data,
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
    return c.json(configShape(updated))
  })

  router.put('/projects/:projectId/heartbeat/sync', async (c) => {
    const projectId = c.req.param('projectId')
    const token = c.req.header('x-runtime-token')
    const verified = verifyRuntimeToken(token, projectId)
    if (!verified.ok || verified.projectId !== projectId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const body = await c.req.json().catch(() => ({} as any))
    const existing = await prisma.agentConfig.findUnique({ where: { projectId } })
    const enabled = typeof body.heartbeatEnabled === 'boolean'
      ? body.heartbeatEnabled
      : existing?.heartbeatEnabled ?? false
    const interval = typeof body.heartbeatInterval === 'number' && body.heartbeatInterval >= 60
      ? body.heartbeatInterval
      : existing?.heartbeatInterval ?? 1800
    const nextHeartbeatAt = enabled
      ? new Date(Date.now() + interval * 1000 + Math.floor(Math.random() * interval * 100))
      : null
    await prisma.agentConfig.upsert({
      where: { projectId },
      update: { heartbeatEnabled: enabled, heartbeatInterval: interval, nextHeartbeatAt },
      create: {
        projectId,
        heartbeatEnabled: enabled,
        heartbeatInterval: interval,
        nextHeartbeatAt,
        channels: [],
      },
    })
    return c.json({ ok: true })
  })

  return router
}
