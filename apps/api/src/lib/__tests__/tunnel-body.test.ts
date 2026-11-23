// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Download windows (SHO-526).
 *
 * A whole MP4 cannot cross one WebSocket frame: Bun caps a frame at 16 MiB and
 * the frame carries base64, so a big file used to close the tunnel socket for
 * every request on that machine. Downloads are fetched in windows the runtime
 * already knows how to serve (`Range` → 206) and streamed as one response.
 */

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  TUNNEL_DOWNLOAD_WINDOW_BYTES,
  isWorkspaceDownloadPath,
  relayWorkspaceDownload,
  tunnelResponseBody,
} from '../tunnel-body'

const W = TUNNEL_DOWNLOAD_WINDOW_BYTES

function fixture(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff
  return out
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

/** A stand-in for the agent-runtime's `fileRangeResponse`. */
function fakeRuntime(file: Uint8Array) {
  const calls: Array<{ path: string; range?: string }> = []
  const send = async (path: string, headers: Record<string, string>) => {
    calls.push({ path, range: headers.range })
    const match = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? '')
    if (!match) {
      return {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(file.length) },
        body: b64(file),
        bodyEncoding: 'base64' as const,
      }
    }
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), file.length - 1) : file.length - 1
    return {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${end}/${file.length}`,
        'accept-ranges': 'bytes',
      },
      body: b64(file.subarray(start, end + 1)),
      bodyEncoding: 'base64' as const,
    }
  }
  return { send, calls }
}

describe('isWorkspaceDownloadPath', () => {
  test('only a GET of the download path is windowed', () => {
    expect(isWorkspaceDownloadPath('GET', '/agent/workspace/download/a.png')).toBe(true)
    expect(isWorkspaceDownloadPath('POST', '/agent/workspace/download/a.png')).toBe(false)
    expect(isWorkspaceDownloadPath('GET', '/agent/status')).toBe(false)
  })
})

describe('tunnelResponseBody', () => {
  test('decodes a base64 frame back to the same bytes', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0xc3, 0x28])
    expect([...tunnelResponseBody({ body: b64(bytes), bodyEncoding: 'base64' }) as Uint8Array]).toEqual([
      ...bytes,
    ])
  })

  test('leaves a text frame alone', () => {
    expect(tunnelResponseBody({ body: '{"ok":true}' })).toBe('{"ok":true}')
  })
})

describe('relayWorkspaceDownload', () => {
  const file = fixture(10 * 1024 * 1024)

  test('no Range: one 200 whose bytes match the file, every frame inside the window', async () => {
    const runtime = fakeRuntime(file)

    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/clip.mp4',
      headers: {},
      send: runtime.send,
    })
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(file.length))
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(sha(bytes)).toBe(sha(file))
    expect(runtime.calls.length).toBe(Math.ceil(file.length / W))
    for (const call of runtime.calls) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(call.range!)!
      expect(Number(match[2]) - Number(match[1]) + 1).toBeLessThanOrEqual(W)
    }
  })

  test('open-ended Range: 206 of one window with the runtime\u2019s Content-Range', async () => {
    const runtime = fakeRuntime(file)

    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/clip.mp4',
      headers: { range: 'bytes=0-' },
      send: runtime.send,
    })
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]!.range).toBe(`bytes=0-${W - 1}`)
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-${W - 1}/${file.length}`)
    expect(bytes.length).toBe(W)
    expect(sha(bytes)).toBe(sha(file.subarray(0, W)))
  })

  test('a Range bigger than a window is clamped to one window', async () => {
    const runtime = fakeRuntime(file)

    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/clip.mp4',
      headers: { range: `bytes=${W}-` },
      send: runtime.send,
    })
    await res.arrayBuffer()

    expect(runtime.calls[0]!.range).toBe(`bytes=${W}-${2 * W - 1}`)
    expect(res.status).toBe(206)
  })

  test('a Range that already fits is forwarded exactly as the client sent it', async () => {
    const runtime = fakeRuntime(file)

    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/clip.mp4',
      headers: { range: 'bytes=100-199' },
      send: runtime.send,
    })
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]!.range).toBe('bytes=100-199')
    expect(res.status).toBe(206)
    expect([...bytes]).toEqual([...file.subarray(100, 200)])
  })

  test('a file smaller than one window arrives complete in a single 200', async () => {
    const small = fixture(1024)
    const runtime = fakeRuntime(small)

    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/a.png',
      headers: {},
      send: runtime.send,
    })
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(runtime.calls).toHaveLength(1)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('1024')
    expect(sha(bytes)).toBe(sha(small))
  })

  test('a runtime that ignores Range is passed through untouched', async () => {
    const small = fixture(1024)
    const runtime = fakeRuntime(small)
    const ignoresRange = async (path: string, _headers: Record<string, string>) => ({
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(small.length) },
      body: b64(small),
      bodyEncoding: 'base64' as const,
    })

    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/a.png',
      headers: {},
      send: ignoresRange,
    })

    expect(res.status).toBe(200)
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(small))
    void runtime
  })

  test('an older desktop (text frames) gets the plain request back, not a truncated file', async () => {
    const textOnly = async (path: string, headers: Record<string, string>) => {
      calls.push({ path, range: headers.range })
      if (headers.range) {
        return { status: 206, headers: { 'content-range': `bytes 0-${W - 1}/${file.length}` }, body: 'mangled' }
      }
      return { status: 200, headers: { 'content-type': 'video/mp4' }, body: 'whole-but-mangled' }
    }
    const calls: Array<{ path: string; range?: string }> = []

    const res = await relayWorkspaceDownload({
      agentPath: '/agent/workspace/download/clip.mp4',
      headers: {},
      send: textOnly,
    })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.range).toBeUndefined()
    expect(await res.text()).toBe('whole-but-mangled')
  })
})
