// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * License key routes — split into two routers because they have
 * different auth requirements:
 *
 *   - `licenseKeyAdminRoutes()` mounts under `/api/admin` and requires
 *     `super_admin` for mint / list / revoke. Plaintext keys are
 *     returned exactly once from `mint` and never persisted, so the
 *     admin UI is responsible for capturing the response (CSV download
 *     is the recommended flow).
 *
 *   - `licenseKeyRoutes()` mounts under `/api` and offers the
 *     workspace-member redeem endpoint. Any member of the target
 *     workspace can redeem because the key itself proves intent; we
 *     don't require `owner` so an invited teammate can redeem a coupon
 *     they were handed for that workspace.
 *
 * After a successful redeem we call `applyGrantMonthlyAllocation` so
 * the wallet picks up the new allotment immediately rather than
 * waiting for the next monthly cron tick.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware, requireAuth } from '../middleware/auth'
import { requireSuperAdmin } from '../middleware/super-admin'
import { prisma } from '../lib/prisma'
import { applyGrantMonthlyAllocation } from '../services/billing.service'
import {
  LicenseKeyRedeemError,
  listLicenseKeys,
  mintLicenseKeys,
  redeemLicenseKey,
  revokeLicenseKey,
} from '../services/license-key.service'

// ----------------------------------------------------------------------------
// Admin (super_admin only)
// ----------------------------------------------------------------------------

const mintSchema = z.object({
  count: z.number().int().min(1).max(10_000),
  planId: z.string().min(1),
  durationDays: z.number().int().positive().nullable().optional(),
  monthlyIncludedUsd: z.number().nonnegative().optional(),
  freeSeats: z.number().int().nonnegative().optional(),
  batchId: z.string().nullable().optional(),
  codePrefix: z.string().min(1).max(32).optional(),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional()
    .transform((v) => (v ? new Date(v) : v === null ? null : undefined)),
  note: z.string().max(2000).nullable().optional(),
})

export function licenseKeyAdminRoutes(): Hono {
  const router = new Hono()
  router.use('*', authMiddleware)
  router.use('*', requireAuth)
  router.use('*', requireSuperAdmin)

  // POST /api/admin/license-keys/mint
  //
  // Returns plaintext codes ONCE. The admin UI is responsible for
  // downloading / displaying them — we cannot reproduce them later.
  router.post('/license-keys/mint', async (c) => {
    const auth = c.get('auth') as { userId?: string } | undefined
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    }
    const parsed = mintSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          },
        },
        400,
      )
    }
    try {
      const keys = await mintLicenseKeys({
        ...parsed.data,
        createdByUserId: auth?.userId ?? null,
      })
      return c.json({ ok: true, data: { keys, count: keys.length } })
    } catch (err: any) {
      console.error('[LicenseKeys] mint failed:', err)
      return c.json(
        { error: { code: 'mint_failed', message: err?.message ?? 'Failed to mint license keys' } },
        400,
      )
    }
  })

  // GET /api/admin/license-keys
  router.get('/license-keys', async (c) => {
    const url = new URL(c.req.url)
    const batchId = url.searchParams.get('batchId') ?? undefined
    const redeemedParam = url.searchParams.get('redeemed')
    const redeemed =
      redeemedParam === 'true' ? true : redeemedParam === 'false' ? false : undefined
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const items = await listLicenseKeys({ batchId, redeemed, limit, offset })
    return c.json({ ok: true, data: { items, count: items.length } })
  })

  // POST /api/admin/license-keys/:id/revoke
  router.post('/license-keys/:id/revoke', async (c) => {
    const id = c.req.param('id')
    const existing = await prisma.licenseKey.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ error: { code: 'not_found', message: 'License key not found' } }, 404)
    }
    if (existing.redeemedAt) {
      return c.json(
        {
          error: {
            code: 'already_redeemed',
            message:
              'License key has already been redeemed. Expire the originating WorkspaceGrant to remove the plan upgrade.',
          },
        },
        409,
      )
    }
    const updated = await revokeLicenseKey(id)
    return c.json({ ok: true, data: { id: updated.id, expiresAt: updated.expiresAt } })
  })

  return router
}

// ----------------------------------------------------------------------------
// Workspace member redeem
// ----------------------------------------------------------------------------

const redeemSchema = z.object({
  code: z.string().min(4).max(128),
})

export function licenseKeyRoutes(): Hono {
  const router = new Hono()
  // IMPORTANT: scope to /workspaces/:workspaceId/redeem-license, not '*'.
  // This router is mounted at /api in server.ts; a '*' middleware would
  // become part of the /api/* chain for every request, blocking
  // unauthenticated public endpoints (e.g. /api/affiliates/lookup) that
  // are mounted at /api *after* this router. See the matching fix in
  // userAttributionRoute (admin.ts) for context.
  router.use('/workspaces/:workspaceId/redeem-license', authMiddleware)
  router.use('/workspaces/:workspaceId/redeem-license', requireAuth)

  // POST /api/workspaces/:workspaceId/redeem-license
  router.post('/workspaces/:workspaceId/redeem-license', async (c) => {
    const auth = c.get('auth') as { userId?: string } | undefined
    const userId = auth?.userId
    if (!userId) {
      return c.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        401,
      )
    }
    const workspaceId = c.req.param('workspaceId')

    // Membership check. Any role can redeem (`owner` would be too
    // restrictive for the "team-mate hands me a coupon" flow), but the
    // user must be on the workspace they're redeeming into so they
    // can't park a coupon on a stranger's workspace.
    const member = await prisma.member.findFirst({
      where: { userId, workspaceId },
      select: { id: true },
    })
    if (!member) {
      return c.json(
        { error: { code: 'forbidden', message: 'Not a member of this workspace' } },
        403,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Body must be JSON' } }, 400)
    }
    const parsed = redeemSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          },
        },
        400,
      )
    }

    try {
      const result = await redeemLicenseKey({
        code: parsed.data.code,
        workspaceId,
        userId,
      })
      // Refresh the wallet so the new monthly allotment is available
      // immediately. We do this outside the redeem transaction so a
      // wallet upsert failure doesn't roll back the redemption — the
      // monthly refill cron will pick it up on the next tick as a
      // safety net.
      try {
        await applyGrantMonthlyAllocation(workspaceId)
      } catch (err) {
        console.error(
          '[LicenseKeys] post-redeem wallet refresh failed (cron will retry):',
          { workspaceId, grantId: result.grantId, err },
        )
      }
      return c.json({
        ok: true,
        data: {
          planId: result.planId,
          grantId: result.grantId,
          expiresAt: result.grantExpiresAt,
        },
      })
    } catch (err) {
      if (err instanceof LicenseKeyRedeemError) {
        const status = err.code === 'not_found' ? 404 : err.code === 'expired' ? 410 : 409
        return c.json({ error: { code: err.code, message: err.message } }, status)
      }
      console.error('[LicenseKeys] redeem failed:', err)
      return c.json(
        { error: { code: 'redeem_failed', message: 'Failed to redeem license key' } },
        500,
      )
    }
  })

  return router
}
