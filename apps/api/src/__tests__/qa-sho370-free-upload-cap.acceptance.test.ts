// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance — SHO-370, the chat upload cap is a plan entitlement.
 *
 * The card's own tests cover the two cap constants, the 413 body builder and
 * the runtime's lower-only header. What they do not cover is the API proxy hop
 * that actually gates the bytes, so this file mounts the real
 * `/api/workspaces/:workspaceId/agent-proxy/*` route with a fake pod and a
 * controllable `hasPaidSubscription`, and asserts the card's acceptance
 * criteria end to end on that hop:
 *
 *   AC1 — a Free workspace's 100 MB + 1 byte upload (a `.zip` too) is refused
 *         with 413 `attachment_too_large`, `plan: 'free'`, `upgrade: true`,
 *         `limitBytes: 100 MB`, before the pod is ever called.
 *   AC2 — a Free chunked body with no `content-length` is still forwarded with
 *         `x-attachment-max-bytes: 100 MB`, which is how the runtime cuts it on
 *         the real byte count.
 *   AC3 — a paid (Basic / grant) workspace forwards a 300 MB file and refuses
 *         500 MB + 1 with `plan: 'paid'`, `upgrade: false`.
 *   AC4 — Free at exactly 100 MB still forwards (no regression of SHO-292).
 *   AC5 — desktop/local resolves to paid (`hasPaidSubscription` is true there),
 *         so the same 300 MB upload forwards with the 500 MB cap.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const MB = 1024 * 1024

const store = {
  userId: 'user-1' as string | null,
  hasAccess: true,
  kind: 'personal' as 'personal' | 'team',
  resolvedUrl: { url: 'http://pod.internal:8080', mode: 'pod' } as null | { url: string; mode: string },
  paid: false,
  /** Every call the proxy made to the fake pod. */
  podCalls: [] as Array<{ url: string; init: any }>,
  podStatus: 200,
  podBody: '{"savedPath":"files/x.bin"}' as string,
}

mock.module('../services/workspace.service', () => ({
  getWorkspaceKind: async (_workspaceId: string) => store.kind,
  loadWorkspaceContext: async (_workspaceId: string, _userId: string) => ({
    hasAccess: store.hasAccess,
    kind: store.kind,
  }),
  normalizeWorkspaceKind: (k?: string) => (k === 'team' ? 'team' : 'personal'),
}))

mock.module('../lib/resolve-workspace-runtime-url', () => {
  class WorkspaceRuntimeNotEnabledError extends Error {}
  return {
    WorkspaceRuntimeNotEnabledError,
    resolveWorkspaceRuntimeUrl: async (_workspaceId: string, _opts: any) => store.resolvedUrl,
  }
})

mock.module('../lib/workspace-runtime-token', () => ({
  deriveWorkspaceRuntimeToken: (_workspaceId: string) => 'mock-workspace-runtime-token',
}))

mock.module('../lib/project-user-context', () => ({
  setProjectUser: (_projectId: string, _userId: string) => {},
  getProjectUser: (_projectId: string) => 'test-user',
  getProjectOwnerUserId: async (_projectId: string) => 'test-user',
  getWorkspaceOwnerUserId: async (_workspaceId: string) => 'test-user',
}))

class MockWorkspaceSessionError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

mock.module('../services/workspace-session.service', () => ({
  attachProject: async () => ({ attachMode: 'readwrite' }),
  assertWorkspaceSessionInWorkspace: async () => {},
  assertWorkspaceSessionAccess: async () => {},
  detachProject: async () => true,
  getAttachedProjects: async () => [],
  createWorkspaceSession: async () => ({ id: 'sess-1' }),
  listWorkspaceSessions: async () => [],
  getOrCreateDefaultWorkspaceSession: async () => ({ id: 'sess-1' }),
  pinWorkspaceSessionToProject: async () => ({ pinned: false, changed: false }),
  unpinWorkspaceSession: async () => {},
  upgradeProjectSessionToWorkspace: async () => null,
  WorkspaceSessionError: MockWorkspaceSessionError,
}))

// The cap is resolved through the billing seam. Keep every real export (the
// route imports the whole module) and swap only the paid/free answer.
const realBillingRuntime = await import('../services/billing-runtime')
mock.module('../services/billing-runtime', () => ({
  ...realBillingRuntime,
  hasPaidSubscription: async (_workspaceId: string) => store.paid,
}))

