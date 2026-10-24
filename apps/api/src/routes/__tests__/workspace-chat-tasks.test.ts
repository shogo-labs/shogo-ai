// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET /api/workspaces/:workspaceId/chat/:sessionId/tasks
 *
 * Added for SHO-31: an open chat window polls its task list to learn that
 * background work is in flight and, once the list is empty, that a
 * `[Task update]` wake is about to be queued. A workspace chat had no such
 * route at all — `fetchRunningProcesses` could only build the per-project
 * agent-proxy URL — so the workspace half of the panel could never notice a
 * wake without a reload.
 *
 *   bun test apps/api/src/routes/__tests__/workspace-chat-tasks.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  userId: 'user-1' as string | null,
  hasAccess: true,
  kind: 'personal' as 'personal' | 'team',
  resolvedUrl: null as null | { url: string; mode: string },
  fetchImpl: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
  calls: [] as string[],
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
    resolveWorkspaceRuntimeUrl: async (_workspaceId: string, _opts: any) => store.resolvedUrl,
  }
})

mock.module('../../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: (_workspaceId: string) => 'mock-workspace-runtime-token',
}))

mock.module('../../lib/project-user-context', () => ({
  setProjectUser: (_projectId: string, _userId: string) => {},
  getProjectUser: (_projectId: string) => 'test-user',
  getProjectOwnerUserId: async (_projectId: string) => 'test-user',
  getWorkspaceOwnerUserId: async (_workspaceId: string) => 'test-user',
}))

mock.module('../../lib/workspace-runtime-args', () => ({
  readWorkspaceSessionRuntimeArgs: async (_workspaceId: string, _sessionId: string) => ({
    attachedProjectIds: [],
    extra: {},
  }),
}))

class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

mock.module('../../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  assertWorkspaceSessionInWorkspace: async () => {},
  assertWorkspaceSessionAccess: async () => {
    if (!store.hasAccess) throw new MockWorkspaceSessionError('workspace_access_denied')
  },
  detachProject: async () => true,
  getAttachedProjects: async () => [],
  createWorkspaceSession: async () => ({ id: 'sess-1' }),
  listWorkspaceSessions: async () => [],
  getOrCreateDefaultWorkspaceSession: async () => ({ id: 'sess-1' }),
  pinWorkspaceSessionToProject: async () => ({ pinned: false, changed: false }),
  unpinWorkspaceSession: async () => {},
  upgradeProjectSessionToWorkspace: async () => null,
  syncPinnedSessionAttachments: async () => {},
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

const originalFetch = globalThis.fetch

const { workspaceChatRoutes } = await import('../workspace-chat')
const { Hono } = await import('hono')

function buildApp() {
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

const TASKS_URL = 'http://x/api/workspaces/ws-1/chat/sess-1/tasks'

describe('GET /api/workspaces/:workspaceId/chat/:sessionId/tasks', () => {
  beforeEach(() => {
    store.userId = 'user-1'
    store.hasAccess = true
    store.kind = 'personal'
    store.resolvedUrl = { url: 'http://pod.internal:8080', mode: 'pod' }
    store.fetchImpl = null
    store.calls = []
    globalThis.fetch = ((url: any, init?: any) => {
      store.calls.push(String(url))
      if (store.fetchImpl) return store.fetchImpl(String(url), init)
      return originalFetch(url, init)
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('401s without auth', async () => {
    store.userId = null
    const res = await buildApp().fetch(new Request(TASKS_URL))
    expect(res.status).toBe(401)
  })

  test('proxies the runtime task list through unchanged', async () => {
    const tasks = [{ id: 'task-1', runId: 'task-1', notify: true, status: 'running' }]
    store.fetchImpl = async () => Response.json({ tasks })
    const res = await buildApp().fetch(new Request(TASKS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tasks })
    expect(store.calls.some((url) => url === 'http://pod.internal:8080/agent/chat/sess-1/tasks')).toBe(true)
  })

  test('falls back to the process list on a runtime that predates tasks', async () => {
    store.fetchImpl = async (url) =>
      url.endsWith('/tasks')
        ? new Response('not found', { status: 404 })
        : Response.json({ processes: [{ runId: 'proc-1', command: 'sleep 5' }] })
    const res = await buildApp().fetch(new Request(TASKS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tasks: [{ runId: 'proc-1', command: 'sleep 5' }] })
  })

  test('answers with an empty list when the runtime has no task endpoints at all', async () => {
    store.fetchImpl = async () => new Response('not found', { status: 404 })
    const res = await buildApp().fetch(new Request(TASKS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tasks: [] })
  })

  test('reports an unreadable list instead of pretending nothing is running', async () => {
    store.fetchImpl = async () => {
      throw new Error('pod unreachable')
    }
    const res = await buildApp().fetch(new Request(TASKS_URL))
    // The client holds its wait on a failed read; `{tasks: []}` would look like
    // "the task finished" and arm a wake probe that cannot see anything.
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'task list unavailable' })
  })

  test('passes a runtime error through as unreadable', async () => {
    store.fetchImpl = async () => new Response('boom', { status: 500 })
    const res = await buildApp().fetch(new Request(TASKS_URL))
    expect(res.status).toBe(502)
  })
})
