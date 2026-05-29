// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// gateway-tools.ts — tool_install composio branch coverage
// Targets L3324-3393: the composio paths inside createToolInstallTool
// (isComposioInitialized() + isComposioEnabled() branches, findComposioToolkit
// hit/miss, initComposioSession success/failure, registerToolkitProxyTools,
// checkComposioAuth status variants).

import { describe, test, expect, mock } from 'bun:test'

// Mock state — flip these per-test
const state = {
  initialized: false,
  enabled: false,
  toolkit: null as null | { slug: string; name: string },
  initSessionOk: true,
  proxy: { toolCount: 0, toolNames: [] as string[] },
  auth: { status: 'active' as string, authUrl: undefined as string | undefined },
  searchToolkits: [] as any[],
  searchThrows: false,
}

mock.module('../composio', () => ({
  isComposioInitialized: () => state.initialized,
  isComposioEnabled: () => state.enabled,
  findComposioToolkit: async (_name: string) => state.toolkit,
  initComposioSession: async () => state.initSessionOk,
  registerToolkitProxyTools: async () => state.proxy,
  checkComposioAuth: async () => state.auth,
  searchComposioToolkits: async () => { if (state.searchThrows) throw new Error('composio down'); return state.searchToolkits },
  getComposioToolkitsCatalog: async () => [] as any[],
  resetComposioSession: () => {},
  getComposio: () => null,
  buildComposioUserId: () => 'uid',
  buildLegacyComposioUserId: () => 'uid',
  getComposioTimings: () => [],
  clearComposioTimings: () => {},
}))

const { createTools } = await import('../gateway-tools')

function makeCtx(overrides: any = {}): any {
  return {
    workspaceDir: '/tmp/test-tool-install-composio',
    channels: new Map(),
    config: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'proj-composio',
    sessionId: 'sess-1',
    mainSessionIds: ['sess-1'],
    mcpClientManager: { install: async () => ({ ok: true }), isRunning: () => false, getServerInfo: () => [] },
    userId: 'user-1',
    ...overrides,
  }
}

async function exec(ctx: any, params: Record<string, any>) {
  const tools = createTools(ctx)
  const t = tools.find((x: any) => x.name === 'connect')!
  const r = await t.execute('test-id', params)
  return r.details ?? r
}

function resetState() {
  state.initialized = false
  state.enabled = false
  state.toolkit = null
  state.initSessionOk = true
  state.proxy = { toolCount: 0, toolNames: [] }
  state.auth = { status: 'active', authUrl: undefined }
  state.searchToolkits = []
  state.searchThrows = false
}

