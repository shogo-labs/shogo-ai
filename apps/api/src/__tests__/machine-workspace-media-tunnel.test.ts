// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end through a real tunnel: a remote workspace's media (SHO-526).
 *
 * Every other test in this card checks one half of the protocol. This one pairs
 * the halves the way production does: the real `WorkerTunnel` (the desktop,
 * shipped in `@shogo-ai/worker`) connects over a real WebSocket to a cloud that
 * speaks the frames `instances.ts` sends, resolves a workspace runtime, and the
 * cloud decodes the reply with the real `tunnelResponseBody` /
 * `relayWorkspaceDownload`.
 *
 * The runtime stand-in is a real HTTP server that answers `Range` the way
 * `fileRangeResponse` does, and — like a runtime — refuses a request without the
 * workspace token. So the pre-fix shape is reproduced here too: a frame that
 * names no target gets no token and is answered 401.
 */

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { WorkerTunnel, type RuntimeResolver } from '@shogo-ai/worker/tunnel'
import { relayWorkspaceDownload, tunnelResponseBody } from '../lib/tunnel-body'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0x00, 0xc3, 0x28])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xc3, 0x28, 0xff, 0xd9])

function fixture(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = (i * 17 + 11) & 0xff
  return out
}

/** 23 MiB — past one frame, and past the old socket limit once base64'd. */
const MP4 = fixture(23 * 1024 * 1024)

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const files = new Map<string, { bytes: Uint8Array; type: string }>([
  ['a.png', { bytes: PNG, type: 'image/png' }],
  ['b.jpg', { bytes: JPEG, type: 'image/jpeg' }],
  ['clip.mp4', { bytes: MP4, type: 'video/mp4' }],
])

const tokensSeen: Array<string | null> = []
let fileServer: ReturnType<typeof Bun.serve>
let cloud: ReturnType<typeof Bun.serve>
let tunnel: WorkerTunnel

const pending = new Map<string, (frame: any) => void>()
let socket: WebSocket | null = null
let sentFrames = 0

beforeAll(async () => {
  fileServer = Bun.serve({
    port: 0,
    fetch(req) {
      const token = req.headers.get('x-runtime-token')
      tokensSeen.push(token)
      // A workspace runtime authenticates with the workspace token; without one
      // it answers exactly this (the 401 Russell saw).
      if (token !== 'wrt:ws-1') {
        return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }

      const file = files.get(new URL(req.url).pathname.replace('/agent/workspace/download/', ''))
      if (!file) return new Response('not found', { status: 404 })

      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') ?? '')
      if (!range) {
        return new Response(file.bytes, { headers: { 'content-type': file.type } })
      }
      const start = Number(range[1])
      const end = range[2] ? Math.min(Number(range[2]), file.bytes.length - 1) : file.bytes.length - 1
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
          instanceId: 'inst-1',
          nextPollIn: 30,
          wsRequested: true,
          // The cloud advertises the tunnel *base*; the worker appends the path.
          wsUrl: `ws://127.0.0.1:${cloud.port}`,
        })
      }
      if (url.pathname === '/api/instances/ws' && server.upgrade(req)) return undefined
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        socket = ws as unknown as WebSocket
      },
      message(_ws, data) {
        const frame = JSON.parse(String(data))
        if (frame.type === 'response' && pending.has(frame.requestId)) {
          pending.get(frame.requestId)!(frame)
          pending.delete(frame.requestId)
        }
      },
    },
  })

  const resolver: RuntimeResolver = {
    async resolveLocalUrl(path, projectId, workspaceId) {
      if (workspaceId && !projectId) return `http://127.0.0.1:${fileServer.port}${path}`
      // The old fallback: with no target, borrow whatever runtime is up.
      if (!projectId && !workspaceId) return `http://127.0.0.1:${fileServer.port}${path}`
      return null
    },
    deriveRuntimeToken: () => 'rt:project-token',
    deriveWorkspaceRuntimeToken: (workspaceId) => `wrt:${workspaceId}`,
    getActiveProjects: () => [],
    status: () => null,
  }

  tunnel = new WorkerTunnel({
    apiKey: 'shogo_sk_test',
    cloudUrl: `http://127.0.0.1:${cloud.port}`,
    resolver,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    deviceId: 'device-sho526',
  })
  tunnel.start()

  const deadline = Date.now() + 5_000
  while (!socket && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(socket).toBeTruthy()
}, 20_000)

