// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A machine heartbeats **once**, however many workspaces it is signed into.
 *
 * This file used to assert the opposite (SHO-87): one tunnel per stored device
 * key, rebuilt when a workspace was joined, left or rotated. That fan-out is what
 * gave a Mac nine `instances` rows — nine heartbeats, nine sockets, and a
 * `/machines` id that changed every few seconds, so a live machine was reported
 * as "stopped heartbeating" (SHO-241, Russell: "every workspace shouldnt
 * heartbeat"). The stored keys are still there and still refreshed; they no
 * longer open a tunnel.
 *
 *   bun test apps/api/src/__tests__/instance-tunnel-sync.test.ts
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const tunnelInstances: Array<{ apiKey: string; connected: boolean; stopped: boolean }> = []

mock.module('@shogo-ai/worker/tunnel-host', () => ({
  startTunnelInWorker: (options: any) => {
    const host = { apiKey: options.apiKey, connected: false, stopped: false }
    tunnelInstances.push(host)
    host.connected = true
    options.onConnection?.(true)
    return {
      stop() {
        host.stopped = true
        host.connected = false
        options.onConnection?.(false)
      },
      instanceId: () => null,
      isConnected: () => host.connected,
      ready: () => Promise.resolve(),
    }
  },
}))

mock.module('@shogo-ai/worker/tunnel', () => {
  class WorkerTunnel {
    apiKey: string
    connected = false
    stopped = false
    constructor(public opts: any) {
      this.apiKey = opts.apiKey
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

const { startInstanceTunnel, stopInstanceTunnel, getInstanceTunnelStatus } = await import(
  '../lib/instance-tunnel'
)

const PRIMARY_KEY = 'shogo_sk_primary'
const ORIGINAL_KEY = process.env.SHOGO_API_KEY

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const keysInUse = () => tunnelInstances.filter((t) => !t.stopped).map((t) => t.apiKey).sort()

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

describe('one tunnel per machine', () => {
  test('three stored device keys still open exactly one tunnel', async () => {
    // Russell's Mac: signed into nine workspaces, one device key each. The old
    // fan-out opened nine tunnels and the cloud kept nine heartbeating rows.
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

    expect(tunnelInstances).toHaveLength(1)
    expect(keysInUse()).toEqual([PRIMARY_KEY])
    const status = getInstanceTunnelStatus()
    expect(status).toHaveLength(1)
    expect(status[0].state).toBe('connected')
  })

  test('a workspace joined later cannot open a second tunnel', async () => {
    startInstanceTunnel()
    await settle()
    expect(getInstanceTunnelStatus()).toHaveLength(1)

    // The rebuild that used to open it is gone, so the stored key set no longer
    // reaches the tunnel at all.
    const tunnelModule: Record<string, unknown> = await import('../lib/instance-tunnel')
    expect(tunnelModule.syncWorkspaceTunnels).toBeUndefined()

    // `syncCloudWorkspaces()` refreshing the key list, and a restart of the one
    // tunnel, both leave the machine registered exactly once.
    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [
        { id: 'ws-personal', name: 'Personal', key: PRIMARY_KEY },
        { id: 'ws-odin', name: 'Odin AI', key: 'shogo_sk_odin' },
      ],
    }
    startInstanceTunnel()
    await settle()

    expect(tunnelInstances.filter((t) => !t.stopped)).toHaveLength(1)
    expect(getInstanceTunnelStatus()).toHaveLength(1)
  })

  test('stopping the tunnel leaves nothing claiming to be connected', async () => {
    startInstanceTunnel()
    await settle()
    expect(getInstanceTunnelStatus()).toHaveLength(1)

    stopInstanceTunnel()

    expect(tunnelInstances.every((t) => t.stopped)).toBe(true)
    expect(getInstanceTunnelStatus()).toEqual([])
  })
})