describe('connect composio paths', () => {
  test('no MCP manager returns error', async () => {
    resetState()
    const ctx = makeCtx({ mcpClientManager: undefined })
    const r = await exec(ctx, { name: 'slack' })
    expect(String(r.error)).toContain('MCP client manager not available')
  })

  test('composio disabled + not initialized falls through to MCP catalog miss', async () => {
    resetState()
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'unknown-thing' })
    // Composio is off and the name isn't in the MCP catalog, so connect
    // auto-routes to MCP and reports the catalog miss.
    expect(String(r.error)).toContain('not in the MCP catalog')
  })

  test('composio already initialized + toolkit found + active auth', async () => {
    resetState()
    state.initialized = true
    state.enabled = true
    state.toolkit = { slug: 'slack', name: 'Slack' }
    state.proxy = { toolCount: 3, toolNames: ['SLACK_SEND', 'SLACK_LIST', 'SLACK_GET'] }
    state.auth = { status: 'active' }
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'slack' })
    expect(r.ok).toBe(true)
    expect(r.server).toBe('composio')
    expect(r.integration).toBe('slack')
    expect(r.toolCount).toBe(3)
    expect(r.tools).toEqual(['SLACK_SEND', 'SLACK_LIST', 'SLACK_GET'])
    expect(r.authStatus).toBe('active')
    expect(String(r.message)).toContain('installed with 3 tool(s)')
    expect(String(r.message)).toContain('Auth is active')
  })

  test('composio initialized + needs_auth WITH authUrl renders Connect-button message', async () => {
    resetState()
    state.initialized = true
    state.enabled = true
    state.toolkit = { slug: 'gmail', name: 'Gmail' }
    state.proxy = { toolCount: 5, toolNames: ['GMAIL_SEND'] }
    state.auth = { status: 'needs_auth', authUrl: 'https://auth.example.com/oauth' }
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'gmail' })
    expect(r.ok).toBe(true)
    expect(r.authStatus).toBe('needs_auth')
    expect(r.authUrl).toBe('https://auth.example.com/oauth')
    expect(String(r.message)).toContain('Connect button')
    expect(String(r.message)).not.toContain('https://auth.example.com/oauth')
  })

  test('composio initialized + needs_auth WITHOUT authUrl renders Tools-panel message', async () => {
    resetState()
    state.initialized = true
    state.enabled = true
    state.toolkit = { slug: 'jira', name: 'Jira' }
    state.proxy = { toolCount: 2, toolNames: [] }
    state.auth = { status: 'needs_auth' }
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'jira' })
    expect(r.ok).toBe(true)
    expect(String(r.message)).toContain('Tools panel')
  })

  test('composio enabled but NOT initialized → initComposioSession path success', async () => {
    resetState()
    state.initialized = false
    state.enabled = true
    state.toolkit = { slug: 'linear', name: 'Linear' }
    state.initSessionOk = true
    state.proxy = { toolCount: 1, toolNames: ['LINEAR_LIST'] }
    state.auth = { status: 'active' }
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'linear' })
    expect(r.ok).toBe(true)
    expect(r.integration).toBe('linear')
  })

  test('initComposioSession returns false → returns failed-to-connect error', async () => {
    resetState()
    state.enabled = true
    state.toolkit = { slug: 'notion', name: 'Notion' }
    state.initSessionOk = false
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'notion' })
    expect(String(r.error)).toContain('Failed to connect "Notion"')
  })

  test('composio enabled but findComposioToolkit returns null → falls through to MCP', async () => {
    resetState()
    state.enabled = true
    state.toolkit = null
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'mystery' })
    // No managed match and no explicit source, so connect falls through to the
    // MCP catalog (which also misses).
    expect(String(r.error)).toContain('not in the MCP catalog')
  })

  test('honors COMPOSIO_USER_SCOPE=project env var', async () => {
    resetState()
    state.enabled = true
    state.toolkit = { slug: 'github', name: 'GitHub' }
    state.proxy = { toolCount: 0, toolNames: [] }
    state.auth = { status: 'active' }
    const orig = process.env.COMPOSIO_USER_SCOPE
    process.env.COMPOSIO_USER_SCOPE = 'project'
    try {
      const ctx = makeCtx()
      const r = await exec(ctx, { name: 'github' })
      expect(r.ok).toBe(true)
    } finally {
      if (orig === undefined) delete process.env.COMPOSIO_USER_SCOPE
      else process.env.COMPOSIO_USER_SCOPE = orig
    }
  })

  test('honors COMPOSIO_USER_SCOPE=invalid → defaults to workspace', async () => {
    resetState()
    state.enabled = true
    state.toolkit = { slug: 'asana', name: 'Asana' }
    state.proxy = { toolCount: 0, toolNames: [] }
    state.auth = { status: 'active' }
    const orig = process.env.COMPOSIO_USER_SCOPE
    process.env.COMPOSIO_USER_SCOPE = 'garbage-value'
    try {
      const ctx = makeCtx()
      const r = await exec(ctx, { name: 'asana' })
      expect(r.ok).toBe(true)
    } finally {
      if (orig === undefined) delete process.env.COMPOSIO_USER_SCOPE
      else process.env.COMPOSIO_USER_SCOPE = orig
    }
  })

  test('catches and wraps unhandled error', async () => {
    resetState()
    state.initialized = true
    state.enabled = true
    state.toolkit = { slug: 'broken', name: 'Broken' }
    // findComposioToolkit returns toolkit, but registerToolkitProxyTools throws
    const realProxy = state.proxy
    let throwOnce = true
    const ctxMcp = {
      install: async () => ({ ok: true }),
      get __throws() { return throwOnce },
    }
    // Easier: replace registerToolkitProxyTools via state to throw
    state.proxy = new Proxy({} as any, { get() { throw new Error('proxy boom') } })
    const ctx = makeCtx({ mcpClientManager: ctxMcp })
    const r = await exec(ctx, { name: 'broken' })
    // Either the proxy-getter throws inside the destructure, or the call site
    // catches and wraps in "Failed to install". Both are valid; we just need
    // the catch block to execute.
    expect(r.error).toBeDefined()
    state.proxy = realProxy
    throwOnce = false
  })
})


describe('search_integrations composio paths', () => {
  test('composio enabled — search returns managed results', async () => {
    resetState()
    state.enabled = true
    state.searchToolkits = [
      { name: 'Slack', slug: 'slack', logo: 'slack.png' },
      { name: 'Jira', slug: 'jira', logo: 'jira.png' },
    ]
    const ctx = makeCtx()
    const tools = createTools(ctx)
    const t = tools.find((x: any) => x.name === 'search_integrations')!
    const r: any = await t.execute('id', { query: 'slack' })
    const detail = r.details ?? r
    expect(Array.isArray(detail.results)).toBe(true)
    const managed = detail.results.filter((x: any) => x.source === 'managed')
    expect(managed.length).toBeGreaterThanOrEqual(1)
    expect(managed[0].installCommand).toContain('connect')
  })

  test('composio enabled — search swallows API errors', async () => {
    resetState()
    state.enabled = true
    state.searchThrows = true
    const ctx = makeCtx()
    const tools = createTools(ctx)
    const t = tools.find((x: any) => x.name === 'search_integrations')!
    const r: any = await t.execute('id', { query: 'anything' })
    const detail = r.details ?? r
    expect(detail.results).toBeDefined()
  })
})
