// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The tunnel's lifecycle: one per machine, started with the primary device key,
 * stopped cleanly.
 *
 * This file used to assert the SHO-87 fan-out — one tunnel per stored device key
 * — which is what gave a Mac nine `instances` rows and nine heartbeats and made
 * a live machine show "Machine offline" (SHO-241). What survives is the
 * lifecycle around the single tunnel.
 *
 *   bun test apps/api/src/__tests__/instance-tunnel-workspaces.test.ts
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const tunnelInstances: Array<{ apiKey: string; connected: boolean; stopped: boolean }> = []

/**
 * Stand-in for the threaded host that `ThreadedTunnel` really creates (SHO-185
 * §5). The threading itself has its own test — `tunnel-worker-block.test.ts` —
 * and what these tests are about is which key gets a tunnel and whether stopping
 * reaches it. So the host is a record plus the two notifications `ThreadedTunnel`
 * reads its state from.
 */
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

let keyInfo: { workspace: { id: string; name: string } } | null = null
mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: async (args: any) =>
        args?.where?.key === 'SHOGO_KEY_INFO' && keyInfo
          ? { key: 'SHOGO_KEY_INFO', value: JSON.stringify(keyInfo) }
          : null,
    },
  },
}))

const { startInstanceTunnel, stopInstanceTunnel, isTunnelConnected, getInstanceTunnelStatus } =
  await import('../lib/instance-tunnel')

const PRIMARY_KEY = 'shogo_sk_primary'
const ORIGINAL_KEY = process.env.SHOGO_API_KEY

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  process.env.SHOGO_API_KEY = PRIMARY_KEY
  keyInfo = { workspace: { id: 'ws-personal', name: 'Personal' } }
  stored = { enabled: true, workspaces: [], reachable: true, user: null }
  stopInstanceTunnel()
  tunnelInstances.length = 0
})

afterAll(() => {
  stopInstanceTunnel()
  if (ORIGINAL_KEY === undefined) delete process.env.SHOGO_API_KEY
  else process.env.SHOGO_API_KEY = ORIGINAL_KEY
})

describe('startInstanceTunnel', () => {
  test('opens one tunnel with the primary key, whatever workspaces are stored', async () => {
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

    expect(tunnelInstances.map((t) => t.apiKey)).toEqual([PRIMARY_KEY])
    const status = getInstanceTunnelStatus()
    expect(status).toHaveLength(1)
    expect(status[0].id).toBe('primary')
    expect(status[0].state).toBe('connected')
  })

  test('restarting the tunnel does not leave the old one running', async () => {
    startInstanceTunnel()
    await settle()
    startInstanceTunnel()
    await settle()

    expect(tunnelInstances.filter((t) => !t.stopped)).toHaveLength(1)
    expect(getInstanceTunnelStatus()).toHaveLength(1)
  })

  test('stopInstanceTunnel stops the tunnel, and nothing claims to be connected', async () => {
    startInstanceTunnel()
    await settle()
    expect(isTunnelConnected()).toBe(true)

    stopInstanceTunnel()

    expect(tunnelInstances.every((t) => t.stopped)).toBe(true)
    expect(isTunnelConnected()).toBe(false)
    expect(getInstanceTunnelStatus()).toEqual([])
  })

  test('no key means no tunnel at all', () => {
    delete process.env.SHOGO_API_KEY
    startInstanceTunnel()
    expect(tunnelInstances).toHaveLength(0)
    expect(getInstanceTunnelStatus()).toEqual([])
  })
})
