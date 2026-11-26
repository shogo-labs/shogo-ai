// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The native `EventSource` stand-in (SHO-580).
 *
 * These drive the real class through a fake `fetch`, because the thing being
 * fixed is the transport: the old one read an ever-growing `responseText` off
 * `XMLHttpRequest`, which is why a long-lived stream got slower and heavier the
 * longer it ran. Everything below is about the contract the callers rely on —
 * named events, custom headers, one `onerror` when the stream ends, and
 * `close()` silencing every callback.
 */

import { describe, expect, it } from 'bun:test'
import { NativeEventSource, type NativeSSEEvent } from '../event-source-native'

const encoder = new TextEncoder()

interface FakeFetch {
  calls: Array<{ url: string; init: RequestInit }>
  fetchImpl: typeof fetch
  push: (chunk: string | Uint8Array) => void
  close: () => void
}

function streamingFetch(chunks: string[] = []): FakeFetch {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk))
    },
  })
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return {
    calls,
    fetchImpl,
    push: (chunk) => controller?.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk),
    close: () => {
      try {
        controller?.close()
      } catch {
        // Already closed by the test.
      }
    },
  }
}

/** Let the reader's microtasks run. */
async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function collect(source: NativeEventSource) {
  const events: NativeSSEEvent[] = []
  const opened: NativeSSEEvent[] = []
  const errors: NativeSSEEvent[] = []
  source.onmessage = (event) => events.push(event)
  source.onopen = (event) => opened.push(event)
  source.onerror = (event) => errors.push(event)
  return { events, opened, errors }
}

describe('NativeEventSource', () => {
  it('streams events as they arrive, after one open', async () => {
    const fake = streamingFetch()
    const source = new NativeEventSource('https://api.test/stream', { fetchImpl: fake.fetchImpl })
    const { events, opened } = collect(source)

    fake.push('data: one\n\n')
    await tick()
    fake.push('data: two\n\n')
    await tick()

    expect(opened).toHaveLength(1)
    expect(events.map((e) => e.data)).toEqual(['one', 'two'])
    expect(source.readyState).toBe(NativeEventSource.OPEN)

    source.close()
  })

  it('sends the custom headers the native cookie needs', async () => {
    const fake = streamingFetch()
    const source = new NativeEventSource('https://api.test/stream', {
      headers: { Cookie: 'shogo.session_token=abc' },
      fetchImpl: fake.fetchImpl,
    })

    expect(fake.calls).toHaveLength(1)
    const headers = fake.calls[0].init.headers as Record<string, string>
    expect(headers.Cookie).toBe('shogo.session_token=abc')
    expect(headers.Accept).toBe('text/event-stream')
    expect(fake.calls[0].init.credentials).toBe('omit')

    source.close()
  })

  it('dispatches named events to their own listener and not to onmessage', async () => {
    const fake = streamingFetch()
    const source = new NativeEventSource('https://api.test/stream', { fetchImpl: fake.fetchImpl })
    const { events } = collect(source)
    const presence: NativeSSEEvent[] = []
    source.addEventListener('presence', (event) => presence.push(event))

    fake.push('event: presence\ndata: {"online":1}\n\n')
    await tick()

    expect(presence.map((e) => e.data)).toEqual(['{"online":1}'])
    expect(events).toHaveLength(0)

    source.close()
  })

  it('fires onerror once when the stream ends, so callers reconnect', async () => {
    const fake = streamingFetch(['data: last\n\n'])
    const source = new NativeEventSource('https://api.test/stream', { fetchImpl: fake.fetchImpl })
    const { events, errors } = collect(source)

    fake.close()
    await tick()

    expect(events.map((e) => e.data)).toEqual(['last'])
    expect(errors).toHaveLength(1)
    expect(source.readyState).toBe(NativeEventSource.CLOSED)
  })

  it('close() aborts the request and stops every callback', async () => {
    const fake = streamingFetch()
    const source = new NativeEventSource('https://api.test/stream', { fetchImpl: fake.fetchImpl })
    const { events, errors } = collect(source)
    const named: NativeSSEEvent[] = []
    source.addEventListener('presence', (event) => named.push(event))

    await tick()
    const signal = fake.calls[0].init.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    source.close()
    expect(source.readyState).toBe(NativeEventSource.CLOSED)
    expect(signal.aborted).toBe(true)

    // Anything the stream still delivers after close is ignored.
    fake.push('data: too late\n\nevent: presence\ndata: too late\n\n')
    await tick()
    fake.close()
    await tick()

    expect(events).toHaveLength(0)
    expect(named).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  it('fires only onerror for a response that is not ok', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof fetch
    const source = new NativeEventSource('https://api.test/stream', { fetchImpl })
    const { opened, errors } = collect(source)

    await tick()

    expect(opened).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(source.readyState).toBe(NativeEventSource.CLOSED)
  })

  it('parses a non-streaming body too', async () => {
    const fetchImpl = (async () =>
      new Response('data: one\n\ndata: two\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch
    const source = new NativeEventSource('https://api.test/stream', { fetchImpl })
    const { events } = collect(source)

    await tick()

    expect(events.map((e) => e.data)).toEqual(['one', 'two'])
  })

  it('decodes multi-byte characters split across chunks', async () => {
    const fake = streamingFetch()
    const source = new NativeEventSource('https://api.test/stream', { fetchImpl: fake.fetchImpl })
    const { events } = collect(source)

    // Split the 2-byte sequence for "é" across two reads.
    const bytes = encoder.encode('data: caf\u00e9\n\n')
    const split = bytes.indexOf(0xc3) + 1
    fake.push(bytes.slice(0, split))
    await tick()
    fake.push(bytes.slice(split))
    await tick()

    expect(events.map((e) => e.data)).toEqual(['caf\u00e9'])

    source.close()
  })
})
