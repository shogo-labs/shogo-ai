// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-580 acceptance: the mobile `EventSource` over a real HTTP stream.
 *
 * `event-source-native.test.ts` drives the class through a fake `fetch`, which
 * proves the parser and the callback contract but not the transport. This drives
 * the same class over a real socket through the app's real global `fetch`, which
 * is what the device uses — the thing AC3 is about ("10k events over one
 * connection parse each event exactly once").
 *
 * It needs a real `fetch`, so it must run in its own process — which is how this
 * package's suite runs (`scripts/run-tests-isolated.ts`, one file per process).
 * `app/__tests__/root-index-redirect.test.tsx` replaces `globalThis.fetch` at
 * module scope and never restores it, so a shared-process `bun test <dir>` would
 * hand this file a stub that answers without streaming.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import http from 'node:http'
import { NativeEventSource, type NativeSSEEvent } from '../event-source-native'

interface StreamServer {
  port: number
  /** Writes to the open stream; queued until the client's GET has landed. */
  write: (chunk: string) => void
  /** Headers of the GET requests the client sent. */
  requests: http.IncomingHttpHeaders[]
  /** Resolves once the client's connection has gone away. */
  closed: Promise<void>
  stop: () => void
}

const servers: StreamServer[] = []

function startServer(opts: { status?: number } = {}): Promise<StreamServer> {
  return new Promise((resolve) => {
    const requests: http.IncomingHttpHeaders[] = []
    let resolveClosed: () => void = () => {}
    const closed = new Promise<void>((r) => (resolveClosed = r))
    let writer: ((chunk: string) => void) | null = null
    const queue: string[] = []

    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    }

    const server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      requests.push(req.headers)
      if (opts.status && opts.status !== 200) {
        res.writeHead(opts.status, { 'content-type': 'text/plain', ...cors })
        res.end('nope')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors })
      writer = (chunk) => res.write(chunk)
      for (const chunk of queue.splice(0)) writer(chunk)
      req.on('close', () => {
        writer = null
        resolveClosed()
      })
      res.on('error', () => {})
    })
    server.on('clientError', (_err, socket) => socket.destroy())

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      servers.push({
        port,
        write: (chunk) => (writer ? writer(chunk) : queue.push(chunk)),
        requests,
        closed,
        stop: () => {
          server.closeAllConnections?.()
          server.close()
        },
      })
      resolve(servers[servers.length - 1])
    })
  })
}

afterEach(() => {
  while (servers.length) servers.pop()!.stop()
})

function collect(source: NativeEventSource) {
  const events: NativeSSEEvent[] = []
  const named: Record<string, NativeSSEEvent[]> = {}
  const opened: NativeSSEEvent[] = []
  const errors: NativeSSEEvent[] = []
  source.onopen = (event) => opened.push(event)
  source.onmessage = (event) => events.push(event)
  source.onerror = (event) => errors.push(event)
  source.addEventListener('tick', (event) => {
    ;(named.tick ??= []).push(event)
  })
  return { events, named, opened, errors }
}

