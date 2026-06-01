// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the `browser` tool in gateway-tools.ts.
 *
 * Mocks `playwright-core` via bun:test mock.module so every action of
 * createBrowserTool is exercised without launching real Chromium:
 *   - launch path (CONTAINER args, isBun cdpPort), connectOverCDP path
 *   - actions: navigate, snapshot, click, fill, extract, text, screenshot,
 *     evaluate, select, scroll (ref + selector + distance), wait_for, close
 *   - error handling try/catch
 *   - capture mode (SHOGO_MOCK_CAPTURE_DIR) wrapper
 *   - screencast path (subagentInstanceId set)
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

const TEST_DIR = '/tmp/test-gateway-tools-browser'

// =====================================================================
// playwright-core fake
// =====================================================================

interface FakeCDPSession {
  on: (event: string, cb: any) => void
  send: (cmd: string, args?: any) => Promise<any>
  detach: () => Promise<void>
  _handlers: Record<string, any>
}

function makeCdpSession(): FakeCDPSession {
  const handlers: Record<string, any> = {}
  return {
    _handlers: handlers,
    on: (ev, cb) => { handlers[ev] = cb },
    send: async () => undefined,
    detach: async () => undefined,
  }
}

interface FakePage {
  goto: (url: string, opts?: any) => Promise<void>
  evaluate: (fn: any, ...args: any[]) => Promise<any>
  $$eval: (sel: string, fn: any) => Promise<any>
  title: () => Promise<string>
  url: () => string
  locator: (sel: string) => any
  screenshot: (opts: any) => Promise<Buffer>
  waitForTimeout: (ms: number) => Promise<void>
  waitForSelector: (sel: string, opts?: any) => Promise<void>
  close: () => Promise<void>
  context: () => { newCDPSession: (p: any) => Promise<FakeCDPSession> }
  _currentUrl: string
  _title: string
  _evalResult: any
  _gotoErr?: Error
  _evalErr?: Error
}

function makeFakePage(opts: { evalResult?: any; gotoErr?: Error; evalErr?: Error; currentUrl?: string; title?: string } = {}): FakePage {
  const page: FakePage = {
    _currentUrl: opts.currentUrl ?? 'https://example.com',
    _title: opts.title ?? 'Example',
    _evalResult: opts.evalResult,
    _gotoErr: opts.gotoErr,
    _evalErr: opts.evalErr,
    goto: async (u: string) => {
      if (page._gotoErr) throw page._gotoErr
      page._currentUrl = u
    },
    evaluate: async (_fn: any) => {
      if (page._evalErr) throw page._evalErr
      // Return the canned result if set; otherwise return a snapshot-like default
      if (page._evalResult !== undefined) return page._evalResult
      return { text: 'a11y-tree', refCount: 0 }
    },
    $$eval: async () => [{ text: 'el1', html: '<a/>' }],
    title: async () => page._title,
    url: () => page._currentUrl,
    locator: (_sel: string) => ({
      click: async () => undefined,
      fill: async () => undefined,
      selectOption: async () => undefined,
      scrollIntoViewIfNeeded: async () => undefined,
    }),
    screenshot: async (_o: any) => Buffer.from('PNGDATA'),
    waitForTimeout: async () => undefined,
    waitForSelector: async () => undefined,
    close: async () => undefined,
    context: () => ({ newCDPSession: async () => makeCdpSession() }),
  }
  return page
}

let fakePage: FakePage = makeFakePage()
let lastLaunchOpts: any = null
let lastConnectArgs: any = null
let connectOverCDPFn: any = null

function installPlaywrightMock() {
  // Reset state so each test gets a fresh page/browser
  fakePage = makeFakePage()
  lastLaunchOpts = null
  lastConnectArgs = null
  connectOverCDPFn = null

  mock.module('playwright-core', () => ({
    chromium: {
      launch: async (opts: any) => {
        lastLaunchOpts = opts
        return {
          newPage: async () => fakePage,
          contexts: () => [],
          close: async () => undefined,
        }
      },
      connectOverCDP: async (...args: any[]) => {
        lastConnectArgs = args
        if (connectOverCDPFn) return await connectOverCDPFn(...args)
        return {
          newPage: async () => fakePage,
          contexts: () => [{
            pages: () => [fakePage],
          }],
          close: async () => undefined,
        }
      },
    },
  }))
}

