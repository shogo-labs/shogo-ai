// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guest-side port bridge (Phase 3 of the Tier 2 docker project class plan).
 *
 * The metal substrate keeps a SINGLE guest DNAT port (the runtime's own
 * `PORT`, 8080) — see the Tier 2 plan's "keep the single guest DNAT" decision.
 * Every other port a project's tech stack declares (e.g. `docker-compose`'s
 * Postgres on 5432) is reached THROUGH the runtime, not by teaching
 * `apps/metal-agent` to punch a hole per port. That keeps the host-side
 * network surface unchanged (still one inbound port per project) while still
 * letting a project reach arbitrary guest-local TCP services:
 *
 *   - `GET/POST/... /agent/ports/:port/http/*` — HTTP reverse proxy to
 *     `127.0.0.1:{port}`. A normal Hono route, so it's covered by the
 *     existing `/agent/*` `checkRuntimeAuth` middleware for free. Used by the
 *     public per-port preview (API renders through this with a runtime
 *     token, exactly like the root preview render proxy).
 *   - `GET /agent/ports/:port/ws` (upgrade) — a raw byte-pipe TCP bridge to
 *     `127.0.0.1:{port}`, for the client-side tunnel (arbitrary binary
 *     protocols — Postgres, Redis, anything that isn't HTTP). WS upgrades
 *     happen in the outer `Bun.serve` fetch handler (Hono never sees them),
 *     so its auth check is a small standalone byte-compare against
 *     `RUNTIME_AUTH_SECRET` done in server.ts BEFORE calling into this
 *     module — see `checkPortBridgeAuth`.
 *
 * Defense in depth: `SHOGO_EXPOSED_PORTS` (injected by
 * `apps/api/src/lib/runtime/build-project-env.ts` from the project's tech
 * stack's declared ports) is the guest-side allowlist for BOTH paths. Even if
 * a caller somehow obtained a valid runtime token and an arbitrary port
 * number, only ports the tech stack actually declares can be reached this
 * way — this is what stops the tunnel/preview surface from becoming a
 * generic "connect to anything listening in the guest" primitive.
 */

import type { ServerWebSocket, Socket } from 'bun'

/** Ports this project's tech stack declares, from `SHOGO_EXPOSED_PORTS` (comma-separated). Empty set = no ports exposed (every non-Docker stack today). */
export function allowedPorts(env: Record<string, string | undefined> = process.env): Set<number> {
  const raw = env.SHOGO_EXPOSED_PORTS
  if (!raw) return new Set()
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const n = Number(part.trim())
    if (Number.isInteger(n) && n > 0 && n <= 65535) out.add(n)
  }
  return out
}

export function isPortAllowed(port: number, env: Record<string, string | undefined> = process.env): boolean {
  return allowedPorts(env).has(port)
}

/** Parse `:port` from a Hono/route param — rejects anything that isn't a bare positive integer (no leading zeros games, no floats, no `Infinity`). */
export function parsePortParam(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]{0,4}$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 && n <= 65535 ? n : null
}

// ── HTTP reverse proxy (`/agent/ports/:port/http/*`) ───────────────────────

export interface PortHttpProxyRequest {
  method: string
  /** Path AFTER the `/agent/ports/:port/http` prefix, e.g. `/` or `/api/widgets`. */
  restPath: string
  search: string
  headers: Headers
  body: BodyInit | null
}

/**
 * Build the fetch() call to proxy an HTTP request to a guest-local port.
 * Pure aside from the actual `fetch` — injected so tests don't need a real
 * listener.
 */
