// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

let findManyImpl: (args: { where: { instanceId: string } }) => Promise<Array<{ pushToken: string }>> =
  async () => []

mock.module('../prisma', () => ({
  prisma: {
    pushSubscription: {
      findMany: (args: any) => findManyImpl(args),
    },
  },
}))

const { sendPushToInstance } = await import('../push-notifications')

let fetchSpy: ReturnType<typeof spyOn>
let errorSpy: ReturnType<typeof spyOn>
let lastFetchArgs: any[] = []

beforeEach(() => {
  lastFetchArgs = []
  fetchSpy = spyOn(global, 'fetch').mockImplementation(async (...args: any[]) => {
    lastFetchArgs = args
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  findManyImpl = async () => []
})

afterEach(() => {
  fetchSpy.mockRestore()
  errorSpy.mockRestore()
})

describe('sendPushToInstance', () => {
  it('skips the network call entirely when no subscriptions match', async () => {
    findManyImpl = async () => []
    await sendPushToInstance('instance-1', { type: 'wake' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs one Expo message per subscription token', async () => {
    findManyImpl = async () => [{ pushToken: 'tok-a' }, { pushToken: 'tok-b' }]
    await sendPushToInstance('instance-1', { type: 'wake' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(lastFetchArgs[0]).toBe(EXPO_PUSH_URL)
    const init = lastFetchArgs[1]
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(body).toHaveLength(2)
    expect(body[0].to).toBe('tok-a')
    expect(body[1].to).toBe('tok-b')
  })

  it('attaches payload + instanceId in data and sets channelId to remote-control', async () => {
    findManyImpl = async () => [{ pushToken: 'tok-a' }]
    await sendPushToInstance('inst-42', { type: 'wake', foo: 'bar' })
    const body = JSON.parse(lastFetchArgs[1].body)
    expect(body[0].data).toEqual({ type: 'wake', foo: 'bar', instanceId: 'inst-42' })
    expect(body[0].channelId).toBe('remote-control')
  })

  it("defaults priority to 'high' when payload omits it", async () => {
    findManyImpl = async () => [{ pushToken: 'tok-a' }]
    await sendPushToInstance('inst-1', { type: 'wake' })
    const body = JSON.parse(lastFetchArgs[1].body)
    expect(body[0].priority).toBe('high')
  })

  it("honours explicit payload.priority='default'", async () => {
    findManyImpl = async () => [{ pushToken: 'tok-a' }]
    await sendPushToInstance('inst-1', { type: 'wake', priority: 'default' })
    const body = JSON.parse(lastFetchArgs[1].body)
    expect(body[0].priority).toBe('default')
  })

  it('logs an error but does not throw when Expo returns non-2xx', async () => {
    findManyImpl = async () => [{ pushToken: 'tok-a' }]
    fetchSpy.mockImplementation(async () => new Response('nope', { status: 500 }))
    await expect(sendPushToInstance('inst-1', { type: 'wake' })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    const msg = (errorSpy.mock.calls[0] ?? [])[0]
    expect(String(msg)).toContain('HTTP 500')
  })

  it('swallows fetch errors and logs them (network unreachable)', async () => {
    findManyImpl = async () => [{ pushToken: 'tok-a' }]
    fetchSpy.mockImplementation(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(sendPushToInstance('inst-1', { type: 'wake' })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    const msg = (errorSpy.mock.calls[0] ?? []).join(' ')
    expect(msg).toContain('ECONNREFUSED')
  })

  it('swallows prisma errors and logs them', async () => {
    findManyImpl = async () => {
      throw new Error('db gone')
    }
    await expect(sendPushToInstance('inst-1', { type: 'wake' })).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('overrides any instanceId provided in payload with the function argument', async () => {
    findManyImpl = async () => [{ pushToken: 'tok-a' }]
    await sendPushToInstance('canonical-id', {
      type: 'wake',
      instanceId: 'attacker-supplied',
    })
    const body = JSON.parse(lastFetchArgs[1].body)
    expect(body[0].data.instanceId).toBe('canonical-id')
  })
})
