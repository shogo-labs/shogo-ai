// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project-pinned workspace sessions created/attached from the home composer.
 *
 * The project page serves its canvas from `ws:proj:<projectId>`, so a
 * workspace chat handed off to that page must be pinned (`contextId`) to the
 * project or chat and preview end up on different runtimes.
 *
 *   bun test ./apps/api/src/routes/__tests__/workspace-chat-pin.test.ts
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'

const store = {
  contextId: null as string | null,
  attached: [] as Array<{ id: string; projectId: string; attachMode: 'readwrite' | 'readonly' }>,
  pinResult: { pinned: false, changed: false },
  resolveThrow: null as Error | null,
  resolveCalls: [] as any[],
  createCalls: [] as any[],
  pinCalls: [] as Array<[string, string]>,
  unpinCalls: [] as Array<[string, string]>,
  detachCalls: [] as Array<[string, string]>,
  stopCalls: [] as string[],
  stopWorkspaceCalls: [] as string[],
}

mock.module('../../services/workspace.service', () => ({
  getWorkspaceKind: async () => 'team',
  loadWorkspaceContext: async () => ({ hasAccess: true, kind: 'team' }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

mock.module('../../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async (workspaceId: string, opts: any) => {
      store.resolveCalls.push({ workspaceId, ...opts, runtimeManager: undefined })
      if (store.resolveThrow) throw store.resolveThrow
      return { url: 'http://pod.internal:8080', mode: 'pod' }
    },
  }
})

mock.module('../../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: () => 'token',
}))

mock.module('../../lib/project-user-context', () => ({
  setProjectUser: () => {},
  getProjectUser: () => 'test-user',
  getProjectOwnerUserId: async () => 'test-user',
  getWorkspaceOwnerUserId: async () => 'test-user',
}))

mock.module('../../lib/prisma', () => ({
  Prisma: {},
  InstanceKind: { desktop: 'desktop', cli_worker: 'cli_worker' },
  prisma: {
    chatSession: { findUnique: async () => ({ contextId: store.contextId }) },
    projectFolder: { findMany: async () => [] },
  },
}))

class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

