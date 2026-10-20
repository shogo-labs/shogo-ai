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

const put = (body: unknown, userId: string | null = 'u1') =>
  app(userId).request('/api/mobile-push-subscriptions/voip', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const TOKEN = 'AB12'.repeat(16)

beforeEach(() => {
  updates = []
  matched = 1
})

describe('PUT /mobile-push-subscriptions/voip', () => {
  test('saves the VoIP token for this device and user, lower-cased', async () => {
    const res = await put({ pushToken: 'ExponentPushToken[x]', voipToken: TOKEN })
    expect(res.status).toBe(200)
    expect(updates).toEqual([{ where: { userId: 'u1', pushToken: 'ExponentPushToken[x]' }, data: { voipToken: TOKEN.toLowerCase() } }])
  })

  test('null clears the token, which turns off ringing for this device', async () => {
    const res = await put({ pushToken: 'p', voipToken: null })
    expect(res.status).toBe(200)
    expect(updates[0].data).toEqual({ voipToken: null })
  })

  test('rejects something that is not a PushKit token', async () => {
    expect((await put({ pushToken: 'p', voipToken: 'not a token!' })).status).toBe(400)
    expect((await put({ pushToken: 'p', voipToken: 42 })).status).toBe(400)
    expect(updates).toEqual([])
  })

  test('needs a device and a voipToken field', async () => {
    expect((await put({ voipToken: TOKEN })).status).toBe(400)
    expect((await put({ pushToken: 'p' })).status).toBe(400)
  })

  test('a device that never registered for push is a 404', async () => {
    matched = 0
    expect((await put({ pushToken: 'p', voipToken: TOKEN })).status).toBe(404)
  })

  test('needs sign-in', async () => {
    expect((await put({ pushToken: 'p', voipToken: TOKEN }, null)).status).toBe(401)
  })
})
