// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace joined (or left) mid-session registers without an app restart.
 *
 * The fan-out tunnels are built once at boot from `SHOGO_CLOUD_WORKSPACES`.
 * `syncCloudWorkspaces()` refreshes that list every ten minutes, so without a
 * reconcile a workspace the user joined from another device would have no tunnel
 * — the machine would not appear in it — until the desktop was restarted, and a
 * workspace they left would keep receiving heartbeats.
 *
 *   bun test apps/api/src/__tests__/instance-tunnel-sync.test.ts
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const tunnelInstances: any[] = []

mock.module('@shogo-ai/worker/tunnel', () => {
  class WorkerTunnel {
    connected = false
    stopped = false
    constructor(public opts: any) {
      tunnelInstances.push(this)
    }
    start() {
      this.connected = true
    }
    stop() {
      this.stopped = true
      this.connected = false
    }
    isConnected() {
      return this.connected
    }
  }
  return {
    WorkerTunnel,
    TUNNEL_PROTOCOL_VERSION: 1,
    TunnelWebSocketHeaderSupportError: class extends Error {},
  }
})

mock.module('../lib/runtime', () => ({
  getRuntimeManager: () => ({
    getActiveProjects: () => [],
    status: () => null,
    start: async () => null,
  }),
}))
mock.module('../lib/machine-snapshot', () => ({ collectMachineSnapshot: async () => ({}) }))
mock.module('../lib/cloud-key-wipe', () => ({ wipeCloudKey: async () => {} }))
mock.module('../lib/project-runtime-token', () => ({ deriveProjectRuntimeToken: async () => null }))

type Stored = {
  enabled: boolean
  workspaces: Array<{ id: string; name: string; key: string }>
  reachable: boolean
  user: null
}
let stored: Stored = { enabled: true, workspaces: [], reachable: true, user: null }
mock.module('../services/cloud-workspaces', () => ({
  listCloudWorkspaces: async () => stored,
}))

mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: async () => ({
        key: 'SHOGO_KEY_INFO',
        value: JSON.stringify({ workspace: { id: 'ws-personal', name: 'Personal' } }),
      }),
    },
  },
}))

const { startInstanceTunnel, stopInstanceTunnel, syncWorkspaceTunnels, getInstanceTunnelStatus } =
  await import('../lib/instance-tunnel')

const PRIMARY_KEY = 'shogo_sk_primary'
const ORIGINAL_KEY = process.env.SHOGO_API_KEY

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const keysInUse = () => tunnelInstances.filter((t) => !t.stopped).map((t) => t.opts.apiKey).sort()

beforeEach(() => {
  process.env.SHOGO_API_KEY = PRIMARY_KEY
  stored = { enabled: true, workspaces: [], reachable: true, user: null }
  stopInstanceTunnel()
  tunnelInstances.length = 0
})

afterAll(() => {
  stopInstanceTunnel()
  if (ORIGINAL_KEY === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = ORIGINAL_KEY
})

describe('syncWorkspaceTunnels', () => {
  test('opens a tunnel for a workspace joined after boot', async () => {
    startInstanceTunnel()
    await settle()
    expect(getInstanceTunnelStatus().map((s) => s.id)).toEqual(['primary'])

    // The user joins Odin AI from another device; the next sync stores its key.
    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [
        { id: 'ws-personal', name: 'Personal', key: PRIMARY_KEY },
        { id: 'ws-odin', name: 'Odin AI', key: 'shogo_sk_odin' },
      ],
    }
    await syncWorkspaceTunnels()
    await settle()

    expect(getInstanceTunnelStatus().map((s) => s.id).sort()).toEqual(['primary', 'ws-odin'])
    expect(keysInUse()).toEqual([PRIMARY_KEY, 'shogo_sk_odin'].sort())
  })

  test('stops the tunnel of a workspace that was left', async () => {
    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [
        { id: 'ws-personal', name: 'Personal', key: PRIMARY_KEY },
        { id: 'ws-odin', name: 'Odin AI', key: 'shogo_sk_odin' },
        { id: 'ws-samsara', name: 'Samsara', key: 'shogo_sk_samsara' },
      ],
    }
    startInstanceTunnel()
    await settle()
    expect(getInstanceTunnelStatus()).toHaveLength(3)

    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [{ id: 'ws-personal', name: 'Personal', key: PRIMARY_KEY }],
    }
    await syncWorkspaceTunnels()
    await settle()

    // The primary tunnel is never torn down: its key is the one this process was
    // launched with, and the machine must stay reachable from it.
    expect(getInstanceTunnelStatus().map((s) => s.id)).toEqual(['primary'])
    expect(keysInUse()).toEqual([PRIMARY_KEY])
  })

  test('re-opens a workspace whose device key was rotated', async () => {
    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [
        { id: 'ws-personal', name: 'Personal', key: PRIMARY_KEY },
        { id: 'ws-odin', name: 'Odin AI', key: 'shogo_sk_odin_old' },
      ],
    }
    startInstanceTunnel()
    await settle()

    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [
        { id: 'ws-personal', name: 'Personal', key: PRIMARY_KEY },
        { id: 'ws-odin', name: 'Odin AI', key: 'shogo_sk_odin_new' },
      ],
    }
    await syncWorkspaceTunnels()
    await settle()

    expect(keysInUse()).toEqual([PRIMARY_KEY, 'shogo_sk_odin_new'].sort())
    expect(tunnelInstances.filter((t) => t.opts.apiKey === 'shogo_sk_odin_old').every((t) => t.stopped)).toBe(true)
  })

  test('does nothing without a key, and nothing extra when the set is unchanged', async () => {
    startInstanceTunnel()
    await settle()
    const before = tunnelInstances.length
    await syncWorkspaceTunnels()
    await settle()
    expect(tunnelInstances.length).toBe(before)

    delete process.env.SHOGO_API_KEY
    await syncWorkspaceTunnels()
    expect(tunnelInstances.length).toBe(before)
  })
})
