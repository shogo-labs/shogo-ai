// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Marketplace Feature-Flag Middleware
 *
 * Gate for marketplace MUTATION routes — install / update / creator
 * publish / admin moderation. Reads the `feature.marketplace`
 * PlatformSetting row that the studio admin UI already manages.
 *
 * Design:
 *
 *   - `value === 'true'`  ⇒ allow.
 *   - `value === 'false'` ⇒ 503 `marketplace_disabled`.
 *   - row absent          ⇒ 503 `marketplace_disabled`.
 *
 * The "absent ⇒ deny" rule is INTENTIONALLY asymmetric with the
 * `/api/config` UI flag default ("absent ⇒ allow", in `server.ts`).
 * The mismatch is deliberate: when a brand-new region's DB has yet
 * to be seeded, we want the UI default of "show the tab" to hold so
 * local/desktop dev and staging keep working, but we want the
 * server-side mutation default to be "deny" so a forgotten seed in a
 * new prod region cannot accidentally open marketplace writes before
 * an operator has signed off.
 *
 * Bypass conditions (always allow regardless of the flag):
 *
 *   - `NODE_ENV === 'test'`    — keeps the test suite from having to
 *                                seed a PlatformSetting fixture in
 *                                every install/update test.
 *   - `SHOGO_LOCAL_MODE=true`  — local/desktop reverse-proxies every
 *                                marketplace request to Shogo Cloud
 *                                (see `marketplace.ts` top-of-file
 *                                forward proxy), so the gate would
 *                                never see those requests anyway,
 *                                but we belt-and-brace it here too.
 *
 * Cache: a 15-second in-memory TTL avoids hitting Prisma on every
 * install request. The flag changes infrequently (operator action
 * via Studio admin) and 15s of staleness is acceptable as the
 * trade-off.
 */

import type { Context, Next } from 'hono'
import { prisma } from '../lib/prisma'

const CACHE_TTL_MS = 15_000
const FLAG_KEY = 'feature.marketplace'

interface CacheEntry {
  enabled: boolean
  expiresAt: number
}

let cache: CacheEntry | null = null

/**
 * Read the `feature.marketplace` flag, honoring the in-memory cache.
 * Exported for tests and for the `/install` happy-path probe.
 */
export async function isMarketplaceEnabled(now = Date.now()): Promise<boolean> {
  if (cache && cache.expiresAt > now) return cache.enabled

  let enabled = false
  try {
    const row = await prisma.platformSetting.findUnique({
      where: { key: FLAG_KEY },
      select: { value: true },
    })
    enabled = row?.value === 'true'
  } catch (err) {
    // If Prisma is unhealthy we fail CLOSED — surfacing as
    // `marketplace_disabled` is far less surprising than letting an
    // installer touch S3 against a half-broken DB. The auth middleware
    // ahead of this gate would also be failing in this scenario, so
    // most calls already 500 before reaching us.
    console.error('[marketplace-feature] failed to read PlatformSetting:', (err as Error).message)
    enabled = false
  }

  cache = { enabled, expiresAt: now + CACHE_TTL_MS }
  return enabled
}

/**
 * Hono middleware wrapping `isMarketplaceEnabled`. Apply per-route
 * (or via `app.use(path, …)`) on every mutation that should be
 * gated; do NOT apply globally — read paths must stay open so the
 * marketplace catalog remains inspectable when the flag is off.
 */
export async function requireMarketplaceFeature(c: Context, next: Next) {
  if (process.env.NODE_ENV === 'test') return next()
  if (process.env.SHOGO_LOCAL_MODE === 'true') return next()

  const enabled = await isMarketplaceEnabled()
  if (!enabled) {
    return c.json(
      {
        error: {
          code: 'marketplace_disabled',
          message: 'Marketplace is currently disabled on this deployment.',
        },
      },
      503,
    )
  }
  return next()
}

/** Visible for tests — drops the cached flag so env or DB changes take effect immediately. */
export function _resetMarketplaceFeatureCacheForTests(): void {
  cache = null
}
