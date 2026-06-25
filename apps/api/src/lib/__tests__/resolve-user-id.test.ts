// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for resolveUserHomeRegionUserId — the home-region router's
 * "which user does this identity write act on?" resolver.
 *
 *   bun test apps/api/src/lib/__tests__/resolve-user-id.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'

const notifications: Record<string, { userId: string } | null> = {
  notif_a: { userId: 'user_owner' },
}

mock.module('../prisma', () => ({
  prisma: {
    notification: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id in notifications ? notifications[id] : null,
    },
  },
}))

const { resolveUserHomeRegionUserId } = await import('../resolve-user-id')

function makeCtx(path: string, sessionUserId?: string) {
  return {
    get: (key: string) => (key === 'auth' ? { userId: sessionUserId } : undefined),
    req: { url: `https://eu.studio.shogo.ai${path}` },
  } as any
}

describe('resolveUserHomeRegionUserId', () => {
  test('/api/users/:id resolves to the path id', async () => {
    expect(await resolveUserHomeRegionUserId(makeCtx('/api/users/u123'))).toBe('u123')
  })

  test('/api/users/me falls back to the session user', async () => {
    expect(await resolveUserHomeRegionUserId(makeCtx('/api/users/me', 'sess_u'))).toBe('sess_u')
  })

  test('bare /api/users collection falls back to the session user', async () => {
    expect(await resolveUserHomeRegionUserId(makeCtx('/api/users', 'sess_u'))).toBe('sess_u')
  })

  test('a user-owned resource by id resolves to its owner', async () => {
    expect(await resolveUserHomeRegionUserId(makeCtx('/api/notifications/notif_a'))).toBe(
      'user_owner',
    )
  })

  test('a collection-level create on a user-owned resource uses the session user', async () => {
    expect(
      await resolveUserHomeRegionUserId(makeCtx('/api/notifications', 'sess_u')),
    ).toBe('sess_u')
  })

  test('an unknown user-owned resource id falls back to the session user', async () => {
    expect(
      await resolveUserHomeRegionUserId(makeCtx('/api/notifications/missing', 'sess_u')),
    ).toBe('sess_u')
  })

  test('self routes resolve to the session user', async () => {
    expect(
      await resolveUserHomeRegionUserId(makeCtx('/api/onboarding/complete', 'sess_u')),
    ).toBe('sess_u')
    expect(
      await resolveUserHomeRegionUserId(makeCtx('/api/affiliates/me/enroll', 'sess_u')),
    ).toBe('sess_u')
    expect(
      await resolveUserHomeRegionUserId(makeCtx('/api/users/me/attribution', 'sess_u')),
    ).toBe('sess_u')
  })

  test('non-identity paths resolve to null', async () => {
    expect(await resolveUserHomeRegionUserId(makeCtx('/api/projects/p1'))).toBeNull()
    expect(await resolveUserHomeRegionUserId(makeCtx('/api/workspaces/w1'))).toBeNull()
  })

  test('returns null when there is no session user and nothing else resolves', async () => {
    expect(await resolveUserHomeRegionUserId(makeCtx('/api/notifications'))).toBeNull()
  })
})
