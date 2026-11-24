// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-538 — waking a hosted workspace's host when the workspace is opened.
 *
 * The client asks the existing `POST /instances/:id/request-connect` for a
 * hosted workspace as soon as it is on screen, so the desktop's fast poll is
 * already running before the first plans or files read arrives.
 *
 * Two things had to line up for that to work for anyone but the machine's owner:
 * a member of the workspace the machine *hosts* may wake it (they reach its
 * runtime through it anyway), and the workspace it marks a viewer on is the one
 * `computeNextPollIn` reads — the instance's registration workspace — so the next
 * heartbeat really comes back on the 3 s poll.
 *
 *   bun test apps/api/src/__tests__/sho-538-host-wake-on-open.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = ''

type InstanceRow = {
  id: string
  workspaceId: string
  userId: string | null
  name: string
  hostname: string
  lastSeenAt: Date
  wsRequestedAt: Date | null
}

const state: {
  instance: InstanceRow | null
  /** workspaceId → the instance that hosts it. */
  hosts: Map<string, string>
  /** workspaceId → roles the caller holds there. */
  readable: Set<string>
  marks: string[]
} = { instance: null, hosts: new Map(), readable: new Set(), marks: [] }

mock.module('../lib/tunnel-redis', () => ({
  initTunnelRedis: async () => {},
  registerTunnelOwnership: async () => {},
  unregisterTunnelOwnership: async () => {},
  evictTunnelOwnership: async () => {},
  refreshTunnelOwnership: async () => {},
  getTunnelOwner: async () => null,
  relayTunnelRequest: async () => ({}),
  relayTunnelStreamRequest: () => ({ cancel: () => {} }),
  setLocalTunnelHandlers: () => {},
  markViewerActiveRedis: async (workspaceId: string) => {
    state.marks.push(workspaceId)
  },
  isViewerActiveRedis: async () => false,
  markControllerActiveRedis: async () => {},
  getActiveControllersRedis: async () => [],
  isTunnelConnectedAnywhere: async () => false,
  getPodId: () => 'pod-test',
  getSharedRedis: () => null,
  whenReady: async () => {},
  verifyPodAlive: async () => false,
}))

mock.module('../lib/prisma', () =>
  withPrismaExports({
    prisma: {
      instance: {
        findUnique: async ({ where }: any) =>
          state.instance && state.instance.id === where.id ? { ...state.instance } : null,
        update: async ({ where, data }: any) => {
          if (state.instance && state.instance.id === where.id) Object.assign(state.instance, data)
          return { ...(state.instance as any) }
        },
      },
      workspace: {
        findUnique: async ({ where }: any) => ({
          hostInstanceId: state.hosts.get(where.id) ?? null,
          kind: 'team',
          personalOwnerId: null,
        }),
      },
      // The real `can()` resolves membership; the fixture is "these workspaces".
      member: {
        findMany: async ({ where }: any) => {
          const asked: string[] = (where?.OR ?? [])
            .map((row: any) => row?.workspaceId)
            .filter((id: unknown): id is string => typeof id === 'string')
          return asked
            .filter((id) => state.readable.has(id))
            .map((id) => ({ role: 'member', workspaceId: id, projectId: null, isBillingAdmin: false }))
        },
      },
      user: { findUnique: async () => ({ role: 'user' }) },
      project: { findUnique: async () => null },
    },
  }),
)

mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => ({ sent: false }),
  sendPushToUser: async () => ({ sent: false }),
}))

const { instanceRoutes, planHostWake, _testing } = await import('../routes/instances')
const { _resetHostCacheForTests } = await import('../lib/host-tunnel')

const HOST = 'inst-mac'
const hostWorkspace = 'ws-personal'

const caller = { id: 'user-2', userId: 'user-2', email: 'u2@x', role: 'user' }

function buildApp(auth: any = caller) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).set('auth', auth)
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

function ask(app: Hono, body: unknown = {}) {
  return app.fetch(
    new Request(`http://x/api/instances/${HOST}/request-connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  _resetHostCacheForTests()
  _testing.tunnels.clear()
  _testing.activeViewers.clear()
  state.instance = {
    id: HOST,
    workspaceId: hostWorkspace,
    userId: 'user-1',
    name: 'Studio Mac',
    hostname: 'studio',
    lastSeenAt: new Date(),
    wsRequestedAt: null,
  }
  state.hosts = new Map([['ws-hosted', HOST]])
  state.readable = new Set([hostWorkspace])
  state.marks = []
})

describe('POST /instances/:id/request-connect — a hosted workspace wakes its host', () => {
  test('a member of the hosted workspace wakes the machine that serves it', async () => {
    state.readable = new Set(['ws-hosted'])

    const res = await ask(buildApp(), { workspaceId: 'ws-hosted' })

    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('requested')
    expect(state.instance?.wsRequestedAt).toBeInstanceOf(Date)
    // The viewer is marked on the workspace the heartbeat polls under, not on the
    // one the client is showing.
    expect(state.marks).toEqual([hostWorkspace])
  })

  test('the next heartbeat for that instance comes back on the fast poll', async () => {
    state.readable = new Set(['ws-hosted'])
    await ask(buildApp(), { workspaceId: 'ws-hosted' })

    // `computeNextPollIn` reads the instance's own registration workspace.
    const nextPollIn = await _testing.computeNextPollIn(
      HOST,
      hostWorkspace,
      state.instance?.wsRequestedAt ?? null,
    )
    expect(nextPollIn).toBe(3)
  })

  test('a member of some other workspace cannot wake it', async () => {
    state.readable = new Set(['ws-other'])

    const res = await ask(buildApp(), { workspaceId: 'ws-other' })

    expect(res.status).toBe(403)
    expect(state.instance?.wsRequestedAt).toBeNull()
  })

  test('naming a workspace this machine does not host wakes nothing', async () => {
    // A member of the hosted workspace, but the machine named is a different one.
    state.readable = new Set(['ws-hosted'])
    state.hosts = new Map([['ws-hosted', 'inst-someone-else']])

    const res = await ask(buildApp(), { workspaceId: 'ws-hosted' })

    expect(res.status).toBe(403)
    expect(state.instance?.wsRequestedAt).toBeNull()
  })

  test('the owner still wakes it with no body at all', async () => {
    const res = await ask(buildApp({ ...caller, userId: 'user-1', id: 'user-1' }), {})

    expect(res.status).toBe(200)
    expect(state.instance?.wsRequestedAt).toBeInstanceOf(Date)
  })

  test('a fresh viewer request is what the wake planner sees as a short wait', () => {
    // The wake is planned from the heartbeat the fast poll just wrote.
    const { state: wakeState, waitMs } = planHostWake({
      tunnelUp: false,
      lastSeenAt: new Date(),
      now: Date.now(),
    })
    expect(wakeState).toBe('wait')
    expect(waitMs).toBeGreaterThan(0)
  })
})
