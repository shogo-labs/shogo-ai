// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { wrapSseStreamWithKeepalive } from '../sse-keepalive'

const enc = new TextEncoder()
const dec = new TextDecoder()

function controlled() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c } })
  return { stream, push: (s: string) => ctl.enqueue(enc.encode(s)), close: () => ctl.close() }
}

const frame = (n: number) => `data: {"n":${n}}\n\n`

const inflight = new WeakMap<object, Promise<string | null>>()
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) {
  // Reuse a read that previously timed out so it can't swallow a later chunk.
  let p = inflight.get(reader)
  if (!p) {
    p = reader.read().then((r) => (r.done ? null : dec.decode(r.value)))
    inflight.set(reader, p)
  }
  const res = await Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])
  if (res !== 'timeout') inflight.delete(reader)
  return res
}

describe('wrapSseStreamWithKeepalive frame integrity', () => {
  test('a chunk with several frames is delivered in full immediately', async () => {
    const src = controlled()
    const reader = wrapSseStreamWithKeepalive(src.stream).getReader()
    src.push(frame(1) + frame(2) + frame(3))
    const got = await readWithin(reader, 500)
    expect(got).toBe(frame(1) + frame(2) + frame(3))
  })

  test('does not build a backlog across many multi-frame chunks', async () => {
    const src = controlled()
    const reader = wrapSseStreamWithKeepalive(src.stream).getReader()
    let sent = ''
    let received = ''
    for (let i = 0; i < 50; i++) {
      const chunk = frame(i * 2) + frame(i * 2 + 1)
      sent += chunk
      src.push(chunk)
      const got = await readWithin(reader, 500)
      expect(got).not.toBe('timeout')
      received += got
      // Everything sent so far must already be delivered (no lag in frames).
      expect(received).toBe(sent)
    }
  })

  test('holds only the incomplete tail and completes it on the next chunk', async () => {
    const src = controlled()
    const reader = wrapSseStreamWithKeepalive(src.stream).getReader()
    src.push(frame(1) + 'data: {"n":')
    expect(await readWithin(reader, 500)).toBe(frame(1))
    expect(await readWithin(reader, 50)).toBe('timeout')
    src.push('2}\n\n')
    expect(await readWithin(reader, 500)).toBe(frame(2))
  })

  test('flushes an incomplete tail on close and preserves byte order', async () => {
    const src = controlled()
    const reader = wrapSseStreamWithKeepalive(src.stream).getReader()
    src.push(frame(1) + 'data: {"n"')
    src.close()
    let out = ''
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      out += dec.decode(r.value)
    }
    expect(out).toBe(frame(1) + 'data: {"n"')
  })

  test('keepalive is never inserted inside a frame', async () => {
    const src = controlled()
    const reader = wrapSseStreamWithKeepalive(src.stream, 20).getReader()
    src.push('data: {"n":')
    await new Promise((r) => setTimeout(r, 60)) // timer fires mid-frame
    src.push('1}\n\n' + frame(2))
    let out = ''
    for (let i = 0; i < 5 && !out.includes(frame(2)); i++) {
      const got = await readWithin(reader, 300)
      if (got === 'timeout' || got === null) break
      out += got
    }
    expect(out.replace(/: proxy-keep-alive\n\n/g, '')).toBe(frame(1) + frame(2))
    expect(out.indexOf(': proxy-keep-alive')).toBeGreaterThan(out.indexOf('"n":1}\n\n') - 1)
    expect(out).not.toMatch(/data: \{"n":[^}]*: proxy/)
  })
})
