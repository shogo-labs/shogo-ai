// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { normalizeAdminScopes } from '../lib/admin-scopes'

type AuthContext = {
  userId?: string
  isAuthenticated?: boolean
}

function userIdFrom(c: any): string | null {
  const auth = c.get('auth') as AuthContext | undefined
  return auth?.isAuthenticated && auth.userId ? auth.userId : null
}

function compareAnnouncementVersions(a: string, b: string): number {
  const [aMajor, aMinor] = a.split('.').map(Number)
  const [bMajor, bMinor] = b.split('.').map(Number)
  return aMajor - bMajor || aMinor - bMinor
}

/**
 * User/profile routes shared by the local composer.
 *
 * These handlers used to live inline in the cloud composer. Keeping the
 * desktop-safe implementation here prevents local startup from evaluating the
 * billing/admin route graph just to answer `/api/me`.
 */
export function userProfileRoutes(): Hono {
  const router = new Hono()

  router.get('/me', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        role: true,
        adminScopes: true,
        onboardingCompleted: true,
        lastSeenAnnouncementVersion: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    if (!user) {
      return c.json({ error: { code: 'not_found', message: 'User not found' } }, 404)
    }

    return c.json({
      ok: true,
      data: { ...user, adminScopes: normalizeAdminScopes(user.adminScopes) },
    })
  })

  router.post('/me/announcements/seen', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }

    let body: { version?: unknown }
    try {
      body = await c.req.json<{ version?: unknown }>()
    } catch {
      return c.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, 400)
    }

    const version = typeof body.version === 'string' ? body.version : ''
    if (!/^\d+\.\d+$/.test(version)) {
      return c.json({
        error: { code: 'invalid_version', message: 'version must look like 1.12' },
      }, 400)
    }

    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastSeenAnnouncementVersion: true },
    })
    if (
      !current?.lastSeenAnnouncementVersion ||
      compareAnnouncementVersions(version, current.lastSeenAnnouncementVersion) > 0
    ) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastSeenAnnouncementVersion: version },
      })
    }

    return c.json({ ok: true, version })
  })

  router.post('/onboarding/complete', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }
    await prisma.user.update({
      where: { id: userId },
      data: { onboardingCompleted: true },
    })
    return c.json({ ok: true })
  })

  router.get('/me/activity', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }

    try {
      const oneYearAgo = new Date()
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
      oneYearAgo.setHours(0, 0, 0, 0)

      const memberships = await prisma.member.findMany({
        where: { userId },
        select: { workspaceId: true },
      })
      const workspaceIds = memberships
        .map((membership) => membership.workspaceId)
        .filter((workspaceId): workspaceId is string => typeof workspaceId === 'string')
      if (workspaceIds.length === 0) {
        return c.json({
          ok: true,
          data: {
            totalMessages: 0,
            dailyAverage: 0,
            daysActive: 0,
            daysInPeriod: 365,
            currentStreak: 0,
            dailyCounts: {},
          },
        })
      }

      const messages = await prisma.chatMessage.findMany({
        where: {
          role: 'user',
          agent: 'technical',
          createdAt: { gte: oneYearAgo },
          session: { project: { workspaceId: { in: workspaceIds } } },
        },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      })

      const dailyCounts: Record<string, number> = {}
      for (const message of messages) {
        const day = message.createdAt.toISOString().slice(0, 10)
        dailyCounts[day] = (dailyCounts[day] || 0) + 1
      }

      const now = new Date()
      const daysInPeriod = Math.max(
        1,
        Math.ceil((now.getTime() - oneYearAgo.getTime()) / 86_400_000),
      )
      let currentStreak = 0
      const cursor = new Date(now)
      cursor.setHours(0, 0, 0, 0)
      while (true) {
        const key = cursor.toISOString().slice(0, 10)
        if (dailyCounts[key]) {
          currentStreak++
          cursor.setDate(cursor.getDate() - 1)
          continue
        }
        if (currentStreak === 0) {
          cursor.setDate(cursor.getDate() - 1)
          const yesterday = cursor.toISOString().slice(0, 10)
          if (dailyCounts[yesterday]) {
            currentStreak++
            cursor.setDate(cursor.getDate() - 1)
            continue
          }
        }
        break
      }

      return c.json({
        ok: true,
        data: {
          totalMessages: messages.length,
          dailyAverage: Math.round((messages.length / daysInPeriod) * 10) / 10,
          daysActive: Object.keys(dailyCounts).length,
          daysInPeriod,
          currentStreak,
          dailyCounts,
        },
      })
    } catch (error: any) {
      console.error('[LocalUser] Failed to fetch activity:', error)
      return c.json({
        error: { code: 'activity_failed', message: error?.message || 'Failed to fetch activity' },
      }, 500)
    }
  })

  return router
}

/** Backwards-compatible name for the local composer. */
export const localUserRoutes = userProfileRoutes
