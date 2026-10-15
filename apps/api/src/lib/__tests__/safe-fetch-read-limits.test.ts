// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * When a response read stops. `stopAt` is what lets a link preview stop at
 * `</head>` instead of dragging in the megabytes of script behind it, and the
 * ceiling is what keeps a hostile or merely enormous page from filling memory.
 *
 * The address is passed explicitly to `requestPinned` here — the public-address
 * check lives one layer up in `resolvePublicUrl` — so a loopback server can be
 * used to exercise the real socket path.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeReadLimiter, requestPinned } from '../safe-fetch'

let server: http.Server | null = null

afterEach(async () => {
  const closing = server
  server = null
  if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()))
})

/** Serves `chunks`, one `res.write` each, and resolves with the base URL. */
async function serve(chunks: string[]): Promise<string> {
  server = http.createServer((_req, res) => {
    res.on('error', () => {})
    res.writeHead(200, { 'Content-Type': 'text/html' })
    for (const chunk of chunks) res.write(chunk)
    res.end()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}/`
}

function read(url: string, opts: { maxBytes: number; stopAt?: string }) {
  return requestPinned(new URL(url), '127.0.0.1', { ...opts, headers: {}, signal: AbortSignal.timeout(5_000) })
}

const text = (body: Uint8Array) => new TextDecoder().decode(body)

describe('makeReadLimiter', () => {
  const chunks = (...parts: string[]) => parts.map((p) => Buffer.from(p))

  test('keeps reading until the ceiling', () => {
    const limiter = makeReadLimiter({ maxBytes: 10 })

    expect(limiter.push(Buffer.from('1234'))).toBe(false)
    expect(limiter.push(Buffer.from('5678'))).toBe(false)
    expect(limiter.push(Buffer.from('90'))).toBe(true)
  })

  test('stops on the marker', () => {
    const limiter = makeReadLimiter({ maxBytes: 1_000, stopAt: '</head>' })

    expect(limiter.push(Buffer.from('<head>'))).toBe(false)
    expect(limiter.push(Buffer.from('</head><body>'))).toBe(true)
  })

  test('sees a marker split across two chunks', () => {
    const limiter = makeReadLimiter({ maxBytes: 1_000, stopAt: '</head>' })

    expect(limiter.push(chunks('</he')[0]!)).toBe(false)
    expect(limiter.push(chunks('ad>')[0]!)).toBe(true)
  })

  test('sees a marker that starts on the last byte of a chunk', () => {
    const limiter = makeReadLimiter({ maxBytes: 1_000, stopAt: '</head>' })

    expect(limiter.push(Buffer.from('<title>x</'))).toBe(false)
    expect(limiter.push(Buffer.from('head>'))).toBe(true)
  })

  test('does not trip on a near miss that spans chunks', () => {
    const limiter = makeReadLimiter({ maxBytes: 1_000, stopAt: '</head>' })

    expect(limiter.push(Buffer.from('</hea'))).toBe(false)
    expect(limiter.push(Buffer.from('dx>'))).toBe(false)
  })

  test('the ceiling still applies when the marker never arrives', () => {
    const limiter = makeReadLimiter({ maxBytes: 8, stopAt: '</head>' })

    expect(limiter.push(Buffer.from('12345'))).toBe(false)
    expect(limiter.push(Buffer.from('6789'))).toBe(true)
  })
})

describe('requestPinned', () => {
  test('reads the whole document when it fits', async () => {
    const body = `<html><head><title>Small</title></head><body>${'y'.repeat(1_000)}</body></html>`
    const url = await serve([body])

    const res = await read(url, { maxBytes: 64 * 1024 })

    expect(res.status).toBe(200)
    expect(text(res.body)).toBe(body)
  })

  test('never reads past maxBytes', async () => {
    const url = await serve([`<html>${'z'.repeat(200_000)}</html>`])

    const res = await read(url, { maxBytes: 1_000 })

    expect(res.body.byteLength).toBe(1_000)
  })

  test('stops at the marker instead of reading the body behind it', async () => {
    const head = '<html><head><title>Wanted</title></head>'
    const url = await serve([head, `<body>${'w'.repeat(400_000)}</body>`])

    const res = await read(url, { maxBytes: 1024 * 1024, stopAt: '</head>' })

    expect(text(res.body)).toBe(head)
  })
})
