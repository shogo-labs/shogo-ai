// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A GET that is slow but alive is never aborted (SHO-582).
 *
 * SHO-580's GET deadline exists for a connection that stalls — the socket is up
 * and no answer ever comes. Over a real socket this pins the other side of that
 * rule: an answer that starts inside the deadline and then dribbles in for far
 * longer than it must still be delivered, because the request is alive and only
 * a starved *client* could be blamed for the slowness.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import http from 'node:http'

import { HttpClient } from '../client'

const servers: Array<{ baseUrl: string; stop: () => void }> = []

/** Answers at once, then writes the body in small pieces over `totalMs`. */
function startDribblingServer(totalMs: number, chunks = 10): Promise<string> {
  return new Promise((resolve) => {
    const sockets = new Set<import('node:net').Socket>()
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const step = Math.max(1, Math.floor(totalMs / chunks))
      let sent = 0
      const timer = setInterval(() => {
        sent += 1
        res.write(sent === chunks ? '{"ok":true}' : ' ')
        if (sent >= chunks) {
          clearInterval(timer)
          res.end()
        }
      }, step)
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      servers.push({
        baseUrl: `http://127.0.0.1:${port}`,
        stop: () => {
          for (const socket of sockets) socket.destroy()
          server.close()
        },
      })
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

afterEach(() => {
  while (servers.length) servers.pop()!.stop()
})

describe('SHO-582 — a slow-but-alive GET is not cut off', () => {
  test('a body that takes four deadlines to arrive is still delivered', async () => {
    const baseUrl = await startDribblingServer(400, 10)
    const client = new HttpClient({ baseUrl, requestTimeoutMs: 100 })

    const started = Date.now()
    const response = await client.get<{ ok: boolean }>('/api/chat-sessions')
    const elapsed = Date.now() - started

    expect(response.data).toEqual({ ok: true })
    // It really was slower than the deadline: the test proves the rule, not a
    // fast server.
    expect(elapsed).toBeGreaterThan(100)
  })
})
