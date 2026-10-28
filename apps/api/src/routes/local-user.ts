// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { normalizeAdminScopes } from '../lib/admin-scopes'
import { parseBuddyLook, type BuddyLook } from '../../../../packages/shared-app/src/buddy-look'
import {
  AVATAR_CONTENT_KEY_PATTERN,
  AVATAR_MAX_BYTES,
  avatarStorageKey,
  avatarTokenPayload,
  avatarUrl,
  isSafeAvatarUserId,
  mimeForAvatarContentKey,
  parseAvatarUrl,
  validateAvatarUpload,
} from '../lib/user-avatar'
import {
  deleteConversationFile,
  putConversationFile,
  readConversationFile,
  readConversationFileStream,
  verifyConversationFileToken,
  wantsInlineBytes,
} from '../lib/conversation-files'

type AuthContext = {
  userId?: string
  isAuthenticated?: boolean
}

function userIdFrom(c: any): string | null {
  const auth = c.get('auth') as AuthContext | undefined
  return auth?.isAuthenticated && auth.userId ? auth.userId : null
}

const ONBOARDING_INTENTS = ['personal', 'team'] as const
type OnboardingIntent = (typeof ONBOARDING_INTENTS)[number]

function storedBuddyLook(raw: string | null | undefined): BuddyLook | null {
  if (!raw) return null
  try {
    const parsed = parseBuddyLook(JSON.parse(raw))
    return parsed.ok ? parsed.look : null
  } catch {
    return null
  }
}

function compareAnnouncementVersions(a: string, b: string): number {
  const [aMajor, aMinor] = a.split('.').map(Number)
  const [bMajor, bMinor] = b.split('.').map(Number)
  return aMajor - bMajor || aMinor - bMinor
}

/**
 * Best-effort removal of the blob a replaced or cleared picture pointed at.
 *
 * Never throws. By the time this runs the user's photo has already changed, and
 * a failed cleanup is not worth failing the request over — blobs are
 * content-addressed, so the worst case is one orphaned file.
 */
