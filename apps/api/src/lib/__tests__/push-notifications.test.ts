// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

let findManyImpl: (args: { where: { instanceId: string } }) => Promise<Array<{ pushToken: string }>> =
  async () => []
let mobileFindManyImpl: () => Promise<Array<{ pushToken: string }>> = async () => []
let instanceDeleteManyImpl: (args: any) => Promise<unknown> = async () => ({ count: 0 })
let mobileDeleteManyImpl: (args: any) => Promise<unknown> = async () => ({ count: 0 })
let instanceDeleteManyArgs: any = null
let mobileDeleteManyArgs: any = null

mock.module('../prisma', () => ({
  prisma: {
    pushSubscription: {
      findMany: (args: any) => findManyImpl(args),
      deleteMany: (args: any) => {
        instanceDeleteManyArgs = args
        return instanceDeleteManyImpl(args)
      },
    },
    mobilePushSubscription: {
      findMany: () => mobileFindManyImpl(),
      deleteMany: (args: any) => {
        mobileDeleteManyArgs = args
        return mobileDeleteManyImpl(args)
      },
    },
  },
}))

const { sendPushToInstance, sendPushToUser } = await import('../push-notifications')

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
  mobileFindManyImpl = async () => []
  instanceDeleteManyImpl = async () => ({ count: 0 })
  mobileDeleteManyImpl = async () => ({ count: 0 })
  instanceDeleteManyArgs = null
  mobileDeleteManyArgs = null
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

  it('removes invalid desktop tokens from the desktop subscription table', async () => {
    findManyImpl = async () => [{ pushToken: 'dead-desktop-token' }]
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({
      data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
    }), { status: 200 }))

    await sendPushToInstance('instance-1', { type: 'wake' })

    expect(instanceDeleteManyArgs).toEqual({ where: { pushToken: { in: ['dead-desktop-token'] } } })
    expect(mobileDeleteManyArgs).toBeNull()
  })
})

describe('sendPushToUser', () => {
  it('sends a completion notification to every registered mobile device', async () => {
    mobileFindManyImpl = async () => [
      { pushToken: 'ExponentPushToken[user-a]' },
      { pushToken: 'ExponentPushToken[user-b]' },
    ]

    await sendPushToUser('user-1', {
      title: 'Research task',
      body: 'The agent completed this task.',
      data: { taskId: 'task-1', notificationType: 'agent_task_completed' },
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(lastFetchArgs[1].body)
    expect(body).toEqual([
      {
        to: 'ExponentPushToken[user-a]',
        title: 'Research task',
        body: 'The agent completed this task.',
        data: {
          taskId: 'task-1',
          notificationType: 'agent_task_completed',
          type: 'chat-complete',
        },
        priority: 'high',
        channelId: 'chat-complete',
      },
      {
        to: 'ExponentPushToken[user-b]',
        title: 'Research task',
        body: 'The agent completed this task.',
        data: {
          taskId: 'task-1',
          notificationType: 'agent_task_completed',
          type: 'chat-complete',
        },
        priority: 'high',
        channelId: 'chat-complete',
      },
    ])
  })

  it('does not call Expo when the user has no registered mobile device', async () => {
    await sendPushToUser('user-1', {
      title: 'Research task',
      body: 'The agent completed this task.',
    })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
