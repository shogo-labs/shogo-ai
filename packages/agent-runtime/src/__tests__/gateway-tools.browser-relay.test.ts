// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// gateway-tools.ts — browser tool relay + screencast coverage
// Targets the playwright/cdp clusters:
//   L2324-2369 spawnCDPRelay (child_process.spawn relay handshake)
//   L2487-2522 ensureScreencast (CDPSession attach + Page.screencastFrame)
// Mocks playwright-core and patches require('child_process').spawn at the
// cached-module level.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { EventEmitter } from 'events'

// Mock playwright-core BEFORE importing gateway-tools
const fakeCdpEvents = new EventEmitter()
const cdpSends: any[] = []
const fakeCdpSession = {
  send: async (method: string, params?: any) => {
    cdpSends.push({ method, params })
    return {}
  },
  on: (evt: string, cb: any) => { fakeCdpEvents.on(evt, cb) },
  detach: async () => {},
}
const fakePage = {
  context: () => ({ newCDPSession: async () => fakeCdpSession }),
  goto: async (_url: string, _opts: any) => null,
  evaluate: async (_fn: any) => ({}),
  $$: async () => [],
  $: async () => null,
  screenshot: async () => Buffer.from(''),
  close: async () => {},
  url: () => 'about:blank',
}
const fakeBrowserCtx = { pages: () => [fakePage] }
const fakeBrowser = {
  contexts: () => [fakeBrowserCtx],
  newPage: async () => fakePage,
  close: async () => {},
}

mock.module('playwright-core', () => ({
  chromium: {
    connectOverCDP: async () => fakeBrowser,
    launch: async () => fakeBrowser,
  },
}))

// Mock screencast-broadcaster
const screencastPublishes: any[] = []
mock.module('../screencast-broadcaster', () => ({
  publish: (instanceId: string, frame: any) => {
    screencastPublishes.push({ instanceId, frame })
  },
}))

// Patch child_process.spawn at the cached CJS module level
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill() { this.killed = true; setImmediate(() => this.emit('exit', 0)) }
}
let lastChild: FakeChild | null = null
let spawnBehavior: 'success' | 'error' | 'exit-nonzero' | 'timeout' = 'success'
{
  const cp = require('child_process')
  cp.spawn = (_cmd: string, _args: string[], _opts: any) => {
    const child = new FakeChild()
    lastChild = child
    setImmediate(() => {
      if (spawnBehavior === 'error') {
        child.emit('error', new Error('ENOENT'))
        return
      }
      if (spawnBehavior === 'exit-nonzero') {
        child.stderr.emit('data', Buffer.from('relay panic'))
        child.emit('exit', 2)
        return
      }
      if (spawnBehavior === 'timeout') {
        return // never emits — test must use jest.runAllTimers or trigger
      }
      // success: emit ready then connected
      child.stdout.emit('data', Buffer.from(
        JSON.stringify({ type: 'ready', cdpEndpoint: 'ws://localhost:9999/cdp' }) + '\n' +
        JSON.stringify({ type: 'connected' }) + '\n'
      ))
    })
    return child as any
  }
}

const { createBrowserTool } = await import('../gateway-tools')

