// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra tests for src/lib/push-notifications.ts — exercises every
 * branch in `sendPushToInstance`:
 *
 *  - Zero subscriptions → no fetch call (early return).
 *  - Multiple subscriptions → one fetch with N messages.
 *  - `payload.priority` honored when set, defaults to "high" otherwise.
 *  - Expo POST !ok response → logs "Expo push failed: HTTP <status>"
 *    but does NOT throw to the caller.
 *  - `fetch` throwing → caught + logged.
 *  - `prisma.pushSubscription.findMany` throwing → caught + logged.
 *  - The Expo message shape: `to`, `data` (with merged instanceId),
 *    `channelId="remote-control"`.
 *
 *   bun test apps/api/src/__tests__/push-notifications-extra.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

interface Sub { pushToken: string; platform: string }
let subs: Sub[] = []
let findManyImpl: () => Promise<Sub[]> = async () => subs

mock.module('../lib/prisma', () => ({
  prisma: {
    pushSubscription: { findMany: () => findManyImpl() },
  },
}))

const { sendPushToInstance } = await import('../lib/push-notifications')

let fetchCalls: Array<{ url: string; init: any }> = []
let fetchImpl: () => Promise<Response> = async () => new Response(null, { status: 200 })

beforeEach(() => {
  fetchCalls = []
  subs = []
  findManyImpl = async () => subs
  fetchImpl = async () => new Response(null, { status: 200 })
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    fetchCalls.push({ url, init })
    return fetchImpl()
  }
})

afterEach(() => {
  delete (globalThis as any).fetch
})

describe('sendPushToInstance', () => {
  test('zero subscriptions → early return, no fetch call', async () => {
    subs = []
    await sendPushToInstance('inst-1', { type: 'wake' })
    expect(fetchCalls).toHaveLength(0)
  })

  test('single subscription → one fetch with one ExpoPushMessage', async () => {
    subs = [{ pushToken: 'ExpoPushToken[aaa]', platform: 'ios' }]
    await sendPushToInstance('inst-1', { type: 'wake' })

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://exp.host/--/api/v2/push/send')
    expect(fetchCalls[0].init.method).toBe('POST')
    expect(fetchCalls[0].init.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(fetchCalls[0].init.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0].to).toBe('ExpoPushToken[aaa]')
    expect(body[0].data.instanceId).toBe('inst-1')
    expect(body[0].data.type).toBe('wake')
    expect(body[0].priority).toBe('high')
    expect(body[0].channelId).toBe('remote-control')
  })

  test('multiple subscriptions → one batched fetch with N messages, instanceId injected', async () => {
    subs = [
      { pushToken: 'ExpoPushToken[a]', platform: 'ios' },
      { pushToken: 'ExpoPushToken[b]', platform: 'android' },
      { pushToken: 'ExpoPushToken[c]', platform: 'ios' },
    ]
    await sendPushToInstance('inst-99', { type: 'wake' })
    expect(fetchCalls).toHaveLength(1)
    const body = JSON.parse(fetchCalls[0].init.body)
    expect(body).toHaveLength(3)
    expect(body.map((m: any) => m.to)).toEqual([
      'ExpoPushToken[a]',
      'ExpoPushToken[b]',
      'ExpoPushToken[c]',
    ])
    for (const m of body) expect(m.data.instanceId).toBe('inst-99')
  })

  test('payload.priority="default" overrides the high default', async () => {
    subs = [{ pushToken: 'ExpoPushToken[a]', platform: 'ios' }]
    await sendPushToInstance('inst-1', { type: 'wake', priority: 'default' })
    const body = JSON.parse(fetchCalls[0].init.body)
    expect(body[0].priority).toBe('default')
  })

  test('payload.priority="high" explicit also works', async () => {
    subs = [{ pushToken: 'ExpoPushToken[a]', platform: 'ios' }]
    await sendPushToInstance('inst-1', { type: 'wake', priority: 'high' })
    const body = JSON.parse(fetchCalls[0].init.body)
    expect(body[0].priority).toBe('high')
  })

  test('Expo POST returning non-OK → logs an error but resolves normally', async () => {
    subs = [{ pushToken: 'ExpoPushToken[a]', platform: 'ios' }]
    fetchImpl = async () => new Response('rate limited', { status: 429 })
    const errs: any[][] = []
    const origErr = console.error
    console.error = (...a: any[]) => { errs.push(a) }
    await sendPushToInstance('inst-1', { type: 'wake' })
    console.error = origErr

    expect(fetchCalls).toHaveLength(1)
    expect(errs.some((c) => String(c[0]).includes('Expo push failed: HTTP 429'))).toBe(true)
  })

  test('fetch throwing is caught + logged (no rethrow)', async () => {
    subs = [{ pushToken: 'ExpoPushToken[a]', platform: 'ios' }]
    fetchImpl = async () => { throw new Error('ENOTFOUND exp.host') }
    const errs: any[][] = []
    const origErr = console.error
    console.error = (...a: any[]) => { errs.push(a) }
    await sendPushToInstance('inst-1', { type: 'wake' })
    console.error = origErr

    expect(errs.some((c) => String(c[0]).includes('Error sending push notification'))).toBe(true)
  })

  test('prisma read throwing is caught + logged (no rethrow)', async () => {
    findManyImpl = async () => { throw new Error('db gone') }
    const errs: any[][] = []
    const origErr = console.error
    console.error = (...a: any[]) => { errs.push(a) }
    await sendPushToInstance('inst-1', { type: 'wake' })
    console.error = origErr

    expect(fetchCalls).toHaveLength(0)
    expect(errs.some((c) => String(c[0]).includes('Error sending push notification'))).toBe(true)
  })

  test('arbitrary payload fields are propagated through data', async () => {
    subs = [{ pushToken: 'ExpoPushToken[a]', platform: 'ios' }]
    await sendPushToInstance('inst-1', {
      type: 'wake',
      url: 'shogo://open/p-1',
      extraNumeric: 42,
      extraBool: true,
    })
    const body = JSON.parse(fetchCalls[0].init.body)
    expect(body[0].data.url).toBe('shogo://open/p-1')
    expect(body[0].data.extraNumeric).toBe(42)
    expect(body[0].data.extraBool).toBe(true)
    expect(body[0].data.type).toBe('wake')
    expect(body[0].data.instanceId).toBe('inst-1')
  })

  test('instanceId in payload is overwritten by the function argument', async () => {
    subs = [{ pushToken: 'ExpoPushToken[a]', platform: 'ios' }]
    await sendPushToInstance('correct-id', {
      type: 'wake',
      instanceId: 'WRONG-from-payload',
    } as any)
    const body = JSON.parse(fetchCalls[0].init.body)
    expect(body[0].data.instanceId).toBe('correct-id')
  })
})
