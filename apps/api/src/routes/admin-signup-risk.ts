// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Super-admin review of signup risk assessments.
 *
 * Mounted at `/api/admin/signup-risk` (super-admin middleware applied in
 * server.ts). Shows every scored signup with the accounts it's linked to
 * (same IP prefix, device id, or canonical email), and lets an admin approve
 * the full credit, revoke it, or ban (revoke + end sessions).
 *
 * Limitation: `User` has no banned flag, so "ban" can't block login outright.
 * It revokes the credit and ends existing sessions; a repeat sign-in is still
 * possible and gets scored again.
 */

import { Hono, type Context } from 'hono'
import { prisma } from '../lib/prisma'
import {
  approveSignupCredit,
  revokeSignupCredit,
} from '../services/signup-credit.service'

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
        // `pending` narrows to unreviewed medium/high; an explicit band wins.
        ...(pending ? { reviewDecision: null, band: { in: ['medium', 'high'] } } : {}),
        ...(band ? { band } : {}),
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    })
    const users = await prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
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
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    })
    const userById = new Map(users.map((u) => [u.id, u]))

    // Paid = owns a workspace with an active or trialing subscription.
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
   * POST /api/admin/signup-risk/:userId/ban — revoke credit and end every
   * session. There is no banned flag on User, so this does not block future
   * sign-ins (see module header).
   */
  app.post('/:userId/ban', async (c) => {
    const adminUserId = adminUserIdOf(c)
    if (!adminUserId) return c.json({ ok: false, error: 'unauthorized' }, 401)
    const userId = c.req.param('userId')
    const result = await revokeSignupCredit({ userId, adminUserId, reviewDecision: 'banned' })
    const ended = await prisma.session.deleteMany({ where: { userId } })
    return c.json({ ok: true, revokedUsd: result.revokedUsd, sessionsEnded: ended.count })
  })

  return app
}