mock.module('../../services/workspace-session.service', () => ({
  attachProject: async (_sessionId: string, projectId: string, attachMode: 'readwrite' | 'readonly') => {
    const row = { id: `csp-${projectId}`, projectId, attachMode }
    store.attached = [...store.attached.filter((a) => a.projectId !== projectId), row]
    return row
  },
  assertWorkspaceSessionInWorkspace: async () => {},
  detachProject: async (sessionId: string, projectId: string) => {
    store.detachCalls.push([sessionId, projectId])
    store.attached = store.attached.filter((a) => a.projectId !== projectId)
    return true
  },
  getAttachedProjects: async () => store.attached,
  createWorkspaceSession: async (workspaceId: string, opts: any) => {
    store.createCalls.push({ workspaceId, ...opts })
    return { id: 'sess-new', workspaceId, contextId: opts.anchorProjectId ?? null, attached: [] }
  },
  listWorkspaceSessions: async () => [],
  getOrCreatePrimaryWorkspaceSession: async () => ({ id: 'sess-primary' }),
  pinWorkspaceSessionToProject: async (sessionId: string, projectId: string) => {
    store.pinCalls.push([sessionId, projectId])
    if (store.pinResult.changed) store.contextId = projectId
    return store.pinResult
  },
  unpinWorkspaceSession: async (sessionId: string, projectId: string) => {
    store.unpinCalls.push([sessionId, projectId])
    store.contextId = null
  },
  upgradeProjectSessionToWorkspace: async () => null,
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

const { workspaceChatRoutes } = await import('../workspace-chat')

function buildApp() {
  const { Hono } = require('hono')
  const app = new Hono()
  app.route(
    '/api',
    workspaceChatRoutes({
      resolveUserId: async () => 'user-1',
      runtimeManager: {
        stop: async (key: string) => {
          store.stopCalls.push(key)
        },
        stopWorkspace: async (workspaceId: string) => {
          store.stopWorkspaceCalls.push(workspaceId)
        },
      } as any,
    }),
  )
  return app
}

function post(path: string, body: unknown) {
  return buildApp().fetch(
    new Request(`http://x/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  store.contextId = null
  store.attached = []
  store.pinResult = { pinned: false, changed: false }
  store.resolveThrow = null
  store.resolveCalls = []
  store.createCalls = []
  store.pinCalls = []
  store.unpinCalls = []
  store.detachCalls = []
  store.stopCalls = []
  store.stopWorkspaceCalls = []
})

describe('POST /api/workspaces/:workspaceId/sessions', () => {
  test('forwards anchorProjectId so the session is created project-pinned', async () => {
    const res = await post('/workspaces/ws-1/sessions', {
      inferredName: 'Untitled',
      attachProjectIds: ['p1'],
      attachMode: 'readwrite',
      anchorProjectId: 'p1',
    })
    expect(res.status).toBe(201)
    expect(store.createCalls[0]).toMatchObject({ workspaceId: 'ws-1', anchorProjectId: 'p1' })
  })

  test('ignores a non-string anchorProjectId', async () => {
    await post('/workspaces/ws-1/sessions', { anchorProjectId: 42 })
    expect(store.createCalls[0].anchorProjectId).toBeUndefined()
  })
})

describe('POST /api/workspaces/:workspaceId/sessions/:sessionId/projects', () => {
  test('without pinAsAnchor keeps the old behavior: no pin, workspace runtime restarted', async () => {
    const res = await post('/workspaces/ws-1/sessions/sess-1/projects', { projectId: 'p1' })
    expect(res.status).toBe(201)
    expect((await res.json()).pinned).toBe(false)
    expect(store.pinCalls).toHaveLength(0)
    expect(store.stopWorkspaceCalls).toEqual(['ws-1'])
    expect(store.resolveCalls[0].anchorProjectId).toBeUndefined()
  })

  test('a fresh pin resolves ws:proj:<project> without restarting it or the shared workspace runtime', async () => {
    store.pinResult = { pinned: true, changed: true }
    const res = await post('/workspaces/ws-1/sessions/sess-1/projects', { projectId: 'p1', pinAsAnchor: true })
    expect(res.status).toBe(201)
    expect((await res.json()).pinned).toBe(true)
    expect(store.pinCalls).toEqual([['sess-1', 'p1']])
    expect(store.stopCalls).toEqual([])
    expect(store.stopWorkspaceCalls).toEqual([])
    expect(store.resolveCalls[0]).toMatchObject({ anchorProjectId: 'p1', attachedProjectIds: ['p1'] })
  })

  test('reports pinned=false when the session cannot be pinned', async () => {
    const res = await post('/workspaces/ws-1/sessions/sess-1/projects', { projectId: 'p1', pinAsAnchor: true })
    expect((await res.json()).pinned).toBe(false)
    expect(store.resolveCalls[0].anchorProjectId).toBeUndefined()
  })

  test('rolls back the pin and the attachment when the runtime cannot be resolved', async () => {
    store.pinResult = { pinned: true, changed: true }
    store.resolveThrow = new Error('boom')
    const res = await post('/workspaces/ws-1/sessions/sess-1/projects', { projectId: 'p1', pinAsAnchor: true })
    expect(res.status).toBe(500)
    expect(store.unpinCalls).toEqual([['sess-1', 'p1']])
    expect(store.detachCalls).toEqual([['sess-1', 'p1']])
    expect(store.contextId).toBeNull()
  })

  test('does not unpin a session that was already pinned before the attach', async () => {
    store.contextId = 'p1'
    store.pinResult = { pinned: true, changed: false }
    store.resolveThrow = new Error('boom')
    await post('/workspaces/ws-1/sessions/sess-1/projects', { projectId: 'p1', pinAsAnchor: true })
    expect(store.unpinCalls).toEqual([])
    expect(store.contextId).toBe('p1')
  })
})