export async function proxyPortHttp(
  port: number,
  req: PortHttpProxyRequest,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<Response> {
  if (!isPortAllowed(port, opts.env)) {
    return new Response(JSON.stringify({ error: `port ${port} is not exposed by this project` }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const target = `http://127.0.0.1:${port}${req.restPath || '/'}${req.search}`
  try {
    const res = await fetchImpl(target, {
      method: req.method,
      headers: req.headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      // @ts-ignore - duplex needed for streaming request bodies (Bun/undici)
      duplex: 'half',
    })
    return new Response(res.body, { status: res.status, headers: res.headers })
  } catch (err: any) {
    console.error(`[port-bridge] proxy to 127.0.0.1:${port} failed:`, err?.message ?? err)
    return new Response(JSON.stringify({ error: 'port not responding' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}

// ── Raw TCP bridge (`/agent/ports/:port/ws`) ────────────────────────────────

export const PORT_BRIDGE_WS_KIND = '__port_bridge_ws__'

export interface PortBridgeWsData {
  readonly __kind: typeof PORT_BRIDGE_WS_KIND
  port: number
  socket: Socket<undefined> | null
  socketReady: boolean
  /** Set once `connect()` has settled (either way) — distinguishes "still connecting, queue it" from "connect failed, drop it" for `!socketReady`. */
  connectSettled: boolean
  outboundQueue: Array<ArrayBuffer | Uint8Array>
  wsClosed: boolean
}

export function isPortBridgeWsData(data: unknown): data is PortBridgeWsData {
  return !!data && typeof data === 'object' && (data as { __kind?: string }).__kind === PORT_BRIDGE_WS_KIND
}

export function buildPortBridgeWsData(port: number): PortBridgeWsData {
  return {
    __kind: PORT_BRIDGE_WS_KIND,
    port,
    socket: null,
    socketReady: false,
    connectSettled: false,
    outboundQueue: [],
    wsClosed: false,
  }
}

/** Minimal surface the handlers need from Bun's TCP `connect()` — injectable for tests. */
export interface TcpConnector {
  connect(opts: {
    hostname: string
    port: number
    socket: {
      data(socket: unknown, data: Uint8Array): void
      open(socket: unknown): void
      close(socket: unknown): void
      error(socket: unknown, err: Error): void
    }
  }): Promise<{ write(data: Uint8Array): number; end(): void; readonly readyState?: string }>
}

export interface PortBridgeWsHandlers {
  open(ws: ServerWebSocket<PortBridgeWsData>): void
  message(ws: ServerWebSocket<PortBridgeWsData>, msg: ArrayBuffer | string | Uint8Array): void
  close(ws: ServerWebSocket<PortBridgeWsData>): void
}

/**
 * Create the raw byte-pipe handlers. `connector` defaults to Bun's real
 * `Bun.connect` (lazily required so this module stays importable/testable in
 * non-Bun test runners); tests inject a fake.
 */
export function createPortBridgeWsHandlers(opts: {
  connector?: TcpConnector
  env?: Record<string, string | undefined>
  logger?: { error(...args: unknown[]): void }
} = {}): PortBridgeWsHandlers {
  const log = opts.logger ?? console
  const connector: TcpConnector = opts.connector ?? {
    connect: (o) => (globalThis as any).Bun.connect(o),
  }

  return {
    open(ws) {
      const { port } = ws.data
      if (!isPortAllowed(port, opts.env)) {
        try { ws.close(4403, `port ${port} is not exposed by this project`) } catch {}
        return
      }

      connector
        .connect({
          hostname: '127.0.0.1',
          port,
          socket: {
            open(sock) {
              ws.data.socket = sock as any
              ws.data.socketReady = true
              ws.data.connectSettled = true
              if (ws.data.wsClosed) {
                try { (sock as any).end() } catch {}
                return
              }
              for (const frame of ws.data.outboundQueue) {
                try { (sock as any).write(new Uint8Array(frame as ArrayBufferLike)) } catch (err) {
                  log.error('[PortBridge] flush queued frame failed:', describeErr(err))
                }
              }
              ws.data.outboundQueue.length = 0
            },
            data(_sock, chunk) {
              if (ws.data.wsClosed) return
              try { ws.send(chunk, true) } catch (err) {
                log.error('[PortBridge] forward guest→client failed:', describeErr(err))
              }
            },
            close() {
              if (ws.data.wsClosed) return
              safeClose(ws, 1000, 'port-closed')
            },
            error(_sock, err) {
              log.error(`[PortBridge] tcp error on 127.0.0.1:${port}:`, describeErr(err))
              if (ws.data.wsClosed) return
              safeClose(ws, 1011, 'port-unreachable')
            },
          },
        })
        .catch((err: unknown) => {
          ws.data.connectSettled = true
          log.error(`[PortBridge] connect to 127.0.0.1:${port} failed:`, describeErr(err))
          safeClose(ws, 1011, 'port-unreachable')
        })
    },

    message(ws, msg) {
      const frame = normalizeInboundFrame(msg)
      if (frame == null) return
      const { socket, socketReady, connectSettled, outboundQueue } = ws.data
      if (socketReady && socket) {
        try { socket.write(new Uint8Array(frame)) } catch (err) {
          log.error('[PortBridge] forward client→guest failed:', describeErr(err))
        }
        return
      }
      if (connectSettled) return // connect() already failed; drop silently, close is imminent
      outboundQueue.push(frame)
    },

    close(ws) {
      ws.data.wsClosed = true
      const { socket } = ws.data
      if (!socket) return
      try { socket.end() } catch {}
    },
  }
}

function normalizeInboundFrame(msg: ArrayBuffer | string | Uint8Array): ArrayBuffer | null {
  if (typeof msg === 'string') return new TextEncoder().encode(msg).buffer
  if (msg instanceof ArrayBuffer) return msg
  if (msg instanceof Uint8Array) {
    const copy = new Uint8Array(msg.byteLength)
    copy.set(msg)
    return copy.buffer
  }
  return null
}

function safeClose(ws: ServerWebSocket<PortBridgeWsData>, code: number, reason: string): void {
  ws.data.wsClosed = true
  try { ws.close(code, reason) } catch {}
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