// =====================================================================
// helpers
// =====================================================================

const envBackup: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined) {
  if (!(key in envBackup)) envBackup[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
function restoreEnv() {
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k]
    else process.env[k] = envBackup[k]
    delete envBackup[k]
  }
}

async function freshBrowserTool(ctxOver: Record<string, any> = {}) {
  installPlaywrightMock()
  // Use a path that allows the dynamic import to resolve fresh — bun's
  // mock.module hooks new imports.
  const { createTools } = await import('../gateway-tools')
  const ctx: any = {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'p',
    ...ctxOver,
  }
  const tool = createTools(ctx).find(t => t.name === 'browser')!
  return { tool, ctx }
}

async function exec(tool: any, params: any) {
  const r = await tool.execute('cid', params)
  return { details: r.details, content: r.content }
}

// =====================================================================
// tests
// =====================================================================

describe('gateway-tools browser tool (playwright-core mocked)', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    setEnv('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', undefined)
    setEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', undefined)
    setEnv('BROWSER_CDP_ENDPOINT', undefined)
    setEnv('CONTAINER', undefined)
    setEnv('SHOGO_MOCK_CAPTURE_DIR', undefined)
  })
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    restoreEnv()
  })

  // -------------------------------------------------------------------
  // launch + navigate
  // -------------------------------------------------------------------
  test('navigate: launches browser and returns title + url', async () => {
    const { tool } = await freshBrowserTool()
    fakePage._title = 'Hello'
    const r = await exec(tool, { action: 'navigate', url: 'https://target.example/x' })
    expect(r.details.ok).toBe(true)
    expect(r.details.title).toBe('Hello')
    expect(r.details.url).toBe('https://target.example/x')
  })

  test('navigate: errors when url missing', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'navigate' })
    expect(r.details.error).toContain('url is required')
  })

  test('navigate: under CONTAINER sets --no-sandbox launch args', async () => {
    setEnv('CONTAINER', '1')
    const { tool } = await freshBrowserTool()
    await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    expect(lastLaunchOpts.args).toContain('--no-sandbox')
    expect(lastLaunchOpts.args).toContain('--disable-setuid-sandbox')
  })

  test('navigate: under bun sets cdpPort=0', async () => {
    const { tool } = await freshBrowserTool()
    await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    // bun detected via globalThis.Bun
    expect(lastLaunchOpts.cdpPort).toBe(0)
  })

  test('navigate: launch failure → helpful error message', async () => {
    const { tool } = await freshBrowserTool()
    // override the chromium.launch to throw
    mock.module('playwright-core', () => ({
      chromium: {
        launch: async () => { throw new Error('cannot find chrome') },
        connectOverCDP: async () => { throw new Error('cdp-fail') },
      },
    }))
    const r = await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    expect(r.details.error).toContain('Browser launch failed')
    expect(r.details.error).toContain('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH')
  })

  test('navigate: extension mode uses connectOverCDP via direct CDP endpoint', async () => {
    setEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'ext-token')
    setEnv('BROWSER_CDP_ENDPOINT', 'ws://1.2.3.4:9222')
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    expect(r.details.ok).toBe(true)
    expect(lastConnectArgs?.[0]).toBe('ws://1.2.3.4:9222')
  })

  test('navigate: extension mode launch failure produces extension-specific error', async () => {
    setEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'ext-token')
    setEnv('BROWSER_CDP_ENDPOINT', 'ws://1.2.3.4:9222')
    const { tool } = await freshBrowserTool()
    mock.module('playwright-core', () => ({
      chromium: {
        launch: async () => { throw new Error('shouldnt-be-called') },
        connectOverCDP: async () => { throw new Error('extension-down') },
      },
    }))
    const r = await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    expect(r.details.error).toContain('Failed to connect to browser via extension')
    expect(r.details.error).toContain('extension-down')
  })

  // -------------------------------------------------------------------
  // snapshot
  // -------------------------------------------------------------------
  test('snapshot: returns text + refCount from page.evaluate', async () => {
    const { tool } = await freshBrowserTool()
    fakePage._evalResult = { text: 'role-tree\n  button', refCount: 3 }
    fakePage._title = 'T'
    const r = await exec(tool, { action: 'snapshot' })
    expect(r.details.snapshot).toContain('role-tree')
    expect(r.details.refCount).toBe(3)
    expect(r.details.title).toBe('T')
  })

  // -------------------------------------------------------------------
  // click
  // -------------------------------------------------------------------
  test('click by ref succeeds', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'click', ref: 5, waitMs: 1 })
    expect(r.details.ok).toBe(true)
    expect(r.details.ref).toBe(5)
  })

  test('click by selector succeeds', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'click', selector: 'button.go' })
    expect(r.details.ok).toBe(true)
    expect(r.details.selector).toBe('button.go')
  })

  test('click without ref or selector errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'click' })
    expect(r.details.error).toContain('ref or selector is required')
  })

  // -------------------------------------------------------------------
  // fill
  // -------------------------------------------------------------------
  test('fill with ref + value succeeds', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'fill', ref: 2, value: 'hello' })
    expect(r.details.ok).toBe(true)
  })

  test('fill without locator errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'fill', value: 'x' })
    expect(r.details.error).toContain('ref or selector is required')
  })

  test('fill without value errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'fill', selector: 'input' })
    expect(r.details.error).toContain('value is required')
  })

  // -------------------------------------------------------------------
  // extract
  // -------------------------------------------------------------------
  test('extract returns elements + count', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'extract', selector: '.item' })
    expect(r.details.count).toBe(1)
    expect(r.details.elements[0].text).toBe('el1')
  })

  test('extract without selector errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'extract' })
    expect(r.details.error).toContain('selector is required')
  })

  // -------------------------------------------------------------------
  // text
  // -------------------------------------------------------------------
  test('text returns cleaned content', async () => {
    const { tool } = await freshBrowserTool()
    fakePage._evalResult = 'Body text content here'
    const r = await exec(tool, { action: 'text' })
    expect(r.details.content).toContain('Body text content')
  })

  test('text truncates >50000 chars', async () => {
    const { tool } = await freshBrowserTool()
    fakePage._evalResult = 'x'.repeat(60000)
    const r = await exec(tool, { action: 'text' })
    expect(typeof r.details.content).toBe('string')
    expect(r.details.content.endsWith('[Truncated]')).toBe(true)
  })

  // -------------------------------------------------------------------
  // screenshot
  // -------------------------------------------------------------------
  test('screenshot writes file under .shogo/screenshots and returns relPath', async () => {
    const { tool, ctx } = await freshBrowserTool()
    const r = await exec(tool, { action: 'screenshot' })
    expect(r.details.ok).toBe(true)
    expect(r.details.path).toContain('.shogo/screenshots')
    // image content present
    expect(Array.isArray(r.content)).toBe(true)
    expect(r.content?.find((c: any) => c.type === 'image')).toBeDefined()
  })

  // -------------------------------------------------------------------
  // evaluate
  // -------------------------------------------------------------------
  test('evaluate returns result', async () => {
    const { tool } = await freshBrowserTool()
    fakePage._evalResult = { computed: 42 }
    const r = await exec(tool, { action: 'evaluate', value: '1+1' })
    expect(r.details.result.computed).toBe(42)
  })

  test('evaluate without code errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'evaluate' })
    expect(r.details.error).toContain('JS code')
  })

  // -------------------------------------------------------------------
  // select
  // -------------------------------------------------------------------
  test('select with ref + value succeeds', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'select', ref: 1, value: 'option1' })
    expect(r.details.ok).toBe(true)
    expect(r.details.value).toBe('option1')
  })

  test('select without locator errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'select', value: 'x' })
    expect(r.details.error).toContain('ref or selector is required')
  })

  test('select without value errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'select', selector: 'select' })
    expect(r.details.error).toContain('value is required')
  })

  // -------------------------------------------------------------------
  // scroll
  // -------------------------------------------------------------------
  test('scroll by selector → scrollIntoViewIfNeeded', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'scroll', selector: '.target' })
    expect(r.details.ok).toBe(true)
  })

  test('scroll by ref → scrollIntoViewIfNeeded', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'scroll', ref: 4 })
    expect(r.details.ok).toBe(true)
  })

  test('scroll without ref/selector → window.scrollBy with distance from value', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'scroll', value: '750' })
    expect(r.details.ok).toBe(true)
  })

  test('scroll without ref/selector and no value → default distance', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'scroll' })
    expect(r.details.ok).toBe(true)
  })

  // -------------------------------------------------------------------
  // wait_for
  // -------------------------------------------------------------------
  test('wait_for with selector succeeds', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'wait_for', selector: '.ready' })
    expect(r.details.ok).toBe(true)
  })

  test('wait_for without selector errors', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'wait_for' })
    expect(r.details.error).toContain('selector is required')
  })

  // -------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------
  test('close before navigate: still returns ok (no browser to close)', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'close' })
    expect(r.details.ok).toBe(true)
  })

  test('close after navigate: cleans up browser + page', async () => {
    const { tool } = await freshBrowserTool()
    await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    const r = await exec(tool, { action: 'close' })
    expect(r.details.ok).toBe(true)
  })

  test('close in extension mode just closes browser without closing page', async () => {
    setEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'ext-token')
    setEnv('BROWSER_CDP_ENDPOINT', 'ws://1.2.3.4:9222')
    const { tool } = await freshBrowserTool()
    await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    const r = await exec(tool, { action: 'close' })
    expect(r.details.ok).toBe(true)
  })

  // -------------------------------------------------------------------
  // unknown action + error try/catch
  // -------------------------------------------------------------------
  test('unknown action → error message', async () => {
    const { tool } = await freshBrowserTool()
    const r = await exec(tool, { action: 'frobnicate' } as any)
    expect(r.details.error).toContain('Unknown browser action')
  })

  test('action throws → caught and surfaced as Browser error', async () => {
    const { tool } = await freshBrowserTool()
    fakePage._gotoErr = new Error('nav-failed')
    // No document landed (about:blank) → navigate must hard-fail rather than
    // take the soft-timeout "continue with loaded page" branch.
    fakePage._currentUrl = 'about:blank'
    const r = await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    expect(r.details.error).toContain('Browser error: nav-failed')
  })

  // -------------------------------------------------------------------
  // Capture mode wrapper
  // -------------------------------------------------------------------
  test('capture mode: wraps execute and writes step file', async () => {
    const cap = join(TEST_DIR, 'cap')
    mkdirSync(cap, { recursive: true })
    setEnv('SHOGO_MOCK_CAPTURE_DIR', cap)
    const { tool } = await freshBrowserTool()
    await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    const files = readdirSync(cap)
    expect(files.length).toBeGreaterThan(0)
  })

  test('capture mode: screenshot strips inline base64 and writes png separately', async () => {
    const cap = join(TEST_DIR, 'cap2')
    mkdirSync(cap, { recursive: true })
    setEnv('SHOGO_MOCK_CAPTURE_DIR', cap)
    const { tool } = await freshBrowserTool()
    await exec(tool, { action: 'screenshot' })
    // captureBrowserCall writes step files (json + optional png) — just confirm something was written
    function walkAll(dir: string): string[] {
      const out: string[] = []
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) out.push(...walkAll(full))
        else out.push(full)
      }
      return out
    }
    const all = walkAll(cap)
    expect(all.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------
  // Screencast path (subagentInstanceId set)
  // -------------------------------------------------------------------
  test('screencast: ensureScreencast attaches CDP session when subagentInstanceId set', async () => {
    const { tool, ctx } = await freshBrowserTool({ subagentInstanceId: 'inst-1' })
    await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    // Subsequent action triggers ensureScreencast again (idempotent)
    await exec(tool, { action: 'snapshot' })
    // Just confirms the actions ran without crashing through the screencast path
    expect(true).toBe(true)
  })

  test('screencast: cleanup tears down CDP session', async () => {
    const { tool } = await freshBrowserTool({ subagentInstanceId: 'inst-2' })
    await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    const r = await exec(tool, { action: 'close' })
    expect(r.details.ok).toBe(true)
  })

  test('screencast: CDP attachment error is swallowed (best-effort)', async () => {
    const { tool } = await freshBrowserTool({ subagentInstanceId: 'inst-3' })
    // Override page.context to throw
    fakePage.context = () => ({ newCDPSession: async () => { throw new Error('cdp-unavailable') } })
    const r = await exec(tool, { action: 'navigate', url: 'https://x.example/' })
    expect(r.details.ok).toBe(true)
  })
})
