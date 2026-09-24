// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `/api/workspaces/:workspaceId/agent-proxy/*`.
 *
 * Added alongside a staging bug fix: the free personal-companion chat (a
 * project-less workspace runtime) had no server route to fetch a generated
 * image's bytes back from the pod — `GenerateImageWidget` (apps/mobile)
 * built its download URL from `/api/projects/:projectId/agent-proxy`, which
 * requires a projectId that doesn't exist for a personal companion. A
 * successfully generated avatar image showed only the "Image generated"
 * placeholder text, never the actual picture. This route mirrors
 * `/api/projects/:projectId/agent-proxy/*` in server.ts, resolving the pod
 * by workspaceId directly instead of via a Project row.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

const store = {
  userId: 'user-1' as string | null,
  hasAccess: true,
  kind: 'personal' as 'personal' | 'team',
  resolvedUrl: null as null | { url: string; mode: string },
  resolveThrow: null as null | Error,
  fetchImpl: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
  sessionWorkspaceMatches: true,
}

mock.module('../../services/workspace.service', () => ({
  getWorkspaceKind: async (_workspaceId: string) => store.kind,
  loadWorkspaceContext: async (_workspaceId: string, _userId: string) => ({
    hasAccess: store.hasAccess,
    kind: store.kind,
  }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

mock.module('../../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async (_workspaceId: string, _opts: any) => {
      if (store.resolveThrow) throw store.resolveThrow
      return store.resolvedUrl
    },
  }
})

mock.module('../../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: (_workspaceId: string) => 'mock-workspace-runtime-token',
}))

// Defensive re-mock with the full export set `workspace-chat.ts` actually
// needs (`setProjectUser` + `getProjectUser`) — other suites in this same
// bun test process (e.g. ai-proxy-db-custom-provider.test.ts) mock this
// module with only `getProjectUser`, and bun's `mock.module` is process-wide
// / import-order-dependent, so an incomplete mock registered elsewhere can
// otherwise break this file's `await import('../workspace-chat')` below.
mock.module('../../lib/project-user-context', () => ({
  setProjectUser: (_projectId: string, _userId: string) => {},
  getProjectUser: (_projectId: string) => 'test-user',
  getProjectOwnerUserId: async (_projectId: string) => 'test-user',
  getWorkspaceOwnerUserId: async (_workspaceId: string) => 'test-user',
}))

// Not exercised by this route, but required by workspace-chat.ts's module
// scope (other routes in the same file import these).
class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

mock.module('../../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  assertWorkspaceSessionInWorkspace: async () => {
    if (!store.sessionWorkspaceMatches) {
      throw new MockWorkspaceSessionError('session_not_in_workspace')
    }
  },
  detachProject: async () => true,
  getAttachedProjects: async () => [],
  createWorkspaceSession: async () => ({ id: 'sess-1' }),
  listWorkspaceSessions: async () => [],
  getOrCreatePrimaryWorkspaceSession: async () => ({ id: 'sess-1' }),
  pinWorkspaceSessionToProject: async () => ({ pinned: false, changed: false }),
  unpinWorkspaceSession: async () => {},
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

const originalFetch = globalThis.fetch

const { workspaceChatRoutes } = await import('../workspace-chat')

function buildApp() {
  const { Hono } = require('hono')
  const app = new Hono()
  app.route(
    '/api',
    workspaceChatRoutes({
      resolveUserId: async () => store.userId,
      runtimeManager: {} as any,
    }),
  )
  return app
}

describe('GET/POST /api/workspaces/:workspaceId/agent-proxy/*', () => {
  beforeEach(() => {
    store.userId = 'user-1'
    store.hasAccess = true
    store.kind = 'personal'
    store.resolvedUrl = { url: 'http://pod.internal:8080', mode: 'pod' }
    store.resolveThrow = null
    store.fetchImpl = null
    store.sessionWorkspaceMatches = true
    globalThis.fetch = ((url: any, init?: any) => {
      if (store.fetchImpl) return store.fetchImpl(String(url), init)
      return originalFetch(url, init)
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('401s without auth', async () => {
    store.userId = null
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/agent-proxy/agent/workspace/download/images/a.png'),
    )
    expect(res.status).toBe(401)
  })

  test('creates or returns the primary workspace session for an authorized team member', async () => {
    store.kind = 'team'
    const app = buildApp()
    const first = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/sessions/primary', { method: 'POST' }),
    )
    const second = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/sessions/primary', { method: 'POST' }),
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await first.json() as any).session.id).toBe('sess-1')
    expect((await second.json() as any).session.id).toBe('sess-1')
  })

  test('does not expose a primary session outside the workspace', async () => {
    store.hasAccess = false
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/sessions/primary', { method: 'POST' }),
    )
    expect(res.status).toBe(403)
  })

  test('does not expose attachments from a session in another workspace', async () => {
    store.sessionWorkspaceMatches = false
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/sessions/foreign-session/projects'),
    )
    expect(res.status).toBe(404)
  })

  test('does not report a project scope mutation ready until the workspace runtime resolves', async () => {
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/sessions/sess-1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-1', attachMode: 'readonly' }),
      }),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      runtime: { ready: true },
    })
  })

  test('403s when the caller lacks workspace access', async () => {
    store.hasAccess = false
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/agent-proxy/agent/workspace/download/images/a.png'),
    )
    expect(res.status).toBe(403)
  })

  test('proxies a GET through to the resolved pod URL, preserving path/query and forwarding bytes', async () => {
    let capturedUrl = ''
    let capturedInit: any = null
    const pngBytes = new Uint8Array([1, 2, 3, 4])
    store.fetchImpl = async (url, init) => {
      capturedUrl = url
      capturedInit = init
      return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }

    const app = buildApp()
    const res = await app.fetch(
      new Request(
        'http://x/api/workspaces/ws-1/agent-proxy/agent/workspace/download/images/a.png?foo=bar',
      ),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(body)).toEqual(Array.from(pngBytes))

    expect(capturedUrl).toBe(
      'http://pod.internal:8080/agent/workspace/download/images/a.png?foo=bar',
    )
    expect(capturedInit.method).toBe('GET')
    expect(capturedInit.headers.get('x-runtime-token')).toBe('mock-workspace-runtime-token')
  })

  test('returns 502 when the pod fetch throws (runtime unreachable)', async () => {
    store.fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/agent-proxy/agent/workspace/download/images/a.png'),
    )
    expect(res.status).toBe(502)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('proxy_error')
  })

  test('returns 501 when workspace runtimes are not enabled', async () => {
    const { WorkspaceRuntimeNotEnabledError } = await import('../../lib/resolve-workspace-runtime-url')
    store.resolveThrow = new WorkspaceRuntimeNotEnabledError('not enabled')
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://x/api/workspaces/ws-1/agent-proxy/agent/workspace/download/images/a.png'),
    )
    expect(res.status).toBe(501)
  })
})
