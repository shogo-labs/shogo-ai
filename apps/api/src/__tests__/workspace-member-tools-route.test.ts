// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal route behind remote workspace members: the workspace agent's file
 * tools and `exec` with a `projectId` run in the mounted project's own
 * runtime. Only the workspace agent's own sessions may call it, only for a
 * project that session has mounted, and a read-only mount only reads.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

type Attached = { projectId: string; attachMode: string }
let attached: Attached[] = []
let session: Record<string, unknown> | null = null

const realSessions = await import('../services/workspace-session.service')
mock.module('../services/workspace-session.service', () => ({
  ...realSessions,
  getAttachedProjects: async () => attached,
}))
mock.module('../lib/resolve-pod-url', () => ({
  resolveProjectPodUrl: async () => ({ url: 'http://project-runtime', mode: 'metal' }),
}))
mock.module('../lib/project-runtime-token', () => ({
  deriveProjectRuntimeToken: async () => 'wrt_v1_ws-1',
}))

const realPrisma = await import('../lib/prisma')
const prisma = new Proxy(realPrisma.prisma as any, {
  get: (target, key) => (key === 'chatSession' ? { findUnique: async () => session } : target[key]),
})
mock.module('../lib/prisma', () => ({ ...realPrisma, prisma }))
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')

type RuntimeCall = { method: string; url: string; headers: Headers; body?: any }

function app(identity: any = { kind: 'workspace', workspaceId: 'ws-1' }) {
  const routes = runtimeInternalRoutes({
    authenticate: async () => identity,
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
  } as any)
  const root = new Hono()
  root.route('/api/internal', routes)
  const base = '/api/internal/workspaces/ws-1/sessions/sess-1/members'
  return {
    tool: (projectId: string, name: string, params: unknown = {}) =>
      root.request(`${base}/${projectId}/tools/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      }),
    release: (projectId: string) => root.request(`${base}/${projectId}/tools/session`, { method: 'DELETE' }),
  }
}

describe('workspace member tool proxy', () => {
  const realFetch = globalThis.fetch
  let calls: RuntimeCall[]
  let replies: Array<() => Response>

  beforeEach(() => {
    attached = [
      { projectId: 'site', attachMode: 'readwrite' },
      { projectId: 'docs', attachMode: 'readonly' },
    ]
    session = { contextType: 'workspace', contextId: null, workspaceId: 'ws-1' }
    calls = []
    replies = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const next = replies.shift()
      return next ? next() : Response.json({ result: { content: [{ type: 'text', text: 'ok' }], details: { ok: true } } })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("forwards the call to the project's runtime with this session's shell", async () => {
    const res = await app().tool('site', 'exec', { command: 'bun test' })
    expect(res.status).toBe(200)
    expect((await res.json()).result.details).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://project-runtime/agent/workspace/tools/exec')
    expect(calls[0]!.body).toEqual({ command: 'bun test' })
    expect(calls[0]!.headers.get('x-member-session')).toBe('sess-1')
    expect(calls[0]!.headers.get('x-runtime-token')).toBe('wrt_v1_ws-1')
  })

  test('only the workspace agent session may call it', async () => {
    session = { contextType: 'workspace', contextId: 'site', workspaceId: 'ws-1' }
    const pinned = await app().tool('site', 'read_file', { path: 'site/a.ts' })
    expect(pinned.status).toBe(403)
    expect((await pinned.json()).error.code).toBe('not_workspace_agent')

    session = { contextType: 'workspace', contextId: null, workspaceId: 'ws-other' }
    expect((await app().tool('site', 'read_file')).status).toBe(403)

    session = null
    expect((await app().tool('site', 'read_file')).status).toBe(403)
    expect(calls).toEqual([])
  })

  test('rejects other callers, unknown tools, and unmounted projects', async () => {
    expect((await app({ kind: 'project', projectId: 'site' }).tool('site', 'exec')).status).toBe(401)
    expect((await app({ kind: 'workspace', workspaceId: 'ws-other' }).tool('site', 'exec')).status).toBe(401)
    expect((await app().tool('site', 'mount_project')).status).toBe(400)
    const unmounted = await app().tool('elsewhere', 'read_file')
    expect(unmounted.status).toBe(404)
    expect((await unmounted.json()).error.code).toBe('not_mounted')
    expect(calls).toEqual([])
  })

  test('a read-only mount allows reads only', async () => {
    expect((await app().tool('docs', 'read_file', { path: 'docs/a.md' })).status).toBe(200)
    for (const name of ['write_file', 'edit_file', 'exec']) {
      const res = await app().tool('docs', name)
      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('readonly_member')
    }
    expect(calls).toHaveLength(1)
  })

  test('retries while the project runtime is still starting', async () => {
    replies.push(() => new Response('starting', { status: 503 }))
    const res = await app().tool('site', 'read_file', { path: 'site/a.ts' })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  test("releasing ends the session's shell in the project runtime", async () => {
    replies.push(() => Response.json({ ok: true }))
    const res = await app().release('site')
    expect(res.status).toBe(200)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe('http://project-runtime/agent/workspace/tools/sessions/sess-1')
  })
})
