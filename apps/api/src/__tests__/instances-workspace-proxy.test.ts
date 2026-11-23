// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The transparent proxy's frame for a workspace-agent-proxy path (SHO-526).
 *
 * A workspace chat has no project, so the wrapper id on the path is the only
 * thing that names a runtime. Dropping it sent the request to whichever runtime
 * happened to be up, with no `x-runtime-token` — the 401 Russell saw on images
 * and video in a remote workspace.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'
import { Hono } from 'hono'

process.env.SHOGO_LOCAL_MODE = 'true'

const INSTANCE_ID = 'inst-sho526'

const mockInstance = {
  id: INSTANCE_ID,
  workspaceId: 'ws-machine',
  userId: 'user-1',
  name: 'mac-sho526',
  hostname: 'mac-sho526',
  os: 'darwin',
  arch: 'arm64',
  status: 'online',
  lastSeenAt: new Date(),
  wsRequestedAt: null as Date | null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const mockPrisma = {
  instance: {
    findUnique: mock(async () => ({ ...mockInstance })),
    update: mock(async () => ({ ...mockInstance })),
  },
  member: {
    findFirst: mock(async () => ({ id: 'm-1', userId: 'user-1', workspaceId: 'ws-machine' })),
    findMany: async () => [{ role: 'member', projectId: null, isBillingAdmin: false }],
  },
  user: { findUnique: async () => ({ role: 'user' }) },
  project: { findUnique: async () => null },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma }))
mock.module('../routes/api-keys', () => ({ resolveApiKey: async () => null }))
mock.module('../routes/remote-audit', () => ({
  logRemoteAction: async () => {},
  classifyAction: () => 'other',
}))
mock.module('../lib/push-notifications', () => ({
  sendPushToInstance: async () => ({ sent: false }),
  sendPushToUser: async () => ({ sent: false }),
}))
mock.module('../lib/tunnel-timeouts', () => ({
  PROXY_TIMEOUT_MS: 2_000,
  RELAY_TIMEOUT_MS: 2_000,
}))

const { instanceRoutes, _testing, handleInstanceWsMessage } = await import('../routes/instances')

function createApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { id: 'user-1', userId: 'user-1', email: 'dev@shogo.ai', role: 'super_admin' })
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

const frame: { current: any } = { current: null }

/**
 * A tunnel socket that records the frame the route sends, answering it with
 * whatever the test wants the desktop to have replied.
 */
function strongTunnel() {
  const ws: any = {
    readyState: 1,
    data: { instanceId: INSTANCE_ID, workspaceId: 'ws-machine' },
    send: (data: string) => {
      const msg = JSON.parse(data)
      frame.current = msg
      setTimeout(() => {
        handleInstanceWsMessage(
          ws,
          JSON.stringify({
            type: 'response',
            requestId: msg.requestId,
            status: 206,
            headers: {
              'content-type': 'image/png',
              'content-range': 'bytes 0-3/4',
              'content-length': '4',
            },
            body: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64'),
            bodyEncoding: 'base64',
          }),
        )
      }, 0)
    },
    close: () => {},
  }
  ;(_testing.tunnels as Map<string, any>).set(INSTANCE_ID, {
    ws,
    instanceId: INSTANCE_ID,
    workspaceId: 'ws-machine',
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  })
  return ws
}

beforeEach(() => {
  ;(_testing.tunnels as Map<string, any>).clear()
  frame.current = null
  mockPrisma.instance.findUnique.mockImplementation(async () => ({ ...mockInstance }))
  mockPrisma.member.findFirst.mockImplementation(async () => ({
    id: 'm-1',
    userId: 'user-1',
    workspaceId: 'ws-machine',
  }))
})

describe('transparent proxy frames (SHO-526)', () => {
  test('a workspace download names the workspace, negotiates base64 and forwards range', async () => {
    strongTunnel()
    const app = createApp()

    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/workspaces/ws-1/agent-proxy/agent/workspace/download/shots/a.png`,
      { headers: { range: 'bytes=0-3' } },
    )
    await res.arrayBuffer()

    expect(frame.current).toMatchObject({
      type: 'request',
      method: 'GET',
      path: '/agent/workspace/download/shots/a.png',
      workspaceId: 'ws-1',
      acceptBodyEncoding: ['base64'],
    })
    expect(frame.current.projectId).toBeUndefined()
    expect(frame.current.headers.range).toBe('bytes=0-3')
  })

  test('the project wrapper still names its project and nothing else', async () => {
    strongTunnel()
    const app = createApp()

    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/projects/p-1/agent-proxy/agent/workspace/download/a.png`,
    )
    await res.arrayBuffer()

    expect(frame.current.projectId).toBe('p-1')
    expect(frame.current.workspaceId).toBeUndefined()
    expect(frame.current.path).toBe('/agent/workspace/download/a.png')
  })

  test('a base64 frame comes back to the client byte-identical', async () => {
    strongTunnel()
    const app = createApp()

    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/workspaces/ws-1/agent-proxy/agent/workspace/download/a.png`,
      { headers: { range: 'bytes=0-3' } },
    )
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(206)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-range')).toBe('bytes 0-3/4')
    expect([...bytes]).toEqual([0xff, 0xd8, 0xff, 0x00])
  })

  test('a workspace chat turn still streams, and carries the workspace id', async () => {
    const ws = strongTunnel()
    // The route sends the frame and waits for stream chunks, so answer by hand.
    const realSend = ws.send
    ws.send = (data: string) => {
      const msg = JSON.parse(data)
      frame.current = msg
      setTimeout(() => {
        handleInstanceWsMessage(ws, JSON.stringify({ type: 'stream-chunk', requestId: msg.requestId, data: 'data: hi\n\n' }))
        handleInstanceWsMessage(ws, JSON.stringify({ type: 'stream-end', requestId: msg.requestId }))
      }, 0)
    }

    const app = createApp()
    const res = await app.request(
      `/api/instances/${INSTANCE_ID}/p/api/workspaces/ws-1/agent-proxy/agent/chat`,
      { method: 'POST', body: JSON.stringify({ message: 'hi' }), headers: { 'content-type': 'application/json' } },
    )
    const text = await res.text()

    ws.send = realSend
    expect(frame.current).toMatchObject({
      path: '/agent/chat',
      workspaceId: 'ws-1',
      acceptBodyEncoding: ['base64'],
    })
    expect(frame.current.projectId).toBeUndefined()
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toContain('data: hi')
  })
})
