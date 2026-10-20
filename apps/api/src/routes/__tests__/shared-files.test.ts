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
    expect(requestedUrl).toBe('http://runtime/agent/workspace/download/project-1/reports/final%20report.pdf')
    expect(requestedToken).toBe('runtime-secret')
  })

  // SHO-94: the mint signs a project-relative path (SHO-67), while an unscoped
  // runtime read walks the merged workspace root — where the project is mounted
  // at `<projectId>/…`. Reading the link exactly as signed was a guaranteed 404
  // for every file inside a project.
  it('reads a project-relative path from its project mount, then its project root', async () => {
    const requested: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      requested.push(url)
      return url.endsWith('/agent/workspace/download/report.pdf?scope=project')
        ? new Response('PDF bytes', { status: 200, headers: { 'content-type': 'application/pdf' } })
        : new Response('{"error":"File not found"}', { status: 404 })
    }) as typeof fetch

    const response = await retryingApp([]).fetch(new Request(`http://api.test/api/f/${token('report.pdf')}`))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('PDF bytes')
    expect(requested).toEqual([
      'http://runtime/agent/workspace/download/project-1/report.pdf',
      'http://runtime/agent/workspace/download/report.pdf?scope=project',
    ])
  })

  it('tries the merged root last, for a runtime whose workspace is the project', async () => {
    const requested: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      requested.push(url)
      return url.endsWith('/agent/workspace/download/report.pdf')
        ? new Response('PDF bytes', { status: 200, headers: { 'content-type': 'application/pdf' } })
        : new Response('{"error":"File not found"}', { status: 404 })
    }) as typeof fetch

    const response = await retryingApp([]).fetch(new Request(`http://api.test/api/f/${token('report.pdf')}`))

    expect(response.status).toBe(200)
    expect(requested.at(-1)).toBe('http://runtime/agent/workspace/download/report.pdf')
  })

  it('names the root that had no file, so a 404 explains itself', async () => {
    globalThis.fetch = (async () => new Response('{"error":"File not found"}', { status: 404 })) as typeof fetch
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      const response = await retryingApp([]).fetch(new Request(`http://api.test/api/f/${token('report.pdf')}`))

      expect(response.status).toBe(404)
      expect((await response.json()).error.code).toBe('file_not_found')
      expect(warnings).toHaveLength(3)
      expect(warnings[0]).toContain('project project-1')
      expect(warnings[0]).toContain('at project-1/report.pdf')
      expect(warnings[0]).toContain('http://runtime answered 404')
      expect(warnings[1]).toContain('at report.pdf (scope=project)')
    } finally {
      console.warn = originalWarn
    }
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
    let relayedCleanPath = ''
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
        relayedCleanPath = options.cleanPath
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
    expect(relayedPath).toBe('/agent/workspace/download/project-1/build/archive.zip')
    expect(relayedCleanPath).toBe('/agent/workspace/download/project-1/build/archive.zip')
  })

  it('keeps a scope on the relayed path but not on the streaming-detection path', async () => {
    const relayed: Array<{ agentPath: string; cleanPath: string }> = []
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
        relayed.push({ agentPath: options.agentPath, cleanPath: options.cleanPath })
        return new Response('missing', { status: 404 })
      },
    })

    const response = await app.fetch(new Request(`http://api.test/f/${token('build/archive.zip')}`))

    expect(response.status).toBe(404)
    expect(relayed.map((r) => r.agentPath)).toEqual([
      '/agent/workspace/download/project-1/build/archive.zip',
      '/agent/workspace/download/build/archive.zip?scope=project',
      '/agent/workspace/download/build/archive.zip',
    ])
    expect(relayed[1].cleanPath).toBe('/agent/workspace/download/build/archive.zip')
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

  function retryingApp(invalidated: string[]) {
    return sharedFileRoutes({
      pinChatToHomeRegion: async () => null,
      resolveAgentProxyPodUrl: async () => ({ ok: true, kind: 'pod', url: 'http://runtime' }),
      deriveProjectRuntimeToken: async () => 'runtime-secret',
      invalidateRuntimeUrl: async (projectId) => { invalidated.push(projectId) },
      sleep: async () => {},
    })
  }

  it('re-resolves and retries when the runtime is not yet bound to the workspace', async () => {
    const statuses = [401, 503, 200]
    let calls = 0
    globalThis.fetch = (async () => {
      const status = statuses[calls++]
      return status === 200
        ? new Response('PDF bytes', { status, headers: { 'content-type': 'application/pdf' } })
        : new Response('{"error":"Unauthorized — missing or invalid runtime token"}', { status })
    }) as typeof fetch
    const invalidated: string[] = []

    const response = await retryingApp(invalidated).fetch(new Request(`http://api.test/api/f/${token()}`))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('PDF bytes')
    expect(calls).toBe(3)
    expect(invalidated).toEqual(['project-1', 'project-1'])
  })

  it('returns a retryable 503, not "File not found", when the runtime stays unavailable', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('unavailable', { status: 503 })
    }) as typeof fetch

    const response = await retryingApp([]).fetch(new Request(`http://api.test/api/f/${token()}`))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect((await response.json()).error.code).toBe('runtime_unavailable')
    expect(calls).toBe(4)
  })

  it('does not retry a permanent runtime refusal', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{"error":"Path is a directory"}', { status: 400 })
    }) as typeof fetch

    const response = await retryingApp([]).fetch(new Request(`http://api.test/api/f/${token()}`))

    expect(response.status).toBe(404)
    // One read per root a project link can mean — no retries of a refusal.
    expect(calls).toBe(3)
  })

  it('serves a workspace-scoped link from the workspace runtime', async () => {
    let requestedUrl = ''
    let requestedToken = ''
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input)
      requestedToken = new Headers(init?.headers).get('x-runtime-token') || ''
      return new Response('xlsx bytes', { status: 200, headers: { 'content-type': 'application/vnd.ms-excel' } })
    }) as typeof fetch
    const pinnedWorkspaces: string[] = []
    const resolvedWorkspaces: string[] = []

    const app = sharedFileRoutes({
      pinChatToHomeRegion: async () => { throw new Error('a workspace link has no project to pin') },
      pinWorkspaceToHomeRegion: async (_c, workspaceId) => { pinnedWorkspaces.push(workspaceId); return null },
      resolveAgentProxyPodUrl: async () => { throw new Error('a workspace link has no project runtime') },
      resolveWorkspaceRuntimeUrl: async (workspaceId) => { resolvedWorkspaces.push(workspaceId); return 'http://ws-runtime' },
      deriveWorkspaceRuntimeToken: (workspaceId) => `wrt-${workspaceId}`,
    })
    const workspaceToken = signSharedFileToken({
      workspaceId: 'workspace-1',
      path: 'exports/summary.xlsx',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const response = await app.fetch(new Request(`http://api.test/api/f/${workspaceToken}`))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('xlsx bytes')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="summary.xlsx"')
    expect(requestedUrl).toBe('http://ws-runtime/agent/workspace/download/exports/summary.xlsx')
    expect(requestedToken).toBe('wrt-workspace-1')
    expect(pinnedWorkspaces).toEqual(['workspace-1'])
    expect(resolvedWorkspaces).toEqual(['workspace-1'])
  })

  it('retries a connection error to a runtime that is seconds from ready', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      if (calls++ === 0) throw new Error('ECONNREFUSED')
      return new Response('PDF bytes', { status: 200, headers: { 'content-type': 'application/pdf' } })
    }) as typeof fetch

    const response = await retryingApp([]).fetch(new Request(`http://api.test/api/f/${token()}`))

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })

  // A link minted from a workspace runtime carries a workspace-relative path,
  // so a project-scoped download can arrive as `<projectId>/reports/…` (SHO-67).
  it('strips a redundant project prefix when the runtime cannot serve it', async () => {
    const requested: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      requested.push(url)
      return url.endsWith('/agent/workspace/download/reports/final%20report.pdf')
        ? new Response('PDF bytes', { status: 200, headers: { 'content-type': 'application/pdf' } })
        : new Response('{"error":"File not found"}', { status: 404 })
    }) as typeof fetch

    const app = sharedFileRoutes({
      pinChatToHomeRegion: async () => null,
      resolveAgentProxyPodUrl: async () => ({ ok: true, kind: 'pod', url: 'http://runtime' }),
      deriveProjectRuntimeToken: async () => 'runtime-secret',
      sleep: async () => {},
    })
    const response = await app.fetch(
      new Request(`http://api.test/api/f/${token('project-1/reports/final report.pdf')}`),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('PDF bytes')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="final report.pdf"')
    expect(requested).toEqual([
      'http://runtime/agent/workspace/download/project-1/reports/final%20report.pdf',
      'http://runtime/agent/workspace/download/reports/final%20report.pdf',
    ])
  })

  it('keeps the 404 when the stripped path is missing too', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{"error":"File not found"}', { status: 404 })
    }) as typeof fetch

    const response = await retryingApp([]).fetch(
      new Request(`http://api.test/api/f/${token('project-1/reports/missing.pdf')}`),
    )

    expect(response.status).toBe(404)
    // The path as signed, the prefix-stripped read, and the same read from the
    // runtime's own project root.
    expect(calls).toBe(3)
  })
})
