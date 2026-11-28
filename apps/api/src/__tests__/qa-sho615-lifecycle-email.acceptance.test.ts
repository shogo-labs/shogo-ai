// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-615 growth §0 card 4/5: recover users who stall.
 *
 * The behavioural half lives in abandoned-checkout.service.test.ts,
 * lifecycle-nurture.test.ts and email-unsubscribe.test.ts. What cannot be
 * exercised without booting the whole API is the *wiring*: the checkout routes
 * put `userId` in session metadata and ask Stripe for a recovery URL, the webhook
 * dispatches `checkout.session.expired`, the nurture cron is scheduled and
 * registered, and the unsubscribe path is public. Those are pinned here as
 * source assertions (the same approach the SHO-598 acceptance test uses).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf-8')

describe('SHO-615 acceptance', () => {
  const server = read('apps/api/src/server.ts')

  test('both checkout routes carry userId in session metadata', () => {
    // /api/billing/checkout: added conditionally (an unauthenticated attempt has none).
    expect(server).toContain('...(userId ? { userId } : {})')
    // /api/billing/workspace-checkout: userId is required there.
    const metadataBlocks = server.match(/const metadata: Record<string, string> = \{[\s\S]*?\n    \}/g) ?? []
    expect(metadataBlocks.some((b) => /\buserId,\n/.test(b))).toBe(true)
  })

  test('every subscription checkout asks Stripe for a recovery URL', () => {
    // Regular + workspace creates in server.ts, and the Solo Founder builder.
    expect((server.match(/after_expiration: \{ recovery: \{ enabled: true \} \}/g) ?? []).length).toBeGreaterThanOrEqual(2)
    const solo = read('apps/api/src/services/solo-founder.service.ts')
    expect(solo).toContain('after_expiration: { recovery: { enabled: true } }')
  })

  test('the Stripe webhook dispatches checkout.session.expired to the recovery service', () => {
    expect(server).toContain("case 'checkout.session.expired'")
    expect(server).toContain("handleCheckoutSessionExpired")
  })

  test('the nurture cron is scheduled', () => {
    expect(server).toContain('startLifecycleNurtureCron')
  })

  test('the unsubscribe route is public and mounted', () => {
    expect(read('apps/api/src/middleware/api-auth-gate.ts')).toContain("'/api/email/unsubscribe'")
    expect(server).toContain("app.route('/api/email', emailUnsubscribeRoutes())")
  })

  test('the lifecycle ledger and opt-out column are in all three schemas', () => {
    for (const rel of ['prisma/schema.prisma', 'prisma/schema.local.prisma', 'apps/desktop/prisma/schema.prisma']) {
      const s = read(rel)
      expect(s).toContain('model LifecycleEmailSend')
      expect(s).toContain('lifecycleEmailOptOutAt')
    }
  })

  test('both migration tracks create the ledger table and the column', () => {
    const pg = read('prisma/migrations/20261128180311_sho615_lifecycle_email/migration.sql')
    const sqlite = read('apps/desktop/prisma/migrations/20261128180311_sho615_lifecycle_email/migration.sql')
    for (const sql of [pg, sqlite]) {
      expect(sql).toContain('lifecycle_email_sends')
      expect(sql).toContain('lifecycleEmailOptOutAt')
    }
  })
})