async function deleteReplacedAvatar(
  userId: string,
  previousImage: string | null | undefined,
  nextContentKey: string | null,
): Promise<void> {
  const previous = parseAvatarUrl(previousImage)
  if (!previous || previous.userId !== userId) return
  if (previous.contentKey === nextContentKey) return
  try {
    await deleteConversationFile(avatarStorageKey(userId, previous.contentKey))
  } catch (error: any) {
    console.warn('[UserAvatar] Could not delete the replaced picture:', error?.message ?? error)
  }
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
        onboardingIntent: true,
        lastSeenAnnouncementVersion: true,
        buddyLook: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    if (!user) {
      return c.json({ error: { code: 'not_found', message: 'User not found' } }, 404)
    }

    return c.json({
      ok: true,
      data: {
        ...user,
        adminScopes: normalizeAdminScopes(user.adminScopes),
        buddyLook: storedBuddyLook(user.buddyLook),
      },
    })
  })

  router.put('/me/buddy', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, 400)
    }

    const parsed = parseBuddyLook(body)
    if (!parsed.ok) {
      return c.json({ error: { code: 'invalid_look', message: parsed.error } }, 400)
    }

    await prisma.user.update({
      where: { id: userId },
      data: { buddyLook: JSON.stringify(parsed.look) },
    })
    return c.json({ ok: true, data: parsed.look })
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

    // Body is optional: the local wizard posts without one.
    let body: { intent?: unknown } = {}
    try {
      body = await c.req.json<{ intent?: unknown }>()
    } catch {}
    const intent = body?.intent
    if (intent !== undefined && !ONBOARDING_INTENTS.includes(intent as OnboardingIntent)) {
      return c.json({
        error: { code: 'invalid_intent', message: `intent must be one of: ${ONBOARDING_INTENTS.join(', ')}` },
      }, 400)
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        onboardingCompleted: true,
        ...(intent ? { onboardingIntent: intent as OnboardingIntent } : {}),
      },
    })
    return c.json({ ok: true })
  })

  /**
   * Server-derived progress for the in-app "Get started" checklist. Mirrors
   * the activation funnel in `analytics.service.ts#getUserFunnel`.
   * Composio connections live outside the DB, so `connectedIntegration`
   * only reflects Slack here; the client ORs in its own connection list.
   */
  router.get('/me/getting-started', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }

    const ownedTeamWorkspaceIds = (
      await prisma.member.findMany({
        where: { userId, projectId: null, role: 'owner', workspace: { kind: 'team' } },
        select: { workspaceId: true },
      })
    )
      .map((m) => m.workspaceId)
      .filter((id): id is string => typeof id === 'string')

    const [sentMessage, createdProject, installedAgent, slackInstall, slackLink, otherMember, invitation] =
      await Promise.all([
        prisma.chatMessage.findFirst({
          where: {
            role: 'user',
            session: {
              OR: [
                { project: { createdBy: userId } },
                // ChatMessage has no author, so shared team workspaces can't
                // be attributed to this user; only their personal space can.
                { workspace: { kind: 'personal', members: { some: { userId, projectId: null } } } },
              ],
            },
          },
          select: { id: true },
        }),
        prisma.project.findFirst({ where: { createdBy: userId }, select: { id: true } }),
        prisma.marketplaceInstall.findFirst({ where: { userId }, select: { id: true } }),
        ownedTeamWorkspaceIds.length > 0
          ? prisma.slackWorkspaceInstallation.findFirst({
              where: { workspaceId: { in: ownedTeamWorkspaceIds } },
              select: { id: true },
            })
          : null,
        prisma.slackUserLink.findFirst({ where: { shogoUserId: userId }, select: { id: true } }),
        ownedTeamWorkspaceIds.length > 0
          ? prisma.member.findFirst({
              where: { workspaceId: { in: ownedTeamWorkspaceIds }, userId: { not: userId } },
              select: { id: true },
            })
          : null,
        prisma.invitation.findFirst({ where: { invitedBy: userId }, select: { id: true } }),
      ])

    return c.json({
      ok: true,
      data: {
        sentFirstMessage: !!sentMessage,
        createdProject: !!createdProject,
        installedAgent: !!installedAgent,
        connectedIntegration: !!slackInstall || !!slackLink,
        invitedTeammate: !!otherMember || !!invitation,
      },
    })
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
        where: { userId, projectId: null },
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

  /**
   * Replaces the signed-in user's profile picture.
   *
   * Multipart `file`, like the custom-emoji upload: on iOS/Android the client
   * sends `localFilePart`, which is the only file shape the native global fetch
   * can encode. The URL is both built and written here — the client never
   * supplies it — so an arbitrary string cannot end up in the one column every
   * message payload carries.
   */
  router.post('/me/avatar', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }

    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!file || typeof file === 'string') {
      return c.json({
        error: { code: 'invalid_file', message: 'Attach an image in the "file" field' },
      }, 400)
    }
    if (file.size > AVATAR_MAX_BYTES) {
      return c.json({
        error: { code: 'file_too_large', message: 'Images must be 1 MB or smaller' },
      }, 413)
    }

    const result = validateAvatarUpload(new Uint8Array(await file.arrayBuffer()))
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, 400)
    }

    const previous = await prisma.user.findUnique({
      where: { id: userId },
      select: { image: true },
    })

    await putConversationFile(
      avatarStorageKey(userId, result.contentKey),
      result.bytes,
      result.mime,
    )

    const image = avatarUrl(userId, result.contentKey)
    await prisma.user.update({ where: { id: userId }, data: { image } })
    await deleteReplacedAvatar(userId, previous?.image, result.contentKey)

    return c.json({ ok: true, data: { image } })
  })

  /** Clears the picture, so the UI falls back to initials. */
  router.delete('/me/avatar', async (c) => {
    const userId = userIdFrom(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }

    const previous = await prisma.user.findUnique({
      where: { id: userId },
      select: { image: true },
    })
    await prisma.user.update({ where: { id: userId }, data: { image: null } })
    await deleteReplacedAvatar(userId, previous?.image, null)

    return c.json({ ok: true, data: { image: null } })
  })

  /**
   * Serves a profile picture.
   *
   * Deliberately outside the session gate (see `isTokenGatedUserAvatarPath`):
   * this is fetched by a plain `<img>` / RN `<Image>` that can present no
   * ambient credentials, so the token in `?t=` is the credential. Because the
   * URL is content-addressed, the bytes can also be cached hard.
   */
  router.get('/user-avatar/:userId', async (c) => {
    const userId = c.req.param('userId')
    const contentKey = c.req.query('k') ?? ''
    if (!isSafeAvatarUserId(userId) || !AVATAR_CONTENT_KEY_PATTERN.test(contentKey)) {
      return c.json({ error: { code: 'invalid_request', message: 'Invalid avatar link' } }, 400)
    }
    if (!verifyConversationFileToken(avatarTokenPayload(userId, contentKey), c.req.query('t'))) {
      return c.json({ error: { code: 'forbidden', message: 'Invalid avatar link' } }, 403)
    }

    const mime = mimeForAvatarContentKey(contentKey)
    if (!mime) {
      return c.json({ error: { code: 'invalid_request', message: 'Invalid avatar link' } }, 400)
    }

    try {
      const file = await readConversationFile(avatarStorageKey(userId, contentKey))
      if (file.kind === 'redirect') {
        if (!wantsInlineBytes(c)) return c.redirect(file.url, 302)
        const stream = await readConversationFileStream(avatarStorageKey(userId, contentKey))
        return new Response(stream.body as any, {
          headers: {
            'Content-Type': mime,
            ...(stream.contentLength !== null ? { 'Content-Length': String(stream.contentLength) } : {}),
            'Cache-Control': 'private, max-age=86400, immutable',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      return new Response(file.bytes as any, {
        headers: {
          'Content-Type': mime,
          'Content-Length': String(file.bytes.byteLength),
          'Cache-Control': 'private, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return c.json({ error: { code: 'not_found', message: 'Avatar not found' } }, 404)
    }
  })

  return router
}

/** Backwards-compatible name for the local composer. */
export const localUserRoutes = userProfileRoutes
