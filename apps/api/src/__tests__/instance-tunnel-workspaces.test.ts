// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One tunnel per cloud workspace the desktop is signed into (SHO-87 §8).
 *
 * A machine belongs to a person, but the cloud files its `instances` row under
 * the workspace its key was issued in. A desktop holding a device key for three
 * workspaces therefore opens three tunnels, so the machine registers in all of
 * them; without the dedupe the primary workspace would get two tunnels racing
 * over the same `(workspaceId, hostname)` row.
 *
 *   bun test apps/api/src/__tests__/instance-tunnel-workspaces.test.ts
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

/** Let the async fan-out settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  tunnelInstances.length = 0
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
  test('opens one tunnel per stored device key, plus the primary', async () => {
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

    // The primary key's workspace is skipped: its tunnel is already running.
    expect(tunnelInstances.map((t) => t.opts.apiKey).sort()).toEqual(
      [PRIMARY_KEY, 'shogo_sk_odin', 'shogo_sk_samsara'].sort(),
    )
    const status = getInstanceTunnelStatus()
    expect(status.map((entry) => entry.id).sort()).toEqual(['primary', 'ws-odin', 'ws-samsara'])
    expect(status.every((entry) => entry.state === 'connected')).toBe(true)
  })

  test('a machine kept on one workspace (enabled: false) opens exactly one tunnel', async () => {
    stored = {
      enabled: false,
      reachable: true,
      user: null,
      workspaces: [
        { id: 'ws-personal', name: 'Personal', key: PRIMARY_KEY },
        { id: 'ws-odin', name: 'Odin AI', key: 'shogo_sk_odin' },
      ],
    }

    startInstanceTunnel()
    await settle()

    expect(tunnelInstances).toHaveLength(1)
    expect(tunnelInstances[0].opts.apiKey).toBe(PRIMARY_KEY)
  })

  test('a stored key identical to the primary is not duplicated', async () => {
    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [
        { id: 'ws-elsewhere', name: 'Elsewhere', key: PRIMARY_KEY },
      ],
    }

    startInstanceTunnel()
    await settle()

    expect(tunnelInstances).toHaveLength(1)
  })

  test('stopInstanceTunnel stops every tunnel, and nothing claims to be connected', async () => {
    stored = {
      enabled: true,
      reachable: true,
      user: null,
      workspaces: [{ id: 'ws-odin', name: 'Odin AI', key: 'shogo_sk_odin' }],
    }
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
  })
})
