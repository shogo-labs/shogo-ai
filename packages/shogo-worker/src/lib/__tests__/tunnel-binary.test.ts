// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Binary bodies and workspace-targeted requests through the tunnel (SHO-526).
 *
 * A remote workspace's images and video used to arrive corrupt even when auth
 * worked: the non-stream branch read every body with `resp.text()`, so a JPEG or
 * an MP4 took a lossy UTF-8 round trip. These tests drive the real `handleRequest`
 * against a real local HTTP server (the stand-in for the agent-runtime) and read
 * the frame the cloud would receive.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import {
  TUNNEL_MAX_FRAME_BODY_BYTES,
  WorkerTunnel,
  type RuntimeResolver,
} from '../tunnel'

// `FF D8 FF` is a JPEG SOI, `C3 28` is invalid UTF-8 on its own, and `00` is a
// NUL — none of them survive a TextDecoder/TextEncoder round trip.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0x00, 0xc3, 0x28])
const MP4_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xd8, 0xff, 0xc3, 0x28, 0x00, 0x80])

/** One byte over what one frame may carry — never base64-encoded, so it costs one allocation. */
const OVER_CAP_BYTES = new Uint8Array(TUNNEL_MAX_FRAME_BODY_BYTES + 1)

let server: ReturnType<typeof Bun.serve>
let baseUrl = ''

const seenAuth: Array<string | null> = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      seenAuth.push(req.headers.get('x-runtime-token'))

      if (path === '/agent/workspace/download/a.png') {
        return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
      }
      if (path === '/agent/workspace/download/clip.mp4') {
        return new Response(MP4_BYTES, { headers: { 'content-type': 'video/mp4' } })
      }
      if (path === '/agent/status') {
        return new Response(JSON.stringify({ ok: true, status: 'running' }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (path === '/agent/echo-token') {
        return new Response(JSON.stringify({ token: req.headers.get('x-runtime-token') }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (path === '/agent/huge') {
        // One byte over the frame budget: real bytes, because Bun rewrites a
        // Content-Length that disagrees with the body it is actually sending.
        return new Response(OVER_CAP_BYTES, { headers: { 'content-type': 'video/mp4' } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

// ─── Fake socket, so `handleRequest` has somewhere to write ──────────────────

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}

let socket: FakeWebSocket

afterEach(() => {
  socket.sent.length = 0
  seenAuth.length = 0
})

function makeResolver(overrides: Partial<RuntimeResolver> = {}): RuntimeResolver {
  return {
    resolveLocalUrl: async (pathWithQuery) => `${baseUrl}${pathWithQuery}`,
    deriveRuntimeToken: () => 'project-token',
    deriveWorkspaceRuntimeToken: () => 'workspace-token',
    getActiveProjects: () => [],
    status: () => null,
    ...overrides,
  }
}

function makeTunnel(resolver = makeResolver()) {
  const tunnel = new WorkerTunnel({
    apiKey: 'shogo_sk_test',
    cloudUrl: 'http://127.0.0.1:1',
    resolver,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  })
  socket = new FakeWebSocket()
  tunnel._testing().installFakeWs(socket as unknown as WebSocket)
  return tunnel
}

async function request(
  tunnel: WorkerTunnel,
  req: Record<string, unknown>,
): Promise<any> {
  await tunnel._testing().handleRequest({ type: 'request', requestId: 'r-1', method: 'GET', ...req } as any)
  return JSON.parse(socket.sent[socket.sent.length - 1]!)
}

describe('binary response frames (SHO-526)', () => {
  it('sends a PNG as base64 so it survives byte-for-byte', async () => {
    const tunnel = makeTunnel()
    const frame = await request(tunnel, {
      path: '/agent/workspace/download/a.png',
      workspaceId: 'ws-1',
      acceptBodyEncoding: ['base64'],
    })

    expect(frame.status).toBe(200)
    expect(frame.bodyEncoding).toBe('base64')
    expect(frame.headers['content-type']).toBe('image/png')
    // `fetch` already decompressed the body; a stale length/encoding would make
    // the cloud's Content-Length disagree with the bytes it writes.
    expect(frame.headers['content-length']).toBeUndefined()
    expect(frame.headers['content-encoding']).toBeUndefined()

    const bytes = new Uint8Array(Buffer.from(frame.body, 'base64'))
    expect([...bytes]).toEqual([...PNG_BYTES])
  })

  it('sends an MP4 as base64 too', async () => {
    const tunnel = makeTunnel()
    const frame = await request(tunnel, {
      path: '/agent/workspace/download/clip.mp4',
      workspaceId: 'ws-1',
      acceptBodyEncoding: ['base64'],
    })

    expect(frame.bodyEncoding).toBe('base64')
    expect([...new Uint8Array(Buffer.from(frame.body, 'base64'))]).toEqual([...MP4_BYTES])
  })

  it('leaves JSON as text', async () => {
    const tunnel = makeTunnel()
    const frame = await request(tunnel, { path: '/agent/status', acceptBodyEncoding: ['base64'] })

    expect(frame.bodyEncoding).toBeUndefined()
    expect(JSON.parse(frame.body)).toEqual({ ok: true, status: 'running' })
  })

  it('behaves exactly as before when the cloud does not negotiate base64', async () => {
    const tunnel = makeTunnel()
    const frame = await request(tunnel, { path: '/agent/workspace/download/a.png' })

    expect(frame.bodyEncoding).toBeUndefined()
    expect(frame.body).toBe(new TextDecoder().decode(PNG_BYTES))
  })

  it('answers a structured 502 instead of a frame that closes the socket', async () => {
    const tunnel = makeTunnel()
    const frame = await request(tunnel, { path: '/agent/huge', acceptBodyEncoding: ['base64'] })

    expect(frame.status).toBe(502)
    expect(frame.headers['content-type']).toBe('application/json')
    const body = JSON.parse(frame.body)
    expect(body.code).toBe('TUNNEL_BODY_TOO_LARGE')
    expect(body.limit).toBe(TUNNEL_MAX_FRAME_BODY_BYTES)
    expect(body.path).toBe('/agent/huge')
  })
})

describe('workspace target (SHO-526)', () => {
  it('resolves with the workspace id and mints the workspace token', async () => {
    const calls: Array<{ path: string; projectId?: string; workspaceId?: string }> = []
    const tunnel = makeTunnel(
      makeResolver({
        resolveLocalUrl: async (pathWithQuery, projectId, workspaceId) => {
          calls.push({ path: pathWithQuery, projectId, workspaceId })
          return `${baseUrl}${pathWithQuery}`
        },
      }),
    )

    const frame = await request(tunnel, { path: '/agent/echo-token', workspaceId: 'ws-1' })

    expect(calls).toEqual([{ path: '/agent/echo-token', projectId: undefined, workspaceId: 'ws-1' }])
    expect(JSON.parse(frame.body)).toEqual({ token: 'workspace-token' })
  })

  it('still uses the project token when a project is named', async () => {
    const tunnel = makeTunnel()
    const frame = await request(tunnel, { path: '/agent/echo-token', projectId: 'p-1' })

    expect(JSON.parse(frame.body)).toEqual({ token: 'project-token' })
  })

  it('sends no token when the cloud named no target (an older cloud)', async () => {
    const tunnel = makeTunnel()
    const frame = await request(tunnel, { path: '/agent/echo-token' })

    expect(JSON.parse(frame.body)).toEqual({ token: null })
  })
})
