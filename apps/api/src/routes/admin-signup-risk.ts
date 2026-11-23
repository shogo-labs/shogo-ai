// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Super-admin review of signup risk assessments + abuse flags.
 *
 * Mounted at `/api/admin/signup-risk` (super-admin middleware applied in
 * server.ts). Shows every scored signup with linked accounts, and lets an
 * admin approve credit, revoke it, or issue a real ban (SHO-459: now sets
 * User.bannedAt, kills sessions, revokes keys, stops runtimes).
 *
 * Abuse sub-routes:
 *   GET  /abuse?status=     – list abuse flags
 *   GET  /abuse/:userId     – flag detail + links + paid status + ban status
 *   POST /:userId/ban       – real ban (now calls banUser)
 *   POST /:userId/unban     – unban
 *   POST /abuse/:flagId/clear – clear one flag
 */

import { Hono, type Context } from 'hono'
import { prisma } from '../lib/prisma'
import {
  approveSignupCredit,
  revokeSignupCredit,
} from '../services/signup-credit.service'
import { banUser, unbanUser } from '../services/abuse/ban'

const DAY_MS = 24 * 60 * 60 * 1000

type LinkKind = 'ip' | 'ipPrefix' | 'device' | 'email'

function linkKinds(
  a: { ip: string | null; ipPrefix: string | null; deviceId: string | null; emailCanonical: string | null },
  b: { ip: string | null; ipPrefix: string | null; deviceId: string | null; emailCanonical: string | null },
): LinkKind[] {
  const kinds: LinkKind[] = []
  if (a.ip && a.ip === b.ip) kinds.push('ip')
  else if (a.ipPrefix && a.ipPrefix === b.ipPrefix) kinds.push('ipPrefix')
  if (a.deviceId && a.deviceId === b.deviceId) kinds.push('device')
  if (a.emailCanonical && a.emailCanonical === b.emailCanonical) kinds.push('email')
  return kinds
}

function adminUserIdOf(c: Context): string | null {
  const id = (c.get('auth') as { userId?: unknown } | undefined)?.userId
  return typeof id === 'string' && id ? id : null
}

