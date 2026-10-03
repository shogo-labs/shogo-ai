// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Route tests for the Shogo buddy look in `routes/local-user.ts`:
 * `PUT /me/buddy` and the `buddyLook` field on `GET /me`.
 *
 *   bun test apps/api/src/routes/__tests__/local-user-buddy.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from '../../__tests__/helpers/prisma-mock-exports'

const s = {
  userUpdates: [] as any[],
  storedLook: null as string | null,
}

mock.module('../../lib/prisma', () => withPrismaExports({
  prisma: {
    user: {
      findUnique: async () => ({
        id: 'u-1',
        email: 'u@example.com',
        adminScopes: [],
        buddyLook: s.storedLook,
      }),
      update: async (args: any) => {
        s.userUpdates.push(args)
        return { id: args.where.id, ...args.data }
      },
    },
  },
}))

const { userProfileRoutes } = await import('../local-user')

function makeApp(userId: string | null = 'u-1') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth' as never, (userId ? { isAuthenticated: true, userId } : {}) as never)
    await next()
  })
  app.route('/api', userProfileRoutes())
  return app
}

function putLook(body: unknown, userId?: string | null) {
  return makeApp(userId).request('/api/me/buddy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const KITTY = {
  topper: 'ears',
  face: 'classic',
  tail: 'none',
  eyewear: 'none',
  neck: 'none',
  bolts: false,
  blush: true,
  color: null,
  finish: 'classic',
}
const FOX = { ...KITTY, topper: 'fox', tail: 'fox', eyewear: 'sunglasses' }

beforeEach(() => {
  s.userUpdates = []
  s.storedLook = null
})

describe('PUT /api/me/buddy', () => {
  test('stores a valid look as JSON', async () => {
    const res = await putLook(KITTY)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(KITTY)
    expect(s.userUpdates).toHaveLength(1)
    expect(s.userUpdates[0].where).toEqual({ id: 'u-1' })
    expect(JSON.parse(s.userUpdates[0].data.buddyLook)).toEqual(KITTY)
  })

  test('stores fox ears, a tail and sunglasses', async () => {
    const res = await putLook(FOX)
    expect(res.status).toBe(200)
    expect(JSON.parse(s.userUpdates[0].data.buddyLook)).toEqual(FOX)
  })

  test('defaults accessories for clients that predate them', async () => {
    const { tail: _tail, eyewear: _eyewear, neck: _neck, color: _color, finish: _finish, ...older } = KITTY
    const res = await putLook(older)
    expect(res.status).toBe(200)
    expect(JSON.parse(s.userUpdates[0].data.buddyLook)).toEqual(KITTY)
  })

  test('stores a body colour in upper case and the modern finish', async () => {
    const res = await putLook({ ...KITTY, color: '#0d9488', finish: 'modern' })
    expect(res.status).toBe(200)
    expect(JSON.parse(s.userUpdates[0].data.buddyLook)).toEqual({ ...KITTY, color: '#0D9488', finish: 'modern' })
  })

  test('rejects a colour that is not #RRGGBB or an unknown finish', async () => {
    expect((await putLook({ ...KITTY, color: 'teal' })).status).toBe(400)
    expect((await putLook({ ...KITTY, color: '#0d9' })).status).toBe(400)
    expect((await putLook({ ...KITTY, finish: 'matte' })).status).toBe(400)
    expect(s.userUpdates).toHaveLength(0)
  })

  test('rejects an unknown tail or eyewear', async () => {
    expect((await putLook({ ...FOX, tail: 'lion' })).status).toBe(400)
    expect((await putLook({ ...FOX, eyewear: 'pince-nez' })).status).toBe(400)
    expect(s.userUpdates).toHaveLength(0)
  })

  test('rejects an unknown topper without writing', async () => {
    const res = await putLook({ ...KITTY, topper: 'unicorn' })
    expect(res.status).toBe(400)
    expect(s.userUpdates).toHaveLength(0)
  })

  test('rejects extra fields', async () => {
    const res = await putLook({ ...KITTY, hat: 'fedora' })
    expect(res.status).toBe(400)
    expect(s.userUpdates).toHaveLength(0)
  })

  test('rejects a partial look', async () => {
    const res = await putLook({ topper: 'ears' })
    expect(res.status).toBe(400)
  })

  test('401s when unauthenticated', async () => {
    const res = await putLook(KITTY, null)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/me buddyLook', () => {
  test('returns the stored look', async () => {
    s.storedLook = JSON.stringify(KITTY)
    const res = await makeApp().request('/api/me')
    expect((await res.json()).data.buddyLook).toEqual(KITTY)
  })

  test('returns null when unset or corrupt', async () => {
    expect((await (await makeApp().request('/api/me')).json()).data.buddyLook).toBeNull()
    s.storedLook = '{nope'
    expect((await (await makeApp().request('/api/me')).json()).data.buddyLook).toBeNull()
  })
})
