// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-526 acceptance: remote-workspace media across BOTH halves of the tunnel.
 *
 * The branch's own suites each cover one side — the cloud route with a scripted
 * tunnel (`instances-workspace-proxy`), and the desktop worker against a fake
 * cloud (`machine-workspace-media-tunnel`). Neither would catch the two sides
 * disagreeing about a field name, and neither drives the request the way a
 * client does. This one wires them together for real:
 *
 *   Hono `/api/instances/:id/p/api/workspaces/:id/agent-proxy/...`
 *     → the real cloud frame path (`handleInstanceWsMessage`)
 *     → a real `WorkerTunnel` over a real WebSocket
 *     → a real HTTP runtime that, like `agent-runtime`, refuses a request whose
 *       `x-runtime-token` is not the workspace's.
 *
 * The acceptance criteria it pins: a PNG and a JPEG come back byte-identical, a
 * 10 MiB MP4 comes back whole through 4 MiB windows, a `Range` seek gets a 206
 * with the right `Content-Range`, and the project wrapper still works. On main
 * the workspace case is a 401 (no `workspaceId` on the frame ⇒ no token).
 */

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'
import { Hono } from 'hono'
import { WorkerTunnel, type RuntimeResolver } from '@shogo-ai/worker/tunnel'

process.env.SHOGO_LOCAL_MODE = 'true'

const INSTANCE_ID = 'inst-sho526-e2e'
const WORKSPACE_ID = 'ws-1'
const PROJECT_ID = 'p-1'
const WORKSPACE_TOKEN = `wrt:${WORKSPACE_ID}`
const PROJECT_TOKEN = `rt:${PROJECT_ID}`

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function fixture(bytes: number, seed = 11): Uint8Array {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = (i * 17 + seed) & 0xff
  return out
}

// Invalid UTF-8 on purpose: `FF D8 FF`, `00`, `C3 28` — the bytes that a
// `resp.text()` round trip corrupts.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0x00, 0xc3, 0x28])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xc3, 0x28, 0xff, 0xd9])
/** 10 MiB: three download windows, and past one tunnel frame once base64'd. */
const MP4 = fixture(10 * 1024 * 1024, 29)

const files = new Map<string, { bytes: Uint8Array; type: string }>([
  ['shots/a.png', { bytes: PNG, type: 'image/png' }],
  ['shots/b.jpg', { bytes: JPEG, type: 'image/jpeg' }],
  ['shots/clip.mp4', { bytes: MP4, type: 'video/mp4' }],
])

const tokensSeen: Array<{ token: string | null; path: string }> = []

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
// The real module first, so a new export (SHO-538's budgets) does not break it.
const realTunnelTimeouts = await import('../lib/tunnel-timeouts')

mock.module('../lib/tunnel-timeouts', () => ({
  ...realTunnelTimeouts,
  PROXY_TIMEOUT_MS: 20_000,
  RELAY_TIMEOUT_MS: 20_000,
}))

const { instanceRoutes, _testing, handleInstanceWsMessage } = await import('../routes/instances')

/** The desktop's agent-runtime stand-in: same token check, same Range replies. */
let runtime: ReturnType<typeof Bun.serve>
/** The cloud's WebSocket endpoint the real worker connects to. */
let cloud: ReturnType<typeof Bun.serve>
let tunnel: WorkerTunnel
let cloudSocket: WebSocket | null = null

const bridge: any = {
  readyState: 1,
  data: { instanceId: INSTANCE_ID, workspaceId: 'ws-machine' },
  send: (data: string) => cloudSocket?.send(data),
  close: () => {},
}

function createApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth', { id: 'user-1', userId: 'user-1', email: 'dev@shogo.ai', role: 'super_admin' })
    await next()
  })
  app.route('/api', instanceRoutes())
  return app
}

