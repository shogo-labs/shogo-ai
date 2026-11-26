// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-580 acceptance (AC5): a stalled GET ends, over a real socket.
 *
 * `client.test.ts` pins the deadline against a fake `fetch`. This runs the same
 * client against a real HTTP server through the runtime's real `fetch`, so the
 * abort has to travel through the transport and come back as the retryable
 * error the screen shows — and a POST, which is work in progress, must not be
 * cut off by the same deadline.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import http from 'node:http'

import { HttpClient } from '../client'
import { ShogoError } from '../../errors.js'

interface TestServer {
  baseUrl: string
  /** Resolves once the client has dropped its connection. */
  closed: Promise<void>
  stop: () => void
}

const servers: TestServer[] = []

/**
 * `behaviour` decides the answer per request:
 *  - 'never'     accept and never answer (a stalled connection)
 *  - 'later'     answer after `delayMs`
 *  - 'json'      answer immediately
 */
function startServer(
  behaviour: 'never' | 'later' | 'json',
  delayMs = 0,
): Promise<TestServer> {
  return new Promise((resolve) => {
    let resolveClosed: () => void = () => {}
    const closed = new Promise<void>((r) => (resolveClosed = r))
    const sockets = new Set<import('node:net').Socket>()

    const server = http.createServer((req, res) => {
      req.on('close', () => resolveClosed())
      if (behaviour === 'never') return
      const send = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, method: req.method }))
      }
      if (behaviour === 'later') setTimeout(send, delayMs)
      else send()
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      servers.push({
        baseUrl: `http://127.0.0.1:${port}`,
        closed,
        stop: () => {
          for (const socket of sockets) socket.destroy()
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

describe('SHO-580 AC5 — a stalled GET fails after the deadline', () => {
  test('the GET rejects as a network error, and the retry works', async () => {
    const stalled = await startServer('never')
    const client = new HttpClient({ baseUrl: stalled.baseUrl, requestTimeoutMs: 120 })

    const started = Date.now()
    const error = (await client.get('/api/projects').then(
      () => null,
      (err) => err as ShogoError,
    )) as ShogoError | null
    const elapsed = Date.now() - started

    expect(error).toBeInstanceOf(ShogoError)
    expect(error!.code).toBe('NETWORK_ERROR')
    expect(error!.message).toContain('timed out after 120 ms')
    // It waited for the deadline, and it did not hang past it.
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(3_000)
    // The connection really was dropped, not just ignored.
    await stalled.closed

    // Retryable: the same call against a healthy server answers.
    const healthy = await startServer('json')
    const retry = await new HttpClient({ baseUrl: healthy.baseUrl, requestTimeoutMs: 120 })
      .get<{ ok: boolean }>('/api/projects')
    expect(retry.data).toEqual({ ok: true, method: 'GET' })
  })

  test('a POST is not cut off by the GET deadline', async () => {
    const slow = await startServer('later', 400)
    const client = new HttpClient({ baseUrl: slow.baseUrl, requestTimeoutMs: 100 })

    const response = await client.post<{ ok: boolean; method: string }>('/api/projects/import', {
      data: 'x',
    })

    expect(response.data.method).toBe('POST')
  })

  test("the caller's own abort is an AbortError, not a timeout", async () => {
    const stalled = await startServer('never')
    const client = new HttpClient({ baseUrl: stalled.baseUrl, requestTimeoutMs: 5_000 })
    const controller = new AbortController()

    const pending = client.request('/api/projects', { method: 'GET', signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const error = (await pending.then(
      () => null,
      (err) => err as Error,
    )) as Error | null

    expect(error).toBeTruthy()
    expect(error!.message).not.toContain('timed out')
  })

  test('without a configured deadline a slow GET still answers, as it always did', async () => {
    const slow = await startServer('later', 250)
    const client = new HttpClient({ baseUrl: slow.baseUrl })

    const response = await client.get<{ ok: boolean }>('/api/projects')
    expect(response.data.ok).toBe(true)
  })
})
