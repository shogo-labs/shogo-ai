// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /api/local/instance-info (desktop router) must say which cloud workspace
 * this machine is registered in. `InstanceInfo.workspaceName` existed in the SDK
 * type and Settings rendered the row, but the route never returned it, so
 * "Cloud Workspace" was always blank (SHO-87 / #1568).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

let keyInfoValue: string | null = null
let tunnelConnected = false

mock.module('../auth', () => ({ auth: {} }))
mock.module('../lib/prisma', () => ({
  prisma: {
    localConfig: {
      findUnique: async (args: any) =>
        args?.where?.key === 'SHOGO_KEY_INFO' && keyInfoValue
          ? { key: 'SHOGO_KEY_INFO', value: keyInfoValue }
          : null,
      upsert: async () => ({}),
      deleteMany: async () => ({}),
      findMany: async () => [],
    },
  },
}))
mock.module('../lib/cloud-urls', () => ({ getShogoCloudUrl: () => 'https://cloud.test' }))
mock.module('../lib/federated-upstream', () => ({
  _resetAgentModelDefaultsCache: () => {},
  _resetUpstreamCredentialCache: () => {},
}))
let registered: Array<{ id: string; name: string; state: 'connected' | 'connecting' }> = []
mock.module('../lib/instance-tunnel', () => ({
  startInstanceTunnel: () => {},
  stopInstanceTunnel: () => {},
  isTunnelConnected: () => tunnelConnected,
  getInstanceTunnelStatus: () => registered,
}))
mock.module('../services/cloud-workspaces', () => ({
  setCloudWorkspaces: async () => {},
  clearCloudWorkspaces: async () => {},
}))

const { localSystemRoutes } = await import('../routes/local-system')

const origHostname = process.env.SHOGO_INSTANCE_NAME

function getInfo(): Promise<Response> {
  const app = new Hono()
  app.route('/api', localSystemRoutes())
  return app.fetch(new Request('http://x/api/local/instance-info'))
}

beforeEach(() => {
  keyInfoValue = null
  tunnelConnected = false
  registered = []
  process.env.SHOGO_INSTANCE_NAME = 'samasra'
})

afterEach(() => {
  if (origHostname === undefined) delete process.env.SHOGO_INSTANCE_NAME
  else process.env.SHOGO_INSTANCE_NAME = origHostname
})

describe('GET /api/local/instance-info', () => {
  test('names the cloud workspace the key was issued in', async () => {
    keyInfoValue = JSON.stringify({
      workspace: { id: 'f8019c80-0000-4000-8000-000000000000', name: 'Samsara' },
      user: { id: 'u-1' },
    })
    tunnelConnected = true

    const res = await getInfo()
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.name).toBe('samasra')
    expect(body.workspaceName).toBe('Samsara')
    expect(body.tunnelConnected).toBe(true)
    expect(body.cloudUrl).toBe('https://cloud.test')
  })

  test('is null, never undefined, before a key is saved', async () => {
    const body = (await (await getInfo()).json()) as any
    expect(body.workspaceName).toBeNull()
    expect(body.tunnelConnected).toBe(false)
  })

  test('lists every workspace it registered in, with each tunnel state', async () => {
    keyInfoValue = JSON.stringify({
      workspace: { id: 'ws-personal', name: 'Personal' },
      user: { id: 'u-1' },
    })
    tunnelConnected = true
    registered = [
      { id: 'primary', name: 'Personal', state: 'connected' },
      { id: 'ws-odin', name: 'Odin AI', state: 'connecting' },
    ]

    const body = (await (await getInfo()).json()) as any
    // The primary tunnel is keyed before its workspace id is known; the route
    // reports the key's own workspace id instead of the placeholder.
    expect(body.workspaces).toEqual([
      { id: 'ws-personal', name: 'Personal', state: 'connected' },
      { id: 'ws-odin', name: 'Odin AI', state: 'connecting' },
    ])
    expect(body.workspaceName).toBe('Personal')
  })

  test('falls back to the key’s workspace when the tunnel list is empty', async () => {
    keyInfoValue = JSON.stringify({
      workspace: { id: 'ws-personal', name: 'Personal' },
      user: { id: 'u-1' },
    })
    tunnelConnected = true
    const body = (await (await getInfo()).json()) as any
    expect(body.workspaces).toEqual([
      { id: 'ws-personal', name: 'Personal', state: 'connected' },
    ])
  })

  test('survives an older key whose info has no workspace name', async () => {
    keyInfoValue = JSON.stringify({ workspace: { id: 'ws-1' }, user: { id: 'u-1' } })
    const body = (await (await getInfo()).json()) as any
    expect(body.workspaceName).toBeNull()
  })
})