export function adminSignupRiskRoutes() {
  const app = new Hono()

  /** GET /api/admin/signup-risk?band=high|medium|low&pending=1 — review queue + 30-day summary. */
  app.get('/', async (c) => {
    const band = c.req.query('band')
    const pending = c.req.query('pending') === '1'
    const since = new Date(Date.now() - 30 * DAY_MS)

    const rows = await prisma.signupRiskAssessment.findMany({
      where: {
        ...(pending ? { reviewDecision: null, band: { in: ['medium', 'high'] } } : {}),
        ...(band ? { band } : {}),
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })
    const users = await prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true, bannedAt: true },
    })
    const userById = new Map(users.map((u) => [u.id, u]))

    const recent = await prisma.signupRiskAssessment.groupBy({
      by: ['band', 'decision'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    })

    return c.json({
      summary: {
        windowDays: 30,
        byBandAndDecision: recent.map((r) => ({
          band: r.band,
          decision: r.decision,
          count: r._count._all,
        })),
      },
      items: rows.map((r) => ({
        userId: r.userId,
        email: userById.get(r.userId)?.email ?? null,
        name: userById.get(r.userId)?.name ?? null,
        emailVerified: userById.get(r.userId)?.emailVerified ?? false,
        createdAt: userById.get(r.userId)?.createdAt ?? null,
        bannedAt: userById.get(r.userId)?.bannedAt ?? null,
        score: r.score,
        band: r.band,
        decision: r.decision,
        reviewDecision: r.reviewDecision,
        reviewedAt: r.reviewedAt,
        ip: r.ip,
        ipPrefix: r.ipPrefix,
        country: r.country,
        deviceId: r.deviceId,
        signals: r.signals,
      })),
    })
  })

  /** GET /api/admin/signup-risk/:userId — one assessment with linked accounts. */
  app.get('/:userId', async (c) => {
    const userId = c.req.param('userId')
    const assessment = await prisma.signupRiskAssessment.findUnique({ where: { userId } })
    if (!assessment) return c.json({ ok: false, error: 'not_found' }, 404)

    const ors: Array<Record<string, string>> = []
    if (assessment.ip) ors.push({ ip: assessment.ip })
    if (assessment.ipPrefix) ors.push({ ipPrefix: assessment.ipPrefix })
    if (assessment.deviceId) ors.push({ deviceId: assessment.deviceId })
    if (assessment.emailCanonical) ors.push({ emailCanonical: assessment.emailCanonical })

    const candidates = ors.length
      ? await prisma.signupRiskAssessment.findMany({
          where: { userId: { not: userId }, OR: ors },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      : []

    const linkedUserIds = Array.from(new Set(candidates.map((r) => r.userId)))
    const allIds = [userId, ...linkedUserIds]
    const users = await prisma.user.findMany({
      where: { id: { in: allIds } },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true, bannedAt: true },
    })
    const userById = new Map(users.map((u) => [u.id, u]))

    const owners = await prisma.member.findMany({
      where: { userId: { in: allIds }, role: 'owner', projectId: null },
      select: { userId: true, workspaceId: true },
    })
    const subs = await prisma.subscription.findMany({
      where: {
        workspaceId: { in: owners.map((o) => o.workspaceId).filter((w): w is string => !!w) },
        status: { in: ['active', 'trialing'] },
      },
      select: { workspaceId: true, status: true, planId: true },
    })
    const subByWorkspace = new Map(subs.map((s) => [s.workspaceId, s]))
    const paidByUser = new Map<string, { planId: string; status: string }>()
    for (const o of owners) {
      const sub = o.workspaceId ? subByWorkspace.get(o.workspaceId) : undefined
      if (sub && !paidByUser.has(o.userId)) paidByUser.set(o.userId, { planId: sub.planId, status: sub.status })
    }

    const toView = (uid: string, a: typeof assessment) => {
      const u = userById.get(uid)
      const paid = paidByUser.get(uid) ?? null
      return {
        userId: uid,
        email: u?.email ?? null,
        name: u?.name ?? null,
        emailVerified: u?.emailVerified ?? false,
        createdAt: u?.createdAt ?? null,
        bannedAt: u?.bannedAt ?? null,
        paid,
        ip: a.ip,
        ipPrefix: a.ipPrefix,
        deviceId: a.deviceId,
        emailCanonical: a.emailCanonical,
      }
    }

    const seen = new Set<string>()
    const linked = candidates
      .filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)))
      .map((r) => ({
        ...toView(r.userId, r),
        linkedBy: linkKinds(assessment, r),
        band: r.band,
        score: r.score,
        decision: r.decision,
      }))

    return c.json({
      ok: true,
      subject: {
        ...toView(userId, assessment),
        band: assessment.band,
        score: assessment.score,
        decision: assessment.decision,
        reviewDecision: assessment.reviewDecision,
        reviewedAt: assessment.reviewedAt,
        signals: assessment.signals,
        country: assessment.country,
      },
      linked,
    })
  })

  /** POST /api/admin/signup-risk/:userId/approve — grant the full $10 now. */
  app.post('/:userId/approve', async (c) => {
    const adminUserId = adminUserIdOf(c)
    if (!adminUserId) return c.json({ ok: false, error: 'unauthorized' }, 401)
    const userId = c.req.param('userId')
    const result = await approveSignupCredit({ userId, adminUserId })
    return c.json({ ok: true, ...result })
  })

  /** POST /api/admin/signup-risk/:userId/revoke — zero remaining credit, stop releases. */
  app.post('/:userId/revoke', async (c) => {
    const adminUserId = adminUserIdOf(c)
    if (!adminUserId) return c.json({ ok: false, error: 'unauthorized' }, 401)
    const userId = c.req.param('userId')
    const result = await revokeSignupCredit({ userId, adminUserId, reviewDecision: 'revoked' })
    return c.json({ ok: true, ...result })
  })

  /**
   * POST /api/admin/signup-risk/:userId/ban — real ban (SHO-459).
   * Sets User.bannedAt, kills sessions, revokes keys, cancels trial, stops runtimes.
   */
  app.post('/:userId/ban', async (c) => {
    const adminUserId = adminUserIdOf(c)
    if (!adminUserId) return c.json({ ok: false, error: 'unauthorized' }, 401)
    const userId = c.req.param('userId')
    const body = await c.req.json().catch(() => ({}))
    const reason: string = body?.reason ?? 'admin-ban'
    const result = await banUser({ userId, reason, bannedByUserId: adminUserId })
    return c.json({ ok: true, ...result })
  })

  /**
   * POST /api/admin/signup-risk/:userId/unban — lift a ban.
   */
  app.post('/:userId/unban', async (c) => {
    const adminUserId = adminUserIdOf(c)
    if (!adminUserId) return c.json({ ok: false, error: 'unauthorized' }, 401)
    const userId = c.req.param('userId')
    await unbanUser({ userId, adminUserId })
    return c.json({ ok: true })
  })

  // =========================================================================
  // Abuse sub-routes (SHO-459)
  // =========================================================================

  /** GET /api/admin/signup-risk/abuse?status=flagged|banned|cleared */
  app.get('/abuse', async (c) => {
    const status = c.req.query('status')
    const db = prisma as any
    const flags = await db.abuseFlag.findMany({
      where: status ? { status } : {},
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
      include: { user: { select: { email: true, bannedAt: true } } },
    })
    return c.json({
      ok: true,
      flags: flags.map((f: any) => ({
        id: f.id,
        userId: f.userId,
        email: f.user?.email ?? null,
        bannedAt: f.user?.bannedAt ?? null,
        runDate: f.runDate,
        category: f.category,
        severity: f.severity,
        confidence: f.confidence,
        status: f.status,
        decidedByUserId: f.decidedByUserId,
        decidedAt: f.decidedAt,
        clusterKey: f.clusterKey,
        createdAt: f.createdAt,
      })),
    })
  })

  /** GET /api/admin/signup-risk/abuse/:userId — flags + evidence for one user. */
  app.get('/abuse/:userId', async (c) => {
    const userId = c.req.param('userId')
    const db = prisma as any
    const [flags, user, assessment] = await Promise.all([
      db.abuseFlag.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }],
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, createdAt: true, bannedAt: true, banReason: true },
      }),
      prisma.signupRiskAssessment.findUnique({
        where: { userId },
        select: { ipPrefix: true, deviceId: true, emailCanonical: true },
      }),
    ])
    if (!user) return c.json({ ok: false, error: 'not_found' }, 404)

    // Linked accounts sharing ipPrefix/deviceId/emailCanonical.
    const ors: any[] = []
    if (assessment?.ipPrefix) ors.push({ ipPrefix: assessment.ipPrefix })
    if (assessment?.deviceId) ors.push({ deviceId: assessment.deviceId })
    if (assessment?.emailCanonical) ors.push({ emailCanonical: assessment.emailCanonical })

    const linked = ors.length
      ? await prisma.signupRiskAssessment.findMany({
          where: { userId: { not: userId }, OR: ors },
          select: { userId: true, ipPrefix: true, deviceId: true, emailCanonical: true },
          take: 30,
        })
      : []

    const isPaid = !!(await prisma.subscription.findFirst({
      where: {
        status: { in: ['active', 'trialing', 'past_due'] },
        workspace: { members: { some: { userId, role: 'owner', projectId: null } } },
      },
      select: { id: true },
    }))

    return c.json({ ok: true, user: { ...user, isPaid }, flags, linked })
  })

  /** POST /api/admin/signup-risk/abuse/:flagId/clear */
  app.post('/abuse/:flagId/clear', async (c) => {
    const adminUserId = adminUserIdOf(c)
    if (!adminUserId) return c.json({ ok: false, error: 'unauthorized' }, 401)
    const flagId = c.req.param('flagId')
    const db = prisma as any
    await db.abuseFlag.update({
      where: { id: flagId },
      data: { status: 'cleared', decidedByUserId: adminUserId, decidedAt: new Date() },
    })
    return c.json({ ok: true })
  })

  return app
}
