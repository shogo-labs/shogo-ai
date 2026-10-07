// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

let updates: Array<{ where: any; data: any }> = []
let matched = 1

mock.module('../../lib/prisma', () => ({
  prisma: {
    mobilePushSubscription: {
      updateMany: async (args: any) => (updates.push(args), { count: matched }),
    },
  },
}))

const { mobilePushRoutes } = await import('../mobile-push')

function app(userId: string | null = 'u1') {
  const a = new Hono()
  a.use('*', async (c, next) => {
    c.set('auth' as never, (userId ? { userId, isAuthenticated: true } : { isAuthenticated: false }) as never)
    await next()
  })
  a.route('/api', mobilePushRoutes())
  return a
}

const patch = (body: unknown, userId: string | null = 'u1') =>
  app(userId).request('/api/mobile-push-subscriptions/live-activity', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const TOKEN = 'AB12'.repeat(8)

beforeEach(() => {
  updates = []
  matched = 1
})

describe('PATCH /mobile-push-subscriptions/live-activity', () => {
  test('saves the activity token for this device and user, lower-cased', async () => {
    const res = await patch({ pushToken: 'ExponentPushToken[x]', activityToken: TOKEN })
    expect(res.status).toBe(200)
    expect(updates).toEqual([{ where: { userId: 'u1', pushToken: 'ExponentPushToken[x]' }, data: { liveActivityToken: TOKEN.toLowerCase() } }])
  })

  test('saves the push-to-start token, and null clears a token', async () => {
    await patch({ pushToken: 'p', pushToStartToken: TOKEN, activityToken: null })
    expect(updates[0].data).toEqual({ liveActivityPushToStartToken: TOKEN.toLowerCase(), liveActivityToken: null })
  })

  test('a token left out is not touched', async () => {
    await patch({ pushToken: 'p', pushToStartToken: TOKEN })
    expect(Object.keys(updates[0].data)).toEqual(['liveActivityPushToStartToken'])
  })

  test('rejects something that is not an APNs token', async () => {
    expect((await patch({ pushToken: 'p', activityToken: 'not a token!' })).status).toBe(400)
    expect((await patch({ pushToken: 'p', activityToken: 42 })).status).toBe(400)
    expect(updates).toEqual([])
  })

  test('needs a device and at least one token', async () => {
    expect((await patch({ activityToken: TOKEN })).status).toBe(400)
    expect((await patch({ pushToken: 'p' })).status).toBe(400)
  })

  test('a device that never registered for push is a 404', async () => {
    matched = 0
    expect((await patch({ pushToken: 'p', activityToken: TOKEN })).status).toBe(404)
  })

  test('needs sign-in', async () => {
    expect((await patch({ pushToken: 'p', activityToken: TOKEN }, null)).status).toBe(401)
  })
})
