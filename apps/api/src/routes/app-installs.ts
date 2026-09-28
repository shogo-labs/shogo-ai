// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono, type Context } from 'hono'
import { prisma } from '../lib/prisma'

function authUserId(c: Context): string | null {
  const auth = c.get('auth') as { userId?: string; isAuthenticated?: boolean } | undefined
  return auth?.isAuthenticated === false ? null : auth?.userId ?? null
}

function unauthorized(c: Context) {
  return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

/** Record a signed-in native app install and refresh its activity timestamp. */
export function appInstallRoutes() {
  const router = new Hono()

  router.post('/app-installs/heartbeat', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)

    type AppInstallBody = {
      deviceId?: unknown
      platform?: unknown
      appVersion?: unknown
      osVersion?: unknown
      deviceModel?: unknown
    }
    const body: AppInstallBody = await c.req.json<AppInstallBody>().catch(
      () => ({} as AppInstallBody),
    )

    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : ''
    if (!deviceId || deviceId.length > 64 || !['ios', 'android'].includes(platform)) {
      return c.json({
        error: {
          code: 'invalid_request',
          message: 'deviceId and a valid mobile platform are required',
        },
      }, 400)
    }

    const now = new Date()
    const appVersion = optionalString(body.appVersion, 32)
    const osVersion = optionalString(body.osVersion, 32)
    const deviceModel = optionalString(body.deviceModel, 64)
    const install = await prisma.appInstall.upsert({
      where: { deviceId },
      create: {
        deviceId,
        platform,
        appVersion,
        osVersion,
        deviceModel,
        userId,
        lastSeenAt: now,
      },
      update: {
        platform,
        appVersion,
        osVersion,
        deviceModel,
        userId,
        lastSeenAt: now,
      },
      select: { id: true },
    })

    return c.json({ ok: true, id: install.id })
  })

  return router
}
