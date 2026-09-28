// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'

describe('workspace meta-agent tools', () => {
  it('lists and mounts through the internal workspace API', async () => {
    const previous = {
      WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
      WORKSPACE_ID: process.env.WORKSPACE_ID,
      SHOGO_API_URL: process.env.SHOGO_API_URL,
    }
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string; body?: any }> = []
    try {
      process.env.WORKSPACE_RUNTIME = 'true'
      process.env.WORKSPACE_ID = 'ws-test'
      process.env.SHOGO_API_URL = 'http://api.test'
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url, method: init?.method || 'GET', body })
        if ((init?.method || 'GET') === 'GET') {
          return Response.json({ projects: [{ id: 'p1', name: 'One', mounted: false }] })
        }
        return Response.json({ ok: true, attached: { projectId: body.projectId } })
      }) as typeof fetch

      const ctx: ToolContext = {
        workspaceDir: '/app/workspace',
        channels: new Map(),
        config: {} as any,
        projectId: 'ws:ws-test',
        workspaceId: 'ws-test',
        sessionId: 'session-1',
        userId: 'user-1',
      }
      const tools = createTools(ctx)
      const list = tools.find((tool) => tool.name === 'list_projects')
      const mount = tools.find((tool) => tool.name === 'mount_project')
      expect(list).toBeDefined()
      expect(mount).toBeDefined()

      const listed = await list!.execute('call-1', {})
      expect(listed.details.projects[0].id).toBe('p1')
      await mount!.execute('call-2', { projectId: 'p1', mode: 'readwrite' })
      expect(calls.some((call) => call.method === 'GET')).toBe(true)
      expect(calls.some((call) => call.method === 'POST' && call.body.projectId === 'p1')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  function withWorkspaceEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
    const keys = ['WORKSPACE_RUNTIME', 'WORKSPACE_ID', 'SHOGO_API_URL', 'WORKSPACE_ANCHOR_PROJECT_ID', ...Object.keys(env)]
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    const originalFetch = globalThis.fetch
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-test'
    process.env.SHOGO_API_URL = 'http://api.test'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn().finally(() => {
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
  }

  const wsCtx = (): ToolContext => ({
    workspaceDir: '/app/workspace',
    channels: new Map(),
    config: {} as any,
    projectId: 'ws:ws-test',
    workspaceId: 'ws-test',
    sessionId: 'session-1',
    userId: 'user-1',
  })

  it('does not offer mount/unmount in a project-anchored runtime (project chats have no workspace session)', async () => {
    await withWorkspaceEnv({ WORKSPACE_ANCHOR_PROJECT_ID: 'anchor-1' }, async () => {
      const names = createTools(wsCtx()).map((tool) => tool.name)
      expect(names).toContain('list_projects')
      expect(names).not.toContain('mount_project')
      expect(names).not.toContain('unmount_project')
    })
  })

  it('surfaces a non-JSON proxy error body instead of a bare status', async () => {
    await withWorkspaceEnv({}, async () => {
      globalThis.fetch = (async () => new Response('upstream connect error', { status: 502 })) as unknown as typeof fetch
      const mount = createTools(wsCtx()).find((tool) => tool.name === 'mount_project')
      await expect(mount!.execute('call-1', { projectId: 'p1' })).rejects.toThrow(
        'Workspace API HTTP 502: upstream connect error',
      )
    })
  })

  it('preview_project builds the mounted member and returns a /p/<id>/ url, never the runtime\'s own port', async () => {
    const previous = {
      WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
      WORKSPACE_ID: process.env.WORKSPACE_ID,
      PORT: process.env.PORT,
      WORKSPACE_PREVIEW_URLS: process.env.WORKSPACE_PREVIEW_URLS,
    }
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string }> = []
    try {
      process.env.WORKSPACE_RUNTIME = 'true'
      process.env.WORKSPACE_ID = 'ws-test'
      process.env.PORT = '37287'
      delete process.env.WORKSPACE_PREVIEW_URLS
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, method: init?.method || 'GET' })
        return Response.json({ ok: true, phase: 'running' })
      }) as typeof fetch

      const ctx: ToolContext = {
        workspaceDir: '/app/workspace',
        channels: new Map(),
        config: {} as any,
        projectId: 'ws:ws-test',
        workspaceId: 'ws-test',
        sessionId: 'session-1',
        userId: 'user-1',
      }
      const tools = createTools(ctx)
      const preview = tools.find((tool) => tool.name === 'preview_project')
      expect(preview).toBeDefined()

      const result = await preview!.execute('call-1', { projectId: 'COUNTER' })
      expect(calls).toEqual([{ url: 'http://localhost:37287/p/COUNTER/preview/start', method: 'POST' }])
      expect(result.details.url).toBe('http://localhost:37287/p/COUNTER/')
      // The URL must be scoped under /p/<id>/ — never a bare runtime-port URL.
      expect(result.details.url).not.toBe('http://localhost:37287/')
      expect(result.details.url).not.toBe('http://localhost:37287')
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('preview_project prefers the external WORKSPACE_PREVIEW_URLS entry when set (cloud)', async () => {
    const previous = {
      WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
      WORKSPACE_ID: process.env.WORKSPACE_ID,
      PORT: process.env.PORT,
      WORKSPACE_PREVIEW_URLS: process.env.WORKSPACE_PREVIEW_URLS,
    }
    const originalFetch = globalThis.fetch
    try {
      process.env.WORKSPACE_RUNTIME = 'true'
      process.env.WORKSPACE_ID = 'ws-test'
      process.env.PORT = '8080'
      process.env.WORKSPACE_PREVIEW_URLS = JSON.stringify({ COUNTER: 'https://preview--counter.example.com' })
      globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ok: true, phase: 'running' })) as typeof fetch

      const ctx: ToolContext = {
        workspaceDir: '/app/workspace',
        channels: new Map(),
        config: {} as any,
        projectId: 'ws:ws-test',
        workspaceId: 'ws-test',
        sessionId: 'session-1',
        userId: 'user-1',
      }
      const preview = createTools(ctx).find((tool) => tool.name === 'preview_project')
      const result = await preview!.execute('call-1', { projectId: 'COUNTER' })
      expect(result.details.url).toBe('https://preview--counter.example.com')
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