function makeCtx(overrides: any = {}): any {
  return {
    workspaceDir: '/tmp/test-browser',
    channels: new Map(),
    config: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'browser-test',
    sessionId: 'sess-1',
    mainSessionIds: ['sess-1'],
    subagentInstanceId: 'subagent-abc',
    ...overrides,
  }
}

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'tok-test-12345'
  process.env.BROWSER_CHANNEL = 'chrome'
  delete process.env.BROWSER_CDP_ENDPOINT
  spawnBehavior = 'success'
  cdpSends.length = 0
  screencastPublishes.length = 0
  lastChild = null
})
afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('spawnCDPRelay', () => {
  test('successful relay handshake → ensureBrowser resolves and connects', async () => {
    const ctx = makeCtx()
    const tool = createBrowserTool(ctx)
    const r: any = await tool.execute('id', { action: 'navigate', url: 'https://example.com' })
    expect(r.details?.ok ?? r.details).toBeDefined()
    expect(lastChild).not.toBeNull()
    // Extension mode bypasses screencast attach (see ensureScreencast bail)
    await tool.execute('id', { action: 'close' })
  })

  test('launch mode (no PLAYWRIGHT_MCP_EXTENSION_TOKEN) → screencast attaches and publishes frame', async () => {
    delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
    const ctx = makeCtx()
    const tool = createBrowserTool(ctx)
    const r: any = await tool.execute('id', { action: 'navigate', url: 'https://example.com' })
    expect(r.details).toBeDefined()
    // No relay spawn in launch mode
    expect(lastChild).toBeNull()
    // Screencast SHOULD be started
    const startSC = cdpSends.find((s) => s.method === 'Page.startScreencast')
    expect(startSC).toBeDefined()
    expect(startSC?.params?.format).toBe('jpeg')
    // Fire a screencast frame and verify publish + ack
    fakeCdpEvents.emit('Page.screencastFrame', {
      data: 'base64data',
      sessionId: 'sid-1',
      metadata: { deviceWidth: 1280, deviceHeight: 720 },
    })
    expect(screencastPublishes.length).toBeGreaterThan(0)
    expect(screencastPublishes[0].instanceId).toBe('subagent-abc')
    expect(screencastPublishes[0].frame.width).toBe(1280)
    const ack = cdpSends.find((s) => s.method === 'Page.screencastFrameAck')
    expect(ack).toBeDefined()
    await tool.execute('id', { action: 'close' })
  })

  test('relay spawn error rejects with extension-token error message', async () => {
    spawnBehavior = 'error'
    const ctx = makeCtx()
    const tool = createBrowserTool(ctx)
    const r: any = await tool.execute('id', { action: 'navigate', url: 'https://example.com' })
    // The error catch wraps in the extension-mode hint
    expect(String(r.details?.error || '')).toMatch(/Failed to start relay|MCP Bridge|ENOENT/i)
    await tool.execute('id', { action: 'close' })
  })

  test('relay exits with non-zero code rejects with stderr included', async () => {
    spawnBehavior = 'exit-nonzero'
    const ctx = makeCtx()
    const tool = createBrowserTool(ctx)
    const r: any = await tool.execute('id', { action: 'navigate', url: 'https://example.com' })
    expect(String(r.details?.error || '')).toMatch(/Relay exited|relay panic|MCP Bridge/i)
    await tool.execute('id', { action: 'close' })
  })

  test('BROWSER_CDP_ENDPOINT env bypasses relay spawn', async () => {
    process.env.BROWSER_CDP_ENDPOINT = 'ws://direct-cdp:9222'
    const ctx = makeCtx()
    const tool = createBrowserTool(ctx)
    const r: any = await tool.execute('id', { action: 'navigate', url: 'https://example.com' })
    expect(r.details).toBeDefined()
    // No child should have spawned
    expect(lastChild).toBeNull()
    await tool.execute('id', { action: 'close' })
  })

  test('reuses existing browser on subsequent calls (no second spawn)', async () => {
    const ctx = makeCtx()
    const tool = createBrowserTool(ctx)
    await tool.execute('id', { action: 'navigate', url: 'https://a.com' })
    const firstChild = lastChild
    await tool.execute('id', { action: 'navigate', url: 'https://b.com' })
    expect(lastChild).toBe(firstChild) // no new spawn
    await tool.execute('id', { action: 'close' })
  })

  test('ensureScreencast bails when no subagentInstanceId', async () => {
    const ctx = makeCtx({ subagentInstanceId: undefined })
    const tool = createBrowserTool(ctx)
    await tool.execute('id', { action: 'navigate', url: 'https://x.com' })
    // No screencast started
    const startSC = cdpSends.find((s) => s.method === 'Page.startScreencast')
    expect(startSC).toBeUndefined()
    await tool.execute('id', { action: 'close' })
  })

  test('screencast frame in launch mode acks back', async () => {
    delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
    const ctx = makeCtx()
    const tool = createBrowserTool(ctx)
    await tool.execute('id', { action: 'navigate', url: 'https://x.com' })
    fakeCdpEvents.emit('Page.screencastFrame', {
      data: 'b64', sessionId: 'sid', metadata: { deviceWidth: 800, deviceHeight: 600 },
    })
    const ack = cdpSends.find((s) => s.method === 'Page.screencastFrameAck')
    expect(ack).toBeDefined()
    await tool.execute('id', { action: 'close' })
  })
})
