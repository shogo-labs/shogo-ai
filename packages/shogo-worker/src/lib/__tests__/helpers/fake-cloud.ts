// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A fake Shogo cloud, in its own process, for the tunnel-block test.
 *
 * It has to be a separate process and not an in-test server: the test blocks the
 * main thread on purpose, and an observer on that thread cannot see the pings it
 * is supposed to be policing. Here the pings keep flowing while the API's thread
 * is busy, which is exactly how the real cloud behaves.
 *
 * Speaks the real protocol: `POST /api/instances/heartbeat` (asking for a socket
 * and advertising its URL), `GET /api/instances/ws` upgrade, `{type:'ping'}`
 * every 40ms answered by `{type:'pong'}`, and a close (1006) for a socket that
 * misses the deadline — the same idle check the cloud runs.
 *
 * Reports over stdout, one JSON object per line: `ready`, `pong`, `kill`,
 * `request`, `close`.
 */

const PING_INTERVAL_MS = Number(process.env.FAKE_CLOUD_PING_MS ?? 40)
const PONG_DEADLINE_MS = Number(process.env.FAKE_CLOUD_DEADLINE_MS ?? 120)

const say = (line: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

let socket: any = null
let awaitingPongSince: number | null = null
let kills = 0

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/api/instances/ws') {
      if (srv.upgrade(req)) return undefined as any
      return new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/api/instances/heartbeat') {
      return Response.json({
        instanceId: 'inst-worker-1',
        wsRequested: true,
        nextPollIn: 30,
        wsUrl: `ws://127.0.0.1:${srv.port}`,
      })
    }
    return new Response('{}', { status: 404 })
  },
  websocket: {
    open(ws) {
      socket = ws
      awaitingPongSince = null
    },
    message(_ws, raw) {
      let message: any
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (message.type === 'pong') {
        awaitingPongSince = null
        say({ event: 'pong' })
        return
      }
      if (message.type === 'response') {
        say({ event: 'request', status: message.status, body: String(message.body ?? '').slice(0, 200) })
        return
      }
      if (message.type === 'stream-chunk' || message.type === 'stream-end') {
        say({ event: 'request', status: 200, body: 'stream' })
      }
    },
    close(_ws, code) {
      socket = null
      say({ event: 'close', code })
    },
  },
})

setInterval(() => {
  if (!socket) return
  if (awaitingPongSince === null) {
    awaitingPongSince = Date.now()
  } else if (Date.now() - awaitingPongSince > PONG_DEADLINE_MS) {
    kills += 1
    say({ event: 'kill', kills })
    try {
      socket.close(1006, 'no pong')
    } catch {
      // already gone
    }
    socket = null
    awaitingPongSince = null
    return
  }
  try {
    socket.send(JSON.stringify({ type: 'ping' }))
  } catch {
    // socket went away
  }
}, PING_INTERVAL_MS)

// The test drives requests over stdin (one JSON object per line), because a
// spawned child has no IPC channel to listen on.
void (async () => {
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message?.type === 'request' && socket) {
        socket.send(
          JSON.stringify({
            type: 'request',
            requestId: message.requestId,
            method: 'GET',
            path: message.path,
            headers: {},
          }),
        )
      }
    }
  }
})()

say({ event: 'ready', port: server.port })