const originalFetch = globalThis.fetch

const { workspaceChatRoutes } = await import('../routes/workspace-chat')

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

/** A PUT to the attachment route with a declared size but a tiny real body. */
function upload(declaredBytes: number | null, name = 'big.bin') {
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
  if (declaredBytes !== null) headers['content-length'] = String(declaredBytes)
  return new Request(
    `http://x/api/workspaces/ws-1/agent-proxy/agent/chat/attachments?name=${encodeURIComponent(name)}`,
    { method: 'PUT', body: 'abc', headers },
  )
}

describe('SHO-370 — the API proxy gates chat attachments by plan', () => {
  beforeEach(() => {
    store.userId = 'user-1'
    store.hasAccess = true
    store.kind = 'personal'
    store.resolvedUrl = { url: 'http://pod.internal:8080', mode: 'pod' }
    store.paid = false
    store.podCalls = []
    store.podStatus = 200
    store.podBody = '{"savedPath":"files/x.bin"}'
    globalThis.fetch = (async (url: any, init?: any) => {
      store.podCalls.push({ url: String(url), init })
      return new Response(store.podBody, {
        status: store.podStatus,
        headers: { 'content-type': 'application/json' },
      })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('AC1 — Free refuses 100 MB + 1 before the pod is called', async () => {
    const res = await buildApp().fetch(upload(100 * MB + 1))

    expect(res.status).toBe(413)
    const body = (await res.json()) as any
    expect(body.error.code).toBe('attachment_too_large')
    expect(body.error.plan).toBe('free')
    expect(body.error.limitBytes).toBe(100 * MB)
    expect(body.error.upgrade).toBe(true)
    expect(body.error.message).toContain('Free workspaces')
    expect(body.error.message).toContain('Upgrade')
    // The whole point: no byte reached the runtime.
    expect(store.podCalls).toHaveLength(0)
  })

  test('AC1 — Free refuses an over-cap .zip too (archives are not exempt)', async () => {
    const res = await buildApp().fetch(upload(100 * MB + 1, 'project.zip'))

    expect(res.status).toBe(413)
    expect(((await res.json()) as any).error.plan).toBe('free')
    expect(store.podCalls).toHaveLength(0)
  })

  test('AC2 — Free forwards a chunked body with the 100 MB cap header', async () => {
    const res = await buildApp().fetch(upload(null))

    expect(res.status).toBe(200)
    expect(store.podCalls).toHaveLength(1)
    const forwarded = store.podCalls[0].init.headers as Headers
    expect(forwarded.get('x-attachment-max-bytes')).toBe(String(100 * MB))
  })

  test('AC3 — a paid workspace forwards 300 MB with the 500 MB cap header', async () => {
    store.paid = true
    const res = await buildApp().fetch(upload(300 * MB))

    expect(res.status).toBe(200)
    expect(store.podCalls).toHaveLength(1)
    const forwarded = store.podCalls[0].init.headers as Headers
    expect(forwarded.get('x-attachment-max-bytes')).toBe(String(500 * MB))
    expect(forwarded.get('content-length')).toBe(String(300 * MB))
  })

  test('AC3 — a paid workspace refuses 500 MB + 1 with no upgrade prompt', async () => {
    store.paid = true
    const res = await buildApp().fetch(upload(500 * MB + 1))

    expect(res.status).toBe(413)
    const body = (await res.json()) as any
    expect(body.error.plan).toBe('paid')
    expect(body.error.limitBytes).toBe(500 * MB)
    expect(body.error.upgrade).toBe(false)
    expect(store.podCalls).toHaveLength(0)
  })

  test('AC4 — Free at exactly 100 MB still uploads', async () => {
    const res = await buildApp().fetch(upload(100 * MB))

    expect(res.status).toBe(200)
    expect(store.podCalls).toHaveLength(1)
    expect((store.podCalls[0].init.headers as Headers).get('x-attachment-max-bytes')).toBe(
      String(100 * MB),
    )
  })

  test('AC5 — desktop/local (paid) forwards 300 MB with no plan lookup failing it', async () => {
    store.paid = true
    const res = await buildApp().fetch(upload(300 * MB, 'project.zip'))

    expect(res.status).toBe(200)
    expect(store.podCalls).toHaveLength(1)
  })
})
