// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Devices that turn off agent turn pushes still get team chat pushes:
 * registration stores `agentTurns`, and `sendPushToUser` filters by audience.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { sendPushToUser } = await import('../lib/push-notifications')
const { mobilePushRoutes } = await import('../routes/mobile-push')

const db = prisma as any
let seed: SeededWorkspace
const realFetch = globalThis.fetch
let sentTo: string[][] = []

const app = new Hono()
app.use('*', async (c, next) => {
  c.set('auth' as never, { userId: c.req.header('x-user'), isAuthenticated: true } as never)
  await next()
})
app.route('/api', mobilePushRoutes())

async function register(user: string, pushToken: string, agentTurns?: boolean) {
  const res = await app.request('/api/mobile-push-subscriptions', {
    method: 'POST',
    headers: { 'x-user': user, 'content-type': 'application/json' },
    body: JSON.stringify({ pushToken, platform: 'ios', ...(agentTurns === undefined ? {} : { agentTurns }) }),
  })
  expect(res.status).toBe(200)
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  ;(globalThis as any).fetch = async (_url: string, init: any) => {
    sentTo.push(JSON.parse(init.body).map((m: any) => m.to))
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
})

afterEach(() => {
  sentTo = []
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('push audiences', () => {
  test('registration defaults to agent pushes on and can opt out; re-registering updates it', async () => {
    await register(seed.owner, 'tok-phone')
    await register(seed.owner, 'tok-tablet', false)
    const rows = await db.mobilePushSubscription.findMany({ where: { userId: seed.owner }, orderBy: { pushToken: 'asc' } })
    expect(rows.map((r: any) => [r.pushToken, r.agentTurns])).toEqual([['tok-phone', true], ['tok-tablet', false]])
  })

  test('agent pushes skip opted-out devices; chat pushes reach every device', async () => {
    await sendPushToUser(seed.owner, { title: 'Turn finished', body: 'Done' })
    await sendPushToUser(seed.owner, { title: '#general', body: 'hi', type: 'channel-message', channelId: 'messages', audience: 'chat' })
    expect(sentTo).toEqual([['tok-phone'], ['tok-phone', 'tok-tablet']])
  })

  test('turning agent pushes back on takes effect on the next registration', async () => {
    await register(seed.owner, 'tok-tablet', true)
    await sendPushToUser(seed.owner, { title: 'Turn finished', body: 'Done' })
    expect(sentTo[0]!.sort()).toEqual(['tok-phone', 'tok-tablet'])
  })
})
