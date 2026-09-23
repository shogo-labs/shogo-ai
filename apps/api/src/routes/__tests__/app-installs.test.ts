// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const upsert = mock(async ({ create }: any) => ({ id: create.deviceId }))

mock.module('../../lib/prisma', () => ({
  prisma: {
    appInstall: { upsert },
  },
}))

const { appInstallRoutes } = await import('../app-installs')

function authenticatedApp(userId = 'user-1') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { userId, isAuthenticated: true })
    await next()
  })
  app.route('/', appInstallRoutes())
  return app
}

beforeEach(() => {
  upsert.mockClear()
})

describe('POST /app-installs/heartbeat', () => {
  test('requires authentication', async () => {
    const response = await appInstallRoutes().request('http://api.test/app-installs/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'ios-1', platform: 'ios' }),
    })

    expect(response.status).toBe(401)
  })

  test('validates device id and mobile platform', async () => {
    const response = await authenticatedApp().request('http://api.test/app-installs/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: '', platform: 'darwin' }),
    })

    expect(response.status).toBe(400)
    expect(upsert).not.toHaveBeenCalled()
  })

  test('upserts the install and refreshes its metadata', async () => {
    const firstResponse = await authenticatedApp().request('http://api.test/app-installs/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'ios-1',
        platform: 'IOS',
        appVersion: ' 3.0.0 ',
        osVersion: '18.6',
        deviceModel: 'iPhone 17',
      }),
    })

    const secondResponse = await authenticatedApp('user-2').request('http://api.test/app-installs/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'ios-1',
        platform: 'IOS',
        appVersion: ' 3.0.0 ',
        osVersion: '18.6',
        deviceModel: 'iPhone 17',
      }),
    })

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(await secondResponse.json()).toEqual({ ok: true, id: 'ios-1' })
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: { deviceId: 'ios-1' },
      create: {
        deviceId: 'ios-1',
        platform: 'ios',
        appVersion: '3.0.0',
        osVersion: '18.6',
        deviceModel: 'iPhone 17',
        userId: 'user-1',
      },
      update: {
        platform: 'ios',
        appVersion: '3.0.0',
        osVersion: '18.6',
        deviceModel: 'iPhone 17',
        userId: 'user-1',
      },
    })
    expect(upsert.mock.calls[0][0].create.lastSeenAt).toBeInstanceOf(Date)
    expect(upsert.mock.calls[0][0].update.lastSeenAt).toBeInstanceOf(Date)
    expect(upsert.mock.calls[1][0]).toMatchObject({
      where: { deviceId: 'ios-1' },
      update: { userId: 'user-2', lastSeenAt: expect.any(Date) },
    })
  })
})
