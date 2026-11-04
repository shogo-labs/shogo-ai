// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The host tunnel (SHO-285): a hosted workspace's runtime URL only ever answers
 * on this process's loopback, only for the instance that hosts the workspace,
 * and is never handed to a client.
 *
 * `hostOfWorkspace` answers "where does this workspace run", and every runtime
 * resolve asks it. A lookup that cannot be answered must read as "no host" —
 * the same path a workspace with no host takes — never as a failed resolve:
 * that turned every route in a database-free process into a 500 (SHO-285 QA).
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

type WorkspaceRow = { hostInstanceId?: string | null; kind?: string; personalOwnerId?: string | null }

const state: {
  row: WorkspaceRow | null
  throws: boolean
  project: { id: string; workspaceId: string } | null
  instance: { id: string; name: string; userId: string | null } | null
  forwarded: Array<{ instanceId: string; payload: any }>
  streamed: Array<{ instanceId: string; payload: any }>
} = { row: null, throws: false, project: null, instance: null, forwarded: [], streamed: [] }

mock.module('../prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async () => {
        if (state.throws) throw new Error('User was denied access on the database')
        return state.row
      },
    },
    project: {
      findUnique: async (args: any) =>
        state.project && state.project.id === args?.where?.id ? state.project : null,
    },
    instance: {
      findUnique: async (args: any) =>
        state.instance && state.instance.id === args?.where?.id ? state.instance : null,
    },
  },
}))

const {
  handleHostTunnel,
  hostOfWorkspace,
  hostTunnelRuntimeUrl,
  clientRuntimeUrl,
  parseTunnelTarget,
  _resetHostCacheForTests,
} = await import('../host-tunnel')

beforeEach(() => {
  _resetHostCacheForTests()
  state.row = null
  state.throws = false
  state.project = { id: 'proj-1', workspaceId: 'ws-1' }
  state.instance = { id: 'inst-1', name: 'Studio Mac', userId: 'user-1' }
  state.forwarded = []
  state.streamed = []
  delete process.env.SHOGO_LOCAL_MODE
})

// ─── hostOfWorkspace ──────────────────────────────────────────────────────

describe('hostOfWorkspace', () => {
  test('a workspace with no host is not hosted', async () => {
    state.row = { hostInstanceId: null }
    expect(await hostOfWorkspace('ws-plain')).toBeNull()
  })

  test('a hosted workspace names its host', async () => {
    state.row = { hostInstanceId: 'inst-1' }
    expect(await hostOfWorkspace('ws-hosted')).toBe('inst-1')
  })

  test('a lookup that cannot be answered is not a failure', async () => {
    state.throws = true
    expect(await hostOfWorkspace('ws-unknown')).toBeNull()
  })

  test('a failed lookup is not cached, so the next resolve asks again', async () => {
    state.throws = true
    expect(await hostOfWorkspace('ws-retry')).toBeNull()
    state.throws = false
    state.row = { hostInstanceId: 'inst-2' }
    expect(await hostOfWorkspace('ws-retry')).toBe('inst-2')
  })

  test('the desktop never asks: it has no cluster to host a workspace', async () => {
    process.env.SHOGO_LOCAL_MODE = 'true'
    state.throws = true
    expect(await hostOfWorkspace('ws-local')).toBeNull()
  })
})

// ─── the tunnel route ─────────────────────────────────────────────────────

/** The secret this process puts in its tunnel URLs (never a literal the test owns). */
const secret = new URL(hostTunnelRuntimeUrl('inst-1', { workspaceId: 'ws-1' })).pathname.split('/')[4]

function tunnelPath(instanceId: string, rest: string, usedSecret = secret): string {
  return `/api/internal/host-tunnel/${usedSecret}/${instanceId}${rest}`
}

const PROJECT_CHAT = '/api/projects/proj-1/agent-proxy/agent/status'
const DEVICE_TOOLS = '/api/workspaces/ws-personal/agent-proxy/agent/remote/tool'

