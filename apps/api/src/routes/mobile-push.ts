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

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'P2002'
}

/** Register the native app's Expo push token for the signed-in user. */
export function mobilePushRoutes() {
  const router = new Hono()

  router.post('/mobile-push-subscriptions', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)

    const body = await c.req.json<{ pushToken?: string; platform?: string }>().catch(
      () => ({} as { pushToken?: string; platform?: string }),
    )
    const pushToken = typeof body.pushToken === 'string' ? body.pushToken.trim() : ''
    const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : ''
    if (!pushToken || pushToken.length > 512 || !['ios', 'android'].includes(platform)) {
      return c.json({ error: { code: 'invalid_request', message: 'pushToken and a valid platform are required' } }, 400)
    }

    const existing = await prisma.mobilePushSubscription.findUnique({
      where: { pushToken },
      select: { id: true },
    })

    if (existing) {
      const subscription = await prisma.mobilePushSubscription.update({
        where: { id: existing.id },
        data: { userId, platform },
        select: { id: true },
      })
      return c.json({ ok: true, id: subscription.id })
    }

    let subscription
    try {
      subscription = await prisma.mobilePushSubscription.create({
        data: { userId, pushToken, platform },
        select: { id: true },
      })
    } catch (error) {
      // Two app surfaces can register the same token at the same time. If the
      // unique insert lost that race, re-read the row and apply the same
      // ownership check as the initial lookup instead of returning a 500.
      if (!isUniqueConstraintError(error)) throw error
      const raced = await prisma.mobilePushSubscription.findUnique({
        where: { pushToken },
        select: { id: true },
      })
      if (!raced) throw error
      subscription = await prisma.mobilePushSubscription.update({
        where: { id: raced.id },
        data: { userId, platform },
        select: { id: true },
      })
    }
    return c.json({ ok: true, id: subscription.id })
  })

  router.delete('/mobile-push-subscriptions', async (c) => {
    const userId = authUserId(c)
    if (!userId) return unauthorized(c)

    const body = await c.req.json<{ pushToken?: string }>().catch(
      () => ({} as { pushToken?: string }),
    )
    const queryToken = c.req.query('pushToken')
    const pushToken = typeof queryToken === 'string'
      ? queryToken.trim()
      : typeof body.pushToken === 'string'
        ? body.pushToken.trim()
        : ''
    if (!pushToken) {
      return c.json({ error: { code: 'invalid_request', message: 'pushToken is required' } }, 400)
    }

    await prisma.mobilePushSubscription.deleteMany({ where: { userId, pushToken } })
    return c.json({ ok: true })
  })

  return router
}
