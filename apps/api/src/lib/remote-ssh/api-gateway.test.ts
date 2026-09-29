// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { isRemoteApiPathAllowed, startRemoteApiGateway, type RemoteApiGateway } from './api-gateway'

interface Seen {
  url: string
  headers: IncomingHttpHeaders
}

let upstream: Server
let gateway: RemoteApiGateway
const seen: Seen[] = []

function send(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    // node:http sends `path` verbatim, unlike fetch, which normalizes it.
    const req = request({ host: '127.0.0.1', port: gateway.port, path, headers }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    res.setHeader('set-cookie', 'session=abc')
    res.setHeader('x-upstream', 'yes')
    res.end('upstream-ok')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  gateway = await startRemoteApiGateway({
    targetPort: typeof address === 'object' && address ? address.port : 0,
  })
})

afterAll(async () => {
  await gateway.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

describe('remote API gateway', () => {
  test('allows only runtime-facing API paths', () => {
    expect(isRemoteApiPathAllowed('/api/ai/v1/chat/completions')).toBe(true)
    expect(isRemoteApiPathAllowed('/api/tools/search')).toBe(true)
    expect(isRemoteApiPathAllowed('/api/projects/p1/git/push')).toBe(true)
    expect(isRemoteApiPathAllowed('/api/projects/p1/agent-proxy')).toBe(true)
    expect(isRemoteApiPathAllowed('/api/auth/local-sign-in')).toBe(false)
    expect(isRemoteApiPathAllowed('/api/projects/p1')).toBe(false)
    expect(isRemoteApiPathAllowed('/api/projects/p1/files')).toBe(false)
    expect(isRemoteApiPathAllowed('/api/workspaces')).toBe(false)
  })

  test('forwards allowed requests and strips ambient credentials both ways', async () => {
    const response = await send('/api/ai/v1/models?x=1', {
      authorization: 'Bearer runtime-token',
      cookie: 'better-auth.session_token=stolen',
      'x-tunnel-auth-user-id': 'user-1',
      'x-forwarded-for': '10.0.0.1',
    })

    expect(response.status).toBe(200)
    expect(response.body).toBe('upstream-ok')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['x-upstream']).toBe('yes')

    const request = seen[seen.length - 1]
    expect(request.url).toBe('/api/ai/v1/models?x=1')
    expect(request.headers.authorization).toBe('Bearer runtime-token')
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers['x-tunnel-auth-user-id']).toBeUndefined()
    expect(request.headers['x-forwarded-for']).toBeUndefined()
  })

  test('rejects disallowed paths without contacting the API', async () => {
    const before = seen.length
    const response = await send('/api/auth/get-session')

    expect(response.status).toBe(403)
    expect(seen.length).toBe(before)
  })

  test('normalizes dot segments before applying the allowlist', async () => {
    const before = seen.length
    for (const path of ['/api/ai/../auth/get-session', '/api/ai/%2e%2e/auth/get-session']) {
      expect((await send(path)).status).toBe(403)
    }
    expect(seen.length).toBe(before)

    const allowed = await send('/api/auth/../ai/v1/models')
    expect(allowed.status).toBe(200)
    expect(seen[seen.length - 1].url).toBe('/api/ai/v1/models')
  })
})
