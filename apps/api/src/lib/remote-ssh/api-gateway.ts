// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The only local endpoint a Remote-SSH runtime can reach.
 *
 * The SSH reverse forward makes this listener reachable from the remote
 * host's loopback interface, i.e. by every user and process on that host.
 * The desktop API treats loopback reachability as authentication (local
 * auto-sign-in, tunnel-forwarded identity headers, session cookies), so the
 * reverse forward must never target the API port directly.
 *
 * Every allowed route must authenticate the request itself with a runtime or
 * AI-proxy token. Ambient credentials are stripped in both directions.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http'

const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/api\/ai\//,
  /^\/api\/tools\//,
  /^\/api\/internal\//,
  /^\/api\/voice\//,
  /^\/api\/projects\/[^/]+\/(?:git|agent-proxy)(?:\/|$)/,
]

const STRIPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'host',
  'connection',
  'upgrade',
  'proxy-authorization',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding'])

export interface RemoteApiGateway {
  readonly port: number
  close(): Promise<void>
}

/** `pathname` must already be normalized (dot segments resolved). */
export function isRemoteApiPathAllowed(pathname: string): boolean {
  return ALLOWED_PATHS.some((pattern) => pattern.test(pathname))
}

function filterRequestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const filtered: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (STRIPPED_REQUEST_HEADERS.has(lower) || lower.startsWith('x-tunnel-')) continue
    filtered[lower] = value
  }
  return filtered
}

function filterResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const filtered: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue
    filtered[name] = value
  }
  return filtered
}

export async function startRemoteApiGateway(options: {
  targetPort: number
  targetHost?: string
}): Promise<RemoteApiGateway> {
  const targetHost = options.targetHost ?? '127.0.0.1'
  const server: Server = createServer((req, res) => {
    let url: URL
    try {
      // WHATWG parsing resolves `..`, `%2e%2e`, and backslashes, so the
      // allowlist sees exactly the path the API router will route.
      url = new URL(req.url ?? '/', 'http://remote-gateway.invalid')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"invalid_request_path"}')
      return
    }
    if (!isRemoteApiPathAllowed(url.pathname)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"error":"remote_api_path_forbidden"}')
      req.resume()
      return
    }

    const upstream = httpRequest(
      {
        host: targetHost,
        port: options.targetPort,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...filterRequestHeaders(req.headers), host: `${targetHost}:${options.targetPort}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, filterResponseHeaders(upstreamRes.headers))
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(res.headersSent ? undefined : '{"error":"api_unavailable"}')
    })
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  })
  server.on('upgrade', (_req, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    server.close()
    throw new Error('Remote API gateway did not bind a port')
  }

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