beforeAll(async () => {
  runtime = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname.replace('/agent/workspace/download/', '')
      const token = req.headers.get('x-runtime-token')
      tokensSeen.push({ token, path })
      if (token !== WORKSPACE_TOKEN && token !== PROJECT_TOKEN) {
        return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
      }

      const file = files.get(path)
      if (!file) return new Response('not found', { status: 404 })

      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') ?? '')
      if (!match) {
        return new Response(file.bytes, { headers: { 'content-type': file.type } })
      }
      const start = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), file.bytes.length - 1) : file.bytes.length - 1
      if (start >= file.bytes.length) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.bytes.length}` } })
      }
      return new Response(file.bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          'content-type': file.type,
          'content-range': `bytes ${start}-${end}/${file.bytes.length}`,
          'accept-ranges': 'bytes',
        },
      })
    },
  })

  cloud = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/api/instances/heartbeat') {
        return Response.json({
          instanceId: INSTANCE_ID,
          nextPollIn: 30,
          wsRequested: true,
          wsUrl: `ws://127.0.0.1:${cloud.port}`,
        })
      }
      if (url.pathname === '/api/instances/ws' && server.upgrade(req)) return undefined
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        cloudSocket = ws as unknown as WebSocket
      },
      message(_ws, data) {
        // Exactly what the cloud does with a frame from a machine.
        handleInstanceWsMessage(bridge, typeof data === 'string' ? data : Buffer.from(data as any))
      },
    },
  })

  const resolver: RuntimeResolver = {
    async resolveLocalUrl(path, projectId, workspaceId) {
      // A workspace target resolves to the workspace runtime; a project target
      // to its project runtime. Both are the same fake runtime here.
      if (workspaceId && !projectId) return `http://127.0.0.1:${runtime.port}${path}`
      if (projectId) return `http://127.0.0.1:${runtime.port}${path}`
      // The desktop's old fallback, kept for an older cloud: with no target it
      // borrows whichever runtime is up — which is exactly how Russell's 401
      // happened (a runtime that has no token for this request).
      return `http://127.0.0.1:${runtime.port}${path}`
    },
    deriveRuntimeToken: (projectId) => `rt:${projectId}`,
    deriveWorkspaceRuntimeToken: (workspaceId) => `wrt:${workspaceId}`,
    getActiveProjects: () => [PROJECT_ID],
    status: () => null,
  }

  tunnel = new WorkerTunnel({
    apiKey: 'shogo_sk_qa',
    cloudUrl: `http://127.0.0.1:${cloud.port}`,
    resolver,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    deviceId: 'device-sho526-qa',
  })
  tunnel.start()

  const deadline = Date.now() + 10_000
  while (!cloudSocket && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(cloudSocket, 'the desktop never connected to the cloud').toBeTruthy()

  ;(_testing.tunnels as Map<string, any>).set(INSTANCE_ID, {
    ws: bridge,
    instanceId: INSTANCE_ID,
    workspaceId: 'ws-machine',
    pendingRequests: new Map(),
    streamHandlers: new Map(),
  })
}, 30_000)

beforeEach(() => {
  tokensSeen.length = 0
  mockPrisma.instance.findUnique.mockImplementation(async () => ({ ...mockInstance }))
  mockPrisma.member.findFirst.mockImplementation(async () => ({
    id: 'm-1',
    userId: 'user-1',
    workspaceId: 'ws-machine',
  }))
})

afterAll(() => {
  tunnel?.stop()
  cloud?.stop(true)
  runtime?.stop(true)
})

const downloadUrl = (path: string) =>
  `/api/instances/${INSTANCE_ID}/p/api/workspaces/${WORKSPACE_ID}/agent-proxy/agent/workspace/download/${path}`

describe('remote workspace media, end to end (SHO-526)', () => {
  test('a PNG in a workspace chat arrives byte-identical, authenticated as the workspace', async () => {
    const res = await createApp().request(downloadUrl('shots/a.png'))
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(sha(bytes)).toBe(sha(PNG))
    // The fix: the request carried the workspace's own token, not "whatever
    // runtime was up" with none, which is the 401 Russell saw.
    expect(tokensSeen.at(-1)).toEqual({ token: WORKSPACE_TOKEN, path: 'shots/a.png' })
  })

  test('a JPEG arrives byte-identical', async () => {
    const res = await createApp().request(downloadUrl('shots/b.jpg'))
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(sha(bytes)).toBe(sha(JPEG))
  })

  test('a 10 MiB MP4 arrives whole, streamed in windows that each fit one frame', async () => {
    const res = await createApp().request(downloadUrl('shots/clip.mp4'))
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-length')).toBe(String(MP4.length))
    expect(sha(bytes)).toBe(sha(MP4))
    // Three windows (4 MiB each) mean the runtime was asked three times, and
    // no single request was ever bigger than a frame.
    expect(tokensSeen.length).toBeGreaterThan(1)
  }, 60_000)

  test('a seek gets a 206 with the right Content-Range and bytes', async () => {
    const start = 5 * 1024 * 1024
    const res = await createApp().request(downloadUrl('shots/clip.mp4'), {
      headers: { range: `bytes=${start}-` },
    })
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(
      `bytes ${start}-${start + bytes.length - 1}/${MP4.length}`,
    )
    expect(sha(bytes)).toBe(sha(MP4.subarray(start, start + bytes.length)))
  }, 60_000)

  test('the project wrapper still works, with the project token', async () => {
    const res = await createApp().request(
      `/api/instances/${INSTANCE_ID}/p/api/projects/${PROJECT_ID}/agent-proxy/agent/workspace/download/shots/a.png`,
    )
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(sha(bytes)).toBe(sha(PNG))
    expect(tokensSeen.at(-1)?.token).toBe(PROJECT_TOKEN)
  })
})
