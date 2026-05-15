// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Mock prisma BEFORE importing push-notifications (static `import { prisma }`).
const findManyMock = mock(async (_args: any): Promise<any[]> => [])
mock.module('../lib/prisma', () => ({
  prisma: {
    pushSubscription: { findMany: findManyMock },
  },
}))

const { sendPushToInstance } = await import('../lib/push-notifications')

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const realFetch = globalThis.fetch

beforeEach(() => {
  findManyMock.mockReset()
  findManyMock.mockImplementation(async () => [])
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(response: { ok: boolean; status?: number }) {
  const fetchSpy = mock(async () => response as unknown as Response)
  globalThis.fetch = fetchSpy as unknown as typeof fetch
  return fetchSpy
}

describe('sendPushToInstance', () => {
  test('queries prisma for subscriptions scoped to the instance', async () => {
    findManyMock.mockImplementation(async () => [])
    const fetchSpy = mockFetch({ ok: true, status: 200 })

    await sendPushToInstance('inst_123', { type: 'wakeup' })

    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(findManyMock.mock.calls[0][0]).toEqual({
      where: { instanceId: 'inst_123' },
    })
    // No subscriptions → no HTTP call.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns silently (no fetch) when no subscriptions exist', async () => {
    findManyMock.mockImplementation(async () => [])
    const fetchSpy = mockFetch({ ok: true })

    await expect(sendPushToInstance('inst_none', { type: 'wakeup' })).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('POSTs one Expo message per subscription with merged data + instanceId', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'ExponentPushToken[aaa]', instanceId: 'inst_x' },
      { pushToken: 'ExponentPushToken[bbb]', instanceId: 'inst_x' },
    ])
    const fetchSpy = mockFetch({ ok: true, status: 200 })

    await sendPushToInstance('inst_x', { type: 'wakeup', sessionId: 'sess_1' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(EXPO_PUSH_URL)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    const body = JSON.parse(init.body as string)
    expect(body).toEqual([
      {
        to: 'ExponentPushToken[aaa]',
        data: { type: 'wakeup', sessionId: 'sess_1', instanceId: 'inst_x' },
        priority: 'high',
        channelId: 'remote-control',
      },
      {
        to: 'ExponentPushToken[bbb]',
        data: { type: 'wakeup', sessionId: 'sess_1', instanceId: 'inst_x' },
        priority: 'high',
        channelId: 'remote-control',
      },
    ])
  })

  test('defaults priority to "high" when payload omits it', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'i' },
    ])
    const fetchSpy = mockFetch({ ok: true })

    await sendPushToInstance('i', { type: 'wakeup' })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(body[0].priority).toBe('high')
  })

  test('respects an explicit priority: "default"', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'i' },
    ])
    const fetchSpy = mockFetch({ ok: true })

    await sendPushToInstance('i', { type: 'wakeup', priority: 'default' })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(body[0].priority).toBe('default')
  })

  test('always sets channelId to "remote-control"', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_a', instanceId: 'i' },
      { pushToken: 'tok_b', instanceId: 'i' },
    ])
    const fetchSpy = mockFetch({ ok: true })

    await sendPushToInstance('i', { type: 'wakeup' })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    for (const msg of body) expect(msg.channelId).toBe('remote-control')
  })

  test('instanceId in payload data takes the route argument, not the payload', async () => {
    // The function spreads `payload` first and then sets `instanceId` to the
    // route argument — so a caller-supplied instanceId in the payload IS
    // overwritten. Pin that contract.
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'inst_real' },
    ])
    const fetchSpy = mockFetch({ ok: true })

    await sendPushToInstance('inst_real', {
      type: 'wakeup',
      instanceId: 'inst_spoofed',
    })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(body[0].data.instanceId).toBe('inst_real')
  })

  test('logs an error (but does NOT throw) when Expo returns a non-2xx response', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'i' },
    ])
    mockFetch({ ok: false, status: 502 })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    await expect(sendPushToInstance('i', { type: 'wakeup' })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0].join(' ')).toContain('502')
    errorSpy.mockRestore()
  })

  test('swallows prisma errors and logs them (push must never break the caller)', async () => {
    findManyMock.mockImplementation(async () => {
      throw new Error('db unreachable')
    })
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    await expect(sendPushToInstance('i', { type: 'wakeup' })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0].join(' ')).toContain('db unreachable')
    errorSpy.mockRestore()
  })

  test('swallows fetch network errors and logs them', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'i' },
    ])
    const fetchSpy = mock(async () => {
      throw new Error('ECONNREFUSED')
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    await expect(sendPushToInstance('i', { type: 'wakeup' })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0].join(' ')).toContain('ECONNREFUSED')
    errorSpy.mockRestore()
  })

  test('forwards arbitrary extra payload fields to Expo data', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'i' },
    ])
    const fetchSpy = mockFetch({ ok: true })

    await sendPushToInstance('i', {
      type: 'wakeup',
      foo: 'bar',
      nested: { a: 1 },
      count: 42,
    })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(body[0].data).toEqual({
      type: 'wakeup',
      foo: 'bar',
      nested: { a: 1 },
      count: 42,
      instanceId: 'i',
    })
  })

  test('does not include title or body in the Expo message (data-only push)', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'i' },
    ])
    const fetchSpy = mockFetch({ ok: true })

    await sendPushToInstance('i', { type: 'wakeup' })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(body[0].title).toBeUndefined()
    expect(body[0].body).toBeUndefined()
  })

  test('hits the documented Expo push endpoint', async () => {
    findManyMock.mockImplementation(async () => [
      { pushToken: 'tok_1', instanceId: 'i' },
    ])
    const fetchSpy = mockFetch({ ok: true })

    await sendPushToInstance('i', { type: 'wakeup' })

    expect(fetchSpy.mock.calls[0][0]).toBe('https://exp.host/--/api/v2/push/send')
  })
})
