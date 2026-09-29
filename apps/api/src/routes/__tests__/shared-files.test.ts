// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { signSharedFileToken } from '../../lib/shared-file-token'
import { sharedFileRoutes } from '../shared-files'

describe('shared file routes', () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'shared-file-route-test-secret'
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = originalSecret
  })

  function token(path = 'reports/final report.pdf', exp = Math.floor(Date.now() / 1000) + 3600) {
    return signSharedFileToken({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      path,
      exp,
    })
  }

  it('streams a runtime file as an attachment without a session', async () => {
    let requestedUrl = ''
    let requestedToken = ''
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input)
      requestedToken = new Headers(init?.headers).get('x-runtime-token') || ''
      return new Response('PDF bytes', {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': '9',
        },
      })
    }) as typeof fetch

    const app = sharedFileRoutes({
      pinChatToHomeRegion: async () => null,
      resolveAgentProxyPodUrl: async () => ({ ok: true, kind: 'pod', url: 'http://runtime' }),
      deriveProjectRuntimeToken: async () => 'runtime-secret',
    })
    const response = await app.fetch(new Request(`http://api.test/f/${token()}`))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('PDF bytes')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="final report.pdf"')
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(requestedUrl).toBe('http://runtime/agent/workspace/download/reports/final%20report.pdf')
    expect(requestedToken).toBe('runtime-secret')
  })

  it('serves the same download under /api/f/ so studio-origin links reach the API', async () => {
    globalThis.fetch = (async () => new Response('PDF bytes', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })) as typeof fetch

    const app = sharedFileRoutes({
      pinChatToHomeRegion: async () => null,
      resolveAgentProxyPodUrl: async () => ({ ok: true, kind: 'pod', url: 'http://runtime' }),
      deriveProjectRuntimeToken: async () => 'runtime-secret',
    })
    const response = await app.fetch(new Request(`http://studio.test/api/f/${token()}`))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('PDF bytes')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="final report.pdf"')
    expect((await app.fetch(new Request('http://studio.test/api/f/not-a-token'))).status).toBe(404)
  })

  it('uses octet-stream for risky file types', async () => {
    globalThis.fetch = (async () => new Response('binary', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch

    const app = sharedFileRoutes({
      pinChatToHomeRegion: async () => null,
      resolveAgentProxyPodUrl: async () => ({ ok: true, kind: 'pod', url: 'http://runtime' }),
      deriveProjectRuntimeToken: async () => 'runtime-secret',
    })
    const response = await app.fetch(new Request(`http://api.test/f/${token('build/app.exe')}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="app.exe"')
  })

  it('passes binary downloads through a paired-instance tunnel', async () => {
    let relayedPath = ''
    const app = sharedFileRoutes({
      pinChatToHomeRegion: async () => null,
      resolveAgentProxyPodUrl: async () => ({
        ok: true,
        kind: 'tunnel',
        instanceId: 'instance-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
      }),
      deriveProjectRuntimeToken: async () => 'runtime-secret',
      relayAgentProxyViaTunnel: async (options) => {
        relayedPath = options.agentPath
        return new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })
      },
    })
    const response = await app.fetch(new Request(`http://api.test/f/${token('build/archive.zip')}`))

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]))
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="archive.zip"')
    expect(relayedPath).toBe('/agent/workspace/download/build/archive.zip')
  })

  it('returns 404 for invalid, expired, or missing runtime files', async () => {
    const app = sharedFileRoutes({
      pinChatToHomeRegion: async () => null,
      resolveAgentProxyPodUrl: async () => ({ ok: true, kind: 'pod', url: 'http://runtime' }),
      deriveProjectRuntimeToken: async () => 'runtime-secret',
    })

    expect((await app.fetch(new Request('http://api.test/f/not-a-token'))).status).toBe(404)
    expect((await app.fetch(new Request(`http://api.test/f/${token('report.pdf', Math.floor(Date.now() / 1000) - 1)}`))).status).toBe(404)

    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch
    expect((await app.fetch(new Request(`http://api.test/f/${token()}`))).status).toBe(404)
  })
})