const tunnel = {
  ensureTunnelConnected: async () => true,
  sendTunnelRequest: async (instanceId: string, payload: any) => {
    state.forwarded.push({ instanceId, payload })
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"relayed":true}' }
  },
  sendTunnelStreamRequest: (instanceId: string, payload: any, _onChunk: (chunk: any) => void) => {
    state.streamed.push({ instanceId, payload })
    return { cancel() {} }
  },
  generateRequestId: () => 'req-1',
}

function app(peer: string | null, hostOf: (workspaceId: string) => Promise<string | null> = async () => null) {
  const a = new Hono()
  a.all('/api/internal/host-tunnel/*', (c) =>
    handleHostTunnel(c, { _peerAddress: peer, _hostOf: hostOf, _tunnel: tunnel }),
  )
  return a
}

const hosts = (workspaceId: string) => async () => (workspaceId === 'ws-1' ? 'inst-1' : null)

describe('handleHostTunnel — only this process may call it', () => {
  test('a peer that is not loopback gets the unknown-route 404', async () => {
    const res = await app('10.1.2.3').request(tunnelPath('inst-1', PROJECT_CHAT), { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('404 Not Found')
    expect(state.forwarded).toHaveLength(0)
  })

  test('a peer that cannot be determined is refused, not assumed', async () => {
    const res = await app(null).request(tunnelPath('inst-1', PROJECT_CHAT), { method: 'POST' })
    expect(res.status).toBe(404)
    expect(state.forwarded).toHaveLength(0)
  })

  test('loopback as IPv6 and IPv4-mapped is accepted', async () => {
    for (const peer of ['::1', '127.0.0.1', '::ffff:127.0.0.1']) {
      state.forwarded = []
      const res = await app(peer, hosts('ws-1')).request(tunnelPath('inst-1', PROJECT_CHAT), { method: 'POST' })
      expect(res.status).toBe(200)
      expect(state.forwarded).toHaveLength(1)
    }
  })

  test('an ingress stamp means it did not come straight from the process', async () => {
    for (const header of ['x-forwarded-for', 'cf-connecting-ip']) {
      const res = await app('127.0.0.1', hosts('ws-1')).request(tunnelPath('inst-1', PROJECT_CHAT), {
        method: 'POST',
        headers: { [header]: '203.0.113.9' },
      })
      expect(res.status).toBe(404)
    }
    expect(state.forwarded).toHaveLength(0)
  })

  test('a wrong secret gets the same 404 as an unknown route', async () => {
    const res = await app('127.0.0.1', hosts('ws-1')).request(
      tunnelPath('inst-1', PROJECT_CHAT, 'not-the-secret'),
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('404 Not Found')
  })

  test('a path outside the runtime agent proxies is never forwarded', async () => {
    for (const rest of ['/api/admin/users', '/api/projects/proj-1/runtime/start', '/']) {
      const res = await app('127.0.0.1', hosts('ws-1')).request(tunnelPath('inst-1', rest), { method: 'POST' })
      expect(res.status).toBe(404)
    }
    expect(state.forwarded).toHaveLength(0)
  })
})

describe('handleHostTunnel — an instance reaches only what it hosts', () => {
  test('the instance that hosts the workspace is forwarded', async () => {
    const res = await app('127.0.0.1', hosts('ws-1')).request(`${tunnelPath('inst-1', PROJECT_CHAT)}?q=1`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(state.forwarded).toHaveLength(1)
    expect(state.forwarded[0].instanceId).toBe('inst-1')
    expect(state.forwarded[0].payload.path).toBe(`${PROJECT_CHAT}?q=1`)
  })

  test('a workspace proxy for a hosted workspace is forwarded', async () => {
    const res = await app('127.0.0.1', hosts('ws-1')).request(
      tunnelPath('inst-1', '/api/workspaces/ws-1/agent-proxy/agent/logs/stream'),
      { method: 'GET', headers: { accept: 'text/event-stream' } },
    )
    expect(res.status).toBe(200)
    expect(state.streamed).toHaveLength(1)
    expect(state.streamed[0].payload.path).toBe('/api/workspaces/ws-1/agent-proxy/agent/logs/stream')
  })

  test('an instance that does not host the workspace is refused with 403', async () => {
    const res = await app('127.0.0.1', async () => 'inst-2').request(tunnelPath('inst-1', PROJECT_CHAT), {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('forbidden')
    expect(state.forwarded).toHaveLength(0)
  })

  test('a workspace with no host is not reachable through the tunnel', async () => {
    const res = await app('127.0.0.1', async () => null).request(tunnelPath('inst-1', PROJECT_CHAT), {
      method: 'POST',
    })
    expect(res.status).toBe(403)
  })

  test('an unknown project or instance is not found', async () => {
    state.project = null
    expect(
      (await app('127.0.0.1', hosts('ws-1')).request(tunnelPath('inst-1', PROJECT_CHAT), { method: 'POST' }))
        .status,
    ).toBe(403)
    state.project = { id: 'proj-1', workspaceId: 'ws-1' }
    state.instance = null
    expect(
      (await app('127.0.0.1', hosts('ws-1')).request(tunnelPath('inst-1', PROJECT_CHAT), { method: 'POST' }))
        .status,
    ).toBe(404)
  })

  test("the device-tools call reaches the instance owner's own Personal workspace", async () => {
    state.row = { kind: 'personal', personalOwnerId: 'user-1' }
    const res = await app('127.0.0.1', async () => null).request(tunnelPath('inst-1', DEVICE_TOOLS), {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(state.forwarded).toHaveLength(1)
  })

  test("the device-tools call does not reach someone else's Personal workspace", async () => {
    state.row = { kind: 'personal', personalOwnerId: 'user-2' }
    const res = await app('127.0.0.1', async () => null).request(tunnelPath('inst-1', DEVICE_TOOLS), {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    expect(state.forwarded).toHaveLength(0)
  })

  test('the Personal exception is only for the device-tools call', async () => {
    state.row = { kind: 'personal', personalOwnerId: 'user-1' }
    const res = await app('127.0.0.1', async () => null).request(
      tunnelPath('inst-1', '/api/workspaces/ws-personal/agent-proxy/agent/chat'),
      { method: 'POST' },
    )
    expect(res.status).toBe(403)
  })
})

describe('handleHostTunnel — what the desktop is told', () => {
  test('the caller does not get to name the billing user', async () => {
    await app('127.0.0.1', hosts('ws-1')).request(tunnelPath('inst-1', PROJECT_CHAT), {
      method: 'POST',
      headers: { 'x-billing-user-id': 'someone-else', 'x-chat-session-id': 'chat-1' },
    })
    const headers = state.forwarded[0].payload.headers
    expect(headers['x-billing-user-id']).toBeUndefined()
    expect(headers['x-tunnel-auth-user-id']).toBe('user-1')
    expect(headers['x-chat-session-id']).toBe('chat-1')
  })
})

describe('the URL never leaves this process', () => {
  test('a host-tunnel runtime URL has no client-facing form', () => {
    const url = hostTunnelRuntimeUrl('inst-1', { workspaceId: 'ws-1' })
    expect(clientRuntimeUrl({ mode: 'host-tunnel', url })).toBeNull()
  })

  test('every other mode keeps its URL', () => {
    expect(clientRuntimeUrl({ mode: 'metal', url: 'https://box.example' })).toBe('https://box.example')
    expect(clientRuntimeUrl({ mode: 'k8s', url: 'https://pod.example' })).toBe('https://pod.example')
    expect(clientRuntimeUrl({ mode: 'host', url: 'http://127.0.0.1:8000' })).toBe('http://127.0.0.1:8000')
  })

  test('the tunnel target parser accepts only runtime agent proxies', () => {
    expect(parseTunnelTarget('/api/projects/p1/agent-proxy/agent/chat')).toEqual({
      kind: 'project',
      id: 'p1',
      rest: '/agent/chat',
    })
    expect(parseTunnelTarget('/api/workspaces/w1/agent-proxy')).toEqual({
      kind: 'workspace',
      id: 'w1',
      rest: '',
    })
    expect(parseTunnelTarget('/api/projects/p1/runtime/start')).toBeNull()
    expect(parseTunnelTarget('/api/internal/other')).toBeNull()
    expect(parseTunnelTarget('/api/projects/%E0%A4%A/agent-proxy')).toBeNull()
  })
})
