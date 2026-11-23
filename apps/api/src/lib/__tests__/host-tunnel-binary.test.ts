// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-538 (SHO-526's byte fix, still missing on this path) — a hosted
 * workspace's files cross the tunnel as bytes, not as text.
 *
 * `handleHostTunnel` used to forward without `acceptBodyEncoding` and answer with
 * `resp.body` as a string, so the desktop sent binary as text and every PNG or
 * clip arrived UTF-8-mangled. It now asks for base64 and decodes with the shared
 * `tunnelResponseBody`, and a whole file goes through the same
 * `relayWorkspaceDownload` windower the instance proxy uses — one insert point,
 * no copy.
 *
 *   bun test apps/api/src/lib/__tests__/host-tunnel-binary.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'

/** A real PNG signature plus bytes that are not valid UTF-8 — the lossy trip shows. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe,
  0x80, 0x81, 0xc3, 0x28,
])

/** 9 MiB: three windows of 4 MiB, so the windower has to do its job. */
const CLIP = new Uint8Array(9 * 1024 * 1024).map((_, i) => (i * 37) % 251)

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const state: {
  forwarded: Array<{ instanceId: string; payload: any }>
} = { forwarded: [] }

mock.module('../prisma', () => ({
  prisma: {
    workspace: { findUnique: async () => ({ hostInstanceId: 'inst-1' }) },
    project: { findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }) },
    instance: { findUnique: async () => ({ id: 'inst-1', name: 'Studio Mac', userId: 'user-1' }) },
  },
}))

const { handleHostTunnel, hostTunnelRuntimeUrl, _resetHostCacheForTests } = await import('../host-tunnel')

const secret = new URL(hostTunnelRuntimeUrl('inst-1', { workspaceId: 'ws-1' })).pathname.split('/')[4]
const tunnelPath = (rest: string) => `/api/internal/host-tunnel/${secret}/inst-1${rest}`

/** What the desktop answers: text unless the caller asked for base64 (SHO-526). */
function frame(bytes: Uint8Array, asksBase64: boolean, status = 200, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { 'content-type': 'image/png', ...headers },
    body: Buffer.from(bytes).toString(asksBase64 ? 'base64' : 'utf8'),
    ...(asksBase64 ? { bodyEncoding: 'base64' as const } : {}),
  }
}

/** Native `Range` support, the way the runtime answers `/agent/workspace/download`. */
function ranged(bytes: Uint8Array, headers: Record<string, string>, asksBase64: boolean) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? '')
  if (!match) return frame(bytes, asksBase64)
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), bytes.byteLength - 1)
  return frame(bytes.slice(start, end + 1), asksBase64, 206, {
    'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
  })
}

const tunnel = {
  async wakeHostTunnel(instanceId: string) {
    return {
      state: 'connected' as const,
      instanceId,
      name: 'Studio Mac',
      lastSeenAt: new Date(),
      retryAfterSeconds: 0,
    }
  },
  async sendTunnelRequest(instanceId: string, payload: any) {
    state.forwarded.push({ instanceId, payload })
    const asksBase64 = Array.isArray(payload.acceptBodyEncoding) && payload.acceptBodyEncoding.includes('base64')
    if (payload.path.includes('/agent/workspace/download/')) {
      const bytes = payload.path.includes('clip.mp4') ? CLIP : PNG
      return ranged(bytes, payload.headers ?? {}, asksBase64)
    }
    return frame(PNG, asksBase64)
  },
  sendTunnelStreamRequest() {
    return { cancel() {} }
  },
  generateRequestId: () => 'req-1',
  ensureTunnelConnected: async () => true,
}

function app() {
  const a = new Hono()
  a.all('/api/internal/host-tunnel/*', (c) =>
    handleHostTunnel(c, {
      _peerAddress: '127.0.0.1',
      _hostOf: async () => 'inst-1',
      _tunnel: tunnel as any,
    }),
  )
  return a
}

beforeEach(() => {
  _resetHostCacheForTests()
  state.forwarded = []
})

describe('handleHostTunnel — binary bodies', () => {
  test('the request asks the desktop for base64, because the tunnel is text', async () => {
    await app().request(tunnelPath('/api/workspaces/ws-1/agent-proxy/agent/status'), { method: 'GET' })
    expect(state.forwarded[0].payload.acceptBodyEncoding).toEqual(['base64'])
  })

  test('a PNG comes back byte-identical', async () => {
    const res = await app().request(
      tunnelPath('/api/workspaces/ws-1/agent-proxy/agent/workspace/download/a.png'),
      { method: 'GET' },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(PNG))
  })

  test('a whole clip is windowed, not sent as one frame', async () => {
    const res = await app().request(
      tunnelPath('/api/workspaces/ws-1/agent-proxy/agent/workspace/download/clip.mp4'),
      { method: 'GET' },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(CLIP.byteLength))
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(CLIP))
    // One round trip per window, not one for the file.
    expect(state.forwarded.length).toBeGreaterThan(1)
  })

  test("the client's range is forwarded, so a hosted workspace's video can be seeked", async () => {
    const res = await app().request(
      tunnelPath('/api/workspaces/ws-1/agent-proxy/agent/workspace/download/clip.mp4'),
      { method: 'GET', headers: { range: 'bytes=0-1023' } },
    )

    expect(res.status).toBe(206)
    expect((await res.arrayBuffer()).byteLength).toBe(1024)
    expect(state.forwarded[0].payload.headers.range).toBe('bytes=0-1023')
  })
})