afterAll(() => {
  tunnel?.stop()
  cloud?.stop(true)
  fileServer?.stop(true)
})

/** One tunnel round trip, framed exactly as `instances.ts` frames it. */
function send(request: {
  path: string
  workspaceId?: string
  headers?: Record<string, string>
}): Promise<any> {
  const requestId = `req-${++sentFrames}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`frame ${requestId} timed out`)), 15_000)
    pending.set(requestId, (frame) => {
      clearTimeout(timer)
      resolve(frame)
    })
    socket!.send(
      JSON.stringify({
        type: 'request',
        requestId,
        method: 'GET',
        acceptBodyEncoding: ['base64'],
        ...request,
      }),
    )
  })
}

describe('a remote workspace\u2019s media through the real tunnel', () => {
  it('sends the workspace token, and a PNG arrives byte-identical', async () => {
    const frame = await send({
      path: '/agent/workspace/download/a.png',
      workspaceId: 'ws-1',
    })

    expect(frame.status).toBe(200)
    expect(frame.bodyEncoding).toBe('base64')
    const bytes = new Uint8Array(tunnelResponseBody(frame) as Uint8Array)
    expect(sha(bytes)).toBe(sha(PNG))
    expect(tokensSeen.at(-1)).toBe('wrt:ws-1')
  })

  it('a JPEG arrives byte-identical', async () => {
    const frame = await send({
      path: '/agent/workspace/download/b.jpg',
      workspaceId: 'ws-1',
    })
    const bytes = new Uint8Array(tunnelResponseBody(frame) as Uint8Array)
    expect(sha(bytes)).toBe(sha(JPEG))
  })

  it('a 23 MiB MP4 arrives whole, in windows that each fit one frame', async () => {
    const FRAME_LIMIT = 11 * 1024 * 1024
    const sizes: number[] = []
    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/clip.mp4',
      headers: {},
      send: async (path, headers) => {
        const frame = await send({ path, workspaceId: 'ws-1', headers })
        const bytes = tunnelResponseBody(frame)
        if (typeof bytes !== 'string') sizes.push(bytes.byteLength)
        return { ...frame, bodyEncoding: frame.bodyEncoding }
      },
    })
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(sha(bytes)).toBe(sha(MP4))
    expect(sizes.length).toBeGreaterThan(1)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(FRAME_LIMIT)
  }, 60_000)

  it('a seek gets a 206 and the right bytes', async () => {
    const start = 5 * 1024 * 1024
    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/clip.mp4',
      headers: { range: `bytes=${start}-` },
      send: async (path, headers) => {
        const frame = await send({ path, workspaceId: 'ws-1', headers })
        return { ...frame, bodyEncoding: frame.bodyEncoding }
      },
    })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const expected = MP4.subarray(start, start + bytes.length)

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(
      `bytes ${start}-${start + bytes.length - 1}/${MP4.length}`,
    )
    expect(sha(bytes)).toBe(sha(expected))
  }, 60_000)

  it('without a target the runtime answers 401 \u2014 the shape this card fixes', async () => {
    // Exactly what the cloud sent before the fix: no workspaceId, so no token,
    // and the desktop's "whichever runtime is up" fallback.
    const frame = await send({ path: '/agent/workspace/download/a.png' })

    expect(frame.status).toBe(401)
    expect(JSON.parse(frame.body).error.code).toBe('unauthorized')
    expect(tokensSeen.at(-1)).toBeNull()
  })
})