async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('SHO-580 AC3 — 10k events over one real connection', () => {
  test('parses every event exactly once, in order, and keeps the ids', async () => {
    const server = await startServer()
    const source = new NativeEventSource(`http://127.0.0.1:${server.port}/events`)
    const seen = collect(source)

    const TOTAL = 10_000
    let buffer = ''
    for (let i = 0; i < TOTAL; i++) {
      // Every 1,000th event is a named event with a two-line payload; every
      // 2,000th block ends with CRLF instead of LF. Both are SSE the old
      // polyfill got wrong.
      const named = i % 1_000 === 0
      const eol = i % 2_000 === 0 ? '\r\n' : '\n'
      const lines = named
        ? ['event: tick', `id: ${i}`, `data: {"i":${i}}`, 'data: line-two']
        : [`id: ${i}`, `data: {"i":${i}}`]
      buffer += lines.join(eol) + eol + eol
      // Write in bursts of 250 and split one chunk in the middle of a block, so
      // the parser has to carry a partial event across reads.
      if (i % 250 === 249) {
        const cut = Math.floor(buffer.length / 2)
        server.write(buffer.slice(0, cut))
        server.write(buffer.slice(cut))
        buffer = ''
      }
    }
    if (buffer) server.write(buffer)

    await until(() => seen.events.length + (seen.named.tick?.length ?? 0) >= TOTAL, '10k events')

    const all = [...seen.events, ...(seen.named.tick ?? [])]
    expect(all).toHaveLength(TOTAL)
    const order = all
      .map((event) => JSON.parse(event.data!.split('\n')[0]).i as number)
      .sort((a, b) => a - b)
    expect(order).toEqual(Array.from({ length: TOTAL }, (_, i) => i))
    // Exactly once each: no duplicate id anywhere.
    expect(new Set(order).size).toBe(TOTAL)
    expect(seen.named.tick).toHaveLength(10)
    expect(source.lastEventId).toBe('9999')
    expect(seen.opened).toHaveLength(1)
    expect(seen.errors).toHaveLength(0)

    source.close()
  })

  test('delivers an event before the response ends', async () => {
    const server = await startServer()
    const source = new NativeEventSource(`http://127.0.0.1:${server.port}/events`)
    const seen = collect(source)

    server.write('data: first\n\n')
    await until(() => seen.events.length === 1, 'the first event')
    // The stream is still open: the old transport could only parse what XHR had
    // buffered, and this proves the new one hands over each read as it lands.
    server.write('data: second\n\n')
    await until(() => seen.events.length === 2, 'the second event')
    expect(seen.events.map((event) => event.data)).toEqual(['first', 'second'])

    source.close()
  })

  test('sends the caller headers on the request', async () => {
    // The native session travels as a `Cookie` header (`authed-event-source.ts`).
    // A browser emulator forbids that header outright, so it cannot be asserted
    // here; `expo/fetch`'s `normalizeHeadersInit` passes every caller header
    // through unfiltered, which is the same contract XHR had. This pins the part
    // the transport owns: the caller's headers reach the wire with the SSE ones.
    const server = await startServer()
    const source = new NativeEventSource(`http://127.0.0.1:${server.port}/events`, {
      headers: { 'X-Shogo-Test': 'qa-580' },
    })
    const seen = collect(source)
    server.write('data: hello\n\n')
    await until(() => seen.events.length === 1, 'one event')

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]['x-shogo-test']).toBe('qa-580')
    expect(server.requests[0].accept).toBe('text/event-stream')
    expect(server.requests[0]['cache-control']).toBe('no-cache')
    source.close()
  })
})

describe('SHO-580 AC3 — close() and failures', () => {
  test('close() stops every callback and drops the connection', async () => {
    const server = await startServer()
    const source = new NativeEventSource(`http://127.0.0.1:${server.port}/events`)
    const seen = collect(source)

    server.write('data: before\n\n')
    await until(() => seen.events.length === 1, 'one event')

    source.close()
    expect(source.readyState).toBe(NativeEventSource.CLOSED)
    // Anything the server sends afterwards must not reach a callback.
    server.write('data: after\n\n')
    await server.closed
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(seen.events.map((event) => event.data)).toEqual(['before'])
    expect(seen.errors).toHaveLength(0)
  })

  test('a 503 fires onerror only, and closes', async () => {
    const server = await startServer({ status: 503 })
    const source = new NativeEventSource(`http://127.0.0.1:${server.port}/events`)
    const seen = collect(source)

    await until(() => seen.errors.length === 1, 'onerror')
    expect(seen.opened).toHaveLength(0)
    expect(seen.events).toHaveLength(0)
    expect(source.readyState).toBe(NativeEventSource.CLOSED)
  })
})
