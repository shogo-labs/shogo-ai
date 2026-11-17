// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The prod wedge, reproduced with real Chromium (SHO-358).
 *
 * A `browser` sub-agent's `snapshot` on a page whose main thread had stopped
 * answering never settled: Playwright puts no timeout on `evaluate`, so the tool
 * call, the sub-agent, and the chat turn all hung — 18 h on prod — and no Stop
 * could end them.
 *
 * The fixture page is a healthy document that freezes its own main thread a few
 * seconds after load (a busy loop), which is what an "Update available — Refresh"
 * page / animated canvas does in the wild. Then:
 *   1. the snapshot returns the actionable "stopped responding" error within the
 *      deadline, the page is closed and its pool slot comes back, and a fresh
 *      navigate works;
 *   2. an aborted turn settles its tool call immediately (the orchestrator's
 *      abort race) and still releases the page.
 *
 * Real browsers are only installed in the `e2e-local` job, so this skips with a
 * loud reason elsewhere — run `npx playwright install chromium` to exercise it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { createBrowserTool } from '../../gateway-tools'
import { getSharedBrowserPool, resetSharedBrowserPool } from '../../browser-pool'
import { wrapToolsWithOrchestration } from '../../../../agent/src/tool-orchestration'

function chromiumInstalled(): boolean {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (override) return existsSync(override)
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const HAS_CHROMIUM = chromiumInstalled()
const TIMEOUT = 30_000

/** Freezes its own main thread ~3 s after load — the frozen-page shape. */
const FROZEN_PAGE = `<!doctype html>
<html><head><title>Frozen fixture</title></head>
<body><h1>This page freezes</h1>
<script>
  setTimeout(function () {
    // A busy loop: the renderer's main thread stops running tasks, including
    // the ones Playwright's evaluate/title/screenshot wait on.
    var until = Date.now() + 10 * 60 * 1000
    while (Date.now() < until) {}
  }, 3000)
</script></body></html>`

const HEALTHY_PAGE = `<!doctype html><html><head><title>Healthy fixture</title></head><body><h1>ok</h1></body></html>`

let server: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ''
let workspaceDir = ''
const envBackup: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined) {
  if (!(key in envBackup)) envBackup[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function restoreEnv() {
  for (const key of Object.keys(envBackup)) {
    if (envBackup[key] === undefined) delete process.env[key]
    else process.env[key] = envBackup[key]
    delete envBackup[key]
  }
}

beforeAll(() => {
  if (!HAS_CHROMIUM) return
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/frozen') return new Response(FROZEN_PAGE, { headers: { 'content-type': 'text/html' } })
      return new Response(HEALTHY_PAGE, { headers: { 'content-type': 'text/html' } })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
  workspaceDir = mkdtempSync(join(tmpdir(), 'sho-358-browser-'))
})

afterAll(async () => {
  await resetSharedBrowserPool().catch(() => {})
  server?.stop(true)
  server = undefined
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
})

afterEach(async () => {
  restoreEnv()
  if (HAS_CHROMIUM) await resetSharedBrowserPool().catch(() => {})
})

function makeTool(): AgentTool {
  const ctx: any = {
    workspaceDir,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'p',
    sessionId: 'sho-358-session',
    subagentInstanceId: 'agent-sho-358-e2e',
  }
  return createBrowserTool(ctx)
}

async function exec(tool: AgentTool, params: Record<string, unknown>, signal?: AbortSignal) {
  const result: any = await tool.execute('call-1', params, signal)
  return result.details
}

describe('SHO-358 — a real page whose main thread stops answering', () => {
  test('snapshot stops at its deadline, the page is closed and the next navigate works', async () => {
    if (!HAS_CHROMIUM) {
      console.warn('[SHO-358] skipping real-Chromium e2e: run `npx playwright install chromium`')
      return
    }
    setEnv('BROWSER_ACTION_TIMEOUT_MS', '500')
    setEnv('BROWSER_PAGE_PROBE_TIMEOUT_MS', '300')

    const tool = makeTool()
    const pool = getSharedBrowserPool()

    const nav = await exec(tool, { action: 'navigate', url: `${baseUrl}/frozen`, waitMs: 0 })
    expect(nav.ok).toBe(true)
    expect(pool.activeCount).toBe(1)

    // Let the fixture freeze its own main thread.
    await Bun.sleep(3500)

    const started = Date.now()
    const snapshot = await exec(tool, { action: 'snapshot' })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(String(snapshot.error)).toContain('stopped responding')
    expect(String(snapshot.error)).toContain('snapshot')
    expect(snapshot.action).toBe('snapshot')

    // The page and its lease are gone, so another browser run can have the slot.
    expect(pool.activeCount).toBe(0)

    const again = await exec(tool, { action: 'navigate', url: `${baseUrl}/healthy`, waitMs: 0 })
    expect(again.ok).toBe(true)
    expect(again.title).toBe('Healthy fixture')
  }, TIMEOUT)

  test('an aborted turn settles the pending tool call and still releases the page', async () => {
    if (!HAS_CHROMIUM) {
      console.warn('[SHO-358] skipping real-Chromium e2e: run `npx playwright install chromium`')
      return
    }
    setEnv('BROWSER_ACTION_TIMEOUT_MS', '60000')
    setEnv('BROWSER_PAGE_PROBE_TIMEOUT_MS', '3000')

    const tool = makeTool()
    const { tools } = wrapToolsWithOrchestration([tool])
    const wrapped = tools.find((t) => t.name === 'browser')!

    const nav = await exec(tool, { action: 'navigate', url: `${baseUrl}/frozen`, waitMs: 0 })
    expect(nav.ok).toBe(true)
    await Bun.sleep(3500)

    const controller = new AbortController()
    const started = Date.now()
    const call = wrapped.execute('call-2', { action: 'snapshot' } as any, controller.signal).catch((err) => err)
    await Bun.sleep(300)
    controller.abort()
    const outcome: any = await call

    // The abort ended the call long before the 60 s action deadline could.
    expect(Date.now() - started).toBeLessThan(5000)
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome.name).toBe('AbortError')

    // And the page was released on the way out.
    await Bun.sleep(500)
    expect(getSharedBrowserPool().activeCount).toBe(0)
  }, TIMEOUT)
})
